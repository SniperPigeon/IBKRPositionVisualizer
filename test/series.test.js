import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYahoo, assemble, makeFactors, scaleBars, aggregate, dayOf, toWall } from '../public/lib/series.js';

const NY = 'America/New_York';
const at = (y, m, d, hh = 9, mm = 30) => {
  // 美东本地时间 → epoch（11 月为 EST，UTC-5）
  return Date.UTC(y, m - 1, d, hh + 5, mm) / 1000;
};
const yahoo = (rows, events = {}, tz = NY) => ({
  chart: { result: [{
    meta: { exchangeTimezoneName: tz },
    timestamp: rows.map((r) => r[0]),
    indicators: { quote: [{ open: rows.map((r) => r[1]), high: rows.map((r) => r[1]), low: rows.map((r) => r[1]), close: rows.map((r) => r[1]), volume: rows.map((r) => r[2]) }] },
    events,
  }] },
});

test('用 asOf 把拆股调整过的价格还原成原始价', () => {
  const split = { date: at(2026, 11, 5), numerator: 3, denominator: 1 };
  // 拆股后抓取：拆股前的价格已被 Yahoo 除以 3
  const after = parseYahoo(yahoo([[at(2026, 11, 3), 150, 300], [at(2026, 11, 4), 152, 300], [at(2026, 11, 5), 138, 900]], { splits: { a: split } }), at(2026, 11, 6));
  const a = assemble([after], true);
  assert.deepEqual(a.bars.map((b) => Math.round(b.close)), [450, 456, 138]);
  assert.deepEqual(a.bars.map((b) => b.volume), [100, 100, 900]);
  // 拆股前抓取的分块（价格本来就是原始价），即使事件列表来自别的分块也不能再乘一次
  const before = parseYahoo(yahoo([[at(2026, 11, 3), 450, 100]]), at(2026, 11, 4, 12));
  const b = assemble([before], true, after.splits);
  assert.equal(b.bars[0].close, 450);
});

test('分时块：只有窗口内的拆股才被 Yahoo 应用过', () => {
  const split = { epoch: at(2026, 11, 5), ratio: 3 };
  // 窗口截止 11-01（拆股前），即使 asOf 在拆股之后，价格仍是原始价
  const hist = { ...parseYahoo(yahoo([[at(2026, 10, 30, 10), 475, 100]]), at(2026, 11, 19)), periodEnd: Date.UTC(2026, 10, 1) / 1000 };
  // 窗口包含拆股：拆股前的 bar 被除以 3
  const tail = { ...parseYahoo(yahoo([[at(2026, 11, 3, 10), 156, 300], [at(2026, 11, 6, 10), 138, 900]], { splits: { a: { date: split.epoch, numerator: 3, denominator: 1 } } }), at(2026, 11, 19)), periodEnd: at(2026, 11, 19) };
  const a = assemble([hist, tail], false);
  assert.deepEqual(a.bars.map((b) => Math.round(b.close)), [475, 468, 138]);
  // 日线不受窗口影响：按 asOf 判断
  const dailyHist = { ...parseYahoo(yahoo([[at(2026, 10, 30), 157, 300]]), at(2026, 11, 19)), periodEnd: Date.UTC(2026, 10, 1) / 1000 };
  assert.equal(Math.round(assemble([dailyHist], true, [split]).bars[0].close), 471);
});

test('股息金额同样按 asOf 还原', () => {
  const ev = {
    splits: { a: { date: at(2026, 11, 5), numerator: 2, denominator: 1 } },
    dividends: { d: { date: at(2026, 11, 2), amount: 0.5 } },   // Yahoo 显示的是拆股调整后的 0.5，原始是 1.0
  };
  const c = parseYahoo(yahoo([[at(2026, 10, 30), 50, 10], [at(2026, 11, 2), 49, 10], [at(2026, 11, 5), 49, 20]], ev), at(2026, 11, 6));
  const a = assemble([c], true);
  assert.equal(a.divs[0].amount, 1);
});

test('前复权因子：拆股 × 股息', () => {
  const D = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
  const daily = [D(2026, 1, 2), D(2026, 1, 5), D(2026, 1, 6), D(2026, 1, 7)].map((time, i) => ({ time, open: 100, high: 100, low: 100, close: [100, 100, 200, 200][i], volume: 1 }));
  const F = makeFactors(daily, [{ day: D(2026, 1, 6), ratio: 0.5 }], [{ day: D(2026, 1, 7), amount: 2 }]); // 1:2 合股、2 元股息
  assert.equal(F.price(D(2026, 1, 7)), 1);
  assert.equal(F.price(D(2026, 1, 6)), 1 - 2 / 200);
  assert.equal(F.price(D(2026, 1, 5)), (1 - 2 / 200) * 2);
  assert.equal(F.vol(D(2026, 1, 5)), 0.5);
  const scaled = scaleBars(daily, F.price, F.vol);
  assert.equal(scaled[3].close, 200);
  assert.ok(Math.abs(scaled[1].close - 198) < 1e-9);
});

