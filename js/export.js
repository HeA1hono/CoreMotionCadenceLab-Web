/**
 * 导出：原始事件 CSV + 诊断 JSON。
 *
 * 诚实性要求（硬约束，任何改动不得放松）：
 *   1. 文件名一律带 `_WEB_<REAL|MOCK>`；session_id 一律带 `web-` 前缀；
 *   2. CSV 每行写明 source（REAL/MOCK）与 sensor（devicemotion/synth），
 *      文件离开本页也无法被误认为 Core Motion 原生输出；
 *   3. 诊断 JSON 显式声明"这是什么、不是什么"；
 *   4. E-W1 不产出 17 字段契约样本 —— 步频算法在 E-W3 才实现，
 *      此处若伪造 cadence 字段即为冒充，明确拒绝。
 *
 * 关于 source 的取值：
 *   直接沿用冻结契约里 CadenceSource 的两个值 REAL / MOCK，不另造词。
 *   REAL 表示"来自设备真实传感器"，MOCK 表示"本地合成的测试信号"。
 *   两者绝不允许混用，故本模块对传入值做**强制校验并抛错**，
 *   而不是给个默认值——默认值正是误标最容易发生的地方。
 */

import {
  CONTRACT_VERSION,
  SAMPLE_FIELDS,
  CSV_HEADER,
  WEB_SOURCE_NOTE,
  CadenceSource,
  ContractViolation,
  assertValid,
  validateSequence,
  formatCsvValue,
  sampleToCsvLine,
} from "./contract.js";

import {
  EXPERIMENT_SCHEMA,
  EXPERIMENT_SCHEMA_VERSION,
} from "./experiment.js";

/** 与契约 CadenceSource 对齐的两个取值 */
export const SourceLabel = Object.freeze({
  REAL: "REAL",
  MOCK: "MOCK",
});

/** 产生数据的实际通道，比 source 更细一层 */
export const SensorKind = Object.freeze({
  DEVICEMOTION: "devicemotion",
  SYNTH: "synth",
});

export const RAW_CSV_HEADER = Object.freeze([
  "seq",
  "t_mono_ms",
  "t_wall",
  "agx",
  "agy",
  "agz",
  "ax",
  "ay",
  "az",
  "rot_alpha",
  "rot_beta",
  "rot_gamma",
  "interval_ms",
  "source",
  "sensor",
]);

export const DIAG_SCHEMA = "core-motion-cadence-lab/web-lab/diagnostics";
export const DIAG_SCHEMA_VERSION = "1.3";

/**
 * 逐峰事件日志 CSV。
 *
 * 为什么要单独导出这一份：诊断 JSON 只放汇总，无法复核"第 137 个峰为什么被拒"。
 * 准确率验证需要的是每一个候选峰的时间、幅值、阈值、突出度和拒绝原因。
 */
export const STEP_EVENTS_CSV_HEADER = Object.freeze([
  "seq",
  "kind",
  "t_mono_ms",
  "t_rel_ms",
  "t_wall",
  "step_index",
  "value_ms2",
  "threshold_ms2",
  "prominence_ms2",
  "interval_ms",
  "counted",
  "reason",
  "source",
  "sensor",
]);

export const STEP_EVENTS_CSV_VERSION = "1.0";

/**
 * 原始波形 CSV 的版本。
 * 1.0：interval_ms 列实际写的是秒（E-W1 的缺陷）
 * 1.1：interval_ms 真正是毫秒
 * 这个版本号存在的唯一目的，是让别人拿到一个旧文件时能判断该不该信那一列。
 */
export const RAW_CSV_VERSION = "1.1";

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 生成 20261119_231500 形式的时间戳，用于文件名。 */
export function formatStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

/**
 * 校验 source / sensor 组合是否自洽。
 * REAL 只能配 devicemotion，MOCK 只能配 synth，其余一律抛错。
 */
export function assertSourcePair(source, sensor) {
  if (source !== SourceLabel.REAL && source !== SourceLabel.MOCK) {
    throw new Error(`source 必须是 REAL 或 MOCK，收到 ${JSON.stringify(source)}`);
  }
  if (sensor !== SensorKind.DEVICEMOTION && sensor !== SensorKind.SYNTH) {
    throw new Error(
      `sensor 必须是 devicemotion 或 synth，收到 ${JSON.stringify(sensor)}`
    );
  }
  if (source === SourceLabel.REAL && sensor !== SensorKind.DEVICEMOTION) {
    throw new Error("source=REAL 只能对应 sensor=devicemotion");
  }
  if (source === SourceLabel.MOCK && sensor !== SensorKind.SYNTH) {
    throw new Error("source=MOCK 只能对应 sensor=synth");
  }
}

