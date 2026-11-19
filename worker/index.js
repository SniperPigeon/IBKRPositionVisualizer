// IBKR 交易回看 — Cloudflare Worker
//
// 静态页面由 Workers Static Assets 直接提供（public/），只有 /api/* 会进到这里。
// 开了 Workers Caching：缓存命中时这里根本不会运行，所以下面每一次执行都意味着要去 Yahoo 拉数据，
// 都要先经过 YahooGate（Durable Object）的限流。
//
//   GET /api/chart?v=1&s=…&i=…&part=…  分块行情，原样透传 Yahoo 的 JSON（不解析，省 CPU），附 X-As-Of
//   GET /api/status                     限流器状态（今日用量、是否在冷却）

import { DurableObject } from 'cloudflare:workers';
import { parseChunk } from '../public/lib/chunks.js';

const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
// 完整的浏览器 UA 在部分环境会被 Yahoo 判成爬虫；简短 UA 在 Workers 上实测稳定
const UA = 'Mozilla/5.0';

const json = (obj, status, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

const numVar = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
function limits(env) {
  return {
    rate: numVar(env.GATE_RATE, 2),        // 全局：每秒补充的令牌
    burst: numVar(env.GATE_BURST, 10),     // 全局：桶容量
    daily: numVar(env.GATE_DAILY, 4000),   // 全局：每天发往 Yahoo 的上限（UTC 日）
    ipRate: numVar(env.IP_RATE, 0.5),      // 每个 IP：每秒补充
    ipBurst: numVar(env.IP_BURST, 20),     // 每个 IP：桶容量
  };
}

// IPv6 用户经常在 /64 内换地址，按 /64 计
function clientKey(req) {
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') + '::/64' : ip;
}

async function fetchYahoo(c) {
  const qs = new URLSearchParams({ interval: c.interval, period1: String(c.period1), period2: String(c.period2), events: 'div,split' });
  if (c.interval !== '1d') qs.set('includePrePost', 'true');
  let last;
  for (const host of YAHOO_HOSTS) {
    try {
      const r = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(c.symbol)}?${qs}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        cache: 'no-store',
      });
      if (r.status >= 500) { last = r; continue; }
      return r;
    } catch (e) {
      last = e;
    }
  }
  if (last instanceof Response) return last;
  throw last;
}

async function chart(req, url, env, ctx) {
  const now = Math.floor(Date.now() / 1000);
  const c = parseChunk(url.search, now);
  if (c.error) return json({ error: c.error, expected: c.expected }, 400, { 'Cache-Control': 'public, max-age=3600' });

  const gate = env.GATE.get(env.GATE.idFromName('global'));
  const permit = await gate.acquire(clientKey(req), limits(env));
  if (!permit.ok) {
    return json({ error: 'rate_limited', reason: permit.reason, retryAfter: permit.retryAfter }, 429, {
      'Retry-After': String(permit.retryAfter), 'Cache-Control': 'no-store',
    });
  }

  let r;
  try {
    r = await fetchYahoo(c);
  } catch {
    ctx.waitUntil(gate.report(0));
    return json({ error: 'upstream unreachable' }, 502, { 'Cache-Control': 'no-store' });
  }
  ctx.waitUntil(gate.report(r.status));

  if (r.status === 404) return json({ error: 'symbol not found' }, 404, { 'Cache-Control': 'public, max-age=86400' });
  if (r.status === 400 || r.status === 422) return json({ error: 'range not available' }, 400, { 'Cache-Control': 'public, max-age=3600' });
  if (r.status === 429) {
    return json({ error: 'rate_limited', reason: 'upstream', retryAfter: 60 }, 503, { 'Retry-After': '60', 'Cache-Control': 'no-store' });
  }
  if (!r.ok) return json({ error: `upstream ${r.status}` }, 502, { 'Cache-Control': 'no-store' });

  return new Response(r.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': c.cacheControl,
      'X-As-Of': String(now),
      'X-Chunk': `${c.interval}:${c.part}`,
    },
  });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'method not allowed' }, 405, { 'Cache-Control': 'no-store' });
    if (url.pathname === '/api/chart') return chart(req, url, env, ctx);
    if (url.pathname === '/api/status') {
      const st = await env.GATE.get(env.GATE.idFromName('global')).status();
      return json({ ...st, limits: limits(env) }, 200, { 'Cache-Control': 'no-store' });
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404, { 'Cache-Control': 'public, max-age=3600' });
    return env.ASSETS.fetch(req);
  },
};

/**
 * 全站唯一的 Yahoo 闸门（idFromName('global')）。
 * - 全局令牌桶 + 每个 IP 的令牌桶
 * - 每天（UTC）请求上限
 * - Yahoo 返回 429 时进入冷却：60 秒起，每次翻倍，最长 30 分钟；之后任一正常响应即恢复
 */
export class YahooGate extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.global = null;
    this.ips = new Map();
    this.st = { day: '', count: 0, coolUntil: 0, coolMs: 0, upstream429: 0 };
    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get('state');
      if (s) this.st = { ...this.st, ...s };
    });
  }

  persist() {
    this.ctx.storage.put('state', this.st);
  }

  refill(b, now, rate, burst) {
    if (!b) return { t: burst, at: now };
    b.t = Math.min(burst, b.t + ((now - b.at) / 1000) * rate);
    b.at = now;
    return b;
  }

  async acquire(key, L) {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.st.day !== day) { this.st.day = day; this.st.count = 0; }
    if (now < this.st.coolUntil) {
      return { ok: false, reason: 'upstream_cooldown', retryAfter: Math.ceil((this.st.coolUntil - now) / 1000) };
    }
    if (this.st.count >= L.daily) {
      return { ok: false, reason: 'daily_budget', retryAfter: Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86400000 - now) / 1000) };
    }
    const b = this.refill(this.ips.get(key), now, L.ipRate, L.ipBurst);
    this.ips.set(key, b);
    if (b.t < 1) return { ok: false, reason: 'per_client', retryAfter: Math.ceil((1 - b.t) / L.ipRate) };
    this.global = this.refill(this.global, now, L.rate, L.burst);
    if (this.global.t < 1) return { ok: false, reason: 'global', retryAfter: Math.ceil((1 - this.global.t) / L.rate) };
    b.t -= 1;
    this.global.t -= 1;
    this.st.count += 1;
    this.persist();
    if (this.ips.size > 5000) for (const [k, v] of this.ips) if (now - v.at > 10 * 60 * 1000) this.ips.delete(k);
    return { ok: true };
  }

  async report(status) {
    if (status === 429) {
      this.st.coolMs = Math.min(this.st.coolMs ? this.st.coolMs * 2 : 60_000, 30 * 60_000);
      this.st.coolUntil = Date.now() + this.st.coolMs;
      this.st.upstream429 += 1;
      this.persist();
    } else if (status > 0 && status < 500 && this.st.coolMs) {
      this.st.coolMs = 0;
      this.persist();
    }
  }

  async status() {
    const now = Date.now();
    return {
      day: this.st.day,
      yahooRequestsToday: this.st.count,
      coolingDown: now < this.st.coolUntil,
      cooldownSeconds: Math.max(0, Math.ceil((this.st.coolUntil - now) / 1000)),
      upstream429Total: this.st.upstream429,
      activeClients: this.ips.size,
    };
  }
}
