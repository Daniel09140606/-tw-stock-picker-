"""從證交所（上市）與櫃買中心（上櫃）的官方 OpenAPI 抓資料，整理成統一格式。

每個來源都容錯：抓不到就記錄錯誤、回傳空資料，不讓整個流程失敗。
欄位名稱用多個候選名稱比對，因為兩個交易所的 JSON key 不同，且偶爾改版。
"""
from __future__ import annotations

import datetime as dt
from typing import Any

from common import get_json, num, pick, roc_to_iso

TWSE = "https://openapi.twse.com.tw/v1"
TPEX = "https://www.tpex.org.tw/openapi/v1"

# 證交所產業代碼（公司基本資料用代碼，月營收用中文名稱）
INDUSTRY_CODES = {
    "01": "水泥工業", "02": "食品工業", "03": "塑膠工業", "04": "紡織纖維", "05": "電機機械",
    "06": "電器電纜", "08": "玻璃陶瓷", "09": "造紙工業", "10": "鋼鐵工業", "11": "橡膠工業",
    "12": "汽車工業", "14": "建材營造", "15": "航運業", "16": "觀光餐旅", "17": "金融保險",
    "18": "貿易百貨", "19": "綜合", "20": "其他", "21": "化學工業", "22": "生技醫療",
    "23": "油電燃氣", "24": "半導體業", "25": "電腦及週邊設備業", "26": "光電業",
    "27": "通信網路業", "28": "電子零組件業", "29": "電子通路業", "30": "資訊服務業",
    "31": "其他電子業", "32": "文化創意業", "33": "農業科技業", "34": "電子商務",
    "35": "綠能環保", "36": "數位雲端", "37": "運動休閒", "38": "居家生活", "80": "管理股票",
    "91": "存託憑證",
}

CODE_KEYS = ("Code", "SecuritiesCompanyCode", "公司代號", "證券代號", "股票代號", "代號")
CODE_RE = r"(代號|Code)$"


def _code(row: dict) -> str | None:
    c = pick(row, *CODE_KEYS, regex=CODE_RE)
    return str(c).strip() if c is not None else None


def _safe(name: str, url: str, log: dict) -> list[dict]:
    try:
        data = get_json(url)
        if isinstance(data, dict):  # 少數端點包一層
            for k in ("data", "aaData", "tables", "result"):
                if isinstance(data.get(k), list):
                    data = data[k]
                    break
        rows = data if isinstance(data, list) else []
        log[name] = {"ok": True, "rows": len(rows), "keys": list(rows[0].keys()) if rows and isinstance(rows[0], dict) else []}
        return [r for r in rows if isinstance(r, dict)]
    except Exception as e:  # noqa: BLE001
        log[name] = {"ok": False, "error": str(e)[:300]}
        return []


def fetch_quotes(log: dict) -> tuple[dict[str, dict], str | None]:
    """收盤價與成交量。回傳 {code: {...}}, 資料日期。"""
    out: dict[str, dict] = {}
    dates: list[str] = []
    mdates: dict[str, str] = {}
    for mkt, url in (("上市", f"{TWSE}/exchangeReport/STOCK_DAY_ALL"),
                     ("上櫃", f"{TPEX}/tpex_mainboard_daily_close_quotes")):
        for r in _safe(f"quotes_{mkt}", url, log):
            code = _code(r)
            if not code:
                continue
            close = num(pick(r, "ClosingPrice", "Close", "收盤價", "收盤", regex=r"(Clos|收盤)"))
            if close is None or close <= 0:
                continue
            vol = num(pick(r, "TradeVolume", "TradingShares", "成交股數", regex=r"(TradeVolume|TradingShares|成交股數)"))
            chg = num(pick(r, "Change", "漲跌價差", "漲跌", regex=r"(Change|漲跌)"))
            name = pick(r, "Name", "CompanyName", "證券名稱", "公司名稱", regex=r"(Name|名稱)")
            d = roc_to_iso(pick(r, "Date", "資料日期", regex=r"(Date|日期)"))
            if d:
                dates.append(d)
                mdates[code] = d
            out[code] = {"code": code, "name": (name or "").strip(), "mkt": mkt, "price": close,
                         "chg": chg, "vol": vol}
    date = max(dates) if dates else None
    log["quote_dates"] = {m: max((d for c, d in mdates.items() if out.get(c, {}).get("mkt") == m), default=None) for m in ("上市", "上櫃")}
    refresh_today(out, log)
    date = max([d for d in log["quote_dates"].values() if d] or ([date] if date else [])) or None
    return out, date


