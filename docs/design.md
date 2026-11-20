# 设计说明

## 结构

```
public/            前端（静态资源，两种后端共用）
  app.js           账单解析、图表、买卖点、表格
  lib/chunks.js    行情分块协议，浏览器和 Worker 共用
  lib/series.js    解析 Yahoo 分块、还原原始价、复权因子、周/月聚合
  vendor/          lightweight-charts 5.0.8（Apache-2.0）
worker/index.js    Cloudflare Worker + YahooGate（Durable Object）
server.py          本地后端（Python 标准库）
smoke/             Yahoo-from-Workers 冒烟测试（独立部署，可选）
test/              node --test
```

账单 CSV 只在浏览器里解析。两种后端都只提供 `/api/chart`（本地版另有 `/api/statements`，用于启动时自动载入账单）。

## 行情分块

每个（代码, 周期）拆成固定窗口，URL 稳定才能命中缓存：

| 周期 | 历史块（不可变，缓存一年） | 最近一段 |
|---|---|---|
| 日线 | 2016 年（或账单前 3 年）→ 本月 1 日 | 本月 1 日前 7 天 → 现在 |
| 60 分 | 22 个月前 → 本月 1 日（Yahoo 只给约 730 天） | 同上 |
| 30 分 | — | 最近 59 天（Yahoo 只给 60 天） |

- 周 K、月 K 由日 K 在浏览器里聚合，不单独请求
- 最近一段的缓存时间按美股交易时段决定：盘中（含盘前盘后 04:00–20:00 ET）日线 5 分钟、分时 2 分钟；收盘后缓存到下一次开盘（最长 6 小时）；非美股统一短 TTL
- 查无此代码缓存 1 天
- query string 必须与规范形式完全一致（参数顺序、无多余参数），否则 400，防止有人绕过缓存
- 新代码第一次查看只需 2 次请求；热门代码所有人共用缓存

## 复权

浏览器把每个分块还原成**原始价**，再自己计算前复权因子，所以之后再发生拆股或分红，旧块也不需要失效，也可以直接显示不复权视图。

Yahoo 的 OHLC 和股息金额做过拆股调整（没有做股息调整），规则因周期而异（实测）：

- 日线：按抓取时刻之前发生的所有拆股调整，与请求窗口无关
- 分时：只按请求窗口内发生的拆股调整

后端在响应头 `X-As-Of` 里带上抓取时间，浏览器据此判断每个分块已经被 Yahoo 应用过哪些拆股。

前复权因子 = 之后所有拆股的 1/比例 × 之后每次除息的（1 − 股息 ÷ 除息前一日收盘价）。K 线、成交价、成本线用同一因子；数量和持仓只受拆股影响。

`npm test` 里有真实数据的核对：前复权收盘价与 Yahoo 的 `adjclose` 误差 < 0.2%（AAPL、NVDA、SOXX、SGOV），以及 SOXX 60 分线跨 3:1 拆股的拼接。

## Cloudflare 后端

- Workers Static Assets 提供 `public/`，只有 `/api/*` 进 Worker（`run_worker_first`）
- `/api/chart` 原样透传 Yahoo 的 JSON，不解析（免费版每次请求只有 10ms CPU）
- 开启 Workers Caching，按响应的 `Cache-Control` 缓存；命中时 Worker 不运行
- 开启 `cross_version_cache`：CI 每次推送 main 都会部署，但缓存不随部署清空。响应格式变化时改 `CHUNK_VERSION`（URL 里的 `v=`），旧缓存自然失效
- 只通过自定义域名提供服务（`routes` 里的 `custom_domain`），`workers_dev` 关闭
- 每次缓存未命中都要经过 `YahooGate`（全站唯一的 Durable Object）：
  - 全局令牌桶 + 每个客户端（IPv4 / IPv6 /64）的令牌桶
  - 每天（UTC）发往 Yahoo 的上限
  - Yahoo 返回 429 时进入冷却：60 秒起，每次翻倍，最长 30 分钟
  - 参数在 `wrangler.jsonc` 的 `vars` 里
- `GET /api/status` 查看今日用量、是否在冷却

## 已知限制

- 账单时间按美东时间解析（IBKR 活动账单的默认设置）
- IBKR 隔夜盘（20:00–04:00 ET）的成交在 Yahoo 上没有对应的 K 线，会挂到下一根盘前 K 线上，价格可能落在该 K 线区间外
- 非美股的 Yahoo 代码按币种猜测（SGD → .SI，HKD → .HK 等），对不上时可以在页面上手动指定
- 期权只标在正股图上，不画期权自己的价格
