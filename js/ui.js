/**
 * 渲染层：只负责把状态画到 DOM，不含任何判定逻辑。
 * 判定全在 env.js / monitor.js / sources.js 里，便于单测。
 */

import { magnitude } from "./synth.js";

const EMPTY = "—";

export function fmt(value, digits = 2) {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value !== "number" || !Number.isFinite(value)) return EMPTY;
  return value.toFixed(digits);
}

export function fmtFixed(value, digits = 1) {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value !== "number" || !Number.isFinite(value)) return EMPTY;
  return value.toFixed(digits);
}

/** 把秒数差格式化成 +0.0s / -1.5s 之类的相对时间 */
export function fmtOffset(ms, originMs) {
  if (originMs === null || originMs === undefined) return EMPTY;
  const d = (ms - originMs) / 1000;
  return `${d >= 0 ? "+" : ""}${d.toFixed(2)}s`;
}

export function severityToClass(severity) {
  if (severity === "OK") return "is-ok";
  if (severity === "WARN") return "is-warn";
  if (severity === "FAIL") return "is-fail";
  return "";
}

/**
 * 渲染环境自检列表。
 *
 * 用列表而不是表格：手机上四列表格会把"实测值"那一列压成一条缝，
 * 提示文字直接看不见。自检结果本来就是一维清单，列表更合适。
 */
export function renderEnvList(container, report) {
  if (!container) return;
  container.textContent = "";

  for (const check of report.checks) {
    const li = document.createElement("li");
    li.className = "check";

    const row = document.createElement("div");
    row.className = "check-row";

    const id = document.createElement("code");
    id.className = "check-id";
    id.textContent = check.id;

    const name = document.createElement("span");
    name.className = "check-name";
    name.textContent = check.label;

    const pill = document.createElement("span");
    pill.className = `state-pill ${check.severity}`;
    pill.textContent =
      check.severity === "OK"
        ? "通过"
        : check.severity === "WARN"
          ? "注意"
          : check.severity === "FAIL"
            ? "不通过"
            : "信息";

    row.append(id, name, pill);
    li.appendChild(row);

    const detail = document.createElement("p");
    detail.className = "check-detail";
    detail.textContent = check.detail;
    li.appendChild(detail);

    if (check.hint) {
      const hint = document.createElement("p");
      hint.className = "check-hint";
      hint.textContent = check.hint;
      li.appendChild(hint);
    }

    container.appendChild(li);
  }
}

/** 更新"最近一个事件"的实时数值区。 */
export function renderLiveMetrics(refs, ev) {
  if (!refs) return;
  const set = (key, text) => {
    const el = refs[key];
    if (el) el.textContent = text;
  };

  if (!ev) {
    ["m-agx", "m-agy", "m-agz", "m-agmag", "m-ax", "m-ay", "m-az", "m-almag",
      "m-alpha", "m-beta", "m-gamma"].forEach((k) => set(k, EMPTY));
    return;
  }

  set("m-agx", fmt(ev.agx));
  set("m-agy", fmt(ev.agy));
  set("m-agz", fmt(ev.agz));
  set("m-agmag", fmt(magnitude(ev.agx, ev.agy, ev.agz)));

  set("m-ax", fmt(ev.ax));
  set("m-ay", fmt(ev.ay));
  set("m-az", fmt(ev.az));
  set("m-almag", fmt(magnitude(ev.ax, ev.ay, ev.az)));

  set("m-alpha", fmt(ev.alpha, 1));
  set("m-beta", fmt(ev.beta, 1));
  set("m-gamma", fmt(ev.gamma, 1));
}

/**
 * 渲染中断与停顿记录表。
 *
 * 中断（≥1000ms）和停顿（200–999ms）合并到一张表里按时间排序，
 * 但"类型"列必须分开写：两者含义不同（一个是真断了，一个是迟滞），
 * 混成一类会让读者低估数据空档的密度。
 *
 * @param {HTMLElement} tbody
 * @param {Array} gaps   中断
 * @param {number|null} originMs
 * @param {Array} [stalls] 停顿
 */
