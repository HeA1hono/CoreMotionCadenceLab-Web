/**
 * 步频可信度：多证据聚合判定。
 *
 * ## 为什么必须拆掉固定步幅阈值
 *
 * E-W4 初版写的是 `stride > 1.8 m ⇒ 步频可能腰斩`。这个判据有一个
 * 无法靠调阈值修补的结构性问题：**它把两个不同传感器、不同时间窗的量做了除法，
 * 然后把全部差值归因于分母。**
 *
 *   stride = GPS 速度 ÷ 算法步频
 *
 * 右边两个量都可能错：
 *   - GPS 瞬时速度是相邻点差分出来的，5 m 的位置抖动在 1 s 间隔上就是 5 m/s；
 *   - 步频是算法估出来的，也可能真的对；
 *   - "步频"这个词在不同 App 里定义都不同（按单腿计 / 按步计 / 按落地次数计）。
 *
 * 一个真实反例：配速 4′58″/km（3.36 m/s）、步频 75 SPM ⇒ 推算步幅 2.68 m。
 * 旧判据会直接喊"腰斩"。但这 2.68 m 完全可能来自：
 *   - 配速是 1 km 平均值，步频是当下瞬时值，两个窗口根本不重叠；
 *   - 那个 App 的"步频"按单腿计（75 × 2 = 150，步幅 1.34 m，一切正常）；
 *   - GPS 在那一段有过一次位置跳变。
 * **在拿到独立证据之前，无法判断错的是哪一方。**
 *
 * ## 所以判据改成"证据聚合"
 *
 * | 证据 | 来源 | 强度 | 能证明什么 |
 * |---|---|---|---|
 * | 人工计数 | 人自己数 | 基准 | 直接比对步数，**唯一能确认**的证据 |
 * | 连续时序 | 本会话步频序列 | 强 | 速度不变时步频阶跃减半，是算法问题的强证据 |
 * | 个体基线 | 本会话早前同速度档 | 中 | 相对自己的偏离 |
 * | 步幅包络 | 速度分带的常见范围 | 弱 | 只说明"这个组合少见" |
 *
 * 判定规则只有一条硬约束：**只有人工计数能给"已确认"**。
 * 其余任何组合最多到「疑似异常／需要人工验证」。
 * 理由很朴素：我们唯一能拿到的物理真值，就是人数出来的步数；
 * 其余全是推断。把推断说成事实，是本项目最不该犯的错。
 *
 * ## 不做什么
 *
 *   - 不改步频（不修正、不钳制、不回填）；
 *   - 不用 GPS 反推步数；
 *   - 不在证据不足时使用"已减半""已腰斩"这类完成态措辞。
 */

/**
 * 判定结果。
 *
 * `SUSPECT` 的中文是「疑似异常」，页面上必须与「需要人工验证」一起出现，
 * 不允许单独渲染成结论。
 */
export const CadenceVerdict = Object.freeze({
  NO_DATA: "no_data",
  NORMAL: "normal",
  SUSPECT: "suspect",
  CONFIRMED_LOW: "confirmed_low",
  CONFIRMED_HIGH: "confirmed_high",
});

/** 判定短标签（放进指标格，必须短到 320 px 不折行）。 */
export const VERDICT_TEXT = Object.freeze({
  [CadenceVerdict.NO_DATA]: "—",
  [CadenceVerdict.NORMAL]: "未见异常",
  [CadenceVerdict.SUSPECT]: "疑似异常",
  [CadenceVerdict.CONFIRMED_LOW]: "已确认偏低",
  [CadenceVerdict.CONFIRMED_HIGH]: "已确认偏高",
});

/**
 * 人工计数与算法步数的比值达到多少才算"确认"。
 *
 * 取 1.6 而不是 2.0：腰斩的理论比值是 2.0，但人会漏数、算法会少计几步，
 * 留 20% 余量后 1.6 已经足够把"真的差一半"和"差几步"分开。
 * 反向同理（0.625 = 1/1.6）。
 */
