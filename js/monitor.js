/**
 * 事件到达频率与数据中断监测 —— E-W1 要求 5 的核心。
 *
 * 本模块刻意做成**纯函数式、时钟由外部提供**：
 * 不读 performance.now()、不读 Date.now()、不碰 DOM。
 * 这样 Node 单元测试可以精确构造"60Hz 正常流""中间静默 1.5 秒"
 * "页面被切到后台"等场景，逐条断言监测结论。
 *
 * 为什么这件事重要：
 * iOS 上 devicemotion 一旦停止派发，页面不会收到任何错误事件。
 * 唯一的证据就是"时间过去了但事件没来"。所以中断必须由我们自己
 * 从时间轴上推断出来，并且要能区分"页面被挂起"与"传感器停摆"。
 */

export const DEFAULT_GAP_WARN_MS = 1000;
export const DEFAULT_GAP_FAIL_MS = 3000;

/**
 * 停顿阈值（E-W2 新增）。
 *
 * E-W1 真机数据暴露的问题：只记 ≥1000ms 的中断会漏掉大量 200–999ms 的停顿。
 * 那次采集里有一段 965ms 的停顿，比阈值只差 35ms，没被计为中断，
 * 却足以把 2 秒滑窗频率从 58.8Hz 拉到 31Hz —— 看板上"频率忽然掉一半"
 * 却找不到任何中断记录，是很容易误判成算法出问题的。
 *
 * 所以把 200ms–999ms 单独记成"停顿"，既不改中断的定义，也不让空档消失。
 */
export const DEFAULT_STALL_MS = 200;

/**
 * @typedef {object} MotionEventRecord
 * @property {number} tMonoMs      单调时钟毫秒（由数据源用 performance.now() 提供）
 * @property {number|null} agx     含重力加速度 x（m/s²）
 * @property {number|null} agy
 * @property {number|null} agz
 * @property {number|null} ax      去重力线性加速度 x
 * @property {number|null} ay
 * @property {number|null} az
 * @property {number|null} alpha   角速度（deg/s）
 * @property {number|null} beta
 * @property {number|null} gamma
 * @property {number|null} intervalMs 设备自报的间隔
 */

export class MotionMonitor {
  /**
   * @param {object} [opts]
   * @param {number} [opts.eventCapacity] 事件环形缓冲容量
   * @param {number} [opts.intervalCapacity] 间隔样本环形缓冲容量
   * @param {number} [opts.gapWarnMs] 判定"需要注意"的静默阈值
   * @param {number} [opts.gapFailMs] 判定"已中断"的静默阈值
   * @param {number} [opts.hzWindowMs] 实时频率的滑动窗口
   * @param {number} [opts.bucketMs] 每秒计数桶宽
   * @param {number} [opts.bucketCount] 保留多少秒的桶
   */
  constructor(opts = {}) {
    this.eventCapacity = opts.eventCapacity ?? 30000;
    // E-W1 用的是 4096。真机一次 181 秒的采集就有 4674 个间隔，
    // 前 578 个被静默挤掉，导致 mean/median/p95 全部只反映"最后 4096 个"。
    // 现在放大到 60000（约 16 分钟 @60Hz），并且一旦发生截断必须显式报告。
    this.intervalCapacity = opts.intervalCapacity ?? 60000;
    this.gapWarnMs = opts.gapWarnMs ?? DEFAULT_GAP_WARN_MS;
    this.gapFailMs = opts.gapFailMs ?? DEFAULT_GAP_FAIL_MS;
    this.stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
    this.hzWindowMs = opts.hzWindowMs ?? 2000;
    this.bucketMs = opts.bucketMs ?? 1000;
    this.bucketCount = opts.bucketCount ?? 120;

    this.reset();
  }

