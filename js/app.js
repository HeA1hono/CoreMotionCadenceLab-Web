/**
 * 编排层：把环境自检、权限、数据源、监测、导出串起来。
 *
 * 本文件是唯一允许直接操作 DOM 与浏览器 API 的地方；
 * 所有判定逻辑都在 env.js / monitor.js / sources.js 内，可脱离浏览器单测。
 */

import {
  probeEnvironment,
  summarizeVerdict,
} from "./env.js";
import { MotionMonitor } from "./monitor.js";
import { RealMotionSource, MockMotionSource, SourceState } from "./sources.js";
import {
  renderEnvList,
  renderLiveMetrics,
  renderGaps,
  drawRateChart,
  setBadge,
  setVerdict,
  fmtFixed,
} from "./ui.js";
import {
  buildRawCsv,
  buildDiagJson,
  buildFilename,
  formatStamp,
  downloadText,
  trySaveToDevServer,
  SourceLabel,
  SensorKind,
} from "./export.js";
import { makeWebSessionId, CONTRACT_VERSION } from "./contract.js";

const APP_VERSION = "0.1.0";
const UPDATE_INTERVAL_MS = 200;
/** 本机开发服务器端点。仅在 localhost 下才会被使用，见 isLocalDevHost()。 */
const DEV_SAVE_ENDPOINT = "/api/save";

const el = (id) => document.getElementById(id);

const refs = {
  "m-agx": el("m-agx"),
  "m-agy": el("m-agy"),
  "m-agz": el("m-agz"),
  "m-agmag": el("m-agmag"),
  "m-ax": el("m-ax"),
  "m-ay": el("m-ay"),
  "m-az": el("m-az"),
  "m-almag": el("m-almag"),
  "m-alpha": el("m-alpha"),
  "m-beta": el("m-beta"),
  "m-gamma": el("m-gamma"),
};

const dom = {
  ribbon: el("mock-ribbon"),
  badgeContext: el("badge-context"),
  badgeSource: el("badge-source"),
  envList: el("env-list"),
  envVerdict: el("env-verdict"),
  permVerdict: el("perm-verdict"),
  permNote: el("perm-note"),
  permHint: el("perm-hint"),
  permResult: el("perm-result"),
  btnRequest: el("btn-request"),
  btnStart: el("btn-start"),
  btnStop: el("btn-stop"),
  btnReset: el("btn-reset"),
  btnExportCsv: el("btn-export-csv"),
  btnExportJson: el("btn-export-json"),
  liveState: el("live-state"),
  rateState: el("rate-state"),
  mHz: el("m-hz"),
  mCount: el("m-count"),
  mElapsed: el("m-elapsed"),
  mSince: el("m-since"),
  mGaps: el("m-gaps"),
  mMedian: el("m-median"),
  mP95: el("m-p95"),
  mJitter: el("m-jitter"),
  mDeclared: el("m-declared"),
  canvas: el("rate-canvas"),
  gapBody: el("gap-body"),
  selSource: el("sel-source"),
  selPreset: el("sel-preset"),
  fieldPreset: el("field-preset"),
  exportResult: el("export-result"),
  exportSource: el("export-source"),
  netCounter: el("net-counter"),
  exportState: el("export-state"),
  footerMeta: el("footer-meta"),
};

const state = {
  sessionId: makeWebSessionId(),
  sourceKind: "real",
  source: null,
  monitor: new MotionMonitor({ eventCapacity: 36000 }),
  lastEvent: null,
  running: false,
  startedWallMs: null,
  visibilityLog: [],
  envReport: null,
  updateTimer: null,
  stats: null,
  lastChartDrawMs: 0,
  networkCalls: 0,
  networkLog: [],
};

