"""抓「產業價值鏈資訊平台」(ic.tpex.org.tw，證交所＋櫃買中心合辦) 的產業鏈：上游／中游／下游環節與各環節公司。

輸出 site/data/chains.json：
  {"generated": ..., "ind": {產業代碼: [產業名, [[環節代碼, 環節名, 上中下游, [[細項名, [股票代號...]], ...]], ...]]}}
網站會用它查一檔股票在哪些產業鏈、哪個環節，以及它的上下游有哪些公司。
產業鏈很少變動，每週更新一次即可。
"""
from __future__ import annotations

import datetime as dt
import re
import sys
import time
from pathlib import Path

from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import SESSION, SITE_DATA, TPE, read_json, write_json  # noqa: E402

BASE = "https://ic.tpex.org.tw/"
CODE_RE = re.compile(r"stk_code=(\d{4})\b")


def codes_in(el) -> list[str]:
    out: list[str] = []
    for a in el.select('a[href*="stk_code="]'):
        m = CODE_RE.search(a.get("href", ""))
        if m and m.group(1) not in out:
            out.append(m.group(1))
    return out


def parse(html: str) -> list:
    soup = BeautifulSoup(html, "html.parser")
    segs, seen = [], set()
    for p in soup.select('.company-chain-panel[id^="ic_link_"]'):
        sid = p["id"].replace("ic_link_", "")
        if sid in seen:
            continue
        seen.add(sid)
        chain = p.find_parent(class_="chain")
        title = chain.select_one(".chain-title-panel") if chain else None
        stream = title.get_text(strip=True) if title else ""
        name = re.sub(r"\s+", "", p.get_text())
        box = soup.find(id="companyList_" + sid)
        subs = []
        if box:
            links = box.select('[id^="sc_link_"]')
            if links:
                for ln in links:
                    sub = ln["id"].replace("sc_link_", "")
                    label = re.sub(r"\s+", " ", re.sub(r"\(\d+家\)", "", ln.get_text().replace("►", "").replace("\xa0", " "))).strip()
                    t = soup.find(id="sc_company_" + sub)
                    subs.append([label, codes_in(t) if t else []])
            else:
                subs.append([name, codes_in(box)])
        segs.append([sid, name, stream, subs])
    return segs


def fetch(path: str) -> str:
    r = SESSION.get(BASE + path, timeout=30)
    r.raise_for_status()
    r.encoding = "utf-8"   # 網站沒宣告編碼，不指定會被當成 latin-1 變亂碼
    return r.text


def main() -> int:
    first = fetch("introduce.php?ic=D000")
    soup = BeautifulSoup(first, "html.parser")
    opts = [(o.get("value"), o.get_text(strip=True)) for o in soup.select("#ic_option option") if o.get("value")]
    if not opts:
        print("找不到產業清單，網站結構可能改了")
        return 1
    out = {}
    for ic, name in opts:
        try:
            html = first if ic == "D000" else fetch(f"introduce.php?ic={ic}")
            segs = parse(html)
            if segs:
                out[ic] = [name, segs]
        except Exception as e:  # noqa: BLE001
            print(f"{ic} {name} 失敗：{e}")
        time.sleep(0.5)
    if len(out) < len(opts) * 0.7:
        old = read_json(SITE_DATA / "chains.json")
        if old:
            print(f"只抓到 {len(out)}/{len(opts)} 個產業，保留舊資料")
            return 0
    write_json(SITE_DATA / "chains.json", {"generated": dt.datetime.now(TPE).isoformat(timespec="minutes"),
                                            "source": "產業價值鏈資訊平台 ic.tpex.org.tw", "ind": out})
    n = len({c for v in out.values() for s in v[1] for sub in s[3] for c in sub[1]})
    print(f"產業鏈：{len(out)} 個產業，涵蓋 {n} 家公司")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