  reset() {
    this._events = new Array(this.eventCapacity);
    this._head = 0;
    this._size = 0;

    this._intervals = new Array(this.intervalCapacity);
    this._iHead = 0;
    this._iSize = 0;
    this._intervalDropped = 0;

    this._buckets = new Map(); // tSec -> count
    this._gaps = [];
    this._stalls = [];
    this._visibility = [{ state: "visible", atMs: 0 }];

    this.totalPushed = 0;
    this.rejectedCount = 0;
    // 丢弃原因分解：E-W1 真机数据里有 7 个事件被丢，但只留了一个总数，
    // 事后无法判断是"同一毫秒撞车"还是"时间源倒退"。这个信息本该在采集时就留下。
    this._rejectedNonFinite = 0;
    this._rejectedTie = 0;
    this._rejectedBackwards = 0;
    this._firstMs = null;
    this._lastMs = null;
    this._finalized = false;
  }

  /**
   * 推入一个事件。
   * 时间必须严格单调递增；否则计入 rejectedCount 并丢弃（不做插值、不重排）。
   * @returns {boolean} 是否被接受
   */
  push(ev) {
    const t = ev.tMonoMs;
    if (!Number.isFinite(t)) {
      this.rejectedCount += 1;
      this._rejectedNonFinite += 1;
      return false;
    }
    if (this._lastMs !== null && t <= this._lastMs) {
      this.rejectedCount += 1;
      // 再分一层：相等和倒退是不同的病。相等多半是同一毫秒内连发两个事件；
      // 倒退说明时间源出了问题，性质严重得多，不该和"同毫秒撞车"混成一个数。
      if (t === this._lastMs) this._rejectedTie += 1;
      else this._rejectedBackwards += 1;
      return false;
    }

    // 中断判定：与上一事件的时间差超过阈值即视为一次中断
    if (this._lastMs !== null) {
      const dt = t - this._lastMs;
      if (dt > this.gapWarnMs) {
        this._gaps.push({
          startMs: this._lastMs,
          endMs: t,
          durationMs: dt,
          level: dt > this.gapFailMs ? "fail" : "warn",
          cause: this._attributeCause(this._lastMs, t),
        });
      } else if (dt >= this.stallMs) {
        // 够不上中断，但也不是正常间隔：单独记一笔，不让空档凭空消失
        this._stalls.push({
          startMs: this._lastMs,
          endMs: t,
          durationMs: dt,
          cause: this._attributeCause(this._lastMs, t),
        });
      }
      this._pushInterval(dt);
    }

    this._pushEvent(ev);
    this._bumpBucket(t);

    this.totalPushed += 1;
    if (this._firstMs === null) this._firstMs = t;
    this._lastMs = t;
    this._finalized = false;
    return true;
  }

  /** 记录页面可见性变化，用于给中断归因。 */
  markVisibility(state, nowMs) {
    const last = this._visibility[this._visibility.length - 1];
    if (last && last.state === state) return;
    this._visibility.push({ state, atMs: nowMs });
    // 只保留最近 64 条，避免长时间运行无限增长
    if (this._visibility.length > 64) this._visibility.shift();
  }

  /**
   * 收尾：若停止时距最后一个事件的静默已超阈值，补记一次尾部中断。
   * 幂等，多次调用不会重复记录。
   */
  finalize(nowMs) {
    if (this._finalized) return;
    if (this._lastMs === null) {
      this._finalized = true;
      return;
    }
    const dt = nowMs - this._lastMs;
    if (dt > this.gapWarnMs) {
      this._gaps.push({
        startMs: this._lastMs,
        endMs: nowMs,
        durationMs: dt,
        level: dt > this.gapFailMs ? "fail" : "warn",
        cause: this._attributeCause(this._lastMs, nowMs),
        trailing: true,
      });
    }
    this._finalized = true;
  }

  /** 取按时间顺序排列的事件快照。 */
  snapshotEvents() {
    const out = new Array(this._size);
    const start = (this._head - this._size + this.eventCapacity) % this.eventCapacity;
    for (let i = 0; i < this._size; i += 1) {
      out[i] = this._events[(start + i) % this.eventCapacity];
    }
    return out;
  }