/**
 * 网络请求计数器。
 *
 * 本页的承诺是"加速度数据不上传任何服务器"。静态扫描能证明代码里没有
 * 上传逻辑，但不能证明运行时确实没发请求（比如某个库偷偷发心跳）。
 * 所以这里把浏览器可用的全部出网通道包一层计数：
 *   fetch / XMLHttpRequest / sendBeacon / WebSocket / EventSource
 *
 * 计数结果会显示在导出区，并写进诊断 JSON —— 真机验收时可以直接看到
 * "本次会话网络请求：0 次"。
 *
 * 这是诊断页，观测本身就是它的职责，因此不做成可选开关。
 */
function installNetworkCounter() {
  const w = typeof window !== "undefined" ? window : null;
  if (!w) return;

  const bump = (channel, detail) => {
    state.networkCalls += 1;
    if (state.networkLog.length < 50) {
      state.networkLog.push({
        channel,
        detail: String(detail).slice(0, 160),
        at_ms: Math.round(performance.now()),
      });
    }
    renderNetworkCounter();
  };

  if (typeof w.fetch === "function") {
    const originalFetch = w.fetch.bind(w);
    w.fetch = function countedFetch(input, init) {
      bump("fetch", typeof input === "string" ? input : (input && input.url) || "?");
      return originalFetch(input, init);
    };
  }

  if (w.XMLHttpRequest && w.XMLHttpRequest.prototype) {
    const originalOpen = w.XMLHttpRequest.prototype.open;
    w.XMLHttpRequest.prototype.open = function countedOpen(method, url) {
      bump("xhr", `${method} ${url}`);
      return originalOpen.apply(this, arguments);
    };
  }

  if (w.navigator && typeof w.navigator.sendBeacon === "function") {
    const originalBeacon = w.navigator.sendBeacon.bind(w.navigator);
    w.navigator.sendBeacon = function countedBeacon(url, data) {
      bump("beacon", url);
      return originalBeacon(url, data);
    };
  }

  if (typeof w.WebSocket === "function") {
    const OriginalWS = w.WebSocket;
    const CountedWS = function CountedWebSocket(url, protocols) {
      bump("websocket", url);
      return new OriginalWS(url, protocols);
    };
    CountedWS.prototype = OriginalWS.prototype;
    w.WebSocket = CountedWS;
  }

  if (typeof w.EventSource === "function") {
    const OriginalES = w.EventSource;
    const CountedES = function CountedEventSource(url, config) {
      bump("eventsource", url);
      return new OriginalES(url, config);
    };
    CountedES.prototype = OriginalES.prototype;
    w.EventSource = CountedES;
  }
}

function renderNetworkCounter() {
  if (!dom.netCounter) return;
  const n = state.networkCalls;
  dom.netCounter.textContent =
    n === 0
      ? "本次会话网络请求：0 次（数据未离开本机）"
      : `本次会话网络请求：${n} 次（详见诊断 JSON 的 network 字段）`;
  dom.netCounter.className = n === 0 ? "net-line is-ok" : "net-line is-warn";
}

// ---------------------------------------------------------------- 环境自检

function runEnvironmentProbe() {
  const report = probeEnvironment(window);
  state.envReport = report;

  renderEnvList(dom.envList, report);

  const verdict = summarizeVerdict(report);
  setVerdict(
    dom.envVerdict,
    verdict.text,
    verdict.level === "OK" ? "is-ok" : verdict.level === "WARN" ? "is-warn" : "is-fail"
  );

  if (report.secureContext) {
    setBadge(dom.badgeContext, "安全上下文 ✓", "is-ok");
  } else {
    setBadge(dom.badgeContext, "非安全上下文", "is-fail");
  }

  if (!report.canRequest) {
    dom.btnRequest.disabled = true;
    dom.permHint.hidden = false;
    dom.permHint.textContent = report.blockedReason || "当前环境无法请求运动权限。";
  } else {
    dom.btnRequest.disabled = false;
    dom.permHint.hidden = true;
  }

  return report;
}

// ---------------------------------------------------------------- 数据源

