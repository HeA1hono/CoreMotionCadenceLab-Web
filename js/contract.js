/**
 * 数据契约 V1.0 —— Web 侧镜像实现，与 windows/cadence_lab/contract.py 逐字段对应。
 *
 * 本文件不修改、不依赖 Python 端任何文件；它是一份独立实现，
 * 通过与冻结版的「跨语言一致性测试」证明两者判定一致
 * （见 tools/parity_check.py 与 tests/fixtures/contract_cases.json）。
 *
 * 设计要点与 Python 端严格保持同构：
 *   1. status 与 quality 是两个独立维度，不可合并。
 *   2. 零步频是数值（status=OK, cadence_spm=0.0），不是状态。
 *   3. 单位换算只允许经由 stepsPerSecondToSPM() 一个入口。
 *   4. INV-5（delta 与累计步数之差）是跨样本不变量，不在 validateSample() 里，
 *      由 deltaConsistencyError() / validateSequence() 在样本串联处校验。
 *
 * 注意：本阶段（E-W1）不产出 17 字段样本，本模块为 E-W3 的步频输出预置，
 * 已通过单测与跨语言一致性测试。
 */

export const CONTRACT_VERSION = "1.0";

/** 契约 §4 默认阈值（与 Python 端一致） */
export const DEFAULT_STALE_THRESHOLD_MS = 3000;
export const DEFAULT_GAP_THRESHOLD_MS = 2000;

/** 浮点比较容差（与 Python 端 _EPS 一致） */
const EPS = 1e-6;

export class ContractViolation extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractViolation";
  }
}

export const CadenceSource = Object.freeze({
  MOCK: "MOCK",
  REAL: "REAL",
});

export const CadenceStatus = Object.freeze({
  OK: "OK",
  NO_DATA: "NO_DATA",
  PERMISSION_NOT_DETERMINED: "PERMISSION_NOT_DETERMINED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  PERMISSION_RESTRICTED: "PERMISSION_RESTRICTED",
  UNAVAILABLE: "UNAVAILABLE",
  INTERRUPTED: "INTERRUPTED",
  ERROR: "ERROR",
});

export const SampleQuality = Object.freeze({
  OK: "OK",
  STALE: "STALE",
  GAP: "GAP",
  INVALID: "INVALID",
});

export const CadenceRawUnit = Object.freeze({
  STEPS_PER_SECOND: "steps_per_second",
  STEPS_PER_MINUTE: "steps_per_minute",
});

export const ProviderState = Object.freeze({
  IDLE: "IDLE",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  STOPPED: "STOPPED",
  ERROR: "ERROR",
});

const ALLOWED_TRANSITIONS = Object.freeze({
  IDLE: ["RUNNING"],
  RUNNING: ["PAUSED", "STOPPED", "ERROR"],
  PAUSED: ["RUNNING", "STOPPED", "ERROR"],
  STOPPED: ["RUNNING"],
  ERROR: ["IDLE"],
});

export function assertTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new ContractViolation(`非法状态转移: ${from} -> ${to}`);
  }
}

/**
 * 唯一换算入口：步/秒 → 步/分钟。
 * CMPedometerData.currentCadence 的官方单位是 steps per second，
 * 任何显示前必须 ×60，且只允许在此处实现（契约 §9）。
 */
export function stepsPerSecondToSPM(raw) {
  return Number(raw) * 60.0;
}

/** CSV 表头，顺序与契约 §7.3 严格一致（16 列，contract_version 不入 CSV） */
export const CSV_HEADER = Object.freeze([
  "seq",
  "session_id",
  "source",
  "status",
  "t_mono_ns",
  "t_wall",
  "steps_total",
  "steps_delta",
  "cadence_spm",
  "cadence_raw",
  "cadence_raw_unit",
  "gap_ms",
  "data_age_ms",
  "quality",
  "target_spm",
  "note",
]);

/** 17 字段的字段名清单，用于结构自检 */
export const SAMPLE_FIELDS = Object.freeze([
  "contract_version",
  "seq",
  "session_id",
  "source",
  "status",
  "t_mono_ns",
  "t_wall",
  "steps_total",
  "steps_delta",
  "cadence_spm",
  "cadence_raw",
  "cadence_raw_unit",
  "gap_ms",
  "data_age_ms",
  "quality",
  "target_spm",
  "note",
]);

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isNullish(v) {
  return v === null || v === undefined;
}

/**
 * 构造一条样本。只做类型归一，不做校验。
 * @param {object} init 17 字段，可省略 target_spm / note
 */