  /**
   * 计算当前统计。
   * @param {number} nowMs 当前单调时钟毫秒
   */
  stats(nowMs) {
    const events = this.snapshotEvents();
    const count = events.length;
    const firstMs = this._firstMs;
    const lastMs = this._lastMs;
    const sinceLastMs = lastMs === null ? 0 : Math.max(0, nowMs - lastMs);
    const elapsedMs = firstMs === null ? 0 : Math.max(0, lastMs - firstMs);

    const intervals = this._snapshotIntervals();
    const meanIntervalMs = intervals.length ? mean(intervals) : 0;

    // 只排序一次，分位数与中位数都从同一份有序数组里取，避免重复排序。
    const sortedIntervals = intervals.slice().sort((a, b) => a - b);
    const medianIntervalMs = percentileSorted(sortedIntervals, 50);
    const p50IntervalMs = medianIntervalMs;
    const p95IntervalMs = percentileSorted(sortedIntervals, 95);
    const maxIntervalMs = sortedIntervals.length
      ? sortedIntervals[sortedIntervals.length - 1]
      : 0;

    // 抖动：以中位数为中心，取 |d - median| 的 P95。
    // 用中位数而非均值，避免个别长间隔把中心拉偏。
    const deviations = intervals.map((d) => Math.abs(d - medianIntervalMs));
    const jitterP95Ms = percentile(deviations, 95);

    const declared = events
      .map((e) => e.intervalMs)
      .filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
    const declaredIntervalMeanMs = declared.length ? mean(declared) : 0;

    // 三种频率口径必须同时给出，否则读者无法判断"这个 Hz 是什么的 Hz"。
    // E-W1 只导出了滑窗值，结果 30.98Hz 被误当成"本次采集频率"（真实有效采集率 57.8Hz）。
    const windowHz = this._observedHz(events, nowMs);
    const sessionAverageHz = elapsedMs > 0 ? ((count - 1) / elapsedMs) * 1000 : 0;

    const gapTotalMs = this._gaps.reduce((acc, g) => acc + g.durationMs, 0);
    const longestGapMs = this._gaps.reduce((acc, g) => Math.max(acc, g.durationMs), 0);

    // 有效采集率：把中断时段从分母里剔掉，把中断的那一个间隔从分子里剔掉。
    // 尾部补记的中断不算——它出现在 elapsedMs 之外，本来就不在分子分母里。
    const innerGaps = this._gaps.filter((g) => !g.trailing);
    const innerGapMs = innerGaps.reduce((acc, g) => acc + g.durationMs, 0);
    const activeSpanMs = Math.max(0, elapsedMs - innerGapMs);
    const activeSamples = Math.max(0, count - 1 - innerGaps.length);
    const activeHz = activeSpanMs > 0 ? (activeSamples / activeSpanMs) * 1000 : 0;

    const stallTotalMs = this._stalls.reduce((acc, s) => acc + s.durationMs, 0);
    const longestStallMs = this._stalls.reduce((acc, s) => Math.max(acc, s.durationMs), 0);

    const interruptLevel =
      sinceLastMs > this.gapFailMs ? "fail" : sinceLastMs > this.gapWarnMs ? "warn" : "none";

    let state = "idle";
    if (count > 0) state = interruptLevel === "none" ? "live" : "interrupting";

    return {
      eventCount: count,
      totalPushed: this.totalPushed,
      rejectedCount: this.rejectedCount,
      rejectedNonFinite: this._rejectedNonFinite,
      rejectedTie: this._rejectedTie,
      rejectedBackwards: this._rejectedBackwards,
      bufferedCapacity: this.eventCapacity,
      firstMs,
      lastMs,
      elapsedMs,
      sinceLastMs,
      windowHz,
      sessionAverageHz,
      activeHz,
      activeSpanMs,
      intervalSampleCount: intervals.length,
      intervalCapacity: this.intervalCapacity,
      intervalDroppedCount: this._intervalDropped,
      intervalStatsTruncated: this._intervalDropped > 0,
      meanIntervalMs,
      medianIntervalMs,
      p50IntervalMs,
      p95IntervalMs,
      maxIntervalMs,
      jitterP95Ms,
      declaredIntervalMeanMs,
      intervalCvPct: meanIntervalMs > 0 ? (stddev(intervals, meanIntervalMs) / meanIntervalMs) * 100 : 0,
      gapCount: this._gaps.length,
      gapTotalMs,
      longestGapMs,
      gaps: this._gaps.slice(),
      stallMs: this.stallMs,
      stallCount: this._stalls.length,
      stallTotalMs,
      longestStallMs,
      stalls: this._stalls.slice(),
      interruptLevel,
      state,
      perSecond: this._perSecondSeries(nowMs),
    };
  }

