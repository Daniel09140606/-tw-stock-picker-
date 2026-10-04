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
function levels(price, vol, etf) {
  const T = years(), m = Math.min(.45, Math.max(.03, SIG[vol] * Math.sqrt(T)));
  if (modeKey() === "short") {
    const ms = Math.min(m, .15), e1 = rnd(price * (1 - .25 * ms), etf, -1), e2 = rnd(price * (1 - .6 * ms), etf, -1), avg = (e1 + e2) / 2;
    return {mode: "short", m: ms, entries: [["第一筆（50%）", e1], ["第二筆（50%）", e2]], avg, stop: rnd(avg * (1 - ms), etf, -1), tp1: rnd(avg * (1 + 1.5 * ms), etf, 1), tp2: rnd(avg * (1 + 2.5 * ms), etf, 1)};
  }
  const ml = Math.min(m, .40), e1 = rnd(price, etf, 0), e2 = rnd(price * (1 - .5 * ml), etf, -1), e3 = rnd(price * (1 - .9 * ml), etf, -1), avg = (e1 + e2 + e3) / 3;
  return {mode: "long", m: ml, entries: [["第一筆 現價（1/3）", e1], ["第二筆 回檔（1/3）", e2], ["第三筆 深度回檔（1/3）", e3]], avg, stop: rnd(avg * (1 - Math.min(.8 * ml + .05, .35)), etf, -1), review: rnd(avg * (1 + Math.max(.2, ml)), etf, 1)};
}
function exitFor(cost, vol, etf) {
  const L = levels(cost, vol, etf);
  if (L.mode === "short") return {stop: rnd(cost * (1 - L.m), etf, -1), tp: rnd(cost * (1 + 1.5 * L.m), etf, 1), tpName: "停利一"};
  return {stop: rnd(cost * (1 - Math.min(.8 * L.m + .05, .35)), etf, -1), tp: rnd(cost * (1 + Math.max(.2, L.m)), etf, 1), tpName: "重新評估價"};
}
function sharesText(n) { const l = Math.floor(n / 1000), o = n % 1000; return ((l ? l + " 張" : "") + (l && o ? " ＋ " : "") + (o ? o + " 股" : "")) || "0 股"; }

/* ---------------- data ---------------- */
const groupKey = s => state.group === "theme" ? (s.themes[0] || null) : s.ind;
const groupName = k => state.group === "theme" ? (DB.themes[k]?.n || k) : k;
const divKey = s => s.themes[0] || s.ind;   // 配置分散用
const isRec = s => s.liq && scoreOf(s) >= 2;
const sizeOk = s => state.sizes.includes(s.size);   // 配置建議選的公司規模
const allSizes = () => ["L", "M", "S", "E"].every(k => state.sizes.includes(k));

async function loadData() {
  const r = await fetch("data/stocks.json", {cache: "no-cache"});
  if (!r.ok) throw new Error("讀不到 data/stocks.json（" + r.status + "）");
  DB = await r.json();
  S = DB.rows.map(row => { const o = {}; DB.fields.forEach((f, i) => o[f] = row[i]); o.themes = o.themes || []; o.etf = o.size === "E"; o.note = DB.notes[o.code] || {}; return o; });
  BY = Object.fromEntries(S.map(s => [s.code, s]));
  $("codeList").innerHTML = S.map(s => `<option value="${s.code}">${esc(s.name)}</option>`).join("");
}

