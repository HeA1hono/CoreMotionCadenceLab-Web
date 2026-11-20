/**
 * 数据源：真实传感器（Safari devicemotion）与模拟源（Windows 上的合成信号）。
 *
 * 两者输出同一种记录结构，下游（监测、UI、导出）不区分来源；
 * 来源差异只体现在 isMock 标记与导出物命名上，绝不在数据里混同。
 */

import { makeGaitSignal, SCENE_PRESETS } from "./synth.js";

export const SourceState = Object.freeze({
  IDLE: "IDLE",
  REQUESTING: "REQUESTING",
  GRANTED: "GRANTED",
  DENIED: "DENIED",
  UNSUPPORTED: "UNSUPPORTED",
  RUNNING: "RUNNING",
  STOPPED: "STOPPED",
  ERROR: "ERROR",
});

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 取定时器 API。
 *
 * 必须绑定接收者：浏览器的 setInterval 是宿主函数，解构后直接调用会抛
 * "Illegal invocation"。这个坑在 Node 里不会出现，只有在真浏览器里才炸，
 * 所以这里显式 bind，并由 tools/smoke_page.py 在无头 Chrome 里守住。
 */
function defaultTimerApi() {
  const g = globalThis;
  return {
    setInterval: g.setInterval.bind(g),
    clearInterval: g.clearInterval.bind(g),
  };
}

/**
 * 把浏览器原生的 DeviceMotionEvent 归一化成内部记录。
 *
 * 关键防御：
 *   - accelerationIncludingGravity 可能整体缺失；
 *   - 单个轴可能是 null（WebKit 在某些机型上如此）；
 *   - interval 可能是 0 或 undefined；
 *   - rotationRate 可能为 null。
 * 任何一项都不得让监听器抛异常——一旦抛，事件流就断了。
 *
 * 【单位】`DeviceMotionEvent.interval` 按 W3C 规范是**秒**，不是毫秒。
 *   E-W1 真机数据把这一点坐实了：iPhone 13 上该字段恒为 0.016667，
 *   即 1/60 秒；而同一批事件的实际时间戳间隔中位数是 17ms。
 *   若原样写进 `interval_ms` 列，列名与内容就差了 1000 倍。
 *   此处统一 ×1000 转成毫秒，与合成源、CSV 列名、UI 单位保持一致。
 *
 * @param {object} event DeviceMotionEvent 或其等价结构
 * @param {number} nowMs 单调时钟毫秒
 */
export function normalizeMotionEvent(event, nowMs) {
  const ag = (event && event.accelerationIncludingGravity) || null;
  const lin = (event && event.acceleration) || null;
  const rr = (event && event.rotationRate) || null;
  const rawIntervalSec = numOrNull(event && event.interval);

  return {
    tMonoMs: nowMs,
    agx: ag ? numOrNull(ag.x) : null,
    agy: ag ? numOrNull(ag.y) : null,
    agz: ag ? numOrNull(ag.z) : null,
    ax: lin ? numOrNull(lin.x) : null,
    ay: lin ? numOrNull(lin.y) : null,
    az: lin ? numOrNull(lin.z) : null,
    alpha: rr ? numOrNull(rr.alpha) : null,
    beta: rr ? numOrNull(rr.beta) : null,
    gamma: rr ? numOrNull(rr.gamma) : null,
    intervalMs: rawIntervalSec === null ? null : rawIntervalSec * 1000,
    intervalSecRaw: rawIntervalSec,
    hasLinearAcceleration: Boolean(lin && numOrNull(lin.x) !== null),
  };
}

/**
 * 真实传感器数据源。
 *
 * requestPermission 必须在**真实点击的同步调用栈**里执行：
 * 经过 await / setTimeout 之后 transient activation 会丢失，
 * Safari 会抛 NotAllowedError。这个方法因此不做任何前置 await。
 */
export class RealMotionSource {
  constructor(opts = {}) {
    this.win = opts.win ?? globalThis;
    this.onEvent = opts.onEvent ?? (() => {});
    this.onState = opts.onState ?? (() => {});
    this.isMock = false;
    this.state = SourceState.IDLE;
    this.permission = "not-determined";
    this._handler = null;
    this._errorText = null;
  }

  _setState(s) {
    this.state = s;
    this.onState(s);
  }