/**
 * 生成原始事件 CSV。
 * 使用 UTF-8 BOM + CRLF，与阶段 C 的 write_csv 保持一致，
 * 保证 Excel 直接双击打开不乱码。
 *
 * @param {Array} events MotionMonitor 的事件快照
 * @param {object} meta { source: "REAL"|"MOCK", sensor: "devicemotion"|"synth", startWallMs }
 */
export function buildRawCsv(events, meta = {}) {
  const { source, sensor, startWallMs } = meta;
  assertSourcePair(source, sensor);

  const wall0 = startWallMs ?? Date.now();
  const t0 = events.length ? events[0].tMonoMs : 0;

  const lines = [RAW_CSV_HEADER.join(",")];
  events.forEach((ev, i) => {
    const wall = new Date(wall0 + (ev.tMonoMs - t0)).toISOString();
    const row = [
      String(i + 1),
      formatCsvValue(ev.tMonoMs),
      wall,
      formatCsvValue(ev.agx),
      formatCsvValue(ev.agy),
      formatCsvValue(ev.agz),
      formatCsvValue(ev.ax),
      formatCsvValue(ev.ay),
      formatCsvValue(ev.az),
      formatCsvValue(ev.alpha),
      formatCsvValue(ev.beta),
      formatCsvValue(ev.gamma),
      formatCsvValue(ev.intervalMs),
      source,
      sensor,
    ];
    lines.push(row.join(","));
  });

  return "\ufeff" + lines.join("\r\n") + "\r\n";
}

/**
 * 生成逐峰事件 CSV（含被拒候选）。
 *
 * kind=step 的是被采纳的峰（counted 可能为 0/1：采纳但节奏未确认时不计数）；
 * kind=reject 的是被四道闸门拒掉的候选，reason 写明是哪一道。
 * 两者放在同一份文件里，"误检/漏检"才有可能被逐条复盘。
 */
export function buildStepEventsCsv(events, meta = {}) {
  const { source, sensor, startWallMs } = meta;
  assertSourcePair(source, sensor);

  const list = events || [];
  const wall0 = startWallMs ?? Date.now();
  const t0 = list.length && Number.isFinite(list[0].t_ms) ? list[0].t_ms : 0;

  const lines = [STEP_EVENTS_CSV_HEADER.join(",")];
  list.forEach((ev, i) => {
    const t = Number.isFinite(ev.t_ms) ? ev.t_ms : null;
    const wall = t === null ? "" : new Date(wall0 + (t - t0)).toISOString();
    lines.push(
      [
        String(i + 1),
        ev.kind === "step" ? "step" : "reject",
        formatCsvValue(t),
        formatCsvValue(t === null ? null : t - t0),
        wall,
        formatCsvValue(ev.step_index),
        formatCsvValue(ev.y),
        formatCsvValue(ev.threshold),
        formatCsvValue(ev.prominence),
        formatCsvValue(ev.interval_ms),
        ev.counted ? "1" : "0",
        ev.reason ?? "",
        source,
        sensor,
      ].join(",")
    );
  });
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}

/**
 * 生成 17 字段契约样本 CSV（16 列，contract_version 不入 CSV）。
 *
 * 导出前**逐条跑契约校验**：单样本不变量 + 跨样本 INV-5。
 * 任何一条不通过就抛错、不生成文件——宁可没有文件，也不给一份"看起来合规"的。
 *
 * 这些样本的 cadence 是网页算法推导值（derived），不是 CMPedometer 的
 * currentCadence；numberOfSteps 同理。字段名沿用契约是为了可比对，
 * 不代表数据来源相同，出处写在 note 与诊断 JSON 里。
 */