function buildSource(kind) {
  if (state.source) {
    try {
      state.source.stop();
    } catch (_err) {
      /* 忽略停止失败 */
    }
  }

  if (kind === "mock") {
    state.source = new MockMotionSource({
      presetName: dom.selPreset.value,
      onEvent: handleEvent,
      onState: handleSourceState,
    });
  } else {
    state.source = new RealMotionSource({
      win: window,
      onEvent: handleEvent,
      onState: handleSourceState,
    });
  }

  state.sourceKind = kind;
  dom.fieldPreset.hidden = kind !== "mock";
  dom.ribbon.hidden = kind !== "mock";
  setBadge(
    dom.badgeSource,
    kind === "mock" ? "来源：MOCK · 合成信号" : "来源：REAL · 真实传感器",
    kind === "mock" ? "is-mock" : ""
  );
  updateSourceIndicator();
  dom.exportResult.textContent = "";
}

/** 在导出区常驻显示来源，避免用户把 MOCK 采集误当成真机数据。 */
function updateSourceIndicator() {
  if (!dom.exportSource) return;
  const pair = currentSourcePair();
  if (pair.source === SourceLabel.MOCK) {
    dom.exportSource.textContent =
      `来源 MOCK · 合成信号（sensor=synth）→ 导出文件名带 _WEB_MOCK`;
    dom.exportSource.className = "source-line is-mock";
  } else {
    dom.exportSource.textContent =
      `来源 REAL · 设备真实传感器（sensor=devicemotion）→ 导出文件名带 _WEB_REAL`;
    dom.exportSource.className = "source-line";
  }
}

function handleSourceState(sourceState) {
  if (sourceState === SourceState.RUNNING) {
    setVerdict(dom.liveState, "采集中", "is-ok");
  } else if (sourceState === SourceState.STOPPED) {
    setVerdict(dom.liveState, "已停止", "");
  } else if (sourceState === SourceState.ERROR) {
    setVerdict(dom.liveState, "错误", "is-fail");
  }
}

function handleEvent(record) {
  const accepted = state.monitor.push(record);
  if (accepted) state.lastEvent = record;
}

// ---------------------------------------------------------------- 权限

function requestPermissionNow() {
  // 注意：此函数必须在点击回调里**同步**调用，不得先 await 别的东西。
  return state.source.requestPermission();
}

function describePermission(result) {
  switch (result) {
    case "granted":
      return { text: "已授权（granted）", cls: "is-ok" };
    case "denied":
      return { text: "已拒绝（denied）", cls: "is-fail" };
    case "not-required":
      return { text: "无需授权（非 iOS 或旧版本）", cls: "is-warn" };
    case "unsupported":
      return { text: "不支持 DeviceMotion", cls: "is-fail" };
    default:
      return { text: `请求异常：${result}`, cls: "is-fail" };
  }
}

async function onRequestClick() {
  if (state.sourceKind === "mock") {
    dom.permResult.textContent = "模拟数据源不需要权限。";
    return;
  }
  dom.permResult.textContent = "正在请求…";
  const result = await requestPermissionNow();
  const desc = describePermission(result);
  setVerdict(dom.permVerdict, desc.text, desc.cls);
  dom.permResult.textContent = `requestPermission() → "${result}"`;

  if (result === "granted" || result === "not-required") {
    dom.btnStart.disabled = false;
    dom.permHint.hidden = true;
  } else if (result === "denied") {
    dom.permHint.hidden = false;
    dom.permHint.textContent =
      "已拒绝。iOS 上首次拒绝后，再点按钮通常不会重新弹窗，必须完全关闭 Safari（上滑杀掉）后重新打开本页。";
  } else if (String(result).startsWith("error:")) {
    dom.permHint.hidden = false;
    dom.permHint.textContent =
      "调用被拒绝。最常见原因是权限请求没有发生在真实点击的同步调用栈里（例如前面经过了 await 或延时）。请重新加载页面后直接点按钮。";
  }
}