  /**
   * 请求运动权限。**必须由真实点击触发，且本方法内部不得出现 await 前置。**
   * @returns {Promise<string>} "granted" | "denied" | "not-required" | "unsupported" | "error:..."
   */
  requestPermission() {
    const DME = this.win ? this.win.DeviceMotionEvent : undefined;
    if (typeof DME === "undefined" || DME === null) {
      this._setState(SourceState.UNSUPPORTED);
      this.permission = "unsupported";
      return Promise.resolve("unsupported");
    }
    if (typeof DME.requestPermission !== "function") {
      // 桌面浏览器或 iOS 13 以下：无需授权，但也不会给出真实数据
      this.permission = "not-required";
      return Promise.resolve("not-required");
    }

    this._setState(SourceState.REQUESTING);
    // 注意：此处直接调用，不包 await、不包 setTimeout。
    let promise;
    try {
      promise = DME.requestPermission();
    } catch (err) {
      this._errorText = String((err && err.name) || err);
      this.permission = "error";
      this._setState(SourceState.ERROR);
      return Promise.resolve(`error:${this._errorText}`);
    }

    return Promise.resolve(promise).then(
      (result) => {
        this.permission = result;
        this._setState(
          result === "granted" ? SourceState.GRANTED : SourceState.DENIED
        );
        return result;
      },
      (err) => {
        const name = String((err && err.name) || err);
        this._errorText = name;
        this.permission = "error";
        this._setState(SourceState.ERROR);
        return `error:${name}`;
      }
    );
  }

  start() {
    if (!this.win || typeof this.win.addEventListener !== "function") {
      this._errorText = "addEventListener 不可用";
      this._setState(SourceState.ERROR);
      return false;
    }
    if (this._handler) return true;

    this._handler = (event) => {
      let record;
      try {
        const now =
          this.win.performance && typeof this.win.performance.now === "function"
            ? this.win.performance.now()
            : Date.now();
        record = normalizeMotionEvent(event, now);
      } catch (_err) {
        return; // 归一化失败也不能让事件流中断
      }
      this.onEvent(record);
    };

    this.win.addEventListener("devicemotion", this._handler);
    this._setState(SourceState.RUNNING);
    return true;
  }

  stop() {
    if (this._handler && this.win && typeof this.win.removeEventListener === "function") {
      this.win.removeEventListener("devicemotion", this._handler);
    }
    this._handler = null;
    if (this.state === SourceState.RUNNING) this._setState(SourceState.STOPPED);
  }
}

/**
 * 模拟数据源。用于 Windows 本机验证整条链路。
 * 用定时器按实时节奏吐出预生成的样本，保持"数据是流式到达"的语义。
 */
export class MockMotionSource {
  constructor(opts = {}) {
    this.onEvent = opts.onEvent ?? (() => {});
    this.onState = opts.onState ?? (() => {});
    this.isMock = true;
    this.state = SourceState.IDLE;
    this.permission = "not-required";

    this.presetName = opts.presetName ?? "walk";
    this.sampleRateHz = opts.sampleRateHz ?? 60;
    this.durationSec = opts.durationSec ?? 900;
    this.seed = opts.seed ?? 20261119;

    this._timerApi = opts.timerApi ?? defaultTimerApi();
    this._clock = opts.clock ?? (() => performance.now());
    this._timer = null;
    this._signal = null;
    this._cursor = 0;
    this._startedAtMs = 0;
  }

  _setState(s) {
    this.state = s;
    this.onState(s);
  }

  setPreset(name) {
    if (!SCENE_PRESETS[name]) throw new Error(`未知场景: ${name}`);
    this.presetName = name;
    if (this.state === SourceState.RUNNING) {
      this.stop();
      this.start();
    }
  }

  start() {
    if (this._timer) return true;
    const preset = SCENE_PRESETS[this.presetName];
    this._signal = makeGaitSignal({
      spm: preset.spm,
      amp: preset.amp,
      tremorAmp: preset.tremorAmp,
      sampleRateHz: this.sampleRateHz,
      durationSec: this.durationSec,
      seed: this.seed,
      intervalJitterMs: 0.8,
      startMs: 0,
    });
    this._cursor = 0;
    this._startedAtMs = this._clock();

    const tickMs = Math.max(4, Math.round(1000 / this.sampleRateHz));
    this._timer = this._timerApi.setInterval(() => this._tick(), tickMs);
    this._setState(SourceState.RUNNING);
    return true;
  }

  _tick() {
    if (!this._signal) return;
    const elapsed = this._clock() - this._startedAtMs;
    const samples = this._signal.samples;
    let emitted = 0;
    while (this._cursor < samples.length && samples[this._cursor].tMonoMs <= elapsed) {
      const src = samples[this._cursor];
      this.onEvent({
        tMonoMs: this._startedAtMs + src.tMonoMs,
        agx: src.agx,
        agy: src.agy,
        agz: src.agz,
        ax: src.ax,
        ay: src.ay,
        az: src.az,
        alpha: src.alpha,
        beta: src.beta,
        gamma: src.gamma,
        intervalMs: src.intervalMs,
        hasLinearAcceleration: true,
      });
      this._cursor += 1;
      emitted += 1;
      if (emitted > 2000) break; // 防止页面挂起后一次性灌爆
    }
    if (this._cursor >= samples.length) this.stop();
  }

  stop() {
    if (this._timer) {
      this._timerApi.clearInterval(this._timer);
      this._timer = null;
    }
    if (this.state === SourceState.RUNNING) this._setState(SourceState.STOPPED);
  }
}
