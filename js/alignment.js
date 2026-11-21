/**
 * 多源时间对齐与中断分析。
 *
 * ## 这个模块负责什么
 *
 *   1. 统一时间轴分桶（三通道计数 + 覆盖率）；
 *   2. 中断检测与合并（哪个源断了、断了多久）；
 *   3. 轨迹速度的时间插值（供跨源对照取样）。
 *
 * ## 这个模块**不**负责什么
 *
 *   不再负责"步幅是否可疑"的判定。E-W4 初版曾在这里放
 *   `stride > 1.8 m ⇒ 步频可能腰斩`，那是个错误的归因：它把
 *   `GPS 速度 ÷ 算法步频` 的差值全部记在分母头上，而分子（差分速度）
 *   同样会错，两个量的时间窗还可能根本不重叠。
 *
 *   跨源一致性的判定搬到了 `cadence_evidence.js`：那边要求
 *   **人工计数**才能给出「已确认」，其余证据最多到「疑似异常／需要人工验证」，
 *   并且步幅阈值按速度分带，不再是固定 1.8 m。
 *
 * ## 也不做的事
 *
 *   **不用 GPS 配速反推步数**。`步数 = 距离 / 步幅` 这种换算需要假设步幅，
 *   假设一错，步数就是编的。GPS 只用来**质疑**步频，不用来**产生**步频。
 */

import { haversineM } from "./gps.js";

/** 时间轴上的数据通道。 */
export const Channel = Object.freeze({
  MOTION: "motion",
  GPS: "gps",
  STEP: "step",
});

/** 中断的类型。区分"哪个源断了"比"断了"本身有用得多。 */
export const OutageKind = Object.freeze({
  MOTION_ONLY: "motion_only",
  GPS_ONLY: "gps_only",
  BOTH: "both",
});

/**
 * 间隔分布诊断：识别"2T 聚集"。
 *
 * 漏检一步不会让所有间隔都变成 2T，只会让其中一部分变成 2T。
 * 所以判据不是"均值翻倍"，而是**分布里同时存在 T 簇与 2T 簇**：
 *
 *   正常： {480, 495, 505, 500, 490}                  → 单簇
 *   漏检： {500, 500, 1000, 500, 500, 1000, 500}      → T 簇 500 + 2T 簇 1000
 *
 * 用中位数当 T 的估计（抗离群），然后数落在 [1.7T, 2.4T] 的比例。
 * 比例超过 15% 且样本数足够，判为"存在 2T 聚集"。
 *
 * 这是**中等强度**证据：真实步态里也会出现长短交替（侧向不平、路面台阶），
 * 所以它单独不足以说明什么，只进入证据列表由 `cadence_evidence.js` 聚合。
 *
 * @param {number[]} intervals 相邻已计步的时间差（毫秒）
 * @param {object} [opts]
 * @returns {{medianMs:number|null, sampleCount:number, nearDoubleRatio:number,
 *            doubled:boolean, note:string}}
 */
export function analyzeIntervalDistribution(intervals, opts = {}) {
  const minSamples = opts.minSamples ?? 8;
  const ratioThreshold = opts.ratioThreshold ?? 0.15;
  const list = (Array.isArray(intervals) ? intervals : []).filter(
    (v) => Number.isFinite(v) && v > 0,
  );
  if (list.length < minSamples) {
    return {
      medianMs: list.length ? medianOf(list) : null,
      sampleCount: list.length,
      nearDoubleRatio: 0,
      doubled: false,
      note: `样本不足（${list.length}/${minSamples}），不做判断`,
    };
  }
  const sorted = list.slice().sort((a, b) => a - b);
  const med = medianOf(sorted);
  const lo = med * 1.7;
  const hi = med * 2.4;
  const nearDouble = sorted.filter((v) => v >= lo && v <= hi).length;
  const ratio = nearDouble / sorted.length;
  const doubled = ratio >= ratioThreshold;
  return {
    medianMs: med,
    sampleCount: sorted.length,
    nearDoubleRatio: ratio,
    doubled,
    note: doubled
      ? `${(ratio * 100).toFixed(0)}% 的间隔落在 1.7–2.4 倍中位数区间，存在一步漏检的迹象`
      : "间隔分布集中在单一簇，无明显 2T 聚集",
  };
}

