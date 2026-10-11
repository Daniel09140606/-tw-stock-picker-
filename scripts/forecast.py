"""明日走向：用規則計分估計「下一個交易日」大盤與個股偏多／偏空的機率，並記錄過去的命中率。

每天跑兩次：
  收盤後（21:30）：用今天的收盤、法人、籌碼、新聞，加上美股期貨盤前走勢
  隔天早上（08:00）：再加上美股收盤（含費半、台積電 ADR）與夜間新聞，作為開盤前的最終版本
這不是保證：分數只是把幾個常見的短線因子加權，網站上會公開過去的命中率讓使用者自己判斷。

輸出 site/data/forecast.json；每個預測日的結果存 data/forecast/{日期}.json 用來算命中率。
"""
from __future__ import annotations

import datetime as dt
import email.utils
import math
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import DATA, HISTORY, SESSION, SITE_DATA, TPE, get_json, read_json, roc_to_iso, write_json  # noqa: E402
from news import GOOD, SKIP, tone  # noqa: E402
from sources import fetch_market_inst, fetch_taiex_month  # noqa: E402

FC_DIR = DATA / "forecast"
MARKET = DATA / "market.json"
SEMI = {"半導體業"}
SEMI_THEMES = {"semi", "icdesign", "memory", "ai_server", "cpo"}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"


def clamp(x: float, a: float = -1.0, b: float = 1.0) -> float:
    return max(a, min(b, x))


HOLIDAYS: set[str] = set()


def load_holidays(log: dict) -> None:
    """證交所休市日（國定假日、補假），避免把預測日排在休市日。"""
    try:
        rows = get_json("https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule")
        for r in rows:
            name, d = str(r.get("Name") or r.get("名稱") or ""), roc_to_iso(r.get("Date") or r.get("日期"))
            if d and not any(k in name for k in ("開始交易", "最後交易")):
                HOLIDAYS.add(d)
        log["holidays"] = len(HOLIDAYS)
    except Exception as e:  # noqa: BLE001
        log["holidays"] = str(e)[:120]


def decide(x: float, k: float, lo: float, hi: float) -> int:
    """把分數轉成上漲機率；一定給方向，不會剛好 50%。"""
    p = int(round(clamp(50 + k * x, lo, hi)))
    if p == 50:
        p = 51 if x >= 0 else 49
    return p


def next_weekday(iso: str) -> str:
    d = dt.date.fromisoformat(iso) + dt.timedelta(days=1)
    while d.weekday() >= 5 or d.isoformat() in HOLIDAYS:
        d += dt.timedelta(days=1)
    return d.isoformat()


def target_day(data_date: str, now: dt.datetime) -> str:
    """下一個還沒收盤的交易日。"""
    t = next_weekday(data_date)
    today = now.date().isoformat()
    while t < today or (t == today and now.hour >= 14):
        t = next_weekday(t)
    return t


# ---------------------------------------------------------------- 大盤資料
def update_market(log: dict) -> list[list]:
    """加權指數每日收盤，存 data/market.json（保留約一年）。"""
    old = (read_json(MARKET, {}) or {}).get("taiex", [])
    rows = {r[0]: r for r in old}
    today = dt.datetime.now(TPE).date()
    months = [today.replace(day=1)]
    if len(old) < 70:   # 第一次：補半年
        m = today.replace(day=1)
        for _ in range(6):
            m = (m - dt.timedelta(days=1)).replace(day=1)
            months.append(m)
    elif today.day <= 3:
        months.append((today.replace(day=1) - dt.timedelta(days=1)).replace(day=1))
    for m in months:
        try:
            for d, c, ch in fetch_taiex_month(m):
                rows[d] = [d, c, ch]
            log[f"taiex_{m:%Y%m}"] = "ok"
        except Exception as e:  # noqa: BLE001
            log[f"taiex_{m:%Y%m}"] = str(e)[:120]
    out = sorted(rows.values())[-260:]
    write_json(MARKET, {"taiex": out})
    return out


