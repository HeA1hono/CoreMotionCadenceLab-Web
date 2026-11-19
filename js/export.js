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
  formatCsvValue,
} from "./contract.js";

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
export const DIAG_SCHEMA_VERSION = "1.0";

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
 * 生成诊断 JSON —— 环境自检、权限结果、到达频率统计、中断记录的完整快照。
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
  } = payload;

  assertSourcePair(source, sensor);

  return {
    schema: DIAG_SCHEMA,
    schema_version: DIAG_SCHEMA_VERSION,
    generated_at: new Date(generatedAt ?? Date.now()).toISOString(),
    app_version: appVersion ?? "0.1.0",
    phase: "E-W1",

    session_id: sessionId,
    file_source: "WEB",
    source,
    sensor,
    is_synthetic: source === SourceLabel.MOCK,
    note: WEB_SOURCE_NOTE,

    what_this_is: [
      "iOS Safari DeviceMotionEvent 派发的原始加速度事件流（当 source=REAL）",
      "或本地合成的测试信号（当 source=MOCK，仅供链路自测）",
      "事件到达频率、间隔抖动与中断时段的统计",
      "采集时浏览器环境的自检结论",
    ],
    what_this_is_not: [
      "不是 Core Motion（CMPedometer）的输出",
      "不含 numberOfSteps / currentCadence / distance / pace",
      "不含 17 字段契约样本：步频算法尚未实现（计划 E-W3）",
      "不含任何上传到第三方的痕迹：全部数据只在页面内生成，导出即下载",
    ],

    contract: {
      version: CONTRACT_VERSION,
      source_enum: [CadenceSource.REAL, CadenceSource.MOCK],
      sample_field_count: SAMPLE_FIELDS.length,
      csv_column_count: CSV_HEADER.length,
      sample_output_pending: true,
      pending_reason:
        "步频估算算法在 E-W3 实现；本阶段不产出 17 字段样本，避免伪造 cadence 值。",
    },

    environment: environment ?? null,
    permission: permission ?? null,
    stats: stats ?? null,
    visibility_log: visibilityLog ?? [],
    network: network ?? { calls: 0, log: [], note: "未统计" },
  };
}

/**
 * 文件名拼装：`<kind>_<stamp>_WEB_<REAL|MOCK>.<ext>`
 * 把 REAL / MOCK 写进文件名，是为了让文件在文件管理器里就能一眼分辨，
 * 不需要打开看内容。
 */
export function buildFilename(kind, stamp, source) {
  if (source !== SourceLabel.REAL && source !== SourceLabel.MOCK) {
    throw new Error(`buildFilename 需要 source=REAL|MOCK，收到 ${JSON.stringify(source)}`);
  }
  const safeKind = kind === "raw" ? "raw" : "diag";
  const ext = kind === "raw" ? "csv" : "json";
  return `${safeKind}_${stamp}_WEB_${source}.${ext}`;
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
