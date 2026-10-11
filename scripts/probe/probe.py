import sys, re, json, requests
S = requests.Session(); S.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
G = {
 "a": [("mdj_hold","https://www.moneydj.com/ETF/X/Basic/Basic0007a.xdjhtm?etfid=0050.TW",["台積電","持股"]),
       ("mdj_hold_b","https://www.moneydj.com/ETF/X/Basic/Basic0007B.xdjhtm?etfid=0050.TW",["台積電","持股"]),
       ("mdj_basic","https://www.moneydj.com/ETF/X/Basic/Basic0004.xdjhtm?etfid=0050.TW",["經理費","規模","追蹤"]),
       ("yahoo_hold","https://tw.stock.yahoo.com/quote/0050.TW/holding",["台積電","持股"]),
       ("yahoo_hold_A","https://tw.stock.yahoo.com/quote/00981A.TW/holding",["台積電","持股"]),
       ("yahoo_hold_us","https://tw.stock.yahoo.com/quote/009823.TW/holding",["持股","Apple","NVIDIA","輝達"]),
       ("mdj_hold_us","https://www.moneydj.com/ETF/X/Basic/Basic0007a.xdjhtm?etfid=009823.TW",["持股","Apple","NVIDIA","輝達"])],
 "b": [("yf_gspc","https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=10d&interval=1d",["regularMarketPrice"]),
       ("yf_sox","https://query1.finance.yahoo.com/v8/finance/chart/%5ESOX?range=10d&interval=1d",["regularMarketPrice"]),
       ("yf_tsm","https://query2.finance.yahoo.com/v8/finance/chart/TSM?range=10d&interval=1d",["regularMarketPrice"]),
       ("yf_twii","https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?range=10d&interval=1d",["regularMarketPrice"]),
       ("fmtqik","https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?response=json",["fields","data"]),
       ("twt93u","https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?response=json",["fields","2330"]),
       ("mi_margn","https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?selectType=STOCK&response=json",["fields","2330"])],
 "c": [("tpex_margin","https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance",["SecuritiesCompanyCode","Code"]),
       ("tpex_sbl","https://www.tpex.org.tw/web/stock/margin_trading/margin_sbl/margin_sbl_result.php?l=zh-tw&o=json",["fields","date"]),
       ("tpex_idx","https://www.tpex.org.tw/openapi/v1/tpex_index",["Date"]),
       ("twse_etf_open","https://openapi.twse.com.tw/v1/opendata/t187ap47_L",["Code","代號"]),
       ("taifex_night","https://mis.taifex.com.tw/futures/api/getQuoteList",["Quote"]),
       ("twse_day_all","https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data",["009823","00981A"]),
       ("tpex_day","https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",["00679B","B\""])],
}
for name, url, keys in G[sys.argv[1]]:
    try:
        r = S.get(url, timeout=30); t = r.text
        i = -1
        for k in keys:
            i = t.find(k)
            if i >= 0: break
        snip = re.sub(r"<[^>]+>", " ", t[max(0, i - 150): i + 450] if i >= 0 else t[:300])
        snip = re.sub(r"\s+", " ", snip).replace("%", "pct")
        extra = ""
        if name in ("twse_day_all",):
            codes = re.findall(r'"(00\d{2,4}[A-Z]?)"', t); extra = f" ETFcount={len(set(codes))} has009823={'009823' in t}"
        if name == "tpex_day":
            codes = re.findall(r'"SecuritiesCompanyCode":"(00\d{2,4}[A-Z]?)"', t); extra = f" ETFcount={len(set(codes))}"
        print(f"::notice title={name}::{r.status_code} len={len(t)}{extra} | {snip[:700]}")
    except Exception as e:
        print(f"::notice title={name}::ERR {e}")
