/**
 * GPS 数据源：真实定位（Geolocation API）与离线回放（GPX）。
 *
 * ## 两类来源的差别不是"精度"，而是"这条数据是怎么来的"
 *
 *   REAL_GPS —— `navigator.geolocation.watchPosition` 拿到的实测定位。
 *               每个点带 `Position.timestamp`（epoch 毫秒，位置确定时刻），
 *               但**没有**速度保证：`coords.speed` 在 iOS 上经常是 null。
 *
 *   REPLAY   —— 从 GPX 文件按时间线播出来的点。**它不是测量**。
 *               更麻烦的是：本仓库可用的 GPX 全部由跑道几何参数生成
 *               （见 E:\虚拟定位工具\tracks\*.gpx 的 <desc>），
 *               连"某次真实跑步的记录"都不是。因此回放数据必须同时携带
 *               `origin=REPLAY` 与 `provenance`，后者说明"这个 GPX 自己是哪来的"。
 *
 * ## 不做的事
 *
 *   - 不把 GPX 回放冒充真实定位（origin 字段是硬标记，导出的每一行都带）；
 *   - 不把 GPS 配速换算成步数（见 alignment.js 的注释：那会造出假步数）；
 *   - 不向系统定位服务写入任何东西——本模块只读 `watchPosition`。
 */

/** 数据来源。这是导出与界面上的**第一分类**，不允许被省略或合并。 */
export const GpsOrigin = Object.freeze({
  REAL: "REAL_GPS",
  REPLAY: "REPLAY",
  NONE: "NONE",
});

/**
 * GPX 文件自身的来历。`origin=REPLAY` 只说明"这是回放"，
 * 不说明"回放的内容是真实轨迹"。两者必须分开。
 */
export const GpxProvenance = Object.freeze({
  /** 由几何/参数生成，不对应任何一次真实运动 */
  SYNTHETIC_GEOMETRY: "synthetic_geometry",
  /** 某次真实运动的记录 */
  RECORDED: "recorded",
  /** 无法判断。默认值——**不默认成 recorded** */
  UNKNOWN: "unknown",
});

export const GpsState = Object.freeze({
  IDLE: "IDLE",
  REQUESTING: "REQUESTING",
  WATCHING: "WATCHING",
  DENIED: "DENIED",
  UNAVAILABLE: "UNAVAILABLE",
  TIMEOUT: "TIMEOUT",
  ERROR: "ERROR",
  STOPPED: "STOPPED",
});

const EARTH_RADIUS_M = 6371008.8;

/** 度 → 弧度 */
function rad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * 两点间大圆距离（米）。
 *
 * 用 haversine 而不是平面近似：本项目在湘潭（纬度 27.9°），1 度经度约 98 km，
 * 400 m 跑道范围内平面近似误差在厘米级、够用；但一旦回放跨校区轨迹，
 * 平面近似会随距离线性跑偏。haversine 的代价只是两个 sin，不值得省。
 */