// ---------------------------------------------------------------- 采集控制

async function onStartClick() {
  if (state.sourceKind === "real") {
    // 必须在手势内同步发起；await 之前不得有其他异步前置
    const result = await requestPermissionNow();
    if (result !== "granted" && result !== "not-required") {
      const desc = describePermission(result);
      setVerdict(dom.permVerdict, desc.text, desc.cls);
      dom.permResult.textContent = `无法开始：requestPermission() → "${result}"`;
      return;
    }
    setVerdict(dom.permVerdict, "已授权", "is-ok");
  }

  state.monitor.reset();
  state.monitor.markVisibility(document.visibilityState === "hidden" ? "hidden" : "visible", 0);
  state.lastEvent = null;
  state.stats = null;
  state.startedWallMs = Date.now();
  state.visibilityLog = [];
  state.running = true;

  // 每次开新会话都换 session_id，避免跨会话数据混在一起
  state.sessionId = makeWebSessionId();

  let started = false;
  try {
    started = state.source.start();
  } catch (err) {
    started = false;
    dom.permResult.textContent = `数据源启动失败：${String((err && err.message) || err)}`;
    setVerdict(dom.liveState, "启动失败", "is-fail");
  }

  if (!started) {
    state.running = false;
    dom.btnStart.disabled = state.sourceKind !== "mock";
    dom.btnStop.disabled = true;
    return;
  }

  dom.btnStart.disabled = true;
  dom.btnStop.disabled = false;
  dom.btnReset.disabled = false;
  dom.btnExportCsv.disabled = true;
  dom.btnExportJson.disabled = true;
  dom.exportResult.textContent = "";
  setVerdict(dom.liveState, "采集中", "is-ok");
  setVerdict(dom.rateState, "等待事件…", "");

  startUpdateLoop();
}

function onStopClick() {
  state.running = false;
  try {
    state.source.stop();
  } catch (_err) {
    /* 忽略 */
  }
  const now = performance.now();
  state.monitor.finalize(now);
  stopUpdateLoop();
  refreshStats(now, true);

  dom.btnStop.disabled = true;
  dom.btnReset.disabled = false;
  if (state.sourceKind === "mock") dom.btnStart.disabled = false;
  else dom.btnStart.disabled = false;

  const count = state.monitor.totalPushed;
  dom.btnExportCsv.disabled = count === 0;
  dom.btnExportJson.disabled = count === 0;
  setVerdict(dom.rateState, count ? `已停止 · ${count} 个事件` : "已停止 · 无数据", "");
}

function onResetClick() {
  state.monitor.reset();
  state.lastEvent = null;
  state.stats = null;
  state.startedWallMs = null;
  state.visibilityLog = [];
  renderLiveMetrics(refs, null);
  setMetricText("0", "0.0", "—", "0", "—", "—", "—", "—");
  dom.gapBody.textContent = "";
  renderGaps(dom.gapBody, [], null);
  drawRateChart(dom.canvas, [], { devicePixelRatio: window.devicePixelRatio || 1 });
  dom.btnExportCsv.disabled = true;
  dom.btnExportJson.disabled = true;
  dom.exportResult.textContent = "";
  setVerdict(dom.liveState, "空闲", "");
  setVerdict(dom.rateState, "空闲", "");
}

function startUpdateLoop() {
  stopUpdateLoop();
  state.updateTimer = setInterval(() => {
    refreshStats(performance.now(), false);
  }, UPDATE_INTERVAL_MS);
}

function stopUpdateLoop() {
  if (state.updateTimer) {
    clearInterval(state.updateTimer);
    state.updateTimer = null;
  }
}