def yahoo(symbol: str) -> dict | None:
    """Yahoo Finance 日線：回傳最後一根 K 棒的日期、收盤與漲跌幅。"""
    try:
        r = SESSION.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?range=1mo&interval=1d",
                        timeout=20, headers={"User-Agent": UA})
        j = r.json()["chart"]["result"][0]
        ts, cl = j["timestamp"], j["indicators"]["quote"][0]["close"]
        pts = [(t, c) for t, c in zip(ts, cl) if c]
        if len(pts) < 2:
            return None
        (t1, c1), (_, c0) = pts[-1], pts[-2]
        tz = dt.timezone(dt.timedelta(seconds=j["meta"].get("gmtoffset", 0)))
        return {"date": dt.datetime.fromtimestamp(t1, tz).date().isoformat(), "close": round(c1, 2),
                "pct": round((c1 / c0 - 1) * 100, 2), "name": j["meta"].get("shortName") or symbol}
    except Exception:  # noqa: BLE001
        return None


def market_news() -> list[list]:
    q = urllib.parse.quote("台股 大盤 when:2d")
    try:
        r = SESSION.get(f"https://news.google.com/rss/search?q={q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", timeout=20)
        root = ET.fromstring(r.content)
    except Exception:  # noqa: BLE001
        return []
    out, seen = [], set()
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=36)
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        src = (it.findtext("source") or "").strip()
        if src and title.endswith(" - " + src):
            title = title[: -len(src) - 3].strip()
        if not title or any(w in title or w in src for w in SKIP):
            continue
        key = re.sub(r"\W", "", title)[:24]
        if key in seen:
            continue
        seen.add(key)
        try:
            when = email.utils.parsedate_to_datetime(it.findtext("pubDate") or "")
        except Exception:  # noqa: BLE001
            continue
        if when < cutoff:
            continue
        out.append([title, src, when.astimezone(TPE).strftime("%Y-%m-%d %H:%M"), it.findtext("link") or "", tone(title)])
    out.sort(key=lambda x: (any(g in x[1] for g in GOOD), x[2]), reverse=True)
    return out[:12]


# ---------------------------------------------------------------- 命中率
def history_close(date: str) -> dict:
    d = read_json(HISTORY / f"{date}.json", {}) or {}
    return {c: v[0] for c, v in d.items() if v and v[0]}


def track_record(taiex: list[list]) -> dict:
    hist_dates = sorted(f.stem for f in HISTORY.glob("*.json"))
    tx = {r[0]: r for r in taiex}
    recent, mk, st, strong = [], [0, 0], [0, 0], [0, 0]
    for f in sorted(FC_DIR.glob("*.json"))[-60:]:
        tgt = f.stem
        if tgt not in hist_dates:
            continue
        i = hist_dates.index(tgt)
        if i == 0:
            continue
        fc = read_json(f, {}) or {}
        now, prev = history_close(tgt), history_close(hist_dates[i - 1])
        hit = n = 0
        for c, p in (fc.get("stocks") or {}).items():
            if c in now and c in prev and prev[c]:
                r = now[c] / prev[c] - 1
                if abs(r) < 0.001 or p == 50:
                    continue
                n += 1
                ok = (p > 50 and r > 0) or (p < 50 and r < 0)
                hit += ok
                if p >= 60 or p <= 40:
                    strong[1] += 1
                    strong[0] += ok
        st[0] += hit
        st[1] += n
        mp, mact = fc.get("market"), None
        if tgt in tx and tx[tgt][1]:
            mact = round(tx[tgt][2] / (tx[tgt][1] - tx[tgt][2]) * 100, 2)
            if mp is not None and mp != 50:
                mk[1] += 1
                mk[0] += (mp > 50 and mact > 0) or (mp < 50 and mact < 0)
        recent.append([tgt, mp, mact, hit, n])
    return {"mkt": mk, "stk": st, "strong": strong, "recent": recent[-20:]}