export function haversineM(a, b) {
  if (!a || !b) return null;
  const lat1 = Number(a.lat);
  const lon1 = Number(a.lon);
  const lat2 = Number(b.lat);
  const lon2 = Number(b.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** 米/秒 → 秒/公里（配速）。速度 ≤ 0 时返回 null，不返回 Infinity。 */
export function speedToPaceSecPerKm(mps) {
  if (!Number.isFinite(mps) || mps <= 0) return null;
  return 1000 / mps;
}

/** 秒/公里 → "5:00" 形式。 */
export function formatPace(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return "—";
  const total = Math.round(secPerKm);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- GPX 解析

/**
 * 宽松的 GPX 解析。
 *
 * 为什么手写而不用 DOMParser：Node 里没有 DOMParser，而这段逻辑必须能被单测
 * 直接覆盖（回放的时间线、缺 time 的兜底、命名空间差异都是会出错的地方）。
 * 手写解析只支持一个结构：`<trk><trkseg><trkpt lat lon>`——与
 * `E:\虚拟定位工具\README.md` 第 8 节记录的支持范围一致，其余结构显式报错，
 * 不做"猜一个"的兜底。
 *
 * 时间格式按同一份文档的说明放宽：允许空格代替 `T`、允许非补零、
 * 允许 `Z` 或 `±HH:MM`。
 *
 * @param {string} xmlText
 * @returns {{points: Array<{lat:number, lon:number, tEpochMs:number|null, ele:number|null, index:number}>,
 *            meta: {name:string|null, desc:string|null, timeText:string|null},
 *            hasTime: boolean}}
 */
export function parseGpx(xmlText) {
  if (typeof xmlText !== "string" || xmlText.length === 0) {
    throw new Error("GPX 内容为空");
  }
  if (/<rte[\s>]/i.test(xmlText) || /<rtept[\s>]/i.test(xmlText)) {
    // 官方解析器对 <rte> 静默返回 0 点，那种"看起来成功其实没数据"的行为必须避免
    throw new Error("不支持 <rte>/<rtept>：请用 <trk><trkseg><trkpt> 结构");
  }

  const metaName = matchTag(xmlText, "name");
  const metaDesc = matchTag(xmlText, "desc");
  const metaTime = matchTag(xmlText, "time", 0);

  const points = [];
  // 必须同时支持两种写法：
  //   成对  <trkpt lat=".." lon=".."><ele>0</ele><time>..</time></trkpt>
  //   自闭合 <trkpt lat=".." lon=".."/>
  // 真实设备导出的 GPX 两种都常见。只写成对形式会让自闭合文件静默返回 0 点，
  // 那正是本项目一直在避免的"看起来成功其实没数据"。
  const trkptRe = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/gi;
  let m;
  let index = 0;
  while ((m = trkptRe.exec(xmlText)) !== null) {
    const attrs = m[1] || "";
    const body = m[2] || "";
    // 注意 Number(null) === 0：缺 lat 属性时若直接把 readAttr 的返回值丢进 Number，
    // 这个点会变成"赤道上的一个点"，累计距离瞬间涨几千公里，而且不会有任何报错。
    // 必须先把"属性不存在"和"属性为 0"区分开。
    const latRaw = readAttr(attrs, "lat");
    const lonRaw = readAttr(attrs, "lon");
    const lat = latRaw === null ? NaN : Number(latRaw);
    const lon = lonRaw === null ? NaN : Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      index += 1;
      continue;
    }
    const timeText = matchTag(body, "time");
    const eleText = matchTag(body, "ele");
    points.push({
      index,
      lat,
      lon,
      tEpochMs: timeText === null ? null : parseGpxTime(timeText),
      ele: eleText === null ? null : Number(eleText),
    });
    index += 1;
  }

  if (points.length === 0) {
    throw new Error("GPX 里没有可用的 <trkpt>（需要 lat/lon 属性）");
  }

  return {
    points,
    meta: { name: metaName, desc: metaDesc, timeText: metaTime },
    hasTime: points.some((p) => p.tEpochMs !== null),
  };
}

function readAttr(attrs, name) {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i");
  const m = re.exec(attrs);
  if (m) return m[1];
  const re2 = new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i");
  const m2 = re2.exec(attrs);
  return m2 ? m2[1] : null;
}

/** 取第一个匹配的标签文本内容。`skip` 用于跳过 metadata 里的同名标签。 */
function matchTag(text, tag, skip = -1) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  let seen = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (seen < skip) {
      seen += 1;
      continue;
    }
    return m[1].trim();
  }
  return null;
}

/**
 * 解析 GPX 时间。返回 epoch 毫秒，失败返回 null（不抛——一个坏时间不该毁掉整条轨迹）。
 *
 * 支持：`2026-11-18T01:00:00Z`、`2026-11-18 01:00:00`、`2026-11-18T01:00:00.500+08:00`、
 * 非补零的 `2026-11-18T1:0:0Z`。
 */
export function parseGpxTime(text) {
  if (typeof text !== "string") return null;
  const s = text.trim();
  if (s === "") return null;

  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) {
    const fallback = Date.parse(s);
    return Number.isFinite(fallback) ? fallback : null;
  }
  const [, y, mo, d, h, mi, sec, frac, tz] = m;
  const ms = frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
  // 用 Date.UTC 构造"字面时间"，再减去时区偏移，避免依赖本机时区
  const base = Date.UTC(
    Number(y), Number(mo) - 1, Number(d),
    Number(h), Number(mi), Number(sec), ms,
  );
  let offsetMin = 0;
  if (tz && tz !== "Z") {
    const sign = tz[0] === "-" ? -1 : 1;
    const hh = Number(tz.slice(1, 3));
    const mm = Number(tz.slice(-2));
    offsetMin = sign * (hh * 60 + mm);
  }
  return base - offsetMin * 60000;
}

/**
 * 从 `<desc>` 猜 GPX 的来历。
 *
 * 只作**提示**，不作定论：真实来源必须由调用方显式声明（`provenance` 参数）。
 * 返回 `null` 表示"猜不出来"，调用方应落到 `UNKNOWN`。
 *
 * 为什么需要这个提示：本仓库能拿到的 GPX 全是几何生成的，但文件名
 * （`xtu2_5km_5min_pace.gpx`）看起来非常像一次真实跑步。若不定 provenance，
 * 导出物会被后来的人当成实测数据。
 */