export function buildContractSamplesCsv(samples) {
  const list = samples || [];
  list.forEach((s, i) => {
    try {
      assertValid(s);
    } catch (err) {
      throw new ContractViolation(`第 ${i + 1} 条样本不合契约：${err.message}`);
    }
  });
  const seqErrors = validateSequence(list);
  if (seqErrors.length) {
    throw new ContractViolation(`INV-5 不通过：${seqErrors.slice(0, 3).join("; ")}`);
  }
  const lines = [CSV_HEADER.join(",")];
  for (const s of list) lines.push(sampleToCsvLine(s));
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}

/**
 * 实验记录 JSON —— 每一轮的人工真值、算法预测、误差、条件与参数版本。
 */
export function buildExperimentJson(payload) {
  const {
    rounds,
    summary,
    params,
    sessionId,
    source,
    sensor,
    generatedAt,
    appVersion,
    environment,
    calibration,
  } = payload;

  assertSourcePair(source, sensor);

  return {
    schema: EXPERIMENT_SCHEMA,
    schema_version: EXPERIMENT_SCHEMA_VERSION,
    generated_at: new Date(generatedAt ?? Date.now()).toISOString(),
    app_version: appVersion ?? "0.3.0",
    phase: "E-W3",

    session_id: sessionId,
    // 回合可能跨越多次采集（每次采集换 session_id），所以另外给出全集，
    // 免得读者以为所有回合都属于 session_id 这一条。
    session_ids: payload.sessionIds ?? (sessionId ? [sessionId] : []),
    file_source: "WEB",
    source,
    sensor,
    is_synthetic: source === SourceLabel.MOCK,
    note: WEB_SOURCE_NOTE,

    ground_truth_vs_prediction: {
      manual_steps: "人工计数，作为真值（ground truth）",
      algorithm_steps: "网页算法检测，作为预测（prediction）",
      error_steps: "algorithm_steps − manual_steps，正数=多计，负数=少计",
      abs_error_pct: "|error| ÷ manual_steps × 100，分母是真值",
      caveat: "净误差不能分离误检与漏检；净误差为 0 也可能二者相互抵消",
    },

    params: params ?? null,
    summary: summary ?? null,
    rounds: rounds ?? [],
    environment: environment ?? null,
    calibration: calibration ?? null,
    what_this_is_not: [
      "不是 CMPedometer 输出",
      "不是逐拍标注的真值数据集：人工计数只提供总数",
      "不包含任何上传痕迹：全部在浏览器内生成，导出即本地下载",
    ],
  };
}
/**
 * 生成诊断 JSON —— 环境自检、权限结果、频率统计、中断记录、E-W3 步态摘要。
 *
 * E-W3 起 `sample_output_pending` 变为 false，并且 what_this_is_not 必须写明
 * "步数是网页算法推导值"。这句话不是免责声明，是防止有人把这份文件当成
 * CMPedometer 的导出去做二次分析。
 */
export function buildDiagJson(payload) {
  const {
    sessionId,
    source,
    sensor,
    environment,
    permission,
    stats,
    visibilityLog,
    appVersion,
    generatedAt,
    network,
    calibration,
    ew3,
    contractSamples,
  } = payload;

  assertSourcePair(source, sensor);

  return {
    schema: DIAG_SCHEMA,
    schema_version: DIAG_SCHEMA_VERSION,
    generated_at: new Date(generatedAt ?? Date.now()).toISOString(),
    app_version: appVersion ?? "0.3.0",
    phase: "E-W3",

    session_id: sessionId,
    file_source: "WEB",
    source,
    sensor,
    is_synthetic: source === SourceLabel.MOCK,
    note: WEB_SOURCE_NOTE,

    what_this_is: [
      "iOS Safari DeviceMotionEvent 派发的原始加速度事件流（当 source=REAL）",
      "或本地合成的测试信号（当 source=MOCK，仅供链路自测）",
      "事件到达频率、间隔抖动、中断与停顿的统计",
      "基于上述加速度、在浏览器内推导的步数与步频（derived，非系统计步器）",
      "采集时浏览器环境的自检结论",
    ],
    what_this_is_not: [
      "不是 Core Motion（CMPedometer）的输出",
      "不含 numberOfSteps / currentCadence 的系统原值：本页步数由算法推导",
      "不含逐拍人工标注：人工计数只提供每轮总步数",
      "不含任何上传到第三方的痕迹：全部数据只在页面内生成，导出即下载",
    ],

    contract: {
      version: CONTRACT_VERSION,
      source_enum: [CadenceSource.REAL, CadenceSource.MOCK],
      sample_field_count: SAMPLE_FIELDS.length,
      csv_column_count: CSV_HEADER.length,
      sample_output_pending: false,
      sample_source: "derived_from_devicemotion",
      sample_note:
        "17 字段样本已产出，cadence 为网页算法推导值（derived）；" +
        "字段名沿用以便比对，不代表与 CMPedometer 同源。",
      sample_count: Array.isArray(contractSamples) ? contractSamples.length : 0,
    },

    raw_csv: {
      version: RAW_CSV_VERSION,
      column_count: RAW_CSV_HEADER.length,
      interval_unit: "ms",
      interval_unit_note:
        "DeviceMotionEvent.interval 按 W3C 规范以秒给出，已在此 ×1000 转成毫秒。" +
        "E-W1 的 1.0 版文件曾把秒直接写进 interval_ms 列，读取旧文件时需除以 1000。",
      calibration_applied: false,
      calibration_note: "CSV 恒为未校准的原始加速度；基线校准只影响屏幕显示。",
    },

    step_events_csv: {
      version: STEP_EVENTS_CSV_VERSION,
      column_count: STEP_EVENTS_CSV_HEADER.length,
      note: "kind=step 为采纳峰，kind=reject 为被拒候选；reason 写明拒绝闸门。",
    },

    ew3: ew3 ?? null,

    environment: environment ?? null,
    permission: permission ?? null,
    stats: stats ?? null,
    calibration: calibration ?? null,
    visibility_log: visibilityLog ?? [],
    network: network ?? { calls: 0, log: [], note: "未统计" },
  };
}

