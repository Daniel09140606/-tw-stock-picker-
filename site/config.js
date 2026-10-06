// Supabase 專案設定。這兩個值本來就會公開在網頁上，安全性靠資料表的 RLS 規則保護。
// service_role key 絕對不要放在這裡。
window.APP_CONFIG = {
  // 資料直接從 GitHub 倉庫讀（每天自動更新後幾分鐘內就看得到，不必等網站重新部署）；讀不到時改用網站內的 data/
  DATA_URL: "https://raw.githubusercontent.com/Daniel09140606/-tw-stock-picker-/main/site/data/",
  SUPABASE_URL: "https://sciwcdxxvppxvhrvkeqa.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjaXdjZHh4dnBweHZocnZrZXFhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExMTc5NjQsImV4cCI6MjEwNjY5Mzk2NH0.c2cZzI-QcQVSeLx2uyux5rKq-unl1gEYb7MfLGaczLk"
};