export function guessProvenance(meta) {
  const text = `${(meta && meta.name) || ""} ${(meta && meta.desc) || ""}`.toLowerCase();
  if (text.trim() === "") return null;
  if (/synthetic|生成|派生|demo|test|模拟|参数化/.test(text)) {
    return GpxProvenance.SYNTHETIC_GEOMETRY;
  }
  if (/recorded|实测|实测轨迹|真实记录/.test(text)) {
    return GpxProvenance.RECORDED;
  }
  return null;
}

// ---------------------------------------------------------------- 真实 GPS

/**
 * 真实定位源。
 *
 * 【关键设计】`maximumAge` 默认 0。
 *   它允许浏览器直接返回缓存位置，是"看起来有数据、其实是几分钟前的点"的
 *   主要来源。E-W4 要研究 GPS 延迟，必须先把缓存这个混淆项关掉；
 *   若要研究缓存行为，把它设成非 0 并单独标注。
 *
 * 【权限】`getCurrentPosition`/`watchPosition` 在 Safari 上需要用户手势触发，
 *   与 DeviceMotion 同理。本模块不做任何预热请求。
 */
export class RealGpsSource {
  constructor(opts = {}) {
    this.win = opts.win ?? globalThis;
    this.onFix = opts.onFix ?? (() => {});
    this.onState = opts.onState ?? (() => {});
    this.onError = opts.onError ?? (() => {});
    this.state = GpsState.IDLE;
    this.origin = GpsOrigin.REAL;
    this.perfNow =
      opts.perfNow ??
      (() =>
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now());
    this.options = {
      enableHighAccuracy: opts.enableHighAccuracy ?? true,
      maximumAge: opts.maximumAge ?? 0,
      timeout: opts.timeout ?? 30000,
    };
    this._watchId = null;
    this._seq = 0;
  }

  _setState(s) {
    this.state = s;
    this.onState(s);
  }

  get supported() {
    return Boolean(this.win && this.win.navigator && this.win.navigator.geolocation);
  }

  start() {
    if (!this.supported) {
      this._setState(GpsState.UNAVAILABLE);
      return false;
    }
    if (this._watchId !== null) return true;

    this._setState(GpsState.REQUESTING);
    try {
      this._watchId = this.win.navigator.geolocation.watchPosition(
        (pos) => this._handlePosition(pos),
        (err) => this._handleError(err),
        this.options,
      );
    } catch (err) {
      this.onError(String((err && err.message) || err));
      this._setState(GpsState.ERROR);
      return false;
    }
    this._setState(GpsState.WATCHING);
    return true;
  }

  _handlePosition(pos) {
    // 收到时刻必须在最前面取：后面任何一步抛异常都不该让时间戳失真
    const arrivalPerfMs = this.perfNow();
    let fix;
    try {
      fix = normalizePosition(pos, arrivalPerfMs, this._seq);
    } catch (err) {
      this.onError(String((err && err.message) || err));
      return;
    }
    this._seq += 1;
    this.onFix(fix);
  }

  _handleError(err) {
    const code = err && typeof err.code === "number" ? err.code : 0;
    const map = {
      1: GpsState.DENIED,
      2: GpsState.UNAVAILABLE,
      3: GpsState.TIMEOUT,
    };
    this._setState(map[code] ?? GpsState.ERROR);
    this.onError({
      code,
      message: String((err && err.message) || "unknown"),
      state: map[code] ?? GpsState.ERROR,
    });
  }

  stop() {
    if (this._watchId !== null && this.supported) {
      try {
        this.win.navigator.geolocation.clearWatch(this._watchId);
      } catch {
        /* 清理失败不影响状态机 */
      }
    }
    this._watchId = null;
    if (this.state === GpsState.WATCHING || this.state === GpsState.REQUESTING) {
      this._setState(GpsState.STOPPED);
    }
  }
}

/**
 * 把 GeolocationPosition 归一化成内部 fix。
 *
 * `coords.speed` 与 `coords.heading` 在 iOS 上**经常是 null**（尤其精度差时）。
 * 这里原样保留，同时把"有没有这个字段"记下来：
 * 后续若用相邻点差分算速度，必须标成 `speed_source="derived"`，
 * 不能和 GPS 芯片自己报的速度混为一谈。
 */