function setMetricText(hz, elapsed, since, gaps, median, p95, jitter, declared) {
  if (dom.mHz) dom.mHz.textContent = hz;
  if (dom.mElapsed) dom.mElapsed.textContent = elapsed;
  if (dom.mSince) dom.mSince.textContent = since;
  if (dom.mGaps) dom.mGaps.textContent = gaps;
  if (dom.mMedian) dom.mMedian.textContent = median;
  if (dom.mP95) dom.mP95.textContent = p95;
  if (dom.mJitter) dom.mJitter.textContent = jitter;
  if (dom.mDeclared) dom.mDeclared.textContent = declared;
}

function refreshStats(nowMs, force) {
  const stats = state.monitor.stats(nowMs);
  state.stats = stats;

  renderLiveMetrics(refs, state.lastEvent);

  if (dom.mCount) dom.mCount.textContent = String(stats.totalPushed);
  setMetricText(
    fmtFixed(stats.observedHz, 1),
    fmtFixed(stats.elapsedMs / 1000, 1),
    stats.eventCount ? fmtFixed(stats.sinceLastMs, 0) : "—",
    String(stats.gapCount),
    stats.intervalSampleCount ? fmtFixed(stats.medianIntervalMs, 1) : "—",
    stats.intervalSampleCount ? fmtFixed(stats.p95IntervalMs, 1) : "—",
    stats.intervalSampleCount ? fmtFixed(stats.jitterP95Ms, 1) : "—",
    stats.declaredIntervalMeanMs ? fmtFixed(stats.declaredIntervalMeanMs, 1) : "—"
  );

  if (stats.state === "live") {
    setVerdict(dom.rateState, "事件正常", "is-ok");
  } else if (stats.state === "interrupting") {
    setVerdict(
      dom.rateState,
      stats.interruptLevel === "fail" ? "已中断" : "迟滞",
      stats.interruptLevel === "fail" ? "is-fail" : "is-warn"
    );
  }

  renderGaps(dom.gapBody, stats.gaps, stats.firstMs);

  const now = force ? nowMs : performance.now();
  if (force || now - state.lastChartDrawMs > 1000) {
    state.lastChartDrawMs = now;
    drawRateChart(dom.canvas, stats.perSecond, {
      devicePixelRatio: window.devicePixelRatio || 1,
      startTSec: stats.firstMs === null ? null : Math.floor(stats.firstMs / 1000),
    });
  }
}

// ---------------------------------------------------------------- 导出

/**
 * 是否运行在本机开发服务器上。
 *
 * 只有 localhost 才允许把导出文件 POST 回 dev_server.py。
 * 部署到 GitHub Pages 等静态托管后，这个判断为 false，
 * 页面上**不会发出任何网络请求**（见 tools/audit_release.py 的断言）。
 */
