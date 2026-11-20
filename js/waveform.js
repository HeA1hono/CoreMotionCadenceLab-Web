/**
 * 波形缓冲与绘制（E-W2）。
 *
 * 为什么不能直接把点画成折线：
 *   60 Hz 采 60 秒是 3600 个点，而 iPhone 竖屏画布只有 ~350 个像素列。
 *   10 个样本挤进 1 列时，如果只取其中一个（首/末/平均），
 *   尖峰会被抹掉——而尖峰恰恰是判断"这步踩下去了没有"的唯一依据。
 *
 * 所以这里用**每列 min/max 包络**：一列里所有样本的最小值和最大值都保留，
 * 画成一条竖线。丢点是不可能的，代价是曲线看起来"毛"，但这是原始数据该有的样子。
 *
 * 空列返回 null 而不是 0：
 *   0 是"加速度为零"，null 是"这段时间没有数据"。这两件事完全不同，
 *   合并会把一段中断画成一条零线，看起来像"静止"，属于伪造。
 */

/** 可选时间窗（毫秒）。上限 60 秒，与缓冲容量匹配。 */
export const TIMESPANS = Object.freeze([
  { ms: 2000, label: "2 秒" },
  { ms: 5000, label: "5 秒" },
  { ms: 15000, label: "15 秒" },
  { ms: 60000, label: "60 秒" },
]);

/** 波形通道定义。key 用于 UI 开关，label 用于图例。 */
export const CHANNELS = Object.freeze({
  agx: { label: "X", color: "#d0453f", group: "axes" },
  agy: { label: "Y", color: "#2f8f4e", group: "axes" },
  agz: { label: "Z", color: "#2f6fb5", group: "axes" },
  agmag: { label: "|a| 含重力", color: "#6b4f9e", group: "mags" },
  lmag: { label: "|a| 线性", color: "#c47a12", group: "mags" },
});

/**
 * 单通道环形缓冲。时间必须单调递增（上游已保证），此处不重排、不插值。
 */
export class WaveformBuffer {
  constructor(capacity = 8192) {
    this.capacity = Math.max(2, Math.floor(capacity));
    this._t = new Float64Array(this.capacity);
    this._v = new Float64Array(this.capacity);
    this._head = 0;
    this._size = 0;
  }

  get size() {
    return this._size;
  }

  clear() {
    this._head = 0;
    this._size = 0;
  }

  /**
   * 追加一个采样。
   * 非有限值（null / NaN / Infinity）一律拒绝——缺数据就是要留空，
   * 不能拿 0 顶上。
   * @returns {boolean} 是否被接受
   */
  push(t, v) {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return false;
    if (this._size > 0) {
      const lastT = this._t[(this._head + this._size - 1) % this.capacity];
      if (t < lastT) return false; // 时间不可倒退，否则列映射会错位
    }
    const idx = (this._head + this._size) % this.capacity;
    this._t[idx] = t;
    this._v[idx] = v;
    if (this._size < this.capacity) {
      this._size += 1;
    } else {
      this._head = (this._head + 1) % this.capacity;
    }
    return true;
  }

  /** 最早与最新的时间戳；空缓冲返回 null。 */
  timeRange() {
    if (this._size === 0) return null;
    return {
      first: this._t[this._head],
      last: this._t[(this._head + this._size - 1) % this.capacity],
    };
  }

