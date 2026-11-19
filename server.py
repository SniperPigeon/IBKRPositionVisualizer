#!/usr/bin/env python3
"""IBKR 交易回看 — 本地服务器（不想用 Cloudflare 时的替代方案）

和 Cloudflare Worker 提供同一套接口，前端代码完全一样：
  - 提供 public/ 下的静态文件
  - /api/chart：按分块协议（见 public/lib/chunks.js）代理 Yahoo，并缓存到 ./cache/chunks/
  - /api/statements：启动时通过命令行传入的账单 CSV（只有本地版有）

账单 CSV 只在浏览器里解析；发往 Yahoo 的只有股票代码和时间范围。

缓存：历史块（part=hist）永久缓存；最近一段（tail/recent）按是否开盘决定新鲜期；
查无此代码缓存 1 天；联网失败时退回过期缓存。删掉 cache/ 目录就是完全重来。

用法:
  python3 server.py                          # 打开页面后拖入 CSV
  python3 server.py ~/Downloads/U123.csv     # 启动时自动载入（可传多个文件）
  python3 server.py --port 9000 --no-browser
"""
import argparse
import datetime as dt
import hashlib
import http.server
import json
import mimetypes
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
PUBLIC = os.path.join(ROOT, "public")
CACHE_DIR = os.path.join(ROOT, "cache", "chunks")
YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]
# 注意：完整的 Chrome UA 反而会被 Yahoo 判成爬虫返回 429，简短的 UA 可以正常访问
UA = "Mozilla/5.0"
DAY = 86400
STATEMENTS = []
_locks = {}
_locks_guard = threading.Lock()

# ---- 分块协议（与 public/lib/chunks.js 保持一致） ------------------------------------------
CHUNK_VERSION = "1"
INTERVALS = ("1d", "60m", "30m")
SYMBOL_RE = re.compile(r"^[A-Z0-9.\-^=]{1,24}$")
HIST_CACHE_CONTROL = "public, max-age=31536000, immutable"
ET = ZoneInfo("America/New_York")


def month_index(epoch):
    d = dt.datetime.fromtimestamp(epoch, dt.timezone.utc)
    return d.year * 12 + d.month - 1


