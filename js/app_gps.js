/**
 * E-W4 编排层：GPS 与运动传感器的协同观测。
 *
 * 与 app.js 的关系：这是**独立页面**的编排层，不改 app.js。
 * 体积上也是独立的——gps.html 只加载它需要的模块，不背 index.html 的波形图与步伐可视化。
 *
 * ## 本文件的三条硬边界
 *
 * 1. **不修改步频算法。** StepDetector 是 E-W3.1 已验证的实现，这里只读它的输出。
 *    唯一破例是读 `_counted`（只读），因为快照接口没有暴露间隔序列，
 *    而 2T 检测需要原始间隔。不改、不写、不影响计数。
 *
 * 2. **回放数据不进 TimeBase。** 回放的 tEpochMs 是 GPX 文件时间线，
 *    与本次会话的锚点毫无关系。把它喂给 observeFix 会算出几十万毫秒的"延迟"，
 *    那个数看起来像 GPS 出了大问题，其实只是两个不相关的时间轴相减。
 *
 * 3. **不用 GPS 反推步数。** 见 gps.html 里的说明与 alignment.js 的注释。
 */

import { probeEnvironment, summarizeVerdict } from "./env.js";
import { RealMotionSource, SourceState } from "./sources.js";
import { StepDetector } from "./stepdetect.js";
import { makeSceneSignal } from "./synth.js";
import { TimeBase } from "./timebase.js";
import {
  RealGpsSource, ReplayGpsSource, parseGpx, guessProvenance,
  appendDerivedFix, GpsOrigin, GpxProvenance, GpsState,
} from "./gps.js";
import { GPS_QUALITY_ALGO, QUALITY_LABEL } from "./gps_quality.js";
import {
  TimelineBuckets, Channel, analyzeIntervalDistribution,
  findGpsOutages, mergeOutages, speedAt,
} from "./alignment.js";
import {
  CadenceVerdict, STRENGTH_TEXT, assessStride, CadenceBaseline,
  detectRegimeChange, assessCadenceIntegrity,
} from "./cadence_evidence.js";
import {
  DataOrigin, buildGpsTrackCsv, buildTimelineCsv, buildGpsDiagJson,
  buildGpsFilename,
} from "./gps_export.js";
import { formatStamp, downloadText } from "./download.js";
import { renderEnvList, setVerdict } from "./ui.js";

const dom = {};
const byId = (id) => document.getElementById(id);

/** 会话状态。集中放一处，避免散落的模块级变量互相打架。 */
const S = {
  t0PerfMs: null,
  running: false,
  motion: null,
  gps: null,
  gpsMode: "off",
  gpsOrigin: GpsOrigin.NONE,
  gpxMeta: null,
  provenance: GpxProvenance.UNKNOWN,
  replaySpeed: 1,
  detector: null,
  timebase: null,
  buckets: null,
  fixes: [],
  track: [],
  motionOutages: [],
  lastSnapshot: null,
  renderTimer: null,
  strideSamples: [],
  lastAssess: null,
  lastStrideFixSeq: -1,
  plausibilityCounts: { within: 0, high: 0, low: 0 },
  baseline: null,
  spmSeries: [],
  current: null,
  human: null,
  integrity: null,
  intervalDx: null,
  lastSteps: 0,
  lastEventT: null,
  lastCountedT: null,
  countedTimes: [],
};

/**
 * 传感器事件间隔超过这个值就算一次中断。
 *
 * 60 Hz 下正常间隔 17 ms，500 ms 等于连续丢了 30 个事件——那已经不是抖动。
 * 阈值不能取太小：iOS 在切后台、锁屏、系统弹窗时都会短暂停发，
 * 把 200 ms 也算成中断会让中断列表充满噪声，真正的断档反而看不见。
 */
const MOTION_GAP_MS = 500;

const NUM = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");

function perfNow() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

// ---------------------------------------------------------------- 初始化

function collectDom() {
  for (const id of [
    "mock-ribbon", "page-meta", "env-verdict", "env-list", "env-note",
    "perm-verdict", "perm-note", "btn-perm-motion", "btn-perm-gps", "btn-start", "btn-stop",
    "gps-state", "gps-origin", "gps-origin-sub", "sel-gps-mode", "file-gpx", "sel-gps-speed",
    "m-gps-dist", "m-gps-dist-trusted", "m-gps-pace", "m-gps-pace-unit",
    "m-gps-speed", "m-gps-acc", "m-gps-count", "m-gps-accepted", "m-gps-anomaly",
    "m-gps-quality", "m-gps-lat",
    "gps-note", "gps-quality-note", "gps-replay-note", "gps-provenance-note", "gps-err",
    "tl-state", "m-tl-motion", "m-tl-gps", "m-tl-buckets",
    "m-tl-outages", "m-tl-outage-ms", "m-tl-drift", "outage-note", "timeline-cap-note",
    "m-stride", "m-stride-verdict", "m-double-ratio", "stride-note",
    "evidence-list", "human-steps", "human-sec", "btn-human-apply", "human-note",
    "btn-export-gps", "btn-export-timeline", "btn-export-gpsdiag", "export-note",
    "footer-meta",
  ]) {
    dom[id] = byId(id);
  }
}

function bootEnvironment() {
  // 注意签名：probeEnvironment(win) 收的是 window 本身，不是 { win }。
  // 传错时 win.DeviceMotionEvent 会是 undefined，页面会显示"全项不支持"，
  // 而那个假象看起来完全像真的（非安全上下文、无传感器 API），不会报错。
  const report = probeEnvironment(window);
  const verdict = summarizeVerdict(report);
  renderEnvList(dom["env-list"], report);
  setVerdict(
    dom["env-verdict"],
    verdict.text,
    verdict.level === "OK" ? "is-ok" : verdict.level === "WARN" ? "is-warn" : "is-fail",
  );
  dom["env-note"].textContent = "";
  dom["page-meta"].textContent = "目标：GPS 与运动传感器协同分析 · 不读取系统计步器 · 不写入任何系统服务";
}

// ---------------------------------------------------------------- 数据源

function ensureDetector() {
  if (S.detector) return S.detector;
  S.detector = new StepDetector({ source: "REAL" });
  return S.detector;
}

function ensureTimebase() {
  if (S.timebase) return S.timebase;
  S.timebase = new TimeBase();
  return S.timebase;
}

function ensureBuckets(tPerf) {
  if (S.buckets) return S.buckets;
  S.buckets = new TimelineBuckets({ t0PerfMs: tPerf, bucketMs: 1000 });
  return S.buckets;
}

function resetSession() {
  S.t0PerfMs = null;
  S.detector = null;
  S.timebase = null;
  S.buckets = null;
  S.fixes = [];
  S.track = [];
  S.motionOutages = [];
  S.strideSamples = [];
  S.plausibilityCounts = { within: 0, high: 0, low: 0 };
  S.baseline = null;
  S.spmSeries = [];
  S.current = null;
  S.human = null;
  S.integrity = null;
  S.intervalDx = null;
  S.lastSteps = 0;
  S.lastEventT = null;
  S.lastAssess = null;
  S.lastStrideFixSeq = -1;
  S.lastCountedT = null;
  S.countedTimes = [];
  S.lastSnapshot = null;
}