  /** 二分找第一个 >= t0 的逻辑下标；找不到返回 size。 */
  _firstIndexAtOrAfter(t0) {
    let lo = 0;
    let hi = this._size;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const t = this._t[(this._head + mid) % this.capacity];
      if (t < t0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * 取 [t0, t1] 内的原始样本（按时间顺序）。
   *
   * 与 columnize 的区别：这里不做列聚合，返回逐点值。
   * 自相关需要原始序列，聚合后的包络会把周期信息抹掉。
   *
   * @returns {Array<{t:number,v:number}>}
   */
  slice(t0, t1, maxPoints = 4096) {
    const out = [];
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return out;
    const start = this._firstIndexAtOrAfter(t0);
    for (let k = start; k < this._size; k += 1) {
      const i = (this._head + k) % this.capacity;
      const t = this._t[i];
      if (t > t1) break;
      out.push({ t, v: this._v[i] });
      if (out.length >= maxPoints) break;
    }
    return out;
  }

  /**
   * 把 [t0, t1] 内的样本按像素列聚合。
   *
   * @returns {Array<{min:number,max:number,last:number,count:number}|null>}
   *          长度恰为 cols；无样本的列为 null。
   */
  columnize(t0, t1, cols) {
    const n = Math.floor(cols);
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || !(t1 > t0) || n <= 0) {
      return new Array(Math.max(0, n)).fill(null);
    }
    const out = new Array(n).fill(null);
    const span = t1 - t0;
    const start = this._firstIndexAtOrAfter(t0);

    for (let k = start; k < this._size; k += 1) {
      const i = (this._head + k) % this.capacity;
      const t = this._t[i];
      if (t > t1) break;
      const v = this._v[i];
      let col = Math.floor(((t - t0) / span) * n);
      if (col < 0) col = 0;
      if (col >= n) col = n - 1;
      const cell = out[col];
      if (cell === null) {
        out[col] = { min: v, max: v, last: v, count: 1 };
      } else {
        if (v < cell.min) cell.min = v;
        if (v > cell.max) cell.max = v;
        cell.last = v;
        cell.count += 1;
      }
    }
    return out;
  }
}

/** 把任意正数向上取到 1 / 2 / 2.5 / 5 / 10 × 10^k 的"整数级"。 */
export function niceCeil(x) {
  if (!Number.isFinite(x) || x <= 0) return 1;
  const exp = Math.floor(Math.log10(x));
  const base = 10 ** exp;
  const m = x / base;
  const steps = [1, 2, 2.5, 5, 10];
  for (const s of steps) {
    if (m <= s + 1e-9) return s * base;
  }
  return 10 * base;
}

/**
 * 由若干列数组算出纵轴范围。
 *
 * @param {Array<Array>} columnLists 多个通道的 columnize 结果
 * @param {object} opts
 * @param {number} [opts.minSpan]  纵轴最小跨度，避免静止时噪声被放大成满屏
 * @param {number} [opts.padRatio] 上下留白比例
 * @param {boolean} [opts.symmetric] 是否强制关于 0 对称
 * @param {number} [opts.hardMin] 物理下界。低于它的部分不放留白——模长不可能为负，
 *   纵轴却标出 -1 会让人以为测到了负的模长。这是"好看"与"不说谎"的取舍，取后者。
 */
export function computeYRange(columnLists, opts = {}) {
  const minSpan = opts.minSpan ?? 2;
  const padRatio = opts.padRatio ?? 0.08;
  const symmetric = opts.symmetric ?? false;
  const hardMin = opts.hardMin ?? -Infinity;

  let lo = Infinity;
  let hi = -Infinity;
  for (const cols of columnLists || []) {
    for (const cell of cols || []) {
      if (!cell) continue;
      if (cell.min < lo) lo = cell.min;
      if (cell.max > hi) hi = cell.max;
    }
  }

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    if (symmetric) return { min: -minSpan / 2, max: minSpan / 2 };
    return { min: Math.max(hardMin, 0), max: minSpan };
  }

  if (symmetric) {
    const m = Math.max(Math.abs(lo), Math.abs(hi));
    const span = Math.max(minSpan, niceCeil(m * (1 + padRatio) * 2));
    return { min: -span / 2, max: span / 2 };
  }

  // 真实数据本身是否已经越过物理下界（加速度三轴就是这种情况）。
  // 越过了就不能钳——否则纵轴把 -12 的数据硬切在 0，曲线整段消失。
  const dataLo = lo;

  let span = hi - lo;
  if (span < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
    span = minSpan;
  }
  const pad = span * padRatio;
  const loOut = lo - pad;
  const clampable = dataLo >= hardMin;
  return { min: clampable && loOut < hardMin ? hardMin : loOut, max: hi + pad };
}

/**
 * 绘制一条通道。
 *
 * 两笔叠加，缺一笔就会在某一种密度下失真：
 *
 * 1. **包络竖线**（每列 min→max）。列数远小于样本数时（60 Hz × 5 s = 300 个样本
 *    压进 ~330 列…… 或者 60 s 压进 330 列，那才是真正的密集场景），这一笔保住尖峰。
 *    只画竖线的问题是反过来的：列数接近样本数时（320px 屏、5 s 窗），每列只有
 *    1 个样本，min == max，整条曲线退化成一排互不相连的短点，看不出波形。
 *
 * 2. **跨列折线**（连接每列最后一个样本）。稀疏时它把点连成连续曲线；密集时它
 *    落在包络内部，不会篡改尖峰。
 *
 * 空列两笔都断开——跨过空列硬连一条线就是在伪造那段时间有数据。
 */
