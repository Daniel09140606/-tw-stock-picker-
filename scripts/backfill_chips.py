"""補過去 N 個交易日的融資融券、借券賣出（只補還沒有的日期）。每日更新流程會先跑這支，第一次約需 5 分鐘。"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import DATA, HISTORY, TPE, read_json, write_json  # noqa: E402
from sources import fetch_chips, fetch_institutional  # noqa: E402

CHIPS = DATA / "chips"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=22)
    a = ap.parse_args()
    today = dt.datetime.now(TPE).date().isoformat()
    dates = [f.stem for f in sorted(HISTORY.glob("*.json")) if f.stem < today][-a.days:]
    done = 0
    for d in dates:
        if (CHIPS / f"{d}.json").exists():
            continue
        log: dict = {}
        chips = fetch_chips(dt.date.fromisoformat(d), log)
        if len(chips) > 500:
            write_json(CHIPS / f"{d}.json", chips)
            done += 1
        print(d, len(chips), {k: v.get("rows", v.get("error")) for k, v in log.items()})
        time.sleep(3)
    print(f"補了 {done} 天籌碼資料")
    # 三大法人分開（外資、投信、自營商）：舊的歷史只有合計，補上分項
    fixed = 0
    for d in dates:
        f = HISTORY / f"{d}.json"
        h = read_json(f, {}) or {}
        sample = h.get("2330") or next(iter(h.values()), None)
        if not sample or len(sample) >= 5:
            continue
        log: dict = {}
        inst = fetch_institutional(d, log)
        if len(inst) < 500:
            print(d, "法人分項抓不到", log)
            continue
        for c, v in h.items():
            i = inst.get(c)
            if i:
                h[c] = [v[0], i["t"], i.get("fi"), i.get("it"), i.get("dl")]
        write_json(f, h)
        fixed += 1
        time.sleep(3)
    print(f"補了 {fixed} 天三大法人分項")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
