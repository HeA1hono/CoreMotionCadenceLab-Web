/**
 * 统一时间基准：把三个不同时钟域的时间戳搬到同一根轴上。
 *
 * 为什么这是 E-W4 的地基，而不是一个工具函数：
 *   本项目有三个数据源，它们的时间戳**根本不在同一个域里**：
 *
 *   ① DeviceMotionEvent → 我们用 `performance.now()` 打戳
 *      这是**单调时钟**：从页面导航开始计时，不受系统时间调整影响，
 *      但它的原点对本页面之外的一切都没有意义。
 *
 *   ② GeolocationPosition.timestamp → **epoch 毫秒**（DOMTimeStamp）
 *      这是"位置确定那一刻"的墙上时间，会被 NTP 同步、用户改时间影响。
 *
 *   ③ GPX 的 `<time>` → 也是 epoch，但来自文件作者那一侧的世界，
 *      和本机时钟没有任何关系，只能作为**相对间隔**使用。
 *
 *   把 ②③ 直接和 ① 相减，得到的是一个既包含"真实延迟"、又包含
 *   "两个时钟的偏移"、还可能包含"系统时间跳变"的混合物。
 *   如果把它当成"GPS 延迟"报出去，数字会看起来很精确，但它什么都不是。
 *
 * 本模块的做法：
 *   - 会话开始时取一对锚点 `{ perfMs, epochMs }`，建立线性映射；
 *   - 用锚点把 epoch 换算到 perf 域，**只做一次**，不做自动校正；
 *   - 每次收到 fix，把 `观测 epoch − 推算 epoch` 记为 `driftMs` 并留存，
 *     让"时钟不同步"变成一个**可观测、可导出的量**，而不是悄悄被平均掉。
 *
 * 为什么不做自动校正：
 *   自动校正需要一个"真实延迟应该是多少"的先验。GPS 延迟本身从 100 ms
 *   到 30 s 都可能（`maximumAge` 会直接返回缓存位置），拿它当基准去校正时钟，
 *   等于用被测量去校准量具。宁可把漂移原样报出来，让人自己判断。
 */

/** 时钟域标识。导出的每一行都带这个字段，避免"这个 t 是哪把尺子量的"这种争论。 */
export const TimeDomain = Object.freeze({
  /** performance.now()：单调、页面相对 */
  MONO: "mono",
  /** epoch 毫秒：墙上时间，可能被系统调整 */
  EPOCH: "epoch",
  /** GPX 文件内相对时间：只有间隔有意义，绝对原点无意义 */
  GPX_REL: "gpx_rel",
});

/** 一次锚点采样。 */
function sampleAnchors(perfNowFn, epochNowFn) {
  // 两次读取之间必然有微小间隔。先读 perf 再读 epoch 更稳：
  // perf 单调递增，epoch 若在两次读取之间被 NTP 校正，误差会被 drift 暴露出来。
  const perfMs = perfNowFn();
  const epochMs = epochNowFn();
  return { perfMs, epochMs };
}

