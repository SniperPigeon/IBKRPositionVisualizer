/* IBKR 交易回看 — 在 K 线上标注买卖点
 * 账单 CSV 在浏览器里解析；行情经本地 server.py 从 Yahoo 获取并缓存。 */
'use strict';
(() => {
const LWC = window.LightweightCharts;
const STATEMENT_TZ = 'America/New_York';   // IBKR 活动账单里的时间是美东时间
const MA_PERIODS = [5, 10, 20, 30];
const IV_SEC = { '60m': 3600, '15m': 900, '5m': 300 };
const DAY = 86400;

// ---------------------------------------------------------------- utils
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const s = String(v ?? '').replace(/,/g, '').trim(); return !s || s === '--' || s === '-' ? NaN : Number(s); };
const pad = (n) => String(n).padStart(2, '0');
const sum = (a) => a.reduce((x, y) => x + (Number.isFinite(y) ? y : 0), 0);
const fmt = (v, d = 2) => Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '--';
const fmtS = (v, d = 2) => Number.isFinite(v) ? (v > 0 ? '+' : '') + fmt(v, d) : '--';
const fmtQ = (v) => !Number.isFinite(v) ? '--' : Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v).toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 4 });
const fmtVol = (v) => { if (!Number.isFinite(v)) return '--'; const a = Math.abs(v); return a >= 1e8 ? (v / 1e8).toFixed(2) + '亿' : a >= 1e4 ? (v / 1e4).toFixed(2) + '万' : fmtQ(v); };
const cls = (v) => v > 0 ? 'up' : v < 0 ? 'down' : 'muted';
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const store = {
  get(k, d) { try { const v = localStorage.getItem('ibv.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ibv.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const WEEK = '日一二三四五六';
// "wall" 时间 = 某时区的本地时钟读数，按 UTC 存成秒（图表库按 UTC 显示，正好显示交易所本地时间）
const wd = (sec) => { const d = new Date(sec * 1000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), H: d.getUTCHours(), M: d.getUTCMinutes(), w: d.getUTCDay() }; };
const dateStr = (sec) => { const x = wd(sec); return `${x.y}-${pad(x.m)}-${pad(x.d)}`; };
const timeStr = (sec) => { const x = wd(sec); return `${pad(x.H)}:${pad(x.M)}`; };
const dayOf = (sec) => Math.floor(sec / DAY) * DAY;

const tzFmts = new Map(), tzOffs = new Map();
function rawWall(epoch, tz) {
  let f = tzFmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); tzFmts.set(tz, f); }
  const p = {}; for (const { type, value } of f.formatToParts(new Date(epoch * 1000))) p[type] = value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000;
}
function toWall(epoch, tz) {           // 时区偏移在同一个 UTC 小时内不变，按小时缓存
  const h = Math.floor(epoch / 3600), k = tz + h;
  let o = tzOffs.get(k);
  if (o === undefined) { o = rawWall(h * 3600, tz) - h * 3600; tzOffs.set(k, o); }
  return epoch + o;
}
function wallToEpoch(wall, tz) { let e = wall; for (let i = 0; i < 3; i++) e = wall - (toWall(e, tz) - e); return e; }
function parseWall(s) {
  const m = String(s ?? '').match(/(\d{4})-?(\d{2})-?(\d{2})(?:[,;\sT]+(\d{1,2}):?(\d{2}):?(\d{2})?)?/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) / 1000 : NaN;
}
function lowerBound(arr, t) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].time < t) lo = m + 1; else hi = m; } return lo; }
const lastLE = (arr, t) => lowerBound(arr, t + 1e-6) - 1;

// ---------------------------------------------------------------- CSV
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const SECTION = {
  '交易': 'trades', 'Trades': 'trades', '转账': 'transfers', 'Transfers': 'transfers',
  '未平仓持仓': 'positions', 'Open Positions': 'positions', '金融产品信息': 'info', 'Financial Instrument Information': 'info',
  '账户信息': 'account', 'Account Information': 'account', 'Statement': 'account',
};
const COLS = {
  disc: ['DataDiscriminator'], asset: ['资产分类', 'Asset Category', 'Asset Class'], cur: ['货币', 'Currency'],
  sym: ['代码', 'Symbol'], dt: ['日期/时间', 'Date/Time'], date: ['日期', 'Date'], qty: ['数量', 'Quantity', 'Qty'],
  price: ['交易价格', 'T. Price', 'Trade Price'], proceeds: ['收益', 'Proceeds'], realized: ['已实现的损益', 'Realized P/L'],
  code: ['代码', 'Code'], dir: ['方向', 'Direction'], mval: ['市场价值', 'Market Value'], cost: ['成本价格', 'Cost Price'],
  close: ['收盘价格', 'Close Price', 'C. Price'], desc: ['描述', 'Description'], under: ['底层', 'Underlying'],
  exch: ['上市交易所', 'Listing Exch'], fname: ['域名称', 'Field Name'], fval: ['域值', 'Field Value'],
};
function colIndex(h) {
  const ix = {};
  for (const [k, names] of Object.entries(COLS)) {
    let first = -1, last = -1;
    h.forEach((c, i) => { if (names.includes(c)) { if (first < 0) first = i; last = i; } });
    ix[k] = k === 'code' ? last : first;
  }
  if (ix.code === ix.sym) ix.code = -1;   // 中文账单里“代码”既是代码又是标记，只有一列时就是代码
  ix.comm = h.findIndex((c) => /^佣金|^Comm/.test(c));
  return ix;
}
function assetKind(a) {
  if (/期权|Option|^OPT$/i.test(a)) return 'option';
  if (/外汇|Forex|^CASH$/i.test(a)) return 'fx';
  if (/股票|Stock|^STK$/i.test(a)) return 'stock';
  return 'other';
}

function parseStatement(text, name) {
  const rows = parseCSV(text);
  if (!rows.some((r) => r[1] === 'Header')) return parseFlat(rows, name);
  const res = { name, trades: [], transfers: [], positions: [], info: [], account: {} };
  const hdr = {};
  for (const r of rows) {
    if (r.length < 3) continue;
    const sec = SECTION[r[0].trim()]; if (!sec) continue;
    const kind = r[1].trim();
    if (kind === 'Header') { hdr[sec] = colIndex(r.slice(2).map((x) => x.trim())); continue; }
    if (kind !== 'Data' || !hdr[sec]) continue;
    const ix = hdr[sec], v = r.slice(2);
    const g = (k) => (ix[k] >= 0 ? (v[ix[k]] ?? '').trim() : '');
    if (sec === 'trades') {
      const disc = g('disc');
      if (disc && !/^(Order|Trade|Execution)$/i.test(disc)) continue;
      const k = assetKind(g('asset'));
      if (k === 'other') continue;
      res.trades.push({ disc, kind: k, sym: g('sym'), cur: g('cur'), wall: parseWall(g('dt')), qty: num(g('qty')), price: num(g('price')),
        priceRaw: g('price'), proceeds: num(g('proceeds')), comm: ix.comm >= 0 ? num(v[ix.comm]) : NaN, realized: num(g('realized')), code: g('code') });
    } else if (sec === 'transfers') {
      if (assetKind(g('asset')) !== 'stock') continue;
      const q = Math.abs(num(g('qty'))); const out = /出|Out/i.test(g('dir'));
      res.transfers.push({ sym: g('sym'), cur: g('cur'), wall: parseWall(g('date')) + 12 * 3600, qty: out ? -q : q, mval: num(g('mval')) });
    } else if (sec === 'positions') {
      const disc = g('disc');
      if ((disc && disc !== 'Summary') || assetKind(g('asset')) !== 'stock') continue;
      res.positions.push({ sym: g('sym'), qty: num(g('qty')), cost: num(g('cost')), close: num(g('close')) });
    } else if (sec === 'info') {
      res.info.push({ sym: g('sym'), desc: g('desc'), exch: g('exch'), under: g('under') });
    } else if (sec === 'account') {
      res.account[g('fname')] = g('fval');
    }
  }
  if (res.trades.some((t) => /^Order$/i.test(t.disc))) res.trades = res.trades.filter((t) => /^Order$/i.test(t.disc));
  return res;
}

