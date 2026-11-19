#!/usr/bin/env python3
"""IBKR Trade Visualizer — 本地服务器

只做两件事：
  1. 提供 index.html / app.js 静态文件
  2. 代理 Yahoo Finance 的 chart 接口（浏览器直连会被 CORS 拦截），并把行情缓存到 ./cache/

账单 CSV 只在浏览器里解析，不会被上传到任何地方；发往 Yahoo 的只有股票代码和时间范围。

行情缓存（cache/<symbol>_<interval>.json）:
  - 新鲜期内（日线 30 分钟、分钟线 2 分钟）直接读本地，不联网
  - 过期后只增量拉取最近几天，与本地合并
  - 发现新的拆股事件时，把本地旧 bar 按比例复权（与 Yahoo 的拆股调整口径一致）
  - 分钟线会越攒越多：Yahoo 只给最近 60 天的 5/15 分钟线，但本地缓存会一直保留
  - 联网失败时退回本地缓存（标记为 stale）
  - 想强制刷新：页面上点「↻」，或直接删除 cache/ 目录

用法:
  python3 server.py                          # 打开页面后拖入 CSV
  python3 server.py ~/Downloads/U123.csv     # 启动时自动载入（可传多个文件）
  python3 server.py --port 9000 --no-browser
"""
import argparse
import datetime as dt
import http.server
import json
import os
import re
import socketserver
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(ROOT, "cache")
STATIC = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js"}
YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]
# 注意：完整的 Chrome UA 反而会被 Yahoo 判成爬虫返回 429，简短的 UA 可以正常访问
UA = "Mozilla/5.0"
SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-^=]{1,24}$")
# 每种周期: 新鲜期(秒)、Yahoo 允许回溯的最长时间(秒)、增量拉取时回看多久(秒)
INTERVALS = {
    "1d":  {"ttl": 1800, "limit": None,          "overlap": 10 * 86400},
    "60m": {"ttl": 120,  "limit": 729 * 86400,   "overlap": 3 * 86400},
    "15m": {"ttl": 120,  "limit": 59 * 86400,    "overlap": 2 * 86400},
    "5m":  {"ttl": 120,  "limit": 59 * 86400,    "overlap": 2 * 86400},
}
META_KEYS = ("currency", "symbol", "exchangeName", "fullExchangeName", "instrumentType",
             "exchangeTimezoneName", "longName", "shortName", "regularMarketPrice",
             "regularMarketTime", "previousClose", "chartPreviousClose")
STATEMENTS = []
_locks = {}
_locks_guard = threading.Lock()


# ---------------------------------------------------------------- Yahoo
def yahoo_fetch(symbol, interval, p1, p2):
    params = {"interval": interval, "period1": int(p1), "period2": int(p2), "events": "div,split"}
    if interval.endswith("m"):
        params["includePrePost"] = "true"
    qs = urllib.parse.urlencode(params)
    last_err = None
    for host in YAHOO_HOSTS:
        url = f"https://{host}/v8/finance/chart/{urllib.parse.quote(symbol)}?{qs}"
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                js = json.load(r)
            return normalize(js)
        except urllib.error.HTTPError as e:
            try:
                desc = json.load(e)["chart"]["error"]["description"]
            except Exception:  # noqa: BLE001
                desc = ""
            last_err = f"Yahoo HTTP {e.code} {desc}".strip()
            if e.code in (400, 404, 422):
                break
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
    raise RuntimeError(last_err or "unknown error")


def normalize(js):
    chart = js.get("chart") or {}
    if chart.get("error"):
        raise RuntimeError(chart["error"].get("description") or "Yahoo error")
    r = (chart.get("result") or [None])[0]
    if not r:
        raise RuntimeError("Yahoo 没有返回数据")
    meta = {k: r["meta"][k] for k in META_KEYS if k in r.get("meta", {})}
    ts = r.get("timestamp") or []
    q = ((r.get("indicators") or {}).get("quote") or [{}])[0]
    cols = [q.get(k) or [None] * len(ts) for k in ("open", "high", "low", "close", "volume")]
    bars = []
    for i, t in enumerate(ts):
        o, h, l, c, v = (col[i] for col in cols)
        if None in (o, h, l, c):
            continue
        bars.append([int(t), round(o, 6), round(h, 6), round(l, 6), round(c, 6), int(v or 0)])
    splits = [[int(s["date"]), s["numerator"], s["denominator"]]
              for s in ((r.get("events") or {}).get("splits") or {}).values()]
    return meta, bars, sorted(splits)


# ---------------------------------------------------------------- cache
def key_lock(key):
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


def cache_path(symbol, interval):
    safe = re.sub(r"[^A-Za-z0-9.\-]", "_", symbol)
    return os.path.join(CACHE_DIR, f"{safe}_{interval}.json")