export function renderGaps(tbody, gaps, originMs, stalls = []) {
  if (!tbody) return;
  tbody.textContent = "";

  const rows = [
    ...(gaps || []).map((g) => ({ ...g, kind: g.level === "fail" ? "中断" : "迟滞" })),
    ...(stalls || []).map((s) => ({ ...s, kind: "停顿" })),
  ].sort((a, b) => a.startMs - b.startMs);

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "empty";
    td.textContent = "暂无中断";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const recent = rows.slice(-20);
  recent.forEach((row, i) => {
    const tr = document.createElement("tr");

    const idx = document.createElement("td");
    idx.textContent = String(rows.length - recent.length + i + 1);

    const kind = document.createElement("td");
    kind.textContent = row.kind;
    if (row.kind === "中断") kind.className = "kind-fail";
    else if (row.kind === "停顿") kind.className = "kind-stall";

    const start = document.createElement("td");
    start.textContent = fmtOffset(row.startMs, originMs);

    const dur = document.createElement("td");
    dur.textContent = `${(row.durationMs / 1000).toFixed(2)}s`;

    const cause = document.createElement("td");
    cause.textContent = row.cause === "hidden" ? "页面隐藏" : "原因未知";
    if (row.cause === "hidden") cause.className = "cause-hidden";

    tr.append(idx, kind, start, dur, cause);
    tbody.appendChild(tr);
  });
}

/**
 * 画每秒事件数柱状图。
 *
 * 关键语义：**区分"尚未开始测量"与"测到了 0"**。
 * 二者在图上都表现为没有柱子，但含义完全相反——
 * 前者是 NO_DATA，后者是"这一秒真的一个事件都没来"。
 * 所以只在首个事件之后的区间里，零事件才涂成红色告警带。
 * （这正是契约里"零步频是数值、不是状态"的同一套思路。）
 */
export function drawRateChart(canvas, perSecond, opts = {}) {
  if (!canvas) return;
  const dpr = opts.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = 110;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padTop = 8;
  const padBottom = 14;
  const plotH = cssH - padTop - padBottom;
  const n = perSecond.length || 1;
  const barW = cssW / n;

  const maxCount = perSecond.reduce((m, b) => Math.max(m, b.count), 0);
  const scaleMax = Math.max(10, maxCount);

  // 测量起点：首个事件所在的秒。之前的时段属于"未测量"。
  const startSec =
    typeof opts.startTSec === "number" && Number.isFinite(opts.startTSec)
      ? opts.startTSec
      : null;

  for (let i = 0; i < perSecond.length; i += 1) {
    const bucket = perSecond[i];
    if (startSec !== null && bucket.tSec < startSec) continue; // 未测量，留白
    if (bucket.count === 0) {
      ctx.fillStyle = "#fbeae9";
      ctx.fillRect(i * barW, padTop, Math.max(barW, 1), plotH);
    }
  }

  ctx.fillStyle = "#2f6db5";
  for (let i = 0; i < perSecond.length; i += 1) {
    const c = perSecond[i].count;
    if (c === 0) continue;
    const h = Math.max(1, (c / scaleMax) * plotH);
    ctx.fillRect(i * barW + 0.5, padTop + plotH - h, Math.max(barW - 1, 1), h);
  }

  ctx.strokeStyle = "#c9d2dd";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, padTop + plotH + 0.5);
  ctx.lineTo(cssW, padTop + plotH + 0.5);
  ctx.stroke();

  ctx.fillStyle = "#8b95a3";
  ctx.font = "10px ui-monospace, monospace";
  ctx.textBaseline = "top";
  ctx.fillText(`${scaleMax}`, 2, padTop);
  ctx.fillText("-120s", 2, padTop + plotH + 2);
  ctx.textAlign = "right";
  ctx.fillText("now", cssW - 2, padTop + plotH + 2);
  ctx.textAlign = "left";

  // 未测量区加一句说明，避免把留白误读成故障
  if (startSec !== null) {
    const measured = perSecond.filter((b) => b.tSec >= startSec).length;
    if (measured < perSecond.length) {
      ctx.fillStyle = "#a8b2bf";
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "center";
      const cutIdx = perSecond.findIndex((b) => b.tSec >= startSec);
      const cx = Math.max(40, (cutIdx * barW) / 2);
      ctx.fillText("未开始采集", cx, padTop + plotH / 2 - 6);
      ctx.textAlign = "left";
    }
  }
}

/** 统一的状态徽章更新。 */
export function setBadge(el, text, className) {
  if (!el) return;
  el.textContent = text;
  el.className = `badge${className ? ` ${className}` : ""}`;
}

export function setVerdict(el, text, className) {
  if (!el) return;
  el.textContent = text;
  el.className = `verdict${className ? ` ${className}` : ""}`;
}