// Flex Query 之类的平铺 CSV（第一行是表头）
function parseFlat(rows, name) {
  const H = (rows[0] || []).map((s) => s.trim());
  const L = H.map((s) => s.toLowerCase().replace(/[^a-z]/g, ''));
  const f = (...n) => { for (const x of n) { const i = L.indexOf(x); if (i >= 0) return i; } return -1; };
  const I = { sym: f('symbol'), dt: f('datetime', 'tradedatetime'), d: f('tradedate', 'date'), t: f('tradetime'), q: f('quantity'),
    p: f('tradeprice', 'price'), a: f('assetclass', 'assetcategory'), c: f('currencyprimary', 'currency'), comm: f('ibcommission', 'commission', 'commfee'),
    r: f('fifopnlrealized', 'realizedpnl', 'realizedpl'), pr: f('proceeds'), code: f('notescodes', 'code', 'opencloseindicator'),
    bs: f('buysell'), lvl: f('levelofdetail'), u: f('underlyingsymbol') };
  if (I.sym < 0 || I.q < 0 || I.p < 0 || (I.dt < 0 && I.d < 0)) throw new Error(`${name}：不是 IBKR 活动账单，也找不到 Symbol / Quantity / TradePrice / Date 列`);
  const res = { name, trades: [], transfers: [], positions: [], info: [], account: {} };
  const hdrKey = H.join(',');
  for (const r of rows.slice(1)) {
    if (r.length < H.length - 2 || r.map((s) => s.trim()).join(',') === hdrKey) continue;
    const g = (i) => (i >= 0 ? (r[i] ?? '').trim() : '');
    const lvl = g(I.lvl).toUpperCase();
    if (lvl && !['ORDER', 'EXECUTION'].includes(lvl)) continue;
    const k = I.a >= 0 ? assetKind(g(I.a)) : 'stock'; if (k === 'other') continue;
    let qty = num(g(I.q)); if (/^S/i.test(g(I.bs)) && qty > 0) qty = -qty;
    const wall = I.dt >= 0 ? parseWall(g(I.dt)) : parseWall(`${g(I.d)} ${g(I.t)}`);
    if (!Number.isFinite(wall) || !Number.isFinite(qty)) continue;
    res.trades.push({ disc: lvl, kind: k, sym: g(I.sym), under: k === 'option' ? g(I.u) : '', cur: g(I.c), wall, qty, price: num(g(I.p)), priceRaw: g(I.p),
      proceeds: num(g(I.pr)), comm: num(g(I.comm)), realized: num(g(I.r)), code: g(I.code) });
  }
  if (res.trades.some((t) => t.disc === 'ORDER')) res.trades = res.trades.filter((t) => t.disc === 'ORDER');
  return res;
}

// ---------------------------------------------------------------- model
const S = {
  trades: [], transfers: [], positions: {}, info: {}, account: {}, files: [], seen: new Set(), asOf: {},
  insts: new Map(), cur: null, iv: store.get('iv', '1d'),
  bars: [], daily: [], tz: STATEMENT_TZ, splits: [], meta: {}, groups: new Map(), ind: null, pos: null, src: null, hl: null,
};
const overrides = store.get('yahoo', {});

function ingest(res) {
  const gen = parseWall(res.account.WhenGenerated || res.account['生成时间']) || Date.now() / 1000;
  for (const t of res.trades) {
    if (!Number.isFinite(t.wall) || !Number.isFinite(t.qty) || !t.qty) continue;
    const key = ['T', t.sym, t.wall, t.qty, t.price].join('|');
    if (S.seen.has(key)) continue;
    S.seen.add(key);
    t.epoch = wallToEpoch(t.wall, STATEMENT_TZ);
    if (t.kind === 'option') {
      const m = t.sym.match(/^(\S+)\s+(\d{2}[A-Z]{3}\d{2})\s+([\d.]+)\s+([CP])$/);
      t.under = t.under || (m ? m[1] : t.sym.split(/\s+/)[0]);
      t.right = m ? m[4] : (/C/.test(t.sym.slice(-9)) ? 'C' : 'P');
    }
    S.trades.push(t);
  }
  for (const x of res.transfers) {
    const key = ['X', x.sym, x.wall, x.qty].join('|');
    if (S.seen.has(key) || !Number.isFinite(x.wall)) continue;
    S.seen.add(key);
    x.epoch = wallToEpoch(x.wall, STATEMENT_TZ);
    S.transfers.push(x);
  }
  // 持仓以最新一份账单为准
  const latest = !S.asOf.positions || gen >= S.asOf.positions;
  if (latest && res.positions.length + res.trades.length) {
    S.asOf.positions = gen; S.positions = {};
    for (const p of res.positions) S.positions[p.sym] = { ...p, asOf: gen };
    S.account = { ...S.account, ...res.account };
  } else {
    S.account = { ...res.account, ...S.account };
  }
  for (const i of res.info) if (i.sym) S.info[i.sym] = i;
  S.files.push(res.name);
}

function yahooSymbol(x) {
  if (x.kind === 'fx') { const [b, q] = x.key.split('.'); return `${b}${q}=X`; }
  const s = x.key.replace(/\s+/g, '-');
  const ex = (x.exch || '').toUpperCase();
  if (x.cur === 'HKD' || ex === 'SEHK') return s.padStart(4, '0') + '.HK';
  if (x.cur === 'SGD' || ex === 'SGX') return s + '.SI';
  if (x.cur === 'CAD') return s + '.TO';
  if (x.cur === 'AUD') return s + '.AX';
  if (x.cur === 'GBP') return s + '.L';
  if (x.cur === 'JPY') return s + '.T';
  return s;
}

function buildInstruments() {
  const m = new Map();
  const get = (key, kind, cur) => {
    let x = m.get(key);
    if (!x) { x = { key, kind, cur, trades: [], opts: [], xfers: [] }; m.set(key, x); }
    return x;
  };
  for (const t of S.trades) {
    if (t.kind === 'option') get(t.under, 'stock', t.cur).opts.push(t);
    else get(t.sym, t.kind, t.cur).trades.push(t);
  }
  for (const x of S.transfers) get(x.sym, 'stock', x.cur).xfers.push(x);
  const by = (a, b) => a.epoch - b.epoch;
  for (const x of m.values()) {
    x.trades.sort(by); x.opts.sort(by); x.xfers.sort(by);
    const all = [...x.trades, ...x.opts, ...x.xfers];
    x.first = Math.min(...all.map((t) => t.epoch));
    x.last = Math.max(...all.map((t) => t.epoch));
    x.realized = sum(x.trades.map((t) => t.realized));
    x.optRealized = sum(x.opts.map((t) => t.realized));
    const closes = [...x.trades, ...x.opts].filter((t) => Number.isFinite(t.realized) && Math.abs(t.realized) > 1e-9);
    x.wins = closes.filter((t) => t.realized > 0).length; x.closes = closes.length;
    const info = S.info[x.key] || {};
    x.name = info.desc || ''; x.exch = info.exch || '';
    const p = S.positions[x.key];
    x.pos = p ? p.qty : 0; x.cost = p ? p.cost : NaN; x.posAsOf = p ? p.asOf : null;
    x.yahoo = overrides[x.key] || yahooSymbol(x);
  }
  S.insts = m;
}

