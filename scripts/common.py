"""共用工具：HTTP、欄位挑選、數字轉換、日期。"""
from __future__ import annotations

import datetime as dt
import json
import re
import time
from pathlib import Path
from typing import Any, Iterable

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HISTORY = DATA / "history"
SITE_DATA = ROOT / "site" / "data"
TPE = dt.timezone(dt.timedelta(hours=8))

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) tw-stock-picker/1.0 (+https://github.com)",
    "Accept": "application/json,text/plain,*/*",
})


def get_json(url: str, tries: int = 3, pause: float = 3.0) -> Any:
    """抓 JSON，失敗時重試；最後一次仍失敗就丟出例外。"""
    last: Exception | None = None
    for i in range(tries):
        try:
            r = SESSION.get(url, timeout=40)
            r.raise_for_status()
            text = r.text.lstrip("﻿")
            return json.loads(text)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(pause * (i + 1))
    raise RuntimeError(f"{url} -> {last}")


def num(x: Any) -> float | None:
    """'1,234.5' / '--' / '' / None -> float 或 None。"""
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    s = str(x).strip().replace(",", "").replace("+", "")
    s = re.sub(r"<[^>]+>", "", s)  # 有些欄位夾帶 HTML
    if s in ("", "-", "--", "---", "N/A", "X", "除權息", "除息", "除權"):
        return None
    try:
        return float(s)
    except ValueError:
        m = re.search(r"-?\d+(\.\d+)?", s)
        return float(m.group()) if m else None


def pick(row: dict, *names: str, regex: str | None = None) -> Any:
    """依序找第一個存在且非空的欄位；都沒有時用 regex 比對欄位名稱。"""
    for n in names:
        if n in row and row[n] not in (None, ""):
            return row[n]
    if regex:
        for k, v in row.items():
            if re.search(regex, k) and v not in (None, ""):
                return v
    return None


def roc_to_iso(s: str | None) -> str | None:
    """'1151002' 或 '115/10/02' -> '2026-10-02'。"""
    if not s:
        return None
    digits = re.sub(r"\D", "", str(s))
    if len(digits) == 7:
        y, m, d = int(digits[:3]) + 1911, int(digits[3:5]), int(digits[5:7])
    elif len(digits) == 8:
        y, m, d = int(digits[:4]), int(digits[4:6]), int(digits[6:8])
    else:
        return None
    try:
        return dt.date(y, m, d).isoformat()
    except ValueError:
        return None


def is_stock_code(code: str) -> bool:
    """一般股票：4 碼數字（排除權證、特別股等）。"""
    return bool(re.fullmatch(r"[1-9]\d{3}", code or ""))


def is_etf_code(code: str) -> bool:
    return bool(re.fullmatch(r"00\d{2,4}[A-Z]?", code or ""))


def write_json(path: Path, obj: Any, compact: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=2)


def read_json(path: Path, default: Any = None) -> Any:
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def first_keys(rows: Iterable[dict] | None) -> list[str]:
    for r in rows or []:
        return list(r.keys())
    return []
