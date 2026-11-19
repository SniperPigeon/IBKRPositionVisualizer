// Yahoo-from-Workers 冒烟测试（v2：按真实使用方式采样）
//
// 目的：确认 Cloudflare Workers 的出口 IP 能不能长期稳定地访问 Yahoo 的 v8 chart 接口。
//
// 每小时一轮（cron 17 * * * *，故意避开整点），每轮：
//   - 所有代码的日线（3 年）
//   - 轮换 3 个股票的 60 分线（700 天）和 30 分线（59 天）——Yahoo 对 30 分线只给 60 天，60 分线约 2 年
//   - 请求串行发送，间隔 300–600ms 随机抖动，模拟正常使用而不是突发
//   - 平时用简短 UA；每 6 小时有一轮改用完整 Chrome UA，作为对照
// 结果写入 KV（保留 7 天），摘要放在 key metadata 里，/results 只需 list。
//
//   GET /probe?key=…[&ua=chrome]     立即跑一轮
//   GET /burst?key=…&n=30&c=6        突发测试：n 次日线请求、c 路并发（只手动触发）
//   GET /results?key=…               汇总
//   GET /run?key=…&k=…               某一轮的明细
//
// 环境：PROBE_KEY（secret，访问口令）、SYMBOLS（secret，逗号分隔的代码；不放进仓库）、RESULTS（KV）

const UA = {
  short: 'Mozilla/5.0',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};
const DEFAULT_SYMBOLS = 'SPY,QQQ,AAPL,MSFT,NVDA,GOOG,META,AMZN,USDSGD=X';
const LOOKBACK_DAYS = { '1d': 3 * 365, '60m': 700, '30m': 59 };
const INTRADAY_PER_RUN = 3;
const MAX_REQUESTS = 45;          // 免费版每次调用最多 50 个外部子请求
const TTL = 7 * 86400;
const PREFIX = 'v2|';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const symbols = (env) => (env.SYMBOLS || DEFAULT_SYMBOLS).split(',').map((s) => s.trim()).filter(Boolean);
const hourSlot = () => Math.floor(Date.now() / 3_600_000);
const okr = (r) => r.status === 200 && r.data;

async function probeOne(symbol, interval, ua) {
  const now = Math.floor(Date.now() / 1000);
  const qs = new URLSearchParams({
    interval, period1: String(now - LOOKBACK_DAYS[interval] * 86400), period2: String(now), events: 'div,split',
  });
  if (interval !== '1d') qs.set('includePrePost', 'true');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA[ua] }, cache: 'no-store' });
    const body = await r.text();   // 故意不 JSON.parse：免费版每次请求只有 10ms CPU
    const out = { symbol, interval, ua, status: r.status, ms: Date.now() - t0, bytes: body.length, data: r.ok && body.includes('"timestamp":[') };
    if (!out.data) {
      out.err = (body.match(/"description":"([^"]{0,140})/) || [])[1] || body.slice(0, 140);
      const ra = r.headers.get('retry-after');
      if (ra) out.retryAfter = ra;
    }
    return out;
  } catch (e) {
    return { symbol, interval, ua, status: 0, ms: Date.now() - t0, err: String(e).slice(0, 140) };
  }
}