// ---------------------------------------------------------------- sidebar / header
function renderAcct() {
  const a = S.account;
  const id = a['账户'] || a.Account || '';
  const masked = id.length > 5 ? id.slice(0, 4) + '•••' + id.slice(-2) : id;
  const all = [...S.insts.values()];
  const byCur = {};
  for (const x of all) byCur[x.cur || '?'] = (byCur[x.cur || '?'] || 0) + x.realized + x.optRealized;
  const n = sum(all.map((x) => x.trades.length + x.opts.length));
  const wins = sum(all.map((x) => x.wins)), closes = sum(all.map((x) => x.closes));
  const pl = Object.entries(byCur).filter(([, v]) => Math.abs(v) > 0.005)
    .map(([c, v]) => `<b class="num ${cls(v)}">${fmtS(v)}</b> ${esc(c)}`).join(' · ') || '<b>0</b>';
  $('#acct').innerHTML = `
    <div class="row"><span>${esc(masked)}${a['基础货币'] || a['Base Currency'] ? ' · ' + esc(a['基础货币'] || a['Base Currency']) : ''}</span><span>${S.files.length} 份账单</span></div>
    <div>${esc(a.Period || a['期间'] || '')}</div>
    <div class="row"><span>已实现</span><span>${pl}</span></div>
    <div class="row"><span>成交 <b class="num">${n}</b> 笔</span><span>胜率 <b class="num">${closes ? Math.round((wins / closes) * 100) : '--'}%</b> <span class="muted">(${wins}/${closes})</span></span></div>`;
}

function sideOrder() {
  const q = $('#q').value.trim().toUpperCase();
  const list = [...S.insts.values()].filter((x) => !q || x.key.toUpperCase().includes(q) || x.name.toUpperCase().includes(q));
  const by = (a, b) => b.last - a.last;
  return [
    ['持仓中', list.filter((x) => x.kind !== 'fx' && Math.abs(x.pos) > 1e-9).sort(by)],
    ['已清仓', list.filter((x) => x.kind !== 'fx' && Math.abs(x.pos) <= 1e-9).sort(by)],
    ['外汇', list.filter((x) => x.kind === 'fx').sort(by)],
  ].filter(([, l]) => l.length);
}
function renderSide() {
  let h = '';
  for (const [g, l] of sideOrder()) {
    h += `<li class="grp">${g} · ${l.length}</li>`;
    for (const x of l) {
      const pl = x.realized + x.optRealized;
      const sub = [`${x.trades.length + x.opts.length} 笔`];
      if (Math.abs(x.pos) > 1e-9) sub.push(`持 ${fmtQ(x.pos)}`);
      if (x.opts.length) sub.push(`期权 ${x.opts.length}`);
      if (x.name) sub.push(esc(x.name));
      h += `<li data-k="${esc(x.key)}" class="${x.key === S.cur ? 'on' : ''}"><span class="s">${esc(x.key)}</span>
        <span class="pl num ${cls(pl)}">${Math.abs(pl) > 0.005 ? fmtS(pl) : ''}</span><span class="sub">${sub.join(' · ')}</span></li>`;
    }
  }
  $('#symlist').innerHTML = h || '<li class="grp">没有匹配的代码</li>';
}

function renderHeader() {
  const x = S.insts.get(S.cur); if (!x) return;
  $('#hSym').textContent = x.key;
  $('#hName').textContent = x.name || S.meta.longName || S.meta.shortName || '';
  $('#ysym').value = x.yahoo;
  const d = S.daily, n = d.length, dg = digits(x);
  if (n >= 2) {
    const c = d[n - 1].close, p = d[n - 2].close, ch = c - p;
    $('#hPx').textContent = fmt(c, dg);
    $('#hPx').className = 'px num ' + cls(ch);
    $('#hChg').innerHTML = `<span class="${cls(ch)}">${fmtS(ch, dg)} ${fmtS((ch / p) * 100)}%</span> <span class="muted">${dateStr(d[n - 1].time)}</span>`;
  } else { $('#hPx').textContent = ''; $('#hChg').textContent = ''; }
  const st = [];
  if (x.kind !== 'fx') {
    const last = n ? d[n - 1].close : NaN;
    const hold = Math.abs(x.pos) > 1e-9;
    st.push(['持仓', hold ? `${fmtQ(x.pos)} 股` : '已清仓', '']);
    if (hold && Number.isFinite(x.cost)) {
      st.push(['成本', fmt(x.cost / splitFactor(x.posAsOf), dg), '']);
      const upl = (last - x.cost / splitFactor(x.posAsOf)) * x.pos * splitFactor(x.posAsOf);
      st.push(['浮动盈亏', `${fmtS(upl)} (${fmtS(((last * splitFactor(x.posAsOf)) / x.cost - 1) * 100)}%)`, cls(upl)]);
    }
    st.push(['已实现', fmtS(x.realized), cls(x.realized)]);
    if (x.opts.length) st.push(['期权已实现', fmtS(x.optRealized), cls(x.optRealized)]);
  }
  st.push(['成交', `${x.trades.length + x.opts.length} 笔`, '']);
  if (x.closes) st.push(['胜率', `${Math.round((x.wins / x.closes) * 100)}% (${x.wins}/${x.closes})`, '']);
  $('#stats').innerHTML = st.map(([k, v, c]) => `<div class="stat"><span class="k">${k}</span><span class="v num ${c}">${v}</span></div>`).join('');
}
const digits = (x) => (x && x.kind === 'fx' ? 4 : 2);

// ---------------------------------------------------------------- data
const memo = new Map();
async function fetchSeries(sym, iv, p1, refresh) {
  const k = `${sym}|${iv}`, hit = memo.get(k);
  if (!refresh && hit && Date.now() - hit.at < 60_000 && hit.p1 <= p1) return hit.data;
  const r = await fetch(`/api/chart?symbol=${encodeURIComponent(sym)}&interval=${iv}&period1=${Math.floor(p1)}${refresh ? '&refresh=1' : ''}`);
  let js; try { js = await r.json(); } catch { throw new Error(`行情服务返回异常 (HTTP ${r.status})`); }
  if (!r.ok) throw new Error(js.error || `HTTP ${r.status}`);
  memo.set(k, { at: Date.now(), p1, data: js });
  return js;
}