function medianOf(values) {
  const v = values.slice().sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * 统一时间轴分桶。
 *
 * 为什么必须分桶而不是"把三路事件按时间排序"：
 * 三路的到达频率差三个数量级（传感器 60 Hz、GPS 1 Hz、步频 10 Hz），
 * 混排之后根本看不出"某一秒里哪个源没给数据"。分桶才能暴露**空洞**。
 *
 * 桶的边界从会话起点对齐，而不是从 0 开始——否则跨会话比较时同一秒的桶
 * 会落在不同相位上。
 */
export class TimelineBuckets {
  /**
   * @param {object} opts
   * @param {number} opts.t0PerfMs 会话起点（单调时钟）
   * @param {number} [opts.bucketMs] 桶宽
   * @param {number} [opts.maxBuckets] 上限，防止长时间实验撑爆内存
   */
  constructor(opts = {}) {
    this.t0 = Number.isFinite(opts.t0PerfMs) ? opts.t0PerfMs : 0;
    this.bucketMs = opts.bucketMs && opts.bucketMs > 0 ? opts.bucketMs : 1000;
    this.maxBuckets = opts.maxBuckets ?? 7200; // 2 小时 @1s
    /** @type {Map<number, {motion:number, gps:number, step:number}>} */
    this.map = new Map();
    /**
     * 被丢弃的事件数，必须计数而不能只 return false。
     *
     * 静默丢弃是这一路最危险的失败形态：时间轴满 2 小时后不再增长，
     * 覆盖率的分母停在 7200，分子也不再增加，于是"覆盖率 100%"看起来完全正常，
     * 而实际后半程一条数据都没进时间轴。计数之后界面才能说"已到上限，超出部分未计入"。
     */
    this.droppedOverflow = 0; // 超出 maxBuckets（长时间实验）
    this.droppedEarly = 0; // 早于会话起点（锚点误差，负桶）
  }

  _bucketOf(perfMs) {
    if (!Number.isFinite(perfMs)) return null;
    const idx = Math.floor((perfMs - this.t0) / this.bucketMs);
    if (idx < 0) return null; // 会话开始之前的事件不计入（锚点误差不该制造负桶）
    if (idx >= this.maxBuckets) return null;
    return idx;
  }

  add(channel, perfMs, count = 1) {
    const idx = this._bucketOf(perfMs);
    if (idx === null) {
      if (Number.isFinite(perfMs)) {
        if (perfMs - this.t0 >= this.maxBuckets * this.bucketMs) this.droppedOverflow += 1;
        else this.droppedEarly += 1;
      }
      return false;
    }
    let b = this.map.get(idx);
    if (!b) {
      b = { motion: 0, gps: 0, step: 0 };
      this.map.set(idx, b);
    }
    b[channel] = (b[channel] ?? 0) + count;
    return true;
  }

  /** 已出现过的最大桶序号（用于确定时间轴长度）。 */
  get maxIndex() {
    let m = -1;
    for (const k of this.map.keys()) if (k > m) m = k;
    return m;
  }

  /**
   * 导出为定长序列。
   *
   * 空洞补 0 而不是 null：这里统计的是"这段时间收到几条数据"，
   * 0 条是一个**真实的观测值**，不是缺失。要表达"这个桶不存在"用 `covered` 字段。
   */
  series() {
    const n = this.maxIndex + 1;
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const b = this.map.get(i);
      out.push({
        index: i,
        tRelMs: i * this.bucketMs,
        motion: b ? b.motion : 0,
        gps: b ? b.gps : 0,
        step: b ? b.step : 0,
        covered: Boolean(b),
      });
    }
    return out;
  }

  /**
   * 覆盖率：有数据的桶 / 总桶数。三个通道分别算。
   *
   * 这是 E-W3.1 那条教训的延续——分母必须是"时间轴长度"，不能是"有数据的桶数"，
   * 否则覆盖率恒等于 1。
   */
  coverage() {
    const n = this.maxIndex + 1;
    if (n <= 0) {
      return {
        buckets: 0, motion: null, gps: null, step: null,
        droppedOverflow: this.droppedOverflow, droppedEarly: this.droppedEarly,
        limitMs: this.maxBuckets * this.bucketMs,
      };
    }
    let m = 0;
    let g = 0;
    let s = 0;
    for (const b of this.map.values()) {
      if (b.motion > 0) m += 1;
      if (b.gps > 0) g += 1;
      if (b.step > 0) s += 1;
    }
    return {
      buckets: n,
      motion: m / n,
      gps: g / n,
      step: s / n,
      droppedOverflow: this.droppedOverflow,
      droppedEarly: this.droppedEarly,
      limitMs: this.maxBuckets * this.bucketMs,
    };
  }
}