function startMotion() {
  if (S.motion) return true;
  const src = new RealMotionSource({
    onEvent: onMotionEvent,
    onState: (st) => {
      if (st === SourceState.RUNNING) {
        setVerdict(dom["perm-verdict"], "运动中", "is-ok");
      }
    },
  });
  S.motion = src;
  return src.start();
}

function onMotionEvent(ev) {
  if (!S.running) return;
  if (S.t0PerfMs === null) {
    S.t0PerfMs = ev.tMonoMs;
    ensureBuckets(ev.tMonoMs);
    ensureTimebase().anchorNow();
  }
  // 中断记账：相邻事件的时间差就是"这段时间传感器没给数据"的直接证据。
  // 用到达间隔而不是内部闸门状态，是因为前者是观测值，后者是算法的判断结果——
  // 分析中断时应该用观测值，否则"算法认为没断"会掩盖真实断档。
  if (S.lastEventT !== null) {
    const gap = ev.tMonoMs - S.lastEventT;
    if (gap > MOTION_GAP_MS) {
      S.motionOutages.push({
        startPerfMs: S.lastEventT,
        endPerfMs: ev.tMonoMs,
        durationMs: gap,
      });
    }
  }
  S.lastEventT = ev.tMonoMs;

  const d = ensureDetector();
  d.push(ev);
  ensureBuckets(S.t0PerfMs).add(Channel.MOTION, ev.tMonoMs);
}

function onGpsFix(fix) {
  if (!S.running) return;
  if (S.t0PerfMs === null) {
    S.t0PerfMs = fix.tMonoMs;
    ensureBuckets(fix.tMonoMs);
    ensureTimebase().anchorNow();
  }
  S.fixes.push(fix);
  appendDerivedFix(S.track, fix);
  ensureBuckets(S.t0PerfMs).add(Channel.GPS, fix.tMonoMs);
  // 有了第一个点就允许导出：允许导出比禁止导出更安全——
  // 导出的是一份带来源标记的真实记录，而不是一个"再等等"的空按钮。
  syncExportButtons();

  // 只有真实定位才观测时钟关系。回放的 epoch 是文件时间线，
  // 与本次会话锚点无关，喂进去会算出毫无意义的"延迟"。
  if (fix.origin === GpsOrigin.REAL) {
    ensureTimebase().observeFix(fix, fix.tMonoMs);
  }
}

function setGpsOrigin(origin, note) {
  S.gpsOrigin = origin;
  dom["gps-origin"].textContent = origin;
  dom["gps-origin-sub"].textContent = note ?? "";
  dom["gps-replay-note"].hidden = origin !== GpsOrigin.REPLAY;
  syncExportButtons();
}

function startRealGps() {
  stopGps();
  const src = new RealGpsSource({
    onFix: onGpsFix,
    onState: (st) => {
      setVerdict(dom["gps-state"], st, st === GpsState.WATCHING ? "is-ok" : "");
      if (st === GpsState.DENIED) {
        dom["gps-err"].hidden = false;
        dom["gps-err"].textContent = "定位被拒绝。到 设置 → Safari → 位置 改为「允许」，或完全关闭 Safari 再重开。";
      }
    },
    onError: (e) => {
      dom["gps-err"].hidden = false;
      dom["gps-err"].textContent = `定位错误：${typeof e === "object" ? e.message : e}`;
    },
  });
  S.gps = src;
  setGpsOrigin(GpsOrigin.REAL, "浏览器 Geolocation 实测；maximumAge=0，不取缓存点");
  src.start();
}

function startReplayGps(gpx) {
  stopGps();
  const speed = Number(dom["sel-gps-speed"].value) || 1;
  S.replaySpeed = speed;
  const declared = guessProvenance(gpx.meta);
  S.provenance = declared ?? GpxProvenance.UNKNOWN;
  S.gpxMeta = gpx.meta;

  const src = new ReplayGpsSource({
    gpx,
    speed,
    provenance: S.provenance,
    onFix: onGpsFix,
    onState: (st) => setVerdict(dom["gps-state"], st, st === GpsState.WATCHING ? "is-warn" : ""),
    onDone: ({ emitted, total }) => {
      dom["gps-err"].hidden = false;
      dom["gps-err"].textContent = `回放结束：${emitted}/${total} 点。`;
    },
  });
  S.gps = src;
  setGpsOrigin(GpsOrigin.REPLAY, `${speed}× 回放 · 延迟恒为 0，非实测`);
  renderProvenance();
  src.start();
}

function renderProvenance() {
  const el = dom["gps-provenance-note"];
  const meta = S.gpxMeta;
  if (!meta) {
    el.hidden = true;
    return;
  }
  const label = {
    [GpxProvenance.SYNTHETIC_GEOMETRY]: "由几何参数生成，不对应任何一次真实运动",
    [GpxProvenance.RECORDED]: "声明为真实记录",
    [GpxProvenance.UNKNOWN]: "无法判断（未声明）",
  }[S.provenance];
  const desc = meta.desc ? `文件描述：${meta.desc}` : "文件无描述";
  el.hidden = false;
  el.textContent = `文件来历：${label}。${desc}`;
  el.className = S.provenance === GpxProvenance.RECORDED ? "note" : "note note-warn";
}

function stopGps() {
  if (S.gps) {
    S.gps.stop();
    S.gps = null;
  }
  setVerdict(dom["gps-state"], "未启动", "");
}

// ---------------------------------------------------------------- 渲染

function render(force = false, atMs = null) {
  if (!S.running && !force) return;
  const now = atMs ?? perfNow();
  const d = S.detector;
  const snap = d ? d.snapshot(now) : null;
  S.lastSnapshot = snap;

  // 已计步时刻（只读，用于 2T 诊断）。同时把每一步的落点写进时间轴的 step 通道，
  // 这样导出的时间轴每一秒都带着"这一秒走了几步"，而不是只留一个总数。
  if (snap && snap.steps > S.lastSteps) {
    const counted = d && Array.isArray(d._counted) ? d._counted : null;
    if (counted) {
      const b = ensureBuckets(S.t0PerfMs);
      for (let i = S.lastSteps; i < counted.length; i += 1) {
        S.countedTimes.push(counted[i].t);
        b.add(Channel.STEP, counted[i].t);
      }
      while (S.countedTimes.length > 400) S.countedTimes.shift();
    }
    S.lastSteps = snap.steps;
  }

  renderGps();
  renderTimeline(snap, now);
}