function toBars(js, daily) {
  const tz = js.meta.exchangeTimezoneName || STATEMENT_TZ;
  const out = [];
  for (const [t, o, h, l, c, v] of js.bars) {
    const w = toWall(t, tz), time = daily ? dayOf(w) : w;
    const b = { time, open: o, high: h, low: l, close: c, volume: v };
    const last = out[out.length - 1];
    if (last && time <= last.time) { if (time === last.time) out[out.length - 1] = b; continue; }
    out.push(b);
  }
  const splits = (js.splits || []).map(([t, n, d]) => ({ day: dayOf(toWall(t, tz)), ratio: n / d })).filter((s) => s.ratio > 0);
  return { bars: out, tz, splits };
}
function aggregate(d, iv) {
  const key = iv === '1wk' ? (t) => t - ((wd(t).w + 6) % 7) * DAY : (t) => { const x = wd(t); return Date.UTC(x.y, x.m - 1, 1) / 1000; };
  const out = []; let cur = null, ck = null;
  for (const b of d) {
    const k = key(b.time);
    if (k !== ck) { if (cur) out.push(cur); ck = k; cur = { ...b }; }
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  if (cur) out.push(cur);
  return out;
}

// 交易日（交易所时区）。美股 20:00 ET 之后的隔夜盘算下一个交易日。
function tradeDay(epoch) {
  const w = toWall(epoch, S.tz);
  return dayOf(w) + (S.tz === 'America/New_York' && wd(w).H >= 20 ? DAY : 0);
}
function splitFactor(epochOrNull) {
  if (epochOrNull == null) return 1;
  const d = tradeDay(epochOrNull);
  let f = 1; for (const s of S.splits) if (s.day > d) f *= s.ratio;
  return f;
}
function mapToBar(epoch) {
  const bars = S.bars; if (!bars.length) return -1;
  if (!IV_SEC[S.iv]) {
    const d = tradeDay(epoch), daily = S.daily;
    if (!daily.length || d < daily[0].time - 5 * DAY) return -1;
    const i = lowerBound(daily, d);
    if (i >= daily.length) return -1;
    return S.iv === '1d' ? i : lastLE(bars, daily[i].time);
  }
  const w = toWall(epoch, S.tz), sec = IV_SEC[S.iv];
  let i = lastLE(bars, w);
  if (i < 0) return -1;
  if (w - bars[i].time >= sec) { if (i + 1 < bars.length) i++; else return -1; }
  return i;
}

function buildGroups() {
  const x = S.insts.get(S.cur);
  const groups = new Map();
  const g = (i) => { let v = groups.get(i); if (!v) { v = { B: [], S: [], X: [], OB: [], OS: [] }; groups.set(i, v); } return v; };
  let out = 0;
  for (const t of x.trades) {
    const f = splitFactor(t.epoch);
    t.adjPrice = t.price / f; t.adjQty = t.qty * f; t._bar = mapToBar(t.epoch);
    if (t._bar < 0) { out++; continue; }
    g(t._bar)[t.qty > 0 ? 'B' : 'S'].push(t);
  }
  for (const t of x.xfers) {
    const f = splitFactor(t.epoch);
    t.adjQty = t.qty * f; t.adjPrice = Math.abs(t.mval / t.qty) / f; t._bar = mapToBar(t.epoch);
    if (t._bar >= 0 && $('#tgXfer').checked) g(t._bar).X.push(t);
  }
  for (const t of x.opts) {
    t._bar = mapToBar(t.epoch);
    if (t._bar >= 0 && $('#tgOpt').checked) g(t._bar)[t.qty > 0 ? 'OB' : 'OS'].push(t);
  }
  S.groups = groups; S.outOfRange = out;
}

// 持仓曲线：用最新账单的持仓倒推期初持仓，再按成交累加
function buildPosition() {
  const x = S.insts.get(S.cur), n = S.bars.length;
  if (x.kind === 'fx' || !n) return null;
  const ev = [...x.trades, ...x.xfers];
  const final = x.pos * splitFactor(x.posAsOf);
  let base = final - sum(ev.map((e) => e.adjQty));
  const delta = new Float64Array(n);
  const firstT = S.bars[0].time;
  for (const e of ev) {
    if (e._bar >= 0) delta[e._bar] += e.adjQty;
    else if (toWall(e.epoch, S.tz) < firstT) base += e.adjQty;
  }
  const out = new Array(n); let c = base;
  for (let i = 0; i < n; i++) { c += delta[i]; out[i] = Math.abs(c) < 1e-6 ? 0 : c; }
  return out;
}

function indicators(bars) {
  const c = bars.map((b) => b.close), n = c.length;
  const ma = MA_PERIODS.map((p) => { const o = new Array(n).fill(null); let s = 0; for (let i = 0; i < n; i++) { s += c[i]; if (i >= p) s -= c[i - p]; if (i >= p - 1) o[i] = s / p; } return o; });
  const ema = (v, p) => { const k = 2 / (p + 1); let e = v[0]; return v.map((x, i) => (e = i ? x * k + e * (1 - k) : x)); };
  const e12 = ema(c, 12), e26 = ema(c, 26);
  const dif = c.map((_, i) => e12[i] - e26[i]), dea = ema(dif, 9);
  return { ma, dif, dea, macd: dif.map((v, i) => 2 * (v - dea[i])) };
}

// ---------------------------------------------------------------- chart
let chart, candle, maS, vol, macdH, difS, deaS, posS, costLine = null;
function updown() { const g = css('--up'), r = css('--down'); return $('#tgRedUp').checked ? { up: r, down: g } : { up: g, down: r }; }
function tickFmt(t, type) {
  const x = wd(t);
  if (type === 0) return String(x.y);
  if (type === 1) return x.m === 1 ? String(x.y) : `${x.m}月`;
  if (type === 2) return `${pad(x.m)}/${pad(x.d)}`;
  return `${pad(x.H)}:${pad(x.M)}`;
}
function timeFmt(t) {
  const x = wd(t);
  if (IV_SEC[S.iv]) return `${pad(x.m)}/${pad(x.d)} ${pad(x.H)}:${pad(x.M)}`;
  return `${x.y}/${pad(x.m)}/${pad(x.d)} 周${WEEK[x.w]}`;
}
function makeChart() {
  chart = LWC.createChart($('#chart'), {
    autoSize: true,
    layout: { fontSize: 11, fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif', panes: { enableResize: true } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.12 } },
    timeScale: { borderVisible: false, rightOffset: 4, barSpacing: 7, minBarSpacing: 0.5, tickMarkFormatter: tickFmt },
    crosshair: { mode: LWC.CrosshairMode.Normal },
    localization: { locale: 'zh-CN', timeFormatter: timeFmt },
  });
  const line = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
  candle = chart.addSeries(LWC.CandlestickSeries, { borderVisible: false, priceLineStyle: 2 }, 0);
  maS = MA_PERIODS.map(() => chart.addSeries(LWC.LineSeries, line, 0));
  vol = chart.addSeries(LWC.HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 1);
  macdH = chart.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, 2);
  difS = chart.addSeries(LWC.LineSeries, line, 2);
  deaS = chart.addSeries(LWC.LineSeries, line, 2);
  posS = chart.addSeries(LWC.LineSeries, { lineWidth: 2, lineType: LWC.LineType.WithSteps, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false }, 3);
  vol.priceScale().applyOptions({ scaleMargins: { top: 0.18, bottom: 0 } });
  posS.priceScale().applyOptions({ scaleMargins: { top: 0.25, bottom: 0.1 } });
  const panes = chart.panes();
  [6, 1.3, 1.6, 1.1].forEach((f, i) => panes[i] && panes[i].setStretchFactor(f));
  chart.subscribeCrosshairMove(onCrosshair);
  applyTheme();
}
function applyTheme() {
  if (!chart) return;
  const C = updown();
  chart.applyOptions({
    layout: { background: { type: 'solid', color: css('--bg') }, textColor: css('--muted'), panes: { separatorColor: css('--line'), separatorHoverColor: css('--panel-2') } },
    grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
    crosshair: { vertLine: { color: css('--faint'), labelBackgroundColor: css('--panel-2') }, horzLine: { color: css('--faint'), labelBackgroundColor: css('--panel-2') } },
  });
  candle.applyOptions({ upColor: C.up, downColor: C.down, wickUpColor: C.up, wickDownColor: C.down });
  maS.forEach((s, i) => s.applyOptions({ color: css(`--ma${MA_PERIODS[i]}`) }));
  difS.applyOptions({ color: css('--dif') }); deaS.applyOptions({ color: css('--dea') });
  posS.applyOptions({ color: css('--pos') });
  if (S.bars.length) setSeriesData(true);
  drawCostLine(); dirty = true;
}
function setSeriesData(colorsOnly = false) {
  const b = S.bars, I = S.ind, C = updown(), x = S.insts.get(S.cur), dg = digits(x);
  if (!colorsOnly) {
    candle.applyOptions({ priceFormat: { type: 'price', precision: dg, minMove: 1 / 10 ** dg } });
    candle.setData(b.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    MA_PERIODS.forEach((_, k) => maS[k].setData(b.map((r, i) => (I.ma[k][i] == null ? { time: r.time } : { time: r.time, value: I.ma[k][i] }))));
    difS.setData(b.map((r, i) => ({ time: r.time, value: I.dif[i] })));
    deaS.setData(b.map((r, i) => ({ time: r.time, value: I.dea[i] })));
    const frac = S.pos && S.pos.some((v) => Math.abs(v - Math.round(v)) > 1e-6);
    posS.applyOptions({ priceFormat: { type: 'price', precision: frac ? 2 : 0, minMove: frac ? 0.01 : 1 } });
    posS.setData(S.pos ? b.map((r, i) => ({ time: r.time, value: S.pos[i] })) : []);
  }
  vol.setData(b.map((r) => ({ time: r.time, value: r.volume, color: r.close >= r.open ? C.up : C.down })));
  macdH.setData(b.map((r, i) => ({ time: r.time, value: I.macd[i], color: I.macd[i] >= 0 ? C.up : C.down })));
}
function drawCostLine() {
  if (costLine) { candle.removePriceLine(costLine); costLine = null; }
  const x = S.insts.get(S.cur);
  if (!x || !S.bars.length || !$('#tgCost').checked || Math.abs(x.pos) < 1e-9 || !Number.isFinite(x.cost)) return;
  costLine = candle.createPriceLine({ price: x.cost / splitFactor(x.posAsOf), color: css('--accent'), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '成本' });
}
function initialRange() {
  const n = S.bars.length, idx = [...S.groups.keys()];
  let from, to;
  if (!idx.length) { to = n + 3; from = n - 150; }
  else if (IV_SEC[S.iv]) { const last = Math.max(...idx); from = last - 220; to = Math.min(n + 3, last + 60); }
  else { from = Math.min(...idx) - 15; to = n + 3; if (to - from < 90) from = to - 90; }
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(-3, from), to });
}