def refresh_today(out: dict[str, dict], log: dict) -> None:
    """OpenAPI 的收盤行情常常要到晚上甚至隔天才更新（2026/10/5 17:55 上市還是 10/2 的價格）。
    若某市場的資料日期早於今天，改抓證交所／櫃買網站的當日收盤行情（收盤後約 14:30 就有）覆蓋。"""
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8)))
    today = now.date()
    if today.weekday() >= 5 or now.hour < 15:
        return
    for mkt, fn in (("上市", twse_quotes_day), ("上櫃", tpex_quotes_day)):
        if (log["quote_dates"].get(mkt) or "") >= today.isoformat():
            continue
        try:
            fresh = fn(today)
        except Exception as e:  # noqa: BLE001
            log[f"fresh_{mkt}"] = {"ok": False, "error": str(e)[:300]}
            continue
        log[f"fresh_{mkt}"] = {"ok": True, "rows": len(fresh)}
        if len(fresh) < 300:   # 休市日或還沒公布
            continue
        for code, q in fresh.items():
            if code in out and out[code]["mkt"] != mkt:
                continue
            out[code] = {**out.get(code, {"code": code, "mkt": mkt}), **q}
        log["quote_dates"][mkt] = today.isoformat()


def _fi(fields: list, *names: str, default: int | None = None) -> int | None:
    f = [str(x).strip() for x in fields]
    for n in names:
        for i, x in enumerate(f):
            if x.startswith(n):
                return i
    return default


def twse_quotes_day(d: dt.date) -> dict[str, dict]:
    j = get_json(f"https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={d:%Y%m%d}&type=ALLBUT0999&response=json")
    out: dict[str, dict] = {}
    for t in j.get("tables") or []:
        fields = t.get("fields") or []
        if "證券代號" not in fields or "收盤價" not in fields:
            continue
        ci, ni, vi, pi = _fi(fields, "證券代號"), _fi(fields, "證券名稱"), _fi(fields, "成交股數"), _fi(fields, "收盤價")
        si, di = _fi(fields, "漲跌(+/-)"), _fi(fields, "漲跌價差")
        for row in t.get("data") or []:
            price = num(row[pi])
            if not price:
                continue
            diff = num(row[di]) if di is not None else None
            sign = str(row[si]) if si is not None else ""
            chg = None if diff is None else (-diff if "-" in sign else diff)
            out[str(row[ci]).strip()] = {"name": str(row[ni]).strip(), "price": price, "chg": chg,
                                         "vol": num(row[vi]) if vi is not None else None}
    return out


def tpex_quotes_day(d: dt.date) -> dict[str, dict]:
    j = get_json("https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php"
                 f"?l=zh-tw&o=json&d={_roc(d)}")
    tables = j.get("tables") or [{}]
    rows = j.get("aaData") or tables[0].get("data") or []
    fields = tables[0].get("fields") or []
    if j.get("reportDate") or j.get("date"):
        rd = str(j.get("reportDate") or j.get("date")).replace("/", "")
        if rd and rd not in (f"{d:%Y%m%d}", _roc(d).replace("/", "")):
            return {}   # 回傳的不是今天的資料
    ci, ni, pi = _fi(fields, "代號", default=0), _fi(fields, "名稱", default=1), _fi(fields, "收盤", default=2)
    gi, vi = _fi(fields, "漲跌", default=3), _fi(fields, "成交股數", default=8)
    out: dict[str, dict] = {}
    for row in rows:
        if len(row) <= max(ci, pi):
            continue
        price = num(row[pi])
        if not price:
            continue
        out[str(row[ci]).strip()] = {"name": str(row[ni]).strip(), "price": price,
                                     "chg": num(row[gi]) if len(row) > gi else None,
                                     "vol": num(row[vi]) if len(row) > vi else None}
    return out


def fetch_valuation(log: dict) -> dict[str, dict]:
    """本益比、殖利率、股價淨值比。"""
    out: dict[str, dict] = {}
    for mkt, url in (("上市", f"{TWSE}/exchangeReport/BWIBBU_ALL"),
                     ("上櫃", f"{TPEX}/tpex_mainboard_peratio_analysis")):
        for r in _safe(f"valuation_{mkt}", url, log):
            code = _code(r)
            if not code:
                continue
            out[code] = {
                "pe": num(pick(r, "PEratio", "PriceEarningRatio", "本益比", regex=r"(PE|EarningRatio|本益比)")),
                "yld": num(pick(r, "DividendYield", "YieldRatio", "殖利率", regex=r"(Yield|殖利率)")),
                "pb": num(pick(r, "PBratio", "PriceBookRatio", "股價淨值比", regex=r"(PB|BookRatio|淨值比)")),
            }
    return out