export function normalizePosition(pos, arrivalPerfMs, seq = 0) {
  const c = (pos && pos.coords) || {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    seq,
    origin: GpsOrigin.REAL,
    provenance: null,
    tEpochMs: num(pos && pos.timestamp),
    tMonoMs: arrivalPerfMs,
    lat: num(c.latitude),
    lon: num(c.longitude),
    accuracyM: num(c.accuracy),
    altitudeM: num(c.altitude),
    altitudeAccuracyM: num(c.altitudeAccuracy),
    headingDeg: num(c.heading),
    speedMps: num(c.speed),
    speedSource: num(c.speed) === null ? null : "reported",
  };
}

// ---------------------------------------------------------------- GPX 回放

/**
 * GPX 回放源。
 *
 * 时间语义是本模块最容易出错的地方，说清楚：
 *   - GPX 里的 `<time>` 属于**文件作者那一侧的 epoch 域**，与本次会话的
 *     `performance.now()` 没有任何关系。所以回放时**不能**用 TimeBase 的锚点。
 *   - 回放自己维持一条时间线：`perfNow = perfStart + (fileEpoch − fileStart)/speed`。
 *   - 因此回放的"延迟"恒等于 0（是我们按点播出来的，不是测出来的）。
 *     导出时必须带 `origin=REPLAY`，否则这个 0 会被当成"GPS 性能极好"。
 *
 * 缺 `<time>` 的 GPX 按 `fallbackIntervalSec`（默认 1 秒）等距回放，
 * 并在 meta 里标 `time_synthesized=true`——那是**我们编的时间**，不是文件里的。
 */
export class ReplayGpsSource {
  /**
   * @param {object} opts
   * @param {object} opts.gpx parseGpx 的返回值
   * @param {number} [opts.speed] 回放倍速，1 = 按原速
   * @param {number} [opts.fallbackIntervalSec] 缺 time 时的点间隔
   * @param {string} [opts.provenance] 显式声明的 GPX 来历
   * @param {(fn:Function, ms:number)=>any} [opts.setTimeoutFn]
   * @param {() => number} [opts.perfNow]
   */
  constructor(opts = {}) {
    if (!opts.gpx || !Array.isArray(opts.gpx.points) || opts.gpx.points.length === 0) {
      throw new Error("ReplayGpsSource 需要非空的 parseGpx 结果");
    }
    this.gpx = opts.gpx;
    this.onFix = opts.onFix ?? (() => {});
    this.onState = opts.onState ?? (() => {});
    this.onDone = opts.onDone ?? (() => {});
    this.speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
    this.fallbackIntervalSec = opts.fallbackIntervalSec ?? 1;
    this.origin = GpsOrigin.REPLAY;
    this.provenance = opts.provenance ?? GpxProvenance.UNKNOWN;

    this.state = GpsState.IDLE;
    this._perfNow =
      opts.perfNow ??
      (() =>
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now());
    this._setTimeout =
      opts.setTimeoutFn ??
      ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = opts.clearTimeoutFn ?? ((h) => clearTimeout(h));

    this._cursor = 0;
    this._timer = null;
    this._perfStart = 0;
    this._fileStartEpoch = 0;
    this._paused = false;
  }

  /** 回放时间线：文件 epoch → 本次会话 perf */
  fileToPerf(tEpochMs) {
    return this._perfStart + (tEpochMs - this._fileStartEpoch) / this.speed;
  }

  /** 本次会话 perf → 文件 epoch（调试图表用） */
  perfToFile(perfMs) {
    return this._fileStartEpoch + (perfMs - this._perfStart) * this.speed;
  }

  get timeSynthesized() {
    return !this.gpx.hasTime;
  }

  start() {
    if (this._timer !== null || this.state === GpsState.WATCHING) return true;

    const pts = this.gpx.points;
    this._cursor = 0;
    this._perfStart = this._perfNow();
    // 首个点的时间作为文件时间线的原点；缺 time 时按 fallback 间隔合成
    this._fileStartEpoch =
      pts[0].tEpochMs !== null ? pts[0].tEpochMs : 0;
    this._paused = false;
    this.state = GpsState.WATCHING;
    this.onState(this.state);
    this._scheduleNext();
    return true;
  }

  _fileTimeOf(index) {
    const pts = this.gpx.points;
    const p = pts[index];
    if (p.tEpochMs !== null) return p.tEpochMs;
    // 缺 time：以首次出现 time 的点为基准按间隔推进；全缺则从 0 开始
    const withTime = pts.find((q) => q.tEpochMs !== null);
    const base = withTime ? withTime.tEpochMs : 0;
    return base + index * this.fallbackIntervalSec * 1000;
  }