// ---------------------------------------------------------------- overlay (买卖点)
let dirty = true, lastSig = '';
function draw() {
  const svg = $('#overlay');
  if (!S.bars.length) { svg.innerHTML = ''; return; }
  const ts = chart.timeScale(), r = ts.getVisibleLogicalRange(), ps = chart.paneSize(0);
  svg.setAttribute('width', ps.width); svg.setAttribute('height', ps.height);
  if (!r) return;
  const n = S.bars.length;
  const from = Math.max(0, Math.floor(r.from)), to = Math.min(n - 1, Math.ceil(r.to));
  const sp = to > from ? (ts.logicalToCoordinate(to) - ts.logicalToCoordinate(from)) / (to - from) : 8;
  const C = updown(), bg = css('--bg'), muted = css('--muted'), xfer = css('--xfer'), opt = css('--opt'), accent = css('--accent');
  const s = Math.max(12, Math.min(17, sp * 0.9 + 7));
  const compact = sp < 4;
  const Y = (p) => candle.priceToCoordinate(p);
  const hl = S.hl && Date.now() < S.hl.until ? S.hl : null;
  let o = '';

  if ($('#tgHiLo').checked && to >= from) {
    let hi = from, lo = from;
    for (let i = from; i <= to; i++) { if (S.bars[i].high > S.bars[hi].high) hi = i; if (S.bars[i].low < S.bars[lo].low) lo = i; }
    const dg = digits(S.insts.get(S.cur));
    for (const [i, p, dy] of [[hi, S.bars[hi].high, -1], [lo, S.bars[lo].low, 1]]) {
      const x = ts.logicalToCoordinate(i), y = Y(p); if (x == null || y == null) continue;
      const right = x < ps.width * 0.7, x2 = x + (right ? 22 : -22);
      o += `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y + dy * 2}" stroke="${muted}" stroke-width="1"/>
        <text x="${x2 + (right ? 3 : -3)}" y="${y + dy * 2}" dy="0.35em" text-anchor="${right ? 'start' : 'end'}" font-size="11" fill="${muted}">${fmt(p, dg)}</text>`;
    }
  }

  const badge = (letter, color, x, cy, up, key, count, ring) => {
    const x0 = x - s / 2, y0 = cy - s / 2;
    const tri = up ? `M${x - 3.5},${y0 + 1} L${x},${y0 - 4} L${x + 3.5},${y0 + 1}Z` : `M${x - 3.5},${y0 + s - 1} L${x},${y0 + s + 4} L${x + 3.5},${y0 + s - 1}Z`;
    return `<g class="mk" data-key="${key}">
      ${ring ? `<rect x="${x0 - 4}" y="${y0 - 4}" width="${s + 8}" height="${s + 8}" rx="${s * 0.4}" fill="none" stroke="${accent}" stroke-width="2"/>` : ''}
      <path d="${tri}" fill="${color}"/><rect x="${x0}" y="${y0}" width="${s}" height="${s}" rx="${s * 0.26}" fill="${color}"/>
      <text x="${x}" y="${cy}" dy="0.36em" text-anchor="middle" font-size="${s * 0.62}" font-weight="700" fill="#fff">${letter}</text>
      ${count > 1 ? `<circle cx="${x0 + s}" cy="${y0}" r="${s * 0.33}" fill="${bg}" stroke="${color}" stroke-width="1"/>
        <text x="${x0 + s}" y="${y0}" dy="0.35em" text-anchor="middle" font-size="${s * 0.42}" font-weight="700" fill="${color}">${count > 9 ? '9+' : count}</text>` : ''}</g>`;
  };
  const tiny = (color, x, y, up, key) => `<g class="mk" data-key="${key}"><path d="${up ? `M${x - 4},${y + 6} L${x},${y} L${x + 4},${y + 6}Z` : `M${x - 4},${y - 6} L${x},${y} L${x + 4},${y - 6}Z`}" fill="${color}"/></g>`;

  for (const [i, g] of S.groups) {
    if (i < from - 1 || i > to + 1) continue;
    const x = ts.logicalToCoordinate(i); if (x == null) continue;
    const b = S.bars[i], yH = Y(b.high), yL = Y(b.low); if (yH == null || yL == null) continue;
    let below = yL + 4, above = yH - 4;
    const put = (list, side, letter, color, isBelow, stem) => {
      if (!list.length) return;
      const key = `${i}:${side}`, ring = hl && hl.i === i && hl.side === side;
      if (compact) {
        if (isBelow) { o += tiny(color, x, below + 2, true, key); below += 9; } else { o += tiny(color, x, above - 2, false, key); above -= 9; }
        return;
      }
      const ys = stem ? list.map((t) => Y(t.adjPrice)).filter((y) => y != null) : [];
      if (isBelow) {
        const cy = Math.max(below, ...ys) + 6 + s / 2;
        if (ys.length) o += `<line x1="${x}" y1="${Math.min(...ys)}" x2="${x}" y2="${cy - s / 2 - 4}" stroke="${color}" stroke-width="1" stroke-dasharray="2 2"/>`;
        o += ys.map((y) => `<circle cx="${x}" cy="${y}" r="2.6" fill="${bg}" stroke="${color}" stroke-width="1.5"/>`).join('');
        o += badge(letter, color, x, cy, true, key, list.length, ring);
        below = cy + s / 2 + 2;
      } else {
        const cy = Math.min(above, ...ys) - 6 - s / 2;
        if (ys.length) o += `<line x1="${x}" y1="${Math.max(...ys)}" x2="${x}" y2="${cy + s / 2 + 4}" stroke="${color}" stroke-width="1" stroke-dasharray="2 2"/>`;
        o += ys.map((y) => `<circle cx="${x}" cy="${y}" r="2.6" fill="${bg}" stroke="${color}" stroke-width="1.5"/>`).join('');
        o += badge(letter, color, x, cy, false, key, list.length, ring);
        above = cy - s / 2 - 2;
      }
    };
    put(g.B, 'B', 'B', C.up, true, true);
    put(g.S, 'S', 'S', C.down, false, true);
    put(g.X.filter((t) => t.qty > 0), 'XI', '转', xfer, true, false);
    put(g.X.filter((t) => t.qty < 0), 'XO', '转', xfer, false, false);
    const optLetter = (l) => (l.length && l.every((t) => t.right === l[0].right) ? l[0].right : '期');
    put(g.OB, 'OB', optLetter(g.OB), opt, true, false);
    put(g.OS, 'OS', optLetter(g.OS), opt, false, false);
  }
  svg.innerHTML = o;
}