def cache_load(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            c = json.load(f)
        return c if c.get("v") == 1 else None
    except (OSError, ValueError):
        return None


def cache_save(path, c):
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(c, f, separators=(",", ":"))
    os.replace(tmp, path)


def apply_new_splits(bars, splits, tzname):
    """把拆股日之前的旧 bar 复权（价格 / ratio，成交量 * ratio）。"""
    tz = ZoneInfo(tzname or "America/New_York")
    for ts, num, den in splits:
        if not num or not den:
            continue
        ratio = num / den
        split_day = dt.datetime.fromtimestamp(ts, tz).date()
        for b in bars:
            if dt.datetime.fromtimestamp(b[0], tz).date() < split_day:
                b[1:5] = [round(x / ratio, 6) for x in b[1:5]]
                b[5] = int(b[5] * ratio)
    return bars


def get_series(symbol, interval, p1, refresh=False):
    cfg = INTERVALS[interval]
    now = int(time.time())
    if cfg["limit"]:
        p1 = max(p1, now - cfg["limit"])
    path = cache_path(symbol, interval)
    with key_lock(path):
        c = cache_load(path)
        if c is None:
            meta, bars, splits = yahoo_fetch(symbol, interval, p1, now)
            c = {"v": 1, "symbol": symbol, "interval": interval, "meta": meta, "bars": bars,
                 "splits": splits, "covered_from": p1, "fetched_at": now}
            cache_save(path, c)
            return c, "network", None

        source, err, changed = "cache", None, False
        try:
            tzname = c["meta"].get("exchangeTimezoneName")
            # 1) 增量：只拉最近一段，覆盖本地同一时间窗
            if refresh or now - c["fetched_at"] > cfg["ttl"]:
                last = c["bars"][-1][0] if c["bars"] else p1
                d1 = last - cfg["overlap"]
                if cfg["limit"]:
                    d1 = max(d1, now - cfg["limit"])
                meta, bars, splits = yahoo_fetch(symbol, interval, d1, now)
                known = {s[0] for s in c["splits"]}
                new_splits = [s for s in splits if s[0] not in known]
                old = [b for b in c["bars"] if b[0] < d1]
                if new_splits:
                    apply_new_splits(old, new_splits, meta.get("exchangeTimezoneName") or tzname)
                    c["splits"] = sorted(c["splits"] + new_splits)
                c["bars"] = old + bars
                c["meta"] = {**c["meta"], **meta}
                c["fetched_at"] = now
                source, changed = "network", True
            # 2) 往前补：请求的起点比本地覆盖范围更早（比如追加了更早的账单）
            if p1 < c["covered_from"] - 86400:
                meta, bars, splits = yahoo_fetch(symbol, interval, p1, c["covered_from"] + 86400)
                first = c["bars"][0][0] if c["bars"] else now
                c["bars"] = [b for b in bars if b[0] < first] + c["bars"]
                known = {s[0] for s in c["splits"]}
                c["splits"] = sorted(c["splits"] + [s for s in splits if s[0] not in known])
                c["covered_from"] = p1
                source, changed = "network", True
        except Exception as e:  # noqa: BLE001 — 联网失败就用本地缓存
            source, err = "stale", str(e)
        if changed:
            cache_save(path, c)
        return c, source, err


# ---------------------------------------------------------------- HTTP
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if os.environ.get("VERBOSE"):
            super().log_message(fmt, *args)

    def send_bytes(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, code, obj):
        self.send_bytes(code, json.dumps(obj, separators=(",", ":")).encode(),
                        "application/json; charset=utf-8")

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path in STATIC:
            fname = STATIC[u.path]
            ctype = "text/html; charset=utf-8" if fname.endswith(".html") else "text/javascript; charset=utf-8"
            with open(os.path.join(ROOT, fname), "rb") as f:
                return self.send_bytes(200, f.read(), ctype)
        if u.path == "/api/statements":
            out = []
            for p in STATEMENTS:
                with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
                    out.append({"name": os.path.basename(p), "content": f.read()})
            return self.send_json(200, out)
        if u.path == "/api/chart":
            return self.chart(urllib.parse.parse_qs(u.query))
        return self.send_json(404, {"error": "not found"})

    def chart(self, q):
        sym = (q.get("symbol") or [""])[0]
        interval = (q.get("interval") or ["1d"])[0]
        if not SYMBOL_RE.match(sym) or interval not in INTERVALS:
            return self.send_json(400, {"error": "bad symbol or interval"})
        try:
            p1 = int((q.get("period1") or ["0"])[0])
        except ValueError:
            return self.send_json(400, {"error": "bad period1"})
        refresh = (q.get("refresh") or ["0"])[0] == "1"
        try:
            c, source, err = get_series(sym, interval, p1, refresh)
        except Exception as e:  # noqa: BLE001
            return self.send_json(502, {"error": str(e)})
        return self.send_json(200, {"symbol": sym, "interval": interval, "meta": c["meta"],
                                    "bars": c["bars"], "splits": c["splits"],
                                    "fetched_at": c["fetched_at"], "source": source, "error": err})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description="IBKR trade visualizer (local)")
    ap.add_argument("csv", nargs="*", help="IBKR Activity Statement CSV 文件")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    for p in args.csv:
        p = os.path.abspath(os.path.expanduser(p))
        if not os.path.isfile(p):
            ap.error(f"找不到文件: {p}")
        STATEMENTS.append(p)
    srv = Server(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"IBKR Trade Visualizer → {url}")
    print(f"行情缓存目录: {CACHE_DIR}")
    if STATEMENTS:
        print("自动载入:", ", ".join(os.path.basename(p) for p in STATEMENTS))
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
