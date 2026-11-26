/**
 * GPS 源与原始路程。REAL_GPS / REPLAY 分开。maximumAge 默认 0。
 * 原始路程按到达顺序累加。有采样时刻时，差分速度用采样间隔，到达速度另存。
 */

import { annotateGpsQuality, appendAnnotated } from "./gps_quality.js";

export const GpsOrigin = Object.freeze({
  REAL: "REAL_GPS",
  REPLAY: "REPLAY",
  NONE: "NONE",
});

export const GpxProvenance = Object.freeze({
  
  SYNTHETIC_GEOMETRY: "synthetic_geometry",
  
  RECORDED: "recorded",
  
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

function rad(deg) {
  return (deg * Math.PI) / 180;
}

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

export function speedToPaceSecPerKm(mps) {
  if (!Number.isFinite(mps) || mps <= 0) return null;
  return 1000 / mps;
}

export function formatPace(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return "—";
  const total = Math.round(secPerKm);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- GPX 解析

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
        
      }
    }
    this._watchId = null;
    if (this.state === GpsState.WATCHING || this.state === GpsState.REQUESTING) {
      this._setState(GpsState.STOPPED);
    }
  }
}

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

export class ReplayGpsSource {
  
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

  
  fileToPerf(tEpochMs) {
    return this._perfStart + (tEpochMs - this._fileStartEpoch) / this.speed;
  }

  
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

function rawStep(prevRow, f) {
  const cumM = prevRow ? prevRow.distCumM : 0;
  const row = {
    ...f,
    distCumM: cumM,
    speedDerivedMps: null,
    speedArrivalMps: null,
    speedSampleMps: null,
    paceSecPerKm: null,
    dtMs: null,
    dtArrivalMs: null,
    dtSampleMs: null,
    speedTimeBasis: null,
  };
  if (prevRow) {
    const dist = haversineM(prevRow, f);
    const dtArrival = Number(f.tMonoMs) - Number(prevRow.tMonoMs);
    const haveSample = Number.isFinite(f.tEpochMs) && Number.isFinite(prevRow.tEpochMs);
    const dtSample = haveSample ? Number(f.tEpochMs) - Number(prevRow.tEpochMs) : null;
    // 原始路程仍按「到达顺序里时间向前」累加，不改用另一把钟重算这条对照值。
    if (dist !== null && dtArrival > 0) {
      row.distCumM = cumM + dist;
      row.dtMs = dtArrival;
      row.dtArrivalMs = dtArrival;
      row.speedArrivalMps = dist / (dtArrival / 1000);
    } else if (Number.isFinite(dtArrival)) {
      row.dtArrivalMs = dtArrival;
    }
    row.dtSampleMs = dtSample;
    if (dist !== null && dtSample !== null && dtSample > 0) {
      row.speedSampleMps = dist / (dtSample / 1000);
    }
    // 有采样时刻时，差分速度用采样间隔。到达间隔只留在 speedArrivalMps，
    // 避免把「一次性吐出的迟到点」算成几百米每秒。没有采样时刻才退回到达间隔。
    if (row.speedSampleMps !== null) {
      row.speedDerivedMps = row.speedSampleMps;
      row.speedTimeBasis = "sample";
    } else if (dtSample === null && row.speedArrivalMps !== null) {
      row.speedDerivedMps = row.speedArrivalMps;
      row.speedTimeBasis = "arrival";
    } else if (dtSample !== null && !(dtSample > 0)) {
      row.speedTimeBasis = "sample_rejected";
    }
  }
  // 数学配速保留原口径：芯片速度优先，没有才用差分。页面显示不直接用它。
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
  return row;
}

export function deriveGpsTrack(fixes) {
  if (!Array.isArray(fixes) || fixes.length === 0) return [];
  const raw = [];
  let prev = null;
  for (const f of fixes) {
    const row = rawStep(prev, f);
    raw.push(row);
    prev = row;
  }
  return annotateGpsQuality(raw);
}

export function appendDerivedFix(track, fix) {
  const prev = track.length ? track[track.length - 1] : null;
  return appendAnnotated(track, rawStep(prev, fix));
}
