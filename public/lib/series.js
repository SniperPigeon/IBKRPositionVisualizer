// 行情数据层：时区换算、解析 Yahoo 分块、还原原始价、计算复权因子、周/月聚合。纯函数，方便单测。
//
// 价格口径：
//   - Yahoo 返回的 OHLC 和股息金额做过拆股调整（没有做股息调整），但两种周期的规则不同（实测）：
//       日线：按抓取时刻 asOf 之前发生的所有拆股调整，与请求窗口无关；
//       分时：只按请求窗口内（≤ 窗口结束时间 periodEnd）发生的拆股调整。
//   - assemble() 先用 asOf 把每个分块还原成原始（不复权）价格，再合并。
//   - makeFactors() 在原始日线上计算前复权因子：拆股 × 股息（1 − 股息 / 除息前一日收盘价）。
//   视图层用因子乘出前复权价，或者直接用原始价（不复权）。

export const DAY = 86400;
export const dayOf = (sec) => Math.floor(sec / DAY) * DAY;

// ---- 时区 -------------------------------------------------------------------------------
// “wall” 时间 = 某时区的本地时钟读数，按 UTC 存成秒（图表库按 UTC 显示，正好显示交易所本地时间）
const tzFmts = new Map();
const tzOffs = new Map();
function rawWall(epoch, tz) {
  let f = tzFmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    tzFmts.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(epoch * 1000))) p[type] = value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000;
}
/** epoch → 某时区的 wall 秒。时区偏移在同一个 UTC 小时内不变，按小时缓存。 */
export function toWall(epoch, tz) {
  const h = Math.floor(epoch / 3600), k = tz + h;
  let o = tzOffs.get(k);
  if (o === undefined) { o = rawWall(h * 3600, tz) - h * 3600; tzOffs.set(k, o); }
  return epoch + o;
}
export function wallToEpoch(wall, tz) {
  let e = wall;
  for (let i = 0; i < 3; i++) e = wall - (toWall(e, tz) - e);
  return e;
}

// ---- 解析 -------------------------------------------------------------------------------
/** 解析一个 Yahoo chart 响应。asOf：这个分块从 Yahoo 抓取的时间（epoch 秒）。 */
export function parseYahoo(js, asOf) {
  const r = js && js.chart && js.chart.result && js.chart.result[0];
  if (!r) return { asOf, meta: {}, rows: [], splits: [], divs: [] };
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const col = (k) => q[k] || [];
  const o = col('open'), h = col('high'), l = col('low'), c = col('close'), v = col('volume');
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    if (o[i] == null || h[i] == null || l[i] == null || c[i] == null) continue;
    rows.push([ts[i], o[i], h[i], l[i], c[i], v[i] || 0]);
  }
  const ev = r.events || {};
  const splits = Object.values(ev.splits || {}).filter((s) => s.numerator > 0 && s.denominator > 0)
    .map((s) => ({ epoch: s.date, ratio: s.numerator / s.denominator }));
  const divs = Object.values(ev.dividends || {}).filter((d) => d.amount > 0).map((d) => ({ epoch: d.date, amount: d.amount }));
  return { asOf, meta: r.meta || {}, rows, splits, divs };
}

/**
 * 合并同一代码、同一周期的多个分块（按时间先后传入，后面的覆盖前面的重叠部分），并还原成原始价。
 * extraSplits：其他周期的分块里看到的拆股事件（合并后才完整）。
 */