def fetch_revenue(log: dict) -> dict[str, dict]:
    """最新月營收：年增率、累計年增率、資料月份、產業別（中文）。"""
    out: dict[str, dict] = {}
    for mkt, url in (("上市", f"{TWSE}/opendata/t187ap05_L"),
                     ("上櫃", f"{TPEX}/mopsfin_t187ap05_O")):
        for r in _safe(f"revenue_{mkt}", url, log):
            code = _code(r)
            if not code:
                continue
            ym = str(pick(r, "資料年月", regex=r"(資料年月|YearMonth|DataYearMonth)") or "")
            month = None
            if len(ym) >= 5 and ym.isdigit():
                month = f"{int(ym[:-2]) + 1911}-{ym[-2:]}"
            out[code] = {
                "rev": num(pick(r, "營業收入-去年同月增減(%)", regex=r"(去年同月增減|YoY|YearOnYear)")),
                "revCum": num(pick(r, "累計營業收入-前期比較增減(%)", regex=r"(累計.*增減|Cumulative.*%)")),
                "revCur": num(pick(r, "營業收入-當月營收", regex=r"(當月營收$|MonthlyRevenue$)")),
                "revPrevM": num(pick(r, "營業收入-上月營收", regex=r"(上月營收$|LastMonthRevenue)")),
                "revLY": num(pick(r, "營業收入-去年當月營收", regex=r"(去年當月營收$|LastYearMonthRevenue)")),
                "revMoM": num(pick(r, "營業收入-上月比較增減(%)", regex=r"(上月比較增減|MoM)")),
                "revCumCur": num(pick(r, "累計營業收入-當月累計營收", regex=r"(當月累計營收$)")),
                "revCumLY": num(pick(r, "累計營業收入-去年累計營收", regex=r"(去年累計營收$)")),
                "revMonth": month,
                "indName": (pick(r, "產業別", regex=r"(產業別|Industry)") or "").strip() or None,
            }
    return out


def fetch_profile(log: dict) -> dict[str, dict]:
    """公司簡稱、產業代碼、已發行股數（算市值）。"""
    out: dict[str, dict] = {}
    for mkt, url in (("上市", f"{TWSE}/opendata/t187ap03_L"),
                     ("上櫃", f"{TPEX}/mopsfin_t187ap03_O")):
        for r in _safe(f"profile_{mkt}", url, log):
            code = _code(r)
            if not code:
                continue
            ind = pick(r, "產業別", "SecuritiesIndustryCode", regex=r"(產業別|IndustryCode|Industry)")
            ind = str(ind).strip() if ind is not None else None
            if ind and ind.isdigit():
                ind = INDUSTRY_CODES.get(ind.zfill(2), ind)
            out[code] = {
                "short": (pick(r, "公司簡稱", "CompanyAbbreviation", regex=r"(簡稱|Abbreviation)") or "").strip() or None,
                "indName": ind,
                "shares": num(pick(r, "已發行普通股數或TDR原股發行股數", "IssueShares",
                                   regex=r"(已發行普通股|IssueShares|IssuedShares)")),
            }
    return out


INCOME_KINDS = ("ci", "fh", "basi", "bd", "ins", "mim")