  // ---------- 内部 ----------

  _pushEvent(ev) {
    this._events[this._head] = ev;
    this._head = (this._head + 1) % this.eventCapacity;
    if (this._size < this.eventCapacity) this._size += 1;
  }

  _pushInterval(dt) {
    if (this._iSize === this.intervalCapacity) this._intervalDropped += 1;
    this._intervals[this._iHead] = dt;
    this._iHead = (this._iHead + 1) % this.intervalCapacity;
    if (this._iSize < this.intervalCapacity) this._iSize += 1;
  }

  _snapshotIntervals() {
    const out = new Array(this._iSize);
    const start = (this._iHead - this._iSize + this.intervalCapacity) % this.intervalCapacity;
    for (let i = 0; i < this._iSize; i += 1) {
      out[i] = this._intervals[(start + i) % this.intervalCapacity];
    }
    return out;
  }

  _bumpBucket(tMs) {
    const tSec = Math.floor(tMs / this.bucketMs);
    this._buckets.set(tSec, (this._buckets.get(tSec) || 0) + 1);
    const oldestAllowed = tSec - this.bucketCount;
    for (const key of this._buckets.keys()) {
      if (key < oldestAllowed) this._buckets.delete(key);
    }
  }

  _observedHz(events, nowMs) {
    if (events.length < 2) return 0;
    const from = nowMs - this.hzWindowMs;
    let startIdx = events.length - 1;
    while (startIdx > 0 && events[startIdx - 1].tMonoMs >= from) startIdx -= 1;
    const slice = events.slice(startIdx);
    if (slice.length < 2) return 0;
    // 与契约的滑窗口径一致：用 (n-1)/Δt，不用 n/Δt。
    const spanMs = slice[slice.length - 1].tMonoMs - slice[0].tMonoMs;
    if (spanMs <= 0) return 0;
    return ((slice.length - 1) / spanMs) * 1000;
  }

  _perSecondSeries(nowMs) {
    const nowSec = Math.floor(nowMs / this.bucketMs);
    const series = [];
    for (let i = this.bucketCount - 1; i >= 0; i -= 1) {
      const tSec = nowSec - i;
      series.push({ tSec, count: this._buckets.get(tSec) || 0 });
    }
    return series;
  }

  /** 判断一段静默区间是否与"页面隐藏"窗口重叠。 */
  _attributeCause(startMs, endMs) {
    const windows = this._visibility;
    for (let i = 0; i < windows.length; i += 1) {
      if (windows[i].state !== "hidden") continue;
      const hiddenStart = windows[i].atMs;
      const hiddenEnd =
        i + 1 < windows.length ? windows[i + 1].atMs : Number.POSITIVE_INFINITY;
      const overlap = Math.min(endMs, hiddenEnd) - Math.max(startMs, hiddenStart);
      if (overlap > 0) return "hidden";
    }
    return "unknown";
  }
}

// ---------- 统计工具（不依赖任何外部库） ----------

export function mean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function stddev(values, meanValue) {
  if (values.length < 2) return 0;
  const m = meanValue ?? mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (values.length - 1));
}

/**
 * 线性插值分位数（与 numpy 默认口径一致）。
 * @param {number[]} values 未排序数组
 * @param {number} p 0..100
 */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return percentileSorted(sorted, p);
}

/** 已排序数组的分位数，避免重复排序。 */
export function percentileSorted(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
