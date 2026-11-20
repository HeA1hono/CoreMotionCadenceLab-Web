/**
 * E-W3 步数与步频估算 —— 可解释的数字信号处理链。
 *
 * 本模块不碰 DOM、不读时钟、不发起任何请求：输入是已归一化的运动事件，
 * 输出是步数、步频、状态、置信度与逐峰事件记录。这样 Node 单测可以
 * 精确构造"静止""120 SPM""中途停顿""采样抖动""时间戳重复"等场景。
 *
 * ============================ 为什么这样设计 ============================
 *
 * 1) 信号用「模长」，不用单轴
 *    iPhone 在手里可能横竖斜任意姿态，单轴的直流分量会随姿态从 −9.8 变到 +9.8，
 *    同一段步行在不同握法下波形完全反过来。模长 ‖a‖ 与姿态无关。
 *
 *    但**必须是含重力模长，不是线性加速度模长**，这一点是本轮用数据纠正的：
 *      · ‖accelerationIncludingGravity‖ ≈ 9.8 + a·ĝ
 *        一阶展开就是「线性加速度在重力方向上的投影」，保留了正负号，
 *        每一步只有一个正峰（踩下去时正向、抬起来时负向，被重力直流抬着）。
 *      · ‖acceleration‖ 是零均值振荡取绝对值，
 *        数学上每个周期必然出现**两个**峰，60 SPM 会被稳定计成 120 步。
 *    两种信号都实现了（`signalMode`），并保留了一条 60 SPM 的对比测试作为证据。
 *    默认用 gravity-mag；linear 模式保留给研究者对照，不作为默认。
 *
 * 2) 0.5 Hz 高通去掉的是重力直流，不是"校准"
 *    静止时无论怎么拿，‖a‖ 都约等于 9.8，高通后归零；
 *    这与 E-W2 的「减固定向量」有本质区别——后者换握法会残留 13.9 m/s²。
 *
 * 3) 重采样到固定 50 Hz 网格
 *    iPhone 的事件间隔并不齐（17 ms ± 抖动，偶发 200–999 ms 停顿）。
 *    双二阶滤波器的系数是按固定采样率算的，直接喂不规则时间戳会让截止频率漂移。
 *    所以先把事件线性插值到 50 Hz 网格；50 Hz 对步态（0.5–6 Hz）有 8 倍余量。
 *    **跨越数据空档时绝不插值**：空档内不产生任何网格样本，滤波器状态清零，
 *    这样中断期间不会凭空长出击步。
 *
 * 4) 0.5–6 Hz 四阶巴特沃斯带通（HP 0.5 Hz → LP 6 Hz 两个双二阶级联）
 *    - 0.5 Hz 高通：去掉残余直流与缓慢的姿态漂移（手持慢晃约 0.2–0.4 Hz）。
 *    - 6 Hz 低通：抑制传感器噪声与 8–12 Hz 生理震颤。
 *      选 6 Hz 而不是 3 Hz，是因为跑步时第二谐波（约 5–6 Hz）仍携带步频信息；
 *      切到 3 Hz 会让 170 SPM 的波形接近正弦，峰更圆、更容易被阈值漏掉。
 *    巴特沃斯而不是切比雪夫：通带平坦，不放大某一段频率的假象。
 *
 * 5) 峰值判定是四道闸门，不是"有峰就算一步"
 *    ① 幅度闸门：y_peak ≥ max(0.45 m/s², 0.35 × 最近 3 秒 |y| 的 P95)
 *       绝对下限挡住静止噪声与手抖；相对项让阈值跟着运动强度走
 *       （轻走 1.5 m/s² 与快跑 8 m/s² 不能用同一个绝对阈值）。
 *       用 P95 而不是最大值：单个尖刺不该把后面 3 秒的阈值全部抬高。
 *    ② 突出度闸门：峰 - 前 200 ms 内的最小值 ≥ max(0.30, 0.35 × 相对阈值)
 *       一个骑在缓慢起伏上的"小鼓包"不算一步，必须是局部隆起。
 *    ③ 不应期：与上一个被采纳的峰间隔 ≥ 250 ms
 *       250 ms 对应 240 SPM，已高于人类步行/跑步的常见上限（约 200–220）。
 *       比这更近的第二个峰通常是落地回弹或谐波，不是独立一步。
 *    ④ 节奏闸门（本算法的核心）：连续 3 个间隔与近期节奏中位数的偏差 ≤ 35%
 *       才判定"这是一段有节律的运动"，并把这一串峰**回溯**计入步数。
 *       随机晃动也能过①②③，但过不了④；静止时更不可能连续踩中节奏。
 *       回溯计步保证"起步前 1.5 秒的步不会白丢"——决策延后，计数不延后。
 *
 * 6) 步频有两种口径，界面上必须并排说清
 *    - 实时步频：最近 6 步的中位间隔 → 60000/median。分辨率高，适合看"此刻多快"。
 *    - 5 s / 10 s / 30 s：窗口内步数 ÷ 实际覆盖时长。语义准，停步会自然回落。
 *      代价是分辨率：5 秒窗里一步就是 12 SPM。
 *    只用中位间隔会让"停止 10 秒后的 30 秒步频"仍然报 120——那不是最近 30 秒的
 *    步频，那是上一次走路时的节奏。两个口径同时给出，谁也不冒充谁。
 *
 * 7) 中断不补步、重复时间戳不重算
 *    事件时间戳由 MotionMonitor 保证严格递增；本模块再做一次防御。
 *    空档 > 150 ms 即断开分段，空档内网格样本数为 0，因此不可能计步。
 *    这一点由单测「中断期间步数不增长」直接锁死。
 */

import { WaveformBuffer } from "./waveform.js";

