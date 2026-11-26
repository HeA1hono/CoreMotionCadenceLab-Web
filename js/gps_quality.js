/**
 * E-W4.1 定位质量与确认距离。
 *
 * 原始累计距离（`distCumM`）保持 E-W4 的口径：时间向前的相邻点，
 * 球面距离直接相加。它用来看漂移本来长什么样，不被覆盖、不被改写。
 *
 * 确认距离是另一件事：只有当「从锚点到当前点的净位移」已经大过两端
 * 定位精度合成出来的不确定度，才把这段净位移算进确认距离。
 * 门限是 `SIGMA_FACTOR × hypot(精度甲, 精度乙)`，单位米是算出来的，
 * 不是一个放之四海的固定米数。净位移还没跨过这道门时，结果是
 * 「尚不能确认」，确认距离不增加，也不假装成 0 米真值。
 *
 * 算进确认距离的是净位移，不是抖动路程。静止时左右乱跳会把原始路程
 * 越加越长，但净位移仍停在精度圆里，这些米留在原始路程和未确认路程里。
 *
 * 没有精度字段（GPX 回放常见）时，做不了这道门。这时只剔除时间倒退、
 * 超高速跳点和长时间中断，并标明 `no_accuracy`。这种结果不能用来
 * 证明真实 GPS 准不准。
 *
 * 速度用的时间：两点都有采样时刻（`tEpochMs`，位置确定的时间）时，
 * 用采样间隔。到达时刻（`tMonoMs`）只说明网页何时收到这个点。
 * 两把钟都保留，不把到达间隔拿去冒充采样间隔。
 */

import { formatPace, haversineM } from "./gps.js";

export const GPS_QUALITY_ALGO = "ew4.2.0";

/**
 * 沿轨迹方向，两端独立高斯误差之差超过 2σ 的概率约 4.6%。
 * 净位移必须大于这一倍的合成精度，才认为不是两个误差圆里的偶然点。
 */
export const SIGMA_FACTOR = 2;

/**
 * 路程远长于净位移、而且超出精度门的余量还很小：更像乱走的噪声，
 * 不像一段走得动的位移。只在「相干性低 且 下限速度也低」时同时成立
 * 才拒绝；干净的直线相干性接近 1，不会被这条挡掉。
 */
export const COHERENCE_MIN = 0.25;

/** 少于这么多段，净位移还分不清「真的在走」和「一个跳点」。 */
export const MIN_SUFFIX_SEGMENTS = 4;

/**
 * 相邻点隐含速度超过这个值，就不是消费级定位的连续位移
 * （约 162 km/h）。这是物理上的荒谬上界，不是配速目标。
 * 低于它的车辆、骑行仍然可以进入确认距离。
 */
export const ABSURD_SPEED_MPS = 45;

/**
 * 瞬时速度已经很快，但这点位移还没跨过精度门：不许把它画成配速。
 * 只影响显示，不参与距离取舍。
 */
export const DISPLAY_UNRELIABLE_MPS = 8;

/** 低于此速度不显示配速（会变成几十分钟甚至上万分钟每公里）。 */
export const STATIONARY_MPS = 0.4;

/** 刚确认过的窗口速度可以再显示这么久，避免 1 Hz 定位把配速闪没。 */
export const PACE_HOLD_MS = 20000;

/** 中断长于 max(此时长, 最近间隔中位数 × 倍数) 时，不把两侧连成一段。 */
export const LONG_GAP_FLOOR_MS = 30000;
export const LONG_GAP_MEDIAN_FACTOR = 8;

const SHORT_GAP_FLOOR_MS = 2000;
const SHORT_GAP_MEDIAN_FACTOR = 3;
const REACQUIRE_COUNT = 3;
const GAP_MEMORY = 12;
const BUFFER_CAP = 240;