function isLocalDevHost() {
  const host =
    typeof location !== "undefined" && location.hostname ? location.hostname : "";
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** 来源标注：REAL = 设备真实传感器，MOCK = 本地合成信号。 */
function currentSourcePair() {
  return state.sourceKind === "mock"
    ? { source: SourceLabel.MOCK, sensor: SensorKind.SYNTH }
    : { source: SourceLabel.REAL, sensor: SensorKind.DEVICEMOTION };
}

function baseMeta() {
  const pair = currentSourcePair();
  return {
    sessionId: state.sessionId,
    source: pair.source,
    sensor: pair.sensor,
    appVersion: APP_VERSION,
    generatedAt: Date.now(),
    environment: state.envReport,
    permission: state.source
      ? { result: state.source.permission, source_kind: state.sourceKind }
      : null,
    visibilityLog: state.visibilityLog,
  };
}

function onExportCsv() {
  const events = state.monitor.snapshotEvents();
  if (!events.length) return;
  const meta = baseMeta();
  const text = buildRawCsv(events, {
    source: meta.source,
    sensor: meta.sensor,
    startWallMs: state.startedWallMs ?? Date.now(),
  });
  const name = buildFilename("raw", formatStamp(new Date()), meta.source);
  downloadText(name, text, "text/csv");
  reportExport(
    `已生成 ${name}（${events.length} 行，source=${meta.source}）。若浏览器未自动保存，请检查下载设置。`
  );
}

async function onExportJson() {
  const stats = state.stats || state.monitor.stats(performance.now());
  if (!stats.totalPushed) return;
  const meta = baseMeta();
  const text = JSON.stringify(
    buildDiagJson({
      sessionId: meta.sessionId,
      source: meta.source,
      sensor: meta.sensor,
      environment: summarizeEnvForExport(state.envReport),
      permission: meta.permission,
      stats: summarizeStatsForExport(stats),
      visibilityLog: meta.visibilityLog,
      appVersion: APP_VERSION,
      generatedAt: meta.generatedAt,
      network: {
        calls: state.networkCalls,
        log: state.networkLog.slice(),
        note: "运行时统计的 fetch / XHR / sendBeacon / WebSocket / EventSource 调用总数",
      },
    }),
    null,
    2
  );
  const name = buildFilename("diag", formatStamp(new Date()), meta.source);
  downloadText(name, text, "application/json");

  // 只有本机开发服务器才落盘；静态托管下这里不会发出任何请求。
  const endpoint = isLocalDevHost() ? DEV_SAVE_ENDPOINT : null;
  const saved = await trySaveToDevServer(endpoint, name, text);
  reportExport(
    saved.ok
      ? `已生成 ${name}，${saved.message}`
      : `已生成 ${name}，仅下载到浏览器（${saved.message}）。`
  );
}

function summarizeEnvForExport(report) {
  if (!report) return null;
  return {
    verdict: summarizeVerdict(report),
    origin: report.origin,
    platform: report.platform,
    secure_context: report.secureContext,
    has_device_motion: report.hasDeviceMotion,
    has_request_permission: report.hasRequestPermission,
    in_iframe: report.inIframe,
    can_request: report.canRequest,
    blocked_reason: report.blockedReason,
    checks: report.checks,
    user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    location_href: typeof location !== "undefined" ? location.href : null,
  };
}

function summarizeStatsForExport(stats) {
  return {
    event_count: stats.eventCount,
    total_pushed: stats.totalPushed,
    rejected_count: stats.rejectedCount,
    elapsed_ms: Math.round(stats.elapsedMs),
    observed_hz: round(stats.observedHz, 3),
    mean_interval_ms: round(stats.meanIntervalMs, 3),
    median_interval_ms: round(stats.medianIntervalMs, 3),
    p95_interval_ms: round(stats.p95IntervalMs, 3),
    max_interval_ms: round(stats.maxIntervalMs, 3),
    jitter_p95_ms: round(stats.jitterP95Ms, 3),
    declared_interval_mean_ms: round(stats.declaredIntervalMeanMs, 3),
    interval_cv_pct: round(stats.intervalCvPct, 3),
    gap_count: stats.gapCount,
    gap_total_ms: Math.round(stats.gapTotalMs),
    longest_gap_ms: Math.round(stats.longestGapMs),
    gaps: stats.gaps,
  };
}

function round(v, digits) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function reportExport(text) {
  dom.exportResult.textContent = text;
  setVerdict(dom.exportState, "已导出", "is-ok");
}

// ---------------------------------------------------------------- 事件绑定

function bindEvents() {
  dom.btnRequest.addEventListener("click", () => {
    onRequestClick();
  });

  dom.btnStart.addEventListener("click", () => {
    onStartClick();
  });

  dom.btnStop.addEventListener("click", onStopClick);
  dom.btnReset.addEventListener("click", onResetClick);
  dom.btnExportCsv.addEventListener("click", onExportCsv);
  dom.btnExportJson.addEventListener("click", () => {
    onExportJson();
  });

  dom.selSource.addEventListener("change", () => {
    const kind = dom.selSource.value;
    buildSource(kind);
    onResetClick();
    if (kind === "mock") {
      dom.btnRequest.disabled = true;
      dom.btnStart.disabled = false;
      dom.permHint.hidden = true;
      setVerdict(dom.permVerdict, "模拟源无需授权", "");
      dom.permResult.textContent = "当前为合成数据，仅用于验证采集链路；导出的文件带 _WEB_MOCK 标记。";
    } else {
      dom.btnStart.disabled = true;
      setVerdict(dom.permVerdict, "未请求", "");
      dom.permResult.textContent = "";
      runEnvironmentProbe();
    }
  });

  dom.selPreset.addEventListener("change", () => {
    if (state.sourceKind === "mock" && state.source) {
      state.source.setPreset(dom.selPreset.value);
    }
  });

  document.addEventListener("visibilitychange", () => {
    const vis = document.visibilityState === "hidden" ? "hidden" : "visible";
    const now = performance.now();
    state.monitor.markVisibility(vis, now);
    state.visibilityLog.push({
      state: vis,
      at_mono_ms: Math.round(now),
      at_wall: new Date().toISOString(),
    });
  });

  window.addEventListener("pagehide", () => {
    state.monitor.finalize(performance.now());
  });
}

// ---------------------------------------------------------------- 启动

/**
 * 无头自检模式：?autostart=mock&preset=walk&seconds=3
 *
 * 用途是让 Windows 上的自动化冒烟检查能跑通「模拟数据 → 采集 → 监测 → 代码级导出」
 * 整条链路，而不需要人去点按钮。结果写进 <html> 的 data-* 属性，
 * 由 tools/smoke_page.py 读取断言。
 *
 * 仅用于自检与演示；正常访问（不带参数）不会自动启动任何东西。
 */
function maybeRunSmoke(params) {
  const autostart = params.get("autostart");
  if (autostart !== "mock") return;

  const preset = params.get("preset") || "walk";
  const seconds = Math.max(1, Math.min(30, Number(params.get("seconds")) || 3));

  dom.selSource.value = "mock";
  dom.selPreset.value = preset;
  buildSource("mock");
  setVerdict(dom.permVerdict, "模拟源无需授权", "");
  dom.permResult.textContent = "当前为合成数据（MOCK），仅用于验证采集链路。";

  onStartClick();

  setTimeout(() => {
    const now = performance.now();
    state.monitor.finalize(now);
    onStopClick();
    const stats = state.monitor.stats(performance.now());

    // 走一遍真实的导出构造路径（不触发下载），证明 CSV 能生成且列数正确
    let csvBytes = 0;
    let csvCols = 0;
    let csvSource = "";
    let csvSensor = "";
    try {
      const events = state.monitor.snapshotEvents();
      const pair = currentSourcePair();
      const csv = buildRawCsv(events, {
        source: pair.source,
        sensor: pair.sensor,
        startWallMs: state.startedWallMs ?? Date.now(),
      });
      csvBytes = new TextEncoder().encode(csv).length;
      const firstDataLine = csv.split("\r\n")[1] || "";
      const cells = firstDataLine ? firstDataLine.split(",") : [];
      csvCols = cells.length;
      csvSource = cells[13] || "";
      csvSensor = cells[14] || "";
    } catch (_err) {
      csvBytes = -1;
    }

    const root = document.documentElement;
    root.dataset.labSmoke = "done";
    root.dataset.labCount = String(stats.totalPushed);
    root.dataset.labHz = stats.observedHz.toFixed(2);
    root.dataset.labGaps = String(stats.gapCount);
    root.dataset.labCsvBytes = String(csvBytes);
    root.dataset.labCsvCols = String(csvCols);
    root.dataset.labCsvSource = csvSource;
    root.dataset.labCsvSensor = csvSensor;
    root.dataset.labSource = currentSourcePair().source;
    root.dataset.labSourceState = String(state.source ? state.source.state : "none");
    root.dataset.labRunning = String(state.running);
    root.dataset.labNetworkCalls = String(state.networkCalls);
  }, seconds * 1000);
}

/**
 * 布局诊断：?diag=1[&w=390]
 *
 * 找出真正撑破容器的元素。手机上横向溢出最容易被忽略——页面能滚，
 * 但卡片右边框跑到屏幕外，提示文字就被切掉了。
 *
 * 为什么不直接改窗口宽度：无头 Chrome 的窗口有最小宽度（本机实测 512px），
 * 压不到 iPhone 的 390。所以这里把 body 宽度强制设成目标值，
 * 网格用的是 auto-fit（跟容器宽度走而不是跟视口走），因此能真实反映回流结果。
 * 注意：依赖 viewport 的媒体查询不会被触发，这一点必须记住。
 */
function runLayoutDiag(forceWidth) {
  const body = document.body;
  if (forceWidth > 0) {
    body.style.width = `${forceWidth}px`;
    body.style.margin = "0";
  }

  const de = document.documentElement;
  const clientW = forceWidth > 0 ? body.clientWidth : de.clientWidth;
  let widest = null;
  for (const node of document.querySelectorAll("body *")) {
    const r = node.getBoundingClientRect();
    if (r.right > clientW + 1 && (!widest || r.right > widest.right)) {
      const cls =
        typeof node.className === "string" && node.className
          ? "." + node.className.trim().split(/\s+/).join(".")
          : "";
      widest = {
        right: r.right,
        desc: `${node.tagName.toLowerCase()}${node.id ? "#" + node.id : ""}${cls}`,
        width: r.width,
      };
    }
  }
  de.dataset.labScrollWidth = String(de.scrollWidth);
  de.dataset.labClientWidth = String(clientW);
  de.dataset.labDiagWidth = String(forceWidth || de.clientWidth);
  de.dataset.labWidest = widest
    ? `${widest.desc} | right=${Math.round(widest.right)} | w=${Math.round(widest.width)}`
    : "none";
}

function boot() {
  // 计数器必须最先装：晚于任何一次请求就没有意义了。
  installNetworkCounter();

  // 把未捕获异常回写到 DOM 上：iPhone 上没有开发者工具，
  // 出错时唯一能看到的线索就是页面本身。无头冒烟检查也靠它取证。
  window.addEventListener("error", (e) => {
    document.documentElement.dataset.labError = String(
      (e && e.message) || "error"
    ).slice(0, 240);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e && e.reason;
    document.documentElement.dataset.labError = String(
      (reason && reason.message) || reason || "rejection"
    ).slice(0, 240);
  });

  dom.footerMeta.textContent =
    `契约版本 ${CONTRACT_VERSION} · 应用版本 ${APP_VERSION} · 阶段 E-W1 · 不产出 17 字段样本（步频算法在 E-W3 实现）`;

  runEnvironmentProbe();
  buildSource("real");
  bindEvents();
  renderNetworkCounter();

  // 非 iOS 环境给出明确提示：桌面浏览器拿不到真实传感器数据
  const report = state.envReport;
  if (report && ["windows", "macos", "linux"].includes(report.platform.id)) {
    dom.permResult.textContent =
      "当前是桌面浏览器：拿不到真实传感器数据。可用下方「模拟数据」验证界面与监测链路，真机请用 iPhone Safari 打开 HTTPS 页面。";
  }

  renderLiveMetrics(refs, null);
  drawRateChart(dom.canvas, [], { devicePixelRatio: window.devicePixelRatio || 1 });

  // 供自动化冒烟检查读取的就绪标记
  document.documentElement.dataset.labBoot = "ok";

  const params = new URLSearchParams(location.search);
  if (params.get("diag") === "1") {
    const w = Number(params.get("w")) || 0;
    setTimeout(() => runLayoutDiag(w), 300);
  }
  maybeRunSmoke(params);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