export function makeSample(init) {
  return {
    contract_version: init.contract_version ?? CONTRACT_VERSION,
    seq: init.seq,
    session_id: init.session_id,
    source: init.source,
    status: init.status,
    t_mono_ns: init.t_mono_ns,
    t_wall: init.t_wall,
    steps_total: init.steps_total,
    steps_delta: init.steps_delta,
    cadence_spm: isNullish(init.cadence_spm) ? null : Number(init.cadence_spm),
    cadence_raw: isNullish(init.cadence_raw) ? null : Number(init.cadence_raw),
    cadence_raw_unit: init.cadence_raw_unit,
    gap_ms: init.gap_ms,
    data_age_ms: init.data_age_ms,
    quality: init.quality,
    target_spm: isNullish(init.target_spm) ? null : Number(init.target_spm),
    note: isNullish(init.note) ? null : String(init.note),
  };
}

/**
 * 校验单样本不变量（对应 Python 端 CadenceSample.validate 的全部检查）。
 * 返回全部违反项的数组；空数组表示通过。
 *
 * 与 Python 端唯一的语义差异：Python 遇第一条即抛异常，此处收集全部，
 * 便于诊断页一次性列出所有问题。判定结果（通过/不通过）完全一致。
 */
export function validateSample(sample) {
  const errors = [];
  const fail = (id, message) => errors.push({ id, message });

  // INV-1 契约版本
  if (sample.contract_version !== CONTRACT_VERSION) {
    fail("INV-1", `契约版本不符: ${sample.contract_version} != ${CONTRACT_VERSION}`);
  }

  // INV-2 seq 从 1 起，正整数
  if (!Number.isInteger(sample.seq) || sample.seq < 1) {
    fail("INV-2", `seq 必须为 >= 1 的整数，实际 ${sample.seq}`);
  }

  // INV-3 单调时钟必须为非负整数（纳秒）
  if (!isFiniteNumber(sample.t_mono_ns) || sample.t_mono_ns < 0) {
    fail("INV-3", `t_mono_ns 不能为负，实际 ${sample.t_mono_ns}`);
  }

  // INV-4 步数非负
  if (!isFiniteNumber(sample.steps_total) || sample.steps_total < 0) {
    fail("INV-4", `steps_total 不能为负，实际 ${sample.steps_total}`);
  }
  if (!isFiniteNumber(sample.steps_delta) || sample.steps_delta < 0) {
    fail("INV-4b", `steps_delta 不能为负，实际 ${sample.steps_delta}`);
  }

  // CHK-gap / CHK-age 非负
  if (!isFiniteNumber(sample.gap_ms) || sample.gap_ms < 0) {
    fail("CHK-gap", `gap_ms 不能为负，实际 ${sample.gap_ms}`);
  }
  if (!isFiniteNumber(sample.data_age_ms) || sample.data_age_ms < 0) {
    fail("CHK-age", `data_age_ms 不能为负，实际 ${sample.data_age_ms}`);
  }

  // INV-6 / INV-7 status 与 cadence 值的互斥关系
  if (sample.status === CadenceStatus.OK) {
    if (isNullish(sample.cadence_spm)) {
      fail("INV-6", "status=OK 时 cadence_spm 不能为 null");
    } else if (!isFiniteNumber(sample.cadence_spm) || sample.cadence_spm < 0) {
      fail("INV-7", `status=OK 时 cadence_spm 不能为负，实际 ${sample.cadence_spm}`);
    }
  } else {
    if (!isNullish(sample.cadence_spm)) {
      fail("INV-6b", `status=${sample.status} 时 cadence_spm 必须为 null`);
    }
    if (!isNullish(sample.cadence_raw)) {
      fail("INV-6c", `status=${sample.status} 时 cadence_raw 必须为 null`);
    }
  }

  // INV-8 REAL 模式不得有目标步频
  if (sample.source === CadenceSource.REAL && !isNullish(sample.target_spm)) {
    fail("INV-8", "REAL 模式 target_spm 必须为 null");
  }

  // INV-9 / INV-10 单位换算一致性
  if (!isNullish(sample.cadence_spm) && !isNullish(sample.cadence_raw)) {
    if (sample.cadence_raw_unit === CadenceRawUnit.STEPS_PER_SECOND) {
      const expected = stepsPerSecondToSPM(sample.cadence_raw);
      if (!numbersClose(sample.cadence_spm, expected)) {
        fail(
          "INV-9",
          `步/秒换算不一致: spm=${sample.cadence_spm} 应为 raw*60=${expected}`
        );
      }
    } else if (!numbersClose(sample.cadence_spm, sample.cadence_raw)) {
      fail(
        "INV-10",
        `步/分直通不一致: spm=${sample.cadence_spm} raw=${sample.cadence_raw}`
      );
    }
  }

  // INV-11 首条样本 gap 为 0
  if (sample.seq === 1 && sample.gap_ms !== 0) {
    fail("INV-11", `首条样本 gap_ms 必须为 0，实际 ${sample.gap_ms}`);
  }

  // INV-12 INVALID 必须带 note
  if (sample.quality === SampleQuality.INVALID && !sample.note) {
    fail("INV-12", "quality=INVALID 时必须提供 note");
  }

  return errors;
}

