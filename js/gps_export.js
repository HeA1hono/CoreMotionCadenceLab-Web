/**
 * E-W4 导出：GPS 轨迹、统一时间轴、跨源诊断。
 *
 * 为什么不塞进 export.js：
 *   export.js 里的 `buildFilename` 是**契约级**的——它只接受 REAL / MOCK，
 *   传别的值直接抛错，`assertSourcePair` 还会校验 source 与 sensor 的配对。
 *   那是 E-W1 确立的规矩，动它会波及 234 个既有测试。
 *
 *   GPS 有四个来源（真实传感器 / 真实定位 / GPX 回放 / 合成），硬塞进
 *   二元枚举里，最可能的结果是有人图省事把回放标成 REAL。
 *   所以这里另起一套三值以上的标记，文件和字段名都带 `origin`，
 *   与既有的 `source` 并存但**不互换**。
 */

import { GpsOrigin, GpxProvenance, formatPace } from "./gps.js";

/**
 * 统一来源标记。这是 E-W4 所有导出物的第一分类。
 *
 * 注意 `REAL_SENSOR` 与 `REAL_GPS` 是两个值而不是一个 "REAL"：
 * 它们来自两个独立硬件，采样率差两个数量级，一条记录只可能来自其中一个。
 * 合并成 REAL 会让"这条轨迹到底有没有位置"变得无法判断。
 */
export const DataOrigin = Object.freeze({
  REAL_SENSOR: "REAL_SENSOR",
  REAL_GPS: "REAL_GPS",
  REPLAY: "REPLAY",
  MOCK: "MOCK",
});

/** 断言 origin 合法，非法值直接抛——不允许"猜一个"。 */
export function assertOrigin(origin) {
  const ok = Object.values(DataOrigin).includes(origin);
  if (!ok) {
    throw new Error(
      `origin 必须是 ${Object.values(DataOrigin).join("|")}，收到 ${JSON.stringify(origin)}`,
    );
  }
  return origin;
}

export const GPS_TRACK_CSV_HEADER = Object.freeze([
  "seq",
  "t_mono_ms",
  "t_rel_ms",
  "t_epoch_ms",
  "lat",
  "lon",
  "accuracy_m",
  "altitude_m",
  "heading_deg",
  "speed_mps",
  "speed_source",
  "pace_s_per_km",
  "dist_cum_m",
  "dt_ms",
  "origin",
  "provenance",
  "replay_speed",
  "dist_confirmed_m",
  "dist_ambiguous_m",
  "dist_open_m",
  "segment_code",
  "quality_state",
  "pace_display",
  "display_speed_mps",
  "quality_algo",
  "dt_sample_ms",
  "speed_sample_mps",
  "speed_arrival_mps",
  "time_basis",
  "delivery",
  "point_reason",
]);

export const GPS_TRACK_CSV_VERSION = "1.2";

export const TIMELINE_CSV_HEADER = Object.freeze([
  "bucket_index",
  "t_rel_ms",
  "motion_count",
  "gps_count",
  "step_count",
  "covered",
  "gps_speed_mps",
  "spm",
  "stride_m",
  // 早先那一列叫 stride_suspicion，取值直接写成"腰斩 / 多计"——那等于断言
  // 步频错了。一桶里速度与步频都是派生量，最多只能说"这个组合在不在常见范围内"，
  // 所以列名与取值都改成 plausibility（within / high / low）。
  "stride_plausibility",
]);

export const TIMELINE_CSV_VERSION = "1.0";

export const GPS_DIAG_SCHEMA = "core-motion-cadence-lab/web-lab/gps-timeline";
export const GPS_DIAG_SCHEMA_VERSION = "1.1";