def month_start(i):
    return int(dt.datetime(i // 12, i % 12 + 1, 1, tzinfo=dt.timezone.utc).timestamp())


def parse_ym(s):
    m = re.fullmatch(r"(\d{4})-(\d{2})", s or "")
    if not m:
        return None
    y, mo = int(m.group(1)), int(m.group(2))
    if y < 1970 or not 1 <= mo <= 12:
        return None
    return y * 12 + mo - 1


def tail_ttl(symbol, interval, now):
    live = 300 if interval == "1d" else 120
    if not re.fullmatch(r"[A-Z0-9-]+", symbol):
        return live
    t = dt.datetime.fromtimestamp(now, ET)
    wd = (t.weekday() + 1) % 7          # 与 JS 一致：0=周日
    minute = t.hour * 60 + t.minute
    open_, close = 4 * 60, 20 * 60
    weekday = 1 <= wd <= 5
    if weekday and open_ <= minute < close:
        return live
    if weekday and minute < open_:
        days = 0
    elif wd == 5:
        days = 3
    elif wd == 6:
        days = 2
    else:
        days = 1
    return max(300, min(6 * 3600, days * DAY + (open_ - minute) * 60))


def tail_cache_control(symbol, interval, now):
    t = tail_ttl(symbol, interval, now)
    return f"public, max-age={t}, stale-while-revalidate={min(t, 600)}"


def parse_chunk(q, now):
    """q: dict[str, str]。本地版不强制参数顺序。"""
    v, s, i, part = q.get("v"), q.get("s", ""), q.get("i", ""), q.get("part", "")
    if v != CHUNK_VERSION:
        return {"error": "unsupported version"}
    if not SYMBOL_RE.match(s):
        return {"error": "bad symbol"}
    if i not in INTERVALS:
        return {"error": "bad interval"}
    cur = month_index(now)
    if part == "hist" and i != "30m":
        to = parse_ym(q.get("to"))
        if to is None or to > cur:
            return {"error": "bad to"}
        if i == "1d":
            fy = q.get("from", "")
            if not re.fullmatch(r"\d{4}", fy) or int(fy) < 1970 or month_start(int(fy) * 12) >= month_start(to):
                return {"error": "bad from"}
            p1 = month_start(int(fy) * 12)
        else:
            frm = parse_ym(q.get("from"))
            if frm is None or frm >= to or cur - frm > 23:
                return {"error": "bad from"}
            p1 = month_start(frm)
        out = {"period1": p1, "period2": month_start(to), "cache_control": HIST_CACHE_CONTROL, "ttl": None}
    elif part == "tail" and i != "30m":
        frm = parse_ym(q.get("from"))
        if frm is None or frm > cur or frm < cur - 1:
            return {"error": "bad from"}
        out = {"period1": month_start(frm) - 7 * DAY, "period2": now,
               "cache_control": tail_cache_control(s, i, now), "ttl": tail_ttl(s, i, now)}
    elif part == "recent" and i == "30m":
        out = {"period1": now - 59 * DAY, "period2": now,
               "cache_control": tail_cache_control(s, i, now), "ttl": tail_ttl(s, i, now)}
    else:
        return {"error": "bad part"}
    out.update(symbol=s, interval=i, part=part)
    return out


# ---- Yahoo + 缓存 ---------------------------------------------------------------------------
def yahoo_fetch(c):
    params = {"interval": c["interval"], "period1": c["period1"], "period2": c["period2"], "events": "div,split"}
    if c["interval"] != "1d":
        params["includePrePost"] = "true"
    qs = urllib.parse.urlencode(params)
    last = None
    for host in YAHOO_HOSTS:
        url = f"https://{host}/v8/finance/chart/{urllib.parse.quote(c['symbol'])}?{qs}"
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            last = (e.code, e.read())
            if e.code < 500:
                break
        except Exception as e:  # noqa: BLE001
            last = (0, str(e).encode())
    return last


def key_lock(key):
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


def cache_get(key):
    try:
        with open(os.path.join(CACHE_DIR, key + ".json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def cache_put(key, entry):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, key + ".json")
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(entry, f, separators=(",", ":"))
    os.replace(path + ".tmp", path)


def get_chunk(c, canon, refresh):
    """返回 (status, body_bytes, as_of, source)。"""
    now = int(time.time())
    key = hashlib.sha1(canon.encode()).hexdigest()
    with key_lock(key):
        hit = cache_get(key)
        if hit and not refresh and (hit["until"] is None or hit["until"] > now):
            return hit["status"], hit["body"].encode(), hit["as_of"], "cache"
        res = yahoo_fetch(c)
        status, body = res if res else (0, b"")
        if status == 200:
            until = None if c["ttl"] is None else now + c["ttl"]
            cache_put(key, {"status": 200, "body": body.decode(), "as_of": now, "until": until})
            return 200, body, now, "network"
        if status == 404:
            cache_put(key, {"status": 404, "body": "", "as_of": now, "until": now + DAY})
            return 404, b"", now, "network"
        if hit:   # 联网失败：退回过期缓存
            return hit["status"], hit["body"].encode(), hit["as_of"], "stale"
        return status, body, now, "network"


# ---- HTTP -----------------------------------------------------------------------------------
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if os.environ.get("VERBOSE"):
            super().log_message(fmt, *args)

    def send_bytes(self, code, body, ctype, headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, code, obj, headers=None):
        self.send_bytes(code, json.dumps(obj).encode(), "application/json; charset=utf-8",
                        {"Cache-Control": "no-store", **(headers or {})})

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path == "/api/statements":
            out = []
            for p in STATEMENTS:
                with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
                    out.append({"name": os.path.basename(p), "content": f.read()})
            return self.send_json(200, out)
        if u.path == "/api/chart":
            return self.chart(u.query)
        if u.path.startswith("/api/"):
            return self.send_json(404, {"error": "not found"})
        return self.static(u.path)

    def static(self, path):
        rel = "index.html" if path in ("", "/") else urllib.parse.unquote(path).lstrip("/")
        full = os.path.realpath(os.path.join(PUBLIC, rel))
        if not full.startswith(os.path.realpath(PUBLIC) + os.sep) or not os.path.isfile(full):
            return self.send_json(404, {"error": "not found"})
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype in ("text/html", "text/javascript", "application/javascript"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            self.send_bytes(200, f.read(), ctype, {"Cache-Control": "no-cache"})

    def chart(self, query):
        q = {k: v[0] for k, v in urllib.parse.parse_qs(query).items()}
        refresh = q.pop("refresh", None) == "1"
        now = int(time.time())
        c = parse_chunk(q, now)
        if "error" in c:
            return self.send_json(400, c)
        canon = urllib.parse.urlencode(sorted(q.items()))
        status, body, as_of, source = get_chunk(c, canon, refresh)
        if status == 200:
            return self.send_bytes(200, body, "application/json; charset=utf-8", {
                "Cache-Control": c["cache_control"], "X-As-Of": str(as_of), "X-Source": source})
        if status == 404:
            return self.send_json(404, {"error": "symbol not found"})
        if status in (400, 422):
            return self.send_json(400, {"error": "range not available"})
        if status == 429:
            return self.send_json(503, {"error": "rate_limited", "reason": "upstream", "retryAfter": 60},
                                  {"Retry-After": "60"})
        return self.send_json(502, {"error": f"upstream {status}"})


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