/** 算法参数。改任何一个都必须同步改 docs/EW3_ALGORITHM.md 与变异清单。 */
export const STEP_PARAMS = Object.freeze({
  version: "ew3-1.0.0",

  /** 重采样网格频率（Hz）。50 Hz 对 0.5–6 Hz 步态信号有 8 倍余量。 */
  gridHz: 50,
  /** 主信号。gravity-mag：含重力模长（默认）；linear：线性加速度模长（对照，低频会倍计）。 */
  signalMode: "gravity-mag",
  /** 带通下截止（Hz）。低于它的慢变分量视为姿态漂移。 */
  hpHz: 0.5,
  /** 带通上截止（Hz）。高于它的视为噪声与生理震颤。 */
  lpHz: 6.0,
  /** 允许线性插位的最大原始间隔（ms）。超过即视为数据空档，不插值。 */
  maxInterpGapMs: 150,

  /** 最小步间隔（ms）→ 上限 240 SPM。 */
  minStepIntervalMs: 250,
  /** 超过此间隔视为一次停顿（ms），节奏链断开。 */
  maxStepIntervalMs: 2000,

  /** 幅度闸门绝对下限（m/s²）。 */
  thresholdFloor: 0.45,
  /** 幅度闸门相对系数：0.35 × 最近 3 秒 |y| 的 P95。 */
  thresholdRel: 0.35,
  /** 阈值统计窗口（ms）。 */
  thresholdWindowMs: 3000,
  /** 突出度闸门下限（m/s²）。 */
  prominenceFloor: 0.3,
  /** 突出度相对系数（相对幅度阈值）。 */
  prominenceRel: 0.35,
  /** 突出度回看窗口（ms）。 */
  prominenceLookbackMs: 200,

  /** 判定节奏用的近期间隔个数（中位数窗口）。 */
  rhythmWindow: 6,
  /** 节奏容差：|interval − median| / median ≤ 此值。 */
  rhythmTolerance: 0.35,
  /** 连续多少个一致间隔才打开节奏闸门（并回溯计步）。 */
  gateOpenIntervals: 3,
  /** 打开闸门还要求自相关不低于此值——间隔一致可能是巧合，周期性不是。 */
  periodicityMin: 0.5,
  /** 自相关窗口（ms）。至少要容纳 3 个步态周期。 */
  periodicityWindowMs: 4000,

  /** 距最后一步超过此值即视为步频归零（ms）。 */
  staleStepMs: 2500,
  /** 距最后一步超过此值记为一次「暂停」（ms）。 */
  pauseMs: 2500,
  /** 事件静默超过此值记为传感器迟滞（ms）。 */
  interruptWarnMs: 1000,
  /** 事件静默超过此值记为传感器中断（ms）。 */
  interruptFailMs: 3000,

  /** 数据质量统计窗口（ms）。 */
  qualityWindowMs: 3000,
  /** 置信度用的数据质量窗口（ms）。 */
  confidenceWindowMs: 3000,
  /** 置信度里"幅度满分"对应的 P95（m/s²）。 */
  amplitudeFullScale: 1.5,
});

/** 运动状态的四个取值（与界面文案一一对应）。 */
export const MotionState = Object.freeze({
  STILL: "STILL",
  MOVING: "MOVING",
  UNSTABLE: "UNSTABLE",
  INTERRUPTED: "INTERRUPTED",
});

export const MOTION_STATE_LABEL = Object.freeze({
  STILL: "静止",
  MOVING: "运动",
  UNSTABLE: "检测不稳定",
  INTERRUPTED: "传感器中断",
});

/** 峰值被拒的原因。界面按此分类展示，不允许合并成一个"其他"。 */
export const RejectReason = Object.freeze({
  THRESHOLD: "threshold",
  PROMINENCE: "prominence",
  REFRACTORY: "refractory",
  RHYTHM: "rhythm",
  SUPERSEDED: "superseded",
  DUPLICATE_TIME: "duplicate-time",
  INVALID: "invalid",
});

export const REJECT_LABEL = Object.freeze({
  superseded: "被同窗更高峰取代",
  threshold: "低于幅度阈值",
  prominence: "突出度不足",
  refractory: "间隔过近（动态不应期）",
  rhythm: "节奏不一致",
  "duplicate-time": "时间戳重复",
  invalid: "数值非法",
});

/** 信号来源：gravity-mag = 含重力模长（默认，每步一个峰）；linear = 线性加速度模长（对照用）。 */
export const SignalMode = Object.freeze({
  GRAVITY_MAG: "gravity-mag",
  LINEAR: "linear",
});

// ---------------------------------------------------------------- 数学工具

export function finiteOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function magnitude3(x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return Math.sqrt(x * x + y * y + z * z);
}