def fetch_income(log: dict) -> dict[str, dict]:
    """最新一季（年初累計）綜合損益表：營收、毛利、營業利益、稅前淨利、稅後淨利、EPS。單位千元。"""
    out: dict[str, dict] = {}
    for mkt, base, suffix in (("上市", f"{TWSE}/opendata/t187ap06_L_", ""), ("上櫃", f"{TPEX}/mopsfin_t187ap06_O_", "")):
        for kind in INCOME_KINDS:
            for r in _safe(f"income_{mkt}_{kind}", base + kind + suffix, log):
                code = _code(r)
                if not code:
                    continue
                y = num(pick(r, "年度", regex=r"(年度|Year)"))
                q = num(pick(r, "季別", regex=r"(季別|Season|Quarter)"))
                general = kind in ("ci", "mim")  # 金融業報表沒有可比的「營業收入／毛利」
                rev = num(pick(r, "營業收入", regex=r"^營業收入$")) if general else None
                out[code] = {
                    "plYear": int(y) + 1911 if y and y < 1000 else (int(y) if y else None),
                    "plQ": int(q) if q else None,
                    "plRev": rev,
                    "plGP": num(pick(r, "營業毛利（毛損）淨額", "營業毛利（毛損）", regex=r"^營業毛利")) if general else None,
                    "plOP": num(pick(r, "營業利益（損失）", regex=r"^營業利益")),
                    "plPretax": num(pick(r, "稅前淨利（淨損）", "繼續營業單位稅前損益", "繼續營業單位稅前淨利（淨損）", regex=r"稅前")),
                    "plNI": num(pick(r, "淨利（淨損）歸屬於母公司業主", "本期淨利（淨損）", "本期稅後淨利（淨損）", regex=r"歸屬於母公司業主$")),
                    "plEPS": num(pick(r, "基本每股盈餘（元）", regex=r"基本每股盈餘")),
                }
    return out


def _roc(d: dt.date) -> str:
    return f"{d.year - 1911}/{d.month:02d}/{d.day:02d}"


def fetch_institutional(date_iso: str | None, log: dict) -> dict[str, float]:
    """三大法人當日買賣超（張）。上市用 T86，上櫃用 3itrade。失敗就回傳空的。"""
    out: dict[str, float] = {}
    if not date_iso:
        return out
    d = dt.date.fromisoformat(date_iso)
    # 上市
    try:
        j = get_json(f"https://www.twse.com.tw/rwd/zh/fund/T86?date={d:%Y%m%d}&selectType=ALLBUT0999&response=json")
        fields = j.get("fields") or []
        idx = next((i for i, f in enumerate(fields) if "三大法人買賣超" in f), None)
        for row in j.get("data") or []:
            if idx is not None:
                v = num(row[idx])
                if v is not None:
                    out[str(row[0]).strip()] = round(v / 1000)
        log["inst_上市"] = {"ok": True, "rows": len(j.get("data") or [])}
    except Exception as e:  # noqa: BLE001
        log["inst_上市"] = {"ok": False, "error": str(e)[:300]}
    # 上櫃
    try:
        j = get_json("https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php"
                     f"?l=zh-tw&o=json&se=EW&t=D&d={_roc(d)}")
        rows = j.get("aaData") or (j.get("tables") or [{}])[0].get("data") or []
        n = 0
        for row in rows:
            # 最後一欄是三大法人買賣超股數合計
            v = num(row[-1])
            if v is not None:
                out[str(row[0]).strip()] = round(v / 1000)
                n += 1
        log["inst_上櫃"] = {"ok": True, "rows": n}
    except Exception as e:  # noqa: BLE001
        log["inst_上櫃"] = {"ok": False, "error": str(e)[:300]}
    return out


def fetch_twse_day(d: dt.date) -> dict[str, float]:
    """補歷史用：證交所某一天全部上市股票收盤價。"""
    j = get_json(f"https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={d:%Y%m%d}&type=ALLBUT0999&response=json")
    out: dict[str, float] = {}
    for t in j.get("tables") or []:
        fields = t.get("fields") or []
        if "證券代號" in fields and "收盤價" in fields:
            ci, pi = fields.index("證券代號"), fields.index("收盤價")
            for row in t.get("data") or []:
                v = num(row[pi])
                if v:
                    out[str(row[ci]).strip()] = v
    return out


def fetch_tpex_day(d: dt.date) -> dict[str, float]:
    """補歷史用：櫃買中心某一天全部上櫃股票收盤價。"""
    j = get_json("https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php"
                 f"?l=zh-tw&o=json&d={_roc(d)}")
    rows = j.get("aaData") or (j.get("tables") or [{}])[0].get("data") or []
    out: dict[str, float] = {}
    for row in rows:
        v = num(row[2]) if len(row) > 2 else None
        if v:
            out[str(row[0]).strip()] = v
    return out


def fetch_all(log: dict) -> dict[str, Any]:
    quotes, date = fetch_quotes(log)
    return {
        "date": date,
        "quotes": quotes,
        "valuation": fetch_valuation(log),
        "revenue": fetch_revenue(log),
        "profile": fetch_profile(log),
        "inst": fetch_institutional(date, log),
        "income": fetch_income(log),
    }