export const HUMAN_CONFIRM_RATIO = 1.6;

/** 人工计数至少要这么多步才有意义（少于 20 步时一次漏数就能改变结论）。 */
export const HUMAN_MIN_STEPS = 20;

/**
 * 人工计数至少要覆盖这么长的时间。
 *
 * 没有这条下限，"开始后 3 秒数了 20 步"就会算出 400 SPM 的比值，
 * 从而得到一次完全虚假的"已确认"。短窗口的比值不是证据，是噪声。
 */
export const HUMAN_MIN_WINDOW_MS = 30000;

/**
 * 步幅包络：按速度分带的"常见单步步长"范围。
 *
 * 单位是 **m/步**（`速度 ÷ 每秒步数`），不是英文语境里两步的 stride。
 *
 * 为什么必须分带：1.4 m/s 时 1.8 m 的步幅是荒谬的，4.0 m/s 时 1.8 m 是正常的。
 * 固定一个数，慢走会漏报、快跑会误报——这正是上一版 1.8 m 的病。
 *
 * 上界取得比生理常见值宽：这一层只是最弱的证据，宁可放过也不要制造误报。
 * 例如 3.2–4.5 m/s 档上界 2.90 m，正好让 4′58″/km @75 SPM 的 2.68 m 落在带内，
 * 不会被任何提示命中。
 */
export const STRIDE_ENVELOPE = Object.freeze([
  Object.freeze({ id: "rest", label: "静止/挪动", minSpeed: 0, maxSpeed: 0.8, minStride: 0.20, maxStride: 1.10 }),
  Object.freeze({ id: "walk", label: "步行", minSpeed: 0.8, maxSpeed: 1.4, minStride: 0.30, maxStride: 1.40 }),
  Object.freeze({ id: "brisk", label: "快走", minSpeed: 1.4, maxSpeed: 2.2, minStride: 0.40, maxStride: 1.80 }),
  Object.freeze({ id: "jog", label: "慢跑", minSpeed: 2.2, maxSpeed: 3.2, minStride: 0.55, maxStride: 2.35 }),
  Object.freeze({ id: "run", label: "跑步", minSpeed: 3.2, maxSpeed: 4.5, minStride: 0.70, maxStride: 2.90 }),
  Object.freeze({ id: "fast", label: "快跑", minSpeed: 4.5, maxSpeed: 6.0, minStride: 0.90, maxStride: 3.30 }),
  Object.freeze({ id: "sprint", label: "冲刺", minSpeed: 6.0, maxSpeed: Infinity, minStride: 1.00, maxStride: 3.80 }),
]);

/** 证据强度标签，给页面用。 */
export const STRENGTH_TEXT = Object.freeze({
  reference: "人工基准",
  strong: "强",
  medium: "中",
  weak: "弱",
});