export class TimeBase {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.perfNow] 单调时钟，默认 performance.now
   * @param {() => number} [opts.epochNow] 墙上时钟，默认 Date.now
   */
  constructor(opts = {}) {
    this._perfNow =
      opts.perfNow ??
      (() =>
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now());
    this._epochNow = opts.epochNow ?? (() => Date.now());

    /** @type {{perfMs:number, epochMs:number}|null} */
    this.anchor = null;
    /** 观测记录：每次 fix 的漂移与延迟 */
    this.observations = [];
    /** 观测上限，避免长时间实验把内存吃穿 */
    this.maxObservations = opts.maxObservations ?? 4096;
  }

  /**
   * 建立锚点。会话开始时调用一次；重新锚定会清空观测（旧观测对新锚点无意义）。
   * @returns {{perfMs:number, epochMs:number}}
   */
  anchorNow() {
    this.anchor = sampleAnchors(this._perfNow, this._epochNow);
    this.observations = [];
    return { ...this.anchor };
  }

  get anchored() {
    return this.anchor !== null;
  }

  /** 锚点给出的 epoch − perf 偏移（毫秒）。未锚定时返回 null。 */
  get offsetMs() {
    return this.anchor === null ? null : this.anchor.epochMs - this.anchor.perfMs;
  }

  /** perf 域 → epoch 域。未锚定时原样返回 null，绝不猜。 */
  perfToEpoch(perfMs) {
    if (this.anchor === null || !Number.isFinite(perfMs)) return null;
    return perfMs + this.offsetMs;
  }

  /** epoch 域 → perf 域。 */
  epochToPerf(epochMs) {
    if (this.anchor === null || !Number.isFinite(epochMs)) return null;
    return epochMs - this.offsetMs;
  }

  /**
   * 记录一次 GPS fix 的时间关系。
   *
   * 三个量必须分开，混在一起就说不清是谁的问题：
   *   - `latencyMs`：位置确定 → 我们收到，隔了多久。含 GPS 芯片解算、
   *     系统定位服务排队、`maximumAge` 缓存命中。
   *   - `driftMs`：用锚点推算出的 epoch 与 fix 自带 epoch 的差。
   *     注意它的**期望值不是 0**，而是 `−latencyMs`：fix 发生在过去。
   *     真正说明"时钟出问题"的是它**相对中位数的突变**，见 `clockJumpMs`。
   *   - `ageMs`：fix 自报的年龄（若可用），与 latency 交叉验证。
   *
   * @param {object} fix 至少含 tEpochMs
   * @param {number} arrivalPerfMs 收到 fix 的单调时刻
   */
  observeFix(fix, arrivalPerfMs) {
    if (this.anchor === null) return null;
    const tEpoch = Number.isFinite(fix && fix.tEpochMs) ? fix.tEpochMs : null;
    if (tEpoch === null) return null;

    const arrivalEpoch = this.perfToEpoch(arrivalPerfMs);
    // 收到时刻（换算到 epoch 域）与 fix 时刻之差 = 这个 fix 有多"旧"
    const latencyMs = arrivalEpoch - tEpoch;
    const driftMs = tEpoch - arrivalEpoch;

    const obs = {
      arrivalPerfMs,
      tEpochMs: tEpoch,
      latencyMs: Math.round(latencyMs),
      driftMs: Math.round(driftMs),
    };
    this.observations.push(obs);
    if (this.observations.length > this.maxObservations) {
      this.observations.splice(0, this.observations.length - this.maxObservations);
    }
    return obs;
  }

  /**
   * 时钟跳变检测。
   *
   * 判据不是"延迟很大"——延迟本来就可能是 30 秒。判据是：
   * 用**最近一段观测的中位延迟**当作基线，若某个 fix 的延迟偏离基线超过阈值，
   * 且这种偏离在后续 fix 上持续存在（不是单次抖动），才判为时钟跳变。
   *
   * 单次偏离多半是 GPS 给了个缓存点，连续偏离才是系统时间被改了。
   *
   * @param {object} [opts]
   * @param {number} [opts.window] 参与基线估计的观测数
   * @param {number} [opts.jumpMs] 判定为跳变的偏离阈值
   * @returns {{jumped:boolean, baselineMs:number|null, deltaMs:number|null, sincePerfMs:number|null}}
   */
  detectClockJump(opts = {}) {
    const window = opts.window ?? 20;
    const jumpMs = opts.jumpMs ?? 5000;
    const list = this.observations;
    if (list.length < 4) {
      return { jumped: false, baselineMs: null, deltaMs: null, sincePerfMs: null };
    }

    const head = list.slice(0, Math.max(3, Math.min(window, list.length - 1)));
    const tail = list.slice(-3);
    const baseline = median(head.map((o) => o.latencyMs));
    const recent = median(tail.map((o) => o.latencyMs));
    const delta = recent - baseline;

    if (Math.abs(delta) <= jumpMs) {
      return { jumped: false, baselineMs: baseline, deltaMs: delta, sincePerfMs: null };
    }
    // 找出这段"新基线"是从哪一条开始的
    let since = null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (Math.abs(list[i].latencyMs - baseline) > jumpMs) since = list[i].arrivalPerfMs;
      else break;
    }
    return { jumped: true, baselineMs: baseline, deltaMs: delta, sincePerfMs: since };
  }

  /** 延迟统计。用于界面展示与导出。 */
  latencyStats() {
    if (this.observations.length === 0) {
      return { count: 0, medianMs: null, p95Ms: null, maxMs: null, minMs: null };
    }
    const v = this.observations.map((o) => o.latencyMs).sort((a, b) => a - b);
    return {
      count: v.length,
      medianMs: median(v),
      p95Ms: percentileSorted(v, 0.95),
      maxMs: v[v.length - 1],
      minMs: v[0],
    };
  }

  /** 导出用：把观测压成定长摘要，避免 JSON 无限膨胀。 */
  summary() {
    const jump = this.detectClockJump();
    return {
      anchored: this.anchored,
      offset_ms: this.offsetMs === null ? null : Math.round(this.offsetMs),
      observation_count: this.observations.length,
      latency: this.latencyStats(),
      clock_jump: {
        jumped: jump.jumped,
        baseline_ms: jump.baselineMs === null ? null : Math.round(jump.baselineMs),
        delta_ms: jump.deltaMs === null ? null : Math.round(jump.deltaMs),
        since_perf_ms: jump.sincePerfMs,
      },
    };
  }

  toJSON() {
    return this.summary();
  }
}

/** 中位数。空数组返回 null（不是 0——0 会被误读成"延迟为零"）。 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const v = values.slice().sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** 已排序数组的分位数，避免重复排序。 */
export function percentileSorted(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}
