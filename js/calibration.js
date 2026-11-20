/**
 * 显示基线校准（E-W2）。
 *
 * 这是什么：把设备静止时的重力向量测出来当零点，显示时减掉它。
 * 这样"放在桌上不动"就是一条贴着零的直线，走路时的起伏不用再跟 9.8 抢纵向空间。
 *
 * 这不是什么（必须写清楚，否则容易被当成传感器校准）：
 *   - 不写回传感器，不改变 iOS 的测量结果；
 *   - 不改变导出：CSV 里永远是未校准的原始值，校准值只活在屏幕上；
 *   - 不能修正非线性和温漂，只是减一个常数向量。
 *
 * 为什么用向量减而不是减标量模长：
 *   |a| = |v - b| ≠ |v| - |b|。后者在设备倾斜时会把姿态变化算成加速度变化。
 *   所以校准必须作用在三轴上，模长由校准后的三分量重新算。
 */

/** 判定"基线可信"的重力模长区间（m/s²）。超出说明采样时设备不在静止状态。 */
export const PLAUSIBLE_GRAVITY_MIN = 7.0;
export const PLAUSIBLE_GRAVITY_MAX = 13.0;

export class CalibrationModel {
  /**
   * @param {object} opts
   * @param {number} [opts.samplesNeeded] 需要多少个静止样本才算采集完成
   */
  constructor(opts = {}) {
    this.samplesNeeded = Math.max(3, Math.floor(opts.samplesNeeded ?? 60));
    this.reset();
  }

  reset() {
    this._capturing = false;
    this._n = 0;
    this._sum = { x: 0, y: 0, z: 0 };
    this._sumSq = { x: 0, y: 0, z: 0 };
    this._baseline = null;
    this._startedAtMs = null;
    this._finishedAtMs = null;
    this._noise = null;
  }

  get capturing() {
    return this._capturing;
  }

  get ready() {
    return this._baseline !== null;
  }

  get sampleCount() {
    return this._n;
  }

  /** 采集进度 0..1，用于给按钮画进度。 */
  get progress() {
    if (!this._capturing) return this.ready ? 1 : 0;
    return Math.min(1, this._n / this.samplesNeeded);
  }

  /** 开始（或重新开始）采集基线。重复调用会丢弃上一次未完成的累积。 */
  begin(nowMs = 0) {
    this._capturing = true;
    this._n = 0;
    this._sum = { x: 0, y: 0, z: 0 };
    this._sumSq = { x: 0, y: 0, z: 0 };
    this._startedAtMs = nowMs;
    this._finishedAtMs = null;
    this._noise = null;
    return true;
  }

  cancel() {
    this._capturing = false;
    this._n = 0;
    this._sum = { x: 0, y: 0, z: 0 };
    this._sumSq = { x: 0, y: 0, z: 0 };
    return false;
  }

  /**
   * 喂一个静止样本。三轴任一缺失即忽略——缺轴的样本会让基线偏。
   * @returns {boolean} 是否被接受
   */
  addSample(v) {
    if (!this._capturing || !v) return false;
    const { x, y, z } = v;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    this._sum.x += x;
    this._sum.y += y;
    this._sum.z += z;
    this._sumSq.x += x * x;
    this._sumSq.y += y * y;
    this._sumSq.z += z * z;
    this._n += 1;
    return true;
  }

  /**
   * 结束采集。样本不足则返回 false 且不产生基线（不拿 3 个点当"校准完成"）。
   * @returns {boolean}
   */
  finish(nowMs = 0) {
    if (!this._capturing) return false;
    if (this._n < this.samplesNeeded) return false;

    const n = this._n;
    const mean = { x: this._sum.x / n, y: this._sum.y / n, z: this._sum.z / n };
    const variance = {};
    for (const k of ["x", "y", "z"]) {
      const v = this._sumSq[k] / n - mean[k] * mean[k];
      variance[k] = v > 0 ? v : 0;
    }

    this._baseline = mean;
    this._noise = {
      x: Math.sqrt(variance.x),
      y: Math.sqrt(variance.y),
      z: Math.sqrt(variance.z),
    };
    this._capturing = false;
    this._finishedAtMs = nowMs;
    return true;
  }

  /** 减掉基线。未校准时原样返回（不返回 null，避免下游到处判空）。 */
  apply(v) {
    if (!v) return v;
    if (!this._baseline) return { x: v.x, y: v.y, z: v.z };
    const { x, y, z } = v;
    const ok = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
    if (!ok) return { x: v.x, y: v.y, z: v.z };
    return {
      x: x - this._baseline.x,
      y: y - this._baseline.y,
      z: z - this._baseline.z,
    };
  }

  /** 供 UI 与导出使用的完整描述。 */
  summary() {
    if (!this._baseline) {
      return {
        applied: false,
        samples_needed: this.samplesNeeded,
        samples_collected: this._n,
        note: "未校准：显示的是原始测量值",
      };
    }
    const b = this._baseline;
    const magnitude = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
    const plausible = magnitude >= PLAUSIBLE_GRAVITY_MIN && magnitude <= PLAUSIBLE_GRAVITY_MAX;
    return {
      applied: true,
      method: "vector-subtraction",
      samples_needed: this.samplesNeeded,
      samples_collected: this._n,
      baseline_ms2: {
        x: round6(b.x),
        y: round6(b.y),
        z: round6(b.z),
      },
      baseline_magnitude_ms2: round6(magnitude),
      noise_std_ms2: {
        x: round6(this._noise.x),
        y: round6(this._noise.y),
        z: round6(this._noise.z),
      },
      plausible_gravity: plausible,
      warning: plausible
        ? null
        : `基线模长 ${magnitude.toFixed(2)} m/s² 偏离 9.81 较远，采样时设备可能不在静止状态，建议重新校准`,
      started_at_ms: this._startedAtMs,
      finished_at_ms: this._finishedAtMs,
      note: "只影响屏幕显示与波形；CSV 导出的永远是未校准的原始值",
    };
  }
}

function round6(v) {
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 1e6) / 1e6;
}
