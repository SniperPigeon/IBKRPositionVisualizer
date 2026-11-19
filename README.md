# IBKR 交易回看

把 IBKR 活动账单（Activity Statement CSV）里的成交画到 K 线上，风格参考富途：B/S 标记、MA5/10/20/30、成交量、MACD、持仓曲线、成本线。

账单只在浏览器里解析，不会上传到任何服务器；行情来自 Yahoo Finance，请求里只有股票代码和时间范围。

## 两种运行方式

前端完全相同（`public/`），后端二选一，接口一致（`/api/chart`，协议见 `public/lib/chunks.js`）。

### Cloudflare（Workers + Static Assets）

```bash
npm install
npm run dev          # 本地运行：http://localhost:8787
npx wrangler login   # 第一次部署前登录
npm run deploy
```

- `worker/index.js`：分块代理 Yahoo，原样透传 JSON（不解析，CPU 很省），按 `Cache-Control` 交给 Workers Caching 缓存
- `YahooGate`（Durable Object）：全局令牌桶 + 每个 IP 的令牌桶 + 每日上限；Yahoo 返回 429 时熔断冷却（60 秒起翻倍，最长 30 分钟）。参数在 `wrangler.jsonc` 的 `vars` 里
- `GET /api/status` 查看今日用量、是否在冷却
- 免费版就够用

### 本地 Python

```bash
python3 server.py ~/Downloads/U1234567_20260101_20261118.csv
```

只依赖 Python 标准库（3.9+）。带账单路径启动会自动载入；不带的话把 CSV 拖进页面即可。行情缓存在 `cache/chunks/`。

## 功能

- 日K / 周K / 月K / 60分 / 30分；周K、月K由日K在浏览器里聚合
- 前复权 / 不复权切换：拆股和分红都会复权，买卖点、成本线、持仓曲线跟着同一口径换算；不复权时显示原始成交价
- 买点 B 在 K 线下方，卖点 S 在上方，虚线连到实际成交价；同一根 K 线有多笔成交时显示数量角标
- 鼠标悬停看明细，点标记会高亮表格里对应的行；点表格行会把图表定位到那天
- 期权成交（C/P，紫色）和持仓转入（“转”，蓝色）显示在正股图上，可以单独开关
- 美股 20:00 ET 之后的隔夜盘成交算到下一个交易日
- 多份账单可以一起拖入，自动去重
- 深色/浅色主题，红涨绿跌/绿涨红跌

## 行情分块与缓存

每个（代码, 周期）拆成固定窗口，URL 稳定才能命中缓存：

| 周期 | 历史块（不可变，缓存一年） | 最近一段 |
|---|---|---|
| 日线 | 2016 年（或账单前 3 年）→ 本月 1 日 | 本月 1 日前 7 天 → 现在 |
| 60 分 | 22 个月前 → 本月 1 日（Yahoo 只给约 730 天） | 同上 |
| 30 分 | — | 最近 59 天（Yahoo 只给 60 天） |

- 最近一段的缓存时间按美股交易时段决定：盘中（含盘前盘后 04:00–20:00 ET）日线 5 分钟、分时 2 分钟；收盘后缓存到下一次开盘（最长 6 小时）
- 查无此代码缓存 1 天
- 新代码第一次查看只需 2 次请求；热门代码所有人共用缓存

### 为什么历史块可以永久缓存

浏览器把每个分块还原成**原始价**再自己算复权因子，所以之后再发生拆股或分红，旧块也不需要失效。Yahoo 的拆股调整规则（实测）：

- 日线：按抓取时刻之前的所有拆股调整，与请求窗口无关
- 分时：只按请求窗口内发生的拆股调整

`npm test` 里有用真实数据核对的用例：前复权收盘价与 Yahoo 的 `adjclose` 误差 < 0.2%（AAPL、NVDA、SOXX、SGOV），以及 SOXX 60 分线跨 3:1 拆股的拼接。

## 已知限制

- 账单时间按美东时间解析（IBKR 活动账单的默认设置）
- IBKR 隔夜盘（20:00–04:00 ET）的成交在 Yahoo 上没有对应的 K 线，会挂到下一根盘前 K 线上，价格可能落在该 K 线区间外
- 非美股的 Yahoo 代码是按币种猜的（SGD → .SI，HKD → .HK 等）。对不上时可以在标题旁的 Yahoo 输入框里手动改，改动记在浏览器里
- 期权只标在正股图上，不画期权自己的价格

## 目录

```
public/            前端（静态资源）
  lib/chunks.js    分块协议，浏览器和 Worker 共用
  lib/series.js    解析、还原原始价、复权因子、聚合
  vendor/          lightweight-charts 5.0.8
worker/index.js    Cloudflare Worker + YahooGate
server.py          本地替代后端
smoke/             Yahoo-from-Workers 冒烟测试（独立部署）
test/              node --test
```