function tipHtml(key) {
  const [iStr, side] = key.split(':'); const i = +iStr, g = S.groups.get(i); if (!g) return '';
  const list = { B: g.B, S: g.S, XI: g.X.filter((t) => t.qty > 0), XO: g.X.filter((t) => t.qty < 0), OB: g.OB, OS: g.OS }[side] || [];
  const x = S.insts.get(S.cur), dg = digits(x);
  const title = { B: '买入', S: '卖出', XI: '转入', XO: '转出', OB: '期权 买入', OS: '期权 卖出' }[side];
  const color = { B: updown().up, S: updown().down, XI: css('--xfer'), XO: css('--xfer'), OB: css('--opt'), OS: css('--opt') }[side];
  let rows = '';
  for (const t of list) {
    const tm = side.startsWith('X') ? dateStr(t.wall) : `${dateStr(t.wall).slice(5)} ${timeStr(t.wall)}`;
    if (side.startsWith('X')) {
      rows += `<tr><td>${tm}</td><td class="r num">${fmtS(t.qty, 0)} 股</td><td class="r num">市值 ${fmt(t.mval)}</td></tr>`;
    } else {
      const label = side.startsWith('O') ? `<td>${esc(t.sym.replace(x.key + ' ', ''))}</td>` : '';
      const adj = !side.startsWith('O') && Math.abs(t.adjPrice - t.price) > 1e-9 ? ` <span class="muted">(复权 ${fmt(t.adjPrice, dg)})</span>` : '';
      const rl = Number.isFinite(t.realized) && Math.abs(t.realized) > 1e-9 ? `<td class="r num ${cls(t.realized)}">${fmtS(t.realized)}</td>` : '<td></td>';
      rows += `<tr><td class="muted">${tm}</td>${label}<td class="r num">${fmtS(t.qty, Number.isInteger(t.qty) ? 0 : 4)}</td><td class="r num">@ ${esc(t.priceRaw || fmt(t.price, dg))}${adj}</td>${rl}</tr>`;
    }
  }
  const q = sum(list.map((t) => t.qty));
  const vw = sum(list.map((t) => t.qty * t.price)) / q;
  const rl = sum(list.map((t) => t.realized));
  const foot = side.startsWith('X') ? '' : `<div class="sum">合计 <b class="num">${fmtS(q, Number.isInteger(q) ? 0 : 4)}</b>${list.length > 1 ? ` · 均价 <b class="num">${fmt(vw, side.startsWith('O') ? 2 : dg)}</b>` : ''}${Math.abs(rl) > 1e-9 ? ` · 已实现 <b class="num ${cls(rl)}">${fmtS(rl)}</b>` : ''}</div>`;
  return `<div class="h"><span><span style="color:${color}">●</span> ${title} · ${list.length} 笔</span><span class="muted">${timeFmt(S.bars[i].time)}</span></div><table>${rows}</table>${foot}`;
}

