"""抓每檔 ETF 的基本資料、前十大持股、產業／地區配置、績效與配息（Yahoo 奇摩股市 ETF 頁面內嵌的資料）。

輸出 site/data/etf.json：
  {"generated", "etf": {代號: {...}}, "holders": {股票代號: [[ETF代號, 權重%], ...]}}
前十大持股是投信每月公告的資料，通常落後 1～2 個月；頁面上會標出資料日期與來源連結。
用法：python scripts/etf.py（在 build.py 之後，會讀 site/data/stocks.json 取得 ETF 清單）
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import SESSION, SITE_DATA, TPE, num, read_json, write_json  # noqa: E402

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
DEC = json.JSONDecoder()


def yahoo_url(code: str, mkt: str, page: str) -> str:
    return f"https://tw.stock.yahoo.com/quote/{code}.{'TWO' if mkt == '上櫃' else 'TW'}/{page}"


def embedded(html: str, key: str):
    i = html.find(f'"{key}":')
    if i < 0:
        return None
    j = html.find("{", i)
    try:
        obj, _ = DEC.raw_decode(html, j)
        return obj
    except ValueError:
        return None


def get(url: str) -> str:
    for k in range(3):
        try:
            r = SESSION.get(url, timeout=30, headers={"User-Agent": UA, "Accept": "text/html"})
            if r.status_code == 200:
                return r.text
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2 * (k + 1))
    return ""


def loc(x):
    return x.get("local") if isinstance(x, dict) else x


def fetch_one(code: str, mkt: str, price: float) -> dict | None:
    html = get(yahoo_url(code, mkt, "holding"))
    info = embedded(html, "etfInfo") if html else None
    data = (info or {}).get("data") or {}
    if not data:
        return None
    b, perf, pf = data.get("basicInfo") or {}, data.get("performance") or {}, data.get("portfolio") or {}
    tr = perf.get("totalReturn") or {}
    top = (pf.get("top10Holdings") or {})
    ind = (pf.get("investIndustryWeights") or {})
    out = {
        "aum": num(b.get("totalAssets")),
        "aumDate": b.get("totalAssetsDate"),
        "idx": b.get("primaryProspectusBenchmark") or "",
        "cat": b.get("category") or "",
        "region": loc(b.get("investRegion")) or "",
        "issuer": loc(b.get("providerCompanyName")) or "",
        "full": loc(b.get("fundDisplayName")) or "",
        "mgr": loc(b.get("fundManagerName")) or "",
        "fee": b.get("managementfee"),
        "cust": (b.get("custodianfee") or "")[:60],
        "inc": b.get("inceptionDate"),
        "divFreq": b.get("divCashFreq"),
        "site": (b.get("providerCompany") or {}).get("website"),
        "ret": {k: num(tr.get(f"price_{k}")) for k in ("1m", "3m", "6m", "1y")} | {"ytd": num(tr.get("priceYtd"))},
        "prem": num((perf.get("premiumDiscount") or {}).get("daily")),
        "premDate": (perf.get("premiumDiscount") or {}).get("date"),
        "alloc": {k: num(v) for k, v in (pf.get("assetAllocation") or {}).items() if k != "date" and num(v)},
        "inds": [[x.get("name"), num(x.get("weighting"))] for x in (ind.get("detail") or []) if num(x.get("weighting"))],
        "indDate": ind.get("date"),
        "top": [[(x.get("ticker") or "").replace(".TWO", "").replace(".TW", ""), x.get("name"), num(x.get("weighting"))]
                for x in (top.get("holdingDetail") or [])],
        "topDate": top.get("date"),
    }
    # 配息：近 12 個月每單位配息合計 ÷ 收盤價
    dh = get(yahoo_url(code, mkt, "dividend"))
    if dh:
        m = re.search(r'"dividend-combineCashAndStock--payYear-[^"]+":', dh)
        obj = embedded(dh, m.group(0)[1:-2]) if m else None
        divs = ((obj or {}).get("data") or {}).get("dividends") or []
        cutoff = (dt.datetime.now(TPE) - dt.timedelta(days=365)).date().isoformat()
        recent = [(d.get("exDate", "")[:10], num(d.get("totalDividend")) or num((d.get("exDividend") or {}).get("cash")))
                  for d in divs if d.get("recordType") == "SUB" and d.get("exDate") and not d.get("isUpcoming")
                  and d.get("exDate", "")[:10] <= dt.datetime.now(TPE).date().isoformat()]   # 還沒除息的不算
        recent = sorted({(d, v) for d, v in recent if v})   # 同一天重複的紀錄只算一次
        last12 = sum(v for d, v in recent if d >= cutoff)
        out["div12"] = round(last12, 4) if last12 else 0
        out["yld"] = round(last12 / price * 100, 2) if last12 and price else None
        out["divs"] = sorted(recent, reverse=True)[:6]
    return out


def main() -> int:
    db = read_json(SITE_DATA / "stocks.json")
    if not db:
        print("找不到 stocks.json")
        return 1
    F = db["fields"]
    etfs = [dict(zip(F, r)) for r in db["rows"]]
    etfs = [s for s in etfs if s.get("et")]
    old = (read_json(SITE_DATA / "etf.json", {}) or {}).get("etf", {})
    out: dict[str, dict] = {}
    t0 = time.time()

    def job(s):
        time.sleep(0.3)
        try:
            return s["code"], fetch_one(s["code"], s["mkt"], s["price"])
        except Exception as e:  # noqa: BLE001
            print(s["code"], "失敗", e)
            return s["code"], None

    with ThreadPoolExecutor(max_workers=4) as ex:
        for code, d in ex.map(job, etfs):
            if d:
                out[code] = d
            elif code in old:
                out[code] = old[code]   # 這次抓不到就沿用上次
    holders: dict[str, list] = {}
    for code, d in out.items():
        for tk, _, w in d.get("top") or []:
            if re.fullmatch(r"\d{4}", tk or "") and w:
                holders.setdefault(tk, []).append([code, w])
    for v in holders.values():
        v.sort(key=lambda x: -x[1])
    if len(out) < len(etfs) * 0.5 and old:
        print(f"只抓到 {len(out)}/{len(etfs)} 檔，保留舊資料")
        return 0
    write_json(SITE_DATA / "etf.json", {"generated": dt.datetime.now(TPE).isoformat(timespec="minutes"),
                                         "source": "Yahoo奇摩股市（投信公告資料）", "etf": out, "holders": holders})
    print(f"ETF：{len(out)}/{len(etfs)} 檔，{time.time() - t0:.0f} 秒；被 ETF 持有的個股 {len(holders)} 檔")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
