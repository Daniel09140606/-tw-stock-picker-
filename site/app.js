/* 預算選股台：讀 data/stocks.json（GitHub Actions 每日產生），在瀏覽器端做配置、篩選、分頁與進出場價計算。
   帳號用 Supabase：每個人的設定、持股、自選股分開存，靠資料表 RLS 保護。沒登入時存在這台瀏覽器。 */
(() => {
"use strict";
const CFG = window.APP_CONFIG || {};
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = n => n == null ? "—" : (+n).toLocaleString("zh-TW", {maximumFractionDigits: 2});
const money = n => "NT$ " + Math.round(n).toLocaleString("zh-TW");
const pct = x => x == null ? "—" : (x > 0 ? "+" : "") + x + "%";
const monthTxt = m => m ? `${+m.slice(5)} 月` : "最新月";
const lots = x => x == null ? "—" : (x > 0 ? "+" : "") + Math.round(x).toLocaleString("zh-TW") + " 張";

const SIG = {1: .18, 2: .32, 3: .50};
const VOLNAME = {1: "低波動", 2: "中波動", 3: "高波動"}, RISKNAME = {1: "低風險", 2: "中風險", 3: "高風險"};
const SIZENAME = {L: "大型", M: "中型", S: "小型", E: "ETF"};
const COLORS = Array.from({length: 10}, (_, i) => `var(--c${i + 1})`);
const FINLAB = c => `https://finlab.finance/stocks/${c}`;
const GOODINFO = c => `https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=${c}`;

let DB = null, S = [], BY = {};
const PREF_KEYS = ["budget", "tNum", "tUnit", "r", "n", "groups", "unit", "sizes"];
let state = {budget: 100000, tNum: 1, tUnit: 365, r: 2, n: 0, groups: [], unit: "odd", sizes: ["L", "M", "S", "E"], group: "theme", mkt: "all", size: "all", afford: "all", sort: "score", per: 20, chip: "all", q: "", page: 1};
try { const s = JSON.parse(localStorage.getItem("picker-ui")); if (s) Object.assign(state, s); } catch (e) {}
if (!Array.isArray(state.sizes) || !state.sizes.length) state.sizes = ["L", "M", "S", "E"];
let sb = null, user = null, holdings = [], watch = new Set();

/* ---------------- local guest storage ---------------- */
const local = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};

/* ---------------- time & levels ---------------- */
const days = () => Math.max(1, Math.round(state.tNum * state.tUnit));
const years = () => days() / 365;
const modeKey = () => years() <= 0.5 ? "short" : "long";
const scoreOf = s => modeKey() === "short" ? s.sS : s.sL;
function daysText(d) { if (d >= 365 && d % 365 === 0) return d / 365 + " 年"; if (d >= 30 && d % 30 === 0) return d / 30 + " 個月"; if (d % 7 === 0 && d >= 7) return d / 7 + " 週"; return d + " 天"; }
function tick(p, etf) { if (etf) return p < 50 ? .01 : .05; return p < 10 ? .01 : p < 50 ? .05 : p < 100 ? .1 : p < 500 ? .5 : p < 1000 ? 1 : 5; }
function rnd(p, etf, dir) { const t = tick(p, etf); const f = dir < 0 ? Math.floor : dir > 0 ? Math.ceil : Math.round; return +(f(p / t + 1e-9 * (dir < 0 ? 1 : -1)) * t).toFixed(2); }
/* 進出場價：依這檔的實際波動與近期支撐計算（2026/10 改版，不再把第二、三筆壓到很深的回檔）。
   第一筆＝現價；第二筆＝現價下方最近的支撐（20 日均線、近 20 日低點，長期再加 60 日均線），找不到就用 1.2 個平均日波動；
   停損＝波段看近 20 日低點、長期看近 60 日低點，再往下留 0.3 個日波動；距離限制在 1.5 個日波動～15%（波段）或 25%（長期）。
   停利＝平均成本 ×（1＋0.6 個持有期間的預期波動；停利二 1.2 個），預期波動＝日報酬標準差 × √持有天數。 */
function levels(s, price) {
  price = price || s.price;
  const etf = s.etf, short = modeKey() === "short", d = days();
  const sdd = (s.sd || SIG[s.volc] / Math.sqrt(250) * 100) / 100;      // 日報酬標準差
  const atr = s.atr && s.price ? s.atr * price / s.price : price * sdd * 0.8;  // 平均每日波動（元）
  const mv = Math.min(short ? .3 : .45, Math.max(.03, sdd * Math.sqrt(Math.max(5, d))));
  const e1 = rnd(price, etf, 0);
  const floor = price - Math.min(price * .12, Math.max(2.5 * atr, price * .04));
  const sup = [[s.ma20, "20 日均線"], [s.lo20, "近 20 日低點"], ...(short ? [] : [[s.ma60, "60 日均線"]])]
    .filter(([v]) => v && v < price * .99 && v >= floor).sort((x, y) => y[0] - x[0]);
  let e2, e2why;
  if (sup.length) { e2 = rnd(sup[0][0], etf, -1); e2why = `${sup[0][1]} ${fmt(+sup[0][0].toFixed(2))} 附近`; }
  else { e2 = rnd(Math.min(price - 1.2 * atr, price * .98), etf, -1); e2why = `現價下方約 1.2 個平均日波動（附近沒有明顯支撐）`; }
  const avg = (e1 + e2) / 2;
  const ref = short ? s.lo20 : (s.lo60 || s.lo20), maxD = short ? .15 : .25, minD = Math.max(1.5 * atr / avg, .03);
  let stop, stopWhy;
  if (ref && ref < e2) { stop = ref - .3 * atr; stopWhy = `跌破${short ? "近 20 日" : "近 60 日"}低點 ${fmt(ref)}`; }
  else { stop = e2 - 2 * atr; stopWhy = "第二筆下方 2 個平均日波動"; }
  if ((avg - stop) / avg > maxD) { stop = avg * (1 - maxD); stopWhy = `${short ? "近 20 日" : "近 60 日"}低點${ref ? " " + fmt(ref) : ""}離現價太遠，改用平均成本下方最大虧損 ${maxD * 100}%`; }
  if ((avg - stop) / avg < minD) { stop = avg * (1 - minD); stopWhy = `平均成本下方 ${Math.round(minD * 1000) / 10}%（至少 1.5 個平均日波動，避免正常震盪就被洗出場）`; }
  stop = rnd(stop, etf, -1);
  const L = {mode: short ? "short" : "long", m: mv, atr, entries: [["第一筆 現價（50%）", e1], [`第二筆 回檔（50%）`, e2]], e2why, avg, stop, stopWhy};
  if (short) { L.tp1 = rnd(avg * (1 + Math.max(.02, .6 * mv)), etf, 1); L.tp2 = rnd(avg * (1 + Math.max(.035, 1.2 * mv)), etf, 1); }
  else L.review = rnd(avg * (1 + Math.max(.12, .6 * mv)), etf, 1);
  const hi = short ? s.hi20 : s.hi60;
  if (hi && hi > price * 1.01 && hi < (L.tp1 || L.review)) L.resist = hi;
  return L;
}
function exitFor(s, cost) {
  const L = levels(s, s.price);
  if (L.mode === "short") return {stop: L.stop, tp: rnd(cost * (1 + Math.max(.02, .6 * L.m)), s.etf, 1), tpName: "停利一"};
  return {stop: L.stop, tp: rnd(cost * (1 + Math.max(.12, .6 * L.m)), s.etf, 1), tpName: "重新評估價"};
}
function sharesText(n) { const l = Math.floor(n / 1000), o = n % 1000; return ((l ? l + " 張" : "") + (l && o ? " ＋ " : "") + (o ? o + " 股" : "")) || "0 股"; }

/* ---------------- data ---------------- */
const groupKey = s => state.group === "theme" ? (s.themes[0] || null) : s.ind;
const groupName = k => state.group === "theme" ? (DB.themes[k]?.n || k) : k;
const divKey = s => s.themes[0] || s.ind;   // 配置分散用
const isRec = s => s.liq && scoreOf(s) >= 2;
const sizeOk = s => state.sizes.includes(s.size);   // 配置建議選的公司規模
const allSizes = () => ["L", "M", "S", "E"].every(k => state.sizes.includes(k));

/* 資料先從 GitHub 倉庫直接讀（每日更新後幾分鐘就是最新），失敗再讀網站內的 data/ */
async function dataFetch(name, bust) {
  const urls = [];
  if (CFG.DATA_URL) urls.push(CFG.DATA_URL + name + (bust ? "?t=" + Date.now() : ""));
  urls.push("data/" + name);
  let last;
  for (const u of urls) {
    try { const r = await fetch(u, {cache: "no-cache"}); if (r.ok) return await r.json(); last = new Error(`讀不到 ${name}（${r.status}）`); }
    catch (e) { last = e; }
  }
  throw last;
}
async function loadData(bust = false) {
  const j = await dataFetch("stocks.json", bust);
  if (DB && j.generated <= DB.generated && !bust) return;
  DB = j; DB.live = null;
  S = DB.rows.map(row => { const o = {}; DB.fields.forEach((f, i) => o[f] = row[i]); o.themes = o.themes || []; o.etf = o.size === "E"; o.note = DB.notes[o.code] || {}; return o; });
  BY = Object.fromEntries(S.map(s => [s.code, s]));
  $("codeList").innerHTML = S.map(s => `<option value="${s.code}">${esc(s.name)}</option>`).join("");
}

/* ---------------- 刷新最新收盤價 ----------------
   每日資料由 GitHub Actions 在 17:40 與 21:30 產生。上市股票另外可以直接從瀏覽器讀證交所當日行情（證交所允許跨網域讀取），
   所以收盤後打開網頁或按「刷新」就能拿到當天上市收盤價；上櫃的櫃買中心不允許瀏覽器直接讀，只能等每日自動更新。 */
const TPE_NOW = () => new Date(Date.now() + (480 + new Date().getTimezoneOffset()) * 60000);
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function lastCloseDay() {   // 最近一個已經收盤（14:00 後）的平日
  const d = TPE_NOW(); if (d.getHours() < 14) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return isoDay(d);
}
const curDate = mkt => (DB.live && DB.live[mkt]) || DB.date;
async function liveTWSE() {
  const r = await fetch("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?type=ALLBUT0999&response=json&_=" + Date.now());
  if (!r.ok) throw new Error("證交所 " + r.status);
  const j = await r.json();
  let date = String(j.date || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const out = {};
  for (const t of j.tables || []) {
    const f = (t.fields || []).map(x => String(x).trim()), ci = f.indexOf("證券代號"), pi = f.indexOf("收盤價");
    if (ci < 0 || pi < 0) continue;
    if (!/^\d{4}-/.test(date)) { const m = (t.title || "").match(/(\d+)年(\d+)月(\d+)日/); if (m) date = `${+m[1] + 1911}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`; }
    const vi = f.indexOf("成交股數"), si = f.indexOf("漲跌(+/-)"), di = f.indexOf("漲跌價差");
    for (const row of t.data || []) {
      const p = parseFloat(String(row[pi]).replace(/,/g, "")); if (!(p > 0)) continue;
      const diff = parseFloat(String(row[di]).replace(/,/g, "")), neg = String(row[si]).includes("-");
      out[String(row[ci]).trim()] = {price: p, chg: isFinite(diff) ? +(neg ? -diff : diff).toFixed(2) : null, vol: Math.round(parseFloat(String(row[vi]).replace(/,/g, "")) / 1000) || 0};
    }
  }
  return {date, out};
}
function applyLive(mkt, date, out) {
  let n = 0;
  S.forEach(s => {
    const q = out[s.code]; if (s.mkt !== mkt || !q) return;
    const k = q.price / s.price;
    if (s.pe) s.pe = +(s.pe * k).toFixed(2); if (s.pb) s.pb = +(s.pb * k).toFixed(2); if (s.yld) s.yld = +(s.yld / k).toFixed(2); if (s.cap) s.cap = Math.round(s.cap * k);
    s.price = q.price; s.chg = q.chg; s.vol = q.vol; n++;
  });
  DB.live = {...(DB.live || {}), [mkt]: date};
  return n;
}
/* force：使用者按按鈕。自動模式只在資料比最近收盤日舊時才去抓。 */
async function refreshLive(force) {
  const want = lastCloseDay(), msgs = [];
  if (!force && curDate("上市") >= want) return "";
  try {
    const {date, out} = await liveTWSE();
    if (date && date > curDate("上市") && Object.keys(out).length > 300) msgs.push(`上市更新到 ${date.slice(5).replace("-", "/")} 收盤（${applyLive("上市", date, out)} 檔）`);
  } catch (e) { msgs.push("證交所即時行情暫時讀不到"); }
  return msgs.join("；");
}
function redrawAll() {
  GSTAT = null; render(); $("stamp").innerHTML = stampHTML(); $("methodBody").innerHTML = methodHTML();
  const up = S.filter(s => s.chg > 0).length, dn = S.filter(s => s.chg < 0).length;
  $("market").innerHTML = `<span>上漲 <b class="up">${up}</b> 檔</span><span>下跌 <b class="down">${dn}</b> 檔</span><span>每日資料產生 <b>${esc(DB.generated.replace("T", " ").slice(0, 16))}</b></span>${DB.live ? `<span>上市即時更新到 <b>${curDate("上市")}</b></span>` : ""}<span>歷史資料 <b>${DB.historyDays}</b> 天</span>`;
}
function stampHTML() {
  const a = curDate("上市"), b = DB.date;
  const d = a === b ? `資料日期 <b>${b}</b>` : `上市 <b>${a}</b> · 上櫃 <b>${b}</b>`;
  return `${d}<br>上市櫃 ${S.length} 檔 · 紅漲綠跌`;
}
async function doRefresh(btn) {
  const msg = $("refreshMsg"), before = curDate("上市") + "|" + DB.date;
  btn.disabled = true; btn.textContent = "刷新中…"; msg.textContent = "";
  try { await loadData(true); NEWS = null; newsLoading = null; FC = null; fcLoading = null; } catch (e) { msg.textContent = "讀取每日資料失敗：" + e.message; }
  const live = await refreshLive(true);
  redrawAll();
  if (lastAnalysis) analyze($("aCode").value, +$("aPrice").value || 0);
  const after = curDate("上市") + "|" + DB.date, want = lastCloseDay();
  let t = live || (after === before ? "已經是目前能取得的最新資料" : "已載入最新的每日資料");
  if (DB.date < want) t += `。上櫃股價、法人與本益比要等每天 17:40、21:30 的自動更新`;
  msg.textContent = t + "。";
  btn.disabled = false; btn.textContent = "↻ 刷新最新資料";
}

/* ---------------- allocation ---------------- */
/* 依權重換算股數。零股模式：直接換算股數；整張模式：先按比例買整張，剩下的錢再一張一張補給離目標最遠的股票。 */
const isLot = () => state.unit === "lot";
const lotCost = s => s.price * 1000 * 1.001425;
function sizeRows(ws, B, g) {
  const rows = ws.map(({s, w}) => { const L = levels(s), unit = L.entries[0][1] * 1.001425; return {s, L, w, g, unit, shares: 0, cost: 0}; });
  if (!isLot()) { rows.forEach(x => { x.shares = Math.floor(B * x.w / x.unit); x.cost = Math.round(x.shares * x.unit); }); return rows; }
  let cash = B * ws.reduce((a, x) => a + x.w, 0);
  rows.forEach(x => { const lot = x.unit * 1000, n = Math.floor(B * x.w / lot); x.shares = n * 1000; x.cost = Math.round(n * lot); cash -= x.cost; });
  for (let guard = 0; guard < 1000; guard++) {
    const cand = rows.filter(x => x.unit * 1000 <= cash);
    if (!cand.length) break;
    const zero = cand.find(x => x.shares === 0);   // 先讓每檔至少有一張
    const deficit = x => (B * x.w - x.cost) / (x.unit * 1000);
    const best = zero || cand.sort((a, b) => deficit(b) - deficit(a))[0];
    if (!zero && deficit(best) < 0.5) break;        // 再加一張會明顯超過目標比例就停
    best.shares += 1000; best.cost = Math.round(best.shares * best.unit); cash -= best.unit * 1000;
  }
  return rows;
}

function plan() {
  if (state.groups && state.groups.length) return planGroups();
  const B = state.budget, r = state.r;
  const pool = S.filter(s => isRec(s) && sizeOk(s) && (r > 1 || s.risk <= 2) && (!isLot() || lotCost(s) <= B * 0.6));
  const adj = s => scoreOf(s) + (r === 1 && s.risk === 1 ? 1 : 0) + (r === 3 && s.risk === 3 ? 1 : 0) - (r === 2 && s.risk === 3 ? 1 : 0);
  const capOf = s => s.etf ? 1e12 + (ETFI.etf[s.code]?.aum || 0) / 1e3 : (s.cap || 0);   // 同分時 ETF 優先，其次市值大的
  pool.sort((a, b) => adj(b) - adj(a) || capOf(b) - capOf(a));
  const N = state.n || (B < 20000 ? 2 : B < 60000 ? 3 : B < 200000 ? 4 : B < 600000 ? 5 : 8);
  const perGroup = N <= 5 ? 1 : 2, cap3 = {1: 0, 2: .15, 3: .30}[r];
  const banned = new Set();
  for (let iter = 0; iter < 40; iter++) {
    const picks = [], cnt = {}; let etfs = 0;
    for (const s of pool) {
      if (picks.length >= N) break;
      if (banned.has(s.code)) continue;
      if (s.etf) { if (etfs >= 1) continue; etfs++; }
      else { const k = divKey(s); if ((cnt[k] || 0) >= perGroup) continue; cnt[k] = (cnt[k] || 0) + 1; }
      picks.push(s);
    }
    if (r > 1 && picks.length && picks.every(s => s.risk === 3)) { const safe = pool.find(s => s.risk < 3 && !banned.has(s.code) && !picks.includes(s)); if (safe) { if (picks.length >= N) picks.pop(); picks.push(safe); } }
    if (!picks.length) return [];
    const core = modeKey() === "long" ? picks.find(s => s.etf) : null, rest = picks.filter(s => s !== core), tot = rest.reduce((a, s) => a + adj(s), 0) || 1;
    const w = {}, coreW = core ? (rest.length ? {1: .5, 2: .3, 3: .15}[r] : 1) : 0;
    if (core) w[core.code] = coreW;
    rest.forEach(s => w[s.code] = (1 - coreW) * adj(s) / tot);
    let excess = 0; rest.forEach(s => { if (s.risk === 3 && w[s.code] > cap3) { excess += w[s.code] - cap3; w[s.code] = cap3; } });
    const safe = picks.filter(s => s.risk < 3); if (excess && safe.length) { const t = safe.reduce((a, s) => a + w[s.code], 0) || 1; safe.forEach(s => w[s.code] += excess * w[s.code] / t); }
    const rows = sizeRows(picks.map(s => ({s, w: w[s.code]})), B);
    const zero = rows.filter(x => x.shares < 1);
    if (!zero.length) return rows;
    zero.forEach(z => banned.add(z.s.code));
  }
  return [];
}

/* ---------------- 使用者選的配置類別 ---------------- */
const gLabel = k => k.startsWith("t:") ? (DB.themes[k.slice(2)]?.n || k.slice(2)) : k.slice(2);
const gMembers = k => k.startsWith("t:") ? S.filter(s => s.themes.includes(k.slice(2))) : S.filter(s => s.ind === k.slice(2) && !s.etf);
const median = a => { const v = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
let GSTAT = null;
function groupStats(k) {
  const key = modeKey() + "|" + state.sizes.join("") + "|" + k;
  GSTAT = GSTAT || {}; if (GSTAT[key]) return GSTAT[key];
  const mem = gMembers(k).filter(s => s.liq && sizeOk(s)), recs = mem.filter(s => scoreOf(s) >= 2);
  const top = recs.map(scoreOf).sort((a, b) => b - a).slice(0, 3);
  const avgTop = top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0;
  const medRev = median(mem.map(s => s.rev > 300 ? null : s.rev));
  const flowKnown = mem.filter(s => s.f20 != null || s.f5 != null);
  const flowPos = flowKnown.length ? flowKnown.filter(s => (s.f20 ?? s.f5) > 0).length / flowKnown.length : null;
  const mom = median(mem.map(s => s.ch20));
  const cl = (x, a, b) => Math.max(0, Math.min(1, (x - a) / (b - a)));
  const strength = mem.length ? Math.round(40 * avgTop / 5 + 20 * (recs.length / mem.length) + 20 * (medRev == null ? .5 : cl(medRev, -10, 50)) + 10 * (flowPos ?? .5) + 10 * (mom == null ? .5 : cl(mom, -5, 15))) : 0;
  return GSTAT[key] = {k, n: mem.length, rec: recs.length, avgTop, medRev, flowPos, mom, strength};
}
function rankedThemes() { return Object.keys(DB.themes).map(t => groupStats("t:" + t)).filter(g => g.n).sort((a, b) => b.strength - a.strength); }
function rankedInds() {
  const inds = [...new Set(S.filter(s => !s.etf).map(s => s.ind))];
  return inds.map(i => groupStats("i:" + i)).filter(g => g.rec >= 2).sort((a, b) => b.strength - a.strength);
}
function hotKeys() { return rankedThemes().filter(g => g.strength >= 55 && g.rec >= 2).slice(0, 4).map(g => g.k); }
function gWhy(g) {
  const p = [`推薦 ${g.rec}/${g.n} 檔`];
  if (g.medRev != null) p.push(`營收年增中位數 ${pct(+g.medRev.toFixed(1))}`);
  if (g.flowPos != null) p.push(`法人買超比例 ${Math.round(g.flowPos * 100)}%`);
  if (g.mom != null) p.push(`近 20 日漲跌中位數 ${pct(+g.mom.toFixed(1))}`);
  return p.join(" · ");
}

function planGroups() {
  const B = state.budget, r = state.r, sel = state.groups.filter(g => +g.w > 0);
  const totW = sel.reduce((a, g) => a + +g.w, 0) || 1;
  const adj = s => scoreOf(s) + (r === 1 && s.risk === 1 ? 1 : 0) + (r === 3 && s.risk === 3 ? 1 : 0) - (r === 2 && s.risk === 3 ? 1 : 0);
  const capOf = s => s.etf ? 1e12 + (ETFI.etf[s.code]?.aum || 0) / 1e3 : (s.cap || 0);
  const autoN = B < 20000 ? 2 : B < 60000 ? 3 : B < 200000 ? 4 : B < 600000 ? 5 : 8;
  const N = Math.max(state.n || autoN, sel.length), cap3 = {1: 0, 2: .15, 3: .30}[r];
  const used = new Set(), out = [];
  for (const g of sel) {
    const wg = +g.w / totW, Bg = B * wg;
    const pool = gMembers(g.k).filter(s => isRec(s) && sizeOk(s) && (r > 1 || s.risk <= 2) && !used.has(s.code) && (isLot() ? lotCost(s) : s.price * 1.001425) <= Bg)
      .sort((a, b) => adj(b) - adj(a) || capOf(b) - capOf(a));
    let want = Math.max(1, Math.round(N * wg)), idx = 0, picks = pool.slice(0, want); idx = picks.length;
    for (let it = 0; it < 20 && picks.length; it++) {
      const tot = picks.reduce((a, s) => a + adj(s), 0) || 1;
      const ws = picks.map(s => ({s, w: wg * adj(s) / tot}));
      let excess = 0; ws.forEach(x => { if (x.s.risk === 3 && x.w > cap3) { excess += x.w - cap3; x.w = cap3; } });
      const safe = ws.filter(x => x.s.risk < 3); if (excess && safe.length) { const t = safe.reduce((a, x) => a + x.w, 0) || 1; safe.forEach(x => x.w += excess * x.w / t); }
      const rows = sizeRows(ws, B, g.k);
      const zero = rows.filter(x => x.shares < 1);
      if (!zero.length) { rows.forEach(x => { used.add(x.s.code); out.push(x); }); break; }
      picks = picks.filter(s => !zero.some(z => z.s === s));
      while (picks.length < want && idx < pool.length) picks.push(pool[idx++]);
      if (!picks.length) break;
    }
  }
  return out;
}

function renderGroupPick(rows) {
  const box = $("groupPick"), sel = state.groups, selKeys = sel.map(g => g.k), hot = hotKeys(), B = state.budget;
  const totW = sel.reduce((a, g) => a + (+g.w || 0), 0) || 1;
  const card = g => { const on = selKeys.includes(g.k), isHot = hot.includes(g.k);
    return `<button type="button" class="gcard" data-gk="${esc(g.k)}" aria-pressed="${on}"><span class="gc-top"><b>${esc(gLabel(g.k))}</b>${isHot ? `<span class="hot">目前看好</span>` : ""}<span class="gc-check">${on ? "已選" : "＋ 選擇"}</span></span><span class="gbar"><i style="width:${g.strength}%"></i></span><span class="gc-num">看好度 ${g.strength}</span><span class="gc-why">${esc(gWhy(g))}</span></button>`; };
  const themes = rankedThemes(), inds = rankedInds().filter(g => !selKeys.includes(g.k));
  const selHTML = sel.length ? `<div class="gsel">${sel.map(g => { const got = rows.filter(x => x.g === g.k), amt = got.reduce((a, x) => a + x.cost, 0);
      return `<div class="gsel-row"><span class="gs-name">${esc(gLabel(g.k))}</span><label class="gs-w"><input type="number" min="0" max="100" step="5" value="${+g.w}" data-gw="${esc(g.k)}" aria-label="${esc(gLabel(g.k))} 資金比例">%</label><span class="gs-amt">${money(B * (+g.w || 0) / totW)}${got.length ? ` · ${got.length} 檔` : ` · <span class="warn-t">預算內挑不到符合條件的股票</span>`}</span><button type="button" class="linkbtn" data-gdel="${esc(g.k)}">移除</button></div>`; }).join("")}<p class="hint">比例會自動換算成總和 100%（目前合計 ${Math.round(totW)}%）。</p></div>` : `<p class="hint">還沒選類別，下方配置由系統在全市場挑選。</p>`;
  box.innerHTML = `<div class="gp-head"><h3 class="minor">選擇想配置的類別</h3><div class="row"><button type="button" class="btn small" id="gRec">套用目前看好的類別</button><button type="button" class="btn ghost small" id="gEq" ${sel.length < 2 ? "disabled" : ""}>平均分配</button><button type="button" class="btn ghost small" id="gClear" ${sel.length ? "" : "disabled"}>清除，改由系統挑</button></div></div>
    <p class="hint">看好度（0–100）依類別內個股的評分、推薦比例、營收成長、法人買超比例與近 20 日走勢計算；前幾名標「目前看好」。你可以自由勾選、混搭，再調整每一類的資金比例，系統只在你選的類別裡挑股票。</p>
    ${selHTML}
    <div class="gcards">${themes.map(card).join("")}</div>
    <div class="gextra"><label class="lbl" for="gAdd">其他官方產業（依看好度排序）</label><div class="row"><select id="gAdd"><option value="">選擇產業…</option>${inds.map(g => `<option value="${esc(g.k)}">${esc(gLabel(g.k))}（看好度 ${g.strength}，推薦 ${g.rec} 檔）</option>`).join("")}</select><button type="button" class="btn ghost small" id="gAddBtn">加入</button></div></div>`;
}
function setGroups(keys) {
  const prev = Object.fromEntries(state.groups.map(g => [g.k, g.w]));
  const eq = keys.length ? Math.round(100 / keys.length) : 0;
  state.groups = keys.map(k => ({k, w: keys.length === state.groups.length ? (prev[k] ?? eq) : eq}));
}

/* ---------------- text from data ---------------- */
function medPE(s) { return DB.indMedianPE[s.ind]; }
const yi = v => v == null ? "—" : (Math.abs(v) >= 1e5 ? (v / 1e5).toLocaleString("zh-TW", {maximumFractionDigits: Math.abs(v) >= 1e7 ? 0 : 1}) + " 億" : (v / 10).toLocaleString("zh-TW", {maximumFractionDigits: 0}) + " 萬");  // 千元 → 億／萬
const monthLong = m => m ? `${m.slice(0, 4)} 年 ${+m.slice(5)} 月` : "最新月";
const prevMonth = m => { if (!m) return null; let y = +m.slice(0, 4), mo = +m.slice(5) - 1; if (mo < 1) { mo = 12; y--; } return `${y}-${String(mo).padStart(2, "0")}`; };
const lastYear = m => m ? `${+m.slice(0, 4) - 1}${m.slice(4)}` : null;
const ratio = (a, b) => (a == null || !b) ? null : +((a / b - 1) * 100).toFixed(1);
const plLabel = s => s.plYear ? `${s.plYear} 年${{1: "第一季", 2: "上半年", 3: "前三季", 4: "全年"}[s.plQ] || ""}` : "最近一期";
const margin = (a, b) => (a == null || !b) ? null : +(a / b * 100).toFixed(1);

const THEME_RISK = {
  etf: "ETF 成分股集中在電子權值股，大盤回檔時會一起跌",
  semi: "半導體有資本支出與庫存循環，客戶調整庫存時訂單會下修",
  icdesign: "IC 設計產品週期短、價格競爭激烈，新產品失利時營收掉得快",
  ai_server: "AI 伺服器營收集中在少數雲端大廠，訂單時程延後就會反映在單月營收",
  memory: "記憶體是報價循環產業，DRAM／NAND 合約價一旦轉跌，獲利會比營收掉得更快",
  passive: "被動元件有明顯的庫存循環，2026 年 7 月族群曾在一個月內急跌近五成",
  cooling: "散熱族群估值已反映液冷滲透率提升，出貨延遲時股價反應大",
  pcb: "銅箔、玻纖布等原料漲價會壓縮毛利，高階材料認證時程也可能延後",
  leo: "低軌衛星仍在建置期，題材熱度起伏大，部分公司相關營收占比不高",
  cpo: "CPO 與矽光子的量產時程仍不確定，族群漲跌劇烈",
  power: "電源產品有一部分是非 AI 應用，這部分成長慢、毛利較低",
  fin: "金融股獲利受利率、匯率與股債市場波動影響，壽險尤其明顯"
};
const IND_RISK = {
  "水泥工業": "中國水泥產能過剩、碳費與能源轉型投資，讓獲利波動變大",
  "航運業": "運價波動大，獲利循環明顯，旺季過後容易轉弱",
  "鋼鐵工業": "鋼價跟著國際原料與中國供需走，景氣循環明顯",
  "建材營造": "營收集中在交屋時認列，受房市政策與信用管制影響大",
  "生技醫療": "新藥與臨床結果不確定，部分公司長期虧損、靠增資支撐",
  "觀光餐旅": "受景氣、旅遊需求與人力成本影響",
  "塑膠工業": "石化報價偏弱，中國擴產帶來價格壓力",
  "化學工業": "原料報價與中國產能擴張會壓縮利差",
  "紡織纖維": "品牌客戶下單節奏與匯率影響大",
  "汽車工業": "車市需求與關稅政策影響銷量",
  "電子通路業": "毛利率低，營運資金需求大，匯率與庫存跌價影響獲利",
  "光電業": "面板與光學元件報價有循環，產能過剩時跌價快",
  "油電燃氣": "受油價與電價政策影響",
  "食品工業": "原物料成本與消費景氣影響毛利",
  "電機機械": "接單隨景氣循環，交期與匯率影響獲利",
  "貿易百貨": "受消費景氣與電商競爭影響",
  "通信網路業": "電信設備採購有週期，客戶集中度高",
  "電腦及週邊設備業": "品牌與代工訂單集中，毛利率偏低",
  "電子零組件業": "報價隨供需循環，客戶庫存調整時訂單下修",
  "其他電子業": "產品組合分散，個別客戶訂單變動影響大"
};

function autoWhy(s) {
  const a = [], med = medPE(s), m = monthTxt(s.revMonth);
  if (s.rev != null && s.rev >= 20) a.push(s.revCur != null && s.revLY != null ? `${m}營收 ${yi(s.revCur)}，比去年同月的 ${yi(s.revLY)}成長 ${s.rev}%${s.revCum != null ? `；今年累計年增 ${s.revCum}%` : ""}` : `${m}營收年增 ${s.rev}%${s.revCum != null ? `，今年累計年增 ${s.revCum}%` : ""}`);
  if (s.revMoM != null && s.revMoM >= 10 && s.rev >= 0) a.push(`${m}營收比上個月再成長 ${s.revMoM}%，動能延續`);
  const gm = margin(s.plGP, s.plRev), opm = margin(s.plOP, s.plRev);
  if (gm != null && gm >= 40) a.push(`${plLabel(s)}毛利率 ${gm}%${opm != null ? `、營業利益率 ${opm}%` : ""}，獲利能力強`);
  if (s.plEPS != null && s.plEPS > 0 && s.plNI != null) a.push(`${plLabel(s)}稅後淨利 ${yi(s.plNI)}，EPS ${s.plEPS} 元`);
  if (s.pe && med && s.pe <= med) a.push(`本益比 ${s.pe} 倍，低於${s.ind}中位數 ${med} 倍`);
  if (s.roe != null && s.roe >= 15) a.push(`推算 ROE 約 ${s.roe}%（股價淨值比 ÷ 本益比）`);
  if (s.yld != null && s.yld >= 3.5) a.push(`殖利率 ${s.yld}%，以現價買進每年約可領 ${fmt(+(s.price * s.yld / 100).toFixed(2))} 元股利`);
  if (s.f20 > 0 && s.f5 > 0) a.push(`三大法人近 20 日與近 5 日都買超（${lots(s.f20)} / ${lots(s.f5)}）`);
  else if (s.f5 > 0) a.push(`三大法人近 5 日買超 ${lots(s.f5)}`);
  if (s.ch20 != null && s.ch20 > 0 && s.ch20 <= 20) a.push(`近 20 日上漲 ${s.ch20}%，走勢向上但不過熱`);
  return a.length ? a : ["目前數據沒有明顯優勢"];
}

function autoBear(s) {
  const a = [], med = medPE(s), m = monthTxt(s.revMonth);
  const gm = margin(s.plGP, s.plRev), opm = margin(s.plOP, s.plRev);
  // 獲利
  if (!s.etf && (s.plNI != null && s.plNI < 0)) a.push(`${plLabel(s)}虧損：稅後淨利 ${yi(s.plNI)}、EPS ${s.plEPS ?? "—"} 元，股價主要靠題材或資產價值支撐`);
  else if (!s.pe && !s.etf) a.push(s.plEPS > 0 ? `沒有本益比（近四季 EPS 合計為負），${plLabel(s)}雖已轉盈、EPS ${s.plEPS} 元，獲利是否穩定還要觀察` : "近四季虧損或沒有本益比資料，無法用獲利評價股價");
  if (s.plOP != null && s.plOP < 0 && !(s.plNI < 0)) a.push(`${plLabel(s)}本業虧損（營業利益 ${yi(s.plOP)}），獲利主要來自業外`);
  else if (s.plPretax > 0 && s.plOP != null && s.plOP > 0 && (s.plPretax - s.plOP) / s.plPretax > 0.4) a.push(`${plLabel(s)}稅前淨利有 ${Math.round((s.plPretax - s.plOP) / s.plPretax * 100)}% 來自業外收益，本業貢獻偏低，業外不一定每年都有`);
  if (gm != null && gm < 10 && gm >= 0) a.push(`${plLabel(s)}毛利率只有 ${gm}%${opm != null ? `、營業利益率 ${opm}%` : ""}，原料或報價小幅變動就會吃掉獲利`);
  // 估值
  if (s.pe && med && s.pe > med * 1.5) a.push(`本益比 ${s.pe} 倍，是${s.ind}中位數 ${med} 倍的 ${(s.pe / med).toFixed(1)} 倍；成長一放緩，股價修正空間大`);
  else if (s.pe && med && s.pe > med * 1.1) a.push(`本益比 ${s.pe} 倍，比${s.ind}中位數 ${med} 倍高 ${Math.round((s.pe / med - 1) * 100)}%，已有一定的成長溢價`);
  if (s.pe && s.pe > 80) a.push(`本益比超過 80 倍，等於用目前的獲利要 ${Math.round(s.pe)} 年才回本，市場已預期多年高成長`);
  if (s.pb != null && s.pb >= 5 && s.roe != null && s.roe < 15) a.push(`股價淨值比 ${s.pb} 倍偏高，但推算 ROE 只有 ${s.roe}%，帳面價值撐不住現價`);
  else if (s.pb != null && s.pb >= 5) a.push(`股價淨值比 ${s.pb} 倍，已反映高 ROE；獲利率一下滑，估值會跟著修正`);
  if (!s.etf && s.yld != null && s.yld < 1.5) a.push(`殖利率只有 ${s.yld}%，報酬幾乎全靠股價上漲，股價不漲時沒有股利緩衝`);
  // 營收
  if (s.rev != null && s.rev < 0) a.push(s.revCur != null && s.revLY != null ? `${m}營收 ${yi(s.revCur)}，比去年同月的 ${yi(s.revLY)}減少 ${Math.abs(s.rev)}%` : `${m}營收年減 ${Math.abs(s.rev)}%`);
  else if (s.rev != null && s.rev < 10 && !s.etf) a.push(`${m}營收年增只有 ${s.rev}%，成長跟不上同業`);
  if (s.revMoM != null && s.revMoM > -15 && s.revMoM <= -5) a.push(`${m}營收比上個月少 ${Math.abs(s.revMoM)}%，留意是否連續下滑`);
  if (s.revMoM != null && s.revMoM <= -15) a.push(`${m}營收比上個月少 ${Math.abs(s.revMoM)}%（${yi(s.revPrevM)} → ${yi(s.revCur)}），短期動能轉弱，留意下個月是否續降`);
  if (s.rev != null && s.revCum != null && s.rev > 0 && s.rev - s.revCum > 30) a.push(`單月年增 ${s.rev}%，但今年累計只有 ${s.revCum}%，成長可能是單月出貨集中，不一定持續`);
  if (s.revCum != null && s.revCum < 0 && s.rev > 0) a.push(`今年累計營收仍年減 ${Math.abs(s.revCum)}%，單月轉正還不代表全年回溫`);
  if (s.rev != null && s.rev > 300) a.push(`營收年增 ${s.rev}% 多半是去年基期太低，不代表能持續`);
  // 籌碼與走勢
  if (s.f20 < 0 && s.f5 < 0) a.push(`三大法人近 20 日與近 5 日都賣超（${lots(s.f20)} / ${lots(s.f5)}），短期賣壓還沒消化`);
  else if (s.f20 > 0 && s.f5 < 0) a.push(`法人近 20 日買超，但近 5 日轉為賣超 ${lots(s.f5)}，留意是否開始調節`);
  if (s.ch20 != null && s.ch20 >= 25) a.push(`近 20 日已漲 ${s.ch20}%，短線乖離大，追價容易買在高點`);
  else if (s.ch60 != null && s.ch60 >= 40) a.push(`近 60 日已漲 ${s.ch60}%，漲幅已反映不少利多`);
  if (s.ch20 != null && s.ch20 <= -10) a.push(`近 20 日跌 ${Math.abs(s.ch20)}%，趨勢偏弱，等止跌再分批比較安全`);
  // 產業
  const tr = s.themes.map(t => THEME_RISK[t]).find(Boolean) || IND_RISK[s.ind];
  if (tr) a.push(tr);
  // 交易面
  if (s.price >= 1000) a.push(`一張要 ${fmt(Math.round(s.price / 10))} 萬元，小預算只能買零股，零股成交價可能比整股差`);
  if (!s.liq) a.push(`當日成交量只有 ${s.vol ?? 0} 張，流動性不足，不列入推薦`);
  else if (s.vol != null && s.vol < 1000) a.push(`當日成交量約 ${fmt(s.vol)} 張，大筆買賣容易推動股價，建議限價分批`);
  if (s.cap != null && s.cap >= 10000) a.push(`市值約 ${(s.cap / 10000).toFixed(1)} 兆元，是大盤權值股，外資資金進出時波動會放大`);
  if (!isLot() && (s.size === "S" || (s.vol != null && s.vol < 1000))) a.push("零股成交量通常很小，掛單可能好幾天買不到、或成交價比整股差；這檔建議整張買（可在「配置建議」把購買單位改成只買整張）");
  if (s.size === "S" && s.cap) a.push(`市值約 ${fmt(s.cap)} 億，屬小型股，單一消息對股價影響大`);
  if (a.length < 3) a.push("大盤本益比在歷史高檔，整體回檔時這檔也可能跟著跌");
  return a;
}

function finHTML(s) {
  if (s.etf || (s.revCur == null && s.plNI == null)) return "";
  const m = s.revMonth, rows = [];
  if (s.revCur != null) {
    const mo = m ? +m.slice(5) : "", pm = prevMonth(m);
    rows.push([`${mo} 月`, yi(s.revCur), yi(s.revLY), pct(s.rev)]);
    if (s.revCumCur != null) rows.push([`1–${mo} 月累計`, yi(s.revCumCur), yi(s.revCumLY), pct(s.revCum)]);
    if (s.revPrevM != null) rows.push([`上月（${pm ? +pm.slice(5) : ""} 月）`, yi(s.revPrevM), "", s.revMoM != null ? `本月比上月 ${pct(s.revMoM)}` : ""]);
  }
  let rev = rows.length ? `<h4>${m ? m.slice(0, 4) : ""} 年 ${m ? +m.slice(5) : ""} 月營收 vs 去年同期</h4><div class="tbl-wrap"><table class="tbl fin"><thead><tr><th>期間</th><th class="num">${m ? m.slice(0, 4) : "今年"}</th><th class="num">${m ? +m.slice(0, 4) - 1 : "去年"}</th><th class="num">增減</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td class="num">${r[2]}</td><td class="num ${/^\+|比上月 \+/.test(r[3]) ? "up" : /^-|比上月 -/.test(r[3]) ? "down" : ""}">${r[3]}</td></tr>`).join("")}</tbody></table></div>` : "";
  if (s.rh && s.rh.length >= 2) {
    rev += `<p class="hint">近 ${s.rh.length} 個月：${s.rh.map(([mm, c, ly]) => `${+mm.slice(5)} 月 ${yi(c)}${ly ? `（${pct(ratio(c, ly))}）` : ""}`).join("、")}</p>`;
  }
  let pl = "";
  if (s.plNI != null || s.plEPS != null) {
    const gm = margin(s.plGP, s.plRev), opm = margin(s.plOP, s.plRev), npm = margin(s.plNI, s.plRev);
    const r2 = [];
    if (s.plRev != null) r2.push(["營業收入", yi(s.plRev), ""]);
    if (s.plGP != null) r2.push(["營業毛利", yi(s.plGP), gm != null ? `毛利率 ${gm}%` : ""]);
    if (s.plOP != null) r2.push(["營業利益", yi(s.plOP), opm != null ? `營益率 ${opm}%` : ""]);
    if (s.plPretax != null) r2.push(["稅前淨利", yi(s.plPretax), s.plOP != null && s.plPretax ? `業外 ${yi(s.plPretax - s.plOP)}` : ""]);
    if (s.plNI != null) r2.push(["稅後淨利（歸屬母公司）", yi(s.plNI), npm != null ? `淨利率 ${npm}%` : ""]);
    if (s.plEPS != null) r2.push(["每股盈餘 EPS", s.plEPS + " 元", ""]);
    pl = `<h4>${plLabel(s)}損益（累計）</h4><div class="tbl-wrap"><table class="tbl fin"><thead><tr><th>項目</th><th class="num">金額</th><th>比率</th></tr></thead><tbody>${r2.map(r => `<tr><td>${r[0]}</td><td class="num ${String(r[1]).startsWith("-") ? "down" : ""}">${r[1]}</td><td>${r[2]}</td></tr>`).join("")}</tbody></table></div>`;
  }
  return `<div class="fins">${rev ? `<div>${rev}</div>` : ""}${pl ? `<div>${pl}</div>` : ""}</div>`;
}

function metricsOf(s) {
  if (s.etf) { const e = ETFI.etf[s.code] || {};
    return [["資產規模", yiAum(e.aum)], ["殖利率（近 12 月）", e.yld != null ? e.yld + "%" : "—"], ["管理費", e.fee || "—"], ["折溢價", e.prem != null ? pct(e.prem) : "—"], ["當日成交量", s.vol != null ? fmt(s.vol) + " 張" : "—"], ["法人 5 日", lots(s.f5)], ["20 日漲跌", pct(s.ch20)], ["60 日漲跌", pct(s.ch60)]]; }
  const m = [], med = medPE(s);
  if (!s.etf) m.push(["本益比", s.pe ? `${s.pe}${med ? `（產業中位 ${med}）` : ""}` : "—"]);
  if (s.yld != null) m.push(["殖利率", s.yld + "%"]);
  if (s.pb != null) m.push(["股價淨值比", s.pb]);
  if (s.roe != null) m.push(["推算 ROE", s.roe + "%"]);
  if (s.rev != null && s.revCur == null) m.push([`${monthTxt(s.revMonth)}營收年增`, pct(s.rev)]);
  if (s.cap != null) m.push(["市值", fmt(s.cap) + " 億"]);
  if (s.vol != null) m.push(["當日成交量", fmt(s.vol) + " 張"]);
  m.push(["法人 5 日", lots(s.f5)], ["法人 20 日", lots(s.f20)], ["20 日漲跌", pct(s.ch20)], ["60 日漲跌", pct(s.ch60)]);
  return m;
}
const oneLine = s => (s.note.why || (s.etf ? etfWhy(s) : autoWhy(s)))[0];

/* ---------------- 最新消息（GitHub Actions 每天抓的新聞標題與重大訊息） ---------------- */
let NEWS = null, newsLoading = null;
function loadNews() { if (!newsLoading) newsLoading = dataFetch("news.json").catch(() => null).then(j => NEWS = j || {news: {}, ann: {}, covered: []}); return newsLoading; }
const yahooNews = s => `https://tw.stock.yahoo.com/quote/${s.code}.${s.mkt === "上櫃" ? "TWO" : "TW"}/news`;
const googleNews = s => `https://news.google.com/search?q=${encodeURIComponent(s.name + " " + s.code)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
const TONE = {1: `<span class="tone pos">偏正面</span>`, "-1": `<span class="tone neg">偏負面</span>`, 0: ""};
function newsHTML(s) {
  const items = NEWS.news[s.code] || [], ann = NEWS.ann[s.code] || [], covered = (NEWS.covered || []).includes(s.code);
  const pos = items.filter(x => x[4] > 0).length, neg = items.filter(x => x[4] < 0).length;
  let sum;
  if (!items.length) sum = covered ? "近 14 天沒有標題提到這家公司的新聞。" : "這檔不在每日新聞追蹤名單（只追蹤推薦與題材股約 700 檔），請點下方連結查詢。";
  else sum = `近 14 天 ${items.length} 則：${pos ? `偏正面 ${pos} 則` : ""}${pos && neg ? "、" : ""}${neg ? `偏負面 ${neg} 則` : ""}${!pos && !neg ? "多為中性消息" : ""}。` + (neg > pos ? "負面消息較多，進場前先看清楚原因。" : pos > neg ? "消息面偏多，但要留意利多是否已反映在股價。" : "");
  const annHTML = ann.length ? `<h4>公司重大訊息（公開資訊觀測站）</h4><ul class="newslist">${ann.slice(0, 5).map(([d, t]) => `<li><span class="nd">${d}</span>${esc(t)}</li>`).join("")}</ul>` : "";
  const nHTML = items.length ? `<h4>新聞標題</h4><ul class="newslist">${items.map(([t, src, d, url, tn]) => `<li><span class="nd">${d}</span><a href="${esc(url)}" target="_blank" rel="noopener">${esc(t)}</a>${src ? `<span class="ns">${esc(src)}</span>` : ""}${TONE[tn] || ""}</li>`).join("")}</ul>` : "";
  return `<div class="newsbox"><div class="news-h"><h4>最新消息</h4><span class="hint" style="margin:0">更新 ${esc((NEWS.generated || "").replace("T", " ").slice(0, 16))}</span></div><p class="news-sum">${sum}</p>${annHTML}${nHTML}<p class="hint">正面／負面是依標題關鍵字粗判，只是提示，請點開原文自己判斷。更多：<a href="${yahooNews(s)}" target="_blank" rel="noopener">Yahoo 股市新聞</a>、<a href="${googleNews(s)}" target="_blank" rel="noopener">Google 新聞</a></p></div>`;
}
function attachNews(root) {
  root.querySelectorAll("[data-news]").forEach(el => {
    const s = BY[el.dataset.news]; if (!s) return;
    if (NEWS) { el.innerHTML = newsHTML(s); return; }
    el.innerHTML = `<p class="hint">載入最新消息中…</p>`;
    loadNews().then(() => { el.innerHTML = newsHTML(s); });
  });
}

/* ---------------- 上下游（產業價值鏈資訊平台，每週更新） ---------------- */
let CHAIN = null, CIDX = null, chainLoading = null;
function loadChains() {
  if (!chainLoading) chainLoading = dataFetch("chains.json").catch(() => null).then(j => {
    CHAIN = j || {ind: {}}; CIDX = {};
    Object.entries(CHAIN.ind).forEach(([ic, [, segs]]) => segs.forEach((sg, si) => sg[3].forEach(([sub, codes]) => codes.forEach(c => {
      const a = CIDX[c] = CIDX[c] || []; let hit = a.find(x => x.ic === ic && x.si === si);
      if (!hit) a.push(hit = {ic, si, subs: []}); hit.subs.push(sub); }))));
  });
  return chainLoading;
}
const ICURL = ic => `https://ic.tpex.org.tw/introduce.php?ic=${ic}`;
const rankS = (a, b) => (isRec(b) - isRec(a)) || scoreOf(b) - scoreOf(a) || (b.cap || 0) - (a.cap || 0);
function chipsHTML(codes, self) {
  const list = [...new Set(codes)].filter(c => c !== self && BY[c]).map(c => BY[c]).sort(rankS);
  if (!list.length) return `<span class="hint" style="margin:0">這個環節沒有上市櫃公司（多為興櫃或未上市）。</span>`;
  const chip = s => `<button type="button" class="cchip${isRec(s) ? " rec" : ""}" data-an="${s.code}" title="${esc(s.ind)} · ${SIZENAME[s.size]} · 評分 ${scoreOf(s)}/5"><code>${s.code}</code>${esc(s.name)}<small>${"●".repeat(scoreOf(s))}</small></button>`;
  const head = list.slice(0, 8).map(chip).join(""), more = list.slice(8);
  return `<div class="cchips">${head}${more.length ? `<details class="cmore"><summary>再看 ${more.length} 家</summary><div class="cchips">${more.map(chip).join("")}</div></details>` : ""}</div>`;
}
function chainIndHTML(s, hit) {
  const [name, segs] = CHAIN.ind[hit.ic], streams = [...new Set(segs.map(x => x[2]))], me = segs[hit.si], myT = streams.indexOf(me[2]);
  const codesOf = sg => sg[3].flatMap(x => x[1]);
  const peers = me[3].filter(x => hit.subs.includes(x[0])).flatMap(x => x[1]);
  const where = `${esc(name)}${me[2] ? ` › ${esc(me[2])}` : ""} › <b>${esc(me[1])}</b>${hit.subs.some(x => x !== me[1]) ? `（${hit.subs.map(esc).join("、")}）` : ""}`;
  const block = (title, cls, list) => list.length ? `<div class="cgrp ${cls}"><h5>${title}</h5>${list.map(sg => `<div class="cseg"><span class="cseg-n">${esc(sg[1])}</span>${chipsHTML(codesOf(sg), s.code)}</div>`).join("")}</div>` : "";
  let body = block("同環節的同業", "same", [[0, hit.subs.join("、"), "", [["", peers]]]]);
  if (streams.length > 1) {
    const by = t => segs.filter((sg, i) => i !== hit.si && streams.indexOf(sg[2]) === t);
    streams.forEach((st, t) => { if (t === myT) { body += block(`同一層：${esc(st)}其他環節`, "mid", by(t)); return; }
      body += block(`${t < myT ? "↑ 上游方向" : "↓ 下游方向"}：${esc(st)}`, t < myT ? "up" : "down", by(t)); });
  } else body += block("同產業鏈其他環節", "mid", segs.filter((sg, i) => i !== hit.si));
  return `<p class="cwhere">${where}</p>${body}<p class="hint">來源：<a href="${ICURL(hit.ic)}" target="_blank" rel="noopener">產業價值鏈資訊平台・${esc(name)}</a>（證交所、櫃買中心）</p>`;
}
function chainHTML(s, pick = 0) {
  const hits = (CIDX[s.code] || []).slice().sort((a, b) => (s.ind && CHAIN.ind[b.ic][0].includes(s.ind.replace(/業$/, ""))) - (s.ind && CHAIN.ind[a.ic][0].includes(s.ind.replace(/業$/, ""))));
  if (!hits.length) return `<div class="chainbox"><h4>上下游產業鏈</h4><p class="hint">產業價值鏈資訊平台沒有收錄這家公司${s.etf ? "（ETF 不屬於單一產業鏈）" : ""}。</p></div>`;
  const tabs = hits.length > 1 ? `<div class="ctabs" role="tablist">${hits.slice(0, 12).map((h, i) => `<button type="button" role="tab" data-ctab="${i}" aria-selected="${i === pick}">${esc(CHAIN.ind[h.ic][0])}・${esc(CHAIN.ind[h.ic][1][h.si][1])}</button>`).join("")}${hits.length > 12 ? `<span class="hint" style="margin:0">另有 ${hits.length - 12} 個環節</span>` : ""}</div>` : "";
  return `<div class="chainbox"><div class="news-h"><h4>上下游產業鏈</h4><span class="hint" style="margin:0">${hits.length > 1 ? `出現在 ${hits.length} 個環節 · ` : ""}點公司名稱看分析</span></div>${tabs}<div class="cbody">${chainIndHTML(s, hits[Math.min(pick, hits.length - 1)])}</div></div>`;
}
function attachChain(root) {
  root.querySelectorAll("[data-chain]").forEach(el => {
    const s = BY[el.dataset.chain]; if (!s) return;
    const draw = () => { el.innerHTML = chainHTML(s); el.onclick = e => { const t = e.target.closest("[data-ctab]"); if (t) el.innerHTML = chainHTML(s, +t.dataset.ctab); }; };
    if (CHAIN) { draw(); return; }
    el.innerHTML = `<p class="hint">載入上下游中…</p>`; loadChains().then(draw);
  });
}

/* ---------------- 共用連結 ---------------- */
const yahooQ = (s, page) => `https://tw.stock.yahoo.com/quote/${s.code}.${s.mkt === "上櫃" ? "TWO" : "TW"}/${page}`;
const A = (t, u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${t}</a>`;
const isoAgo = n => { const d = new Date(Date.now() + 8 * 3600e3 - n * 864e5); return d.toISOString().slice(0, 10); };
const TONEMARK = {1: `<span class="ob up">▲ 利多</span>`, "-1": `<span class="ob down">▼ 利空</span>`, 0: `<span class="ob mid">● 觀察</span>`};

/* ---------------- ETF 資料（etf.json：持股、規模、配息） ---------------- */
let ETFI = {etf: {}, holders: {}};
const yiAum = v => v == null ? "—" : v >= 1e8 ? fmt(Math.round(v / 1e8)) + " 億" : fmt(Math.round(v / 1e4)) + " 萬";
const FREQ = {"Monthly": "月配", "Quarterly": "季配", "Semi-Annual": "半年配", "Annual": "年配"};
const ETYPE_NOTE = {"槓桿反向": "每日追蹤指數的倍數或反向，適合極短線，不適合長抱", "商品期貨": "持有期貨，會有轉倉成本", "債券": "主要持有債券，跟利率反向", "主動式": "經理人主動選股，沒有固定追蹤指數", "國外股票": "投資海外市場，含匯率風險", "國內股票": "追蹤台股指數或選股規則"};
function etfWhy(s) {
  const e = ETFI.etf[s.code] || {}, a = [];
  const top = e.top || [], t1 = top[0], sum10 = top.reduce((x, y) => x + (y[2] || 0), 0);
  if (e.aum >= 1e11) a.push(`資產規模 ${yiAum(e.aum)}，是市場上規模最大的 ETF 之一，流動性好、清算風險低`);
  else if (e.aum >= 1e10) a.push(`資產規模 ${yiAum(e.aum)}，流動性足夠`);
  if (e.yld >= 4) a.push(`近 12 個月每單位配息 ${e.div12} 元，以現價算殖利率約 ${e.yld}%${e.divFreq ? `（${FREQ[e.divFreq] || e.divFreq}）` : ""}`);
  if (e.ret && e.ret["1y"] != null && e.ret["1y"] > 10) a.push(`近一年股價報酬 ${pct(e.ret["1y"])}${e.ret.ytd != null ? `，今年以來 ${pct(e.ret.ytd)}` : ""}`);
  const fee = parseFloat(e.fee); if (fee && fee <= 0.3) a.push(`管理費 ${e.fee}，長期持有的費用低`);
  if (sum10 && sum10 < 40 && top.length >= 10) a.push(`前十大持股合計只占 ${sum10.toFixed(1)}%，持股分散`);
  else if (t1 && t1[2] >= 30) a.push(`最大持股 ${t1[1]} 占 ${t1[2]}%，表現主要跟著它走`);
  if (e.prem != null && Math.abs(e.prem) <= 0.3) a.push(`折溢價 ${pct(e.prem)}，市價貼近淨值，沒有買貴`);
  if (s.f20 > 0 && s.f5 > 0) a.push(`三大法人近 20 日與近 5 日都買超（${lots(s.f20)} / ${lots(s.f5)}）`);
  if (s.ma20 && s.price > s.ma20 && s.ch20 != null && s.ch20 > 0 && s.ch20 <= 12) a.push(`站上 20 日均線，近 20 日上漲 ${s.ch20}%，走勢穩健`);
  return a.length ? a : ["目前數據沒有明顯優勢"];
}
function etfBear(s) {
  const e = ETFI.etf[s.code] || {}, a = [], top = e.top || [], t1 = top[0];
  if (s.et === "槓桿反向") a.push("槓桿／反向 ETF 每天重設倍數，盤整或來回震盪時淨值會被侵蝕，長期報酬可能遠低於指數的倍數；系統不放進配置建議");
  if (s.et === "商品期貨") a.push("期貨型 ETF 每月要把快到期的合約換成下一期（轉倉），正價差時會產生成本，長期報酬可能低於商品本身");
  if (s.et === "債券") a.push("債券 ETF 價格跟利率反向，利率上升時會跌；長天期債券波動更大，海外債券還有匯率風險");
  if (s.et === "國外股票") a.push("投資海外市場，報酬會受新台幣匯率影響；海外市場收盤時間不同，台股交易時段的價格可能偏離淨值");
  if (s.et === "主動式") a.push("主動式 ETF 由經理人選股，績效取決於經理人判斷，不一定贏過大盤，費用通常比指數型高");
  if (t1 && t1[2] >= 40) a.push(`最大持股 ${t1[1]} 占 ${t1[2]}%，集中度很高，等於大部分押在這一檔上`);
  if (e.aum && e.aum < 2e9) a.push(`資產規模只有 ${yiAum(e.aum)}，規模太小的 ETF 可能被清算下市，成交量也較少`);
  if (e.prem != null && e.prem >= 1) a.push(`目前溢價 ${e.prem}%（市價比淨值貴），追價等於多付了溢價`);
  else if (e.prem != null && e.prem <= -1) a.push(`目前折價 ${Math.abs(e.prem)}%，可能反映流動性不足或海外市場變動`);
  const fee = parseFloat(e.fee); if (fee >= 0.8) a.push(`管理費 ${e.fee} 偏高，長期會侵蝕報酬`);
  if (e.inc && (Date.now() - new Date(e.inc.replace(/\//g, "-"))) / 864e5 < 365) a.push(`成立日 ${e.inc}，不到一年，績效與配息紀錄還很短`);
  if (s.ch20 != null && s.ch20 >= 15) a.push(`近 20 日已漲 ${s.ch20}%，短線漲多，追高容易套在高點`);
  if (s.f20 < 0 && s.f5 < 0) a.push(`三大法人近 20 日與近 5 日都賣超（${lots(s.f20)} / ${lots(s.f5)}）`);
  if (!s.liq) a.push(`當日成交量只有 ${s.vol ?? 0} 張，流動性不足，買賣價差可能很大`);
  if (a.length < 2) a.push("ETF 會跟著持股與大盤一起波動，大盤回檔時一樣會跌");
  return a;
}
function etfHTML(s) {
  const e = ETFI.etf[s.code];
  const links = `${A("Yahoo 持股明細", yahooQ(s, "holding"))}、${A("Yahoo 配息", yahooQ(s, "dividend"))}${e?.site ? `、${A("發行投信網站", e.site)}` : ""}`;
  if (!e) return `<div class="etfbox"><h4>ETF 持股與基本資料</h4><p class="hint">還沒有這檔的資料（每個交易日晚上更新）。可以先看 ${links}。</p></div>`;
  const kv = [["類型", `${esc(s.et || "")}${ETYPE_NOTE[s.et] ? `<small>${ETYPE_NOTE[s.et]}</small>` : ""}`], ["追蹤指數", esc(e.idx && e.idx !== "不適用" ? e.idx : "主動式，無追蹤指數")], ["發行投信", esc((e.issuer || "").replace("證券投資信託股份有限公司", "投信"))], ["成立日", esc(e.inc || "—")],
    ["資產規模", `${yiAum(e.aum)}<small>${esc(e.aumDate || "")}</small>`], ["管理費", esc(e.fee || "—")], ["配息", e.div12 ? `近 12 月 ${e.div12} 元・殖利率 ${e.yld ?? "—"}%<small>${FREQ[e.divFreq] || e.divFreq || ""}</small>` : (e.divFreq ? FREQ[e.divFreq] || e.divFreq : "不配息或尚未配息")],
    ["折溢價", e.prem != null ? `${pct(e.prem)}<small>${esc(e.premDate || "")}</small>` : "—"]];
  const ret = e.ret ? [["近 1 月", e.ret["1m"]], ["近 3 月", e.ret["3m"]], ["近 6 月", e.ret["6m"]], ["近 1 年", e.ret["1y"]], ["今年以來", e.ret.ytd]].filter(x => x[1] != null) : [];
  const bar = (w, max) => `<span class="wbar"><i style="width:${Math.min(100, w / (max || 100) * 100)}%"></i></span>`;
  const top = e.top || [], mx = Math.max(...top.map(x => x[2] || 0), 1), sum10 = top.reduce((x, y) => x + (y[2] || 0), 0);
  const topHTML = top.length ? `<h5>前十大持股 <small>資料日期 ${esc(e.topDate || "")}・投信每月公告，約落後 1–2 個月</small></h5><table class="holdtbl"><tbody>${top.map(([tk, nm, w], i) => `<tr><td class="rk">${i + 1}</td><td>${BY[tk] ? `<button type="button" class="linkbtn" data-an="${tk}"><code>${tk}</code> ${esc(nm)}</button>` : esc(nm)}</td><td class="num">${w}%</td><td class="bc">${bar(w, mx)}</td></tr>`).join("")}</tbody></table><p class="hint">前十大合計 ${sum10.toFixed(1)}%。</p>` : "";
  const ALN = {stock: "股票", bond: "債券", cash: "現金", other: "其他"};
  const alloc = e.alloc && Object.keys(e.alloc).length ? `<h5>資產配置</h5><div class="allocbar">${Object.entries(e.alloc).filter(([, v]) => v > 0).map(([k, v], i) => `<i style="flex-basis:${v}%;background:${COLORS[i]}" title="${ALN[k] || k} ${v}%"></i>`).join("")}</div><p class="hint">${Object.entries(e.alloc).filter(([, v]) => v > 0).map(([k, v]) => `${ALN[k] || k} ${v}%`).join("・")}</p>` : "";
  const inds = (e.inds || []).slice(0, 8), imx = Math.max(...inds.map(x => x[1] || 0), 1);
  const indHTML = inds.length ? `<h5>產業／地區配置 <small>${esc(e.indDate || "")}</small></h5><table class="holdtbl"><tbody>${inds.map(([n, w]) => `<tr><td>${esc(n)}</td><td class="num">${w}%</td><td class="bc">${bar(w, imx)}</td></tr>`).join("")}</tbody></table>` : "";
  const divHTML = (e.divs || []).length ? `<h5>最近配息</h5><p class="hint" style="margin-top:0">${e.divs.map(([d, v]) => `${d} 配 ${v} 元`).join("・")}</p>` : "";
  return `<div class="etfbox"><h4>ETF 持股與基本資料</h4>
    <div class="kv">${kv.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>
    ${ret.length ? `<div class="retrow">${ret.map(([k, v]) => `<div><span>${k}</span><b class="${v > 0 ? "up" : v < 0 ? "down" : ""}">${pct(v)}</b></div>`).join("")}</div>` : ""}
    <div class="etfcols"><div>${topHTML}</div><div>${alloc}${indHTML}${divHTML}</div></div>
    <p class="hint">資料來源：${links}（${esc(ETFI.source || "")}，更新 ${esc((ETFI.generated || "").replace("T", " "))}）</p></div>`;
}
function holdersHTML(s) {
  const hs = (ETFI.holders || {})[s.code];
  if (!hs || !hs.length) return "";
  return `<div class="holders"><h4>持有這檔的 ETF <small>（列在前十大持股裡的，共 ${hs.length} 檔）</small></h4><div class="cchips">${hs.slice(0, 16).map(([c, w]) => `<button type="button" class="cchip" data-an="${c}"><code>${c}</code>${esc(BY[c]?.name || "")}<small style="color:var(--muted);letter-spacing:0">${w}%</small></button>`).join("")}</div><p class="hint">大型 ETF 調整持股或資金大量申購贖回時，會帶動這檔的買賣盤。</p></div>`;
}

/* ---------------- 線形圖與短線動態（附查核連結） ---------------- */
const SER = {};
function loadSeries(code) { const k = code[0]; if (!SER[k]) SER[k] = dataFetch(`series/${k}.json`).catch(() => null); return SER[k]; }
function maOf(arr, w) { return arr.map((_, i) => { if (i < w - 1) return null; const sl = arr.slice(i - w + 1, i + 1); return sl.some(v => v == null) ? null : sl.reduce((x, y) => x + y, 0) / w; }); }
function chartSVG(s, ser, L) {
  const raw = ser?.p?.[s.code]; if (!raw) return "";
  const idx = raw.map((v, i) => [i, v]).filter(x => x[1] != null);
  if (idx.length < 10) return "";
  const closes = raw.slice(), dates = ser.dates;
  if (DB.live && DB.live[s.mkt] && DB.live[s.mkt] > dates[dates.length - 1]) { closes.push(s.price); dates.push(DB.live[s.mkt]); }
  const m20 = maOf(closes, 20), m60 = maOf(closes, 60);
  const lines = [[L.entries[1][1], "第二筆", "var(--accent)"], [L.stop, "停損", "var(--down)"], [L.tp1 || L.review, L.tp1 ? "停利一" : "評估價", "var(--up)"]];
  const cv = closes.filter(v => v != null), cmin = Math.min(...cv), cmax = Math.max(...cv), span = cmax - cmin || cmax * .05;
  const near = lines.filter(x => x[0] >= cmin - span * .6 && x[0] <= cmax + span * .6);   // 太遠的線不畫，避免把走勢壓扁
  const far = lines.filter(x => !near.includes(x));
  const vals = [...cv, ...near.map(x => x[0])];
  let lo = Math.min(...vals), hi = Math.max(...vals); const padv = (hi - lo) * .06; lo -= padv; hi += padv;
  const W = 640, H = 230, l = 6, r = 104, t = 10, b = 24, n = closes.length;
  const X = i => l + i / (n - 1) * (W - l - r), Y = v => t + (hi - v) / (hi - lo) * (H - t - b);
  const path = arr => { let d = "", pen = false; arr.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1); pen = true; }); return d; };
  const last = closes[n - 1], first = closes.find(v => v != null), up = last >= first;
  const area = path(closes) + `L${X(n - 1).toFixed(1)} ${H - b}L${X(closes.findIndex(v => v != null)).toFixed(1)} ${H - b}Z`;
  const md = d => d ? `${+d.slice(5, 7)}/${+d.slice(8)}` : "";
  const xl = [0, Math.floor((n - 1) / 2), n - 1].map(i => `<text x="${X(i).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}" class="ax">${md(dates[i])}</text>`).join("");
  const hl = near.map(([v, name, c]) => `<line x1="${l}" x2="${W - r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${c}" stroke-dasharray="4 4" stroke-width="1"/><text x="${W - r + 4}" y="${(Y(v) + 4).toFixed(1)}" class="lb" fill="${c}">${name} ${fmt(v)}</text>`).join("");
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.name)} 近 ${n} 個交易日收盤價走勢">
    <defs><linearGradient id="g${s.code}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${up ? "var(--up)" : "var(--down)"}" stop-opacity=".18"/><stop offset="1" stop-color="${up ? "var(--up)" : "var(--down)"}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#g${s.code})"/>
    <path d="${path(m60)}" fill="none" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 3"/>
    <path d="${path(m20)}" fill="none" stroke="var(--c3)" stroke-width="1.3"/>
    <path d="${path(closes)}" fill="none" stroke="${up ? "var(--up)" : "var(--down)"}" stroke-width="1.8"/>
    ${hl}${xl}</svg>
    <figcaption><span class="lg"><i style="background:${up ? "var(--up)" : "var(--down)"}"></i>收盤價</span><span class="lg"><i style="background:var(--c3)"></i>20 日均線</span><span class="lg"><i class="dash"></i>60 日均線</span>近 ${n} 個交易日・虛線是這次建議的價位${far.length ? `（${far.map(x => `${x[1]} ${fmt(x[0])}`).join("、")} 離目前走勢較遠，沒畫進圖裡）` : ""}</figcaption></figure>`;
}
function obsItems(s) {
  const it = [], yq = p => yahooQ(s, p), twse = s.mkt === "上市";
  const items = (NEWS?.news?.[s.code] || []), wk = items.filter(x => x[2] >= isoAgo(7)), ann = (NEWS?.ann?.[s.code] || []).filter(x => x[0] >= isoAgo(7));
  if (wk.length) {
    const p = wk.filter(x => x[4] > 0).length, n = wk.filter(x => x[4] < 0).length, lt = wk[0];
    it.push([p > n ? 1 : n > p ? -1 : 0, `<b>新聞走向</b>：近 7 天 ${wk.length} 則，偏正面 ${p}、偏負面 ${n}。最新：${A(esc(lt[0]), lt[3])}<span class="ns">${esc(lt[1])} ${lt[2]}</span>`]);
  } else it.push([0, `<b>新聞走向</b>：近 7 天沒有標題提到這家公司的新聞。${A("Google 新聞", googleNews(s))}`]);
  if (ann.length) it.push([0, `<b>重大訊息</b>：${ann.slice(0, 2).map(([d, t]) => `${d} ${esc(t)}`).join("；")}。${A("公開資訊觀測站", "https://mops.twse.com.tw/mops/#/web/t05st01")}`]);
  if (s.ma20) {
    const a20 = s.price > s.ma20, a60 = s.ma60 ? s.price > s.ma60 : null;
    let txt = `<b>線形</b>：收盤 ${fmt(s.price)}，在 20 日均線 ${fmt(s.ma20)} ${a20 ? "之上" : "之下"}${s.ma60 ? `、60 日均線 ${fmt(s.ma60)} ${a60 ? "之上" : "之下"}` : ""}`;
    if (s.ch20 != null) txt += `，近 20 日${s.ch20 >= 0 ? "漲" : "跌"} ${Math.abs(s.ch20)}%`;
    if (s.hi20 && s.price < s.hi20) txt += `，離近 20 日高點 ${fmt(s.hi20)} 還有 ${((s.hi20 / s.price - 1) * 100).toFixed(1)}%`;
    else if (s.hi20 && s.price >= s.hi20) txt += `，創近 20 日新高`;
    it.push([a20 && a60 !== false ? 1 : !a20 && a60 === false ? -1 : 0, txt + `。${A("Yahoo 技術分析", yq("technical-analysis"))}・線形圖見下方`]);
  }
  if (s.rsi != null && (s.rsi >= 75 || s.rsi <= 30)) it.push([s.rsi >= 75 ? -1 : 0, `<b>短線熱度</b>：14 日 RSI ${s.rsi}，${s.rsi >= 75 ? "短線過熱，容易拉回" : "短線超賣，可能出現跌深反彈，但趨勢未必反轉"}。`]);
  if (s.inst != null) {
    const r = s.vol ? Math.round(s.inst / s.vol * 100) : null;
    it.push([Math.sign(s.f5 ?? s.inst) || 0, `<b>法人</b>：三大法人今天${s.inst >= 0 ? "買" : "賣"}超 ${fmt(Math.abs(s.inst))} 張${r != null ? `（約占成交量 ${Math.abs(r)}%）` : ""}${s.f5 != null ? `，近 5 日 ${lots(s.f5)}` : ""}${s.f20 != null ? `、近 20 日 ${lots(s.f20)}` : ""}。${A("Yahoo 法人買賣", yq("institutional-trading"))}${twse ? `・${A("證交所三大法人", "https://www.twse.com.tw/zh/trading/foreign/t86.html")}` : ""}`]);
  }
  if (s.ls != null || s.lb != null) {
    const ratio = s.ls20 ? s.ls / Math.max(s.ls20, 1) : null, big = ratio && ratio >= 2 && s.vol && s.ls > 0.05 * s.vol;
    let txt = `<b>借券賣出（放空賣壓）</b>：今天借券賣出 ${fmt(s.ls ?? 0)} 張${s.ls20 != null ? `，近 20 日平均 ${fmt(s.ls20)} 張${ratio && ratio >= 1.5 ? `，放大 ${ratio.toFixed(1)} 倍` : ""}` : ""}`;
    if (s.lb != null) txt += `；借券賣出餘額 ${fmt(s.lb)} 張${s.lbCh5 ? `（5 日 ${s.lbCh5 > 0 ? "+" : ""}${fmt(s.lbCh5)}）` : ""}`;
    txt += big ? "。借券賣出突然放大，通常是外資或法人放空、避險，短線會形成賣壓" : "。";
    it.push([big || (s.lbCh5 > 0 && s.vol && s.lbCh5 > 0.3 * s.vol) ? -1 : 0, txt + ` ${A("Yahoo 資券變化", yq("margin"))}${twse ? `・${A("證交所借券賣出", "https://www.twse.com.tw/zh/trading/margin/twt93u.html")}` : ""}`]);
  }
  if (s.mb != null || s.sb != null) {
    const pctCh = (v, ch) => v && ch != null && v - ch > 0 ? Math.round(ch / (v - ch) * 100) : null;
    const mp = pctCh(s.mb, s.mbCh5), sp = pctCh(s.sb, s.sbCh5);
    const neg = mp != null && mp >= 10 && s.chg < 0;
    it.push([neg ? -1 : 0, `<b>融資融券</b>：融資餘額 ${fmt(s.mb ?? 0)} 張${mp != null ? `（5 日 ${mp > 0 ? "+" : ""}${mp}%）` : ""}、融券餘額 ${fmt(s.sb ?? 0)} 張${sp != null ? `（5 日 ${sp > 0 ? "+" : ""}${sp}%）` : ""}。${neg ? "散戶融資加碼但股價下跌，籌碼變亂。" : sp != null && sp >= 20 ? "融券大增代表看空的人變多，但回補時也可能造成軋空。" : ""}${A("Yahoo 資券變化", yq("margin"))}${twse ? `・${A("證交所融資融券", "https://www.twse.com.tw/zh/trading/margin/mi-margn.html")}` : ""}`]);
  }
  it.push([0, `<b>誰在買賣</b>：公開資料無法判斷是否有人「故意」壓低或拉抬，但可以看哪幾家券商分點大量進出：${A("Yahoo 主力進出", yq("broker-trading"))}・${A("Goodinfo 個股", GOODINFO(s.code))}`]);
  return it;
}
function obsHTML(s, ser, L) {
  const its = obsItems(s);
  return `<div class="obsbox"><h4>短線動態與籌碼 <small>每一項都附查核連結</small></h4>${chartSVG(s, ser, L)}<ul class="obs">${its.map(([t, h]) => `<li>${TONEMARK[t]}<span>${h}</span></li>`).join("")}</ul>${s.chipDate ? "" : ""}<p class="hint">籌碼資料：證交所／櫃買中心每日公告（融資融券、借券賣出、三大法人），資料日期 ${DB.date}。</p></div>`;
}
function attachObs(root) {
  root.querySelectorAll("[data-obs]").forEach(el => {
    const s = BY[el.dataset.obs]; if (!s) return;
    const price = +el.dataset.price || s.price;
    el.innerHTML = `<p class="hint">載入線形圖與籌碼中…</p>`;
    Promise.all([loadSeries(s.code), loadNews()]).then(([ser]) => { el.innerHTML = obsHTML(s, ser, levels(s, price)); });
  });
}
function attachAll(root) { attachChain(root); attachNews(root); attachObs(root); }

/* ---------------- rendering pieces ---------------- */
function ladderHTML(L, etf) {
  let h = L.entries.map(([k, v]) => `<tr class="en"><td>${k}</td><td>${fmt(v)}</td></tr>`).join("");
  if (L.mode === "short") h += `<tr class="tp"><td>停利二（再出 50%）</td><td>${fmt(L.tp2)}</td></tr><tr class="tp"><td>停利一（先出 50%）</td><td>${fmt(L.tp1)}</td></tr><tr class="sl"><td>停損（收盤跌破全出）</td><td>${fmt(L.stop)}</td></tr>`;
  else h += `<tr class="tp"><td>重新評估價（考慮賣一半）</td><td>${fmt(L.review)}</td></tr><tr class="sl"><td>停損（收盤跌破全出）</td><td>${fmt(L.stop)}</td></tr>`;
  const avg = fmt(+L.avg.toFixed(2)), d = daysText(days()), dl = (L.entries[0][1] - L.stop) / L.entries[0][1];
  const why = `<li>第二筆設在${L.e2why}；兩筆都買到時平均成本約 ${avg}。</li><li>停損：${L.stopWhy}（從現價算約 −${(dl * 100).toFixed(1)}%）。</li><li>${L.mode === "short" ? "停利" : "重新評估價"}：依這檔近 60 日的實際波動，持有 ${d} 的正常波動約 ±${(L.m * 100).toFixed(1)}%，${L.mode === "short" ? "停利一取 0.6 倍、停利二取 1.2 倍" : "取 0.6 倍（至少 12%）"}，不抓最樂觀的情境。${L.resist ? `途中會先碰到前波高點 ${fmt(L.resist)}，那裡可能有賣壓。` : ""}</li>`;
  const rules = L.mode === "short"
    ? `<li>持有到第 ${d} 仍沒碰到停利一，就出場。</li><li>碰到停利一後，把剩下部位的停損上移到平均成本 ${avg}。</li><li>第二筆沒回檔到就不追，用第一筆的部位操作即可。</li>`
    : `<li>${etf ? "ETF 可改為每月定期定額，不必等回檔。" : "月營收年增率連兩個月轉負：減碼一半。"}</li><li>第二筆沒回檔到就不追；預計持有 ${d}，期滿重新評估。</li>`;
  return `<table class="ladder"><tbody>${h}</tbody></table><ul class="rules">${why}${rules}</ul>`;
}
function stockBody(s, opts = {}) {
  const price = opts.price || s.price, L = levels(s, price), h = modeKey(), sc = scoreOf(s), x = opts.row;
  const tags = [];
  s.themes.forEach(t => tags.push(`<span class="tag">${esc(DB.themes[t]?.n || t)}</span>`));
  tags.push(`<span class="tag">${esc(s.ind)}</span>`, `<span class="tag">${s.mkt}</span>`, `<span class="tag">${SIZENAME[s.size]}${s.etf ? "" : "股"}</span>`, `<span class="tag r${s.risk}">${RISKNAME[s.risk]}</span>`, `<span class="tag">${VOLNAME[s.volc]}</span>`, `<span class="tag">${h === "short" ? "波段" : "長期"}評分 ${sc}/5</span>`);
  if (!isRec(s)) tags.push(`<span class="tag warn">不在推薦清單</span>`);
  const fit = Math.floor(state.budget / (price * 1.001425));
  const tr = 2, lotsN = Math.floor((x?.shares || 0) / 1000);
  const firstTxt = !x ? "" : isLot() ? sharesText(Math.max(1, Math.floor(lotsN / tr)) * 1000) : sharesText(Math.max(1, Math.floor(x.shares / tr)));
  const lotNote = x && isLot() && lotsN < tr ? `<span class="hint" style="margin:0">只有 ${lotsN} 張，分不成 ${tr} 筆：建議先在第一筆價位買 1 張，其餘等回檔到後面的進場價再買。</span>` : "";
  const buy = x ? `<div class="buy"><span>配置 <b>${Math.round(x.w * 100)}%</b></span><span>第一筆 <b>${firstTxt}</b></span><span>全部到位 <b>${sharesText(x.shares)}</b></span><span>預估投入 <b>${money(x.cost)}</b></span>${lotNote}</div>`
    : fit >= 1 ? `<div class="buy"><span>用全部預算可買 <b>${sharesText(fit)}</b></span><span>一張 <b>${money(price * 1000 * 1.001425)}</b></span></div>` : `<div class="buy">預算不足一股（一股 ${money(price * 1.001425)}）。</div>`;
  const n = s.note, why = [...(n.why || []), ...(s.etf ? etfWhy(s) : autoWhy(s)).filter(t => !t.startsWith("目前數據"))].slice(0, 6), bear = [...(n.bear || []), ...(s.etf ? etfBear(s) : autoBear(s))].slice(0, 8);
  const src = [[`FinLab ${s.code}`, FINLAB(s.code)], [`Goodinfo ${s.code}`, GOODINFO(s.code)], ...(n.src || [])];
  return `<div class="tags">${tags.join("")}</div>${buy}
   ${opts.price && opts.price !== s.price ? `<p class="hint">價位用你輸入的現價 ${fmt(opts.price)} 計算；其他數據是 ${DB.date} 的資料。</p>` : ""}
   <div class="metrics">${metricsOf(s).map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>
   ${finHTML(s)}
   <div class="cols"><div><h4>看好的理由</h4><ul>${(why.length ? why : ["目前基本面數據沒有明顯優勢，請參考下方短線動態"]).map(t => `<li>${esc(t)}</li>`).join("")}</ul><h4 style="margin-top:10px">主要風險</h4><ul>${bear.map(t => `<li>${esc(t)}</li>`).join("")}</ul>${n.adjNote ? `<p class="hint">${esc(n.adjNote)}</p>` : ""}</div>
   <div><h4>${h === "short" ? "波段" : "長期"}進出場參考價（持有 ${daysText(days())}）</h4>${ladderHTML(L, s.etf)}</div></div>
   ${n.event ? `<div class="event">${esc(n.event)}</div>` : ""}
   <div data-obs="${s.code}" data-price="${price}"></div>
   ${s.etf ? etfHTML(s) : `<div data-chain="${s.code}"></div>${holdersHTML(s)}`}
   <div data-news="${s.code}"></div>
   <div class="src">資料來源：證交所／櫃買中心 OpenAPI（${DB.date}）、${src.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${esc(t)}</a>`).join("、")}</div>`;
}
function stockRow(s, rows) {
  const ci = rows.findIndex(r => r.s === s), x = rows[ci], sc = scoreOf(s);
  const fit = Math.floor(state.budget / (s.price * 1.001425));
  const fitHTML = x ? `<span class="pill in">已配置 ${Math.round(x.w * 100)}%</span>` : isLot() ? (fit >= 1000 ? `<span class="pill out">可買 ${Math.floor(fit / 1000)} 張</span>` : `<span class="pill no">預算買不起一張</span>`) : fit >= 1000 ? `<span class="pill out">可買 ${sharesText(fit)}</span>` : fit >= 1 ? `<span class="pill out">零股 ${fit} 股</span>` : `<span class="pill no">預算不足一股</span>`;
  const d = document.createElement("details"); d.className = "stock"; d.id = "s" + s.code;
  const dot = x ? `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${COLORS[ci % COLORS.length]};margin-right:6px"></span>` : "";
  const on = watch.has(s.code);
  d.innerHTML = `<summary><button type="button" class="star" data-star="${s.code}" aria-pressed="${on}" aria-label="${on ? "移出" : "加入"}自選股">${on ? "★" : "☆"}</button><span class="s-name">${dot}<code>${s.code}</code>${esc(s.name)}<small>${SIZENAME[s.size]}</small><span class="dots" aria-label="評分 ${sc} 分">${"●".repeat(sc)}${"○".repeat(5 - sc)}</span></span><span class="s-price">${fmt(s.price)}</span><span class="s-one">${esc(oneLine(s))}</span><span class="s-fit">${fitHTML}</span></summary><div class="body"></div>`;
  d.addEventListener("toggle", () => { if (d.open) { const b = d.querySelector(".body"); b.innerHTML = stockBody(s, {row: x}); attachAll(b); } });
  return d;
}

/* ---------------- main render ---------------- */
function filtered() {
  const B = state.budget, q = state.q.trim().toLowerCase();
  let list = S.filter(isRec);
  if (state.group === "theme") list = list.filter(s => s.themes.length);
  if (state.mkt !== "all") list = list.filter(s => s.mkt === state.mkt);
  if (state.size !== "all") list = list.filter(s => s.size === state.size);
  if (state.afford === "lot") list = list.filter(s => s.price * 1000 * 1.001425 <= B);
  if (state.afford === "share") list = list.filter(s => s.price * 1.001425 <= B);
  if (q) list = list.filter(s => s.code.includes(q) || s.name.toLowerCase().includes(q) || s.ind.toLowerCase().includes(q));
  return list;
}
const sorters = {
  score: (a, b) => scoreOf(b) - scoreOf(a) || (b.cap || 0) - (a.cap || 0),
  price: (a, b) => a.price - b.price,
  pe: (a, b) => (a.pe || 9999) - (b.pe || 9999),
  rev: (a, b) => (b.rev ?? -999) - (a.rev ?? -999),
  yld: (a, b) => (b.yld ?? -1) - (a.yld ?? -1)
};
function pagerHTML(total, pages) {
  const p = state.page, from = total ? (p - 1) * state.per + 1 : 0, to = Math.min(total, p * state.per);
  const nums = []; for (let i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - p) <= 2) nums.push(i); else if (nums[nums.length - 1] !== "…") nums.push("…");
  return `<span class="info">第 ${from}–${to} 檔，共 ${total} 檔</span><div class="pages"><button type="button" data-p="${p - 1}" ${p <= 1 ? "disabled" : ""}>上一頁</button>${nums.map(i => i === "…" ? `<span class="info">…</span>` : `<button type="button" data-p="${i}" ${i === p ? 'aria-current="page"' : ""}>${i}</button>`).join("")}<button type="button" data-p="${p + 1}" ${p >= pages ? "disabled" : ""}>下一頁</button></div>`;
}