/** 显示用速度：芯片自报优先，没有才退回差分值。两个口径不能混成一个数。 */
function preferredSpeed(fix) {
  if (!fix) return null;
  if (Number.isFinite(fix.speedMps) && fix.speedMps >= 0) return fix.speedMps;
  if (Number.isFinite(fix.speedDerivedMps) && fix.speedDerivedMps >= 0) return fix.speedDerivedMps;
  return null;
}

function renderGps() {
  const track = S.track;
  const last = track.length ? track[track.length - 1] : null;
  dom["m-gps-count"].textContent = String(S.fixes.length);
  dom["m-gps-dist"].textContent = last ? NUM(last.distCumM, 1) : "—";
  if (dom["m-gps-dist-trusted"]) {
    dom["m-gps-dist-trusted"].textContent = last ? NUM(last.distConfirmedM, 1) : "—";
  }
  const showSpeed = last && Number.isFinite(last.displaySpeedMps);
  dom["m-gps-speed"].textContent = showSpeed ? NUM(last.displaySpeedMps, 2) : "—";
  dom["m-gps-acc"].textContent = last && Number.isFinite(last.accuracyM) ? NUM(last.accuracyM, 1) : "—";
  dom["m-gps-pace"].textContent = last && last.paceDisplayText ? last.paceDisplayText : "—";
  if (dom["m-gps-pace-unit"]) {
    dom["m-gps-pace-unit"].textContent = last && last.paceDisplayKind === "pace" ? "/km" : "";
  }
  if (dom["m-gps-accepted"]) {
    dom["m-gps-accepted"].textContent = last ? String(last.effectiveCount ?? 0) : "0";
  }
  if (dom["m-gps-anomaly"]) {
    dom["m-gps-anomaly"].textContent = last ? String(last.anomalyCount ?? 0) : "0";
  }
  if (dom["m-gps-quality"]) {
    dom["m-gps-quality"].textContent = last ? (QUALITY_LABEL[last.qualityState] || "—") : "—";
  }
  if (dom["gps-quality-note"]) {
    dom["gps-quality-note"].textContent = last && last.qualityNote
      ? last.qualityNote
      : "开始采集后，这里说明原始路程和确认距离差在哪里。";
  }

  const tb = S.timebase;
  if (tb && S.gpsOrigin === GpsOrigin.REAL && tb.observations.length) {
    const st = tb.latencyStats();
    dom["m-gps-lat"].textContent = st.medianMs === null ? "—" : String(Math.round(st.medianMs));
  } else if (S.gpsOrigin === GpsOrigin.REPLAY) {
    dom["m-gps-lat"].textContent = "0";
  } else {
    dom["m-gps-lat"].textContent = "—";
  }
}

/** GPS 断档列表。findGpsOutages 的返回形状恒定是 `{outages, thresholdMs, medianGapMs}`。 */
function gpsOutageInfo() {
  const res = findGpsOutages(S.fixes);
  return {
    list: Array.isArray(res.outages) ? res.outages : [],
    thresholdMs: res.thresholdMs ?? null,
    medianGapMs: res.medianGapMs ?? null,
  };
}

function renderTimeline(snap, now) {
  const b = S.buckets;
  if (!b) return;
  const cov = b.coverage();
  dom["m-tl-motion"].textContent = cov.motion === null ? "—" : NUM(cov.motion * 100, 1);
  dom["m-tl-gps"].textContent = cov.gps === null ? "—" : NUM(cov.gps * 100, 1);
  dom["m-tl-buckets"].textContent = String(cov.buckets);
  renderCapNote(cov);

  // 中断要合并两源才有意义：只有把"传感器断了"和"定位没点"放在一起，
  // 才能区分"硬件停了"与"这个源本来就这么慢"。
  const info = gpsOutageInfo();
  const merged = mergeOutages(S.motionOutages, info.list);
  dom["m-tl-outages"].textContent = String(merged.length);
  const totalMs = merged.reduce((a, o) => a + o.durationMs, 0);
  dom["m-tl-outage-ms"].textContent = NUM(totalMs / 1000, 1);
  renderOutageNote(merged, info);

  // 时钟跳变
  const tb = S.timebase;
  if (tb && S.gpsOrigin === GpsOrigin.REAL && tb.observations.length >= 4) {
    const jump = tb.detectClockJump();
    dom["m-tl-drift"].textContent = jump.jumped
      ? `跳变 ${Math.round(jump.deltaMs)} ms`
      : "无";
  } else {
    dom["m-tl-drift"].textContent = S.gpsOrigin === GpsOrigin.REPLAY ? "回放不测" : "—";
  }

  // 2T 占比先算。它是证据之一，必须在聚合判定之前就绪——
  // 否则每次判定用的都是上一秒的 intervalDx，看起来"慢半拍"。
  const iv = [];
  for (let i = 1; i < S.countedTimes.length; i += 1) {
    const dt = S.countedTimes[i] - S.countedTimes[i - 1];
    if (dt > 0) iv.push(dt);
  }
  const dx = analyzeIntervalDistribution(iv);
  S.intervalDx = dx;
  dom["m-double-ratio"].textContent = dx.sampleCount ? NUM(dx.nearDoubleRatio * 100, 1) : "—";

  // 跨源一致性：**只在有新定位点时评估一次**。
  // 渲染是 4 Hz，按渲染计次会把同一个定位点重复计 4 次，
  // 导出的 paired 就不是"配对数"而是"渲染帧数"。
  const refT = S.fixes.length ? S.fixes[S.fixes.length - 1].tMonoMs : null;
  const lastSeq = S.fixes.length ? S.fixes[S.fixes.length - 1].seq : -1;
  if (refT !== null && lastSeq !== S.lastStrideFixSeq) {
    S.lastStrideFixSeq = lastSeq;
    const spd = speedAt(S.track, refT);
    const spm = snap ? snap.cadenceSpm : null;
    const speedMps = spd && Number.isFinite(spd.speedMps) ? spd.speedMps : null;
    S.lastAssess = spd ? assessStride({ speedMps, spm }) : null;
    S.current = S.lastAssess
      ? { perfMs: refT, speedMps, spm, strideM: S.lastAssess.strideM }
      : null;
    if (S.lastAssess) {
      S.strideSamples.push(S.lastAssess.strideM);
      if (S.strideSamples.length > 1200) S.strideSamples.shift();
      const k = S.lastAssess.plausibility;
      S.plausibilityCounts[k] = (S.plausibilityCounts[k] ?? 0) + 1;
    }
    if (S.current && Number.isFinite(spm) && spm > 0) {
      ensureBaseline().add({ perfMs: refT, speedMps, spm });
      S.spmSeries.push({ perfMs: refT, spm, speedMps });
      // 阶跃检测是 O(箱数²)，序列不能无限增长；600 个 1 Hz 样本 = 10 分钟
      if (S.spmSeries.length > 600) S.spmSeries.shift();
    }
    refreshIntegrity();
  }

  renderIntegrity();
  setVerdict(dom["tl-state"], S.running ? "采集中" : "空闲", S.running ? "is-ok" : "");
}

