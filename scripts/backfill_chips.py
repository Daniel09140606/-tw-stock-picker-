"""補過去 N 個交易日的融資融券、借券賣出（只補還沒有的日期）。每日更新流程會先跑這支，第一次約需 5 分鐘。"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import DATA, HISTORY, TPE, write_json  # noqa: E402
from sources import fetch_chips  # noqa: E402

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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
