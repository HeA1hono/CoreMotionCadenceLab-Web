/**
 * 合成运动信号生成器 —— Windows 侧"模拟数据"来源，同时供 Node 单测使用。
 *
 * 为什么需要它：
 * Windows 上没有运动传感器，Chrome/Edge 的 devicemotion 不会给出真实数据。
 * 若不做合成数据源，整条采集链路（事件归一化 → 环形缓冲 → 频率统计 →
 * 中断判定 → 导出）在真机之前完全无法验证。
 *
 * 纪律：合成数据必须始终带 MOCK 标记，任何导出物的文件名与 note 都要写明，
 * 不得与真机数据混同（沿用阶段 C 的 MOCK 四道防线原则）。
 *
 * 所有随机数来自可播种的 PRNG，同一 seed 结果完全一致，
 * 这样单元测试可以断言具体数值，而不是"大概差不多"。
 */

export const GRAVITY = 9.80665;

/** mulberry32：32 位可播种伪随机数生成器，周期足够本用途。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller，用两个均匀分布造一个标准正态。 */
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function magnitude(x, y, z) {
  if (x === null || y === null || z === null) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return Math.sqrt(x * x + y * y + z * z);
}

/** 场景预设。spm=0 表示静止。 */
export const SCENE_PRESETS = Object.freeze({
  still: { label: "静止", spm: 0, amp: 0.0, tremorAmp: 0.05 },
  handheld: { label: "手持静止", spm: 0, amp: 0.0, tremorAmp: 0.35 },
  walk: { label: "步行 120", spm: 120, amp: 3.0, tremorAmp: 0.05 },
  jog: { label: "慢跑 170", spm: 170, amp: 7.0, tremorAmp: 0.05 },
});

/**
 * 生成一段步态信号。
 *
 * 模型（刻意保持简单、可解释、可断言）：
 *   垂直轴 z  —— 每一步一次冲击：amp·sin(2π f t) + h2·amp·sin(2π 2f t + φ)
 *   侧向轴 y  —— 摆动周期是步频的一半：0.25·amp·sin(2π (f/2) t)
 *   前后轴 x  —— 二阶谐波的小分量
 *   重力      —— 手机屏幕朝上时落在 −z（与 Android 符号相反，见报告 §1.1）
 *
 * @param {object} opts
 * @param {number} [opts.spm] 步/分钟，0 表示静止
 * @param {number} [opts.amp] 垂直冲击幅值（m/s²）
 * @param {number} [opts.noise] 白噪声标准差（m/s²）
 * @param {number} [opts.sampleRateHz] 采样率
 * @param {number} [opts.durationSec] 时长
 * @param {number} [opts.seed] 随机种子
 * @param {number} [opts.h2] 二阶谐波相对幅值
 * @param {number} [opts.tremorAmp] 生理震颤幅值（8–12 Hz）
 * @param {number} [opts.intervalJitterMs] 设备自报间隔的抖动幅度
 * @param {number} [opts.startMs] 起始单调时钟
 */
export function makeGaitSignal(opts = {}) {
  const spm = opts.spm ?? 120;
  const amp = opts.amp ?? 3.0;
  const noise = opts.noise ?? 0.08;
  const sampleRateHz = opts.sampleRateHz ?? 60;
  const durationSec = opts.durationSec ?? 10;
  const seed = opts.seed ?? 1;
  const h2 = opts.h2 ?? 0.35;
  const tremorAmp = opts.tremorAmp ?? 0.05;
  const intervalJitterMs = opts.intervalJitterMs ?? 0;
  const startMs = opts.startMs ?? 0;

  const rng = mulberry32(seed);
  const dtMs = 1000 / sampleRateHz;
  const n = Math.round(durationSec * sampleRateHz);
  const f = spm / 60;
  const phase2 = rng() * Math.PI * 2;
  const phase3 = rng() * Math.PI * 2;

  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const tMs = startMs + i * dtMs;
    const t = (i * dtMs) / 1000;

    let z = -GRAVITY;
    let y = 0;
    let x = 0;

    if (spm > 0) {
      z += amp * Math.sin(2 * Math.PI * f * t);
      z += h2 * amp * Math.sin(2 * Math.PI * 2 * f * t + phase2);
      y += 0.25 * amp * Math.sin(2 * Math.PI * (f / 2) * t);
      x += 0.15 * amp * Math.sin(2 * Math.PI * 2 * f * t + phase3);
    }

    if (tremorAmp > 0) {
      const tremorF = 8 + rng() * 4;
      z += tremorAmp * Math.sin(2 * Math.PI * tremorF * t);
    }

    if (noise > 0) {
      z += gaussian(rng) * noise;
      y += gaussian(rng) * noise;
      x += gaussian(rng) * noise;
    }

    samples.push({
      tMonoMs: tMs,
      agx: x,
      agy: y,
      agz: z,
      ax: x,
      ay: y,
      az: z + GRAVITY,
      alpha: 0,
      beta: 0,
      gamma: 0,
      intervalMs:
        intervalJitterMs > 0 ? dtMs + (rng() * 2 - 1) * intervalJitterMs : dtMs,
    });
  }

  return {
    config: {
      spm,
      amp,
      noise,
      sampleRateHz,
      durationSec,
      seed,
      h2,
      tremorAmp,
      intervalJitterMs,
      startMs,
      mock: true,
    },
    samples,
  };
}

/** 静止场景的便捷封装。 */
export function makeStationarySignal(opts = {}) {
  return makeGaitSignal({ spm: 0, amp: 0, tremorAmp: 0.05, ...opts });
}

/** 按预设名生成。 */
export function makeSceneSignal(presetName, opts = {}) {
  const preset = SCENE_PRESETS[presetName];
  if (!preset) throw new Error(`未知场景: ${presetName}`);
  return makeGaitSignal({
    spm: preset.spm,
    amp: preset.amp,
    tremorAmp: preset.tremorAmp,
    ...opts,
  });
}

/**
 * 用过零计数估算主频。
 * 只用于单测里验证合成信号确实落在预期频带，不参与步频算法本身
 * （步频算法在 E-W3 才实现，且用峰值检测而非过零）。
 *
 * @param {number[]} values 已去均值的序列
 * @param {number} sampleRateHz
 * @returns {number} Hz
 */
export function estimateFrequencyByCrossings(values, sampleRateHz) {
  if (!values || values.length < 4) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  let crossings = 0;
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1] - m;
    const cur = values[i] - m;
    if (prev <= 0 && cur > 0) crossings += 1;
  }
  const durationSec = (values.length - 1) / sampleRateHz;
  if (durationSec <= 0) return 0;
  return crossings / durationSec;
}