const STATE_NOTE = Object.freeze({
  good: "定位质量良好。确认距离是跨过精度门的净位移，不是把每个抖动都加进去。",
  no_accuracy: "没有定位精度，只去掉了中断和超高速跳点，不能用来证明真实 GPS 准不准。",
  insufficient: "位置变化还不够大，不能确认真的在移动。",
  drift: "疑似静止漂移：原始路程在涨，但净位移还落在定位误差里。",
  spike: "出现异常跳点。跳变留在原始路程里，没有算进确认距离。",
  gap: "定位中断。中断前后分成两段，没有把空白连起来。",
  disagree: "芯片速度和位置变化对不上，这段先记为存疑，不计入确认距离。",
  time: "时间戳重复或倒退，这一段没有用来算速度。",
  few_points: "定位点太少，距离和配速都还不能判断。",
});

export const QUALITY_LABEL = Object.freeze({
  good: "良好",
  no_accuracy: "无精度值",
  insufficient: "尚不能确认",
  drift: "疑似漂移",
  spike: "异常跳点",
  gap: "定位中断",
  disagree: "速度矛盾",
  time: "时间异常",
  few_points: "点数不足",
});

function accOf(fix) {
  const a = Number(fix && fix.accuracyM);
  return Number.isFinite(a) && a > 0 ? a : null;
}

function rss(a, b) {
  if (a === null || b === null) return null;
  return Math.hypot(a, b);
}

