/**
 * 步伐检测可视化（⑧）。
 *
 * 画五样东西，缺一样都会让"算法到底看到了什么"变得不可复核：
 *   1. 原始标量信号（含重力模长，浅灰包络）——算法输入的原貌
 *   2. 带通滤波后的信号（蓝线）——算法真正判峰的那条线
 *   3. 自适应阈值（橙虚线）——当前生效的门槛，随时间浮动
 *   4. 已计数的步伐（绿色实心三角）
 *   5. 被采纳但未计数 / 被拒的候选（空心三角与灰叉）——误检与漏检的线索
 *
 * 为什么不用 E-W2 的 drawWaveform：那条函数是"多通道叠一条曲线"，
 * 这里需要标记、阈值线、两类峰符号，混在一起会让两边都难维护。
 * 但列聚合（min/max 包络）与纵轴计算复用 waveform.js，保证两处口径一致。
 */

import { computeYRange } from "./waveform.js";

const COLORS = Object.freeze({
  bg: "#fbfaf8",
  grid: "#e6e2dc",
  border: "#d8d2c8",
  axisText: "#8b8378",
  raw: "#c9c3b8",
  filtered: "#2f6db5",
  threshold: "#c47a12",
  step: "#2f8f4e",
  stepPending: "#7aa88b",
  rejected: "#b04a45",
});

function yMapper(yMin, yMax, y0, height) {
  const span = yMax - yMin || 1;
  return (v) => y0 + height - ((v - yMin) / span) * height;
}

function drawEnvelope(ctx, cols, geom, color) {
  const { x0, y0, width, height, yMin, yMax } = geom;
  const yOf = yMapper(yMin, yMax, y0, height);
  const colW = width / cols.length;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < cols.length; i += 1) {
    const c = cols[i];
    if (!c) continue;
    const x = x0 + (i + 0.5) * colW;
    const yTop = yOf(c.max);
    const yBot = yOf(c.min);
    ctx.moveTo(x, yTop);
    ctx.lineTo(x, Math.max(yBot, yTop + 0.5));
  }
  ctx.stroke();
}

function drawLine(ctx, cols, geom, color, lineWidth = 1.6) {
  const { x0, y0, width, height, yMin, yMax } = geom;
  const yOf = yMapper(yMin, yMax, y0, height);
  const colW = width / cols.length;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  let down = false;
  for (let i = 0; i < cols.length; i += 1) {
    const c = cols[i];
    if (!c) {
      down = false;
      continue;
    }
    const x = x0 + (i + 0.5) * colW;
    const y = yOf(c.last);
    if (down) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    down = true;
  }
  ctx.stroke();
}