# ---------------------------------------------------------------- 主程式
def main() -> int:
    db = read_json(SITE_DATA / "stocks.json")
    if not db:
        print("找不到 stocks.json")
        return 1
    F = db["fields"]
    rows = [dict(zip(F, r)) for r in db["rows"]]
    news = read_json(SITE_DATA / "news.json", {}) or {}
    now = dt.datetime.now(TPE)
    basis = "pre" if now.hour < 12 else "close"
    log: dict = {}
    load_holidays(log)
    target = target_day(db["date"], now)
    taiex = update_market(log)

    # 大盤因子
    f_us, us_items = 0.0, []
    syms = ["^GSPC", "^IXIC", "^SOX", "TSM"] if basis == "pre" else ["ES=F", "NQ=F", "^SOX", "TSM"]
    us = {s: yahoo(s) for s in syms}
    if basis == "pre":
        fresh = {k: v for k, v in us.items() if v and v["date"] >= db["date"]}
        if fresh:
            f_us = clamp((0.3 * (fresh.get("^GSPC") or {}).get("pct", 0) + 0.3 * (fresh.get("^IXIC") or {}).get("pct", 0)
                          + 0.4 * (fresh.get("^SOX") or {}).get("pct", 0)) / 1.5)
    else:
        es, nq = us.get("ES=F"), us.get("NQ=F")
        if es or nq:
            f_us = clamp((0.5 * (es or {}).get("pct", 0) + 0.5 * (nq or {}).get("pct", 0)) / 1.0)
    for s, v in us.items():
        if v:
            us_items.append([s, v["name"], v["date"], v["close"], v["pct"]])
    semi_us = 0.0
    sox, tsm = us.get("^SOX"), us.get("TSM")
    if basis == "pre" and sox and sox["date"] >= db["date"]:
        semi_us = clamp((0.5 * sox["pct"] + 0.5 * ((tsm or {}).get("pct") or 0)) / 2)

    closes = [r[1] for r in taiex]
    f_trend, tx_info = 0.0, {}
    if len(closes) >= 20:
        c, ma5, ma20 = closes[-1], sum(closes[-5:]) / 5, sum(closes[-20:]) / 20
        ch5 = (c / closes[-6] - 1) * 100
        g = [max(0, closes[i] - closes[i - 1]) for i in range(len(closes) - 14, len(closes))]
        l = [max(0, closes[i - 1] - closes[i]) for i in range(len(closes) - 14, len(closes))]
        rsi = 100 if sum(l) == 0 else 100 - 100 / (1 + sum(g) / max(1e-9, sum(l)))
        f_trend = (0.35 if c > ma5 else -0.35) + (0.35 if c > ma20 else -0.35)
        f_trend += -0.3 if ch5 > 5 or rsi > 78 else 0.3 if ch5 < -5 or rsi < 25 else 0
        f_trend = clamp(f_trend)
        tx_info = {"date": taiex[-1][0], "close": c, "chg": taiex[-1][2], "ma5": round(ma5, 2), "ma20": round(ma20, 2),
                   "ch5": round(ch5, 2), "rsi": round(rsi, 1), "series": [[r[0], r[1]] for r in taiex[-60:]]}
    stocks_only = [r for r in rows if not r.get("et")]
    up = sum(1 for r in stocks_only if (r.get("chg") or 0) > 0)
    dn = sum(1 for r in stocks_only if (r.get("chg") or 0) < 0)
    f_breadth = clamp(((up / (up + dn)) - 0.5) * 2.5) if up + dn else 0.0
    inst_total = sum(r.get("inst") or 0 for r in stocks_only)
    lots3 = {k: sum(r.get(k) or 0 for r in stocks_only) for k in ("fi", "it", "dl")}   # 外資、投信、自營商（張）
    amt = None
    try:
        amt = fetch_market_inst(dt.date.fromisoformat(db["date"]))   # 上市三大法人買賣金額（億元）
    except Exception as e:  # noqa: BLE001
        log["inst_amount"] = str(e)[:120]
    if amt:
        # 外資影響最大；投信連續性高；自營商多為短線避險，權重最低
        f_flow = math.tanh((amt["fi"] + 0.8 * amt["it"] + 0.4 * amt["dl"]) / 250)
    else:
        f_flow = math.tanh((lots3["fi"] + 0.8 * lots3["it"] + 0.4 * lots3["dl"]) / 150000) if any(lots3.values()) else math.tanh(inst_total / 150000)
    mnews = market_news()
    pos, neg = sum(1 for x in mnews if x[4] > 0), sum(1 for x in mnews if x[4] < 0)
    f_news = clamp((pos - neg) / max(4, len(mnews)) * 1.5)
    z = 0.35 * f_us + 0.2 * f_trend + 0.15 * f_breadth + 0.15 * f_flow + 0.15 * f_news
    mprob = decide(z, 30, 22, 78)

    # 個股因子
    news_since = (dt.date.fromisoformat(db["date"]) - dt.timedelta(days=1)).isoformat()
    out_stocks: dict[str, list] = {}
    for r in rows:
        if not r.get("liq") or not r.get("price") or r.get("et") == "槓桿反向":
            continue
        p = r["price"]
        beta = clamp((r.get("sd") or 1.5) / 1.5, 0.5, 1.6)
        is_semi = r.get("ind") in SEMI or bool(SEMI_THEMES & set(r.get("themes") or []))
        m = z * beta
        if is_semi and semi_us:
            m = 0.5 * m + 0.5 * semi_us * beta
        m = clamp(m / 1.2)
        t = 0.0
        if r.get("ma5"):
            t += 0.3 if p > r["ma5"] else -0.3
        if r.get("ma20"):
            t += 0.2 if p > r["ma20"] else -0.2
        rsi = r.get("rsi")
        if rsi is not None:
            t += -0.4 if rsi > 80 else -0.2 if rsi > 72 else 0.4 if rsi < 22 else 0.2 if rsi < 30 else 0
        prev = p - (r.get("chg") or 0)
        pct = (r.get("chg") or 0) / prev * 100 if prev else 0
        if pct >= 9:
            t += 0.3   # 漲停或接近漲停，隔日常有慣性
        elif pct <= -9:
            t -= 0.3
        t = clamp(t / 1.0)
        f = 0.0
        if r.get("vol") and r.get("fi") is not None:
            # 外資、投信、自營商分開加權：投信買賣通常較有延續性，自營商多為避險
            f += clamp(((r.get("fi") or 0) + 1.3 * (r.get("it") or 0) + 0.4 * (r.get("dl") or 0)) / r["vol"] * 4, -0.6, 0.6)
        elif r.get("inst") is not None and r.get("vol"):
            f += clamp(r["inst"] / r["vol"] * 4, -0.6, 0.6)
        if r.get("f5") is not None:
            f += 0.25 if r["f5"] > 0 else -0.25 if r["f5"] < 0 else 0
        f = clamp(f / 0.85)
        c = 0.0
        ls, ls20, vol = r.get("ls"), r.get("ls20"), r.get("vol") or 0
        if ls and ls20 is not None and ls > 2 * max(ls20, 1) and vol and ls > 0.05 * vol:
            c -= 0.5      # 借券賣出突然放大
        if r.get("lbCh5") and vol and r["lbCh5"] > 0.3 * vol:
            c -= 0.2      # 借券餘額 5 日明顯增加
        if r.get("sbCh5") and r.get("sb") and r["sbCh5"] > 0.2 * max(r["sb"] - r["sbCh5"], 1):
            c -= 0.15     # 融券 5 日大增
        if r.get("mbCh5") and r.get("mb") and r["mbCh5"] > 0.15 * max(r["mb"] - r["mbCh5"], 1) and pct < 0:
            c -= 0.15     # 融資追價但股價下跌
        c = clamp(c / 0.8)
        items = [x for x in (news.get("news") or {}).get(r["code"], []) if x[2] >= news_since]   # 近兩天的新聞
        npos, nneg = sum(1 for x in items if x[4] > 0), sum(1 for x in items if x[4] < 0)
        n = clamp((npos - nneg) * 0.3)
        total = 0.35 * m + 0.25 * t + 0.2 * f + 0.1 * c + 0.1 * n
        prob = decide(total if total else m + t * 0.1, 28, 22, 78)
        out_stocks[r["code"]] = [prob, round(m, 2), round(t, 2), round(f, 2), round(c, 2), round(n, 2), npos, nneg]

    FC_DIR.mkdir(parents=True, exist_ok=True)
    write_json(FC_DIR / f"{target}.json", {"basis": basis, "market": mprob, "stocks": {k: v[0] for k, v in out_stocks.items()}})
    for old in sorted(FC_DIR.glob("*.json"))[:-90]:
        old.unlink()
    track = track_record(taiex)
    write_json(SITE_DATA / "forecast.json", {
        "generated": now.isoformat(timespec="minutes"), "basis": basis, "dataDate": db["date"], "target": target,
        "market": {"prob": mprob, "z": round(z, 3),
                   "f": {"us": round(f_us, 2), "trend": round(f_trend, 2), "breadth": round(f_breadth, 2),
                         "flow": round(f_flow, 2), "news": round(f_news, 2)},
                   "up": up, "down": dn, "inst": inst_total, "instLots": lots3, "instAmt": amt, "taiex": tx_info, "us": us_items, "semiUs": round(semi_us, 2),
                   "news": mnews},
        "fields": ["prob", "mkt", "tech", "flow", "chip", "news", "npos", "nneg"],
        "stocks": out_stocks, "track": track, "log": log,
    })
    print(f"明日走向（{basis}）：目標 {target}，大盤 {mprob}%，個股 {len(out_stocks)} 檔；命中率 {track['stk']} {track['mkt']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
