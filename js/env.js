/**
 * 环境自检 —— 把 Safari 权限链路的每一道门槛变成可观测的显式结论。
 *
 * 为什么需要它：iOS 上事件不触发时**不会报错**，只会静默无声。
 * 五道门槛里任何一道不满足，表现都是"页面一片安静"，
 * 无法从现象反推原因。所以必须在采集之前逐条探测并显示。
 *
 * 本模块是纯函数：接受注入的 window 对象，不直接读全局。
 * 这样 Node 单元测试可以伪造 iOS Safari / 桌面浏览器 / iframe 等各种环境。
 */

export const Severity = Object.freeze({
  OK: "OK",
  WARN: "WARN",
  FAIL: "FAIL",
  INFO: "INFO",
  PENDING: "PENDING",
});

/** 安全上下文的三种来源形态 */
export const OriginKind = Object.freeze({
  HTTPS: "https",
  LOCALHOST: "localhost",
  LAN_HTTP: "lan-http",
  FILE: "file",
  OTHER: "other",
});

function safeNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** 判定页面来源形态。localhost 例外是规范明确允许的。 */
export function classifyOrigin(win) {
  const loc = (win && win.location) || {};
  const protocol = String(loc.protocol || "");
  const hostname = String(loc.hostname || "");
  if (protocol === "https:") return OriginKind.HTTPS;
  if (protocol === "file:") return OriginKind.FILE;
  if (protocol === "http:") {
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
      return OriginKind.LOCALHOST;
    }
    return OriginKind.LAN_HTTP;
  }
  return OriginKind.OTHER;
}

/** 平台判定：iPadOS 的桌面版 UA 伪装成 Macintosh，靠触摸点数区分。 */
export function detectPlatform(win) {
  const nav = (win && win.navigator) || {};
  const ua = String(nav.userAgent || "");
  const maxTouch = safeNumber(nav.maxTouchPoints) ? nav.maxTouchPoints : 0;

  if (/iPhone|iPod/i.test(ua)) return { id: "ios-phone", label: "iPhone / iPod touch" };
  if (/iPad/i.test(ua)) return { id: "ipados", label: "iPad" };
  if (/Macintosh/i.test(ua) && maxTouch > 1) {
    return { id: "ipados", label: "iPad（桌面版 UA）" };
  }
  if (/Android/i.test(ua)) return { id: "android", label: "Android" };
  if (/Windows/i.test(ua)) return { id: "windows", label: "Windows 桌面" };
  if (/Macintosh|Mac OS X/i.test(ua)) return { id: "macos", label: "macOS 桌面" };
  if (/Linux/i.test(ua)) return { id: "linux", label: "Linux 桌面" };
  return { id: "unknown", label: "未识别" };
}

/**
 * 执行全部静态检查。
 * @param {object} win 注入的 window（默认 globalThis）
 * @returns {{checks: Array, summary: object, canRequest: boolean, platform: object, origin: string}}
 */
