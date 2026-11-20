/**
 * 渲染层：只负责把状态画到 DOM，不含任何判定逻辑。
 * 判定全在 env.js / monitor.js / sources.js 里，便于单测。
 */

import { magnitude } from "./synth.js";
import { REJECT_LABEL } from "./stepdetect.js";

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

/* ---------------------------------------------------------------- E-W3 步伐 */

const MOTION_LABEL = {
  START: "运动开始",
  PAUSE: "运动暂停",
  RESUME: "运动恢复",
};

/**
 * 渲染运动起止记录（开始 / 暂停 / 恢复）。
 *
 * 只显示最近 8 条，但保留原始顺序：这串记录是"算法认定运动从哪一刻开始"的
 * 唯一证据，倒序会让读者以为事件是往回走的。
 *
 * @param {HTMLElement} container ul 容器
 * @param {Array<{kind:string,t_ms:number}>} events
 * @param {number|null} originMs 采集起点（用于算相对时间）
 */
export function renderMotionLog(container, events, originMs) {
  if (!container) return;
  container.textContent = "";

  const list = (events || []).slice(-8);
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "check-empty";
    li.textContent = "尚无记录";
    container.appendChild(li);
    return;
  }

  list.forEach((ev) => {
    const li = document.createElement("li");
    const label = document.createElement("strong");
    label.textContent = MOTION_LABEL[ev.kind] || String(ev.kind).toLowerCase();
    const off = document.createElement("span");
    off.className = "motion-off";
    off.textContent = fmtOffset(ev.t_ms, originMs);
    li.append(label, document.createTextNode(" "), off);
    container.appendChild(li);
  });
}

/**
 * 拒绝原因的含义必须写清楚：
 * "被拒 87 次"本身不说明任何问题，读者要知道是"低于阈值"（可能漏检）
 * 还是"间隔过近"（肩峰被正确剔除）。两类含义相反，不能混成一句。
 */
const REJECT_ORDER = [
  "threshold",
  "prominence",
  "refractory",
  "superseded",
  "rhythm",
  "duplicate-time",
  "invalid",
];

const REJECT_MEANING = {
  threshold: "峰值未越过动态阈值（0.45 m/s² 与近 3s P95 的 35% 取大）",
  prominence: "相对前 200ms 的抬升不足，多为呼吸或噪声抖动",
  refractory: "与上一峰挨得太近，按同一步的肩峰剔除（阈值随中位周期放大）",
  superseded: "同一保持窗口内出现更高的峰，本峰被取代（不算闸门拒绝）",
  rhythm: "间隔偏离近期中位周期 ±35%，不构成节律",
  "duplicate-time": "同一毫秒到达的重复事件：不计步，也不作为节奏证据",
  invalid: "数值非有限或时间戳倒退",
};

/**
 * @param {HTMLElement} tbody
 * @param {Record<string, number>|null} rejected  null = 尚未开始（区别于"全 0"）
 * @param {number} [reversed=0] 已被回溯计步撤销的否决次数
 */
export function renderRejectTable(tbody, rejected, reversed = 0) {
  if (!tbody) return;
  tbody.textContent = "";

  if (!rejected) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "empty";
    td.textContent = "尚未开始";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const total = REJECT_ORDER.reduce((sum, k) => sum + (rejected[k] || 0), 0);
  if (total === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "empty";
    // "当前 0 条"不等于"从来没拒过"：起步阶段被拒、开闸后又回溯计步的证据在下一句里。
    td.textContent = reversed > 0
      ? `当前没有生效的拒绝记录（另有 ${reversed} 次否决已因回溯计步撤销）`
      : "暂无拒绝记录";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  REJECT_ORDER.forEach((key) => {
    const n = rejected[key] || 0;
    if (n === 0) return;
    const tr = document.createElement("tr");

    const name = document.createElement("td");
    name.textContent = REJECT_LABEL[key] || key;
    name.title = key;

    const count = document.createElement("td");
    count.textContent = String(n);

    const meaning = document.createElement("td");
    meaning.className = "reject-meaning";
    meaning.textContent = REJECT_MEANING[key] || "—";

    tr.append(name, count, meaning);
    tbody.appendChild(tr);
  });
}

/**
 * 渲染人工对照回合表。
 *
 * 真值与预测分列、误差带符号、百分比用人工数作分母：
 * 三件事都是为了让"算法比人工多/少几步"一眼可读，而不是先心算再判断。
 * 真值为 0 时百分比无定义，写 "—" 而不是 0% 或无穷大。
 *
 * @param {HTMLElement} tbody
 * @param {Array} rounds ExperimentLog.rounds
 */
export function renderExperimentTable(tbody, rounds) {
  if (!tbody) return;
  tbody.textContent = "";

  const list = rounds || [];
  if (!list.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "empty";
    td.textContent = "尚无已保存回合";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  list.forEach((r) => {
    const tr = document.createElement("tr");

    const id = document.createElement("td");
    id.textContent = r.round_id;
    const meta = [r.motion_type, r.posture].filter(Boolean).join("·");
    id.title = `${meta}${r.target_spm ? ` 目标 ${r.target_spm} SPM` : ""} ${r.params_version}`;

    const manual = document.createElement("td");
    manual.textContent = String(r.manual_steps);

    const algo = document.createElement("td");
    algo.textContent = String(r.algorithm_steps);

    const err = document.createElement("td");
    err.textContent = `${r.error_steps > 0 ? "+" : ""}${r.error_steps}`;
    if (r.direction === "over") err.className = "err-over";
    else if (r.direction === "under") err.className = "err-under";

    const abs = document.createElement("td");
    abs.textContent = String(r.abs_error_steps);

    const pct = document.createElement("td");
    pct.textContent = r.abs_error_pct === null ? "—" : `${r.abs_error_pct}%`;

    // data-label 供窄屏堆叠布局使用：六列表格在手机上横向滚动很难读，
    // 改成"一回合一块、每格自带标签"后，真值与预测不会挤在同一行里被误读。
    id.dataset.label = "回合";
    manual.dataset.label = "人工（真值）";
    algo.dataset.label = "算法（预测）";
    err.dataset.label = "误差";
    abs.dataset.label = "绝对误差";
    pct.dataset.label = "绝对 %";

    tr.append(id, manual, algo, err, abs, pct);
    tbody.appendChild(tr);
  });
}
