import requests, os
S = requests.Session(); S.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
os.makedirs("probe-out", exist_ok=True)
U = {
 "y_hold_0050": "https://tw.stock.yahoo.com/quote/0050.TW/holding",
 "y_hold_009823": "https://tw.stock.yahoo.com/quote/009823.TWO/holding",
 "y_hold_00679B": "https://tw.stock.yahoo.com/quote/00679B.TWO/holding",
 "y_prof_0050": "https://tw.stock.yahoo.com/quote/0050.TW/profile",
 "y_div_0050": "https://tw.stock.yahoo.com/quote/0050.TW/dividend",
 "mdj_hold_0050": "https://www.moneydj.com/ETF/X/Basic/Basic0007a.xdjhtm?etfid=0050.TW",
 "tpex_etf_basic": "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap47_O",
 "twse_etf_basic": "https://openapi.twse.com.tw/v1/opendata/t187ap47_L",
 "y_hold_00981A": "https://tw.stock.yahoo.com/quote/00981A.TW/holding",
}
for k, u in U.items():
    try:
        r = S.get(u, timeout=40)
        open(f"probe-out/{k}.html", "wb").write(r.content)
        print(k, r.status_code, len(r.content), r.headers.get("content-type"))
    except Exception as e:
        print(k, "ERR", e)