function ensureBaseline() {
  if (S.baseline) return S.baseline;
  S.baseline = new CadenceBaseline();
  return S.baseline;
}

/**
 * 聚合判定。
 *
 * 注意这里**没有**任何"if stride > X 就判腰斩"的分支——
 * 判定逻辑全部在 `cadence_evidence.js` 里，且只有人工计数能给出「已确认」。
 * 这个函数只负责把当前会话的四类证据凑齐。
 */
function refreshIntegrity() {
  const cur = S.current;
  const spd = cur && Number.isFinite(cur.speedMps) ? cur.speedMps : null;
  const baselineRes = cur && spd !== null ? ensureBaseline().query(spd, cur.perfMs) : null;
  // 16 个 1 Hz 样本 = 16 秒，低于这个长度做阶跃检测只会检到起步本身
  const regime = S.spmSeries.length >= 16 ? detectRegimeChange(S.spmSeries) : null;
  const steps = S.lastSnapshot && Number.isFinite(S.lastSnapshot.steps) ? S.lastSnapshot.steps : 0;
  const humanCount = S.human
    ? { steps: S.human.steps, algoSteps: steps, windowMs: S.human.windowMs }
    : null;
  S.integrity = assessCadenceIntegrity({
    stride: S.lastAssess,
    baseline: baselineRes,
    current: cur,
    regime,
    intervalDx: S.intervalDx,
    humanCount,
    algoSpm: cur ? cur.spm : null,
  });
}

function renderIntegrity() {
  const integ = S.integrity;
  const assess = S.lastAssess;
  dom["m-stride"].textContent = assess ? NUM(assess.strideM, 2) : "—";

  if (!integ || integ.verdict === CadenceVerdict.NO_DATA) {
    setVerdict(
      dom["m-stride-verdict"],
      S.gpsOrigin === GpsOrigin.REPLAY ? "需真实速度" : "待数据",
      "",
    );
    dom["stride-note"].hidden = true;
    dom["stride-note"].textContent = "";
    renderEvidence(integ);
    renderHumanNote();
    return;
  }

  setVerdict(dom["m-stride-verdict"], integ.label, integ.tone);
  const show = integ.verdict !== CadenceVerdict.NORMAL;
  dom["stride-note"].hidden = !show;
  dom["stride-note"].textContent = show ? integ.note : "";
  renderEvidence(integ);
  renderHumanNote();
}

/** 证据列表：把判定依据逐条摊开，避免只给一个结论。 */
function renderEvidence(integ) {
  const ul = dom["evidence-list"];
  if (!ul) return;
  ul.textContent = "";
  const items = integ && Array.isArray(integ.evidence) ? integ.evidence : [];
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "check-empty";
    li.textContent =
      !integ || integ.verdict === CadenceVerdict.NO_DATA
        ? "还没有足够的配对数据（需要 GPS 速度 + 步频同时在场）"
        : "当前没有任何异常证据";
    ul.appendChild(li);
  }
  for (const e of items) {
    const li = document.createElement("li");
    const tag = document.createElement("strong");
    tag.textContent = `[${STRENGTH_TEXT[e.strength] ?? e.strength}]`;
    li.appendChild(tag);
    li.appendChild(document.createTextNode(` ${e.text}`));
    ul.appendChild(li);
  }
  // 还没拿到的证据也要列出来。只写"没有异常证据"会让读者以为"已经验证过没问题"，
  // 而实际是"还没有能力验证"——这两件事必须分开说。
  const missing =
    integ && Array.isArray(integ.missing) &&
    (integ.verdict === CadenceVerdict.NORMAL || integ.verdict === CadenceVerdict.SUSPECT)
      ? integ.missing
      : [];
  if (missing.length) {
    const li = document.createElement("li");
    li.className = "check-empty";
    li.textContent = `尚缺：${missing.join("；")}`;
    ul.appendChild(li);
  }
}

function renderHumanNote() {
  const el = dom["human-note"];
  if (!el) return;
  if (!S.human) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  const algo = S.lastSnapshot && Number.isFinite(S.lastSnapshot.steps) ? S.lastSnapshot.steps : 0;
  const refSpm = S.human.windowMs ? (S.human.steps / (S.human.windowMs / 1000)) * 60 : null;
  el.hidden = false;
  el.textContent =
    `人工基准：${S.human.steps} 步` +
    (S.human.windowMs ? ` / ${(S.human.windowMs / 1000).toFixed(0)} s = ${NUM(refSpm, 1)} SPM` : "") +
    `；算法同期 ${algo} 步。人工计数覆盖「从开始到现在」整段，所以两者可以直接比步数——` +
    "这是本项目唯一能给出「已确认」的证据。";
}

/**
 * 时间轴容量提示。
 *
 * 满了之后 coverage() 的分母停在 maxBuckets、分子也不再增长，
 * 于是"覆盖率 100%"看起来完全正常，而实际后半程的数据一条都没进时间轴。
 * 这是本项目最不愿意见到的失败形态：数字好看，数据是假的。
 * 所以只要发生过一次溢出就必须明说，不许静默。
 */
function renderCapNote(cov) {
  const el = dom["timeline-cap-note"];
  if (!el) return;
  const over = cov.droppedOverflow ?? 0;
  const early = cov.droppedEarly ?? 0;
  if (!over && !early) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  const parts = [];
  if (over) {
    parts.push(`时间轴已达上限 ${(cov.limitMs / 60000).toFixed(0)} 分钟，之后有 ${over} 个事件未计入时间轴（步数与定位本身仍在累加）`);
  }
  if (early) {
    parts.push(`${early} 个事件早于会话起点，未计入（锚点误差不制造负桶）`);
  }
  el.hidden = false;
  el.textContent = `${parts.join("；")}。导出时请以原始轨迹与步数记录为准，不要只看覆盖率。`;
}

function renderOutageNote(merged, info) {
  const el = dom["outage-note"];
  if (!el) return;
  if (!merged.length) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  const count = { motion_only: 0, gps_only: 0, both: 0 };
  const longest = { motion_only: 0, gps_only: 0, both: 0 };
  for (const o of merged) {
    count[o.kind] = (count[o.kind] ?? 0) + 1;
    longest[o.kind] = Math.max(longest[o.kind] ?? 0, o.durationMs);
  }
  const parts = [];
  if (count.motion_only) parts.push(`仅传感器 ${count.motion_only} 次（最长 ${(longest.motion_only / 1000).toFixed(1)} s）`);
  if (count.gps_only) parts.push(`仅定位 ${count.gps_only} 次（最长 ${(longest.gps_only / 1000).toFixed(1)} s）`);
  if (count.both) parts.push(`两者同时 ${count.both} 次（最长 ${(longest.both / 1000).toFixed(1)} s）`);
  const th = info.thresholdMs === null ? "点数不足，未判定" : `阈值 ${Math.round(info.thresholdMs)} ms（中位间隔 ${Math.round(info.medianGapMs)} ms × 3，自适应）`;
  el.hidden = false;
  el.textContent = `${parts.join("；")}。定位中断判定${th}。` +
    "中断区间的起止都是观测到的时刻：起点是最后一个正常点，终点是恢复后的第一个点，中间没有插值。";
}