/** 中位数（不修改入参）。空数组返回 null。 */
export function median(values) {
  if (!values || !values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const n = s.length;
  if (n % 2 === 1) return s[(n - 1) / 2];
  return (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** 线性插值分位数（与 monitor.percentile 同口径，避免跨模块依赖）。 */
export function quantile(values, p) {
  if (!values || !values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const rank = (p / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return s[lo];
  return s[lo] * (1 - (rank - lo)) + s[hi] * (rank - lo);
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * RBJ Audio EQ Cookbook 双二阶（Direct Form I）。
 *
 * 为什么自己实现而不是引库：本项目零依赖；而且参数必须能被单测逐条验证
 * （直流增益、奈奎斯特增益、单位冲激响应），第三方库的边界行为不可控。
 */
export class Biquad {
  /**
   * @param {"lowpass"|"highpass"} type
   * @param {number} fc 截止频率 Hz
   * @param {number} fs 采样率 Hz
   * @param {number} [q] 品质因数，巴特沃斯取 1/√2
   */
  constructor(type, fc, fs, q = Math.SQRT1_2) {
    this.type = type;
    this.fc = fc;
    this.fs = fs;
    this.q = q;
    this._z1 = 0;
    this._z2 = 0;
    this._design();
  }

  _design() {
    const w0 = (2 * Math.PI * this.fc) / this.fs;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * this.q);

    let b0;
    let b1;
    let b2;
    if (this.type === "lowpass") {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
    } else {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    }
    const a0 = 1 + alpha;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;

    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  reset() {
    this._z1 = 0;
    this._z2 = 0;
  }

  /**
   * 把滤波器预置到「输入恒为 x0、输出恒为 0」的稳态。
   *
   * 为什么需要：高通从零状态启动、而输入第一条就是 9.8 m/s² 的重力直流，
   * 会产生一个幅度接近 9.8 的阶跃瞬态，衰减时间约 1/0.5Hz ≈ 2 秒。
   * 这 2 秒里的瞬态峰足以被判成 1–3 步——探针里 60 SPM/30 秒就多算了 3 步。
   * 预置稳态后，第一帧输出即为 0，不产生假峰，也不吞掉真实步。
   */
  primeDc(x0) {
    if (!Number.isFinite(x0)) return;
    // DF1 稳态：y=0 时 z1 = −b0·x0，z2 = b2·x0
    this._z1 = -this.b0 * x0;
    this._z2 = this.b2 * x0;
  }

  process(x) {
    if (!Number.isFinite(x)) return 0;
    const y = this.b0 * x + this._z1;
    this._z1 = this.b1 * x - this.a1 * y + this._z2;
    this._z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /** 某个频率的稳态幅度增益，用于单测与参数论证。 */
  gainAt(freqHz) {
    const w = (2 * Math.PI * freqHz) / this.fs;
    const cos1 = Math.cos(w);
    const sin1 = Math.sin(w);
    const cos2 = Math.cos(2 * w);
    const sin2 = Math.sin(2 * w);
    const numRe = this.b0 + this.b1 * cos1 + this.b2 * cos2;
    const numIm = -(this.b1 * sin1 + this.b2 * sin2);
    const denRe = 1 + this.a1 * cos1 + this.a2 * cos2;
    const denIm = -(this.a1 * sin1 + this.a2 * sin2);
    const num = Math.hypot(numRe, numIm);
    const den = Math.hypot(denRe, denIm);
    return den === 0 ? 0 : num / den;
  }
}

/** 幅度响应：HP 0.5 Hz → LP 6 Hz 两级级联。 */
export function bandpassGain(freqHz, fs = STEP_PARAMS.gridHz, hp = STEP_PARAMS.hpHz, lp = STEP_PARAMS.lpHz) {
  const h = new Biquad("highpass", hp, fs).gainAt(freqHz);
  const l = new Biquad("lowpass", lp, fs).gainAt(freqHz);
  return h * l;
}

// ---------------------------------------------------------------- 主类

/**
 * 逐步推进的步态检测器。
 *
 * 用法：
 *   const d = new StepDetector({ source: "REAL" });
 *   d.push(record);            // 每个被 MotionMonitor 接受的事件
 *   const s = d.snapshot(now); // 任意时刻取指标（不改变计数，除暂停事件外）
 */
export class StepDetector {
  /**
   * @param {object} [opts]
   * @param {string} [opts.source] "REAL" | "MOCK"，只用于标记，不参与计算
   * @param {object} [opts.params] 覆盖 STEP_PARAMS（测试用）
   * @param {number} [opts.eventLogCapacity] 逐峰事件日志上限
   */
  constructor(opts = {}) {
    this.params = Object.freeze({ ...STEP_PARAMS, ...(opts.params || {}) });
    this.source = opts.source ?? null;
    this.eventLogCapacity = Math.max(64, opts.eventLogCapacity ?? 6000);
    this.reset();
  }

  reset() {
    const p = this.params;
    this.gridDtMs = 1000 / p.gridHz;

    this._hp = new Biquad("highpass", p.hpHz, p.gridHz);
    this._lp = new Biquad("lowpass", p.lpHz, p.gridHz);
    this._primeNeeded = true;

    // 可视化与统计缓冲：10 秒 @60Hz 约 600 点，8192 足够覆盖 60 秒窗
    this._raw = new WaveformBuffer(8192);
    this._filt = new WaveformBuffer(8192);

    this._thrWindow = []; // {t, abs}
    this._threshold = p.thresholdFloor;
    this._p95Abs = 0;

    this._hold = null; // 保持窗口内的最优候选
    this._holdStartT = null;

    // 最近 320 ms 的滤波样本。峰值确认要看后一个样本，突出度回看要看前 200 ms，
    // 两者共用这一条窗口——曾经只用「最近 3 个样本」，结果突出度实际只回看了
    // 60 ms，60 SPM 的低频步态在 60 ms 内几乎没变化，全部被判成「突出度不足」。
    this._filtWindow = [];
    this._peakSeq = 0; // 候选峰编号（含被拒）
    this._peaks = []; // 被采纳的峰（含未计数的）
    this._counted = []; // 已计数峰（步数 = length）
    this._rejected = []; // {t, y, reason, seq}
    this._rejectedCount = { threshold: 0, prominence: 0, refractory: 0, rhythm: 0, superseded: 0, "duplicate-time": 0, invalid: 0 };
    // 被回溯计步撤销的否决次数（撤销可审计）
    this._reversedRejects = 0;
    this._candidateCount = 0;

    this._events = []; // 导出用逐峰事件日志
    this._motionEvents = []; // 开始 / 暂停 / 恢复

    this._lastEventT = null;
    this._lastAcceptedT = null;
    this._lastCountedT = null;
    this._lastInterval = null;
    this._intervals = []; // 被采纳峰的间隔（ms），最多 200 个
    this._consecutive = 0;
    this._gateOpen = false;
    this._lastPeriodicity = null;

    this._gridT = null;
    this._segPrev = null;
    this._segmentStartT = null;
    this._segmentCount = 0;
    this._gaps = []; // {startMs, endMs, durationMs}

    this._sampleCount = 0;
    this._eventCount = 0;
    this._eventTimes = []; // 最近 5 秒事件时间，用于覆盖率
    this._moved = false;
    this._paused = false;

    this._mode = this.params.signalMode === SignalMode.LINEAR ? SignalMode.LINEAR : SignalMode.GRAVITY_MAG;
    this._modeReason = null;
    this._linearZeroRun = 0;
    this._agMean = null;
  }

  // ------------------------------------------------------------ 输入

  /**
   * 喂入一个事件。
   * @param {object} rec 归一化事件（tMonoMs / agx..agz / ax..az）
   * @returns {boolean} 是否被本模块接受（时间戳非法或重复则为 false）
   */
  push(rec) {
    if (!rec) return false;
    const t = rec.tMonoMs;
    if (!Number.isFinite(t)) {
      this._reject(RejectReason.INVALID, t, null);
      return false;
    }
    // 防御性再查一次：MotionMonitor 已保证严格递增，但本模块可能被单独使用。
    if (this._lastEventT !== null && t <= this._lastEventT) {
      this._reject(RejectReason.DUPLICATE_TIME, t, null);
      return false;
    }

    // 暂停判定不能只靠 snapshot 轮询：如果上层恰好没有定时器（单测、后台节流），
    // "停了 5 秒又走了 10 秒"会被记成一次连续运动，PAUSE/RESUME 全部丢失。
    // 所以在事件到达时就检查一次，snapshot 里再兜一次"事件彻底不来"的情况。
    if (
      this._moved &&
      !this._paused &&
      this._lastCountedT !== null &&
      t - this._lastCountedT > this.params.pauseMs
    ) {
      this._paused = true;
      this._moved = false;
      this._noteMotion("PAUSE", this._lastCountedT + this.params.pauseMs);
    }

    const value = this._selectSignal(rec);
    if (value === null) return false;

    this._eventCount += 1;
    this._lastEventT = t;
    this._eventTimes.push(t);
    while (this._eventTimes.length && t - this._eventTimes[0] > 5000) this._eventTimes.shift();

    this._raw.push(t, value);
    this._resample(t, value);
    return true;
  }

  /**
   * 选择本次样本的标量信号。
   *
   * 返回 null 表示这一条事件不能用于检测（缺轴 / 非有限值），
   * 但事件本身仍计入到达统计——这是"收到了但用不了"，与"没收到"不同。
   *
   * 两种模式的取舍见文件头 §1：默认 gravity-mag，因为零均值的线性模长
   * 每周期必然两峰，低频步态会被稳定倍计。
   */
  _selectSignal(rec) {
    const lin = magnitude3(rec.ax, rec.ay, rec.az);
    const agm = magnitude3(rec.agx, rec.agy, rec.agz);

    if (this._mode === SignalMode.LINEAR) {
      if (lin === null) {
        // 连续缺线性通道 → 永久回退，并记录原因
        this._linearZeroRun += 1;
        if (this._linearZeroRun >= 10) this._fallback("linear-channel-null");
        return agm;
      }
      // iOS 理论上不会给"有字段但恒为 0"；真给了就是异常。
      // 长时间全 0 且含重力模长在变化时，说明线性通道失效，必须回退。
      if (lin < 1e-9) {
        this._linearZeroRun += 1;
        if (agm !== null) {
          this._agMean = this._agMean === null ? agm : this._agMean * 0.99 + agm * 0.01;
          if (this._linearZeroRun >= 120 && Math.abs(agm - this._agMean) > 0.15) {
            this._fallback("linear-channel-zero");
          }
        }
      } else {
        this._linearZeroRun = 0;
      }
      return lin;
    }

    // 默认：含重力模长
    if (agm === null) {
      // 含重力通道缺失（极罕见）→ 连续 10 条都缺才回退，
      // 单条坏数据就换信号源会让模式来回跳，反而制造分段与瞬态。
      this._gravityNullRun = (this._gravityNullRun || 0) + 1;
      if (this._gravityNullRun >= 10 && lin !== null) {
        this._fallback("gravity-channel-null");
        return lin;
      }
      if (lin === null) {
        this._reject(RejectReason.INVALID, rec.tMonoMs, null);
        return null;
      }
      return lin;
    }
    this._gravityNullRun = 0;
    return agm;
  }

  _fallback(reason) {
    const next = this._mode === SignalMode.LINEAR ? SignalMode.GRAVITY_MAG : SignalMode.LINEAR;
    this._mode = next;
    this._modeReason = reason;
    this._resetSegment();
  }

  /**
   * 线性插值到固定网格。
   *
   * 关键点：`maxInterpGapMs` 之前的最后一条与当前条之差不允许超过阈值，
   * 超过就断段——空档里一个网格样本都不产生。这是"不编造步数"的实现级保证。
   */
  _resample(t, v) {
    if (!this._segPrev) {
      this._segPrev = { t, v };
      return;
    }
    const dtRaw = t - this._segPrev.t;
    if (!(dtRaw > 0) || dtRaw > this.params.maxInterpGapMs) {
      this._breakSegment(this._segPrev.t, t);
      this._segPrev = { t, v };
      return;
    }

    if (this._gridT === null) this._gridT = this._segPrev.t;
    const prev = this._segPrev;
    while (this._gridT + this.gridDtMs <= t) {
      const gt = this._gridT + this.gridDtMs;
      const u = (gt - prev.t) / dtRaw;
      this._onGrid(gt, prev.v + u * (v - prev.v));
      this._gridT = gt;
    }
    this._segPrev = { t, v };
  }

  _breakSegment(fromMs, toMs) {
    const duration = toMs - fromMs;
    this._gaps.push({ startMs: fromMs, endMs: toMs, durationMs: duration });
    if (this._gaps.length > 200) this._gaps.shift();
    this._resetSegment();
  }

  /** 断段：清滤波器状态、清峰值待确认队列、关节奏闸门（不补步）。 */
  _resetSegment() {
    this._hp.reset();
    this._lp.reset();
    this._primeNeeded = true;
    this._filtWindow = [];
    this._hold = null; // 断段时挂着未决的峰不补计——宁可少一步，不跨空档造一步
    this._holdStartT = null;
    this._gridT = null;
    this._segPrev = null;
    this._consecutive = 0;
    this._gateOpen = false;
    this._segmentCount += 1;
    this._thrWindow = [];
    this._threshold = this.params.thresholdFloor;
  }

  /** 一个网格样本：带通 → 缓冲 → 阈值 → 峰确认。 */
  _onGrid(t, x) {
    if (this._primeNeeded) {
      this._hp.primeDc(x);
      this._lp.reset();
      this._primeNeeded = false;
      this._segmentStartT = t;
    }
    const y = this._lp.process(this._hp.process(x));
    this._filt.push(t, y);
    this._sampleCount += 1;

    const abs = Math.abs(y);
    this._thrWindow.push({ t, abs });
    while (this._thrWindow.length && t - this._thrWindow[0].t > this.params.thresholdWindowMs) {
      this._thrWindow.shift();
    }
    this._updateThreshold();

    this._filtWindow.push({ t, y });
    const keepMs = Math.max(this.params.prominenceLookbackMs + 100, 300);
    while (this._filtWindow.length > 2 && t - this._filtWindow[0].t > keepMs) {
      this._filtWindow.shift();
    }

    const n = this._filtWindow.length;
    if (n >= 3) {
      const a = this._filtWindow[n - 3];
      const b = this._filtWindow[n - 2];
      const c = this._filtWindow[n - 1];
      // 严格大于前一个、且不低于后一个 → b 是已确认的局部极大
      if (b.y > a.y && b.y >= c.y) this._onCandidate(b.t, b.y);
    }

    // 保持窗口到期时即使没有新候选也要结算，否则一次连续候选之后
    // 最后一个峰会被永远挂着，步数少 1。
    if (this._hold && this._holdStartT !== null && t - this._holdStartT >= this._holdMs()) {
      this._finalizeHold(t);
    }
  }

  _updateThreshold() {
    if (!this._thrWindow.length) {
      this._threshold = this.params.thresholdFloor;
      this._p95Abs = 0;
      return;
    }
    const vals = this._thrWindow.map((s) => s.abs);
    const p95 = quantile(vals, 95) ?? 0;
    this._p95Abs = p95;
    this._threshold = Math.max(this.params.thresholdFloor, this.params.thresholdRel * p95);
  }

  // ------------------------------------------------------------ 峰值判定

  /** 峰值确认后不立即采纳，先在一个"保持窗口"里取最高者。 */
  _holdMs() {
    const med = median(this._intervals.slice(-6));
    const base = med && med > 0 ? med : 500;
    return Math.max(120, Math.min(400, base * 0.35));
  }

  /** 动态不应期：至少 250 ms，且不小于当前节奏周期的 55%。 */
  _refractoryMs() {
    const med = median(this._intervals.slice(-6));
    return Math.max(this.params.minStepIntervalMs, med && med > 0 ? med * 0.55 : 0);
  }

  /**
   * 候选峰先过幅度与突出度两道闸门，然后进入保持窗口。
   *
   * 为什么不能"过了闸门就采纳"：
   *   60 SPM 的含重力模长常出现"主峰 + 肩峰"结构，肩峰与主峰相隔 250–300 ms，
   *   既过了 250 ms 不应期，又落在 35% 的节奏容差内（740 ms vs 1000 ms），
   *   于是同一个步态周期会被计成两步。探针里 30 秒多算了 3 步，就是这么来的。
   *   保持窗口把"这一步到底是哪个峰"推迟 0.35×周期再决定，取窗口内最高者，
   *   既不多计，也不会把峰位标到肩峰上。
   */
  _onCandidate(t, y) {
    const p = this.params;
    this._candidateCount += 1;
    const seq = ++this._peakSeq;

    if (!Number.isFinite(y) || !Number.isFinite(t)) {
      this._reject(RejectReason.INVALID, t, y, seq);
      return;
    }
    if (y < this._threshold) {
      this._reject(RejectReason.THRESHOLD, t, y, seq, this._threshold);
      return;
    }

    const prom = y - this._minSince(t, p.prominenceLookbackMs);
    const promThreshold = Math.max(p.prominenceFloor, p.prominenceRel * this._threshold);
    if (prom < promThreshold) {
      this._reject(RejectReason.PROMINENCE, t, y, seq, this._threshold, prom);
      return;
    }

    if (!this._hold) {
      this._hold = { t, y, prom, seq };
      this._holdStartT = t;
    } else if (y > this._hold.y) {
      // 同一保持窗口里出现更高的峰：先前那个不是"被闸门拒绝"，而是被取代。
      // 不记录它会凭空消失——候选数减去采纳数与拒绝数就对不上，
      // 读者会怀疑算法漏掉了数据。所以单列一类原因，可复盘。
      this._reject(RejectReason.SUPERSEDED, this._hold.t, this._hold.y, this._hold.seq, this._threshold, this._hold.prom);
      this._hold = { t, y, prom, seq };
    }
    // 保持窗口按"第一个候选出现的时刻"计时，不因后续更高峰而延长，
    // 否则连续多个候选会让决策无限推迟。
    if (this._holdStartT !== null && t - this._holdStartT >= this._holdMs()) {
      this._finalizeHold(t);
    }
  }

  /** 保持窗口到期：把窗口内最高的候选交给节奏逻辑。 */
  _finalizeHold(nowT) {
    if (!this._hold) {
      this._holdStartT = null;
      return;
    }
    const cand = this._hold;
    this._hold = null;
    this._holdStartT = null;
    this._acceptPeak(cand);
  }

  _acceptPeak(cand) {
    const p = this.params;
    const refractory = this._refractoryMs();
    if (this._lastAcceptedT !== null && cand.t - this._lastAcceptedT < refractory) {
      this._reject(RejectReason.REFRACTORY, cand.t, cand.y, cand.seq, this._threshold, cand.prom);
      return;
    }

    const interval = this._lastAcceptedT === null ? null : cand.t - this._lastAcceptedT;
    const peak = {
      seq: cand.seq,
      t: cand.t,
      y: round6(cand.y),
      threshold: round6(this._threshold),
      prominence: round6(cand.prom),
      intervalMs: interval === null ? null : round6(interval),
      counted: false,
      countedAtMs: null,
      stepIndex: null,
    };
    this._peaks.push(peak);
    if (this._peaks.length > 4000) this._peaks.shift();
    this._lastAcceptedT = cand.t;
    this._lastInterval = interval;

    if (interval === null) {
      this._consecutive = 1;
    } else {
      // 超过 2 秒的间隔是"停顿"，不是节奏，不能进中位数窗口——
      // 否则停一次之后的中位数会被拉长，恢复行走的头几步会被误拒。
      if (interval <= p.maxStepIntervalMs) {
        this._intervals.push(interval);
        if (this._intervals.length > 200) this._intervals.shift();
      }
      const rhythmic = this._isRhythmic(interval);
      this._consecutive = rhythmic ? this._consecutive + 1 : 1;
      if (!rhythmic) this._gateOpen = false;
    }

    if (!this._gateOpen && this._consecutive >= p.gateOpenIntervals) {
      // 第三道独立证据：间隔一致可能是巧合（随机晃动也会连续几次落在 35% 内），
      // 但"信号本身以这个周期重复"不能用巧合解释。自相关不足就不开闸门。
      const rho = this._periodicity(median(this._intervals.slice(-p.rhythmWindow)));
      if (rho !== null && rho >= p.periodicityMin) {
        this._gateOpen = true;
        this._lastPeriodicity = rho;
        this._backfillCount(peak);
      } else {
        this._lastPeriodicity = rho;
        this._reject(RejectReason.RHYTHM, cand.t, cand.y, cand.seq, this._threshold, cand.prom, peak);
      }
    } else if (this._gateOpen) {
      this._countPeak(peak);
    } else {
      this._reject(RejectReason.RHYTHM, cand.t, cand.y, cand.seq, this._threshold, cand.prom, peak);
    }
  }

  /**
   * 归一化自相关 ρ(L)，L 取一个步态周期。
   *
   * 只在"准备打开闸门"时调用，每次代价 O(N)，N ≈ 200，可忽略。
   * 只取当前分段内的样本：跨过数据空档的序列不是等间隔的，
   * 对它做自相关等于给空档编造一个周期。
   *
   * @returns {number|null} ρ ∈ [−1, 1]；样本不足返回 null
   */
  _periodicity(lagMs) {
    if (!Number.isFinite(lagMs) || lagMs <= 0) return null;
    if (this._lastAcceptedT === null) return null;
    const p = this.params;
    const to = this._lastAcceptedT;
    const from = Math.max(to - p.periodicityWindowMs, this._segmentStartT ?? to - p.periodicityWindowMs);
    const pts = this._filt.slice(from, to, 2048);
    const lag = Math.round(lagMs / this.gridDtMs);
    if (lag < 3 || pts.length < lag * 3) return null;
    let num = 0;
    let d1 = 0;
    let d2 = 0;
    for (let i = 0; i + lag < pts.length; i += 1) {
      const a = pts[i].v;
      const b = pts[i + lag].v;
      num += a * b;
      d1 += a * a;
      d2 += b * b;
    }
    const den = Math.sqrt(d1 * d2);
    return den > 0 ? num / den : null;
  }

  /** 当前间隔是否与近期节奏一致（无历史时视为一致，允许起步）。 */
  _isRhythmic(interval) {
    const p = this.params;
    if (interval > p.maxStepIntervalMs) return false;
    const hist = this._intervals.slice(-1 - p.rhythmWindow, -1); // 不含当前
    if (hist.length < 2) return true;
    const med = median(hist);
    if (!med) return true;
    return Math.abs(interval - med) / med <= p.rhythmTolerance;
  }

  /**
   * 回溯计步：闸门刚打开时，把当前节奏链上的峰一次性计入。
   *
   * 为什么必须有这一步：节奏判定需要 3 个间隔，若只从第 3 个间隔之后开始计数，
   * 每次起步都会稳定丢掉 2–3 步，人工对照实验里表现为系统性少计——
   * 那不是算法保守，那是把"延迟决策"错误地做成了"丢弃数据"。
   */
  _backfillCount() {
    const n = Math.min(this._consecutive, this._peaks.length);
    const chain = this._peaks.slice(this._peaks.length - n);
    for (const pk of chain) {
      if (!pk.counted) this._countPeak(pk, true);
    }
  }

  _countPeak(peak, backfill = false) {
    if (peak.counted) return;
    // 回溯计步会"翻案"：闸门打开前因节奏不足被拒的峰，现在证明它就是这一步。
    // 不撤销那条否决记录，就会出现"同一个 seq 既是 reject 又是 step"，
    // 逐峰 CSV 里一对矛盾行，拒绝计数也会虚高。
    // 撤销时留一个计数器（reversedRejects），保证撤销本身可被审计，不是悄悄删掉。
    if (peak.rejectReason) {
      const reason = peak.rejectReason;
      this._rejectedCount[reason] = Math.max(0, (this._rejectedCount[reason] || 0) - 1);
      this._reversedRejects += 1;
      const idx = this._events.findIndex(
        (ev) => ev.kind === "reject" && ev.seq === peak.seq && ev.t_ms === peak.t
      );
      if (idx >= 0) this._events.splice(idx, 1);
      const ridx = this._rejected.findIndex((r) => r.seq === peak.seq && r.t_ms === peak.t);
      if (ridx >= 0) this._rejected.splice(ridx, 1);
      peak.rejectReason = null;
      peak.rejectReversed = true;
    }
    peak.counted = true;
    peak.countedAtMs = peak.t;
    peak.stepIndex = this._counted.length + 1;
    peak.backfilled = backfill;
    this._counted.push(peak);
    if (this._counted.length > 6000) this._counted.shift();
    this._lastCountedT = peak.t;
    // 生命周期：第一次计步 → START；暂停后第一次计步 → RESUME。
    // 两者必须分开记，否则"运动中断后再恢复"在记录里看起来像"又从零开始"。
    if (this._paused) {
      this._noteMotion("RESUME", peak.t);
      this._paused = false;
      this._moved = true;
    } else if (!this._moved) {
      this._noteMotion("START", peak.t);
      this._moved = true;
    }
    this._events.push({
      kind: "step",
      // 带上峰序号：否决记录也用同一个序号，两者可以互相对照。
      // 没有它就无法检查"同一个峰是否既被拒又被计步"。
      seq: peak.seq,
      t_ms: round6(peak.t),
      y: peak.y,
      threshold: peak.threshold,
      prominence: peak.prominence,
      interval_ms: peak.intervalMs,
      step_index: peak.stepIndex,
      counted: true,
      reason: null,
      backfilled: backfill,
    });
    this._trimEvents();
  }

  _minSince(t, windowMs) {
    let min = Infinity;
    for (let i = this._filtWindow.length - 1; i >= 0; i -= 1) {
      if (t - this._filtWindow[i].t > windowMs) break;
      if (this._filtWindow[i].y < min) min = this._filtWindow[i].y;
    }
    return Number.isFinite(min) ? min : 0;
  }

  _reject(reason, t, y, seq = null, threshold = null, prominence = null, peak = null) {
    this._rejectedCount[reason] = (this._rejectedCount[reason] || 0) + 1;
    const rec = {
      t_ms: Number.isFinite(t) ? round6(t) : null,
      y: Number.isFinite(y) ? round6(y) : null,
      threshold: threshold === null ? null : round6(threshold),
      prominence: prominence === null ? null : round6(prominence),
      reason,
    };
    this._rejected.push({ ...rec, seq });
    if (this._rejected.length > 2000) this._rejected.shift();
    this._events.push({ kind: "reject", ...rec, seq, counted: false, step_index: null });
    this._trimEvents();
    if (peak) peak.rejectReason = reason;
  }

  _trimEvents() {
    if (this._events.length > this.eventLogCapacity) {
      this._events.splice(0, this._events.length - this.eventLogCapacity);
    }
  }

  _noteMotion(kind, tMs) {
    const last = this._motionEvents[this._motionEvents.length - 1];
    // 同一毫秒不重复记；START 之后紧跟 RESUME 属于状态错乱，直接忽略
    if (last && last.kind === kind && Math.abs(last.t_ms - tMs) < 1) return;
    this._motionEvents.push({ kind, t_ms: round6(tMs) });
    if (this._motionEvents.length > 200) this._motionEvents.shift();
  }

  // ------------------------------------------------------------ 输出

  /**
   * 取当前指标。可重复调用（暂停事件只会记一次）。
   * @param {number} nowMs 当前单调时钟毫秒
   */
  snapshot(nowMs) {
    const p = this.params;
    const now = Number.isFinite(nowMs) ? nowMs : this._lastEventT ?? 0;

    // 会话末尾往往没有"下一个峰"来触发结算，这里按时间把保持窗口关掉。
    // 这只影响最后一步的计入时机，不改变判定规则。
    if (this._hold && this._holdStartT !== null && now - this._holdStartT >= this._holdMs()) {
      this._finalizeHold(now);
    }

    const sinceEvent = this._lastEventT === null ? null : Math.max(0, now - this._lastEventT);
    const sinceStep = this._lastCountedT === null ? null : Math.max(0, now - this._lastCountedT);

    // 暂停判定：从"运动中"掉出来时记一次，不重复记
    if (this._moved && sinceStep !== null && sinceStep > p.pauseMs) {
      if (!this._paused) {
        this._paused = true;
        this._moved = false;
        this._noteMotion("PAUSE", this._lastCountedT + p.pauseMs);
      }
    }

    const state = this._computeState(sinceEvent, sinceStep);

    const live = this._cadenceLive(now);
    const c5 = this._cadenceWindow(now, 5000);
    const c10 = this._cadenceWindow(now, 10000);
    const c30 = this._cadenceWindow(now, 30000);

    const quality = this._quality(now);
    const confidence = this._confidence(state, now, quality);

    return {
      source: this.source,
      mode: this._mode,
      modeReason: this._modeReason,
      paramsVersion: p.version,

      steps: this._counted.length,
      candidateCount: this._candidateCount,
      acceptedCount: this._peaks.length,
      rejectedCount: sumRejects(this._rejectedCount),
      rejected: { ...this._rejectedCount },
      // 判定漏斗：候选 = 通过闸门 + 闸门拒绝 + 待决（仍在峰保持窗口里）
      // 闸门拒绝 = 幅度 + 突出度 + 不应期，这三道都发生在候选产生之后。
      // invalid / duplicate-time 可能在 push 阶段就发生（那时还没有候选），
      // 算进来会让等式不成立，所以单列在 rejected 里、不进漏斗。
      gateRejectedCount:
        this._rejectedCount.threshold +
        this._rejectedCount.prominence +
        this._rejectedCount.refractory,
      supersededCount: this._rejectedCount.superseded,
      pendingHoldCount: this._hold ? 1 : 0,
      reversedRejectCount: this._reversedRejects,

      cadenceSpm: live.spm,
      cadenceProvisional: live.provisional,
      cadenceWindow5Spm: c5.spm,
      cadenceWindow10Spm: c10.spm,
      cadenceWindow30Spm: c30.spm,
      cadenceWindow5Provisional: c5.provisional,
      cadenceWindow10Provisional: c10.provisional,
      cadenceWindow30Provisional: c30.provisional,

      state,
      stateLabel: MOTION_STATE_LABEL[state],
      gateOpen: this._gateOpen,
      consecutive: this._consecutive,
      periodicity: this._lastPeriodicity === null ? null : round3(this._lastPeriodicity),
      lastStepMs: this._lastCountedT,
      sinceStepMs: sinceStep,
      lastEventMs: this._lastEventT,
      sinceEventMs: sinceEvent,

      threshold: round6(this._threshold),
      p95Abs: round6(this._p95Abs),
      confidence: confidence.score,
      confidenceLevel: confidence.level,

      quality: quality.level,
      qualityLabel: quality.label,
      coveragePct: round1(quality.coverage * 100),
      expectedHz: round1(quality.expectedHz),
      gapCount: this._gaps.length,
      lastGapMs: this._gaps.length ? this._gaps[this._gaps.length - 1].durationMs : 0,

      intervalMedianMs: round1(median(this._intervals.slice(-p.rhythmWindow))),
      intervalCvPct: round1(cvPct(this._intervals.slice(-p.rhythmWindow))),

      sampleCount: this._sampleCount,
      eventCount: this._eventCount,
      // 断段次数（不是段数）：空档 > maxInterpGapMs 的次数，段数 = 它 + 1
      segmentBreaks: this._segmentCount,
      motionEvents: this._motionEvents.slice(-12),
    };
  }

  _computeState(sinceEvent, sinceStep) {
    const p = this.params;
    if (this._lastEventT === null) return MotionState.STILL;
    if (sinceEvent !== null && sinceEvent > p.interruptWarnMs) return MotionState.INTERRUPTED;
    if (this._gateOpen && sinceStep !== null && sinceStep <= p.staleStepMs) {
      return MotionState.MOVING;
    }
    // 「不稳定」判的是"有运动但不构成节律"，不是"候选峰很多"。
    // 静止时也会有一堆低于阈值的候选峰（噪声过零即产生候选），
    // 若按候选峰数量判，永远静止不下来——这个错误在探针里被抓到过。
    const recentAccepted = this._peaks.filter((pk) => pk.t >= this._lastEventT - 2000).length;
    const ampHigh = this._p95Abs >= Math.max(p.thresholdFloor * 1.6, 0.6);
    if (recentAccepted > 0 || ampHigh) return MotionState.UNSTABLE;
    return MotionState.STILL;
  }

  _cadenceLive(now) {
    const p = this.params;
    if (this._lastCountedT === null) return { spm: null, provisional: false };
    if (now - this._lastCountedT > p.staleStepMs) return { spm: 0, provisional: false };
    const tail = this._counted.slice(-6);
    if (tail.length < 2) return { spm: null, provisional: true };
    const iv = [];
    for (let i = 1; i < tail.length; i += 1) iv.push(tail[i].t - tail[i - 1].t);
    const med = median(iv);
    if (!med || med <= 0) return { spm: null, provisional: true };
    return { spm: Math.round(60000 / med), provisional: tail.length < 4 };
  }

  /**
   * 窗口步频 = 窗口内步数 ÷ 实际覆盖时长。
   *
   * 为什么三个窗口都用"计数/时长"，而不是中位间隔：
   *   中位间隔描述的是"走的时候节奏多快"，即使已经停了 10 秒，只要窗口里还剩
   *   两步，它照样报 120 —— 那不是"最近 30 秒的步频"，那是"上一次走路时的步频"。
   *   计数/时长会随停顿自然回落，语义与卡片标题一致。
   *   代价是分辨率：5 秒窗里一步就是 12 SPM。所以"实时步频"用中位间隔（分辨率高），
   *   窗口值用计数（语义准），两者并排显示，谁都不冒充谁。
   */
  _cadenceWindow(now, windowMs) {
    const from = now - windowMs;
    const inWin = this._counted.filter((pk) => pk.t >= from && pk.t <= now);
    const firstEver = this._counted.length ? this._counted[0].t : null;

    if (!inWin.length) {
      // 从未有过步 → 无数据；有过步但窗口内没有 → 0（确实没在走）
      if (firstEver === null) return { spm: null, provisional: false };
      return { spm: 0, provisional: false };
    }
    const covered = Math.min(windowMs, now - Math.max(from, firstEver));
    if (covered < 1000) return { spm: null, provisional: true };
    const spm = (inWin.length / covered) * 60000;
    return { spm: Math.round(spm), provisional: covered < windowMs * 0.5 };
  }

  _quality(now) {
    const p = this.params;
    const recent = this._eventTimes.filter((t) => t >= now - p.qualityWindowMs);
    let expectedHz = 60;
    if (recent.length >= 3) {
      const span = recent[recent.length - 1] - recent[0];
      if (span > 0) expectedHz = ((recent.length - 1) / span) * 1000;
    }
    const expected = (expectedHz * p.qualityWindowMs) / 1000;
    const coverage = expected > 0 ? clamp01(recent.length / expected) : 0;
    const recentGaps = this._gaps.filter((g) => g.endMs >= now - 10000).length;
    let level = "good";
    if (coverage < 0.7 || recentGaps >= 3) level = "poor";
    else if (coverage < 0.9 || recentGaps > 0) level = "fair";
    const label = level === "good" ? "好" : level === "fair" ? "一般" : "差";
    return { coverage, expectedHz, level, label, recentGaps };
  }

  _confidence(state, now, quality) {
    const p = this.params;
    if (state === MotionState.STILL) return { score: 0, level: "none" };

    const intervals = this._intervals.slice(-5);
    let rhythm = 0;
    if (intervals.length >= 2) {
      const cv = cvPct(intervals) / 100;
      rhythm = clamp01(1 - cv / p.rhythmTolerance);
    } else if (intervals.length === 1) {
      rhythm = 0.5;
    }

    const amp = clamp01(this._p95Abs / p.amplitudeFullScale);
    const coverage = clamp01(quality.coverage);
    const gate = this._gateOpen ? 1 : 0.25;

    const score = 100 * (0.35 * rhythm + 0.25 * amp + 0.25 * coverage + 0.15 * gate);
    const level = score >= 70 ? "high" : score >= 45 ? "medium" : "low";
    return { score: Math.round(score), level };
  }

  // ------------------------------------------------------------ 供可视化 / 导出

  /** 原始信号按列聚合（复用 E-W2 的包络算法，保尖峰）。 */
  rawSeries(fromMs, toMs, cols) {
    return this._raw.columnize(fromMs, toMs, cols);
  }

  /** 滤波信号按列聚合。 */
  filteredSeries(fromMs, toMs, cols) {
    return this._filt.columnize(fromMs, toMs, cols);
  }

  /** 窗口内的已采纳峰（含 counted 标记）。 */
  peaksIn(fromMs, toMs) {
    return this._peaks.filter((pk) => pk.t >= fromMs && pk.t <= toMs);
  }

  /** 窗口内被拒候选峰。 */
  rejectedIn(fromMs, toMs) {
    return this._rejected.filter((r) => r.t_ms !== null && r.t_ms >= fromMs && r.t_ms <= toMs);
  }

  /**
   * 在 [from, to] 内计数的步数。
   * 实验回合用它冻结算法步数：回合结束后再回溯补计不会改变已结束回合。
   */
  stepsBetween(fromMs, toMs) {
    return this._counted.filter((pk) => pk.t >= fromMs && pk.t <= toMs).length;
  }

  /** 逐峰事件日志（导出用）。 */
  eventLog() {
    return this._events.slice();
  }

  /** 导出前的一致性自检：计数必须等于 counted 事件数。 */
  selfCheck() {
    const countedEvents = this._events.filter((e) => e.kind === "step" && e.counted).length;
    const ok = countedEvents === this._counted.length;
    return {
      ok,
      countedSteps: this._counted.length,
      countedEvents,
      stepIndexMonotonic: this._counted.every((pk, i) => pk.stepIndex === i + 1),
      message: ok ? "步数与事件日志一致" : "步数与事件日志不一致，导出不可信",
    };
  }
}

function sumRejects(counts) {
  let n = 0;
  for (const k of Object.keys(counts)) n += counts[k] || 0;
  return n;
}

function cvPct(values) {
  if (!values || values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  if (!(m > 0)) return 0;
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  const sd = Math.sqrt(acc / (values.length - 1));
  return (sd / m) * 100;
}

function round1(v) {
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 10) / 10;
}

function round3(v) {
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 1000) / 1000;
}

function round6(v) {
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 1e6) / 1e6;
}