/**
 * 合并多源中断，找出"只有某个源断了"的区间。
 *
 * 为什么要合并：单一源的"没数据"经常不是真的断——步频 2 秒不出新值可能只是
 * 人停下来了；GPS 5 秒没新点可能只是 1 Hz 定位的正常间隔。把两路放在一起看，
 * 才能区分"传感器挂了"和"这个源本来就这么慢"。
 *
 * @param {Array<{startPerfMs:number, endPerfMs:number}>} motionOutages
 * @param {Array<{startPerfMs:number, endPerfMs:number}>} gpsOutages
 * @returns {Array<{startPerfMs:number, endPerfMs:number, durationMs:number,
 *                  kind:string, motion:boolean, gps:boolean}>}
 */
export function mergeOutages(motionOutages, gpsOutages) {
  const edges = [];
  for (const o of motionOutages || []) {
    if (Number.isFinite(o.startPerfMs) && Number.isFinite(o.endPerfMs) && o.endPerfMs > o.startPerfMs) {
      edges.push({ t: o.startPerfMs, delta: 1, src: "m" });
      edges.push({ t: o.endPerfMs, delta: -1, src: "m" });
    }
  }
  for (const o of gpsOutages || []) {
    if (Number.isFinite(o.startPerfMs) && Number.isFinite(o.endPerfMs) && o.endPerfMs > o.startPerfMs) {
      edges.push({ t: o.startPerfMs, delta: 1, src: "g" });
      edges.push({ t: o.endPerfMs, delta: -1, src: "g" });
    }
  }
  if (edges.length === 0) return [];

  edges.sort((a, b) => a.t - b.t || a.delta - b.delta);

  // 必须**按时刻分组**再判断状态变化，不能逐条边处理。
  // 逐条处理时，两个源在同一毫秒开始中断会产生：m+ 时 segG=false，g+ 时 segG=true，
  // 于是切出一个 start==end 的零长度段，最后得到 3 段而不是 1 段。
  // 同一时刻的所有边代表"这一瞬间发生了什么"，要作为一个整体应用。
  const out = [];
  let mCount = 0;
  let gCount = 0;
  let segStart = null;
  let segM = false;
  let segG = false;

  const pushSeg = (start, end, m, g) => {
    // 这条守卫是防御性的、按构造不可达：按时刻分组之后，闭合段的起点一定
    // 早于终点（分组已经消掉了"同一毫秒开始/结束"切出零长度段的情况）。
    // 留着它是为了万一将来有人改回逐条边处理时，不会静默产出空段；
    // 变异检验里因此不把它当承重项，见 tools/mutation_check.mjs 的 M64 注释。
    if (start === null || end <= start) return; // 零长度段不是中断
    out.push({
      startPerfMs: start,
      endPerfMs: end,
      durationMs: end - start,
      kind: m && g ? OutageKind.BOTH : m ? OutageKind.MOTION_ONLY : OutageKind.GPS_ONLY,
      motion: m,
      gps: g,
    });
  };

  let i = 0;
  while (i < edges.length) {
    const t = edges[i].t;
    const wasDown = mCount > 0 || gCount > 0;
    // 把同一时刻的边全部应用
    while (i < edges.length && edges[i].t === t) {
      if (edges[i].src === "m") mCount += edges[i].delta;
      else gCount += edges[i].delta;
      i += 1;
    }
    const nowM = mCount > 0;
    const nowG = gCount > 0;
    const nowDown = nowM || nowG;

    if (!wasDown && nowDown) {
      segStart = t;
      segM = nowM;
      segG = nowG;
    } else if (wasDown && !nowDown) {
      pushSeg(segStart, t, segM, segG);
      segStart = null;
    } else if (wasDown && nowDown && (segM !== nowM || segG !== nowG)) {
      // 参与中断的源集合变了：闭合上一段，从这一刻开新段
      pushSeg(segStart, t, segM, segG);
      segStart = t;
      segM = nowM;
      segG = nowG;
    }
  }
  // 结尾仍未闭合的区间不输出：它还没结束，长度未知
  return out;
}

