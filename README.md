# 預算選股台

輸入預算、持有時間與風險偏好，從台股上市櫃全市場依公開規則評分，列出推薦標的、配置建議與進出場參考價。每個帳號的設定、持股、自選股分開存。

> 這是研究工具，不是投資建議。資料每個交易日收盤後更新一次，不是即時報價。

## 架構

| 部分 | 做什麼 | 在哪裡 |
|---|---|---|
| 資料 | 抓證交所、櫃買中心官方 OpenAPI，計算評分，輸出 `site/data/stocks.json` | `scripts/`，由 GitHub Actions 每天 17:40 執行 |
| 網站 | 靜態網頁，讀 `stocks.json`，在瀏覽器端做配置、篩選、分頁、進出場價 | `site/`，由 GitHub Actions 部署到 GitHub Pages |
| 帳號 | 登入、每人的設定／持股／自選股，靠 RLS 只能讀寫自己的資料 | Supabase，資料表定義在 `supabase/schema.sql` |

## 第一次設定

1. **Supabase**
   - 建一個新專案。
   - 到 SQL Editor 貼上 `supabase/schema.sql` 全文執行。
   - 到 Authentication → URL Configuration，把 Site URL 設成 GitHub Pages 網址。
   - 把 Project URL 和 anon public key 填進 `site/config.js`。
   - **service_role key 不要放進 repo。**
2. **GitHub Pages**
   - repo 的 Settings → Pages → Build and deployment → Source 選 **GitHub Actions**。
   - 之後每次資料更新或 `site/` 有改動，都會自動部署。
3. **GitHub Actions**
   - 到 Actions 分頁，手動執行「每日更新股票資料」一次，確認抓得到資料。
   - 再執行一次「補歷史收盤價」，讓近 20 / 60 日漲跌一開始就有數字。

## 本機測試

```bash
pip install -r requirements.txt
python tests/make_fixture.py tests/fixtures/sample.json
python scripts/build.py --fixture tests/fixtures/sample.json --no-history   # 不連網
python scripts/build.py                                                      # 連官方 API
cd site && python -m http.server 8000
```

## 檔案

- `scripts/sources.py`：各資料來源的抓取與欄位對應。兩個交易所的欄位名稱不同，用候選名稱比對；每次執行的來源狀態寫在 `data/fetch_log.json`。
- `scripts/build.py`：合併資料、累積歷史（`data/history/`，保留約半年）、計算評分。
- `scripts/backfill.py`：補過去交易日的收盤價。
- `data/themes.json`：題材分組（低軌衛星、被動元件…），可自行增刪代號。
- `data/notes.json`：個股研究筆記與人工調整（理由、風險、證據連結）。

## 評分規則

規則寫在網站底部的「評分與進出場價位怎麼算」。要調整就改 `scripts/build.py` 的 `score()`。