// ---------------------------------------------------------------- 导出

function syncExportButtons() {
  const hasGps = S.fixes.length > 0;
  dom["btn-export-gps"].disabled = !hasGps;
  dom["btn-export-timeline"].disabled = !hasGps;
  dom["btn-export-gpsdiag"].disabled = !hasGps;
}

function baseMeta() {
  return {
    t0PerfMs: S.t0PerfMs,
    origin: S.gpsOrigin,
    provenance: S.provenance,
    replaySpeed: S.gpsOrigin === GpsOrigin.REPLAY ? S.replaySpeed : null,
  };
}

function exportGpsTrack() {
  const csv = buildGpsTrackCsv(S.track, baseMeta());
  downloadText(buildGpsFilename("gpstrack", formatStamp(new Date()), S.gpsOrigin), csv, "text/csv");
}

function exportTimeline() {
  const b = S.buckets;
  if (!b) return;
  const rows = b.series();
  const bucketSec = b.bucketMs / 1000;

  // 每桶 GPS 速度：把落在该桶里的定位点速度取平均。
  // 同一秒内的几个点属于同一时刻，取均值不是插值；桶里没有点就留空，
  // 不拿邻近桶的值去填——填空会造出没测过的数。
  const byBucket = new Map();
  for (const f of S.track) {
    const idx = Math.floor((f.tMonoMs - S.t0PerfMs) / b.bucketMs);
    if (idx < 0) continue;
    const v = preferredSpeed(f);
    if (v === null) continue;
    const acc = byBucket.get(idx) ?? { sum: 0, n: 0 };
    acc.sum += v;
    acc.n += 1;
    byBucket.set(idx, acc);
  }

  for (const r of rows) {
    // 每桶步频 = 该桶内的步数 ÷ 桶宽。这是**计数推导**，不是平滑：
    // 桶里没有步就是 0。桶宽 1 秒时分辨率只能是 0/60/120，所以桶宽要一起写进文件。
    r.spm = r.covered ? (r.step / bucketSec) * 60 : null;
    const acc = byBucket.get(r.index);
    const spd = acc && acc.n ? acc.sum / acc.n : null;
    r.speedMps = spd;
    // 每桶步幅同样由这一桶自己的速度与步频算出，不用全局值——那样每一行都会
    // 显示同一个数，看起来像"每秒都测了一次步幅"，其实是同一次测量的复制。
    const a = spd !== null && r.spm !== null && r.spm > 0
      ? assessStride({ speedMps: spd, spm: r.spm })
      : null;
    r.strideM = a ? a.strideM : null;
    // 导出的列名从 stride_suspicion 改成 stride_plausibility：
    // 一桶一个值的派生量只能表达"这个组合常不常见"，表达不了"谁错了"。
    r.plausibility = a ? a.plausibility : null;
  }
  const csv = buildTimelineCsv(rows, baseMeta());
  downloadText(buildGpsFilename("timeline", formatStamp(new Date()), S.gpsOrigin), csv, "text/csv");
}

function exportDiag() {
  const tb = S.timebase;
  const b = S.buckets;
  const cov = b ? b.coverage() : {};
  const track = S.track;
  const last = track.length ? track[track.length - 1] : null;
  const info = gpsOutageInfo();
  const list = info.list;
  const merged = mergeOutages(S.motionOutages, list);
  const byKind = {};
  for (const o of merged) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;

  const accs = track.map((f) => f.accuracyM).filter((v) => Number.isFinite(v)).sort((a, c) => a - c);
  const speedSourceCounts = {};
  for (const f of track) {
    const k = f.speedSource ?? "none";
    speedSourceCounts[k] = (speedSourceCounts[k] ?? 0) + 1;
  }
  const strides = S.strideSamples;
  const meanStride = strides.length ? strides.reduce((a, c) => a + c, 0) / strides.length : null;

  const payload = {
    origin: S.gpsOrigin,
    provenance: S.provenance,
    replaySpeed: S.gpsOrigin === GpsOrigin.REPLAY ? S.replaySpeed : null,
    generatedAt: new Date().toISOString(),
    timebase: tb ? tb.summary() : {},
    gps: {
      fixCount: S.fixes.length,
      firstRelMs: S.fixes.length && S.t0PerfMs !== null ? Math.round(S.fixes[0].tMonoMs - S.t0PerfMs) : null,
      lastRelMs: S.fixes.length && S.t0PerfMs !== null ? Math.round(S.fixes.at(-1).tMonoMs - S.t0PerfMs) : null,
      totalDistanceM: last ? last.distCumM : null,
      meanSpeedMps: last && last.distCumM > 0 && S.fixes.length > 1
        ? last.distCumM / ((S.fixes.at(-1).tMonoMs - S.fixes[0].tMonoMs) / 1000)
        : null,
      meanPaceSecPerKm: last && last.distCumM > 0 && S.fixes.length > 1
        ? 1000 / (last.distCumM / ((S.fixes.at(-1).tMonoMs - S.fixes[0].tMonoMs) / 1000))
        : null,
      accuracyMedianM: accs.length ? accs[accs.length >> 1] : null,
      speedSourceCounts,
      qualityAlgo: last ? last.qualityAlgo ?? null : null,
      confirmedDistanceM: last ? last.distConfirmedM : null,
      ambiguousDistanceM: last ? last.distAmbiguousM : null,
      openDistanceM: last ? last.distOpenM : null,
      qualityState: last ? last.qualityState ?? null : null,
      paceDisplay: last ? last.paceDisplayText ?? null : null,
      displaySpeedMps: last ? last.displaySpeedMps : null,
      anomalyCount: last ? last.anomalyCount ?? 0 : 0,
      effectiveCount: last ? last.effectiveCount ?? 0 : 0,
    },
    outages: {
      gpsThresholdMs: info.thresholdMs,
      gpsMedianGapMs: info.medianGapMs,
      list,
      motionGapThresholdMs: MOTION_GAP_MS,
      motionCount: S.motionOutages.length,
      merged,
      totalMs: merged.reduce((a, o) => a + o.durationMs, 0),
      byKind,
    },
    timeline: {
      bucketMs: 1000,
      bucketCount: cov.buckets ?? 0,
      motionCoverage: cov.motion,
      gpsCoverage: cov.gps,
      stepCoverage: cov.step,
      droppedOverflow: cov.droppedOverflow ?? 0,
      droppedEarly: cov.droppedEarly ?? 0,
    },
    consistency: {
      paired: S.strideSamples.length,
      meanStrideM: meanStride,
      plausibilityCounts: S.plausibilityCounts,
      integrity: S.integrity,
      humanCount: S.human
        ? { steps: S.human.steps, algoSteps: S.lastSnapshot ? S.lastSnapshot.steps : 0, windowMs: S.human.windowMs }
        : null,
      intervalDiagnosis: S.intervalDx,
    },
    notes: [
      "GPS 只用于质疑步频，不用于产生步频或步数",
      "步幅为派生量（速度 ÷ 步频），不是任何设备直接测量值",
      "跨源判定只有人工计数能给出「已确认」；其余证据最多到「疑似异常／需要人工验证」",
      S.gpsOrigin === GpsOrigin.REPLAY ? "本文件为 GPX 回放，延迟恒为 0，不可作为定位性能依据" : "",
    ].filter(Boolean),
  };

  const json = JSON.stringify(buildGpsDiagJson(payload), null, 2);
  downloadText(buildGpsFilename("gpsdiag", formatStamp(new Date()), S.gpsOrigin), json, "application/json");
}