export function assemble(chunks, daily, extraSplits = []) {
  const withData = chunks.filter((c) => c.rows.length || c.splits.length || c.divs.length);
  const meta = (withData.find((c) => c.meta && c.meta.exchangeTimezoneName) || chunks[0] || {}).meta || {};
  const tz = meta.exchangeTimezoneName || 'America/New_York';

  const splitMap = new Map();
  for (const s of [...extraSplits, ...chunks.flatMap((c) => c.splits)]) splitMap.set(s.epoch, s);
  const splits = [...splitMap.values()].map((s) => ({ ...s, day: dayOf(toWall(s.epoch, tz)) })).sort((a, b) => a.day - b.day);

  const byKey = new Map();
  const divMap = new Map();
  for (const c of chunks) {
    // 这个分块里 Yahoo 已经应用过的拆股（规则见文件头）
    const until = daily ? c.asOf : Math.min(c.asOf, c.periodEnd ?? c.asOf);
    const applied = splits.filter((s) => s.epoch <= until);
    const fAt = (day) => { let f = 1; for (const s of applied) if (day < s.day) f *= s.ratio; return f; };
    for (const [t, o, h, l, cl, v] of c.rows) {
      const w = toWall(t, tz);
      const key = daily ? dayOf(w) : w;
      const f = fAt(dayOf(w));
      byKey.set(key, { time: key, open: o * f, high: h * f, low: l * f, close: cl * f, volume: v / f });
    }
    for (const d of c.divs) {
      const day = dayOf(toWall(d.epoch, tz));
      divMap.set(day, { day, amount: d.amount * fAt(day) });
    }
  }
  const bars = [...byKey.values()].sort((a, b) => a.time - b.time);
  const divs = [...divMap.values()].sort((a, b) => a.day - b.day);
  return { bars, splits: splits.map(({ day, ratio, epoch }) => ({ day, ratio, epoch })), divs, tz, meta };
}

// ---- 复权因子 ---------------------------------------------------------------------------
/**
 * 前复权因子。dailyRaw：原始日线（time 为交易日 0 点的 wall 秒）。
 * 返回 price(day) / vol(day)：某个交易日的价格、数量乘数（只有该日之后的事件会影响它）。
 */
export function makeFactors(dailyRaw, splits, divs) {
  const pts = [];
  for (const s of splits) pts.push({ day: s.day, p: 1 / s.ratio, v: s.ratio, kind: 'split', ratio: s.ratio });
  for (const d of divs) {
    let lo = 0, hi = dailyRaw.length;           // 除息日前最后一根日线
    while (lo < hi) { const m = (lo + hi) >> 1; if (dailyRaw[m].time < d.day) lo = m + 1; else hi = m; }
    const prev = dailyRaw[lo - 1];
    if (!prev || !(prev.close > d.amount)) continue;
    pts.push({ day: d.day, p: 1 - d.amount / prev.close, v: 1, kind: 'div', amount: d.amount });
  }
  pts.sort((a, b) => a.day - b.day);
  const n = pts.length;
  const sufP = new Float64Array(n + 1).fill(1);
  const sufV = new Float64Array(n + 1).fill(1);
  for (let i = n - 1; i >= 0; i--) { sufP[i] = sufP[i + 1] * pts[i].p; sufV[i] = sufV[i + 1] * pts[i].v; }
  const firstAfter = (day) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].day <= day) lo = m + 1; else hi = m; } return lo; };
  return {
    events: pts,
    price: (day) => sufP[firstAfter(day)],
    vol: (day) => sufV[firstAfter(day)],
  };
}

/** 按日因子缩放一组 bar（日线或分时）。 */
export function scaleBars(bars, priceF, volF) {
  return bars.map((b) => {
    const d = dayOf(b.time), p = priceF(d), v = volF(d);
    return p === 1 && v === 1 ? b : { time: b.time, open: b.open * p, high: b.high * p, low: b.low * p, close: b.close * p, volume: b.volume * v };
  });
}

// ---- 聚合 -------------------------------------------------------------------------------
export function aggregate(daily, iv) {
  const weekday = (t) => new Date(t * 1000).getUTCDay();
  const key = iv === '1wk'
    ? (t) => t - ((weekday(t) + 6) % 7) * DAY
    : (t) => { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; };
  const out = [];
  let cur = null, ck = null;
  for (const b of daily) {
    const k = key(b.time);
    if (k !== ck) { if (cur) out.push(cur); ck = k; cur = { ...b }; }
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  if (cur) out.push(cur);
  return out;
}