function numbersClose(a, b) {
  if (!isFiniteNumber(a) || !isFiniteNumber(b)) return false;
  return Math.abs(a - b) <= Math.max(EPS, EPS * Math.max(Math.abs(a), Math.abs(b)));
}

/** 校验失败时抛 ContractViolation，消息内包含全部违反项。 */
export function assertValid(sample) {
  const errors = validateSample(sample);
  if (errors.length > 0) {
    throw new ContractViolation(
      errors.map((e) => `[${e.id}] ${e.message}`).join("; ")
    );
  }
}

/**
 * INV-5：steps_delta 必须等于相邻两条样本的 steps_total 之差。
 *
 * 适用边界（不满足即「不适用」，返回 null，不视为违反）：
 *   1. 没有前一条（会话首条）；
 *   2. session_id 不同（跨会话）；
 *   3. seq 不等于 prev.seq + 1（reset 或重开会话导致 seq 重排）。
 */
export function deltaConsistencyError(prev, cur) {
  if (!prev) return null;
  if (cur.session_id !== prev.session_id) return null;
  if (cur.seq !== prev.seq + 1) return null;

  const expected = cur.steps_total - prev.steps_total;
  if (cur.steps_delta === expected) return null;

  if (expected < 0) {
    return (
      `累计步数回退: seq ${prev.seq}->${cur.seq} ` +
      `steps_total ${prev.steps_total}->${cur.steps_total}, ` +
      `但 steps_delta=${cur.steps_delta}`
    );
  }
  return (
    `steps_delta 与累计步数差不一致: seq ${cur.seq} ` +
    `delta=${cur.steps_delta}, 期望 ${expected} ` +
    `(steps_total ${prev.steps_total}->${cur.steps_total})`
  );
}

export function assertDeltaConsistency(prev, cur) {
  const error = deltaConsistencyError(prev, cur);
  if (error !== null) {
    throw new ContractViolation(`INV-5 违反: ${error}`);
  }
}

/** 对整串样本复核 INV-5，返回全部违反说明（空数组表示通过）。 */
export function validateSequence(samples) {
  const errors = [];
  let prev = null;
  for (const sample of samples) {
    const error = deltaConsistencyError(prev, sample);
    if (error !== null) errors.push(error);
    prev = sample;
  }
  return errors;
}

/**
 * 浮点转 CSV 字段，与 Python 端 sample_to_csv_row 的
 * f"{value:.6f}".rstrip("0").rstrip(".") 逐字一致。
 */
export function formatCsvValue(value) {
  if (isNullish(value)) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    let s = value.toFixed(6);
    if (s.indexOf(".") >= 0) {
      s = s.replace(/0+$/, "").replace(/\.$/, "");
    }
    return s;
  }
  return String(value);
}

/** 转 CSV 行（数组），列顺序严格按 CSV_HEADER。 */
export function sampleToCsvRow(sample) {
  return CSV_HEADER.map((key) => formatCsvValue(sample[key]));
}

export function sampleToCsvLine(sample) {
  return sampleToCsvRow(sample).join(",");
}

/**
 * Web 侧会话号：web- 前缀用于在任何导出物里一眼区分来源。
 * 契约未限制 session_id 格式，前缀不违反契约。
 */
export function makeWebSessionId(uuidFn) {
  const uuid =
    typeof uuidFn === "function"
      ? uuidFn()
      : globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : fallbackUuid();
  return `web-${uuid}`;
}

function fallbackUuid() {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
    else if (i === 14) out += "4";
    else out += hex[Math.floor(Math.random() * 16)];
  }
  return out;
}

/** Web 侧统一来源声明，写入每条导出物的 note。 */
export const WEB_SOURCE_NOTE = "sensor=devicemotion;cadence=derived;not_cmpedometer";
