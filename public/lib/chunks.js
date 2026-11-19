// 行情分块协议：浏览器用 chunkQueries() 拼 URL，Worker 用 parseChunk() 校验。两边共用这一个文件。
//
// 每个 (代码, 周期) 分成固定窗口，URL 稳定才能命中缓存：
//   1d  : hist  [from 年 1 月 1 日, to 月 1 日)            —— 不可变，缓存一年
//         tail  [from 月 1 日 - 7 天, 现在)                —— 按是否开盘决定 TTL
//   60m : hist  [from 月 1 日, to 月 1 日)，from 最多回溯 23 个月（Yahoo 只给约 730 天）
//         tail  同上
//   30m : recent [现在 - 59 天, 现在)                      —— Yahoo 只给 60 天
// 周 K / 月 K 由日 K 在浏览器里聚合，不单独请求。
//
// 历史块“不可变”的前提：Yahoo 返回的价格按抓取时刻（X-As-Of）做过拆股调整，浏览器会用 asOf
// 把它还原成原始价，再自行计算复权因子，所以旧块在之后发生拆股/分红时也不需要失效。

export const CHUNK_VERSION = '1';
export const INTERVALS = ['1d', '60m', '30m'];
export const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,24}$/;
export const HIST_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const DAY = 86400;
const pad = (n) => String(n).padStart(2, '0');

export const monthIndex = (date) => date.getUTCFullYear() * 12 + date.getUTCMonth();
export const monthKeyFromIndex = (i) => `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
const monthStart = (i) => Date.UTC(Math.floor(i / 12), i % 12, 1) / 1000;

function parseYM(s) {
  const m = /^(\d{4})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const y = +m[1], mo = +m[2];
  if (y < 1970 || mo < 1 || mo > 12) return null;
  return y * 12 + mo - 1;
}

const canon = (pairs) => new URLSearchParams(pairs).toString();

/** 浏览器端：某个代码、某个周期需要请求的分块（返回 query string 列表）。 */
export function chunkQueries(symbol, interval, firstEpoch, now = new Date()) {
  const cur = monthIndex(now);
  const base = [['v', CHUNK_VERSION], ['s', symbol], ['i', interval]];
  if (interval === '1d') {
    // 统一从 2016 年开始，让大多数人共用同一个缓存块；账单更早的话再往前 3 年
    const firstYear = new Date((firstEpoch || Date.now() / 1000) * 1000).getUTCFullYear();
    const fromYear = Math.min(2016, firstYear - 3);
    return [
      canon([...base, ['part', 'hist'], ['from', String(fromYear)], ['to', monthKeyFromIndex(cur)]]),
      canon([...base, ['part', 'tail'], ['from', monthKeyFromIndex(cur)]]),
    ];
  }
  if (interval === '60m') {
    return [
      canon([...base, ['part', 'hist'], ['from', monthKeyFromIndex(cur - 22)], ['to', monthKeyFromIndex(cur)]]),
      canon([...base, ['part', 'tail'], ['from', monthKeyFromIndex(cur)]]),
    ];
  }
  if (interval === '30m') return [canon([...base, ['part', 'recent']])];
  throw new Error(`unsupported interval ${interval}`);
}

/** 分块请求窗口的结束时间（epoch 秒）：历史块是 to 月 1 日，最近一段是抓取时刻。 */
export function chunkPeriodEnd(qs, asOf) {
  const q = new URLSearchParams(qs);
  if (q.get('part') === 'hist') {
    const to = parseYM(q.get('to'));
    if (to != null) return monthStart(to);
  }
  return asOf;
}

/** 美东时间的星期和分钟数。 */
function etClock(epoch) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(epoch * 1000))) parts[type] = value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { wd, min: (+parts.hour % 24) * 60 + +parts.minute };
}

/** 最近一段数据的缓存秒数：美股交易时段（含盘前盘后 04:00–20:00 ET）内短，收盘后缓存到下一次开盘。 */
export function tailTtl(symbol, interval, now) {
  const live = interval === '1d' ? 300 : 120;
  if (!/^[A-Z0-9-]+$/.test(symbol)) return live; // 非美股 / 外汇 / 指数：交易时段不同，统一用短 TTL
  const { wd, min } = etClock(now);
  const open = 4 * 60, close = 20 * 60;
  const weekday = wd >= 1 && wd <= 5;
  if (weekday && min >= open && min < close) return live;
  let days;
  if (weekday && min < open) days = 0;
  else if (wd === 5) days = 3;      // 周五收盘后 → 周一
  else if (wd === 6) days = 2;
  else days = 1;                    // 周日、周一至周四收盘后
  const secs = days * DAY + (open - min) * 60;
  return Math.max(300, Math.min(6 * 3600, secs));
}

export function tailCacheControl(symbol, interval, now) {
  const t = tailTtl(symbol, interval, now);
  return `public, max-age=${t}, stale-while-revalidate=${Math.min(t, 600)}`;
}

/**
 * 服务端：校验并解析一个分块请求。要求 query string 与规范形式完全一致，
 * 这样别人无法通过追加参数、调换顺序来绕过缓存。
 */
export function parseChunk(search, now) {
  const q = new URLSearchParams(search);
  const v = q.get('v'), s = q.get('s') || '', i = q.get('i') || '', part = q.get('part') || '';
  if (v !== CHUNK_VERSION) return { error: 'unsupported version' };
  if (!SYMBOL_RE.test(s)) return { error: 'bad symbol' };
  if (!INTERVALS.includes(i)) return { error: 'bad interval' };
  const cur = monthIndex(new Date(now * 1000));
  const pairs = [['v', v], ['s', s], ['i', i], ['part', part]];
  let out;
  if (part === 'hist' && i !== '30m') {
    const to = parseYM(q.get('to'));
    if (to == null || to > cur) return { error: 'bad to' };
    let p1;
    if (i === '1d') {
      const fy = q.get('from') || '';
      if (!/^\d{4}$/.test(fy) || +fy < 1970 || Date.UTC(+fy, 0, 1) / 1000 >= monthStart(to)) return { error: 'bad from' };
      p1 = Date.UTC(+fy, 0, 1) / 1000;
    } else {
      const from = parseYM(q.get('from'));
      if (from == null || from >= to || cur - from > 23) return { error: 'bad from' };
      p1 = monthStart(from);
    }
    pairs.push(['from', q.get('from')], ['to', q.get('to')]);
    out = { period1: p1, period2: monthStart(to), cacheControl: HIST_CACHE_CONTROL };
  } else if (part === 'tail' && i !== '30m') {
    const from = parseYM(q.get('from'));
    if (from == null || from > cur || from < cur - 1) return { error: 'bad from' };
    pairs.push(['from', q.get('from')]);
    out = { period1: monthStart(from) - 7 * DAY, period2: now, cacheControl: tailCacheControl(s, i, now) };
  } else if (part === 'recent' && i === '30m') {
    out = { period1: now - 59 * DAY, period2: now, cacheControl: tailCacheControl(s, i, now) };
  } else {
    return { error: 'bad part' };
  }
  const expected = canon(pairs);
  const given = String(search).replace(/^\?/, '');
  if (given !== expected) return { error: 'non-canonical query', expected };
  return { symbol: s, interval: i, part, ...out };
}