export function probeEnvironment(win = globalThis) {
  const checks = [];
  const add = (id, label, severity, detail, hint) => {
    checks.push({ id, label, severity, detail, hint: hint || null });
  };

  const origin = classifyOrigin(win);
  const platform = detectPlatform(win);
  const nav = (win && win.navigator) || {};
  const loc = (win && win.location) || {};
  const DME = win ? win.DeviceMotionEvent : undefined;

  // ENV-01 安全上下文
  const secure = win ? win.isSecureContext === true : false;
  if (secure) {
    add("ENV-01", "安全上下文", Severity.OK, "isSecureContext = true");
  } else {
    add(
      "ENV-01",
      "安全上下文",
      Severity.FAIL,
      "isSecureContext = false",
      origin === OriginKind.LAN_HTTP
        ? "当前是局域网 HTTP。Safari 只在 HTTPS 或 localhost 下派发 devicemotion 事件，且不会报错。必须改用 HTTPS 来源。"
        : origin === OriginKind.FILE
          ? "file:// 打开不是安全上下文。必须经 HTTP(S) 服务访问。"
          : "需要 HTTPS（localhost 例外）。"
    );
  }

  // ENV-02 页面来源
  add(
    "ENV-02",
    "页面来源",
    Severity.INFO,
    `${loc.protocol || "?"}//${loc.host || "?"}`,
    origin === OriginKind.LOCALHOST
      ? "localhost 被视为安全上下文，但 iPhone 无法用它访问电脑，仅适合 Windows 本机开发。"
      : null
  );

  // ENV-03 DeviceMotionEvent 存在性
  const hasDME = typeof DME !== "undefined" && DME !== null;
  if (hasDME) {
    add("ENV-03", "DeviceMotionEvent", Severity.OK, "接口存在");
  } else {
    add(
      "ENV-03",
      "DeviceMotionEvent",
      Severity.FAIL,
      "接口不存在",
      "该浏览器不提供运动传感器 API。iOS 上必须用 Safari，且系统不能禁用运动与方向访问。"
    );
  }

  // ENV-04 requestPermission 存在性
  const hasRequestPermission =
    hasDME && typeof DME.requestPermission === "function";
  if (hasRequestPermission) {
    add("ENV-04", "requestPermission()", Severity.OK, "需要显式授权（iOS 13+）");
  } else if (hasDME) {
    add(
      "ENV-04",
      "requestPermission()",
      Severity.WARN,
      "不存在",
      "两种可能：① 桌面浏览器，本来就不需要授权也不会给真实数据；② iOS 版本过旧（<13）。"
    );
  } else {
    add("ENV-04", "requestPermission()", Severity.FAIL, "无法检测（接口缺失）");
  }

  // ENV-05 是否被嵌在 iframe 里 —— iOS 26 已知缺陷
  let inIframe = false;
  try {
    inIframe = Boolean(win.top) && win.top !== win.self;
  } catch (_err) {
    inIframe = true; // 跨源访问 top 抛错，说明确实在 iframe 内
  }
  if (inIframe) {
    add(
      "ENV-05",
      "顶层窗口",
      Severity.FAIL,
      "页面被嵌在 iframe 内",
      "WebKit Bug 301294：iOS 26 中 iframe 内即使授权成功，devicemotion 事件也不会派发。必须顶层直接打开。"
    );
  } else {
    add("ENV-05", "顶层窗口", Severity.OK, "顶层加载（非 iframe）");
  }

  // ENV-06 平台
  const desktopLike = ["windows", "macos", "linux"].includes(platform.id);
  add(
    "ENV-06",
    "运行平台",
    desktopLike ? Severity.WARN : Severity.INFO,
    platform.label,
    desktopLike
      ? "桌面浏览器的 devicemotion 不会给出真实传感器数据（通常全 0 或 null）。请用 iPhone Safari 打开本页。"
      : null
  );

  // ENV-07 页面可见性
  const doc = (win && win.document) || {};
  const visibility = String(doc.visibilityState || "unknown");
  add(
    "ENV-07",
    "页面可见性",
    visibility === "visible" ? Severity.OK : Severity.WARN,
    visibility,
    visibility === "visible"
      ? null
      : "页面在后台时 iOS 会挂起事件派发。采集期间必须保持页面在前台、屏幕不锁定。"
  );

  // ENV-08 触摸能力（辅助判断是否移动端）
  const maxTouch = safeNumber(nav.maxTouchPoints) ? nav.maxTouchPoints : 0;
  add(
    "ENV-08",
    "触摸点数",
    Severity.INFO,
    `maxTouchPoints = ${maxTouch}`
  );

  // ENV-09 相邻 API：DeviceOrientationEvent
  const hasDOE = win ? typeof win.DeviceOrientationEvent !== "undefined" : false;
  add(
    "ENV-09",
    "DeviceOrientationEvent",
    hasDOE ? Severity.OK : Severity.INFO,
    hasDOE ? "接口存在" : "接口不存在",
    "本实验不使用该 API，仅用于判断 WebKit 传感器栈是否整体可用。"
  );

  // ENV-10 高精度时钟
  const hasPerf =
    win && win.performance && typeof win.performance.now === "function";
  add(
    "ENV-10",
    "performance.now()",
    hasPerf ? Severity.OK : Severity.FAIL,
    hasPerf ? "可用（单调时钟）" : "不可用",
    hasPerf
      ? "事件间隔一律用单调时钟计算，不用 Date.now()，避免系统时间调整造成负间隔。"
      : "缺少单调时钟会导致间隔计算不可靠。"
  );

  // ENV-11 是否支持 Web Crypto（session_id 生成用）
  const hasCrypto =
    win && win.crypto && typeof win.crypto.randomUUID === "function";
  add(
    "ENV-11",
    "crypto.randomUUID()",
    hasCrypto ? Severity.OK : Severity.WARN,
    hasCrypto ? "可用" : "不可用（回退到 Math.random 实现）",
    hasCrypto ? null : "session_id 仍能生成，但唯一性保证较弱，仅影响会话区分。"
  );

  const count = (sev) => checks.filter((c) => c.severity === sev).length;
  const summary = {
    ok: count(Severity.OK),
    warn: count(Severity.WARN),
    fail: count(Severity.FAIL),
    info: count(Severity.INFO),
    total: checks.length,
  };

  return {
    checks,
    summary,
    origin,
    platform,
    secureContext: secure,
    hasDeviceMotion: hasDME,
    hasRequestPermission,
    inIframe,
    canRequest: hasDME && hasRequestPermission && secure,
    blockedReason: deriveBlockedReason({
      secure,
      hasDME,
      hasRequestPermission,
      inIframe,
      origin,
    }),
  };
}

/** 给出"为什么现在还不能请求权限"的唯一原因，供 UI 直接显示。 */
export function deriveBlockedReason(flags) {
  if (!flags.secure) {
    return flags.origin === OriginKind.LAN_HTTP
      ? "非安全上下文：局域网 HTTP 下 Safari 不派发传感器事件，也不弹授权框。需改用 HTTPS 来源。"
      : "非安全上下文：需要 HTTPS（localhost 例外）。";
  }
  if (!flags.hasDME) {
    return "当前浏览器不提供 DeviceMotionEvent 接口。iOS 上请使用 Safari。";
  }
  if (flags.inIframe) {
    return "页面在 iframe 内。iOS 26 存在 iframe 内事件不派发的已知缺陷，请顶层直接打开。";
  }
  if (!flags.hasRequestPermission) {
    return "该浏览器没有 requestPermission()，通常说明它不是 iOS Safari（桌面浏览器不会给出真实数据）。";
  }
  return null;
}

/** 给 UI 用的一句话总判定。 */
export function summarizeVerdict(report) {
  if (report.summary.fail > 0) {
    return { level: "FAIL", text: `有 ${report.summary.fail} 项检查未通过，无法采集真实数据` };
  }
  if (report.summary.warn > 0) {
    return { level: "WARN", text: `有 ${report.summary.warn} 项需要注意` };
  }
  return { level: "OK", text: "环境检查全部通过，可以请求运动权限" };
}