export function drawSeries(ctx, cols, geom, color, lineWidth = 1) {
  const { x0, y0, width, height, yMin, yMax } = geom;
  const span = yMax - yMin || 1;
  const yOf = (v) => y0 + height - ((v - yMin) / span) * height;
  const colW = width / cols.length;

  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";

  // 第 1 笔：跨列折线（稀疏时的连续曲线，密集时被包络盖住）
  ctx.lineCap = "round";
  ctx.beginPath();
  let penDown = false;
  for (let i = 0; i < cols.length; i += 1) {
    const cell = cols[i];
    if (!cell) {
      penDown = false;
      continue;
    }
    const x = x0 + (i + 0.5) * colW;
    const y = yOf(cell.last);
    if (penDown) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    penDown = true;
  }
  ctx.stroke();

  // 第 2 笔：包络竖线（保尖峰）
  ctx.lineCap = "butt";
  ctx.beginPath();
  for (let i = 0; i < cols.length; i += 1) {
    const cell = cols[i];
    if (!cell) continue;
    const x = x0 + (i + 0.5) * colW;
    const yTop = yOf(cell.max);
    const yBot = yOf(cell.min);
    ctx.moveTo(x, yTop);
    ctx.lineTo(x, Math.max(yBot, yTop + 0.6)); // 单点时给 0.6px，保证可见
  }
  ctx.stroke();
}

/** 画背景网格与坐标标注。 */
export function drawFrame(ctx, geom, yRange, tRange, colors) {
  const { x0, y0, width, height } = geom;
  ctx.fillStyle = colors.bg;
  ctx.fillRect(x0, y0, width, height);

  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = colors.axisText;
  ctx.font = "10px -apple-system, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  const steps = 4;
  for (let i = 0; i <= steps; i += 1) {
    const v = yRange.min + ((yRange.max - yRange.min) * i) / steps;
    const y = y0 + height - (height * i) / steps;
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(y) + 0.5);
    ctx.lineTo(x0 + width, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillText(v.toFixed(0), x0 - 3, y);
  }

  // 零线加重：加速度的零点有物理含义，不该和普通网格线一样淡
  if (yRange.min < 0 && yRange.max > 0) {
    const span = yRange.max - yRange.min;
    const yZero = y0 + height - ((0 - yRange.min) / span) * height;
    ctx.strokeStyle = colors.zero;
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(yZero) + 0.5);
    ctx.lineTo(x0 + width, Math.round(yZero) + 0.5);
    ctx.stroke();
  }

  ctx.strokeStyle = colors.border;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, width - 1, height - 1);

  // 时间标注：右上方**绘图区以外**的一条带里写窗口跨度，避免读者误判横轴比例。
  //
  // 曾经写在 y0 + 4（绘图区左上角内侧），结果 320px 屏上"加速度模长"的峰值
  // 正好穿过这行字，灰字压在紫线上谁也看不清。挪到 y0 之上就再没有谁遮挡谁的问题，
  // 也不需要给文字加底色方块——那种方块会把曲线切出一段空白，看着像那里没数据。
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = colors.axisText;
  const spanSec = (tRange.to - tRange.from) / 1000;
  ctx.fillText(`窗口 ${spanSec.toFixed(0)} s`, x0 + width - 4, y0 - 13);
}

/**
 * 在 canvas 上绘制完整波形（含高分屏缩放）。
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {Array<{cols:Array,color:string,width:number}>} opts.series
 * @param {{from:number,to:number}} opts.tRange
 * @param {{min:number,max:number}} opts.yRange
 * @param {number} [opts.dpr]
 */
export function drawWaveform(canvas, opts) {
  if (!canvas || typeof canvas.getContext !== "function") return;
  const dpr = opts.dpr ?? 1;
  const cssW = canvas.clientWidth || canvas.width || 300;
  const cssH = canvas.clientHeight || canvas.height || 120;

  const pxW = Math.max(1, Math.round(cssW * dpr));
  const pxH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== pxW) canvas.width = pxW;
  if (canvas.height !== pxH) canvas.height = pxH;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padLeft = 26;
  const padRight = 4;
  // 顶部 15px 是给「窗口 N s」留的标注带，不属于绘图区
  const padTop = 15;
  const padBottom = 4;
  const geom = {
    x0: padLeft,
    y0: padTop,
    width: Math.max(1, cssW - padLeft - padRight),
    height: Math.max(1, cssH - padTop - padBottom),
    yMin: opts.yRange.min,
    yMax: opts.yRange.max,
  };

  const colors = {
    bg: "#fbfaf8",
    grid: "#e6e2dc",
    zero: "#b9b2a8",
    border: "#d8d2c8",
    axisText: "#8b8378",
  };

  // 整张画布统一铺底色，否则顶部那条标注带会是透明的，和卡片底色差出浅浅一条
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  drawFrame(ctx, geom, opts.yRange, opts.tRange, colors);
  for (const s of opts.series || []) {
    if (!s || !s.cols) continue;
    drawSeries(ctx, s.cols, geom, s.color, s.width ?? 1);
  }
}