/** CSV 单元格转义：含分隔符/引号/换行时加引号。null → 空。 */
function cell(v, sep = ",") {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    return Number.isFinite(v) ? String(v) : "";
  }
  const s = String(v);
  if (s.includes(sep) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function round(v, digits = 3) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

/**
 * GPS 轨迹 CSV。
 *
 * `t_rel_ms` 是相对**本次会话起点**的毫秒数，用于跨源对齐；
 * `t_epoch_ms` 是墙上时间，用于和外部（相机、手表）对照。
 * 两列都留，因为只留一列总会有人需要另一列，然后开始自己换算。
 *
 * @param {Array<object>} fixes deriveGpsTrack 的输出
 * @param {object} meta
 * @param {number} meta.t0PerfMs 会话起点（单调时钟）
 * @param {string} meta.origin DataOrigin
 * @param {string} [meta.provenance]
 * @param {string} [meta.sessionId]
 */
export function buildGpsTrackCsv(fixes, meta = {}) {
  const origin = assertOrigin(meta.origin);
  const t0 = Number.isFinite(meta.t0PerfMs) ? meta.t0PerfMs : null;
  const lines = [GPS_TRACK_CSV_HEADER.join(",")];

  for (const f of fixes || []) {
    const rel = t0 !== null && Number.isFinite(f.tMonoMs) ? Math.round(f.tMonoMs - t0) : null;
    lines.push(
      [
        cell(f.seq),
        cell(f.tMonoMs === undefined ? null : Math.round(f.tMonoMs)),
        cell(rel),
        cell(f.tEpochMs === undefined ? null : f.tEpochMs),
        cell(round(f.lat, 7)),
        cell(round(f.lon, 7)),
        cell(round(f.accuracyM, 2)),
        cell(round(f.altitudeM, 2)),
        cell(round(f.headingDeg, 1)),
        cell(round(f.speedMps, 3)),
        cell(f.speedSource ?? null),
        cell(round(f.paceSecPerKm, 1)),
        cell(round(f.distCumM, 2)),
        cell(f.dtMs === undefined || f.dtMs === null ? null : Math.round(f.dtMs)),
        cell(origin),
        cell(f.provenance ?? meta.provenance ?? GpxProvenance.UNKNOWN),
        cell(f.replaySpeed ?? null),
        cell(round(f.distConfirmedM, 2)),
        cell(round(f.distAmbiguousM, 2)),
        cell(round(f.distOpenM, 2)),
        cell(f.segmentCode ?? null),
        cell(f.qualityState ?? null),
        cell(f.paceDisplayText ?? null),
        cell(round(f.displaySpeedMps, 3)),
        cell(f.qualityAlgo ?? null),
        cell(f.dtSampleMs === undefined || f.dtSampleMs === null ? null : Math.round(f.dtSampleMs)),
        cell(round(f.speedSampleMps, 3)),
        cell(round(f.speedArrivalMps, 3)),
        cell(f.speedTimeBasis ?? null),
        cell(f.delivery ?? null),
        cell(f.pointReason ?? null),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * 统一时间轴 CSV。
 *
 * 每一行是一个时间桶，三个通道各自的事件数 + 该桶内的 GPS 速度与步频。
 * 空白（`covered=false`）保留为一行全零，因为"这一秒什么都没收到"
 * 本身就是最值得看的信息；把它删掉会让中断消失。
 */
export function buildTimelineCsv(rows, meta = {}) {
  assertOrigin(meta.origin);
  const lines = [TIMELINE_CSV_HEADER.join(",")];
  for (const r of rows || []) {
    lines.push(
      [
        cell(r.index),
        cell(r.tRelMs),
        cell(r.motion),
        cell(r.gps),
        cell(r.step),
        cell(r.covered ? 1 : 0),
        cell(round(r.speedMps, 3)),
        cell(r.spm === null || r.spm === undefined ? null : Math.round(r.spm)),
        cell(round(r.strideM, 2)),
        cell(r.plausibility ?? null),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * 跨源诊断 JSON。
 *
 * 与既有的 `diag` 不同，这份**只讲两个源之间的关系**：时钟、延迟、中断、
 * 一致性。运动传感器自己的统计仍在 `diag` 里，不重复。
 */
export function buildGpsDiagJson(payload = {}) {
  const origin = assertOrigin(payload.origin);
  const timebase = payload.timebase || {};
  const latency = timebase.latency || {};

  return {
    schema: GPS_DIAG_SCHEMA,
    schema_version: GPS_DIAG_SCHEMA_VERSION,
    generated_at: payload.generatedAt ?? new Date().toISOString(),
    session_id: payload.sessionId ?? null,
    origin,
    provenance: payload.provenance ?? GpxProvenance.UNKNOWN,
    replay_speed: payload.replaySpeed ?? null,
    // 来源一句话说明，写进文件里，避免文件脱离上下文后被误读
    origin_note:
      origin === DataOrigin.REAL_GPS
        ? "GPS 为浏览器 Geolocation 实测；步频为网页算法推导，非 CMPedometer"
        : origin === DataOrigin.REPLAY
          ? "GPS 为 GPX 离线回放，非实测；回放延迟恒为 0，不可作为定位性能依据"
          : "GPS 通道无数据",
    clock: {
      anchored: Boolean(timebase.anchored),
      offset_ms: timebase.offset_ms ?? null,
      observation_count: timebase.observation_count ?? 0,
      latency_median_ms: latency.medianMs ?? null,
      latency_p95_ms: latency.p95Ms ?? null,
      latency_max_ms: latency.maxMs ?? null,
      latency_min_ms: latency.minMs ?? null,
      clock_jump: timebase.clock_jump ?? {
        jumped: false, baseline_ms: null, delta_ms: null, since_perf_ms: null,
      },
    },
    gps: {
      fix_count: payload.gps && payload.gps.fixCount ? payload.gps.fixCount : 0,
      first_t_rel_ms: payload.gps ? payload.gps.firstRelMs ?? null : null,
      last_t_rel_ms: payload.gps ? payload.gps.lastRelMs ?? null : null,
      total_distance_m: payload.gps ? round(payload.gps.totalDistanceM, 2) : null,
      mean_speed_mps: payload.gps ? round(payload.gps.meanSpeedMps, 3) : null,
      mean_pace_s_per_km: payload.gps ? round(payload.gps.meanPaceSecPerKm, 1) : null,
      mean_pace_text: formatPace(payload.gps ? payload.gps.meanPaceSecPerKm : null),
      accuracy_median_m: payload.gps ? round(payload.gps.accuracyMedianM, 2) : null,
      speed_source_counts: payload.gps ? payload.gps.speedSourceCounts ?? {} : {},
      quality_algo: payload.gps ? payload.gps.qualityAlgo ?? null : null,
      confirmed_distance_m: payload.gps ? round(payload.gps.confirmedDistanceM, 2) : null,
      ambiguous_distance_m: payload.gps ? round(payload.gps.ambiguousDistanceM, 2) : null,
      open_distance_m: payload.gps ? round(payload.gps.openDistanceM, 2) : null,
      quality_state: payload.gps ? payload.gps.qualityState ?? null : null,
      pace_display: payload.gps ? payload.gps.paceDisplay ?? null : null,
      display_speed_mps: payload.gps ? round(payload.gps.displaySpeedMps, 3) : null,
      anomaly_count: payload.gps ? payload.gps.anomalyCount ?? null : null,
      effective_count: payload.gps ? payload.gps.effectiveCount ?? null : null,
    },
    outages: {
      // 只算定位断档：这一项的阈值是自适应的，由定位点自身的中位间隔决定，
      // 因此可以跨设备比较；运动传感器的阈值是一个固定常数（见 motion_gap_threshold_ms），
      // 两者口径不同，不能合成一个 count。
      gps_threshold_ms: payload.outages ? payload.outages.gpsThresholdMs ?? null : null,
      gps_median_gap_ms: payload.outages ? payload.outages.gpsMedianGapMs ?? null : null,
      count: payload.outages && Array.isArray(payload.outages.list) ? payload.outages.list.length : 0,
      motion_gap_threshold_ms: payload.outages ? payload.outages.motionGapThresholdMs ?? null : null,
      motion_count: payload.outages ? payload.outages.motionCount ?? 0 : 0,
      merged_count: payload.outages && Array.isArray(payload.outages.merged)
        ? payload.outages.merged.length
        : 0,
      total_ms: payload.outages && Number.isFinite(payload.outages.totalMs) ? payload.outages.totalMs : 0,
      by_kind: payload.outages ? payload.outages.byKind ?? {} : {},
      // 合并后的区间明细。数量级通常是几十条以内，放进来比让人去 CSV 里数空洞更有用；
      // 每条都带 kind，因此"是传感器断了还是定位没点"在文件里就能分辨。
      merged_outages: payload.outages && Array.isArray(payload.outages.merged)
        ? payload.outages.merged.map((o) => ({
            start_ms: round(o.startPerfMs, 0),
            end_ms: round(o.endPerfMs, 0),
            duration_ms: round(o.durationMs, 0),
            kind: o.kind,
          }))
        : [],
    },
    timeline: {
      bucket_ms: payload.timeline ? payload.timeline.bucketMs ?? null : null,
      bucket_count: payload.timeline ? payload.timeline.bucketCount ?? 0 : 0,
      motion_coverage: payload.timeline ? round(payload.timeline.motionCoverage, 4) : null,
      gps_coverage: payload.timeline ? round(payload.timeline.gpsCoverage, 4) : null,
      step_coverage: payload.timeline ? round(payload.timeline.stepCoverage, 4) : null,
      // 时间轴满 2 小时后事件会被丢弃。这两个计数是"覆盖率看着正常、
      // 实际后半程没进时间轴"的唯一证据，必须随文件一起走。
      dropped_overflow: payload.timeline ? payload.timeline.droppedOverflow ?? 0 : 0,
      dropped_early: payload.timeline ? payload.timeline.droppedEarly ?? 0 : 0,
    },
    consistency: (() => {
      const c = payload.consistency || {};
      const integ = c.integrity || {};
      const baseline = integ.evidence && Array.isArray(integ.evidence)
        ? integ.evidence.find((e) => e.id === "baseline")
        : null;
      return {
        // 判定只有四个取值，且「已确认」只可能来自人工计数。
        // 早先这里是 cadence_half_suspected 一个布尔量——那个字段名本身
        // 就是一句断言，导出之后会被当成事实读。
        verdict: integ.verdict ?? "no_data",
        verdict_label: integ.label ?? null,
        confidence: integ.confidence ?? null,
        direction: integ.direction ?? null,
        only_human_count_can_confirm: true,
        paired_samples: c.paired ?? 0,
        mean_stride_m: round(c.meanStrideM, 3),
        plausibility_counts: c.plausibilityCounts ?? {},
        evidence: Array.isArray(integ.evidence)
          ? integ.evidence.map((e) => ({
              id: e.id ?? null,
              strength: e.strength ?? null,
              direction: e.direction ?? null,
              text: e.text ?? null,
            }))
          : [],
        missing: Array.isArray(integ.missing) ? integ.missing : [],
        human_count: (() => {
          const h = c.humanCount;
          if (!h || !Number.isFinite(h.steps)) {
            return { provided: false, steps: null, algo_steps: null, ratio: null, window_ms: null };
          }
          const algo = Number.isFinite(h.algoSteps) ? h.algoSteps : null;
          return {
            provided: true,
            steps: h.steps,
            algo_steps: algo,
            ratio: algo && algo > 0 ? round(h.steps / algo, 3) : null,
            window_ms: Number.isFinite(h.windowMs) ? h.windowMs : null,
          };
        })(),
        baseline_note: baseline ? baseline.text : null,
        interval_diagnosis: c.intervalDiagnosis ?? null,
        note: integ.note ?? null,
      };
    })(),
    notes: Array.isArray(payload.notes) ? payload.notes : [],
  };
}

export const GPS_FILE_KINDS = Object.freeze({
  gpstrack: { prefix: "gpstrack", ext: "csv" },
  timeline: { prefix: "timeline", ext: "csv" },
  gpsdiag: { prefix: "gpsdiag", ext: "json" },
});

/**
 * GPS 导出文件名：`<prefix>_<stamp>_WEB_<ORIGIN>.<ext>`
 *
 * 与 `buildFilename` 的区别只在来源段：这里写的是四值 origin。
 * 文件名里带来源，是为了让文件在文件管理器里就能分辨，
 * 不必打开看第一行。
 */
export function buildGpsFilename(kind, stamp, origin) {
  assertOrigin(origin);
  const spec = GPS_FILE_KINDS[kind];
  if (!spec) {
    throw new Error(`未知的 GPS 导出类型: ${JSON.stringify(kind)}`);
  }
  return `${spec.prefix}_${stamp}_WEB_${origin}.${spec.ext}`;
}
