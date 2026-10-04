"""補過去 N 個交易日的收盤價，讓「近 20 / 60 日漲跌」第一天就算得出來。

用法：python scripts/backfill.py --days 65
證交所有流量限制，每天之間會停幾秒；65 天約需 10 分鐘。已存在的日期會略過。
法人買賣超只從開始每日更新後累積，不回補。
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import HISTORY, TPE, read_json, write_json  # noqa: E402
from sources import fetch_tpex_day, fetch_twse_day  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=65, help="要補幾個交易日")
    ap.add_argument("--pause", type=float, default=4.0)
    a = ap.parse_args()
    got, d, tries = 0, dt.datetime.now(TPE).date(), 0
    while got < a.days and tries < a.days * 2 + 20:
        tries += 1
        d -= dt.timedelta(days=1)
        if d.weekday() >= 5:
            continue
        path = HISTORY / f"{d.isoformat()}.json"
        if path.exists():
            got += 1
            continue
        try:
            twse = fetch_twse_day(d)
        except Exception as e:  # noqa: BLE001
            print(f"{d} 上市失敗：{e}")
            twse = {}
        time.sleep(a.pause)
        if not twse:  # 假日或休市
            continue
        try:
            tpex = fetch_tpex_day(d)
        except Exception as e:  # noqa: BLE001
            print(f"{d} 上櫃失敗：{e}")
            tpex = {}
        time.sleep(a.pause)
        day = read_json(path, {}) or {}
        for c, p in {**twse, **tpex}.items():
            day.setdefault(c, [p, None])
        write_json(path, day)
        got += 1
        print(f"{d}：上市 {len(twse)}、上櫃 {len(tpex)}")
    print(f"補完 {got} 天")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
