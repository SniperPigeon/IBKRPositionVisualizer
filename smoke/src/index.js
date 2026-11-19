// Yahoo-from-Workers 冒烟测试
//
// 目的：确认 Cloudflare Workers 的出口 IP 能不能稳定访问 Yahoo 的 v8 chart 接口。
// 每次运行做一组探测：4 个用例 × 2 个 host × 3 种 User-Agent = 24 次请求（串行，避免自己制造突发）。
// 结果写入 KV（保留 7 天），摘要放在 key metadata 里，/results 只需一次 list。
//
//   GET /probe?key=…    立即跑一轮并返回明细
//   GET /results?key=…  汇总：按 UA 的成功率、状态码分布、时间线
//   GET /run?key=…&k=…  某一轮的明细
//   cron */10 * * * *    每 10 分钟自动跑一轮
//
// 只读 PROBE_KEY（secret），不需要其他配置。

const UAS = {
  short: 'Mozilla/5.0',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  none: null,
};
const CASES = [['SOXX', '1d'], ['AAPL', '1d'], ['USDSGD=X', '1d'], ['SOXX', '5m']];
const HOSTS = ['query1', 'query2'];
const TTL = 7 * 86400;

async function probeOne(symbol, interval, host, ua) {
  const now = Math.floor(Date.now() / 1000);
  const p1 = interval === '1d' ? now - 3 * 365 * 86400 : now - 5 * 86400;
  const qs = new URLSearchParams({ interval, period1: String(p1), period2: String(now), events: 'div,split' });
  if (interval.endsWith('m')) qs.set('includePrePost', 'true');
  const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`;
  const headers = { Accept: 'application/json' };
  if (UAS[ua]) headers['User-Agent'] = UAS[ua];
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers, cache: 'no-store' });
    const body = await r.text();
    // 故意不 JSON.parse：免费版每次请求只有 10ms CPU
    return {
      symbol, interval, host, ua, status: r.status, ms: Date.now() - t0, bytes: body.length,
      data: body.includes('"timestamp":['),
      err: (body.match(/"code":"([^"]+)"/) || [])[1] || null,
      snippet: r.ok ? undefined : body.slice(0, 120),
    };
  } catch (e) {
    return { symbol, interval, host, ua, status: 0, ms: Date.now() - t0, error: String(e) };
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

const ok = (r) => r.status === 200 && r.data;

async function run(env, source, reqColo) {
  const started = new Date().toISOString();
  const eg = await egress();
  const results = [];
  for (const [s, iv] of CASES) for (const h of HOSTS) for (const ua of Object.keys(UAS)) results.push(await probeOne(s, iv, h, ua));
  const rec = { started, source, reqColo: reqColo || null, egress: eg, results };
  const meta = {
    colo: eg.colo || reqColo || '?',
    ok: results.filter(ok).length,
    n: results.length,
    ua: Object.fromEntries(Object.keys(UAS).map((u) => [u, results.filter((r) => r.ua === u).map((r) => r.status).join(',')])),
  };
  await env.RESULTS.put(`${started}|${source}`, JSON.stringify(rec), { expirationTtl: TTL, metadata: meta });
  return rec;
}

async function summary(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.RESULTS.list({ cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const agg = {};
  for (const k of keys) {
    for (const [ua, codes] of Object.entries(k.metadata?.ua || {})) {
      const a = (agg[ua] ??= { ok: 0, total: 0, codes: {} });
      for (const c of codes.split(',')) { a.total++; a.codes[c] = (a.codes[c] || 0) + 1; if (c === '200') a.ok++; }
    }
  }
  return {
    runs: keys.length,
    first: keys[0]?.name, last: keys.at(-1)?.name,
    byUa: agg,
    colos: [...new Set(keys.map((k) => k.metadata?.colo))],
    failingRuns: keys.filter((k) => k.metadata && k.metadata.ok < k.metadata.n).map((k) => ({ k: k.name, ...k.metadata })),
    recent: keys.slice(-12).map((k) => ({ k: k.name, ...k.metadata })),
  };
}

const json = (o, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!env.PROBE_KEY || url.searchParams.get('key') !== env.PROBE_KEY) return json({ error: 'forbidden' }, 403);
    if (url.pathname === '/probe') return json(await run(env, 'http', req.cf?.colo));
    if (url.pathname === '/results') return json(await summary(env));
    if (url.pathname === '/run') return json(await env.RESULTS.get(url.searchParams.get('k') || '', 'json'));
    return json({ error: 'not found' }, 404);
  },
  async scheduled(_evt, env, ctx) {
    ctx.waitUntil(run(env, 'cron'));
  },
};