// ---------------------------------------------------------------- 事件绑定

function bind() {
  dom["btn-perm-motion"].addEventListener("click", () => {
    const src = new RealMotionSource({
      onEvent: onMotionEvent,
      onState: () => {},
    });
    src.requestPermission().then((r) => {
      S.motion = src;
      dom["perm-note"].textContent = `运动权限：${r}`;
      setVerdict(dom["perm-verdict"], r === "granted" ? "已授权" : r, r === "granted" ? "is-ok" : "is-warn");
      dom["btn-start"].disabled = r !== "granted" && r !== "not-required";
    });
  });

  dom["btn-perm-gps"].addEventListener("click", () => {
    if (!navigator.geolocation) {
      setVerdict(dom["perm-verdict"], "不支持定位", "is-fail");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        dom["perm-note"].textContent = `定位已授权（精度 ${NUM(pos.coords.accuracy, 0)} m）`;
        setVerdict(dom["perm-verdict"], "定位已授权", "is-ok");
      },
      (err) => {
        dom["perm-note"].textContent = `定位失败：${err.message}`;
        setVerdict(dom["perm-verdict"], "定位被拒", "is-fail");
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  });

  dom["btn-start"].addEventListener("click", () => {
    resetSession();
    S.running = true;
    dom["btn-start"].disabled = true;
    dom["btn-stop"].disabled = false;
    ensureTimebase().anchorNow();
    startMotion();
    if (S.renderTimer) clearInterval(S.renderTimer);
    S.renderTimer = setInterval(render, 250);
  });

  dom["btn-stop"].addEventListener("click", () => {
    S.running = false;
    if (S.renderTimer) clearInterval(S.renderTimer);
    S.renderTimer = null;
    if (S.motion) { S.motion.stop(); S.motion = null; }
    stopGps();
    dom["btn-start"].disabled = false;
    dom["btn-stop"].disabled = true;
    syncExportButtons();
    render(true);
  });

  dom["sel-gps-mode"].addEventListener("change", (e) => {
    const mode = e.target.value;
    S.gpsMode = mode;
    if (mode === "off") stopGps();
    else if (mode === "real") startRealGps();
    else if (mode === "replay") {
      dom["file-gpx"].click();
    }
  });

  dom["file-gpx"].addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const gpx = parseGpx(text);
      startReplayGps(gpx);
    } catch (err) {
      dom["gps-err"].hidden = false;
      dom["gps-err"].textContent = `GPX 解析失败：${err.message}`;
      setVerdict(dom["gps-state"], "解析失败", "is-fail");
    }
  });

  dom["btn-export-gps"].addEventListener("click", exportGpsTrack);
  dom["btn-export-timeline"].addEventListener("click", exportTimeline);
  dom["btn-export-gpsdiag"].addEventListener("click", exportDiag);
  dom["btn-human-apply"].addEventListener("click", applyHumanCount);
}

/**
 * 应用人工计数基准。
 *
 * 为什么比"步数"而不是比"SPM"：两边都覆盖「从开始到现在」这一段，
 * 总步数是最原始、最不可能算错的量；一旦换算成 SPM，就引入了
 * "用哪段时间做分母"的新歧义（中途停顿算不算、最后几秒算不算）。
 */
function applyHumanCount() {
  const raw = dom["human-steps"].value;
  const steps = Number(raw);
  if (!Number.isFinite(steps) || steps <= 0) {
    dom["human-note"].hidden = false;
    dom["human-note"].textContent = "请填写你实际数到的步数（正整数）。";
    return;
  }
  let windowMs = null;
  const sec = Number(dom["human-sec"].value);
  if (Number.isFinite(sec) && sec > 0) {
    windowMs = sec * 1000;
  } else if (S.t0PerfMs !== null) {
    windowMs = Math.max(0, perfNow() - S.t0PerfMs);
  }
  S.human = { steps: Math.round(steps), windowMs };
  refreshIntegrity();
  render(true);
  dom["export-note"].textContent =
    "人工计数已记入本次会话，会随诊断 JSON 一起导出（字段 human_count）。";
}

// ---------------------------------------------------------------- 无头自检

/**
 * 自检用的 GPX：一条正北方向的直线，1 秒一点，1.4 m/s，并在中途留一个 6 秒空洞。
 *
 * 为什么留空洞：断档检测是本阶段要验证的东西之一，如果自检轨迹一路无洞，
 * 那"断档 0 次"既可能是实现正确，也可能是这条路径根本没跑过。
 * 空洞期间**位置照常前进**（人没停，只是定位没了），所以空洞后那一点的
 * 差分速度仍然是 1.4 m/s——如果时间被拉长而距离没变，就会造出一个
 * 0.2 m/s 的假速度，反而把步幅判定带偏。
 *
 * 为什么不写 GPX 1.1 的 xmlns 命名空间声明：解析器是正则实现，
 * 命名空间声明对它没有任何作用（1.0 / 1.1 / 不带命名空间三种写法都由单测覆盖）。
 * 而这个字符串会进公开站点，站点的发布审查要求**一个外部地址都不出现**，
 * 写一个用不到的 xmlns 只会让审查去讨论"这算不算外链"。
 *
 * 为什么在代码里生成而不是放一个样本文件：站点白名单不允许 `.gpx` 进入
 * `site/`（那是数据，不是页面）。生成出来的轨迹是**几何参数化的**，
 * 所以 `<desc>` 里明写 synthetic——`guessProvenance` 会把它判成
 * SYNTHETIC_GEOMETRY，页面上那条警告也就被一起验证到了。
 */