  _scheduleNext() {
    if (this._paused) return;
    const pts = this.gpx.points;
    if (this._cursor >= pts.length) {
      this._finish();
      return;
    }
    const targetPerf = this.fileToPerf(this._fileTimeOf(this._cursor));
    const now = this._perfNow();
    const waitMs = Math.max(0, targetPerf - now);
    // 单次等待上限 1 秒：既保证长间隔也能被暂停/停止打断，又不至于空转
    const chunk = Math.min(waitMs, 1000);
    this._timer = this._setTimeout(() => {
      this._timer = null;
      if (this._paused) return;
      if (chunk < waitMs) {
        this._scheduleNext();
        return;
      }
      this._emitCurrent();
    }, chunk);
  }

  _emitCurrent() {
    const pts = this.gpx.points;
    if (this._cursor >= pts.length) {
      this._finish();
      return;
    }
    const p = pts[this._cursor];
    const fileTime = this._fileTimeOf(this._cursor);
    const arrivalPerf = this._perfNow();
    this.onFix({
      seq: this._cursor,
      origin: GpsOrigin.REPLAY,
      provenance: this.provenance,
      // 文件时间放进 epoch 域；到达时刻放进 perf 域。两者不相等是正常的
      tEpochMs: fileTime,
      tMonoMs: arrivalPerf,
      lat: p.lat,
      lon: p.lon,
      accuracyM: null,
      altitudeM: p.ele,
      altitudeAccuracyM: null,
      headingDeg: null,
      speedMps: null,
      speedSource: null,
      replaySpeed: this.speed,
    });
    this._cursor += 1;
    this._scheduleNext();
  }

  pause() {
    this._paused = true;
    if (this._timer !== null) {
      this._clearTimeout(this._timer);
      this._timer = null;
    }
  }

  resume() {
    if (this.state !== GpsState.WATCHING) return;
    this._paused = false;
    this._scheduleNext();
  }

  get progress() {
    const n = this.gpx.points.length;
    return n === 0 ? 0 : this._cursor / n;
  }

  _finish() {
    this.state = GpsState.STOPPED;
    this.onState(this.state);
    this.onDone({ emitted: this._cursor, total: this.gpx.points.length });
  }

  stop() {
    if (this._timer !== null) {
      this._clearTimeout(this._timer);
      this._timer = null;
    }
    this._paused = false;
    if (this.state === GpsState.WATCHING) {
      this.state = GpsState.STOPPED;
      this.onState(this.state);
    }
  }
}

/**
 * 从 fix 序列计算派生量：累计距离、分段速度、配速。
 *
 * 速度来源分三种，**必须分别标注**，不能混成一个 speed 列：
 *   - `reported`：GPS 芯片自己报的（`coords.speed`），可信但常为 null；
 *   - `derived` ：由相邻两点的距离/时间算出；
 *   - `null`    ：算不出来（时间不前进、点数不足）。
 *
 * 差分算出的速度对定位噪声极其敏感：GPS 抖动 5 m、间隔 1 s，就能造出 5 m/s
 * 的假速度。所以这里同时给出 `impliedAccuracy`，让下游能判断这个速度值不值信。
 *
 * @param {Array<object>} fixes 按 tMonoMs 升序
 * @returns {Array<object>} 每个 fix 附带派生字段的新数组
 */
export function deriveGpsTrack(fixes) {
  if (!Array.isArray(fixes) || fixes.length === 0) return [];
  const out = [];
  let cumM = 0;
  let prev = null;

  for (const f of fixes) {
    const row = { ...f, distCumM: cumM, speedDerivedMps: null, paceSecPerKm: null, dtMs: null };
    if (prev !== null) {
      const dist = haversineM(prev, f);
      const dtMs = f.tMonoMs - prev.tMonoMs;
      if (dist !== null && dtMs > 0) {
        row.distCumM = cumM + dist;
        cumM = row.distCumM;
        row.dtMs = dtMs;
        row.speedDerivedMps = dist / (dtMs / 1000);
        row.paceSecPerKm = speedToPaceSecPerKm(row.speedDerivedMps);
      } else {
        row.distCumM = cumM;
      }
    }
    // 优先用芯片报的速度算配速；没有才退回差分速度
    const speedForPace =
      row.speedMps !== null && Number.isFinite(row.speedMps)
        ? row.speedMps
        : row.speedDerivedMps;
    row.paceSecPerKm = speedToPaceSecPerKm(speedForPace);
    row.paceSpeedSource =
      row.speedMps !== null && Number.isFinite(row.speedMps) ? "reported" : "derived";
    if (row.speedSource === null && row.speedDerivedMps !== null) {
      row.speedSource = "derived";
    }
    out.push(row);
    prev = f;
  }
  return out;
}
