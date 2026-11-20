/**
 * E-W3 人工计数对照实验（⑨）。
 *
 * 这个模块存在的唯一目的，是让"算法准不准"变成可复核的记录，而不是一句感觉。
 *
 * 三条纪律（任何改动不得放松）：
 *   1. 人工计数是**真值**（ground truth），算法步数是**预测**（prediction）。
 *      字段名必须分开写：manual_steps / algorithm_steps，永远不合并成 "steps"。
 *   2. 百分比误差的分母是真值，不是预测值。用预测值当分母会在少计时
 *      把误差算小（算出来 2%，实际 50%），是最常见的自欺方式。
 *   3. 回合结束即冻结算法步数。之后算法再回溯补计，也不改已完成的回合——
 *      否则同一份数据每看一次误差都不一样。
 *
 * 本模块不读时钟、不碰 DOM：时间由调用方传入，便于单测构造确定性回合。
 */

export const EXPERIMENT_SCHEMA = "core-motion-cadence-lab/web-lab/experiments";
export const EXPERIMENT_SCHEMA_VERSION = "1.0";

export const MotionType = Object.freeze({
  WALK: "walk",
  MARCH: "march",
  RUN: "run",
  OTHER: "other",
});

export const Posture = Object.freeze({
  HAND: "hand",
  POCKET: "pocket",
  ARMBAND: "armband",
  OTHER: "other",
});

export const MOTION_TYPE_LABEL = Object.freeze({
  walk: "步行",
  march: "原地踏步",
  run: "跑步",
  other: "其他",
});

export const POSTURE_LABEL = Object.freeze({
  hand: "手持（屏幕朝上）",
  pocket: "口袋",
  armband: "臂包",
  other: "其他",
});

export class ExperimentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExperimentError";
  }
}

function assertNonNegativeInt(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ExperimentError(`${name} 必须是 >= 0 的整数，收到 ${JSON.stringify(value)}`);
  }
}

/**
 * 计算人工真值与算法预测的偏差。
 *
 * 符号约定：error_steps = algorithm − manual。
 *   正数 = 多计（净误检），负数 = 少计（净漏检）。
 * 注意这只是**净额**：多计 3 步同时漏计 3 步，净误差是 0。
 * 想分离误检与漏检必须逐拍标注，本实验做不到，报告里不得声称能分离。
 *
 * @param {number} manualSteps 人工计数（真值）
 * @param {number} algorithmSteps 算法检测步数（预测）
 */
export function computeStepError(manualSteps, algorithmSteps) {
  assertNonNegativeInt(manualSteps, "manual_steps");
  assertNonNegativeInt(algorithmSteps, "algorithm_steps");

  const error = algorithmSteps - manualSteps;
  const absError = Math.abs(error);
  const pct = manualSteps > 0 ? (absError / manualSteps) * 100 : null;
  return {
    manual_steps: manualSteps,
    algorithm_steps: algorithmSteps,
    error_steps: error,
    abs_error_steps: absError,
    // 真值为 0 时百分比无定义——返回 null，不返回 0，也不返回 Infinity。
    abs_error_pct: pct === null ? null : Math.round(pct * 100) / 100,
    direction: error > 0 ? "over" : error < 0 ? "under" : "exact",
  };
}

/** 一轮实验：开始 → 结束 → 填人工数 → 冻结。 */
export class ExperimentLog {
  /**
   * @param {object} opts
   * @param {string} opts.sessionId 与导出物一致的 web- 前缀会话号
   * @param {string} opts.source "REAL" | "MOCK"
   * @param {string} opts.sensor "devicemotion" | "synth"
   * @param {string} opts.paramsVersion 算法参数版本
   */
  constructor(opts = {}) {
    this.sessionId = opts.sessionId ?? null;
    this.source = opts.source ?? null;
    this.sensor = opts.sensor ?? null;
    this.paramsVersion = opts.paramsVersion ?? null;
    this.rounds = [];
    this._open = null;
    this._seq = 0;
  }

  get isOpen() {
    return this._open !== null;
  }

  get openRound() {
    return this._open;
  }

  /** 开始一轮。重复调用会丢弃上一轮未提交的计时（不产生半条记录）。 */
  begin(nowMs, meta = {}) {
    if (!Number.isFinite(nowMs)) throw new ExperimentError("begin 需要有效的单调时钟");
    this._seq += 1;
    this._open = {
      round_id: `R${String(this._seq).padStart(2, "0")}`,
      started_at_ms: Math.round(nowMs),
      started_at_wall: meta.wallIso ?? new Date().toISOString(),
      motion_type: meta.motionType ?? MotionType.WALK,
      posture: meta.posture ?? Posture.HAND,
      target_spm: Number.isFinite(meta.targetSpm) ? meta.targetSpm : null,
      notes: meta.notes ? String(meta.notes).slice(0, 200) : "",
      // 会话信息随回合一起冻结：采集中途换过数据源时，回合仍能标对来源，
      // 不会因为导出时读的是"当前来源"而把 MOCK 回合标成 REAL。
      session_id: meta.sessionId ?? this.sessionId,
      source: meta.source ?? this.source,
      sensor: meta.sensor ?? this.sensor,
      params_version: meta.paramsVersion ?? this.paramsVersion,
    };
    return this._open;
  }

