"""每日抓個股最新新聞標題（Google 新聞 RSS）與公司重大訊息（證交所／櫃買 OpenAPI）。

只存標題、來源、日期、連結，不存內文。標題用關鍵字粗判正面／負面，網站上會註明只是參考。
用法：python scripts/news.py            （在 build.py 之後執行，會讀 site/data/stocks.json 決定要抓哪些股票）
"""
from __future__ import annotations

import datetime as dt
import email.utils
import re
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import DATA, SESSION, SITE_DATA, TPE, read_json, roc_to_iso, write_json  # noqa: E402
from sources import TPEX, TWSE, _code, _safe  # noqa: E402

ANN_DIR = DATA / "announcements"
MAX_STOCKS = 700        # 每天抓新聞的股票數上限（依評分與市值排序）
DAYS = 14               # 只留最近 14 天的新聞
PER_STOCK = 6

POS = ["創新高", "新高", "成長", "增長", "大增", "倍增", "年增", "轉盈", "獲利增", "上調", "調升", "調高", "看好", "買超",
       "加碼", "接單", "訂單", "擴產", "漲停", "大漲", "上漲", "受惠", "突破", "優於預期", "旺", "回溫", "強勢", "攻"]
NEG = ["衰退", "下滑", "減少", "年減", "虧損", "轉虧", "下修", "調降", "降評", "賣超", "減碼", "跌停", "重挫", "大跌", "下跌",
       "違約", "訴訟", "罰", "停工", "裁員", "延後", "低於預期", "警示", "處置", "利空", "疲", "砍單", "示警", "跌破"]


def tone(title: str) -> int:
    p = sum(1 for w in POS if w in title)
    n = sum(1 for w in NEG if w in title)
    return 1 if p > n else -1 if n > p else 0


def google_news(code: str, name: str) -> list[list]:
    q = urllib.parse.quote(f"{name} {code}")
    url = f"https://news.google.com/rss/search?q={q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant"
    try:
        r = SESSION.get(url, timeout=20)
        r.raise_for_status()
        root = ET.fromstring(r.content)
    except Exception:  # noqa: BLE001
        return []
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=DAYS)
    out, seen = [], set()
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        src = (it.findtext("source") or "").strip()
        if src and title.endswith(" - " + src):
            title = title[: -len(src) - 3].strip()
        if not title or (name not in title and code not in title):
            continue  # 只留標題有提到這家公司的
        key = re.sub(r"\W", "", title)[:30]
        if key in seen:
            continue
        seen.add(key)
        try:
            when = email.utils.parsedate_to_datetime(it.findtext("pubDate") or "")
        except Exception:  # noqa: BLE001
            continue
        if when < cutoff:
            continue
        out.append([title, src, when.astimezone(TPE).strftime("%Y-%m-%d"), it.findtext("link") or "", tone(title)])
    out.sort(key=lambda x: x[2], reverse=True)
    return out[:PER_STOCK]


def announcements(log: dict) -> dict[str, list]:
    """今天公告的重大訊息存檔，合併最近 30 天。"""
    today: dict[str, list] = {}
    for mkt, url in (("上市", f"{TWSE}/opendata/t187ap04_L"), ("上櫃", f"{TPEX}/mopsfin_t187ap04_O")):
        for r in _safe(f"ann_{mkt}", url, log):
            code = _code(r)
            subj = (r.get("主旨") or r.get("Subject") or "").strip().strip("「」")
            d = roc_to_iso(r.get("發言日期") or r.get("Date"))
            if code and subj and d:
                today.setdefault(code, []).append([d, subj[:120]])
    if today:
        stamp = dt.datetime.now(TPE).date().isoformat()
        old = read_json(ANN_DIR / f"{stamp}.json", {}) or {}
        for c, v in today.items():
            old[c] = [list(x) for x in {tuple(x) for x in old.get(c, []) + v}]
        write_json(ANN_DIR / f"{stamp}.json", old)
    files = sorted(ANN_DIR.glob("*.json"))
    for f in files[:-30]:
        f.unlink()
    merged: dict[str, list] = {}
    for f in sorted(ANN_DIR.glob("*.json")):
        for c, v in (read_json(f, {}) or {}).items():
            merged.setdefault(c, []).extend(v)
    for c in merged:
        uniq = {tuple(x) for x in merged[c]}
        merged[c] = sorted((list(x) for x in uniq), key=lambda x: x[0], reverse=True)[:8]
    return merged


def main() -> int:
    db = read_json(SITE_DATA / "stocks.json")
    if not db:
        print("找不到 stocks.json，先跑 build.py")
        return 1
    F = db["fields"]
    rows = [dict(zip(F, r)) for r in db["rows"]]
    picked = [r for r in rows if r["liq"] and (max(r["sL"], r["sS"]) >= 2 or r["themes"])]
    picked.sort(key=lambda r: (max(r["sL"], r["sS"]), r["cap"] or 0), reverse=True)
    picked = picked[:MAX_STOCKS]
    log: dict = {}
    ann = announcements(log)

    def job(r):
        time.sleep(0.25)
        return r["code"], google_news(r["code"], r["name"])

    news: dict[str, list] = {}
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=4) as ex:
        for code, items in ex.map(job, picked):
            if items:
                news[code] = items
    write_json(SITE_DATA / "news.json", {
        "generated": dt.datetime.now(TPE).isoformat(timespec="minutes"),
        "covered": [r["code"] for r in picked],
        "news": news,
        "ann": ann,
    })
    print(f"新聞：{len(picked)} 檔查詢、{len(news)} 檔有新聞，{time.time() - t0:.0f} 秒；重大訊息 {len(ann)} 家；{log}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
