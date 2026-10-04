"""每日更新主程式：抓資料 → 存當日歷史 → 計算指標與評分 → 輸出 site/data/stocks.json。

用法：
  python scripts/build.py                 # 正式抓官方 API
  python scripts/build.py --fixture FILE  # 用測試資料跑（不連網）
"""
from __future__ import annotations

import argparse
import datetime as dt
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (DATA, HISTORY, SITE_DATA, TPE, is_etf_code, is_stock_code,  # noqa: E402
                    read_json, write_json)
from sources import fetch_all  # noqa: E402

KEEP_DAYS = 130          # 歷史保留天數（約半年交易日）
MIN_VOL_SHARES = 200_000  # 當日成交量低於 200 張視為流動性不足，不列入推薦
HIGH_BETA_THEMES = {"memory", "cpo", "passive", "leo"}

FIELDS = ["code", "name", "mkt", "ind", "themes", "price", "chg", "vol", "pe", "yld", "pb", "roe",
          "rev", "revCum", "revMonth", "cap", "size", "f5", "f20", "ch20", "ch60", "sL", "sS",
          "risk", "volc", "liq"]


# ---------------------------------------------------------------- history
def save_history(date: str, quotes: dict, inst: dict) -> None:
    day = {c: [q["price"], inst.get(c)] for c, q in quotes.items()}
    write_json(HISTORY / f"{date}.json", day)
    files = sorted(HISTORY.glob("*.json"))
    for old in files[:-KEEP_DAYS]:
        old.unlink()


def load_history() -> list[tuple[str, dict]]:
    out = []
    for f in sorted(HISTORY.glob("*.json")):
        d = read_json(f, {})
        if d:
            out.append((f.stem, d))
    return out


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
    return st


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

    if write_hist and quotes:
        save_history(date, quotes, inst)
    hist = load_history()
    has_flow_hist = sum(1 for _, d in hist if any(v[1] is not None for v in list(d.values())[:50])) >= 5
    has_mom_hist = len(hist) >= 21

    rows: list[dict] = []
    for code, q in quotes.items():
        if not (is_stock_code(code) or code in etf_list):
            continue
        p = prof.get(code, {})
        r = revn.get(code, {})
        vv = val.get(code, {})
        ind = r.get("indName") or p.get("indName") or ("ETF" if is_etf_code(code) else "其他")
        cap = round(q["price"] * p["shares"] / 1e8) if p.get("shares") else None
        s = {
            "code": code, "name": p.get("short") or q["name"], "mkt": q["mkt"], "ind": ind,
            "themes": code_themes.get(code, []), "price": q["price"], "chg": q["chg"],
            "vol": round(q["vol"] / 1000) if q.get("vol") else None,
            "pe": vv.get("pe"), "yld": vv.get("yld"), "pb": vv.get("pb"),
            "rev": None if r.get("rev") is None else round(r["rev"], 1),
            "revCum": None if r.get("revCum") is None else round(r["revCum"], 1),
            "revMonth": r.get("revMonth"), "cap": cap, "size": size_of(cap),
        }
        s["roe"] = round(s["pb"] / s["pe"] * 100, 1) if s["pe"] and s["pe"] > 0 and s["pb"] else None
        s.update(series_stats(hist, code))
        s["liq"] = 1 if (q.get("vol") or 0) >= MIN_VOL_SHARES else 0
        rows.append(s)

    # 產業本益比中位數
    by_ind: dict[str, list[float]] = {}
    for s in rows:
        if s["pe"] and 0 < s["pe"] < 300:
            by_ind.setdefault(s["ind"], []).append(s["pe"])
    med = {k: statistics.median(v) for k, v in by_ind.items() if len(v) >= 3}

    for s in rows:
        is_etf = s["code"] in etf_list
        fin = s["ind"] in ("金融保險", "金融保險業", "金融業")
        loss = not s["pe"] or s["pe"] <= 0
        if is_etf or fin:
            volc = 1
        elif s["size"] == "S" or (s["pe"] and s["pe"] > 60) or loss or HIGH_BETA_THEMES & set(s["themes"]):
            volc = 3
        else:
            volc = 2
        risk = 1 if (is_etf or fin) else 2 if (s["size"] == "L" and volc == 3 and not loss and (s["pe"] or 0) < 60) else volc
        s["volc"], s["risk"] = volc, risk
        n = notes.get(s["code"], {})
        if is_etf:
            s["size"] = "E"
            s["sL"], s["sS"] = n.get("fix", {}).get("long", 4), n.get("fix", {}).get("short", 2)
        else:
            sl, ss = score(s, med.get(s["ind"]), has_flow_hist, has_mom_hist)
            adj = n.get("adj", {})
            s["sL"] = max(1, min(5, sl + adj.get("long", 0)))
            s["sS"] = max(1, min(5, ss + adj.get("short", 0)))
        if not s["liq"]:
            s["sL"], s["sS"] = min(s["sL"], 1), min(s["sS"], 1)

    rows.sort(key=lambda s: s["code"])
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