/**
 * 从一连串 GPS fix 里找"应当有数据但没有"的区间。
 *
 * 判据不是固定阈值，而是**自适应**：用中位到达间隔的 N 倍作阈值。
 * 1 Hz 定位用 5 秒阈值合理，10 Hz 高频定位用 5 秒就会把正常情况全判成中断。
 *
 * @param {Array<{tMonoMs:number}>} fixes
 * @param {object} [opts]
 */
export function findGpsOutages(fixes, opts = {}) {
  const list = (Array.isArray(fixes) ? fixes : [])
    .filter((f) => Number.isFinite(f && f.tMonoMs))
    .sort((a, b) => a.tMonoMs - b.tMonoMs);
  // 返回值形状必须**恒定**。早先这里在点数不足时直接 return []，
  // 于是调用方得写 `Array.isArray(res) ? res : res.outages`，
  // 而漏写那一行时 `info.list` 会变成 undefined —— 断档数静默变成 0，
  // 页面显示"没有断档"，其实只是字段名对不上。宁可多一层壳，也不要双形状。
  if (list.length < 3) {
    return { outages: [], thresholdMs: null, medianGapMs: null };
  }

  const gaps = [];
  for (let i = 1; i < list.length; i += 1) gaps.push(list[i].tMonoMs - list[i - 1].tMonoMs);
  const med = medianOf(gaps);
  const factor = opts.factor ?? 3;
  const minMs = opts.minMs ?? 2000;
  const threshold = Math.max(minMs, med * factor);

  const out = [];
  for (let i = 1; i < list.length; i += 1) {
    const gap = list[i].tMonoMs - list[i - 1].tMonoMs;
    if (gap > threshold) {
      out.push({
        startPerfMs: list[i - 1].tMonoMs,
        endPerfMs: list[i].tMonoMs,
        durationMs: gap,
      });
    }
  }
  return { outages: out, thresholdMs: threshold, medianGapMs: med };
}

/**
 * 把 GPS 轨迹按时间插值到某个 perf 时刻，用于和步频做同期比较。
 *
 * 为什么用插值而不是"取最近一个点"：
 * 1 Hz 的 GPS 与 10 Hz 的步频做同期比较时，"最近点"最多会差 500 ms，
 * 在 3 m/s 下就是 1.5 m 的位置误差，足以把步幅判断带偏。
 *
 * 端点外不做外推（返回 null）：外推出来的速度是编的。
 *
 * @param {Array<{tMonoMs:number, speedMps:number|null, lat:number, lon:number}>} fixes
 * @param {number} perfMs
 */
export function speedAt(fixes, perfMs) {
  if (!Array.isArray(fixes) || fixes.length === 0) return null;
  if (!Number.isFinite(perfMs)) return null;
  const list = fixes;
  if (perfMs < list[0].tMonoMs || perfMs > list[list.length - 1].tMonoMs) return null;

  for (let i = 1; i < list.length; i += 1) {
    if (list[i].tMonoMs >= perfMs) {
      const a = list[i - 1];
      const b = list[i];
      const span = b.tMonoMs - a.tMonoMs;
      const speedA = pickSpeed(a);
      const speedB = pickSpeed(b);
      if (speedA === null || speedB === null) {
        // 一端没有速度：返回可用的那个，并说明不是插值结果。
        // 不能返回裸数字——调用方按 `{speedMps, interpolated}` 解构，
        // 类型漂移会让上层的 `r.speedMps` 变成 undefined 而静默失效。
        const v = speedB === null ? speedA : speedB;
        return v === null ? null : { speedMps: v, interpolated: false };
      }
      if (span <= 0) return { speedMps: speedB, interpolated: false };
      const w = (perfMs - a.tMonoMs) / span;
      return { speedMps: speedA * (1 - w) + speedB * w, interpolated: true };
    }
  }
  return null;
}

function pickSpeed(fix) {
  if (!fix) return null;
  if (Number.isFinite(fix.speedMps) && fix.speedMps >= 0) return fix.speedMps;
  if (Number.isFinite(fix.speedDerivedMps) && fix.speedDerivedMps >= 0) return fix.speedDerivedMps;
  return null;
}

/** 两点直线距离，供"轨迹总长 vs 直线距离"之类的粗略判断使用。 */
export function straightLineM(fixes) {
  if (!Array.isArray(fixes) || fixes.length < 2) return null;
  return haversineM(fixes[0], fixes[fixes.length - 1]);
}
