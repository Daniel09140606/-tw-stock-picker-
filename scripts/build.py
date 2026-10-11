"""每日更新主程式：抓資料 → 存當日歷史 → 計算指標與評分 → 輸出 site/data/stocks.json。

用法：
  python scripts/build.py                 # 正式抓官方 API
  python scripts/build.py --fixture FILE  # 用測試資料跑（不連網）
"""
from __future__ import annotations

import argparse
import datetime as dt
import math
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import re  # noqa: E402

from common import (DATA, HISTORY, SITE_DATA, TPE, is_etf_code, is_stock_code,  # noqa: E402
                    read_json, write_json)
from sources import fetch_all  # noqa: E402

KEEP_DAYS = 130          # 歷史保留天數（約半年交易日）
MIN_VOL_SHARES = 200_000  # 當日成交量低於 200 張視為流動性不足，不列入推薦
HIGH_BETA_THEMES = {"memory", "cpo", "passive", "leo"}

FIELDS = ["code", "name", "mkt", "ind", "themes", "price", "chg", "vol", "pe", "yld", "pb", "roe",
          "rev", "revCum", "revMonth", "cap", "size", "f5", "f20", "ch20", "ch60", "sL", "sS",
          "risk", "volc", "liq",
          "revCur", "revPrevM", "revLY", "revMoM", "revCumCur", "revCumLY",
          "plYear", "plQ", "plRev", "plGP", "plOP", "plPretax", "plNI", "plEPS", "rh",
          "et", "ma5", "ma20", "ma60", "lo20", "lo60", "hi20", "hi60", "atr", "sd", "rsi", "inst",
          "mb", "mbCh5", "sb", "sbCh5", "ls", "ls20", "lb", "lbCh5"]
CHIPS = DATA / "chips"       # 每日融資融券、借券賣出
SERIES_DAYS = 120            # 網站線形圖用的天數
REV_DIR = DATA / "revenue"   # 每月營收快照，累積成近 12 個月走勢


# ---------------------------------------------------------------- history
def save_history(date: str, quotes: dict, inst: dict) -> None:
    day = {c: [q["price"], inst.get(c)] for c, q in quotes.items()}
    write_json(HISTORY / f"{date}.json", day)
    files = sorted(HISTORY.glob("*.json"))
    for old in files[:-KEEP_DAYS]:
        old.unlink()


def save_revenue(revn: dict) -> None:
    by_month: dict[str, dict] = {}
    for c, r in revn.items():
        if r.get("revMonth") and r.get("revCur") is not None:
            by_month.setdefault(r["revMonth"], {})[c] = [r["revCur"], r.get("revLY")]
    for m, d in by_month.items():
        old = read_json(REV_DIR / f"{m}.json", {}) or {}
        old.update(d)
        write_json(REV_DIR / f"{m}.json", old)


def load_revenue() -> list[tuple[str, dict]]:
    return [(f.stem, read_json(f, {})) for f in sorted(REV_DIR.glob("*.json"))][-13:]


def load_history() -> list[tuple[str, dict]]:
    out = []
    for f in sorted(HISTORY.glob("*.json")):
        d = read_json(f, {})
        if d:
            out.append((f.stem, d))
    return out


def save_chips(date: str, chips: dict) -> None:
    if chips:
        write_json(CHIPS / f"{date}.json", chips)
    for old in sorted(CHIPS.glob("*.json"))[:-60]:
        old.unlink()


def load_chips() -> list[tuple[str, dict]]:
    return [(f.stem, read_json(f, {}) or {}) for f in sorted(CHIPS.glob("*.json"))][-25:]


def chip_stats(chips: list[tuple[str, dict]], code: str) -> dict:
    rows = [d[code] for _, d in chips if code in d]
    st: dict = {k: None for k in ("mb", "mbCh5", "sb", "sbCh5", "ls", "ls20", "lb", "lbCh5")}
    if not rows:
        return st
    last = chips[-1][1].get(code) if chips else None
    if last:
        st["mb"], st["sb"], st["ls"], st["lb"] = last.get("mb"), last.get("sb"), last.get("ls"), last.get("lb")
    def ch5(k):
        v = [r.get(k) for r in rows if r.get(k) is not None]
        return int(v[-1] - v[-6]) if len(v) >= 6 else None
    st["mbCh5"], st["sbCh5"], st["lbCh5"] = ch5("mb"), ch5("sb"), ch5("lb")
    ls = [r.get("ls") for r in rows[-20:] if r.get("ls") is not None]
    st["ls20"] = round(sum(ls) / len(ls), 1) if len(ls) >= 5 else None
    return st