  /**
   * 结束计时并冻结算法步数。
   *
   * @param {number} nowMs
   * @param {object} captured 回合结束瞬间的算法快照
   * @param {number} captured.algorithmSteps 该时间段内已计步数（由调用方用
   *   StepDetector.stepsBetween(start, end) 取得）
   * @param {object} [captured.diagnostics] 数据质量快照
   */
  end(nowMs, captured = {}) {
    if (!this._open) throw new ExperimentError("当前没有进行中的回合");
    if (!Number.isFinite(nowMs)) throw new ExperimentError("end 需要有效的单调时钟");
    if (nowMs < this._open.started_at_ms) {
      throw new ExperimentError("结束时间早于开始时间");
    }
    const algorithmSteps = captured.algorithmSteps;
    assertNonNegativeInt(algorithmSteps, "algorithm_steps");

    const finished = {
      ...this._open,
      ended_at_ms: Math.round(nowMs),
      duration_ms: Math.round(nowMs - this._open.started_at_ms),
      algorithm_steps: algorithmSteps,
      frozen_at_ms: Math.round(nowMs),
      // 冻结后即使算法再回溯补计，本回合仍以这个数为准
      algorithm_steps_frozen: true,
      diagnostics: captured.diagnostics ?? null,
      manual_steps: null,
      error_steps: null,
      abs_error_steps: null,
      abs_error_pct: null,
      direction: null,
      committed: false,
    };
    this._open = finished;
    return finished;
  }

  /**
   * 提交人工计数并落库。
   * @param {number} manualSteps
   */
  commitManual(manualSteps) {
    if (!this._open || !this._open.ended_at_ms) {
      throw new ExperimentError("必须先结束回合，才能填人工计数");
    }
    const err = computeStepError(manualSteps, this._open.algorithm_steps);
    const round = {
      ...this._open,
      ...err,
      session_id: this._open.session_id ?? this.sessionId,
      source: this._open.source ?? this.source,
      sensor: this._open.sensor ?? this.sensor,
      params_version: this._open.params_version ?? this.paramsVersion,
      committed: true,
      committed_at_wall: new Date().toISOString(),
    };
    this.rounds.push(round);
    this._open = null;
    return round;
  }

  /** 放弃当前回合（不会留下半条记录）。 */
  cancel() {
    this._open = null;
  }

  reset() {
    this.rounds = [];
    this._open = null;
    this._seq = 0;
  }

  /** 汇总：平均绝对百分比误差只在有人工数 > 0 的回合上算。 */
  summary() {
    const rounds = this.rounds;
    const n = rounds.length;
    if (!n) {
      return {
        rounds: 0,
        manual_steps_total: 0,
        algorithm_steps_total: 0,
        abs_error_total: 0,
        mean_abs_error_pct: null,
        max_abs_error_pct: null,
        over_count: 0,
        under_count: 0,
        exact_count: 0,
        note: "尚无已提交的回合",
      };
    }
    const withPct = rounds.filter((r) => r.abs_error_pct !== null);
    const meanPct = withPct.length
      ? withPct.reduce((a, r) => a + r.abs_error_pct, 0) / withPct.length
      : null;
    const maxPct = withPct.length
      ? Math.max(...withPct.map((r) => r.abs_error_pct))
      : null;
    return {
      rounds: n,
      manual_steps_total: rounds.reduce((a, r) => a + r.manual_steps, 0),
      algorithm_steps_total: rounds.reduce((a, r) => a + r.algorithm_steps, 0),
      abs_error_total: rounds.reduce((a, r) => a + r.abs_error_steps, 0),
      mean_abs_error_pct: meanPct === null ? null : Math.round(meanPct * 100) / 100,
      max_abs_error_pct: maxPct === null ? null : Math.round(maxPct * 100) / 100,
      over_count: rounds.filter((r) => r.direction === "over").length,
      under_count: rounds.filter((r) => r.direction === "under").length,
      exact_count: rounds.filter((r) => r.direction === "exact").length,
      note:
        "误差是净额（algorithm − manual）。净误差为 0 不代表没有误检与漏检，" +
        "只代表二者相互抵消；本实验不含逐拍标注，不能分离二者。",
    };
  }
}

/** 实验 CSV 列顺序。改这里必须同步改 buildExperimentCsv 与单测。 */
export const EXPERIMENT_CSV_HEADER = Object.freeze([
  "round_id",
  "session_id",
  "source",
  "sensor",
  "started_at_wall",
  "duration_s",
  "manual_steps",
  "algorithm_steps",
  "error_steps",
  "abs_error_steps",
  "abs_error_pct",
  "direction",
  "motion_type",
  "posture",
  "target_spm",
  "confidence",
  "coverage_pct",
  "gap_count",
  "params_version",
  "notes",
]);

function cell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 实验记录 CSV。带 UTF-8 BOM + CRLF，Excel 双击不乱码。 */
export function buildExperimentCsv(rounds) {
  const lines = [EXPERIMENT_CSV_HEADER.join(",")];
  for (const r of rounds || []) {
    const d = r.diagnostics || {};
    lines.push(
      [
        r.round_id,
        r.session_id,
        r.source,
        r.sensor,
        r.started_at_wall,
        (r.duration_ms / 1000).toFixed(2),
        r.manual_steps,
        r.algorithm_steps,
        r.error_steps,
        r.abs_error_steps,
        r.abs_error_pct === null ? "" : r.abs_error_pct,
        r.direction,
        r.motion_type,
        r.posture,
        r.target_spm,
        d.confidence ?? "",
        d.coveragePct ?? "",
        d.gapCount ?? "",
        r.params_version,
        r.notes,
      ]
        .map(cell)
        .join(",")
    );
  }
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}