function medianOf(values) {
  const v = values.slice().sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * 相对离散度：1.4826 × MAD ÷ 中位数。
 *
 * 用 MAD 而不是标准差：标准差会被一两个离群点拉爆，而这里的离群点
 * 恰恰就是我们想识别的东西——拿它当分母会把真正的阶跃洗成"噪声略大"。
 */
function relativeMad(values, med) {
  if (!Number.isFinite(med) || med === 0 || values.length < 2) return null;
  const dev = values.map((v) => Math.abs(v - med));
  const mad = medianOf(dev);
  if (!Number.isFinite(mad)) return null;
  return (1.4826 * mad) / med;
}

/** 线性插值分位数（输入需已升序）。 */
function quantileSorted(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * p10–p90 相对跨度：`(p90 − p10) / 中位数`。
 *
 * 为什么不用 MAD 判"这一段稳不稳"：MAD 在**多数值完全相同**时会退化成 0。
 * 例如一段里 40 个 60 SPM、32 个 120 SPM，中位数 60，偏差里 40 个 0 →
 * MAD = 0 → "离散度 0%"，于是这段被当成稳定的单一行情，
 * 阶跃检测就会把还没有真正切换的位置当成切换点（实测报早 32 秒）。
 * p10–p90 跨度对这种"两簇混合"不会退化：这里它是 1.0。
 */
function spreadSorted(sorted, med) {
  if (!Number.isFinite(med) || med === 0) return null;
  const lo = quantileSorted(sorted, 0.1);
  const hi = quantileSorted(sorted, 0.9);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return (hi - lo) / med;
}

/** 某个速度落在哪一档包络；速度非法返回 null。 */
export function strideEnvelopeFor(speedMps) {
  if (!Number.isFinite(speedMps) || speedMps <= 0) return null;
  const last = STRIDE_ENVELOPE.length - 1;
  for (let i = 0; i < STRIDE_ENVELOPE.length; i += 1) {
    const b = STRIDE_ENVELOPE[i];
    if (speedMps >= b.minSpeed && (i === last || speedMps < b.maxSpeed)) {
      return { id: b.id, label: b.label, minStride: b.minStride, maxStride: b.maxStride };
    }
  }
  return null;
}

/**
 * 由速度与步频推算步幅，只回答"这个组合常不常见"，**不回答谁错了**。
 *
 * 返回的 `plausibility` 只有三种值：`within` / `high` / `low`。
 * 早先这里返回的是 `cadence_half` / `cadence_double`——那等于把
 * "这个数少见"直接翻译成"步频错了"，而这两件事之间缺了一整步推理。
 *
 * @param {{speedMps:number|null, spm:number|null}} input
 * @returns {{strideM:number, plausibility:string, band:string|null, limitM:number|null, note:string}|null}
 */
export function assessStride(input) {
  const speed = input && input.speedMps;
  const spm = input && input.spm;
  if (!Number.isFinite(speed) || !Number.isFinite(spm) || spm <= 0 || speed <= 0) {
    return null;
  }
  const strideM = speed / (spm / 60);
  const env = strideEnvelopeFor(speed);
  if (!env) {
    return { strideM, plausibility: "within", band: null, limitM: null, note: "" };
  }
  if (strideM > env.maxStride) {
    return {
      strideM,
      plausibility: "high",
      band: env.id,
      limitM: env.maxStride,
      note: `推算步幅 ${strideM.toFixed(2)} m 高于「${env.label}」档常见上限 ${env.maxStride.toFixed(2)} m`,
    };
  }
  if (strideM < env.minStride) {
    return {
      strideM,
      plausibility: "low",
      band: env.id,
      limitM: env.minStride,
      note: `推算步幅 ${strideM.toFixed(2)} m 低于「${env.label}」档常见下限 ${env.minStride.toFixed(2)} m`,
    };
  }
  return {
    strideM,
    plausibility: "within",
    band: env.id,
    limitM: null,
    note: `推算步幅 ${strideM.toFixed(2)} m 在「${env.label}」档 ${env.minStride.toFixed(2)}–${env.maxStride.toFixed(2)} m 之内`,
  };
}

/**
 * 个体基线：本会话早前、同一速度档、稳定段的步幅中位数。
 *
 * 为什么要有它：包络是"全人类"的范围，宽到几乎不报错；而每个人自己的步幅
 * 相对固定，**相对自己的偏离**比相对全人类的范围敏感得多。
 *
 * 三条自我保护：
 *   1. 只用 `excludeTailMs` 之前的样本——否则正在发生的异常会把自己写进基线，
 *      然后拿它证明自己正常（每来一个点就抬高一次基线，永远追不上）；
 *   2. 离散度太大就不当基线（CV > 15% 说明这段本来就不稳）；
 *   3. 样本数或持续时间不够就直接说"不够"，不拿 3 个点算中位数。
 */
export class CadenceBaseline {
  constructor(opts = {}) {
    this.bandMps = Number.isFinite(opts.bandMps) ? opts.bandMps : 0.3;
    this.minSamples = Number.isFinite(opts.minSamples) ? opts.minSamples : 10;
    this.minSpanMs = Number.isFinite(opts.minSpanMs) ? opts.minSpanMs : 15000;
    this.maxCv = Number.isFinite(opts.maxCv) ? opts.maxCv : 0.15;
    this.excludeTailMs = Number.isFinite(opts.excludeTailMs) ? opts.excludeTailMs : 20000;
    this.retainMs = Number.isFinite(opts.retainMs) ? opts.retainMs : 600000;
    /** @type {Array<{perfMs:number, speedMps:number, spm:number, strideM:number}>} */
    this.samples = [];
  }

  get size() {
    return this.samples.length;
  }

  add(sample) {
    const s = sample || {};
    if (!Number.isFinite(s.perfMs) || !Number.isFinite(s.speedMps) || !Number.isFinite(s.spm)) return false;
    if (s.speedMps <= 0 || s.spm <= 0) return false;
    this.samples.push({
      perfMs: s.perfMs,
      speedMps: s.speedMps,
      spm: s.spm,
      strideM: s.speedMps / (s.spm / 60),
    });
    const cut = s.perfMs - this.retainMs;
    while (this.samples.length && this.samples[0].perfMs < cut) this.samples.shift();
    return true;
  }

  /** 形状恒定的空结果——双形状返回值是上一轮踩过的坑，这里不再犯。 */
  static _miss(reason, count = 0, spanMs = 0, cv = null) {
    return { available: false, strideM: null, spm: null, count, spanMs, cv, reason };
  }

  /**
   * @param {number} speedMps 当前速度
   * @param {number} perfMs 当前时刻
   * @param {{excludeTailMs?:number}} [opts]
   */
  query(speedMps, perfMs, opts = {}) {
    if (!Number.isFinite(speedMps) || !Number.isFinite(perfMs)) {
      return CadenceBaseline._miss("速度或时刻无效");
    }
    const excludeTailMs = Number.isFinite(opts.excludeTailMs) ? opts.excludeTailMs : this.excludeTailMs;
    const cutoff = perfMs - excludeTailMs;
    const picked = [];
    for (const s of this.samples) {
      if (s.perfMs > cutoff) continue;
      if (Math.abs(s.speedMps - speedMps) > this.bandMps) continue;
      picked.push(s);
    }
    if (picked.length === 0) {
      return CadenceBaseline._miss(`尚无 ${excludeTailMs / 1000} 秒之前的同速度档样本`);
    }
    if (picked.length < this.minSamples) {
      return CadenceBaseline._miss(
        `同速度档样本不足（${picked.length}/${this.minSamples}）`,
        picked.length,
      );
    }
    const spanMs = picked[picked.length - 1].perfMs - picked[0].perfMs;
    if (spanMs < this.minSpanMs) {
      return CadenceBaseline._miss(
        `同速度档持续时间不足（${(spanMs / 1000).toFixed(0)}/${(this.minSpanMs / 1000).toFixed(0)} 秒）`,
        picked.length,
        spanMs,
      );
    }
    const strides = picked.map((s) => s.strideM);
    const strideM = medianOf(strides);
    const cv = relativeMad(strides, strideM);
    if (cv !== null && cv > this.maxCv) {
      return CadenceBaseline._miss(
        `同速度档步幅离散度过大（CV ${(cv * 100).toFixed(0)}%），不能当基线`,
        picked.length,
        spanMs,
        cv,
      );
    }
    return {
      available: true,
      strideM,
      spm: medianOf(picked.map((s) => s.spm)),
      count: picked.length,
      spanMs,
      cv,
      reason: "",
    };
  }
}

/** 阶跃检测的空结果，形状同样恒定。 */
function regimeMiss(note, bins = 0) {
  return {
    detected: false,
    direction: null,
    fromSpm: null,
    toSpm: null,
    ratio: null,
    atPerfMs: null,
    beforeSpread: null,
    afterSpread: null,
    speedRatio: null,
    speedChecked: false,
    bins,
    note,
  };
}

/**
 * 在步频序列里找"阶跃式"变化：速度基本不变，步频却在几秒内掉到约一半。
 *
 * 为什么这条证据强：真正改变步态时速度一定跟着变（走→跑、跑→走、停下）。
 * 速度不动而步频精确地掉一半，只有两种解释——算法漏计了，或者被测量对象
 * 突然换了动作（后者在真实步行里几乎不发生）。
 *
 * 但仍然不叫"确认"：如果 GPS 那一段速度本身就是错的，"速度没变"这个前提
 * 也不成立。所以它只能把判定推到「疑似」。
 *
 * @param {Array<{perfMs:number, spm:number, speedMps?:number}>} points
 * @param {object} [opts]
 */
export function detectRegimeChange(points, opts = {}) {
  const binMs = Number.isFinite(opts.binMs) ? opts.binMs : 1000;
  const maxBins = Number.isFinite(opts.maxBins) ? opts.maxBins : 300;
  const minSegBins = Number.isFinite(opts.minSegBins) ? opts.minSegBins : 8;
  const maxSpread = Number.isFinite(opts.maxSpread) ? opts.maxSpread : 0.25;
  const minSpm = Number.isFinite(opts.minSpm) ? opts.minSpm : 30;
  const speedTol = Number.isFinite(opts.speedTol) ? opts.speedTol : 0.25;

  const list = (Array.isArray(points) ? points : [])
    .filter((p) => Number.isFinite(p && p.perfMs) && Number.isFinite(p && p.spm) && p.spm > 0)
    .sort((a, b) => a.perfMs - b.perfMs);
  if (list.length === 0) return regimeMiss("无步频样本");

  const t0 = list[0].perfMs;
  const buckets = new Map();
  for (const p of list) {
    const idx = Math.floor((p.perfMs - t0) / binMs);
    let b = buckets.get(idx);
    if (!b) {
      b = { idx, spms: [], speeds: [] };
      buckets.set(idx, b);
    }
    b.spms.push(p.spm);
    if (Number.isFinite(p.speedMps) && p.speedMps > 0) b.speeds.push(p.speedMps);
  }
  const all = [...buckets.values()]
    .sort((a, b) => a.idx - b.idx)
    .map((b) => ({
      idx: b.idx,
      tMono: t0 + b.idx * binMs,
      spm: medianOf(b.spms),
      speedMps: b.speeds.length ? medianOf(b.speeds) : null,
    }));

  // 只保留最近 maxBins 个箱：扫描是 O(箱数²)，长时间实验不能无限增长
  const bins = all.length > maxBins ? all.slice(all.length - maxBins) : all;

  // 必须按"连续箱"切段。定位中断会在序列里留下空洞，跨空洞比较
  // 等于把中断前后当成一次阶跃——那正是把传感器断档误判成算法问题的路径。
  const runs = [];
  let cur = [];
  for (const b of bins) {
    if (cur.length === 0 || b.idx === cur[cur.length - 1].idx + 1) {
      cur.push(b);
    } else {
      if (cur.length) runs.push(cur);
      cur = [b];
    }
  }
  if (cur.length) runs.push(cur);

  let best = null;
  for (const run of runs) {
    if (run.length < minSegBins * 2) continue;
    for (let k = minSegBins; k <= run.length - minSegBins; k += 1) {
      const before = run.slice(0, k);
      const after = run.slice(k);
      const bSpms = before.map((b) => b.spm);
      const aSpms = after.map((b) => b.spm);
      const bMed = medianOf(bSpms);
      const aMed = medianOf(aSpms);
      if (!(bMed >= minSpm) || !(aMed >= minSpm)) continue;
      const bSpread = spreadSorted(bSpms.slice().sort((x, y) => x - y), bMed);
      const aSpread = spreadSorted(aSpms.slice().sort((x, y) => x - y), aMed);
      if (bSpread === null || aSpread === null) continue;
      if (bSpread > maxSpread || aSpread > maxSpread) continue;

      const ratio = bMed / aMed;
      const drop = ratio >= 1.75 && ratio <= 2.35;
      const rise = ratio >= 0.425 && ratio <= 0.571;
      if (!drop && !rise) continue;

      const bSpeeds = before.map((b) => b.speedMps).filter((v) => Number.isFinite(v) && v > 0);
      const aSpeeds = after.map((b) => b.speedMps).filter((v) => Number.isFinite(v) && v > 0);
      let speedRatio = null;
      if (bSpeeds.length && aSpeeds.length) {
        const bm = medianOf(bSpeeds);
        const am = medianOf(aSpeeds);
        if (bm > 0 && am > 0) speedRatio = bm / am;
      }
      if (speedRatio !== null && (speedRatio < 1 - speedTol || speedRatio > 1 + speedTol)) continue;

      const score = Math.abs(Math.log(ratio) - Math.log(drop ? 2 : 0.5));
      const cand = {
        detected: true,
        direction: drop ? "drop" : "rise",
        fromSpm: bMed,
        toSpm: aMed,
        ratio,
        atPerfMs: after[0].tMono,
        beforeSpread: bSpread,
        afterSpread: aSpread,
        speedRatio,
        speedChecked: speedRatio !== null,
        bins: run.length,
        note: "",
        score,
      };
      if (
        best === null ||
        cand.score < best.score - 1e-9 ||
        // 同分时取**最早**的切分点：一次 120→60 的阶跃，从第 40 秒到第 51 秒
        // 切都能得到 2.00 倍，取最晚的会把"变化发生时刻"报晚十几秒。
        (Math.abs(cand.score - best.score) < 1e-9 && cand.atPerfMs < best.atPerfMs)
      ) {
        best = cand;
      }
    }
  }

  if (!best) {
    return regimeMiss(`未检出阶跃（需 ${minSegBins} 秒以上稳定段 + 约 2 倍变化 + 速度基本不变）`, bins.length);
  }

  // 定位真正的切换点。
  //
  // 同分取最早切分点会带来一个偏差：120→60 的阶跃发生在第 40 秒时，
  // 从第 36 秒切也能得到 2.00 倍（后面混进的 4 个 120 只占 9%，
  // p90 够不到它们）。所以选定切分点后，再往前找到第一个"更像新档"的箱：
  // 它的步频离新中位数比离旧中位数更近。这样报出的时刻就是真实拐点。
  const from = best.fromSpm;
  const to = best.toSpm;
  for (const b of bins) {
    if (b.tMono < best.atPerfMs) continue;
    if (Math.abs(b.spm - to) < Math.abs(b.spm - from)) {
      best.atPerfMs = b.tMono;
      break;
    }
  }
  const atSec = (best.atPerfMs / 1000).toFixed(0);
  const speedPart =
    best.speedRatio === null ? "" : `，同期速度比 ${best.speedRatio.toFixed(2)}`;
  best.note =
    best.direction === "drop"
      ? `步频在 ${atSec} s 附近由 ${from.toFixed(0)} 掉到 ${to.toFixed(0)} SPM（${best.ratio.toFixed(2)} 倍）${speedPart}`
      : `步频在 ${atSec} s 附近由 ${from.toFixed(0)} 升到 ${to.toFixed(0)} SPM（${(1 / best.ratio).toFixed(2)} 倍）${speedPart}`;
  return best;
}

function dominantDirection(evidence) {
  let low = 0;
  let high = 0;
  for (const e of evidence) {
    if (e.direction === "low") low += e.strength === "strong" ? 2 : 1;
    else if (e.direction === "high") high += e.strength === "strong" ? 2 : 1;
  }
  if (low === 0 && high === 0) return "none";
  if (low === high) return "mixed";
  return low > high ? "low" : "high";
}

/**
 * 聚合判定。
 *
 * @param {object} input
 * @param {object|null} [input.stride]    assessStride 的结果（当前点）
 * @param {object|null} [input.baseline]  CadenceBaseline.query 的结果
 * @param {object|null} [input.current]   {strideM, spm, speedMps}
 * @param {object|null} [input.regime]    detectRegimeChange 的结果
 * @param {object|null} [input.intervalDx] analyzeIntervalDistribution 的结果
 * @param {{steps:number, algoSteps:number, windowMs?:number}|null} [input.humanCount]
 * @param {number|null} [input.algoSpm]
 */
export function assessCadenceIntegrity(input = {}) {
  const stride = input.stride && Number.isFinite(input.stride.strideM) ? input.stride : null;
  const baseline = input.baseline && input.baseline.available ? input.baseline : null;
  const regime = input.regime && input.regime.detected ? input.regime : null;
  const dx = input.intervalDx && input.intervalDx.doubled ? input.intervalDx : null;
  const current = input.current && Number.isFinite(input.current.strideM) ? input.current : null;
  const human = input.humanCount || null;

  const evidence = [];
  const missing = [];

  // ---- 证据 0：人工计数（唯一的"基准"级证据）
  let humanRatio = null;
  if (human && Number.isFinite(human.steps) && Number.isFinite(human.algoSteps)) {
    if (human.steps < HUMAN_MIN_STEPS) {
      missing.push(`人工计数的步数太少（${Math.round(human.steps)} 步，至少 ${HUMAN_MIN_STEPS} 步）`);
    } else if (!Number.isFinite(human.windowMs) || human.windowMs < HUMAN_MIN_WINDOW_MS) {
      missing.push(
        `人工计数覆盖的时长太短（${Number.isFinite(human.windowMs) ? (human.windowMs / 1000).toFixed(0) : "?"} 秒，至少 ${HUMAN_MIN_WINDOW_MS / 1000} 秒）`,
      );
    } else {
      humanRatio = human.algoSteps > 0 ? human.steps / human.algoSteps : Infinity;
      const dir =
        humanRatio >= HUMAN_CONFIRM_RATIO ? "low" : humanRatio <= 1 / HUMAN_CONFIRM_RATIO ? "high" : "none";
      evidence.push({
        id: "human_count",
        strength: "reference",
        direction: dir,
        text: `人工计数 ${Math.round(human.steps)} 步 / 算法同期 ${Math.round(human.algoSteps)} 步 = ${Number.isFinite(humanRatio) ? humanRatio.toFixed(2) : "∞"} 倍`,
      });
    }
  } else {
    missing.push("人工计数（目前唯一能确认的证据）");
  }

  // ---- 证据 1：步幅包络（弱）
  if (stride && stride.plausibility === "high") {
    evidence.push({
      id: "stride_envelope",
      strength: "weak",
      direction: "low",
      text: `${stride.note}；单一派生量，不能据此判断错在速度还是步频`,
    });
  } else if (stride && stride.plausibility === "low") {
    evidence.push({
      id: "stride_envelope",
      strength: "weak",
      direction: "high",
      text: `${stride.note}；单一派生量，不能据此判断错在速度还是步频`,
    });
  }

  // ---- 证据 2：个体基线（中）
  if (baseline && current) {
    const ratio = baseline.strideM > 0 ? current.strideM / baseline.strideM : null;
    if (ratio !== null && (ratio >= 1.5 || ratio <= 1 / 1.5)) {
      const dir = ratio >= 1.5 ? "low" : "high";
      evidence.push({
        id: "baseline",
        strength: "medium",
        direction: dir,
        text: `当前步幅 ${current.strideM.toFixed(2)} m，本会话同速度档基线 ${baseline.strideM.toFixed(2)} m（${baseline.count} 个样本 / ${(baseline.spanMs / 1000).toFixed(0)} 秒），相差 ${ratio.toFixed(2)} 倍`,
      });
    }
  } else if (input.baseline && !input.baseline.available) {
    missing.push(`个体基线：${input.baseline.reason}`);
  } else if (!input.baseline) {
    missing.push("个体基线（需要同速度档先稳定走 15 秒以上）");
  }

  // ---- 证据 3：连续时序阶跃（强；没查速度时降为中）
  if (regime) {
    evidence.push({
      id: "regime",
      strength: regime.speedChecked ? "strong" : "medium",
      direction: regime.direction === "drop" ? "low" : "high",
      text: `${regime.note}${regime.speedChecked ? "；速度基本不变" : "；缺同期速度，强度降级"}`,
    });
  }

  // ---- 证据 4：间隔分布 2T 聚集（中）
  if (dx) {
    evidence.push({
      id: "interval_2t",
      strength: "medium",
      direction: "low",
      text: `${(dx.nearDoubleRatio * 100).toFixed(0)}% 的计步间隔落在 1.7–2.4 倍中位区间（${dx.sampleCount} 个间隔）`,
    });
  }

  const toneOf = (v) =>
    v === CadenceVerdict.NORMAL ? "is-ok" : v === CadenceVerdict.SUSPECT ? "is-warn" : "is-fail";

  const mk = (verdict, confidence, direction, summary, note) => ({
    verdict,
    label: VERDICT_TEXT[verdict],
    tone: toneOf(verdict),
    confidence,
    direction,
    humanRatio,
    evidence,
    missing,
    summary,
    note,
  });

  // ---- 判定
  if (humanRatio !== null) {
    if (humanRatio >= HUMAN_CONFIRM_RATIO) {
      return mk(
        CadenceVerdict.CONFIRMED_LOW,
        "high",
        "low",
        "人工计数确认算法少计",
        `人工计数确认：你数了 ${Math.round(human.steps)} 步，算法同期 ${Math.round(human.algoSteps)} 步，` +
          `相差 ${humanRatio.toFixed(2)} 倍。这是本项目唯一能给出「已确认」的路径——` +
          "其余证据都只是推断。算法本身未作任何修改，这份结果只用于诊断。",
      );
    }
    if (humanRatio <= 1 / HUMAN_CONFIRM_RATIO) {
      return mk(
        CadenceVerdict.CONFIRMED_HIGH,
        "high",
        "high",
        "人工计数确认算法多计",
        `人工计数确认：你数了 ${Math.round(human.steps)} 步，算法同期 ${Math.round(human.algoSteps)} 步，` +
          `算法是人工的 ${(1 / humanRatio).toFixed(2)} 倍。算法未作任何修改。`,
      );
    }
    return mk(
      CadenceVerdict.NORMAL,
      "high",
      "none",
      "人工计数与算法一致",
      `人工计数 ${Math.round(human.steps)} 步 / 算法 ${Math.round(human.algoSteps)} 步 = ` +
        `${humanRatio.toFixed(2)} 倍，两者一致。本次会话的步频没有明显问题。`,
    );
  }

  const hasAnything = Boolean(stride || baseline || regime || dx);
  if (!hasAnything) {
    return mk(
      CadenceVerdict.NO_DATA,
      "none",
      "none",
      "还没有可用的配对数据",
      "需要同时拿到 GPS 速度与步频才能做跨源对照。",
    );
  }

  if (evidence.length > 0) {
    const strong = evidence.some((e) => e.strength === "strong");
    const mediumCount = evidence.filter((e) => e.strength === "medium").length;
    const reasons = evidence.map((e) => e.text).join("；");
    const need = missing.length ? `要确认还需要：${missing.join("、")}。` : "";
    return mk(
      CadenceVerdict.SUSPECT,
      strong ? "medium" : mediumCount >= 2 ? "medium" : "low",
      dominantDirection(evidence),
      "疑似异常，需要人工验证",
      `疑似异常／需要人工验证：${reasons}。${need}` +
        "这里不会断言步频已经减半——单一派生量无法区分「速度错了」「步频错了」" +
        "和「两者的时间窗本来就不重叠」这三种情况。请用人工计数核对。",
    );
  }

  return mk(
    CadenceVerdict.NORMAL,
    "medium",
    "none",
    "现有证据未见异常",
    `步幅包络、个体基线、连续时序均未触发。${missing.length ? `尚未${missing.join("、")}，因此这是推断而不是确认。` : ""}`,
  );
}