/**
 * 导出类型 → 文件名前缀与扩展名。
 * 未知类型直接抛错，不退回默认值——"猜一个"正是误标最容易发生的地方。
 */
export const FILE_KINDS = Object.freeze({
  raw: { prefix: "raw", ext: "csv" },
  diag: { prefix: "diag", ext: "json" },
  steps: { prefix: "steps", ext: "csv" },
  exp: { prefix: "exp", ext: "json" },
  expcsv: { prefix: "exp", ext: "csv" },
  samples: { prefix: "samples", ext: "csv" },
});

/**
 * 文件名拼装：`<kind>_<stamp>_WEB_<REAL|MOCK>.<ext>`
 * 把 REAL / MOCK 写进文件名，是为了让文件在文件管理器里就能一眼分辨，
 * 不需要打开看内容。
 */
export function buildFilename(kind, stamp, source) {
  if (source !== SourceLabel.REAL && source !== SourceLabel.MOCK) {
    throw new Error(`buildFilename 需要 source=REAL|MOCK，收到 ${JSON.stringify(source)}`);
  }
  const spec = FILE_KINDS[kind];
  if (!spec) {
    throw new Error(`未知的导出类型: ${JSON.stringify(kind)}`);
  }
  return `${spec.prefix}_${stamp}_WEB_${source}.${spec.ext}`;
}

/** 触发浏览器下载。 */
export function downloadText(filename, text, mime) {
  if (typeof document === "undefined") {
    throw new Error("downloadText 只能在浏览器中调用");
  }
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * 尝试把文件存到本机开发服务器。
 *
 * **只在 localhost 下调用**：托管到公网静态站点时页面上没有任何后端，
 * 端点为空字符串即直接返回，不发出任何请求。这是本页在 GitHub Pages 上
 * 保持"零网络请求"的关键，改动前请先读 tools/audit_release.py 的断言。
 *
 * 失败不抛异常 —— 导出必须永远有本地下载这条兜底路径。
 */
export async function trySaveToDevServer(endpoint, filename, text, fetchImpl) {
  if (!endpoint) {
    return { ok: false, skipped: true, message: "当前不是本机开发环境，未发起任何网络请求" };
  }
  const f = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!f) return { ok: false, skipped: true, message: "环境无 fetch，已跳过" };
  try {
    const res = await f(`${endpoint}?name=${encodeURIComponent(filename)}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: text,
    });
    if (!res.ok) return { ok: false, message: `服务端返回 ${res.status}` };
    const data = await res.json();
    return {
      ok: true,
      message: data && data.path ? `已保存到本机：${data.path}` : "已保存到本机",
    };
  } catch (err) {
    return { ok: false, message: `本机保存失败：${String((err && err.message) || err)}` };
  }
}