let ROWS = [];
function render() {
  if (!DB) return;
  $("budget").value = state.budget; $("tNum").value = state.tNum; $("tUnit").value = String(state.tUnit); $("nPick").value = String(state.n);
  [["fGroup", "group"], ["fMkt", "mkt"], ["fSize", "size"], ["fAfford", "afford"], ["fSort", "sort"], ["fPer", "per"]].forEach(([id, k]) => $(id).value = String(state[k]));
  if (document.activeElement !== $("fQ")) $("fQ").value = state.q;
  document.querySelectorAll("#risk button").forEach(b => b.setAttribute("aria-pressed", +b.dataset.v === state.r));
  document.querySelectorAll("#unit button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === state.unit));
  document.querySelectorAll("#sizes button").forEach(b => b.setAttribute("aria-pressed", state.sizes.includes(b.dataset.v)));
  const recBy = k => S.filter(s => isRec(s) && s.size === k).length;
  $("sizeHint").textContent = (allSizes() ? "不限規模，" : `只從${state.sizes.map(k => SIZENAME[k]).join("、")}${state.sizes.length === 1 && state.sizes[0] === "E" ? "" : "股"}裡挑，`) + `目前推薦：大型 ${recBy("L")}、中型 ${recBy("M")}、小型 ${recBy("S")}、ETF ${recBy("E")} 檔。` + (state.sizes.includes("S") ? "小型股成交量較小，建議用限價單。" : "");
  $("unitHint").textContent = isLot() ? "只配置買得起一整張的股票，股數都是 1,000 股的倍數；單一股票最多占預算 60%。" : "可以買零股，小預算也能分散；但小型股的零股成交量小，建議改買整張。";
  $("riskHint").textContent = {1: "以 ETF、金融與中低風險股為主，不放高風險股。", 2: "高風險股單檔上限 15%。", 3: "可放題材股與小型股，高風險股單檔上限 30%。"}[state.r];
  const h = modeKey(), d = days();
  $("modeBox").innerHTML = `持有 <b>${daysText(d)}</b> → <b>${h === "short" ? "波段模式" : "長期模式"}</b>${d < 14 ? "<br>少於 2 週接近短打，這套規則參考性較低。" : ""}${h === "short" && DB.shortMode !== "full" ? "<br>歷史資料還在累積，波段評分暫時只用基本面估算。" : ""}`;

  GSTAT = null;
  const rows = ROWS = plan(), B = state.budget, used = rows.reduce((a, x) => a + x.cost, 0);
  $("sum").innerHTML = `<div><small>預算</small><strong>${money(B)}</strong></div><div><small>全部到位投入</small><strong>${money(used)}</strong></div><div><small>保留現金</small><strong>${money(B - used)}</strong></div><div><small>配置標的</small><strong>${rows.length} 檔</strong></div>`;
  $("bar").innerHTML = rows.map((x, i) => `<i style="flex-basis:${(x.cost / B * 100).toFixed(1)}%;background:${COLORS[i % COLORS.length]}"></i>`).join("");
  $("legend").innerHTML = rows.map((x, i) => `<span style="--c:${COLORS[i % COLORS.length]}"><button type="button" data-open="a${x.s.code}">${esc(x.s.name)}</button> ${(x.cost / B * 100).toFixed(0)}%</span>`).join("") + `<span style="--c:var(--line)">現金 ${((B - used) / B * 100).toFixed(0)}%</span>`;

  const ac = $("allocCards"); ac.innerHTML = "";
  if (!rows.length) ac.innerHTML = `<div class="empty">${allSizes() ? "預算太低，連一股都買不到。試著把預算調到 1,000 元以上。" : `在你選的規模（${state.sizes.map(k => SIZENAME[k]).join("、")}）裡，預算內挑不到符合條件的股票。試著多選幾種規模或提高預算。`}</div>`;
  else if (state.groups.length) {
    state.groups.forEach(g => { const got = rows.filter(x => x.g === g.k); if (!got.length) return;
      const sec = document.createElement("section"); sec.className = "ind"; const amt = got.reduce((a, x) => a + x.cost, 0);
      sec.innerHTML = `<div class="ind-h"><h3>${esc(gLabel(g.k))}</h3><span class="cnt">${got.length} 檔 · ${money(amt)}（${(amt / B * 100).toFixed(0)}%）</span></div><div class="ind-list"></div>`;
      got.forEach(x => { const r = stockRow(x.s, rows); r.id = "a" + x.s.code; sec.querySelector(".ind-list").appendChild(r); }); ac.appendChild(sec); });
  } else { const box = document.createElement("div"); box.className = "ind-list"; rows.forEach(x => { const r = stockRow(x.s, rows); r.id = "a" + x.s.code; box.appendChild(r); }); ac.appendChild(box); }
  renderGroupPick(rows);
  $("condSummary").innerHTML = `目前條件<br>預算 <b>${money(B)}</b><br>持有 <b>${daysText(d)}</b>（${h === "short" ? "波段" : "長期"}）<br>風險 <b>${{1: "保守", 2: "穩健", 3: "積極"}[state.r]}</b> · ${isLot() ? "整張" : "可零股"}<br>規模 <b>${allSizes() ? "不限" : state.sizes.map(k => SIZENAME[k]).join("、")}</b> · 配置 <b>${rows.length}</b> 檔<br>${state.groups.length ? `類別 <b>${state.groups.map(g => esc(gLabel(g.k))).join("、")}</b><br>` : "類別 <b>系統全市場挑選</b><br>"}<a href="#alloc" data-view="alloc">修改條件</a>`;

  const all = filtered();
  const counts = {}; all.forEach(s => { const k = groupKey(s); if (k) counts[k] = (counts[k] || 0) + 1; });
  let keys = Object.keys(counts);
  if (state.group === "theme") keys.sort((a, b) => Object.keys(DB.themes).indexOf(a) - Object.keys(DB.themes).indexOf(b));
  else keys.sort((a, b) => counts[b] - counts[a]);
  if (state.chip !== "all" && !keys.includes(state.chip)) state.chip = "all";
  $("indChips").innerHTML = `<button type="button" data-chip="all" aria-pressed="${state.chip === "all"}">全部 ${all.length}</button>` + keys.map(k => `<button type="button" data-chip="${esc(k)}" aria-pressed="${state.chip === k}">${esc(groupName(k))} ${counts[k]}</button>`).join("");
  const flat = []; (state.chip === "all" ? keys : [state.chip]).forEach(k => all.filter(s => groupKey(s) === k).sort(sorters[state.sort]).forEach(s => flat.push(s)));
  const pages = Math.max(1, Math.ceil(flat.length / state.per)); state.page = Math.min(Math.max(1, state.page), pages);
  const items = flat.slice((state.page - 1) * state.per, state.page * state.per);
  const totalRec = S.filter(isRec).length;
  $("listTitle").textContent = `推薦清單：${flat.length} 檔`;
  $("listSub").textContent = `全市場 ${S.length} 檔中，${h === "short" ? "波段" : "長期"}評分 2 分以上、成交量足夠的有 ${totalRec} 檔。` + (state.group === "theme" ? `依題材分組只列出已歸類題材的股票，切到「依官方產業」可看全市場。` : `依證交所／櫃買官方產業分組。`) + ` 點 ☆ 加入自選股。`;
  const g = $("groups"); g.innerHTML = "";
  if (!items.length) g.innerHTML = `<div class="empty">沒有符合條件的標的。試著放寬篩選，或清除搜尋。</div>`;
  let cur = null, box = null;
  items.forEach(s => {
    const k = groupKey(s);
    if (k !== cur) {
      cur = k; const th = state.group === "theme" ? DB.themes[k] : null;
      const sec = document.createElement("section"); sec.className = "ind";
      sec.innerHTML = `<div class="ind-h"><h3>${esc(groupName(k))}</h3><span class="cnt">${counts[k]} 檔</span></div>${th ? `<p class="ind-thesis">${esc(th.t)}${th.s?.length ? " " + th.s.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${esc(t)}</a>`).join("、") : ""}</p>` : ""}<div class="ind-list"></div>`;
      g.appendChild(sec); box = sec.querySelector(".ind-list");
    }
    box.appendChild(stockRow(s, rows));
  });
  const ph = pagerHTML(flat.length, pages); $("pagerTop").innerHTML = ph; $("pagerBot").innerHTML = ph;
  renderMine();
  if (view === "etf") renderETF();
  if (view === "forecast" && FC) renderForecast();
  saveUI();
  if (lastAnalysis) lastAnalysis();
}

/* ---------------- my holdings & watchlist ---------------- */
function renderMine() {
  const hl = $("holdList");
  if (!holdings.length) hl.innerHTML = `<p class="status">還沒有持股。輸入代號、成本和股數加入後，這裡會依你的持有時間顯示停損與停利。${user ? "" : "未登入時只存在這台瀏覽器。"}</p>`;
  else {
    const tr = holdings.map(hd => {
      const s = BY[hd.code]; if (!s) return `<tr><td>${esc(hd.code)}</td><td colspan="7">資料庫找不到這個代號</td><td><button type="button" class="linkbtn" data-delhold="${hd.id}">刪除</button></td></tr>`;
      const e = exitFor(s, +hd.cost), pl = (s.price - hd.cost) / hd.cost;
      const net = (s.price * (1 - (s.etf ? .001 : .003) - .001425) - hd.cost * 1.001425) * hd.qty;
      const sig = s.price <= e.stop ? `<span class="sig exit">跌破停損 ${fmt(e.stop)}</span>` : s.price >= e.tp ? `<span class="sig tp">已達${e.tpName} ${fmt(e.tp)}</span>` : `<span class="sig hold">持有中</span>`;
      return `<tr><td><button type="button" class="linkbtn" data-go="${s.code}">${s.code} ${esc(s.name)}</button></td><td class="num">${fmt(hd.qty)}</td><td class="num">${fmt(hd.cost)}</td><td class="num">${fmt(s.price)}</td><td class="num ${pl >= 0 ? "up" : "down"}">${(pl * 100).toFixed(1)}%</td><td class="num ${net >= 0 ? "up" : "down"}">${money(net)}</td><td class="num">${fmt(e.stop)} / ${fmt(e.tp)}</td><td>${sig}</td><td><button type="button" class="linkbtn" data-delhold="${hd.id}">刪除</button></td></tr>`;
    }).join("");
    hl.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>股票</th><th>股數</th><th>成本</th><th>收盤</th><th>報酬</th><th>扣稅費損益</th><th>停損 / 停利</th><th>訊號</th><th></th></tr></thead><tbody>${tr}</tbody></table></div>`;
  }
  const wm = $("watchMine"); wm.innerHTML = "";
  const ws = [...watch].map(c => BY[c]).filter(Boolean);
  if (!ws.length) { wm.innerHTML = `<p class="status">在推薦清單點 ☆ 就會出現在這裡。</p>`; return; }
  const box = document.createElement("div"); box.className = "ind-list";
  ws.forEach(s => { const r = stockRow(s, ROWS); r.id = "w" + s.code; box.appendChild(r); });
  wm.appendChild(box);
}

/* ---------------- analyzer ---------------- */
let lastAnalysis = null;
function analyze(q, price) {
  const out = $("anOut"); q = q.trim();
  const s = BY[q.toUpperCase()] || S.find(x => x.name === q) || S.find(x => x.name.includes(q));
  if (!q) { out.innerHTML = ""; lastAnalysis = null; return; }
  if (!s) { out.innerHTML = `<p class="status">找不到「${esc(q)}」。這裡只收上市櫃普通股與常見 ETF，興櫃、權證不在資料庫。</p>`; lastAnalysis = null; return; }
  lastAnalysis = () => { out.innerHTML = `<div class="ind-h"><h3><code style="font:600 14px var(--f-data);color:var(--muted);margin-right:6px">${s.code}</code>${esc(s.name)}</h3><span class="s-price">${fmt(price || s.price)}</span></div>` + stockBody(s, {price: price || null, row: ROWS.find(r => r.s === s)}); attachAll(out); };
  lastAnalysis();
}

function goTo(code) {
  const s = BY[code]; if (!s) return;
  if (!isRec(s)) { show("analyze"); $("aCode").value = code; analyze(code, 0); return; }
  state.q = ""; state.mkt = "all"; state.size = "all"; state.afford = "all";
  if (state.group === "theme" && !s.themes.length) state.group = "ind";
  state.chip = groupKey(s);
  const list = filtered().filter(x => groupKey(x) === state.chip).sort(sorters[state.sort]);
  state.page = Math.floor(Math.max(0, list.indexOf(s)) / state.per) + 1;
  show("list", false); render();
  const el = $("s" + code); if (el) { el.open = true; el.scrollIntoView({behavior: "smooth", block: "center"}); }
}

/* ---------------- 明日走向 ---------------- */
let FC = null, fcLoading = null;
function loadFC(bust) { if (!fcLoading || bust) fcLoading = dataFetch("forecast.json", bust).catch(() => null).then(j => FC = j); return fcLoading; }
const fcLabel = p => p >= 56 ? ["偏多", "up"] : p <= 44 ? ["偏空", "down"] : ["震盪", "mid"];
const fcRow = c => { const r = FC?.stocks?.[c]; return r ? Object.fromEntries(FC.fields.map((f, i) => [f, r[i]])) : null; };
const WEEK = "日一二三四五六";
const dayTxt = iso => iso ? `${+iso.slice(5, 7)}/${+iso.slice(8)}（週${WEEK[new Date(iso + "T00:00:00+08:00").getDay()]}）` : "";
const fbar = v => `<span class="fbar"><i class="${v >= 0 ? "pos" : "neg"}" style="${v >= 0 ? "left:50%" : `right:50%`};width:${Math.min(50, Math.abs(v) * 50)}%"></i></span>`;
const yfq = sym => `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`;
function sparkSVG(series, w = 220, h = 56) {
  const v = series.map(x => x[1]); if (v.length < 3) return "";
  const lo = Math.min(...v), hi = Math.max(...v), X = i => i / (v.length - 1) * w, Y = y => 4 + (hi - y) / ((hi - lo) || 1) * (h - 8);
  const up = v[v.length - 1] >= v[0];
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" aria-hidden="true"><path d="${v.map((y, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(y).toFixed(1)).join("")}" fill="none" stroke="${up ? "var(--up)" : "var(--down)"}" stroke-width="1.6"/></svg>`;
}
function fcMarketHTML() {
  const M = FC.market, [lb, cl] = fcLabel(M.prob), tx = M.taiex || {}, f = M.f || {};
  const usTxt = (M.us || []).map(([sym, nm, d, c, p]) => `${A(esc(nm), yfq(sym))} <b class="${p > 0 ? "up" : p < 0 ? "down" : ""}">${pct(p)}</b><small>${d.slice(5)}</small>`).join("、");
  const pos = (M.news || []).filter(x => x[4] > 0).length, neg = (M.news || []).filter(x => x[4] < 0).length;
  const rows = [
    ["美股與費半", .35, f.us, `${FC.basis === "pre" ? "昨晚美股收盤" : "美股期貨盤前"}：${usTxt || "暫時抓不到"}`],
    ["加權指數線形", .20, f.trend, tx.close ? `收盤 ${fmt(tx.close)}（${tx.chg >= 0 ? "+" : ""}${fmt(tx.chg)} 點），${tx.close > tx.ma5 ? "站上" : "跌破"} 5 日均線 ${fmt(Math.round(tx.ma5))}、${tx.close > tx.ma20 ? "站上" : "跌破"} 20 日均線 ${fmt(Math.round(tx.ma20))}；近 5 日 ${pct(tx.ch5)}，RSI ${tx.rsi}${tx.rsi >= 75 ? "（過熱）" : tx.rsi <= 30 ? "（超賣）" : ""}。${A("證交所大盤資料", "https://www.twse.com.tw/zh/trading/historical/fmtqik.html")}` : "暫無資料"],
    ["漲跌家數", .15, f.breadth, `今天上漲 ${M.up} 家、下跌 ${M.down} 家（不含 ETF）。`],
    ["三大法人合計", .15, f.flow, `全部個股合計${M.inst >= 0 ? "買" : "賣"}超 ${fmt(Math.abs(M.inst))} 張。${A("證交所三大法人", "https://www.twse.com.tw/zh/trading/foreign/t86.html")}`],
    ["市場新聞", .15, f.news, `近 36 小時 ${(M.news || []).length} 則：偏正面 ${pos}、偏負面 ${neg}。`]];
  const newsList = (M.news || []).slice(0, 6).map(([t, src, d, u, tn]) => `<li><span class="nd">${d.slice(5)}</span>${A(esc(t), u)}<span class="ns">${esc(src)}</span>${TONE[tn] || ""}</li>`).join("");
  return `<div class="fcm">
    <div class="fcm-gauge ${cl}"><span class="lbl">大盤 ${dayTxt(FC.target)}</span><strong>${M.prob}<small>%</small></strong><span class="fcl">上漲機率・${lb}</span>${tx.series ? sparkSVG(tx.series) : ""}<span class="hint" style="margin:0">${FC.basis === "pre" ? "開盤前版本：已含昨晚美股收盤與夜間新聞" : "收盤後版本：明早 08:00 前會用美股收盤再更新"}・產生於 ${esc((FC.generated || "").replace("T", " ").slice(5, 16))}</span></div>
    <div class="fcm-f"><table class="ftbl"><tbody>${rows.map(([n, w, v, t]) => `<tr><th>${n}<small>權重 ${Math.round(w * 100)}%</small></th><td>${fbar(v || 0)}</td><td>${t}</td></tr>`).join("")}</tbody></table>
    ${newsList ? `<details class="fcnews"><summary>看市場新聞標題</summary><ul class="newslist">${newsList}</ul></details>` : ""}</div></div>`;
}
function fcExplain(s, r) {
  const M = FC.market, beta = Math.max(.5, Math.min(1.6, (s.sd || 1.5) / 1.5)), us = Object.fromEntries((M.us || []).map(x => [x[0], x]));
  const semi = s.ind === "半導體業" || s.themes.some(t => ["semi", "icdesign", "memory", "ai_server", "cpo"].includes(t));
  const prev = s.price - (s.chg || 0), pc = prev ? (s.chg || 0) / prev * 100 : 0;
  const out = [];
  out.push(["大盤連動", .35, r.mkt, `大盤上漲機率 ${M.prob}%；這檔近 60 日每天平均波動 ${s.sd ?? "—"}%，跟大盤的連動約 ${beta.toFixed(1)} 倍。${semi && FC.basis === "pre" && us["^SOX"] ? `半導體相關另參考費半 ${pct(us["^SOX"][4])}${us.TSM ? `、台積電 ADR ${pct(us.TSM[4])}` : ""}。` : ""}`]);
  const t = [];
  if (s.ma5) t.push(`收盤 ${fmt(s.price)} ${s.price > s.ma5 ? "站上" : "跌破"} 5 日均線 ${fmt(s.ma5)}`);
  if (s.ma20) t.push(`${s.price > s.ma20 ? "在" : "跌破"} 20 日均線 ${fmt(s.ma20)}${s.price > s.ma20 ? " 之上" : ""}`);
  if (s.rsi != null) t.push(`RSI ${s.rsi}${s.rsi > 72 ? "（偏熱，容易拉回）" : s.rsi < 30 ? "（超賣，可能反彈）" : ""}`);
  if (Math.abs(pc) >= 9) t.push(pc > 0 ? "今天漲停或接近漲停，隔天常有慣性" : "今天跌停或接近跌停");
  out.push(["個股線形", .25, r.tech, t.join("，") + `。${A("Yahoo 技術分析", yahooQ(s, "technical-analysis"))}`]);
  out.push(["法人動向", .20, r.flow, s.inst != null ? `三大法人今天${s.inst >= 0 ? "買" : "賣"}超 ${fmt(Math.abs(s.inst))} 張${s.vol ? `（占成交量 ${Math.abs(Math.round(s.inst / s.vol * 100))}%）` : ""}，近 5 日 ${lots(s.f5)}。${A("Yahoo 法人買賣", yahooQ(s, "institutional-trading"))}` : "沒有法人資料"]);
  const c = [];
  if (s.ls != null) c.push(`借券賣出 ${fmt(s.ls)} 張${s.ls20 ? `（20 日平均 ${fmt(s.ls20)}）` : ""}`);
  if (s.lbCh5) c.push(`借券餘額 5 日 ${s.lbCh5 > 0 ? "+" : ""}${fmt(s.lbCh5)} 張`);
  if (s.sbCh5) c.push(`融券 5 日 ${s.sbCh5 > 0 ? "+" : ""}${fmt(s.sbCh5)} 張`);
  if (s.mbCh5) c.push(`融資 5 日 ${s.mbCh5 > 0 ? "+" : ""}${fmt(s.mbCh5)} 張`);
  out.push(["籌碼賣壓", .10, r.chip, (c.length ? c.join("、") + (r.chip < 0 ? "，有放空或籌碼轉亂的跡象" : "，沒有明顯異常") : "沒有融資券或借券資料") + `。${A("Yahoo 資券變化", yahooQ(s, "margin"))}・${A("Yahoo 主力進出", yahooQ(s, "broker-trading"))}`]);
  const its = (NEWS?.news?.[s.code] || []).filter(x => x[2] >= isoAgo(2));
  out.push(["新聞", .10, r.news, its.length ? `近兩天 ${its.length} 則（偏正面 ${r.npos}、偏負面 ${r.nneg}）：${its.slice(0, 3).map(x => A(esc(x[0]), x[3])).join("；")}` : `近兩天沒有相關新聞。${A("Google 新聞", googleNews(s))}`]);
  return out;
}
function fcDetailHTML(s) {
  const r = fcRow(s.code);
  if (!r) return `<div class="fcd"><p class="status">${esc(s.code)} ${esc(s.name)} 沒有明日走向：${s.et === "槓桿反向" ? "槓桿反向 ETF 不計算。" : "當日成交量不到 200 張，資料不足以判斷短線方向。"}</p></div>`;
  const [lb, cl] = fcLabel(r.prob);
  return `<div class="fcd"><div class="fcd-h"><div><code>${s.code}</code> <b>${esc(s.name)}</b> <span class="s-price">${fmt(s.price)}</span> <span class="${s.chg > 0 ? "up" : s.chg < 0 ? "down" : ""}">${s.chg > 0 ? "+" : ""}${fmt(s.chg)}</span></div><div class="fcd-p ${cl}"><strong>${r.prob}%</strong><span>${dayTxt(FC.target)} 上漲機率・${lb}</span></div></div>
    <table class="ftbl"><tbody>${fcExplain(s, r).map(([n, w, v, t]) => `<tr><th>${n}<small>權重 ${Math.round(w * 100)}%</small></th><td>${fbar(v || 0)}</td><td>${t}</td></tr>`).join("")}</tbody></table>
    <p class="hint">條狀圖往右是偏多、往左是偏空。<button type="button" class="linkbtn" data-an="${s.code}">看 ${esc(s.name)} 完整分析與進出場價 →</button></p></div>`;
}
function renderForecast() {
  if (!DB) return;
  if (!FC) { $("fcMarket").innerHTML = `<p class="status">載入明日走向中…</p>`; loadFC().then(() => { if (FC) Promise.resolve(loadNews()).then(renderForecast); else $("fcMarket").innerHTML = `<p class="status">明日走向資料還沒產生（每天收盤後 21:30 與開盤前 08:00 更新）。</p>`; }); return; }
  if (!NEWS) { loadNews().then(renderForecast); }
  $("fcScope").value = state.fcScope || "rec";
  $("fcMarket").innerHTML = fcMarketHTML();
  const q = ($("fcQ").value || "").trim();
  const hit = q ? (BY[q.toUpperCase()] || S.find(x => x.name === q) || S.find(x => x.name.includes(q))) : null;
  $("fcDetail").innerHTML = q ? (hit ? fcDetailHTML(hit) : `<p class="status">找不到「${esc(q)}」。</p>`) : "";
  const sc = state.fcScope || "rec", mine = new Set([...watch, ...holdings.map(h => h.code)]);
  const codes = Object.keys(FC.stocks).filter(c => BY[c] && (sc === "all" ? !BY[c].etf : sc === "etf" ? BY[c].etf : sc === "watch" ? mine.has(c) : isRec(BY[c]) && !BY[c].etf));
  const rows = codes.map(c => [BY[c], fcRow(c)]).sort((x, y) => y[1].prob - x[1].prob);
  const item = ([s, r]) => { const [lb, cl] = fcLabel(r.prob); const top = fcExplain(s, r).slice(0, 5).sort((x, y) => Math.abs(y[2] * y[1]) - Math.abs(x[2] * x[1]))[0];
    return `<button type="button" class="fcrow" data-fc="${s.code}"><span class="fr-n"><code>${s.code}</code>${esc(s.name)}</span><span class="fr-p">${fmt(s.price)}</span><span class="fr-b ${cl}"><i style="width:${r.prob}%"></i></span><span class="fr-v ${cl}">${r.prob}%</span><span class="fr-w">${esc(top[0])}${top[2] >= 0 ? "偏多" : "偏空"}</span></button>`; };
  const bull = rows.filter(x => x[1].prob >= 56).slice(0, 15), bear = rows.filter(x => x[1].prob <= 44).reverse().slice(0, 15);
  const scName = {rec: "推薦清單", all: "全部個股", watch: "自選股與持股", etf: "ETF"}[sc];
  $("fcLists").innerHTML = sc === "watch" && !mine.size ? `<p class="status">還沒有自選股或持股。到推薦清單點 ☆，或在「我的持股」加入。</p>`
    : `<p class="hint">${scName}中有明日走向的共 ${rows.length} 檔：偏多 ${rows.filter(x => x[1].prob >= 56).length}、震盪 ${rows.filter(x => x[1].prob > 44 && x[1].prob < 56).length}、偏空 ${rows.filter(x => x[1].prob <= 44).length}。點任一檔看原因。</p>
      <div class="fclists"><section><h3 class="minor up">最偏多</h3>${bull.map(item).join("") || `<p class="status">沒有偏多的標的。</p>`}</section><section><h3 class="minor down">最偏空</h3>${bear.map(item).join("") || `<p class="status">沒有偏空的標的。</p>`}</section></div>
      ${sc === "watch" ? `<section><h3 class="minor">全部</h3>${rows.map(item).join("")}</section>` : ""}`;
  const T = FC.track || {}, rate = x => x && x[1] ? `${x[0]}/${x[1]}（${Math.round(x[0] / x[1] * 100)}%）` : "還沒有足夠紀錄";
  const rec = (T.recent || []).filter(x => x[2] != null || x[4]);
  $("fcTrack").innerHTML = `<div class="track"><h3 class="minor">過去命中率</h3>
    <p>大盤方向：<b>${rate(T.mkt)}</b>・個股（只算判斷偏多或偏空的）：<b>${rate(T.stk)}</b>・信心較高（≥62% 或 ≤38%）：<b>${rate(T.strong)}</b></p>
    ${rec.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>日期</th><th class="num">大盤預估</th><th class="num">大盤實際</th><th class="num">個股命中</th></tr></thead><tbody>${rec.slice().reverse().map(([d, mp, ma, h, n]) => `<tr><td>${dayTxt(d)}</td><td class="num">${mp ?? "—"}%</td><td class="num ${ma > 0 ? "up" : ma < 0 ? "down" : ""}">${ma == null ? "—" : pct(ma)}</td><td class="num">${n ? `${h}/${n}（${Math.round(h / n * 100)}%）` : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<p class="hint">命中率從 ${dayTxt(FC.target)} 開始記錄，累積幾個交易日後這裡會顯示每天的對錯。</p>`}
    <p class="hint">怎麼算：大盤看美股（35%）、加權指數線形（20%）、漲跌家數（15%）、法人合計（15%）、新聞（15%）。個股看大盤連動（35%）、個股線形（25%）、法人（20%）、借券與融資券賣壓（10%）、近兩天新聞（10%）。機率限制在 25%–75%，因為短線本來就很難預測；50% 附近代表沒有明顯方向。這只是規則計分，不是保證，請搭配自己的判斷。</p></div>`;
}

/* ---------------- ETF 專區 ---------------- */
const ETF_TYPES = ["國內股票", "國外股票", "主動式", "債券", "槓桿反向", "商品期貨", "其他"];
function etfRow(s) {
  const e = ETFI.etf[s.code] || {}, on = watch.has(s.code);
  const d = document.createElement("details"); d.className = "stock etfrow"; d.id = "e" + s.code;
  const ret = e.ret?.["1y"] ?? e.ret?.["6m"] ?? e.ret?.["3m"];
  d.innerHTML = `<summary><button type="button" class="star" data-star="${s.code}" aria-pressed="${on}" aria-label="${on ? "移出" : "加入"}自選股">${on ? "★" : "☆"}</button><span class="s-name"><code>${s.code}</code>${esc(s.name)}<small>${esc(s.et)}</small></span><span class="s-price">${fmt(s.price)}<small class="${s.chg > 0 ? "up" : s.chg < 0 ? "down" : ""}">${s.chg > 0 ? "+" : ""}${fmt(s.chg)}</small></span><span class="e-k"><small>規模</small>${yiAum(e.aum)}</span><span class="e-k"><small>殖利率</small>${e.yld != null ? e.yld + "%" : "—"}</span><span class="e-k"><small>${e.ret?.["1y"] != null ? "近 1 年" : e.ret?.["6m"] != null ? "近 6 月" : "近 3 月"}</small><b class="${ret > 0 ? "up" : ret < 0 ? "down" : ""}">${ret != null ? pct(ret) : "—"}</b></span><span class="e-top">${esc((e.top || []).slice(0, 3).map(x => `${x[1]} ${x[2]}%`).join("、") || (e.idx || ""))}</span></summary><div class="body"></div>`;
  d.addEventListener("toggle", () => { if (d.open) { const b = d.querySelector(".body"); b.innerHTML = stockBody(s, {row: ROWS.find(r => r.s === s)}); attachAll(b); } });
  return d;
}
function renderETF() {
  if (!DB) return;
  const all = S.filter(s => s.etf), t = state.etfType || "all", q = (state.etfQ || "").trim().toLowerCase();
  const cnt = {}; all.forEach(s => cnt[s.et] = (cnt[s.et] || 0) + 1);
  $("etfTypes").innerHTML = `<button type="button" data-et="all" aria-pressed="${t === "all"}">全部 ${all.length}</button>` + ETF_TYPES.filter(k => cnt[k]).map(k => `<button type="button" data-et="${k}" aria-pressed="${t === k}">${k} ${cnt[k]}</button>`).join("");
  let list = all.filter(s => t === "all" || s.et === t);
  if (q) list = list.filter(s => { const e = ETFI.etf[s.code] || {}; return s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || (e.idx || "").toLowerCase().includes(q) || (e.issuer || "").includes(q) || (e.top || []).some(x => (x[1] || "").toLowerCase().includes(q) || x[0] === q); });
  const E = c => ETFI.etf[c] || {};
  const so = {aum: (x, y) => (E(y.code).aum || 0) - (E(x.code).aum || 0), vol: (x, y) => (y.vol || 0) - (x.vol || 0), yld: (x, y) => (E(y.code).yld ?? -1) - (E(x.code).yld ?? -1),
    ret1y: (x, y) => (E(y.code).ret?.["1y"] ?? -999) - (E(x.code).ret?.["1y"] ?? -999), fee: (x, y) => (parseFloat(E(x.code).fee) || 9) - (parseFloat(E(y.code).fee) || 9),
    new: (x, y) => (E(y.code).inc || "").localeCompare(E(x.code).inc || "")}[state.etfSort || "aum"];
  list.sort(so);
  $("etfSort").value = state.etfSort || "aum"; if (document.activeElement !== $("etfQ")) $("etfQ").value = state.etfQ || "";
  const per = 20, pages = Math.max(1, Math.ceil(list.length / per)); state.etfPage = Math.min(Math.max(1, state.etfPage || 1), pages);
  const p = state.etfPage, pg = `<span class="info">第 ${list.length ? (p - 1) * per + 1 : 0}–${Math.min(list.length, p * per)} 檔，共 ${list.length} 檔</span><div class="pages"><button type="button" data-ep="${p - 1}" ${p <= 1 ? "disabled" : ""}>上一頁</button><span class="info">${p} / ${pages}</span><button type="button" data-ep="${p + 1}" ${p >= pages ? "disabled" : ""}>下一頁</button></div>`;
  $("etfPagerTop").innerHTML = pg; $("etfPagerBot").innerHTML = pg;
  const box = $("etfList"); box.innerHTML = "";
  if (!list.length) box.innerHTML = `<div class="empty">沒有符合的 ETF。</div>`;
  const wrap = document.createElement("div"); wrap.className = "ind-list"; list.slice((p - 1) * per, p * per).forEach(s => wrap.appendChild(etfRow(s))); box.appendChild(wrap);
  $("etfSub").textContent = `上市櫃全部 ${all.length} 檔 ETF：前十大持股、產業配置、規模、費用、配息與績效${ETFI.generated ? `（持股資料更新 ${ETFI.generated.slice(0, 10)}）` : ""}。搜尋可以打持股名稱，例如「台積電」找出持有它的 ETF。`;
}

/* ---------------- views ---------------- */
const VIEWS = ["alloc", "list", "analyze", "forecast", "etf", "mine", "account", "help"];
let view = "alloc";
function show(v, scroll = true) {
  if (!VIEWS.includes(v)) v = "alloc";
  view = v;
  VIEWS.forEach(k => { $("view-" + k).hidden = k !== v; });
  document.querySelectorAll("#menu a").forEach(a => { if (a.dataset.view === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
  document.title = $("view-" + v).dataset.title + "｜股票分析網";
  if (v === "forecast") renderForecast();
  if (v === "etf") renderETF();
  if (scroll) window.scrollTo({top: 0});
}

/* ---------------- persistence ---------------- */
let prefTimer = null;
function saveUI() {
  local.set("picker-ui", state);
  if (user && sb) { clearTimeout(prefTimer); prefTimer = setTimeout(async () => {
    const row = {user_id: user.id, budget: state.budget, t_num: state.tNum, t_unit: state.tUnit, risk: state.r, n_pick: state.n, updated_at: new Date().toISOString()};
    saveUI.missing = saveUI.missing || new Set();
    if (!saveUI.missing.has("groups")) row.groups = state.groups;
    if (!saveUI.missing.has("unit")) row.unit = state.unit;
    if (!saveUI.missing.has("sizes")) row.sizes = state.sizes;
    let {error} = await sb.from("user_settings").upsert(row);
    for (let i = 0; i < 3 && error; i++) {   // 舊資料表還沒有新欄位時，拿掉該欄位再存
      const col = ["groups", "unit", "sizes"].find(c => (error.message || "").includes(c) && c in row);
      if (!col) break; saveUI.missing.add(col); delete row[col]; ({error} = await sb.from("user_settings").upsert(row));
    }
    if (error) console.warn(error);
  }, 800); }
}
async function loadUserData() {
  if (!user) { holdings = local.get("picker-holdings", []); watch = new Set(local.get("picker-watch", [])); return; }
  const [st, hd, wl] = await Promise.all([
    sb.from("user_settings").select("*").eq("user_id", user.id).maybeSingle(),
    sb.from("holdings").select("*").order("created_at"),
    sb.from("watchlist").select("code")
  ]);
  if (st.data) { Object.assign(state, {budget: +st.data.budget, tNum: +st.data.t_num, tUnit: +st.data.t_unit, r: +st.data.risk, n: +st.data.n_pick}); if (Array.isArray(st.data.groups)) state.groups = st.data.groups; if (st.data.unit === "lot" || st.data.unit === "odd") state.unit = st.data.unit; if (Array.isArray(st.data.sizes) && st.data.sizes.length) state.sizes = st.data.sizes; }
  holdings = hd.data || []; watch = new Set((wl.data || []).map(x => x.code));
  // 第一次登入：把這台瀏覽器的訪客資料搬上去
  const gh = local.get("picker-holdings", []), gw = local.get("picker-watch", []);
  if (!holdings.length && gh.length) { const {data} = await sb.from("holdings").insert(gh.map(x => ({user_id: user.id, code: x.code, cost: x.cost, qty: x.qty}))).select(); holdings = data || []; local.set("picker-holdings", []); }
  const newW = gw.filter(c => !watch.has(c)); if (newW.length) { await sb.from("watchlist").insert(newW.map(c => ({user_id: user.id, code: c}))); newW.forEach(c => watch.add(c)); local.set("picker-watch", []); }
}
async function addHolding(code, cost, qty) {
  if (user) { const {data, error} = await sb.from("holdings").insert({user_id: user.id, code, cost, qty}).select().single(); if (error) throw error; holdings.push(data); }
  else { holdings.push({id: "g" + Date.now(), code, cost, qty}); local.set("picker-holdings", holdings); }
}
async function delHolding(id) {
  if (user) { const {error} = await sb.from("holdings").delete().eq("id", id); if (error) throw error; }
  holdings = holdings.filter(h => String(h.id) !== String(id)); if (!user) local.set("picker-holdings", holdings);
}
async function toggleWatch(code) {
  const on = !watch.has(code);
  if (user) { const q = on ? sb.from("watchlist").insert({user_id: user.id, code}) : sb.from("watchlist").delete().eq("code", code); const {error} = await q; if (error) throw error; }
  on ? watch.add(code) : watch.delete(code);
  if (!user) local.set("picker-watch", [...watch]);
}

/* ---------------- account UI ---------------- */
function accountUI(msg = "", err = false) {
  const el = $("account");
  $("navUser").textContent = user ? "已登入 " + user.email : (sb ? "未登入，資料存在這台瀏覽器" : "未設定");
  $("mineSub").textContent = "每筆持股依你的成本與持有時間計算停損與停利，看是否已經碰到出場條件。" + (user ? "資料已同步到你的帳號。" : "目前未登入，資料只存在這台瀏覽器；到「帳號」登入就能跨裝置同步。");
  if (!sb) { el.innerHTML = `<span class="lbl">帳號</span><p class="msg">帳號功能尚未設定（config.js 缺少 Supabase 設定）。資料先存在這台瀏覽器。</p>`; return; }
  if (user) { el.innerHTML = `<span class="lbl">帳號</span><div class="who">已登入：<b>${esc(user.email)}</b></div><p class="msg">設定、持股、自選股會同步到你的帳號，其他人看不到。</p><div class="row"><button type="button" class="btn ghost small" id="signOut">登出</button></div>`; return; }
  el.innerHTML = `<span class="lbl">帳號</span>
    <form id="authForm" class="row" style="flex-direction:column;gap:6px">
      <input id="authEmail" type="email" placeholder="Email" autocomplete="email" required>
      <input id="authPw" type="password" placeholder="密碼（至少 6 碼）" autocomplete="current-password" minlength="6" required>
      <div class="row"><button class="btn small" type="submit" data-act="in">登入</button><button class="btn ghost small" type="submit" data-act="up">註冊</button></div>
    </form>
    <button type="button" class="linkbtn" id="forgot">忘記密碼</button>
    <p class="msg ${err ? "err" : ""}" id="authMsg">${esc(msg) || "登入後，每個人的設定、持股、自選股分開存。沒登入也能用，資料只存在這台瀏覽器。"}</p>`;
}
const AUTH_ERR = {"Invalid login credentials": "Email 或密碼不對。", "User already registered": "這個 Email 已經註冊過，請直接登入。", "Email not confirmed": "請先到信箱點確認連結，再回來登入。"};

/* ---------------- method text ---------------- */
function methodHTML() {
  return `<ul>
  <li><b>資料</b>：證交所與櫃買中心官方 OpenAPI 的收盤價、本益比、殖利率、股價淨值比、月營收（本月、上月、去年同月、今年累計）、最新一期綜合損益表（營收、毛利、營業利益、稅後淨利、EPS）、公司基本資料，以及三大法人買賣超。每個交易日收盤後由 GitHub Actions 自動更新。目前資料日期 ${DB.date}${curDate("上市") !== DB.date ? `（上市收盤價已即時更新到 ${curDate("上市")}）` : ""}，已累積 ${DB.historyDays} 天歷史。</li>
  <li><b>長期評分</b>（1–5 分）＝ 成長（月營收年增率，最高 2 分）＋ 估值（本益比和同產業中位數比，越低越高分；超過 80 倍扣分；虧損直接扣分）＋ 獲利品質（推算 ROE＝股價淨值比÷本益比）＋ 法人動向（最多 0.5 分）。記憶體是景氣循環股，估值分數最多 0.5 分；營收年增超過 300% 多半是基期太低，成長分數只給 1 分。</li>
  <li><b>波段評分</b> ＝ 三大法人近 20 日與 5 日買賣超（權重最高）＋ 近 20 日走勢（上漲但不過熱加分，20 日漲超過 25% 或 60 日漲超過 50% 扣分）＋ 成長與估值。${DB.shortMode !== "full" ? "歷史資料累積到 20 個交易日前，波段評分只用基本面估算。" : ""}</li>
  <li><b>主要風險</b>依每檔的數據逐條產生：虧損或本業虧損、業外占比、毛利率偏低、本益比與同產業比、殖利率、營收年減或月減、單月與累計成長落差、法人賣超、短線漲幅、所屬題材或產業的特有風險、成交量與市值。</li>
  <li>評分 2 分以上、當日成交量至少 200 張的股票列入推薦清單。少數標的有人工研究筆記或調整，卡片上會寫明原因。</li>
  <li><b>公司規模</b>：大型股市值 1,000 億以上、中型 200–1,000 億、小型 200 億以下。小型股流動性較差，掛單建議用限價。在「配置建議」可以複選只要大型、中型、小型股或 ETF，配置與類別看好度都只用你選的規模計算。</li>
  <li><b>上下游產業鏈</b>：取自證交所與櫃買中心合辦的「產業價值鏈資訊平台」，每週更新。卡片會列出這家公司所在的產業與環節、同環節的同業，以及上游、下游各環節的上市櫃公司（依推薦與評分排序，框線標示的是目前推薦清單裡的）。一家公司可能出現在好幾條產業鏈，可切換查看。</li>
  <li><b>配置類別與看好度</b>：每個題材（或官方產業）的看好度 0–100 ＝ 類別內前 3 檔平均評分（40%）＋ 推薦比例（20%）＋ 營收年增中位數（20%）＋ 法人買超比例（10%）＋ 近 20 日漲跌中位數（10%）。看好度 55 以上的前 4 名標「目前看好」。選了類別後，資金依你設的比例分給各類別，系統只在該類別裡挑評分高、預算買得起的股票；沒選就由系統在全市場挑。</li>
  <li><b>進出場參考價（2026/10 改版）</b>：分兩筆各 50%。第一筆用現價；第二筆設在現價下方最近的支撐（20 日均線、近 20 日低點，長期再看 60 日均線），找不到支撐就用現價下方 1.2 個「平均日波動」（近 20 日每天收盤價變動的平均）。第二筆沒回檔到就不追。</li>
  <li><b>停損</b>：波段（6 個月以內）設在近 20 日低點下方、長期設在近 60 日低點下方，再多留 0.3 個平均日波動；距離至少 1.5 個平均日波動（避免正常震盪就被洗出場），最多 15%（波段）或 25%（長期）。</li>
  <li><b>停利與重新評估價</b>：用這檔近 60 日的日報酬標準差 × √持有天數，得到持有期間的正常波動幅度。波段的停利一＝平均成本＋1 個波動幅度、停利二＝1.8 個；長期的重新評估價＝平均成本＋1 個波動幅度（至少 12%）。途中若有前波高點，卡片會提醒那裡可能有賣壓。</li>
  <li><b>短線動態與籌碼</b>：每張卡片會列出近 7 天新聞正負面、均線與 RSI、三大法人、借券賣出（法人放空的主要管道）、融資融券，以及主力分點的查詢連結；每一項都附上可以點開核對的來源。公開資料看得到賣壓從哪裡來，但無法判斷是不是有人「故意」壓低。</li>
  <li><b>明日走向</b>：大盤＝美股與費半（35%）＋加權指數均線與 RSI（20%）＋漲跌家數（15%）＋三大法人合計（15%）＋市場新聞正負面（15%）；個股＝大盤連動（35%，依個股波動放大或縮小，半導體另看費半與台積電 ADR）＋個股線形（25%）＋法人（20%）＋借券與融資券賣壓（10%）＋近兩天新聞（10%）。每天收盤後與開盤前各算一次，並公開過去的命中率。</li>
  <li><b>ETF</b>：收錄上市櫃全部 ETF，類型依證交所 ETF 基本資料與名稱判斷。前十大持股、產業配置、規模、費用、配息與績效來自 Yahoo 奇摩股市（投信每月公告的持股約落後 1–2 個月）。ETF 評分看規模、類型與走勢；槓桿反向 ETF 一律 1 分、不放進配置。</li>
  <li>所有價位依證交所升降單位取整。</li></ul>`;
}

/* ---------------- events ---------------- */
let laterT = null;
const renderLater = () => { clearTimeout(laterT); laterT = setTimeout(render, 220); };  // 欄位失焦觸發的重繪延後，讓同一下點擊先完成
function wireGroups() {
  const box = $("groupPick");
  box.addEventListener("click", e => {
    const c = e.target.closest("[data-gk]");
    if (c) { const k = c.dataset.gk, keys = state.groups.map(g => g.k); setGroups(keys.includes(k) ? keys.filter(x => x !== k) : [...keys, k]); render(); return; }
    const d = e.target.closest("[data-gdel]"); if (d) { setGroups(state.groups.map(g => g.k).filter(x => x !== d.dataset.gdel)); render(); return; }
    if (e.target.id === "gRec") { setGroups(hotKeys()); state.groups.forEach(g => g.w = Math.round(100 / state.groups.length)); render(); }
    if (e.target.id === "gEq") { state.groups.forEach(g => g.w = Math.round(100 / state.groups.length)); render(); }
    if (e.target.id === "gClear") { state.groups = []; render(); }
    if (e.target.id === "gAddBtn") { const v = $("gAdd").value; if (v && !state.groups.some(g => g.k === v)) { setGroups([...state.groups.map(g => g.k), v]); render(); } }
  });
  box.addEventListener("change", e => { const w = e.target.closest("[data-gw]"); if (w) { const g = state.groups.find(x => x.k === w.dataset.gw); if (g) { g.w = Math.max(0, Math.min(100, +w.value || 0)); renderLater(); } } });
}
function wire() {
  wireGroups();
  document.addEventListener("click", e => { const a = e.target.closest("a[data-view]"); if (a) { e.preventDefault(); show(a.dataset.view); } });
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));
  const reset = () => { state.page = 1; render(); };
  $("budget").addEventListener("change", e => { const v = +e.target.value; if (v > 0) { state.budget = v; state.page = 1; renderLater(); } });
  $("budgetChips").addEventListener("click", e => { const b = e.target.closest("button[data-b]"); if (b) { state.budget = +b.dataset.b; reset(); } });
  $("tNum").addEventListener("change", e => { const v = +e.target.value; if (v > 0) { state.tNum = v; state.page = 1; renderLater(); } });
  $("tUnit").addEventListener("change", e => { state.tUnit = +e.target.value; reset(); });
  $("timeChips").addEventListener("click", e => { const b = e.target.closest("button[data-n]"); if (b) { state.tNum = +b.dataset.n; state.tUnit = +b.dataset.u; reset(); } });
  $("risk").addEventListener("click", e => { const b = e.target.closest("button[data-v]"); if (b) { state.r = +b.dataset.v; render(); } });
  $("unit").addEventListener("click", e => { const b = e.target.closest("button[data-v]"); if (b) { state.unit = b.dataset.v; render(); } });
  $("sizes").addEventListener("click", e => { const b = e.target.closest("button[data-v]"); if (!b) return; const k = b.dataset.v, on = state.sizes.includes(k);
    if (on && state.sizes.length === 1) { $("sizeHint").textContent = "至少要選一種規模。"; return; }
    state.sizes = on ? state.sizes.filter(x => x !== k) : ["L", "M", "S", "E"].filter(x => x === k || state.sizes.includes(x)); render(); });
  $("nPick").addEventListener("change", e => { state.n = +e.target.value; render(); });
  [["fGroup", "group"], ["fMkt", "mkt"], ["fSize", "size"], ["fAfford", "afford"], ["fSort", "sort"]].forEach(([id, k]) => $(id).addEventListener("change", e => { state[k] = e.target.value; if (k === "group") state.chip = "all"; reset(); }));
  $("fPer").addEventListener("change", e => { state.per = +e.target.value; reset(); });
  let qt; $("fQ").addEventListener("input", e => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value; reset(); }, 250); });
  $("indChips").addEventListener("click", e => { const b = e.target.closest("button[data-chip]"); if (b) { state.chip = b.dataset.chip; reset(); } });
  ["pagerTop", "pagerBot"].forEach(id => $(id).addEventListener("click", e => { const b = e.target.closest("button[data-p]"); if (b && !b.disabled) { state.page = +b.dataset.p; render(); $("listTitle").scrollIntoView({behavior: "smooth", block: "start"}); } }));
  document.addEventListener("click", async e => {
    const op = e.target.closest("[data-open]"); if (op) { const el = $(op.dataset.open); if (el) { el.open = true; el.scrollIntoView({behavior: "smooth", block: "center"}); } return; }
    const an = e.target.closest("[data-an]"); if (an) { e.preventDefault(); show("analyze"); $("aCode").value = an.dataset.an; $("aPrice").value = ""; analyze(an.dataset.an, 0); return; }
    const go = e.target.closest("[data-go]"); if (go) { e.preventDefault(); goTo(go.dataset.go); return; }
    const st = e.target.closest("[data-star]");
    if (st) { e.preventDefault(); e.stopPropagation(); try { await toggleWatch(st.dataset.star); render(); } catch (err) { alertMsg("自選股沒有存成功：" + err.message); } return; }
    const dh = e.target.closest("[data-delhold]");
    if (dh) { try { await delHolding(dh.dataset.delhold); render(); } catch (err) { alertMsg("刪除失敗：" + err.message); } }
  });
  $("holdForm").addEventListener("submit", async e => {
    e.preventDefault();
    const code = $("hCode").value.trim().toUpperCase(), cost = +$("hCost").value, qty = Math.round(+$("hQty").value);
    if (!BY[code]) { alertMsg(`找不到代號 ${code}。`); return; }
    if (!(cost > 0) || !(qty > 0)) { alertMsg("請填入大於 0 的成本與股數。"); return; }
    try { await addHolding(code, cost, qty); $("holdForm").reset(); render(); } catch (err) { alertMsg("持股沒有存成功：" + err.message); }
  });
  $("fcScope").addEventListener("change", e => { state.fcScope = e.target.value; renderForecast(); saveUI(); });
  let fq; $("fcQ").addEventListener("input", () => { clearTimeout(fq); fq = setTimeout(renderForecast, 300); });
  $("fcLists").addEventListener("click", e => { const b = e.target.closest("[data-fc]"); if (b) { $("fcQ").value = b.dataset.fc; renderForecast(); $("fcDetail").scrollIntoView({behavior: "smooth", block: "start"}); } });
  $("etfTypes").addEventListener("click", e => { const b = e.target.closest("[data-et]"); if (b) { state.etfType = b.dataset.et; state.etfPage = 1; renderETF(); saveUI(); } });
  $("etfSort").addEventListener("change", e => { state.etfSort = e.target.value; state.etfPage = 1; renderETF(); saveUI(); });
  let eq; $("etfQ").addEventListener("input", e => { clearTimeout(eq); eq = setTimeout(() => { state.etfQ = e.target.value; state.etfPage = 1; renderETF(); }, 250); });
  ["etfPagerTop", "etfPagerBot"].forEach(id => $(id).addEventListener("click", e => { const b = e.target.closest("button[data-ep]"); if (b && !b.disabled) { state.etfPage = +b.dataset.ep; renderETF(); $("etfTypes").scrollIntoView({behavior: "smooth", block: "start"}); } }));
  $("anForm").addEventListener("submit", e => { e.preventDefault(); analyze($("aCode").value, +$("aPrice").value || 0); });
  $("account").addEventListener("submit", async e => {
    e.preventDefault();
    const act = e.submitter?.dataset.act || "in", email = $("authEmail").value.trim(), password = $("authPw").value;
    const {error, data} = act === "up" ? await sb.auth.signUp({email, password, options: {emailRedirectTo: location.origin + location.pathname}}) : await sb.auth.signInWithPassword({email, password});
    if (error) accountUI(AUTH_ERR[error.message] || error.message, true);
    else if (act === "up" && !data.session) accountUI("註冊成功。請到信箱點確認連結，再回來登入。");
  });
  $("account").addEventListener("click", async e => {
    if (e.target.id === "signOut") { await sb.auth.signOut(); }
    if (e.target.id === "forgot") {
      const email = $("authEmail")?.value.trim();
      if (!email) { accountUI("請先在上方填 Email，再按忘記密碼。", true); return; }
      const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo: location.origin + location.pathname});
      accountUI(error ? error.message : "重設密碼的信已寄出，請到信箱查看。", !!error);
    }
  });
}
function alertMsg(t) { const m = $("mineMsg"); m.textContent = t; m.classList.add("err"); clearTimeout(alertMsg.t); alertMsg.t = setTimeout(() => { m.textContent = ""; }, 6000); }

/* ---------------- boot ---------------- */
async function boot() {
  try { await Promise.all([loadData(), dataFetch("etf.json").then(j => { if (j && j.etf) ETFI = j; }).catch(() => {})]); }
  catch (e) { $("stamp").textContent = "資料載入失敗"; $("groups").innerHTML = `<div class="empty">${esc(e.message)}。GitHub Actions 第一次跑完後才會有資料。</div>`; return; }
  $("stamp").innerHTML = stampHTML();
  $("refreshBtn").addEventListener("click", e => doRefresh(e.currentTarget));
  const up = S.filter(s => s.chg > 0).length, dn = S.filter(s => s.chg < 0).length;
  $("market").innerHTML = `<span>上漲 <b class="up">${up}</b> 檔</span><span>下跌 <b class="down">${dn}</b> 檔</span><span>更新時間 <b>${esc(DB.generated.replace("T", " ").slice(0, 16))}</b></span><span>歷史資料 <b>${DB.historyDays}</b> 天</span>`;
  $("methodBody").innerHTML = methodHTML();
  wire();
  if (CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase) {
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    const {data} = await sb.auth.getSession(); user = data.session?.user || null;
    sb.auth.onAuthStateChange(async (_ev, session) => {
      const next = session?.user || null; if ((next?.id) === (user?.id)) return;
      user = next; await loadUserData(); accountUI(); render();
    });
  }
  await loadUserData().catch(e => console.warn(e));
  accountUI(); redrawAll(); show(location.hash.slice(1) || "alloc", false);
  // 每日資料比最近收盤日舊時，背景直接向證交所拿上市收盤價
  refreshLive(false).then(m => { if (m) { redrawAll(); if (lastAnalysis) analyze($("aCode").value, +$("aPrice").value || 0); $("refreshMsg").textContent = m + "。"; } });
}
boot();
})();