// ---------------------------------------------------------------- legends & info
function placeLegends() {
  const h = [0, 1, 2].map((i) => chart.paneSize(i).height);
  $('#lgMain').style.top = '4px';
  $('#lgVol').style.top = `${h[0] + 4}px`;
  $('#lgMacd').style.top = `${h[0] + h[1] + 5}px`;
  $('#lgPos').style.top = `${h[0] + h[1] + h[2] + 6}px`;
}
function updateLegends(i) {
  const b = S.bars[i]; if (!b) return;
  const I = S.ind, x = S.insts.get(S.cur), dg = digits(x);
  const v = (val, d = dg) => (val == null || !Number.isFinite(val) ? '--' : fmt(val, d));
  $('#lgMain').innerHTML = MA_PERIODS.map((p, k) => `<span style="color:${css(`--ma${p}`)}">MA${p}:${v(I.ma[k][i], 3)}</span>`).join('');
  $('#lgVol').innerHTML = `<span class="muted">成交量</span><span style="color:${b.close >= b.open ? updown().up : updown().down}">VOL:${fmtVol(b.volume)}</span>`;
  $('#lgMacd').innerHTML = `<span class="muted">MACD(12,26,9)</span><span style="color:${css('--dif')}">DIF:${v(I.dif[i], 3)}</span><span style="color:${css('--dea')}">DEA:${v(I.dea[i], 3)}</span><span style="color:${I.macd[i] >= 0 ? updown().up : updown().down}">MACD:${v(I.macd[i], 3)}</span>`;
  $('#lgPos').innerHTML = S.pos ? `<span class="muted">持仓</span><span style="color:${css('--pos')}">${fmtQ(S.pos[i])}</span>` : '';
  const prev = i > 0 ? S.bars[i - 1].close : b.open, ch = b.close - prev;
  const c = (val) => `<b class="num ${cls(val - prev)}">${fmt(val, dg)}</b>`;
  $('#info').innerHTML = `<span>${timeFmt(b.time)}</span><span>开 ${c(b.open)}</span><span>高 ${c(b.high)}</span><span>低 ${c(b.low)}</span><span>收 ${c(b.close)}</span>
    <span>涨跌 <b class="num ${cls(ch)}">${fmtS(ch, dg)} (${fmtS((ch / prev) * 100)}%)</b></span><span>振幅 <b class="num">${fmt(((b.high - b.low) / prev) * 100)}%</b></span>
    <span>量 <b class="num">${fmtVol(b.volume)}</b></span>${srcLabel()}`;
}
function srcLabel() {
  if (!S.src) return '';
  const t = new Date(S.src.fetched_at * 1000), hm = `${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const txt = S.src.source === 'stale' ? `⚠ Yahoo 不可达，使用本地缓存 (${hm})` : S.src.source === 'cache' ? `行情：本地缓存 · ${hm} 更新` : `行情：Yahoo · ${hm} 更新`;
  return `<span class="src" title="${esc(S.src.error || '')}">${txt}</span>`;
}
function onCrosshair(p) {
  if (!S.bars.length) return;
  let i = S.bars.length - 1;
  if (p && p.point && p.logical != null) i = Math.max(0, Math.min(S.bars.length - 1, Math.round(p.logical)));
  updateLegends(i);
}

// ---------------------------------------------------------------- table
function renderTable() {
  const x = S.insts.get(S.cur); if (!x) return;
  const C = updown(), xferC = css('--xfer'), optC = css('--opt'), dg = digits(x);
  const rows = [...x.trades, ...($('#tgXfer').checked ? x.xfers : []), ...($('#tgOpt').checked ? x.opts : [])].sort((a, b) => b.epoch - a.epoch);
  const pill = (txt, c) => `<span class="side-pill" style="background:${c}">${txt}</span>`;
  $('#tbody').innerHTML = rows.map((t) => {
    const isX = t.mval !== undefined, isO = t.kind === 'option';
    const side = isX ? (t.qty > 0 ? 'XI' : 'XO') : isO ? (t.qty > 0 ? 'OB' : 'OS') : t.qty > 0 ? 'B' : 'S';
    const p = isX ? pill(t.qty > 0 ? '转入' : '转出', xferC) : isO ? pill(t.qty > 0 ? '买' + t.right : '卖' + t.right, optC) : pill(t.qty > 0 ? '买入' : '卖出', t.qty > 0 ? C.up : C.down);
    const adjQ = t.adjQty !== undefined && Math.abs(t.adjQty - t.qty) > 1e-9 ? `<span class="adj">≈${fmtQ(t.adjQty)}</span>` : '';
    const adjP = !isX && !isO && t.adjPrice !== undefined && Math.abs(t.adjPrice - t.price) > 1e-9 ? `<span class="adj">复权 ${fmt(t.adjPrice, dg)}</span>` : '';
    const rl = Number.isFinite(t.realized) && Math.abs(t.realized) > 1e-9 ? `<span class="${cls(t.realized)}">${fmtS(t.realized)}</span>` : '';
    return `<tr data-bar="${t._bar ?? -1}" data-side="${side}" class="${t._bar === undefined || t._bar >= 0 ? '' : 'off'}" title="${t._bar < 0 ? '不在当前周期的行情范围内' : '点击定位到图上'}">
      <td class="num">${dateStr(t.wall)} ${isX ? '' : timeStr(t.wall)}</td><td>${p}</td><td>${esc(isO ? t.sym : x.key)}</td>
      <td class="r num">${fmtQ(t.qty)}${adjQ}</td><td class="r num">${isX ? '—' : esc(t.priceRaw || fmt(t.price, dg))}${adjP}</td>
      <td class="r num">${isX ? fmt(t.mval) : fmt(t.proceeds)}</td><td class="r num muted">${isX ? '' : fmt(t.comm)}</td>
      <td class="r num">${rl}</td><td class="muted">${esc(t.code || '')}</td></tr>`;
  }).join('');
  $('#tradesSub').textContent = `${rows.length} 条 · ${x.cur || ''}`;
}

// ---------------------------------------------------------------- flow
let seq = 0;
async function loadChart(refresh = false) {
  const my = ++seq, x = S.insts.get(S.cur), iv = S.iv;
  if (!x) return;
  $('#loading').style.display = 'flex';
  $('#notice').style.display = 'none';
  $('#notice').innerHTML = '';
  try {
    const [dj, ij] = await Promise.all([
      fetchSeries(x.yahoo, '1d', x.first - 3 * 365 * DAY, refresh),
      IV_SEC[iv] ? fetchSeries(x.yahoo, iv, x.first - 5 * DAY, refresh) : null,
    ]);
    if (my !== seq) return;
    const D = toBars(dj, true);
    S.daily = D.bars; S.tz = D.tz; S.splits = D.splits; S.meta = dj.meta;
    S.bars = iv === '1d' ? D.bars : IV_SEC[iv] ? toBars(ij, false).bars : aggregate(D.bars, iv);
    S.src = ij || dj;
    if (!S.bars.length) throw new Error('Yahoo 没有返回这个代码的行情');
    chart.applyOptions({ timeScale: { timeVisible: !!IV_SEC[iv] } });
    buildGroups();
    S.ind = indicators(S.bars); S.pos = buildPosition();
    setSeriesData(); drawCostLine(); initialRange();
    renderHeader(); renderTable(); updateLegends(S.bars.length - 1);
    const notes = [];
    if (S.outOfRange) notes.push(`${S.outOfRange} 笔成交不在当前周期的行情范围内${IV_SEC[iv] ? '（Yahoo 的分钟线只能回溯 60 天 / 60 分钟线 2 年，本地缓存会逐渐积累）' : ''}，表格中以灰色显示。`);
    if (S.splits.some((s) => x.trades.some((t) => tradeDay(t.epoch) < s.day))) notes.push('该股票期间有拆股，图上的买卖价已按拆股比例复权（表格中同时显示原价和复权价）。');
    if (dj.source === 'stale') notes.push(`联网失败，正在使用本地缓存：${dj.error}`);
    if (notes.length) { $('#notice').innerHTML = notes.map(esc).join('<br>'); $('#notice').style.display = 'block'; }
  } catch (e) {
    if (my !== seq) return;
    S.bars = []; S.groups = new Map();
    [candle, ...maS, vol, macdH, difS, deaS, posS].forEach((s) => s.setData([]));
    $('#info').innerHTML = '';
    $('#notice').innerHTML = `行情载入失败（${esc(x.yahoo)}）：${esc(e.message)}<br>如果代码对不上，可以在标题旁的 Yahoo 输入框里改成 Yahoo 上的代码。`;
    $('#notice').style.display = 'block';
    renderHeader(); renderTable();
  } finally {
    if (my === seq) { $('#loading').style.display = 'none'; dirty = true; }
  }
}

function select(key) {
  if (!S.insts.has(key)) return;
  S.cur = key; store.set('sym', key);
  document.querySelectorAll('#symlist li[data-k]').forEach((li) => li.classList.toggle('on', li.dataset.k === key));
  S.meta = {}; S.daily = []; S.splits = [];
  renderHeader(); renderTable();
  loadChart();
}

function focusBar(i, side) {
  const r = chart.timeScale().getVisibleLogicalRange();
  const span = r ? r.to - r.from : 120;
  chart.timeScale().setVisibleLogicalRange({ from: i - span * 0.6, to: i + span * 0.4 });
  S.hl = { i, side, until: Date.now() + 2200 };
  setTimeout(() => { dirty = true; }, 2300);
  dirty = true;
  $('main').scrollTo({ top: 0, behavior: 'smooth' });
}
function highlightRows(i, side) {
  const rows = [...document.querySelectorAll('#tbody tr')];
  rows.forEach((r) => r.classList.toggle('hl', +r.dataset.bar === i && r.dataset.side === side));
  const first = rows.find((r) => r.classList.contains('hl'));
  if (first) { const w = $('.tbl-wrap'); w.scrollTo({ top: first.offsetTop - w.clientHeight / 2, behavior: 'smooth' }); }
}

async function loadTexts(list) {
  const err = [];
  for (const { name, content } of list) {
    try { ingest(parseStatement(content, name)); } catch (e) { err.push(e.message); }
  }
  buildInstruments();
  if (!S.insts.size) throw new Error(err[0] || '文件里没有找到成交记录（需要包含“交易 / Trades”部分的活动账单）');
  renderAcct(); renderSide();
  $('#drop').classList.remove('show');
  const want = S.cur && S.insts.has(S.cur) ? S.cur : store.get('sym', null);
  const first = sideOrder()[0][1][0].key;
  select(S.insts.has(want) ? want : first);
}
async function loadFiles(files) {
  const list = await Promise.all([...files].map(async (f) => ({ name: f.name, content: await f.text() })));
  try { await loadTexts(list); } catch (e) { showDropError(e.message); }
}
function showDropError(m) { const el = $('#dropErr'); el.textContent = m; el.style.display = 'block'; $('#drop').classList.add('show'); }

// ---------------------------------------------------------------- events
function bind() {
  $('#pickBtn').onclick = () => $('#file').click();
  $('#addBtn').onclick = () => $('#file').click();
  $('#file').onchange = (e) => { if (e.target.files.length) loadFiles(e.target.files); e.target.value = ''; };
  let depth = 0;
  addEventListener('dragenter', (e) => { e.preventDefault(); depth++; $('#drop').classList.add('show', 'over'); });
  addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('#drop').classList.remove('over'); if (S.insts.size) $('#drop').classList.remove('show'); } });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); depth = 0; $('#drop').classList.remove('over'); if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); });
  $('#drop').addEventListener('click', (e) => { if (e.target.id === 'drop' && S.insts.size) $('#drop').classList.remove('show'); });

  $('#symlist').addEventListener('click', (e) => { const li = e.target.closest('li[data-k]'); if (li) select(li.dataset.k); });
  $('#q').addEventListener('input', renderSide);
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || !S.insts.size || !['ArrowUp', 'ArrowDown'].includes(e.key) || e.metaKey || e.ctrlKey) return;
    const keys = sideOrder().flatMap(([, l]) => l.map((x) => x.key));
    const i = keys.indexOf(S.cur), j = Math.max(0, Math.min(keys.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    if (j !== i) { e.preventDefault(); select(keys[j]); document.querySelector(`#symlist li[data-k="${CSS.escape(keys[j])}"]`)?.scrollIntoView({ block: 'nearest' }); }
  });

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-iv]'); if (!b || b.dataset.iv === S.iv) return;
    S.iv = b.dataset.iv; store.set('iv', S.iv);
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    loadChart();
  });
  $('#refreshBtn').onclick = () => loadChart(true);
  $('#ysym').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const x = S.insts.get(S.cur), v = e.target.value.trim().toUpperCase(); if (!x || !v) return;
    x.yahoo = v;
    if (v === yahooSymbol(x)) delete overrides[x.key]; else overrides[x.key] = v;
    store.set('yahoo', overrides); e.target.blur(); loadChart();
  });

  const regroup = () => { if (!S.bars.length) { renderTable(); return; } buildGroups(); renderTable(); dirty = true; };
  $('#tgOpt').onchange = regroup;
  $('#tgXfer').onchange = regroup;
  $('#tgCost').onchange = () => { drawCostLine(); store.set('cost', $('#tgCost').checked); };
  $('#tgHiLo').onchange = () => { dirty = true; store.set('hilo', $('#tgHiLo').checked); };
  $('#tgRedUp').onchange = () => { store.set('redUp', $('#tgRedUp').checked); applyTheme(); renderTable(); if (S.bars.length) updateLegends(S.bars.length - 1); };
  $('#themeBtn').onclick = () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t; store.set('theme', t);
    applyTheme(); renderTable(); if (S.bars.length) updateLegends(S.bars.length - 1);
  };

  const svg = $('#overlay'), tip = $('#tip');
  svg.addEventListener('mouseover', (e) => { const g = e.target.closest('.mk'); if (!g) return; tip.innerHTML = tipHtml(g.dataset.key); tip.style.display = 'block'; });
  svg.addEventListener('mousemove', (e) => {
    if (tip.style.display !== 'block') return;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let l = e.clientX + 16, t = e.clientY + 14;
    if (l + w > innerWidth - 8) l = e.clientX - w - 16;
    if (t + h > innerHeight - 8) t = e.clientY - h - 14;
    tip.style.left = `${Math.max(8, l)}px`; tip.style.top = `${Math.max(8, t)}px`;
  });
  svg.addEventListener('mouseout', (e) => { if (e.target.closest('.mk') && !e.relatedTarget?.closest?.('.mk')) tip.style.display = 'none'; });
  svg.addEventListener('click', (e) => { const g = e.target.closest('.mk'); if (!g) return; const [i, side] = g.dataset.key.split(':'); highlightRows(+i, side); });
  $('#tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const i = +tr.dataset.bar; if (i < 0 || !S.bars.length) return;
    document.querySelectorAll('#tbody tr').forEach((r) => r.classList.toggle('hl', r === tr));
    focusBar(i, tr.dataset.side);
  });
}