test('周 K / 月 K 聚合', () => {
  const D = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
  const daily = [D(2026, 11, 2), D(2026, 11, 3), D(2026, 11, 9), D(2026, 12, 1)].map((time, i) => ({ time, open: i, high: i + 1, low: i - 1, close: i, volume: 10 }));
  assert.equal(aggregate(daily, '1wk').length, 3);
  const m = aggregate(daily, '1mo');
  assert.equal(m.length, 2);
  assert.equal(m[0].volume, 30);
  assert.equal(m[0].high, 3);
});

// ---- 用真实数据核对：我们算的前复权收盘价 vs Yahoo 自带的 adjclose（拆股+股息） --------------
async function yahooDaily(symbol, p1, p2) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${p1}&period2=${p2}&events=div,split`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

for (const symbol of ['AAPL', 'NVDA', 'SOXX', 'SGOV']) {
  test(`真实数据：${symbol} 前复权与 Yahoo adjclose 一致`, async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const mid = Date.UTC(2025, 0, 1) / 1000;
    let js1, js2;
    try {
      // 拆成两块：模拟 hist + tail，各自带 asOf
      js1 = await yahooDaily(symbol, Date.UTC(2023, 0, 1) / 1000, mid);
      js2 = await yahooDaily(symbol, mid - 7 * 86400, now);
    } catch (e) {
      t.skip(`无法访问 Yahoo：${e.message}`);
      return;
    }
    const chunks = [parseYahoo(js1, now), parseYahoo(js2, now)];
    const a = assemble(chunks, true);
    const F = makeFactors(a.bars, a.splits, a.divs);
    const adj = new Map();
    for (const js of [js1, js2]) {
      const r = js.chart.result[0];
      const tz = r.meta.exchangeTimezoneName;
      r.timestamp.forEach((ts, i) => { const v = r.indicators.adjclose[0].adjclose[i]; if (v != null) adj.set(dayOf(toWall(ts, tz)), v); });
    }
    let worst = 0, n = 0;
    for (const b of a.bars) {
      const ref = adj.get(b.time);
      if (ref == null) continue;
      const ours = b.close * F.price(b.time);
      worst = Math.max(worst, Math.abs(ours / ref - 1));
      n++;
    }
    assert.ok(n > 400, `对比样本太少：${n}`);
    assert.ok(worst < 2e-3, `${symbol} 最大相对误差 ${worst}`);
  });
}

// ---- 真实数据：按分块协议的窗口取 SOXX 60 分线，跨 2026-11-05 的 3:1 拆股 -------------------
test('真实数据：SOXX 60 分线跨拆股的分块拼接', async (t) => {
  const { chunkQueries, parseChunk, chunkPeriodEnd } = await import('../public/lib/chunks.js');
  const now = Math.floor(Date.now() / 1000);
  const chunks = [];
  try {
    for (const qs of chunkQueries('SOXX', '60m', Date.UTC(2026, 1, 27) / 1000)) {
      const c = parseChunk('?' + qs, now);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/SOXX?interval=60m&period1=${c.period1}&period2=${c.period2}&events=div,split&includePrePost=true`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      chunks.push({ ...parseYahoo(await r.json(), now), periodEnd: chunkPeriodEnd(qs, now) });
    }
  } catch (e) {
    t.skip(`无法访问 Yahoo：${e.message}`);
    return;
  }
  const a = assemble(chunks, false);
  const F = makeFactors([], a.splits, []);
  const near = (y, m, d, hh) => a.bars.find((b) => b.time === Date.UTC(y, m - 1, d, hh, 30) / 1000);
  const before = near(2026, 10, 30, 9), after = near(2026, 11, 6, 9);
  assert.ok(before && after, '缺少对比用的 bar');
  assert.ok(before.close > 400 && before.close < 550, `拆股前应为原始价，实际 ${before.close}`);   // 原始约 475
  assert.ok(after.close > 120 && after.close < 170, `拆股后约 140，实际 ${after.close}`);
  const qfqBefore = before.close * F.price(dayOf(before.time));
  assert.ok(qfqBefore > 140 && qfqBefore < 180, `前复权后应约 158，实际 ${qfqBefore}`);
  // 7 月的 bar 也必须是原始价（来自截止于拆股前的历史块）
  const july = a.bars.find((b) => b.time >= Date.UTC(2026, 6, 7, 11) / 1000);
  assert.ok(july.close > 450 && july.close < 700, `7 月原始价应在 500 左右，实际 ${july.close}`);
});