async function egress() {
  try {
    const t = await (await fetch('https://cloudflare.com/cdn-cgi/trace', { cache: 'no-store' })).text();
    const g = (k) => (t.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
    return { ip: g('ip'), colo: g('colo') };
  } catch {
    return {};
  }
}

function plan(env, slot) {
  const syms = symbols(env);
  const stocks = syms.filter((s) => !s.includes('='));
  const groups = Math.max(1, Math.ceil(stocks.length / INTRADAY_PER_RUN));
  const start = (slot % groups) * INTRADAY_PER_RUN;
  const intraday = stocks.slice(start, start + INTRADAY_PER_RUN);
  return [...syms.map((s) => [s, '1d']), ...intraday.flatMap((s) => [[s, '60m'], [s, '30m']])].slice(0, MAX_REQUESTS);
}

function pct(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
}

function digest(source, eg, reqColo, ua, results, extra = {}) {
  const iv = {};
  const codes = {};
  for (const r of results) {
    const a = (iv[r.interval] ??= [0, 0]);
    a[1]++; if (okr(r)) a[0]++;
    codes[r.status] = (codes[r.status] || 0) + 1;
  }
  const lat = results.filter(okr).map((r) => r.ms).sort((a, b) => a - b);
  return {
    src: source, colo: eg.colo || reqColo || '?', ua,
    ok: results.filter(okr).length, n: results.length,
    iv: Object.fromEntries(Object.entries(iv).map(([k, [o, n]]) => [k, `${o}/${n}`])),
    codes, p50: pct(lat, 0.5), p95: pct(lat, 0.95), ...extra,
  };
}

async function save(env, source, rec, meta) {
  await env.RESULTS.put(`${PREFIX}${rec.started}|${source}`, JSON.stringify(rec), { expirationTtl: TTL, metadata: meta });
}

async function run(env, source, reqColo, uaOverride) {
  const slot = hourSlot();
  const ua = uaOverride || (slot % 6 === 0 ? 'chrome' : 'short');
  const started = new Date().toISOString();
  const eg = await egress();
  const results = [];
  for (const [i, [s, iv]] of plan(env, slot).entries()) {
    if (i) await sleep(300 + Math.random() * 300);
    results.push(await probeOne(s, iv, ua));
  }
  const rec = { started, source, slot, ua, reqColo: reqColo || null, egress: eg, results };
  const meta = digest(source, eg, reqColo, ua, results);
  await save(env, source, rec, meta);
  return { meta, rec };
}

async function burst(env, n, c, ua, reqColo) {
  const syms = symbols(env);
  const tasks = Array.from({ length: n }, (_, i) => syms[i % syms.length]);
  const started = new Date().toISOString();
  const eg = await egress();
  const results = [];
  const t0 = Date.now();
  let next = 0;
  await Promise.all(Array.from({ length: c }, async () => {
    while (next < tasks.length) results.push(await probeOne(tasks[next++], '1d', ua));
  }));
  const wallMs = Date.now() - t0;
  const rec = { started, source: 'burst', n, c, ua, wallMs, reqColo: reqColo || null, egress: eg, results };
  const meta = digest('burst', eg, reqColo, ua, results, { c, wallMs });
  await save(env, 'burst', rec, meta);
  return { meta, rec };
}

async function summary(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.RESULTS.list({ prefix: PREFIX, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const metas = keys.map((k) => ({ k: k.name.slice(PREFIX.length), ...k.metadata }));
  const add = (o, key, ok, n) => { const a = (o[key] ??= { ok: 0, total: 0 }); a.ok += ok; a.total += n; };
  const byUa = {}, byIv = {}, bySrc = {}, codes = {};
  for (const m of metas) {
    if (m.src !== 'burst') add(byUa, m.ua, m.ok, m.n);
    add(bySrc, m.src, m.ok, m.n);
    for (const [iv, s] of Object.entries(m.iv || {})) { const [o, n] = s.split('/').map(Number); if (m.src !== 'burst') add(byIv, iv, o, n); }
    for (const [c, n] of Object.entries(m.codes || {})) codes[c] = (codes[c] || 0) + n;
  }
  const p50s = metas.filter((m) => m.p50 != null).map((m) => m.p50).sort((a, b) => a - b);
  return {
    runs: metas.length, first: metas[0]?.k, last: metas.at(-1)?.k,
    byUa, byIv, bySrc, codes,
    medianOfP50ms: pct(p50s, 0.5),
    colos: [...new Set(metas.map((m) => m.colo))],
    failingRuns: metas.filter((m) => m.ok < m.n),
    recent: metas.slice(-24),
  };
}

const json = (o, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const q = url.searchParams;
    if (!env.PROBE_KEY || q.get('key') !== env.PROBE_KEY) return json({ error: 'forbidden' }, 403);
    const ua = UA[q.get('ua')] ? q.get('ua') : undefined;
    if (url.pathname === '/probe') return json(await run(env, 'http', req.cf?.colo, ua));
    if (url.pathname === '/burst') {
      const n = Math.min(MAX_REQUESTS, Math.max(1, Number(q.get('n')) || 30));
      const c = Math.min(6, Math.max(1, Number(q.get('c')) || 6));   // 每次调用最多 6 个并发出站连接
      return json(await burst(env, n, c, ua || 'short', req.cf?.colo));
    }
    if (url.pathname === '/results') return json(await summary(env));
    if (url.pathname === '/run') return json(await env.RESULTS.get(PREFIX + (q.get('k') || ''), 'json'));
    return json({ error: 'not found' }, 404);
  },
  async scheduled(_evt, env, ctx) {
    ctx.waitUntil(run(env, 'cron'));
  },
};