def tech_stats(closes: list[float]) -> dict:
    """均線、近期高低點、平均每日波動（ATR 近似：只有收盤價，用相鄰收盤差的平均）、日報酬標準差、RSI。"""
    st: dict = {k: None for k in ("ma5", "ma20", "ma60", "lo20", "lo60", "hi20", "hi60", "atr", "sd", "rsi")}
    n = len(closes)
    r2 = lambda x: round(x, 2)
    for k, w in (("ma5", 5), ("ma20", 20), ("ma60", 60)):
        if n >= w:
            st[k] = r2(sum(closes[-w:]) / w)
    if n >= 20:
        st["lo20"], st["hi20"] = min(closes[-20:]), max(closes[-20:])
        diffs = [abs(closes[i] - closes[i - 1]) for i in range(n - 20, n)]
        st["atr"] = r2(sum(diffs) / len(diffs))
    if n >= 40:
        w = closes[-60:]
        st["lo60"], st["hi60"] = min(w), max(w)
        rets = [math.log(w[i] / w[i - 1]) for i in range(1, len(w)) if w[i - 1] > 0 and w[i] > 0]
        if len(rets) > 10:
            st["sd"] = round(statistics.pstdev(rets) * 100, 2)
    if n >= 15:
        g = [max(0, closes[i] - closes[i - 1]) for i in range(n - 14, n)]
        l = [max(0, closes[i - 1] - closes[i]) for i in range(n - 14, n)]
        ag, al = sum(g) / 14, sum(l) / 14
        st["rsi"] = 100.0 if al == 0 else round(100 - 100 / (1 + ag / al), 1)
    return st


ETF_TYPES = ("國內股票", "國外股票", "主動式", "債券", "槓桿反向", "商品期貨", "其他")


def etf_type(code: str, name: str, basic: dict | None) -> str:
    t = (basic or {}).get("type", "")
    if "槓桿" in t or "反向" in t or re.search(r"正2|反1|反向|2X|-1X|雙倍|槓桿", name):
        return "槓桿反向"
    if "期貨" in t or re.search(r"期|原油|黃金|白銀|黃豆|商品", name):
        return "商品期貨"
    if code.endswith("B") or "債券" in t or re.search(r"債|公司債|美債|投等", name):
        return "債券"
    if "主動" in t or code.endswith("A"):
        return "主動式"
    if "國外" in t or "境外" in t or (basic or {}).get("foreign") or re.search(
            r"美國|標普|S&P|那斯達克|納斯達克|NASDAQ|費城|日本|日經|中國|上証|滬深|香港|恒生|印度|越南|歐洲|全球|美股|德國|韓國|東協|新興|美國", name):
        return "國外股票"
    if "國內" in t or not t:
        return "國內股票"
    return "其他"


def series_stats(hist: list[tuple[str, dict]], code: str) -> dict:
    closes = [d[code][0] for _, d in hist if code in d and d[code][0]]
    flows = [d[code][1] for _, d in hist if code in d and len(d[code]) > 1 and d[code][1] is not None]
    st: dict = {"ch20": None, "ch60": None, "f5": None, "f20": None}
    if len(closes) >= 21:
        st["ch20"] = round((closes[-1] / closes[-21] - 1) * 100, 1)
    if len(closes) >= 61:
        st["ch60"] = round((closes[-1] / closes[-61] - 1) * 100, 1)
    if len(flows) >= 5:
        st["f5"] = int(sum(flows[-5:]))
    if len(flows) >= 20:
        st["f20"] = int(sum(flows[-20:]))
    last = hist[-1][1].get(code) if hist else None
    st["inst"] = last[1] if last and len(last) > 1 else None
    st.update(tech_stats(closes))
    return st