function loop() {
  if (chart && S.bars.length) {
    const r = chart.timeScale().getVisibleLogicalRange(), ps = chart.paneSize(0), b = S.bars[S.bars.length - 1];
    const sig = r ? [r.from.toFixed(2), r.to.toFixed(2), ps.width, ps.height, chart.paneSize(1).height, chart.paneSize(2).height,
      candle.priceToCoordinate(b.close), candle.priceToCoordinate(b.close * 1.05)].join('|') : '';
    if (dirty || sig !== lastSig) { lastSig = sig; dirty = false; draw(); placeLegends(); }
  } else if (dirty) { dirty = false; draw(); }
  requestAnimationFrame(loop);
}

async function boot() {
  document.documentElement.dataset.theme = store.get('theme', 'dark');
  $('#tgRedUp').checked = store.get('redUp', false);
  $('#tgCost').checked = store.get('cost', true);
  $('#tgHiLo').checked = store.get('hilo', true);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.iv === S.iv));
  if (!LWC) { showDropError('图表库没加载出来（需要能访问 unpkg.com）。'); return; }
  makeChart(); bind(); loop();
  window.__ibv = { S, get chart() { return chart; }, get candle() { return candle; } };   // 调试用
  if (location.protocol === 'file:') { showDropError('请用 python3 server.py 启动后再打开页面，否则拿不到行情数据。'); return; }
  try {
    const r = await fetch('/api/statements');
    const list = r.ok ? await r.json() : [];
    if (list.length) await loadTexts(list);
  } catch (e) { showDropError(e.message); }
}
boot();
})();
