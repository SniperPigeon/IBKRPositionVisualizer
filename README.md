# IBKR Position Visualizer

把 IBKR 活动账单（Activity Statement CSV）里的买卖点标到 K 线上回看，风格参考富途。

- 账单只在浏览器里解析，不会上传；行情来自 Yahoo Finance，请求里只有代码和时间范围
- 日K / 周K / 月K / 60分 / 30分，前复权 / 不复权（拆股 + 分红）
- B/S 标记连到实际成交价，悬停看明细；期权成交和持仓转入标在正股上
- MA、成交量、MACD、持仓曲线、成本线

## 运行

本地（只需 Python 3.9+）：

```bash
python3 server.py [账单.csv]
```

打开 http://127.0.0.1:8765 ，把 CSV 拖进页面（多份账单会自动去重）。

Cloudflare Workers：

```bash
npm install
npm run dev      # http://localhost:8787
npm run deploy
```

## 导出账单

IBKR 网页端 → 业绩和报告 → 报表 → 活动 → 选择期间，格式选 CSV。中文、英文账单都支持。

## 开发

```bash
npm test
```

GitHub Actions 会在每次推送和 PR 时跑测试；推送到 `main` 后自动部署到 Cloudflare（需要在仓库 secrets 里配置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`，没配置时跳过部署）。

架构、行情缓存和复权的细节见 [docs/design.md](docs/design.md)。

## 说明

- 行情使用 Yahoo Finance 的非官方接口，仅供个人使用，请遵守其服务条款
- 与 Interactive Brokers、Yahoo 均无关联，不构成任何投资建议
- 许可证 [GPL-3.0](LICENSE)；内置的 [lightweight-charts](https://github.com/tradingview/lightweight-charts) 为 Apache-2.0（© TradingView）
