import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkQueries, parseChunk, tailTtl } from '../public/lib/chunks.js';

// 2026-11-18（周三）15:00 UTC = 10:00 ET，美股交易时段内
const NOW = Date.UTC(2026, 10, 18, 15, 0) / 1000;
const NOW_DATE = new Date(NOW * 1000);
const FIRST_TRADE = Date.UTC(2026, 1, 27) / 1000;

test('客户端拼出的每个分块都能通过服务端校验', () => {
  for (const sym of ['SOXX', 'USDSGD=X', 'BRK-B', 'D05.SI', '^GSPC']) {
    for (const iv of ['1d', '60m', '30m']) {
      for (const qs of chunkQueries(sym, iv, FIRST_TRADE, NOW_DATE)) {
        const c = parseChunk('?' + qs, NOW);
        assert.equal(c.error, undefined, `${qs}: ${c.error}`);
        assert.equal(c.symbol, sym);
        assert.ok(c.period1 < c.period2, qs);
      }
    }
  }
});

test('分块范围', () => {
  const [hist, tail] = chunkQueries('SOXX', '1d', FIRST_TRADE, NOW_DATE).map((q) => parseChunk('?' + q, NOW));
  assert.equal(hist.period1, Date.UTC(2016, 0, 1) / 1000);         // 统一从 2016 年开始
  assert.equal(hist.period2, Date.UTC(2026, 10, 1) / 1000);        // 到本月 1 日
  assert.match(hist.cacheControl, /immutable/);
  assert.equal(tail.period1, Date.UTC(2026, 10, 1) / 1000 - 7 * 86400);
  assert.equal(tail.period2, NOW);

  const old = chunkQueries('SOXX', '1d', Date.UTC(2010, 5, 1) / 1000, NOW_DATE)[0];
  assert.match(old, /from=2007/);                                   // 账单更早时往前 3 年

  const [h60] = chunkQueries('SOXX', '60m', FIRST_TRADE, NOW_DATE).map((q) => parseChunk('?' + q, NOW));
  assert.ok(NOW - h60.period1 < 729 * 86400, '60 分线历史必须在 Yahoo 的 730 天限制内');
});

test('非规范的 query 一律拒绝（防止绕过缓存）', () => {
  const qs = chunkQueries('SOXX', '1d', FIRST_TRADE, NOW_DATE)[1];
  assert.match(parseChunk('?' + qs + '&x=1', NOW).error, /non-canonical/);
  const reordered = qs.split('&').reverse().join('&');
  assert.match(parseChunk('?' + reordered, NOW).error, /non-canonical/);
  assert.match(parseChunk('?' + qs.replace('v=1', 'v=9'), NOW).error, /version/);
  assert.match(parseChunk('?v=1&s=soxx&i=1d&part=tail&from=2026-11', NOW).error, /symbol/);
  assert.match(parseChunk('?v=1&s=SOXX&i=5m&part=recent', NOW).error, /interval/);
});

test('时间窗口校验', () => {
  const p = (qs) => parseChunk('?' + qs, NOW);
  assert.equal(p('v=1&s=SOXX&i=1d&part=tail&from=2026-10').error, undefined);   // 月初时钟偏差，允许上个月
  assert.match(p('v=1&s=SOXX&i=1d&part=tail&from=2026-09').error, /from/);
  assert.match(p('v=1&s=SOXX&i=1d&part=hist&from=2016&to=2026-12').error, /to/); // 未来月份
  assert.match(p('v=1&s=SOXX&i=60m&part=hist&from=2024-10&to=2026-11').error, /from/); // 超过 23 个月
  assert.equal(p('v=1&s=SOXX&i=60m&part=hist&from=2024-12&to=2026-11').error, undefined);
  assert.match(p('v=1&s=SOXX&i=30m&part=hist&from=2026-10&to=2026-11').error, /part/);
});

test('最近一段的缓存时间随交易时段变化', () => {
  assert.equal(tailTtl('SOXX', '1d', NOW), 300);
  assert.equal(tailTtl('SOXX', '60m', NOW), 120);
  const sat = Date.UTC(2026, 10, 21, 15, 0) / 1000;       // 周六
  assert.equal(tailTtl('SOXX', '1d', sat), 6 * 3600);     // 封顶 6 小时
  const preOpen = Date.UTC(2026, 10, 18, 8, 30) / 1000;   // 周三 03:30 ET，30 分钟后开盘前时段
  assert.equal(tailTtl('SOXX', '1d', preOpen), 1800);
  assert.equal(tailTtl('USDSGD=X', '1d', sat), 300);      // 非美股统一短 TTL
});