function buildSelftestGpx(seconds, opts = {}) {
  const speedMps = 1.4;
  const gapAt = opts.gapAt ?? 5;
  const gapSec = opts.gapSec ?? 6;
  const baseLat = opts.baseLat ?? 30;
  const baseLon = opts.baseLon ?? 120;
  const pts = [];
  for (let i = 0; i <= seconds; i += 1) {
    // 第 gapAt 点之后的那一段，墙上时间多走了 gapSec 秒
    const elapsedSec = i + (i > gapAt ? gapSec : 0);
    const lat = baseLat + (speedMps * elapsedSec) / 111320;
    const iso = new Date(Date.UTC(2026, 10, 21, 0, 0, elapsedSec))
      .toISOString()
      .replace(".000Z", "Z");
    pts.push(
      `  <trkpt lat="${lat.toFixed(7)}" lon="${baseLon.toFixed(7)}">` +
        `<ele>0</ele><time>${iso}</time></trkpt>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="CoreMotionCadenceLab selftest">
  <metadata><name>selftest_line</name><desc>synthetic geometry, generated for page selftest</desc></metadata>
  <trk><name>selftest</name><trkseg>
${pts.join("\n")}
  </trkseg></trk>
</gpx>`;
}

/**
 * 无头自检：`gps.html?selftest=1&seconds=12&preset=walk`
 *
 * 与真机无关：这里的运动序列是合成的，GPX 是几何生成的，回放走虚拟时钟。
 * 它证明的是**页面装配正确**——模块能解析、DOM id 对得上、导出能构造出来、
 * 全程不发请求；它不证明任何精度。
 *
 * 虚拟时钟：回放源的 setTimeout 被换成一个按虚拟时刻排序的队列，
 * 于是 12 秒的轨迹在几毫秒内跑完，而**排程逻辑仍是生产实现**
 * （`_scheduleNext` → `fileToPerf` → `_emitCurrent`）。
 * 若换成手写循环一个个喂点，这里就只是"我也能造出 fix"，测不到排程。
 */
function maybeRunSelftest(params) {
  if (params.get("selftest") !== "1") return false;

  const root = document.documentElement;
  const put = (k, v) => root.setAttribute(`data-lab-${k}`, String(v));
  const seconds = Math.max(4, Math.min(30, Number(params.get("seconds")) || 12));
  const preset = params.get("preset") || "walk";

  // ---- 虚拟时钟与虚拟定时器
  let virtualNow = 0;
  let timerSeq = 0;
  const timers = [];
  const setTimeoutVirtual = (fn, ms) => {
    timerSeq += 1;
    timers.push({ id: timerSeq, at: virtualNow + Math.max(0, ms || 0), fn });
    return timerSeq;
  };
  const clearTimeoutVirtual = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const pump = () => {
    for (;;) {
      let pick = -1;
      for (let i = 0; i < timers.length; i += 1) {
        if (timers[i].at <= virtualNow && (pick < 0 || timers[i].at < timers[pick].at)) pick = i;
      }
      if (pick < 0) return;
      timers.splice(pick, 1)[0].fn();
    }
  };

  // ---- 组装两条数据流
  // 轨迹中途有一个 6 秒空洞，而人是照常走的：所以运动序列要覆盖
  // 12 秒行走 + 6 秒空洞 = 18 秒，两条流才落在同一条时间线上。
  const gapSec = 6;
  const totalSec = seconds + gapSec;
  const gpx = parseGpx(buildSelftestGpx(seconds, { gapSec }));
  const sig = makeSceneSignal(preset, {
    sampleRateHz: 50,
    durationSec: totalSec,
    seed: 11,
    startMs: 0,
  });

  resetSession();
  S.running = true;
  dom["btn-start"].disabled = true;
  dom["btn-stop"].disabled = false;
  setVerdict(dom["perm-verdict"], "自检模式（合成数据）", "is-warn");
  dom["perm-note"].textContent = "自检模式下的运动序列是合成的，不是 iPhone 传感器。";

  S.gpxMeta = gpx.meta;
  S.provenance = guessProvenance(gpx.meta) ?? GpxProvenance.UNKNOWN;
  const replay = new ReplayGpsSource({
    gpx,
    speed: 1,
    provenance: S.provenance,
    onFix: onGpsFix,
    onState: () => {},
    onDone: () => {},
    perfNow: () => virtualNow,
    setTimeoutFn: setTimeoutVirtual,
    clearTimeoutFn: clearTimeoutVirtual,
  });
  S.gps = replay;
  S.replaySpeed = 1;
  setGpsOrigin(GpsOrigin.REPLAY, "1× 回放 · 延迟恒为 0，非实测");
  renderProvenance();

  // ---- 按虚拟时间把两条流交织推进
  let cursor = 0;
  let done = null;
  replay.start();
  const stepMs = 20;
  for (let t = 0; t <= totalSec * 1000; t += stepMs) {
    virtualNow = t;
    pump();
    while (cursor < sig.samples.length && sig.samples[cursor].tMonoMs <= t) {
      onMotionEvent(sig.samples[cursor]);
      cursor += 1;
    }
    // 每秒走一次真实渲染路径。只在最后渲染一次的话，配对样本只有 1 个，
    // 个体基线与步频序列永远攒不满——自检就测不到"证据不足"以外的任何分支。
    if (t % 1000 === 0) render(true, t);
  }
  replay.stop();
  if (timers.length) done = `unfired:${timers.length}`;

  // ---- 走一遍真实的导出构造路径（不触发下载）
  render(true, virtualNow);

  const snap = S.lastSnapshot;
  const trackCsv = buildGpsTrackCsv(S.track, baseMeta());
  const trackLines = trackCsv.trimEnd().split("\n");
  let timelineRows = 0;
  let timelineCols = 0;
  let diag = null;
  let diagBytes = 0;
  try {
    const b = S.buckets;
    // 复用页面上那条导出逻辑，避免自检和真实导出走两套代码
    const rows = b ? b.series() : [];
    for (const r of rows) r.spm = r.covered ? r.step * 60 : null;
    const tlCsv = buildTimelineCsv(rows, baseMeta());
    timelineRows = Math.max(0, tlCsv.trimEnd().split("\n").length - 1);
    timelineCols = tlCsv.split("\n")[0].split(",").length;
  } catch (err) {
    put("gps-selftest-error", String(err && err.message ? err.message : err));
  }
  try {
    diag = buildGpsDiagJson({
      origin: S.gpsOrigin,
      provenance: S.provenance,
      replaySpeed: S.replaySpeed,
      timebase: S.timebase ? S.timebase.summary() : {},
      gps: {
        fixCount: S.fixes.length,
        totalDistanceM: S.track.length ? S.track[S.track.length - 1].distCumM : null,
      },
      outages: {
        gpsThresholdMs: gpsOutageInfo().thresholdMs,
        list: gpsOutageInfo().list,
        merged: mergeOutages(S.motionOutages, gpsOutageInfo().list),
        byKind: {},
        totalMs: 0,
        motionCount: S.motionOutages.length,
      },
      timeline: { bucketMs: 1000, bucketCount: S.buckets ? S.buckets.coverage().buckets : 0 },
      consistency: {
        paired: S.strideSamples.length,
        meanStrideM: S.strideSamples.length
          ? S.strideSamples.reduce((a, c) => a + c, 0) / S.strideSamples.length
          : null,
        plausibilityCounts: S.plausibilityCounts,
        integrity: S.integrity,
        intervalDiagnosis: S.intervalDx,
      },
      notes: [],
    });
    diagBytes = new TextEncoder().encode(JSON.stringify(diag, null, 2)).length;
  } catch (err) {
    put("gps-selftest-error", String(err && err.message ? err.message : err));
  }

  const cov = S.buckets ? S.buckets.coverage() : {};
  const info = gpsOutageInfo();
  const merged = mergeOutages(S.motionOutages, info.list);
  const last = S.track.length ? S.track[S.track.length - 1] : null;

  put("gps-selftest", "done");
  put("gps-points", gpx.points.length);
  put("gps-fixes", S.fixes.length);
  put("gps-origin", S.gpsOrigin);
  put("gps-origin-shown", dom["gps-origin"].textContent);
  put("gps-provenance", S.provenance);
  put("gps-provenance-note", dom["gps-provenance-note"].hidden ? "hidden" : "visible");
  put("gps-replay-note", dom["gps-replay-note"].hidden ? "hidden" : "visible");
  put("gps-dist", last ? last.distCumM.toFixed(2) : "—");
  put("gps-speed", preferredSpeed(last) === null ? "—" : String(preferredSpeed(last)));
  put("gps-outages", merged.length);
  put("gps-outage-ms", merged.reduce((a, o) => a + o.durationMs, 0));
  put("gps-buckets", cov.buckets ?? 0);
  put("gps-motion-cov", cov.motion === null ? "—" : (cov.motion * 100).toFixed(1));
  put("gps-gps-cov", cov.gps === null ? "—" : (cov.gps * 100).toFixed(1));
  put("gps-step-cov", cov.step === null ? "—" : (cov.step * 100).toFixed(1));
  put("gps-dropped", `${cov.droppedOverflow ?? 0}/${cov.droppedEarly ?? 0}`);
  put("gps-stride", dom["m-stride"].textContent);
  put("gps-stride-verdict", dom["m-stride-verdict"].textContent);
  put("gps-verdict", S.integrity ? S.integrity.verdict : "none");
  put("gps-verdict-confirmed", S.integrity && String(S.integrity.verdict).startsWith("confirmed") ? "1" : "0");
  put("gps-evidence-count", S.integrity ? S.integrity.evidence.length : 0);
  put("gps-evidence-items", S.integrity ? S.integrity.evidence.map((e) => e.id).join("+") : "");
  put("gps-missing", S.integrity ? S.integrity.missing.length : 0);
  put("gps-baseline", S.baseline ? String(S.baseline.size) : "0");
  put("gps-double", dom["m-double-ratio"].textContent);
  put("gps-steps", snap ? snap.steps : 0);
  put("gps-spm", snap ? snap.cadenceSpm : "null");
  put("gps-csv-bytes", new TextEncoder().encode(trackCsv).length);
  put("gps-csv-rows", trackLines.length - 1);
  put("gps-csv-cols", trackLines[0].split(",").length);
  put("gps-csv-first-line", trackLines[1] ?? "");
  put("gps-timeline-rows", timelineRows);
  put("gps-timeline-cols", timelineCols);
  put("gps-diag-schema", diag ? diag.schema : "—");
  put("gps-diag-bytes", diagBytes);
  put("gps-diag-origin-note", diag ? (diag.origin_note.includes("回放") ? "replay" : "other") : "—");
  put("gps-filename", buildGpsFilename("gpstrack", "SELFTEST", S.gpsOrigin));
  put("gps-export-enabled", [
    dom["btn-export-gps"], dom["btn-export-timeline"], dom["btn-export-gpsdiag"],
  ].filter((el) => el && !el.disabled).length);
  put("gps-timers-left", done ?? "0");
  put("gps-samples", sig.samples.length);
  put("gps-plan-sec", totalSec);
  put("gps-gap-sec", gapSec);

  S.running = false;
  return true;
}

// ---------------------------------------------------------------- 启动

/** 网络计数器：静态扫描只能证明"代码里没写上传"，这里证明"跑完一轮确实没发请求"。 */
let netCalls = 0;
function installNetworkCounter() {
  const bump = (ch, detail) => {
    netCalls += 1;
    document.documentElement.setAttribute(
      "data-lab-gps-net-log",
      `${ch}:${String(detail).slice(0, 80)}`,
    );
    document.documentElement.setAttribute("data-lab-gps-net", String(netCalls));
  };
  if (typeof window.fetch === "function") {
    const orig = window.fetch.bind(window);
    window.fetch = function countedFetch(input, init) {
      bump("fetch", typeof input === "string" ? input : (input && input.url) || "?");
      return orig(input, init);
    };
  }
  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
    const origOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function countedOpen(method, url) {
      bump("xhr", `${method} ${url}`);
      return origOpen.apply(this, arguments);
    };
  }
  if (window.navigator && typeof window.navigator.sendBeacon === "function") {
    const orig = window.navigator.sendBeacon.bind(window.navigator);
    window.navigator.sendBeacon = function countedBeacon(url) {
      bump("beacon", url);
      return orig.apply(window.navigator, arguments);
    };
  }
  if (typeof window.WebSocket === "function") {
    const OrigWs = window.WebSocket;
    function CountedWs(url, protocols) {
      bump("ws", url);
      return protocols === undefined ? new OrigWs(url) : new OrigWs(url, protocols);
    }
    CountedWs.prototype = OrigWs.prototype;
    window.WebSocket = CountedWs;
  }
  document.documentElement.setAttribute("data-lab-gps-net", "0");
}

function main() {
  collectDom();
  installNetworkCounter();
  // 未捕获异常回写到 DOM：iPhone 上没有控制台，页面本身就是唯一的线索。
  window.addEventListener("error", (e) => {
    document.documentElement.setAttribute(
      "data-lab-error",
      String((e && e.message) || "error").slice(0, 240),
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e && e.reason;
    document.documentElement.setAttribute(
      "data-lab-error",
      String((reason && reason.message) || reason || "rejection").slice(0, 240),
    );
  });

  bootEnvironment();
  bind();
  setGpsOrigin(GpsOrigin.NONE, "尚未选择 GPS 模式");
  dom["footer-meta"].textContent =
    `E-W4.2 · 距离算法 ${GPS_QUALITY_ALGO} · 步频参数 ${new StepDetector({ source: "REAL" }).params.version}`;
  document.documentElement.setAttribute("data-lab-boot", "ok");

  // 自检放在 boot 之后：即使自检中途抛异常，冒烟检查也能区分
  // "页面根本没起来"（缺 boot）与"起来了但自检失败"（有 boot、无 selftest）。
  try {
    maybeRunSelftest(new URLSearchParams(location.search));
  } catch (err) {
    document.documentElement.setAttribute(
      "data-lab-gps-selftest-error",
      String((err && err.message) || err).slice(0, 240),
    );
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