/** 时间轴刻度：相对秒数，避免把单调时钟的原始毫秒直接写给人看。 */
function drawTimeAxis(ctx, geom, tRange) {
  const { x0, y0, width, height } = geom;
  const spanSec = (tRange.to - tRange.from) / 1000;
  ctx.fillStyle = COLORS.axisText;
  ctx.font = "10px -apple-system, system-ui, sans-serif";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText(`-${spanSec.toFixed(0)}s`, x0, y0 + height + 3);
  ctx.textAlign = "right";
  ctx.fillText("now", x0 + width, y0 + height + 3);
  // 中间两档，便于估读峰间距
  ctx.textAlign = "center";
  ctx.fillText(`-${(spanSec / 2).toFixed(0)}s`, x0 + width / 2, y0 + height + 3);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {Array} opts.rawCols 原始信号列聚合
 * @param {Array} opts.filtCols 滤波信号列聚合
 * @param {{from:number,to:number}} opts.tRange
 * @param {{min:number,max:number}} [opts.yRange] 省略则自动计算
 * @param {number|null} opts.threshold 当前阈值
 * @param {Array<{t:number,y:number,counted:boolean}>} opts.steps
 * @param {Array<{t_ms:number,y:number|null,reason:string}>} opts.rejected
 * @param {object} opts.show 通道开关
 * @param {number} [opts.dpr]
 */
export function drawStepChart(canvas, opts) {
  if (!canvas || typeof canvas.getContext !== "function") return;
  const dpr = opts.dpr ?? 1;
  const cssW = canvas.clientWidth || canvas.width || 300;
  const cssH = canvas.clientHeight || canvas.height || 150;
  const pxW = Math.max(1, Math.round(cssW * dpr));
  const pxH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== pxW) canvas.width = pxW;
  if (canvas.height !== pxH) canvas.height = pxH;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  const padLeft = 34;
  const padRight = 6;
  const padTop = 16;
  const padBottom = 18;
  const geom = {
    x0: padLeft,
    y0: padTop,
    width: Math.max(1, cssW - padLeft - padRight),
    height: Math.max(1, cssH - padTop - padBottom),
  };

  const show = opts.show || {};
  const seriesForRange = [];
  if (show.raw !== false) seriesForRange.push(opts.rawCols || []);
  if (show.filtered !== false) seriesForRange.push(opts.filtCols || []);
  let yRange = opts.yRange;
  if (!yRange) {
    yRange = computeYRange(seriesForRange, {
      minSpan: 2,
      symmetric: false,
      padRatio: 0.08,
      hardMin: 0, // 模长不可能为负
    });
  }
  // 阈值高于所有数据时也要画得出来，否则"阈值线不见了"会被误读成没有阈值
  if (Number.isFinite(opts.threshold)) {
    yRange = { min: yRange.min, max: Math.max(yRange.max, opts.threshold * 1.1) };
  }
  geom.yMin = yRange.min;
  geom.yMax = yRange.max;
  const yOf = yMapper(yRange.min, yRange.max, geom.y0, geom.height);

  // 网格 + 纵轴
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = COLORS.axisText;
  ctx.font = "10px -apple-system, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i += 1) {
    const v = yRange.min + ((yRange.max - yRange.min) * i) / 4;
    const y = geom.y0 + geom.height - (geom.height * i) / 4;
    ctx.beginPath();
    ctx.moveTo(geom.x0, Math.round(y) + 0.5);
    ctx.lineTo(geom.x0 + geom.width, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillText(v.toFixed(1), geom.x0 - 4, y);
  }

  const tRange = opts.tRange;
  const span = Math.max(1, tRange.to - tRange.from);
  const xOf = (t) => geom.x0 + ((t - tRange.from) / span) * geom.width;

  if (show.raw !== false && opts.rawCols) drawEnvelope(ctx, opts.rawCols, geom, COLORS.raw);
  if (show.filtered !== false && opts.filtCols) drawLine(ctx, opts.filtCols, geom, COLORS.filtered);

  // 阈值线
  if (show.threshold !== false && Number.isFinite(opts.threshold)) {
    const y = yOf(opts.threshold);
    ctx.save();
    ctx.strokeStyle = COLORS.threshold;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(geom.x0, y);
    ctx.lineTo(geom.x0 + geom.width, y);
    ctx.stroke();
    ctx.restore();
    // 标注不能直接压在数据上：先铺一块背景，再往上抬 6px。
    // 阈值线常落在信号包络密集处，无底色时文字与曲线互相吃掉，读数不可辨。
    ctx.font = "10px -apple-system, system-ui, sans-serif";
    const label = `阈值 ${opts.threshold.toFixed(2)}`;
    const tw = (ctx.measureText ? ctx.measureText(label).width : 40) + 8;
    const ly = y - 6 < geom.y0 + 10 ? y + 8 : y - 6;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(geom.x0 + 2, ly - 10, tw, 12);
    ctx.fillStyle = COLORS.threshold;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, geom.x0 + 6, ly);
  }

  // 被拒候选：灰叉。只画在视野内的，避免长会话时每帧遍历几千条。
  //
  // 时间字段兼容 `t_ms` 与 `t` 两种写法：StepDetector 的拒绝记录用 `t_ms`
  // （与逐峰 CSV 同名列），采纳峰用 `t`。若只认一种，另一种会静默画不出来——
  // 图上看起来"没有误检"，其实是一个标记都没画。
  if (show.rejected !== false && Array.isArray(opts.rejected)) {
    ctx.strokeStyle = COLORS.rejected;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    const r = 3;
    for (const rej of opts.rejected) {
      const t = Number.isFinite(rej.t_ms) ? rej.t_ms : rej.t;
      if (!Number.isFinite(t) || t < tRange.from || t > tRange.to) continue;
      if (!Number.isFinite(rej.y)) continue;
      const x = xOf(t);
      const y = yOf(rej.y);
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 步伐标记
  if (show.steps !== false && Array.isArray(opts.steps)) {
    for (const st of opts.steps) {
      if (!Number.isFinite(st.t) || st.t < tRange.from || st.t > tRange.to) continue;
      const x = xOf(st.t);
      const y = yOf(Number.isFinite(st.y) ? st.y : 0);
      const h = 7;
      ctx.beginPath();
      ctx.moveTo(x, y - h);
      ctx.lineTo(x - 4.5, y - h + 7);
      ctx.lineTo(x + 4.5, y - h + 7);
      ctx.closePath();
      if (st.counted) {
        ctx.fillStyle = COLORS.step;
        ctx.fill();
      } else {
        ctx.strokeStyle = COLORS.stepPending;
        ctx.lineWidth = 1.3;
        ctx.stroke();
      }
    }
  }

  // 边框
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(geom.x0 + 0.5, geom.y0 + 0.5, geom.width - 1, geom.height - 1);

  drawTimeAxis(ctx, geom, tRange);

  // 图例放在绘图区上方，不压曲线
  ctx.font = "10px -apple-system, system-ui, sans-serif";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  let lx = geom.x0;
  const legend = [
    ["原始", COLORS.raw],
    ["滤波", COLORS.filtered],
    ["步伐", COLORS.step],
    ["被拒", COLORS.rejected],
  ];
  for (const [label, color] of legend) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, 5, 8, 3);
    ctx.fillStyle = COLORS.axisText;
    ctx.fillText(label, lx + 11, 1);
    lx += 11 + ctx.measureText(label).width + 12;
  }
}