def write_series(hist: list[tuple[str, dict]], chips: list[tuple[str, dict]], codes: list[str]) -> None:
    """網站線形圖與籌碼走勢用：依代號第一碼分檔，點開個股時才載入。"""
    h = hist[-SERIES_DAYS:]
    dates = [d for d, _ in h]
    cd = [d for d, _ in chips[-20:]]
    shards: dict[str, dict] = {}
    for c in codes:
        sh = shards.setdefault(c[0], {"dates": dates, "cdates": cd, "p": {}, "f": {}, "m": {}, "s": {}, "l": {}, "b": {}})
        sh["p"][c] = [d[c][0] if c in d else None for _, d in h]
        sh["f"][c] = [(d[c][1] if c in d and len(d[c]) > 1 else None) for _, d in h[-20:]]
        if any(c in d for _, d in chips[-20:]):
            for key, k in (("m", "mb"), ("s", "sb"), ("l", "ls"), ("b", "lb")):
                sh[key][c] = [d.get(c, {}).get(k) for _, d in chips[-20:]]
    for k, sh in shards.items():
        write_json(SITE_DATA / "series" / f"{k}.json", sh)


# ---------------------------------------------------------------- scoring
def size_of(cap_yi: float | None) -> str:
    if cap_yi is None:
        return "S"
    if cap_yi >= 1000:
        return "L"
    if cap_yi >= 200:
        return "M"
    return "S"


def score(s: dict, ind_med_pe: float | None, has_flow: bool, has_mom: bool) -> tuple[int, int]:
    rev, pe, pb = s.get("rev"), s.get("pe"), s.get("pb")
    g = 0.5 if rev is None else 2 if rev >= 100 else 1.5 if rev >= 40 else 1 if rev >= 20 else 0.5 if rev >= 0 else 0
    if rev is not None and rev > 300:  # 年增超過 300% 多半是去年基期太低，不當成真實成長
        g = 1
    if rev is not None and rev > 0 and s.get("revCum") is not None and s["revCum"] < 0:
        g -= 0.25
    if not pe or pe <= 0:
        v = -1.0
    else:
        k = pe / ind_med_pe if ind_med_pe else 1
        v = 1.5 if k <= 0.8 else 1 if k <= 1 else 0.5 if k <= 1.5 else 0
        if pe > 80:
            v -= 0.5
        if "memory" in s["themes"]:
            v = min(v, 0.5)
    if s.get("yld") and s["yld"] >= 4:
        v += 0.25
    roe = s.get("roe")
    q = 0.25 if roe is None else 1 if roe >= 20 else 0.5 if roe >= 12 else 0
    f = 0.0
    for key in ("f20", "f5"):
        x = s.get(key)
        if x is not None:
            f += 0.5 if x > 0 else -0.25 if x < 0 else 0
    m = 0.0
    if s.get("ch20") is not None:
        c = s["ch20"]
        m += 0.5 if 0 < c <= 20 else -0.5 if c > 25 else -0.25 if c < -10 else 0
    if s.get("ch60") is not None and s["ch60"] > 50:
        m -= 0.25
    long_raw = g + v + q + 0.5 * f
    if has_flow or has_mom:
        short_raw = (0.6 * g + 1.5 * f + 1.5 * m + 0.5 * v) * 1.15
    else:  # 歷史還不夠時，波段只能先用基本面粗估
        short_raw = (0.6 * g + 0.5 * v) * 1.6

    def clamp(x: float) -> int:
        return max(1, min(5, round(x)))

    sl, ss = clamp(long_raw), clamp(short_raw)
    if not pe or pe <= 0:
        sl, ss = 1, min(ss, 1)
    return sl, ss