/* ---------------- allocation ---------------- */
/* 依權重換算股數。零股模式：直接換算股數；整張模式：先按比例買整張，剩下的錢再一張一張補給離目標最遠的股票。 */
const isLot = () => state.unit === "lot";
const lotCost = s => s.price * 1000 * 1.001425;
function sizeRows(ws, B, g) {
  const rows = ws.map(({s, w}) => { const L = levels(s.price, s.volc, s.etf), unit = L.entries[0][1] * 1.001425; return {s, L, w, g, unit, shares: 0, cost: 0}; });
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
  const capOf = s => s.etf ? 1e12 : (s.cap || 0);   // 同分時 ETF 優先，其次市值大的
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
  const capOf = s => s.etf ? 1e12 : (s.cap || 0);
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
const oneLine = s => (s.note.why || autoWhy(s))[0];

/* ---------------- 最新消息（GitHub Actions 每天抓的新聞標題與重大訊息） ---------------- */
let NEWS = null, newsLoading = null;
function loadNews() { if (!newsLoading) newsLoading = fetch("data/news.json", {cache: "no-cache"}).then(r => r.ok ? r.json() : null).catch(() => null).then(j => NEWS = j || {news: {}, ann: {}, covered: []}); return newsLoading; }
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
  if (!chainLoading) chainLoading = fetch("data/chains.json", {cache: "no-cache"}).then(r => r.ok ? r.json() : null).catch(() => null).then(j => {
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

/* ---------------- rendering pieces ---------------- */
function ladderHTML(L, etf) {
  let h = L.entries.map(([k, v]) => `<tr class="en"><td>${k}</td><td>${fmt(v)}</td></tr>`).join("");
  if (L.mode === "short") h += `<tr class="tp"><td>停利二（再出 50%）</td><td>${fmt(L.tp2)}</td></tr><tr class="tp"><td>停利一（先出 50%）</td><td>${fmt(L.tp1)}</td></tr><tr class="sl"><td>停損（收盤跌破全出）</td><td>${fmt(L.stop)}</td></tr>`;
  else h += `<tr class="tp"><td>重新評估價（考慮賣 1/3）</td><td>${fmt(L.review)}</td></tr><tr class="sl"><td>最大虧損線（全出）</td><td>${fmt(L.stop)}</td></tr>`;
  const avg = fmt(+L.avg.toFixed(2)), d = daysText(days());
  const rules = L.mode === "short"
    ? `<li>持有到第 ${d} 仍沒碰到停利一，就出場。</li><li>碰到停利一後，把剩下部位的停損上移到平均成本 ${avg}。</li>`
    : `<li>${etf ? "ETF 可改為每月定期定額，不必等回檔。" : "月營收年增率連兩個月轉負：減碼一半。"}</li><li>三筆都買到時平均成本約 ${avg}；預計持有 ${d}，期滿重新評估。</li>`;
  return `<table class="ladder"><tbody>${h}</tbody></table><ul class="rules">${rules}</ul>`;
}
function stockBody(s, opts = {}) {
  const price = opts.price || s.price, L = levels(price, s.volc, s.etf), h = modeKey(), sc = scoreOf(s), x = opts.row;
  const tags = [];
  s.themes.forEach(t => tags.push(`<span class="tag">${esc(DB.themes[t]?.n || t)}</span>`));
  tags.push(`<span class="tag">${esc(s.ind)}</span>`, `<span class="tag">${s.mkt}</span>`, `<span class="tag">${SIZENAME[s.size]}${s.etf ? "" : "股"}</span>`, `<span class="tag r${s.risk}">${RISKNAME[s.risk]}</span>`, `<span class="tag">${VOLNAME[s.volc]}</span>`, `<span class="tag">${h === "short" ? "波段" : "長期"}評分 ${sc}/5</span>`);
  if (!isRec(s)) tags.push(`<span class="tag warn">不在推薦清單</span>`);
  const fit = Math.floor(state.budget / (price * 1.001425));
  const tr = h === "short" ? 2 : 3, lotsN = Math.floor((x?.shares || 0) / 1000);
  const firstTxt = !x ? "" : isLot() ? sharesText(Math.max(1, Math.floor(lotsN / tr)) * 1000) : sharesText(Math.max(1, Math.floor(x.shares / tr)));
  const lotNote = x && isLot() && lotsN < tr ? `<span class="hint" style="margin:0">只有 ${lotsN} 張，分不成 ${tr} 筆：建議先在第一筆價位買 1 張，其餘等回檔到後面的進場價再買。</span>` : "";
  const buy = x ? `<div class="buy"><span>配置 <b>${Math.round(x.w * 100)}%</b></span><span>第一筆 <b>${firstTxt}</b></span><span>全部到位 <b>${sharesText(x.shares)}</b></span><span>預估投入 <b>${money(x.cost)}</b></span>${lotNote}</div>`
    : fit >= 1 ? `<div class="buy"><span>用全部預算可買 <b>${sharesText(fit)}</b></span><span>一張 <b>${money(price * 1000 * 1.001425)}</b></span></div>` : `<div class="buy">預算不足一股（一股 ${money(price * 1.001425)}）。</div>`;
  const n = s.note, why = [...(n.why || []), ...autoWhy(s).filter(t => !t.startsWith("目前數據"))].slice(0, 6), bear = [...(n.bear || []), ...autoBear(s)].slice(0, 8);
  const src = [[`FinLab ${s.code}`, FINLAB(s.code)], [`Goodinfo ${s.code}`, GOODINFO(s.code)], ...(n.src || [])];
  return `<div class="tags">${tags.join("")}</div>${buy}
   ${opts.price && opts.price !== s.price ? `<p class="hint">價位用你輸入的現價 ${fmt(opts.price)} 計算；其他數據是 ${DB.date} 的資料。</p>` : ""}
   <div class="metrics">${metricsOf(s).map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>
   ${finHTML(s)}
   <div class="cols"><div><h4>看好的理由</h4><ul>${why.map(t => `<li>${esc(t)}</li>`).join("")}</ul><h4 style="margin-top:10px">主要風險</h4><ul>${bear.map(t => `<li>${esc(t)}</li>`).join("")}</ul>${n.adjNote ? `<p class="hint">${esc(n.adjNote)}</p>` : ""}</div>
   <div><h4>${h === "short" ? "波段" : "長期"}進出場參考價（持有 ${daysText(days())}）</h4>${ladderHTML(L, s.etf)}</div></div>
   ${n.event ? `<div class="event">${esc(n.event)}</div>` : ""}
   ${s.etf ? "" : `<div data-chain="${s.code}"></div><div data-news="${s.code}"></div>`}
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
  d.addEventListener("toggle", () => { if (d.open) { const b = d.querySelector(".body"); b.innerHTML = stockBody(s, {row: x}); attachChain(b); attachNews(b); } });
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
      const e = exitFor(+hd.cost, s.volc, s.etf), pl = (s.price - hd.cost) / hd.cost;
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
  lastAnalysis = () => { out.innerHTML = `<div class="ind-h"><h3><code style="font:600 14px var(--f-data);color:var(--muted);margin-right:6px">${s.code}</code>${esc(s.name)}</h3><span class="s-price">${fmt(price || s.price)}</span></div>` + stockBody(s, {price: price || null, row: ROWS.find(r => r.s === s)}); attachChain(out); attachNews(out); };
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

/* ---------------- views ---------------- */
const VIEWS = ["alloc", "list", "analyze", "mine", "account", "help"];
let view = "alloc";
function show(v, scroll = true) {
  if (!VIEWS.includes(v)) v = "alloc";
  view = v;
  VIEWS.forEach(k => { $("view-" + k).hidden = k !== v; });
  document.querySelectorAll("#menu a").forEach(a => { if (a.dataset.view === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
  document.title = $("view-" + v).dataset.title + "｜預算選股台";
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
  <li><b>資料</b>：證交所與櫃買中心官方 OpenAPI 的收盤價、本益比、殖利率、股價淨值比、月營收（本月、上月、去年同月、今年累計）、最新一期綜合損益表（營收、毛利、營業利益、稅後淨利、EPS）、公司基本資料，以及三大法人買賣超。每個交易日收盤後由 GitHub Actions 自動更新。目前資料日期 ${DB.date}，已累積 ${DB.historyDays} 天歷史。</li>
  <li><b>長期評分</b>（1–5 分）＝ 成長（月營收年增率，最高 2 分）＋ 估值（本益比和同產業中位數比，越低越高分；超過 80 倍扣分；虧損直接扣分）＋ 獲利品質（推算 ROE＝股價淨值比÷本益比）＋ 法人動向（最多 0.5 分）。記憶體是景氣循環股，估值分數最多 0.5 分；營收年增超過 300% 多半是基期太低，成長分數只給 1 分。</li>
  <li><b>波段評分</b> ＝ 三大法人近 20 日與 5 日買賣超（權重最高）＋ 近 20 日走勢（上漲但不過熱加分，20 日漲超過 25% 或 60 日漲超過 50% 扣分）＋ 成長與估值。${DB.shortMode !== "full" ? "歷史資料累積到 20 個交易日前，波段評分只用基本面估算。" : ""}</li>
  <li><b>主要風險</b>依每檔的數據逐條產生：虧損或本業虧損、業外占比、毛利率偏低、本益比與同產業比、殖利率、營收年減或月減、單月與累計成長落差、法人賣超、短線漲幅、所屬題材或產業的特有風險、成交量與市值。</li>
  <li>評分 2 分以上、當日成交量至少 200 張的股票列入推薦清單。少數標的有人工研究筆記或調整，卡片上會寫明原因。</li>
  <li><b>公司規模</b>：大型股市值 1,000 億以上、中型 200–1,000 億、小型 200 億以下。小型股流動性較差，掛單建議用限價。在「配置建議」可以複選只要大型、中型、小型股或 ETF，配置與類別看好度都只用你選的規模計算。</li>
  <li><b>上下游產業鏈</b>：取自證交所與櫃買中心合辦的「產業價值鏈資訊平台」，每週更新。卡片會列出這家公司所在的產業與環節、同環節的同業，以及上游、下游各環節的上市櫃公司（依推薦與評分排序，框線標示的是目前推薦清單裡的）。一家公司可能出現在好幾條產業鏈，可切換查看。</li>
  <li><b>配置類別與看好度</b>：每個題材（或官方產業）的看好度 0–100 ＝ 類別內前 3 檔平均評分（40%）＋ 推薦比例（20%）＋ 營收年增中位數（20%）＋ 法人買超比例（10%）＋ 近 20 日漲跌中位數（10%）。看好度 55 以上的前 4 名標「目前看好」。選了類別後，資金依你設的比例分給各類別，系統只在該類別裡挑評分高、預算買得起的股票；沒選就由系統在全市場挑。</li>
  <li><b>預期波動</b>：年化波動假設低 18%、中 32%、高 50%，乘上持有時間（年）的平方根，得到這段期間的正常波動幅度。</li>
  <li><b>波段模式（6 個月以內）</b>：資金分兩筆，現價下方 0.25 與 0.6 個波動幅度。停損在平均成本下方 1 個波動幅度（上限 15%），停利一、二是停損距離的 1.5 與 2.5 倍。持有天數到了還沒碰到停利一就出場。</li>
  <li><b>長期模式（超過 6 個月）</b>：資金分三筆，現價、回檔 0.5 與 0.9 個波動幅度各 1/3（上限 40%）。最大虧損線上限 35%。漲到重新評估價時考慮先賣 1/3；月營收年增率連兩個月轉負就減碼一半。</li>
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
  try { await loadData(); }
  catch (e) { $("stamp").textContent = "資料載入失敗"; $("groups").innerHTML = `<div class="empty">${esc(e.message)}。GitHub Actions 第一次跑完後才會有資料。</div>`; return; }
  $("stamp").innerHTML = `資料日期 <b>${DB.date}</b><br>上市櫃 ${S.length} 檔 · 紅漲綠跌`;
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
  accountUI(); render(); show(location.hash.slice(1) || "alloc", false);
}
boot();
})();