function finiteNonNeg(v) {
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

function snap(fix) {
  const epoch = fix && fix.tEpochMs;
  const tSample = typeof epoch === "number" && Number.isFinite(epoch) ? epoch : null;
  const tArrival = Number(fix.tMonoMs);
  return {
    lat: Number(fix.lat),
    lon: Number(fix.lon),
    // 窗口内部的 t 是运动学时间：有采样时刻就用采样时刻，否则才用到达时刻。
    t: tSample !== null ? tSample : tArrival,
    tArrival,
    tSample,
    acc: accOf(fix),
    seg: 0,
    reported: finiteNonNeg(fix.speedMps),
  };
}

function kinBetween(prev, point) {
  const dtArrival = point.tArrival - prev.tArrival;
  if (prev.tSample !== null && point.tSample !== null) {
    return { dt: point.tSample - prev.tSample, basis: "sample", dtArrival };
  }
  return { dt: dtArrival, basis: "arrival", dtArrival };
}

function localReason(delivery, v, reported) {
  if (delivery === "batched" && v < DISPLAY_UNRELIABLE_MPS) return "late_delivery";
  if (delivery === "batched") return "late_delivery_noisy";
  if (v >= DISPLAY_UNRELIABLE_MPS) {
    return reported === 0 ? "reported_zero_but_fast_step" : "noisy_unconfirmed";
  }
  if (reported === 0 && v <= STATIONARY_MPS) return "reported_zero_small_step";
  if (reported === 0) return "reported_zero_unconfirmed";
  return "within_uncertainty";
}

function deliveryClass(kin) {
  const dtA = kin.dtArrival;
  const dtS = kin.basis === "sample" ? kin.dt : null;
  if (!(dtS > 0) || !(dtA > 0)) return "unknown";
  if (dtA < 250 && dtS > Math.max(500, dtA * 5)) return "batched";
  if (Math.abs(dtS - dtA) <= Math.max(250, 0.25 * Math.max(dtS, 1))) return "aligned";
  return "skewed";
}

function cloneCursor(c) {
  return {
    ...c,
    anchor: { ...c.anchor },
    geom: { ...c.geom },
    buffer: c.buffer.map((p) => ({ ...p })),
    gaps: c.gaps.slice(),
    pendingSpikes: c.pendingSpikes.map((p) => ({ ...p })),
    origins: c.origins.slice(),
  };
}

function emptyCursor(fix) {
  const s = snap(fix);
  return {
    anchor: s,
    geom: s,
    buffer: [s],
    trusted: 0,
    ambiguous: 0,
    openPath: 0,
    gaps: [],
    accepted: 1,
    anomaly: 0,
    pointCount: 1,
    excludedSpike: 0,
    excludedGap: 0,
    pendingSpikes: [],
    lastCommitSpeed: null,
    lastCommitT: null,
    lastCommitCode: null,
    lastCode: "origin",
    pointReason: "origin",
    delivery: "none",
    kinBasis: null,
    kinSpeed: null,
    origins: fix.origin ? [fix.origin] : [],
  };
}

function rawSegM(raw) {
  if (!Number.isFinite(raw.speedDerivedMps) || !Number.isFinite(raw.dtMs) || raw.dtMs <= 0) return 0;
  return raw.speedDerivedMps * (raw.dtMs / 1000);
}

function rememberGap(cursor, dt) {
  if (!(dt > 0)) return;
  cursor.gaps.push(dt);
  if (cursor.gaps.length > GAP_MEMORY) cursor.gaps.shift();
}

function longGap(cursor, dt) {
  const med = median(cursor.gaps);
  if (med === null) return false;
  return dt > Math.max(LONG_GAP_FLOOR_MS, LONG_GAP_MEDIAN_FACTOR * med);
}

function shortGap(cursor, dt) {
  const med = median(cursor.gaps);
  if (med === null) return false;
  return dt > Math.max(SHORT_GAP_FLOOR_MS, SHORT_GAP_MEDIAN_FACTOR * med);
}

function nearCluster(point, spikes, geom) {
  const last = spikes[spikes.length - 1];
  const d = haversineM(last, point);
  if (d === null) return false;
  const sig = rss(last.acc, point.acc !== undefined && point.acc !== null ? point.acc : accOf(point));
  if (sig !== null) return d <= SIGMA_FACTOR * sig;
  const dGeom = haversineM(geom, point);
  if (dGeom === null) return false;
  return d * 3 < dGeom;
}

function suffixStats(buf, s) {
  const start = buf[s];
  const end = buf[buf.length - 1];
  const dt = end.t - start.t;
  if (!(dt > 0)) return null;
  const net = haversineM(start, end);
  if (net === null) return null;
  let path = 0;
  let maxSegV = 0;
  const reps = [];
  if (start.reported !== null) reps.push(start.reported);
  for (let k = s + 1; k < buf.length; k += 1) {
    path += buf[k].seg;
    if (buf[k].reported !== null) reps.push(buf[k].reported);
    const dtK = buf[k].t - buf[k - 1].t;
    const vK = dtK > 0 ? buf[k].seg / (dtK / 1000) : Infinity;
    if (vK > maxSegV) maxSegV = vK;
  }
  const sig = rss(start.acc, end.acc);
  if (sig === null) return null;
  const gate = SIGMA_FACTOR * sig;
  const dtSec = dt / 1000;
  return {
    net,
    path,
    gate,
    coh: path > 0 ? net / path : 0,
    vNet: net / dtSec,
    vLow: (net - gate) / dtSec,
    maxSegV,
    rep: median(reps),
    endT: end.t,
  };
}

/**
 * 从最长的后缀开始找第一段「净位移已经跨过精度门」的窗口。
 * 找到就把净位移提交，锚点移到当前点。提交的是净位移，抖动留在外面。
 */
function tryCommit(cursor) {
  const buf = cursor.buffer;
  if (buf.length - 1 < MIN_SUFFIX_SEGMENTS) return false;
  let sawDrift = false;
  const lastS = buf.length - 1 - MIN_SUFFIX_SEGMENTS;
  for (let s = 0; s <= lastS; s += 1) {
    const stats = suffixStats(buf, s);
    if (!stats) continue;
    if (stats.maxSegV > ABSURD_SPEED_MPS) continue;
    if (!(stats.net > stats.gate)) continue;
    if (stats.coh < COHERENCE_MIN && stats.vLow < 0.5) {
      sawDrift = true;
      continue;
    }
    if (stats.rep !== null && stats.rep <= STATIONARY_MPS && stats.vLow < 0.8) {
      sawDrift = true;
      continue;
    }
    const end = buf[buf.length - 1];
    if (stats.rep !== null && stats.rep <= STATIONARY_MPS) {
      cursor.ambiguous += stats.net;
      cursor.lastCommitCode = "ambiguous";
      cursor.lastCode = "ambiguous";
    } else {
      cursor.trusted += stats.net;
      cursor.lastCommitCode = "confirmed";
      cursor.lastCode = "confirmed";
    }
    cursor.lastCommitSpeed = stats.vNet;
    cursor.lastCommitT = end.tArrival;
    const kept = { ...end, seg: 0 };
    cursor.buffer = [kept];
    cursor.anchor = kept;
    cursor.geom = kept;
    cursor.openPath = 0;
    return true;
  }
  if (sawDrift) cursor.lastCode = "drift";
  return false;
}

function slideOldest(cursor) {
  if (cursor.buffer.length < 3) return;
  const dropped = cursor.buffer[1].seg;
  cursor.openPath = Math.max(0, cursor.openPath - dropped);
  cursor.buffer.shift();
  cursor.buffer[0] = { ...cursor.buffer[0], seg: 0 };
  cursor.anchor = cursor.buffer[0];
  if (cursor.lastCode === "within_uncertainty") cursor.lastCode = "window_slide";
}

function assignState(cursor) {
  const code = cursor.lastCode;
  if (code === "spike" || code === "reacquire") return "spike";
  if (code === "gap") return "gap";
  if (code === "time_rewind" || code === "time_duplicate" || code === "bad_coords") return "time";
  if (code === "ambiguous") return "disagree";
  if (code === "drift") return "drift";
  if (
    code === "no_accuracy"
    || code === "no_accuracy_bridged"
    || cursor.lastCommitCode === "no_accuracy"
    || cursor.lastCommitCode === "no_accuracy_bridged"
  ) {
    if (code === "spike" || code === "gap" || code === "time_rewind") return "no_accuracy";
    return "no_accuracy";
  }
  if (cursor.trusted > 0 && (code === "confirmed" || code === "within_uncertainty" || code === "window_slide")) {
    return "good";
  }
  if (code === "window_slide") return "drift";
  if (cursor.pointCount < 5 && cursor.trusted === 0 && cursor.anomaly === 0) return "few_points";
  if (code === "origin") return "few_points";
  return "insufficient";
}

function presentPace(row) {
  const reported = finiteNonNeg(row.speedMps);
  const derived = finiteNonNeg(row.speedDerivedMps);
  const committed = finiteNonNeg(row.committedSpeedMps);
  const age = Number.isFinite(row.tMonoMs) && Number.isFinite(row.committedAtMs)
    ? row.tMonoMs - row.committedAtMs
    : null;
  const commitCode = row.lastCommitCode;
  const recentGood = committed !== null
    && committed >= STATIONARY_MPS
    && age !== null
    && age >= 0
    && age <= PACE_HOLD_MS
    && (commitCode === "confirmed" || commitCode === "no_accuracy" || commitCode === "no_accuracy_bridged");
  const instCandidates = [reported, derived].filter((v) => v !== null);
  const inst = instCandidates.length ? Math.max(...instCandidates) : null;

  const pack = (kind, text, speedMps, source) => ({
    paceDisplayKind: kind,
    paceDisplayText: text,
    displaySpeedMps: speedMps,
    displaySpeedSource: source,
  });

  if (
    row.segmentCode === "spike"
    || row.segmentCode === "reacquire"
    || row.segmentCode === "time_rewind"
    || row.segmentCode === "time_duplicate"
    || row.segmentCode === "bad_coords"
  ) {
    return pack("unreliable", "数据不可靠", null, "none");
  }
  if (row.segmentCode === "ambiguous") {
    return pack("unreliable", "数据不可靠", null, "none");
  }
  // 芯片明确报了接近 0 的速度：优先显示静止。
  // 只有「刚确认过一段不慢的净位移」时才改口为不可靠，避免两套数互相拆台。
  if (reported !== null && reported <= STATIONARY_MPS) {
    if (recentGood && committed >= 0.8) return pack("unreliable", "数据不可靠", null, "none");
    return pack("stationary", "静止", reported, "reported");
  }
  if (
    !recentGood
    && inst !== null
    && inst >= DISPLAY_UNRELIABLE_MPS
    && (row.distConfirmedM === 0 || row.segmentCode === "within_uncertainty" || row.segmentCode === "drift")
  ) {
    return pack("unreliable", "数据不可靠", null, "none");
  }
  if (recentGood) {
    return pack("pace", formatPace(1000 / committed), committed, "window");
  }
  if (derived !== null && derived <= STATIONARY_MPS) {
    return pack("stationary", "静止", derived, "derived");
  }
  return pack("no_pace", "暂无有效配速", null, "none");
}

function fmtM(v) {
  return Number.isFinite(v) ? v.toFixed(1) : "—";
}

export function buildQualityNote(row) {
  if (!row || !row.qualityState) return "还没有定位点。";
  const bits = [`原始 ${fmtM(row.distRawM)} m，确认 ${fmtM(row.distConfirmedM)} m。`];
  if (row.distAmbiguousM > 0) {
    bits.push(`存疑 ${fmtM(row.distAmbiguousM)} m，位移和芯片速度对不上，没有算进确认距离。`);
  }
  if (row.distOpenM > 0) bits.push(`另有 ${fmtM(row.distOpenM)} m 还不能确认。`);
  if (Number.isFinite(row.openGateM) && row.distConfirmedM === 0 && row.qualityState !== "no_accuracy") {
    bits.push(`净位移还没超过约 ${fmtM(row.openGateM)} m（两端精度合成值的 2 倍），所以先不确认。`);
  }
  if (row.excludedSpikeM > 0) bits.push(`异常跳点 ${fmtM(row.excludedSpikeM)} m 已隔开。`);
  if (row.excludedGapM > 0) bits.push(`中断两侧没有连上，隔开的 ${fmtM(row.excludedGapM)} m 只留在原始路程里。`);
  if (row.delivery === "batched") {
    bits.push("有定位点是成批迟到的：速度按采样间隔计算，没有把几毫秒的到达间隔当成高速。");
  }
  if (row.speedMps === 0 && Number.isFinite(row.speedSampleMps) && row.speedSampleMps > 1) {
    bits.push("芯片速度为 0，但采样间隔上的位移并不像静止。0 是设备报告，这段没有计入确认距离。");
  } else if (row.speedMps === 0 && row.paceDisplayKind === "stationary") {
    bits.push("芯片速度为 0，对应采样位移也小。这不能单独证明整次实验都没移动。");
  }
  if (STATE_NOTE[row.qualityState]) bits.push(STATE_NOTE[row.qualityState]);
  if (row.paceDisplayKind === "stationary") bits.push("速度接近零，不换算配速。");
  if (row.paceDisplayKind === "unreliable") bits.push("当前差分速度不可靠，不显示配速。");
  if (row.paceDisplayKind === "no_pace" && row.qualityState !== "few_points") {
    bits.push("暂无有效配速。");
  }
  if (row.mixedOrigin) bits.push("轨迹里混有不同来源，不能当成同一次实测。");
  return bits.join("");
}

function finish(cursor, raw) {
  const row = { ...raw };
  row.distRawM = row.distCumM;
  row.distConfirmedM = cursor.trusted;
  row.distAmbiguousM = cursor.ambiguous;
  row.distOpenM = cursor.openPath;
  row.segmentCode = cursor.lastCode;
  row.pointReason = cursor.pointReason;
  row.delivery = cursor.delivery;
  row.kinBasis = cursor.kinBasis;
  row.kinSpeedMps = cursor.kinSpeed;
  row.qualityAlgo = GPS_QUALITY_ALGO;
  row.committedSpeedMps = cursor.lastCommitSpeed;
  row.committedAtMs = cursor.lastCommitT;
  row.lastCommitCode = cursor.lastCommitCode;
  row.anomalyCount = cursor.anomaly;
  row.effectiveCount = cursor.accepted;
  row.excludedSpikeM = cursor.excludedSpike;
  row.excludedGapM = cursor.excludedGap;
  row.mixedOrigin = cursor.origins.length > 1;
  const sig = rss(cursor.anchor.acc, cursor.geom.acc);
  row.openGateM = sig === null ? null : SIGMA_FACTOR * sig;
  row.qualityState = assignState(cursor);
  Object.assign(row, presentPace(row));
  row.qualityNote = buildQualityNote(row);
  row.qualityCursor = cursor;
  return { row, cursor };
}

function noteOrigin(cursor, raw) {
  if (raw.origin && !cursor.origins.includes(raw.origin)) cursor.origins.push(raw.origin);
}

function applyOne(prev, raw) {
  if (!prev) return finish(emptyCursor(raw), raw);
  const cursor = cloneCursor(prev);
  noteOrigin(cursor, raw);
  const segRaw = rawSegM(raw);

  const located = snap(raw);
  if (!Number.isFinite(located.lat) || !Number.isFinite(located.lon) || !Number.isFinite(located.tArrival)) {
    cursor.anomaly += 1;
    cursor.pointCount += 1;
    cursor.lastCode = "bad_coords";
    cursor.pointReason = "bad_coords";
    return finish(cursor, raw);
  }

  const distG = haversineM(cursor.geom, located);
  const kin = kinBetween(cursor.geom, located);
  const dtG = kin.dt;
  cursor.kinBasis = kin.basis;
  cursor.delivery = deliveryClass(kin);
  if (distG === null) {
    cursor.anomaly += 1;
    cursor.pointCount += 1;
    cursor.lastCode = "bad_coords";
    cursor.pointReason = "bad_coords";
    return finish(cursor, raw);
  }
  if (!(dtG > 0)) {
    cursor.anomaly += 1;
    cursor.pointCount += 1;
    cursor.lastCode = dtG < 0 ? "time_rewind" : "time_duplicate";
    cursor.pointReason = kin.basis === "sample"
      ? (dtG < 0 ? "sample_time_rewind" : "sample_time_duplicate")
      : cursor.lastCode;
    return finish(cursor, raw);
  }

  const vG = distG / (dtG / 1000);
  cursor.kinSpeed = vG;
  if (longGap(cursor, dtG)) {
    cursor.excludedGap += segRaw > 0 ? segRaw : distG;
    cursor.accepted += 1;
    cursor.pointCount += 1;
    cursor.pendingSpikes = [];
    const s = snap(raw);
    cursor.buffer = [s];
    cursor.anchor = s;
    cursor.geom = s;
    cursor.openPath = 0;
    cursor.lastCode = "gap";
    cursor.pointReason = kin.basis === "sample" ? "sample_gap" : "arrival_gap";
    return finish(cursor, raw);
  }

  const reported = finiteNonNeg(raw.speedMps);
  const absurd = vG > ABSURD_SPEED_MPS && (reported === null || reported < vG * 0.5);
  // 只有「仍远在上一个可信点的精度门外」的点才延续跳点簇。
  // 精度恢复后回到门内的点必须退出，不能因为曾经邻近一个异常点就一直算 spike。
  const farSig = rss(cursor.geom.acc, located.acc);
  const far = farSig === null ? true : distG > SIGMA_FACTOR * farSig;
  const continuingTeleport = cursor.pendingSpikes.length > 0
    && far
    && nearCluster(located, cursor.pendingSpikes, cursor.geom);
  if (absurd || continuingTeleport) {
    cursor.anomaly += 1;
    cursor.pointCount += 1;
    cursor.excludedSpike += segRaw > 0 ? segRaw : distG;
    cursor.pendingSpikes.push(snap(raw));
    if (cursor.pendingSpikes.length >= REACQUIRE_COUNT && far) {
      const s = snap(raw);
      cursor.buffer = [s];
      cursor.anchor = s;
      cursor.geom = s;
      cursor.openPath = 0;
      cursor.pendingSpikes = [];
      cursor.lastCode = "reacquire";
      cursor.pointReason = "reacquire_after_teleport";
    } else {
      cursor.lastCode = "spike";
      cursor.pointReason = absurd
        ? (kin.basis === "sample" ? "absurd_sample_speed" : "absurd_arrival_speed")
        : "teleport_cluster";
    }
    return finish(cursor, raw);
  }

  cursor.pendingSpikes = [];
  cursor.pointReason = localReason(cursor.delivery, vG, reported);

  const accPoint = accOf(raw);
  const accGeom = cursor.geom.acc;
  if (accPoint === null || accGeom === null) {
    const bridged = shortGap(cursor, dtG);
    if (bridged && cursor.lastCommitSpeed !== null && cursor.lastCommitSpeed > 0) {
      const ratio = vG / cursor.lastCommitSpeed;
      if (ratio > 2 || ratio < 0.5) {
        cursor.excludedGap += segRaw > 0 ? segRaw : distG;
        cursor.accepted += 1;
        cursor.pointCount += 1;
        const s = snap(raw);
        cursor.buffer = [s];
        cursor.anchor = s;
        cursor.geom = s;
        cursor.openPath = 0;
        cursor.lastCode = "gap";
        cursor.pointReason = "short_gap_inconsistent";
        return finish(cursor, raw);
      }
    }
    cursor.trusted += distG;
    cursor.lastCommitSpeed = vG;
    cursor.lastCommitT = located.tArrival;
    cursor.lastCommitCode = bridged ? "no_accuracy_bridged" : "no_accuracy";
    cursor.lastCode = cursor.lastCommitCode;
    cursor.openPath = 0;
    const s = snap(raw);
    cursor.buffer = [s];
    cursor.anchor = s;
    cursor.geom = s;
    cursor.accepted += 1;
    cursor.pointCount += 1;
    rememberGap(cursor, dtG);
    return finish(cursor, raw);
  }

  const s = snap(raw);
  s.seg = distG;
  cursor.buffer.push(s);
  cursor.geom = s;
  cursor.openPath += distG;
  cursor.accepted += 1;
  cursor.pointCount += 1;
  rememberGap(cursor, dtG);

  const committed = tryCommit(cursor);
  if (committed) {
    cursor.pointReason = cursor.lastCode === "ambiguous" ? "reported_contradicts_motion" : "confirmed_net";
  }
  if (!committed && cursor.lastCode !== "drift") {
    cursor.lastCode = "within_uncertainty";
  }
  if (
    !committed
    && cursor.trusted === 0
    && reported !== null
    && reported <= STATIONARY_MPS
    && cursor.openPath > 0
  ) {
    cursor.lastCode = "drift";
  }
  if (!committed) {
    const gateNow = (() => {
      const g = rss(cursor.buffer[0].acc, cursor.geom.acc);
      return g === null ? null : SIGMA_FACTOR * g;
    })();
    const tooLong = cursor.buffer.length > BUFFER_CAP
      || (gateNow !== null && cursor.openPath > 4 * gateNow && cursor.buffer.length > MIN_SUFFIX_SEGMENTS + 2);
    if (tooLong) slideOldest(cursor);
  }
  return finish(cursor, raw);
}

/** 给已经算好原始派生量的行补上质量字段。不改 lat/lon，不改 distCumM。 */
export function annotateGpsQuality(rows) {
  const out = [];
  let cursor = null;
  for (const raw of rows || []) {
    const step = applyOne(cursor, raw);
    cursor = step.cursor;
    out.push(step.row);
  }
  return out;
}

/** 增量追加一行。与 annotateGpsQuality 全量结果一致，避免每次来点都重算整条轨迹。 */
export function appendAnnotated(track, rawRow) {
  const prev = track.length ? track[track.length - 1].qualityCursor : null;
  const step = applyOne(prev, rawRow);
  track.push(step.row);
  return track;
}