def etf_score(s: dict, info: dict) -> tuple[int, int]:
    """ETF 沒有本益比與營收，改用類型、規模與走勢評分。槓桿反向不推薦（1 分）。"""
    if s["et"] == "槓桿反向":
        return 1, 1
    aum = info.get("aum") or 0
    sl = 3.0
    if aum >= 1e11:
        sl += 1
    elif aum and aum < 2e9:
        sl -= 1          # 規模小於 20 億，有下市或流動性風險
    if s["et"] == "商品期貨":
        sl -= 1          # 期貨轉倉成本，長期持有會被侵蝕
    if s.get("ch60") is not None and s["ch60"] < -15:
        sl -= 0.5
    m = 0.0
    if s.get("ch20") is not None:
        m += 0.5 if 0 < s["ch20"] <= 12 else -0.5 if s["ch20"] < -5 or s["ch20"] > 18 else 0
    if s.get("f5") is not None:
        m += 0.5 if s["f5"] > 0 else -0.25 if s["f5"] < 0 else 0
    if s.get("ma20") and s["price"] > s["ma20"]:
        m += 0.25
    ss = 2 + m
    return max(1, min(5, round(sl))), max(1, min(4, round(ss)))


# ---------------------------------------------------------------- main
def build(raw: dict, write_hist: bool = True) -> dict:
    date = raw["date"] or dt.datetime.now(TPE).date().isoformat()
    quotes, val, revn, prof, inst = raw["quotes"], raw["valuation"], raw["revenue"], raw["profile"], raw["inst"]
    themes_cfg = read_json(DATA / "themes.json", {})
    notes = read_json(DATA / "notes.json", {})
    code_themes: dict[str, list[str]] = {}
    for key, t in themes_cfg.items():
        for c in t.get("codes", []):
            code_themes.setdefault(c, []).append(key)
    etf_list = set(themes_cfg.get("etf", {}).get("codes", []))
    etf_basic = raw.get("etfBasic", {})
    etf_info = (read_json(SITE_DATA / "etf.json", {}) or {}).get("etf", {})   # 上一次 etf.py 抓的規模、持股

    income = raw.get("income", {})
    if write_hist and quotes:
        save_history(date, quotes, inst)
    if write_hist and revn:
        save_revenue(revn)
    if write_hist:
        save_chips(date, raw.get("chips") or {})
    revhist = load_revenue()
    hist = load_history()
    chips = load_chips()
    has_flow_hist = sum(1 for _, d in hist if any(v[1] is not None for v in list(d.values())[:50])) >= 5
    has_mom_hist = len(hist) >= 21

    rows: list[dict] = []
    for code, q in quotes.items():
        is_etf = is_etf_code(code)
        if not (is_stock_code(code) or is_etf):
            continue
        p = prof.get(code, {})
        r = revn.get(code, {})
        vv = val.get(code, {})
        et = etf_type(code, q["name"], etf_basic.get(code)) if is_etf else None
        ind = f"ETF・{et}" if is_etf else (r.get("indName") or p.get("indName") or "其他")
        if is_etf and not p.get("shares") and etf_info.get(code, {}).get("aum"):
            p = {**p, "shares": etf_info[code]["aum"] / q["price"]}   # ETF 用資產規模當市值
        cap = round(q["price"] * p["shares"] / 1e8) if p.get("shares") else None
        s = {
            "code": code, "name": p.get("short") or q["name"], "mkt": q["mkt"], "ind": ind,
            "themes": code_themes.get(code, []), "price": q["price"], "chg": q["chg"],
            "vol": round(q["vol"] / 1000) if q.get("vol") else None,
            "pe": vv.get("pe"), "yld": vv.get("yld"), "pb": vv.get("pb"),
            "rev": None if r.get("rev") is None else round(r["rev"], 1),
            "revCum": None if r.get("revCum") is None else round(r["revCum"], 1),
            "revMonth": r.get("revMonth"), "cap": cap, "size": size_of(cap), "et": et,
        }
        s["roe"] = round(s["pb"] / s["pe"] * 100, 1) if s["pe"] and s["pe"] > 0 and s["pb"] else None
        s.update(series_stats(hist, code))
        s.update(chip_stats(chips, code))
        for k in ("revCur", "revPrevM", "revLY", "revCumCur", "revCumLY"):
            s[k] = r.get(k)
        s["revMoM"] = None if r.get("revMoM") is None else round(r["revMoM"], 1)
        s.update({k: income.get(code, {}).get(k) for k in ("plYear", "plQ", "plRev", "plGP", "plOP", "plPretax", "plNI", "plEPS")})
        rh = [[m, d[code][0], d[code][1]] for m, d in revhist if code in d]
        s["rh"] = rh if len(rh) >= 2 else None
        s["liq"] = 1 if (q.get("vol") or 0) >= MIN_VOL_SHARES else 0
        rows.append(s)

    # 產業本益比中位數
    by_ind: dict[str, list[float]] = {}
    for s in rows:
        if s["pe"] and 0 < s["pe"] < 300:
            by_ind.setdefault(s["ind"], []).append(s["pe"])
    med = {k: statistics.median(v) for k, v in by_ind.items() if len(v) >= 3}

    for s in rows:
        is_etf = s["et"] is not None
        fin = s["ind"] in ("金融保險", "金融保險業", "金融業")
        loss = not s["pe"] or s["pe"] <= 0
        if is_etf:
            volc = 3 if s["et"] == "槓桿反向" else 1 if s["et"] in ("國內股票", "債券") else 2
        elif fin:
            volc = 1
        elif s["size"] == "S" or (s["pe"] and s["pe"] > 60) or loss or HIGH_BETA_THEMES & set(s["themes"]):
            volc = 3
        else:
            volc = 2
        if s.get("sd"):   # 有實際波動就用實際的：年化 25% 以下低、45% 以下中、以上高
            ann = s["sd"] * math.sqrt(250)
            volc = 3 if s["et"] == "槓桿反向" else 1 if ann < 25 else 2 if ann < 45 else 3
        risk = (3 if s["et"] == "槓桿反向" else 2 if volc == 3 else 1) if is_etf else 1 if fin else 2 if (s["size"] == "L" and volc == 3 and not loss and (s["pe"] or 0) < 60) else volc
        s["volc"], s["risk"] = volc, risk
        n = notes.get(s["code"], {})
        if is_etf:
            s["size"] = "E"
            s["sL"], s["sS"] = etf_score(s, etf_info.get(s["code"], {}))
            if n.get("fix"):
                s["sL"], s["sS"] = n["fix"].get("long", s["sL"]), n["fix"].get("short", s["sS"])
        else:
            sl, ss = score(s, med.get(s["ind"]), has_flow_hist, has_mom_hist)
            adj = n.get("adj", {})
            s["sL"] = max(1, min(5, sl + adj.get("long", 0)))
            s["sS"] = max(1, min(5, ss + adj.get("short", 0)))
        if not s["liq"]:
            s["sL"], s["sS"] = min(s["sL"], 1), min(s["sS"], 1)

    rows.sort(key=lambda s: s["code"])
    if write_hist or not (SITE_DATA / "series").exists():
        write_series(hist, chips, [s["code"] for s in rows])
    out = {
        "date": date,
        "generated": dt.datetime.now(TPE).isoformat(timespec="minutes"),
        "historyDays": len(hist),
        "shortMode": "full" if (has_flow_hist or has_mom_hist) else "fundamental",
        "indMedianPE": {k: round(v, 1) for k, v in med.items()},
        "fields": FIELDS,
        "rows": [[s.get(f) for f in FIELDS] for s in rows],
        "themes": {k: {kk: vv for kk, vv in t.items() if kk != "codes"} for k, t in themes_cfg.items()},
        "notes": notes,
    }
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", help="用測試資料取代真實 API")
    ap.add_argument("--no-history", action="store_true")
    a = ap.parse_args()
    log: dict = {}
    if a.fixture:
        raw = read_json(Path(a.fixture))
        log["fixture"] = a.fixture
    else:
        raw = fetch_all(log)
    write_json(DATA / "fetch_log.json", {"at": dt.datetime.now(TPE).isoformat(timespec="minutes"),
                                          "date": raw.get("date"), "sources": log}, compact=False)
    if not raw.get("quotes"):
        print("沒有抓到任何報價，保留舊資料。", log, file=sys.stderr)
        return 1
    out = build(raw, write_hist=not a.no_history)
    write_json(SITE_DATA / "stocks.json", out)
    n = len(out["rows"])
    print(f"完成：{out['date']}，{n} 檔，歷史 {out['historyDays']} 天，波段模式 {out['shortMode']}")
    for k, v in log.items():
        if isinstance(v, dict):
            print(f"  {k}: {str(v.get('rows')) + ' rows' if v.get('ok') else v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
