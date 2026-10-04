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
const PREF_KEYS = ["budget", "tNum", "tUnit", "r", "n"];
let state = {budget: 100000, tNum: 1, tUnit: 365, r: 2, n: 0, group: "theme", mkt: "all", size: "all", afford: "all", sort: "score", per: 20, chip: "all", q: "", page: 1};
try { const s = JSON.parse(localStorage.getItem("picker-ui")); if (s) Object.assign(state, s); } catch (e) {}
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

async function loadData() {
  const r = await fetch("data/stocks.json", {cache: "no-cache"});
  if (!r.ok) throw new Error("讀不到 data/stocks.json（" + r.status + "）");
  DB = await r.json();
  S = DB.rows.map(row => { const o = {}; DB.fields.forEach((f, i) => o[f] = row[i]); o.themes = o.themes || []; o.etf = o.size === "E"; o.note = DB.notes[o.code] || {}; return o; });
  BY = Object.fromEntries(S.map(s => [s.code, s]));
  $("codeList").innerHTML = S.map(s => `<option value="${s.code}">${esc(s.name)}</option>`).join("");
}

/* ---------------- allocation ---------------- */
function plan() {
  const B = state.budget, r = state.r;
  const pool = S.filter(s => isRec(s) && (r > 1 || s.risk <= 2));
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
    const rows = picks.map(s => { const L = levels(s.price, s.volc, s.etf); const sh = Math.floor(B * w[s.code] / (L.entries[0][1] * 1.001425)); return {s, L, w: w[s.code], shares: sh, cost: Math.round(sh * L.entries[0][1] * 1.001425)}; });
    const zero = rows.filter(x => x.shares < 1);
    if (!zero.length) return rows;
    zero.forEach(z => banned.add(z.s.code));
  }
  return [];
}

/* ---------------- text from data ---------------- */
function medPE(s) { return DB.indMedianPE[s.ind]; }
function autoWhy(s) {
  const a = [], med = medPE(s);
  if (s.rev != null && s.rev >= 20) a.push(`${monthTxt(s.revMonth)}營收年增 ${s.rev}%${s.revCum != null ? `，今年累計年增 ${s.revCum}%` : ""}`);
  if (s.pe && med && s.pe <= med) a.push(`本益比 ${s.pe} 倍，低於${s.ind}中位數 ${med} 倍`);
  if (s.roe != null && s.roe >= 15) a.push(`推算 ROE 約 ${s.roe}%（股價淨值比 ÷ 本益比）`);
  if (s.yld != null && s.yld >= 3.5) a.push(`殖利率 ${s.yld}%`);
  if (s.f20 > 0 && s.f5 > 0) a.push(`三大法人近 20 日與近 5 日都買超（${lots(s.f20)} / ${lots(s.f5)}）`);
  else if (s.f5 > 0) a.push(`三大法人近 5 日買超 ${lots(s.f5)}`);
  if (s.ch20 != null && s.ch20 > 0 && s.ch20 <= 20) a.push(`近 20 日上漲 ${s.ch20}%，走勢向上但不過熱`);
  return a.length ? a : ["目前數據沒有明顯優勢"];
}
function autoBear(s) {
  const a = [], med = medPE(s);
  if (!s.pe && !s.etf) a.push("近四季虧損或無本益比資料");
  if (s.pe && med && s.pe > med * 1.5) a.push(`本益比 ${s.pe} 倍，是${s.ind}中位數 ${med} 倍的 ${(s.pe / med).toFixed(1)} 倍`);
  if (s.pe && s.pe > 80) a.push(`本益比超過 80 倍，市場已預期高成長`);
  if (s.rev != null && s.rev < 0) a.push(`最新月營收年減 ${Math.abs(s.rev)}%`);
  else if (s.rev != null && s.rev < 10) a.push(`營收成長只有 ${s.rev}%`);
  if (s.f20 < 0 && s.f5 < 0) a.push(`三大法人近 20 日與近 5 日都賣超（${lots(s.f20)} / ${lots(s.f5)}）`);
  if (s.ch60 != null && s.ch60 >= 40) a.push(`近 60 日已漲 ${s.ch60}%`);
  if (s.ch20 != null && s.ch20 <= -10) a.push(`近 20 日跌 ${Math.abs(s.ch20)}%`);
  if (s.rev != null && s.rev > 300) a.push(`營收年增 ${s.rev}% 多半是去年基期太低，不代表能持續`);
  if (s.price >= 1000) a.push(`一張要 ${fmt(Math.round(s.price / 10))} 萬，小預算只能買零股`);
  if (s.size === "S") a.push("小型股成交量較小，掛單建議用限價");
  if (!s.liq) a.push(`當日成交量只有 ${s.vol ?? 0} 張，流動性不足，不列入推薦`);
  return a.length ? a : ["大盤估值偏高時，跟著回檔的風險"];
}
function metricsOf(s) {
  const m = [], med = medPE(s);
  if (!s.etf) m.push(["本益比", s.pe ? `${s.pe}${med ? `（產業中位 ${med}）` : ""}` : "—"]);
  if (s.yld != null) m.push(["殖利率", s.yld + "%"]);
  if (s.pb != null) m.push(["股價淨值比", s.pb]);
  if (s.roe != null) m.push(["推算 ROE", s.roe + "%"]);
  if (s.rev != null) m.push([`${monthTxt(s.revMonth)}營收年增`, pct(s.rev)]);
  if (s.revCum != null) m.push(["今年累計年增", pct(s.revCum)]);
  if (s.cap != null) m.push(["市值", fmt(s.cap) + " 億"]);
  if (s.vol != null) m.push(["當日成交量", fmt(s.vol) + " 張"]);
  m.push(["法人 5 日", lots(s.f5)], ["法人 20 日", lots(s.f20)], ["20 日漲跌", pct(s.ch20)], ["60 日漲跌", pct(s.ch60)]);
  return m;
}
const oneLine = s => (s.note.why || autoWhy(s))[0];

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
  const buy = x ? `<div class="buy"><span>配置 <b>${Math.round(x.w * 100)}%</b></span><span>第一筆 <b>${sharesText(Math.max(1, Math.floor(x.shares / (h === "short" ? 2 : 3))))}</b></span><span>全部到位 <b>${sharesText(x.shares)}</b></span><span>預估投入 <b>${money(x.cost)}</b></span></div>`
    : fit >= 1 ? `<div class="buy"><span>用全部預算可買 <b>${sharesText(fit)}</b></span><span>一張 <b>${money(price * 1000 * 1.001425)}</b></span></div>` : `<div class="buy">預算不足一股（一股 ${money(price * 1.001425)}）。</div>`;
  const n = s.note, why = [...(n.why || []), ...autoWhy(s).filter(t => !t.startsWith("目前數據"))].slice(0, 6), bear = [...(n.bear || []), ...autoBear(s)].slice(0, 6);
  const src = [[`FinLab ${s.code}`, FINLAB(s.code)], [`Goodinfo ${s.code}`, GOODINFO(s.code)], ...(n.src || [])];
  return `<div class="tags">${tags.join("")}</div>${buy}
   ${opts.price && opts.price !== s.price ? `<p class="hint">價位用你輸入的現價 ${fmt(opts.price)} 計算；其他數據是 ${DB.date} 的資料。</p>` : ""}
   <div class="metrics">${metricsOf(s).map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>
   <div class="cols"><div><h4>看好的理由</h4><ul>${why.map(t => `<li>${esc(t)}</li>`).join("")}</ul><h4 style="margin-top:10px">主要風險</h4><ul>${bear.map(t => `<li>${esc(t)}</li>`).join("")}</ul>${n.adjNote ? `<p class="hint">${esc(n.adjNote)}</p>` : ""}</div>
   <div><h4>${h === "short" ? "波段" : "長期"}進出場參考價（持有 ${daysText(days())}）</h4>${ladderHTML(L, s.etf)}</div></div>
   ${n.event ? `<div class="event">${esc(n.event)}</div>` : ""}
   <div class="src">資料來源：證交所／櫃買中心 OpenAPI（${DB.date}）、${src.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${esc(t)}</a>`).join("、")}</div>`;
}
function stockRow(s, rows) {
  const ci = rows.findIndex(r => r.s === s), x = rows[ci], sc = scoreOf(s);
  const fit = Math.floor(state.budget / (s.price * 1.001425));
  const fitHTML = x ? `<span class="pill in">已配置 ${Math.round(x.w * 100)}%</span>` : fit >= 1000 ? `<span class="pill out">可買 ${sharesText(fit)}</span>` : fit >= 1 ? `<span class="pill out">零股 ${fit} 股</span>` : `<span class="pill no">預算不足一股</span>`;
  const d = document.createElement("details"); d.className = "stock"; d.id = "s" + s.code;
  const dot = x ? `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${COLORS[ci % COLORS.length]};margin-right:6px"></span>` : "";
  const on = watch.has(s.code);
  d.innerHTML = `<summary><button type="button" class="star" data-star="${s.code}" aria-pressed="${on}" aria-label="${on ? "移出" : "加入"}自選股">${on ? "★" : "☆"}</button><span class="s-name">${dot}<code>${s.code}</code>${esc(s.name)}<small>${SIZENAME[s.size]}</small><span class="dots" aria-label="評分 ${sc} 分">${"●".repeat(sc)}${"○".repeat(5 - sc)}</span></span><span class="s-price">${fmt(s.price)}</span><span class="s-one">${esc(oneLine(s))}</span><span class="s-fit">${fitHTML}</span></summary><div class="body"></div>`;
  d.addEventListener("toggle", () => { if (d.open) d.querySelector(".body").innerHTML = stockBody(s, {row: x}); });
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
  $("riskHint").textContent = {1: "以 ETF、金融與中低風險股為主，不放高風險股。", 2: "高風險股單檔上限 15%。", 3: "可放題材股與小型股，高風險股單檔上限 30%。"}[state.r];
  const h = modeKey(), d = days();
  $("modeBox").innerHTML = `持有 <b>${daysText(d)}</b> → <b>${h === "short" ? "波段模式" : "長期模式"}</b>${d < 14 ? "<br>少於 2 週接近短打，這套規則參考性較低。" : ""}${h === "short" && DB.shortMode !== "full" ? "<br>歷史資料還在累積，波段評分暫時只用基本面估算。" : ""}`;

  const rows = ROWS = plan(), B = state.budget, used = rows.reduce((a, x) => a + x.cost, 0);
  $("sum").innerHTML = `<div><small>預算</small><strong>${money(B)}</strong></div><div><small>全部到位投入</small><strong>${money(used)}</strong></div><div><small>保留現金</small><strong>${money(B - used)}</strong></div><div><small>配置標的</small><strong>${rows.length} 檔</strong></div>`;
  $("bar").innerHTML = rows.map((x, i) => `<i style="flex-basis:${(x.cost / B * 100).toFixed(1)}%;background:${COLORS[i % COLORS.length]}"></i>`).join("");
  $("legend").innerHTML = rows.map((x, i) => `<span style="--c:${COLORS[i % COLORS.length]}"><button type="button" data-open="a${x.s.code}">${esc(x.s.name)}</button> ${(x.cost / B * 100).toFixed(0)}%</span>`).join("") + `<span style="--c:var(--line)">現金 ${((B - used) / B * 100).toFixed(0)}%</span>`;

  const ac = $("allocCards"); ac.innerHTML = "";
  if (!rows.length) ac.innerHTML = `<div class="empty">預算太低，連一股都買不到。試著把預算調到 1,000 元以上。</div>`;
  else { const box = document.createElement("div"); box.className = "ind-list"; rows.forEach(x => { const r = stockRow(x.s, rows); r.id = "a" + x.s.code; box.appendChild(r); }); ac.appendChild(box); }
  $("condSummary").innerHTML = `目前條件<br>預算 <b>${money(B)}</b><br>持有 <b>${daysText(d)}</b>（${h === "short" ? "波段" : "長期"}）<br>風險 <b>${{1: "保守", 2: "穩健", 3: "積極"}[state.r]}</b> · 配置 <b>${rows.length}</b> 檔<br><a href="#alloc" data-view="alloc">修改條件</a>`;

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
  lastAnalysis = () => { out.innerHTML = `<div class="ind-h"><h3><code style="font:600 14px var(--f-data);color:var(--muted);margin-right:6px">${s.code}</code>${esc(s.name)}</h3><span class="s-price">${fmt(price || s.price)}</span></div>` + stockBody(s, {price: price || null, row: ROWS.find(r => r.s === s)}); };
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
  if (user && sb) { clearTimeout(prefTimer); prefTimer = setTimeout(() => sb.from("user_settings").upsert({user_id: user.id, budget: state.budget, t_num: state.tNum, t_unit: state.tUnit, risk: state.r, n_pick: state.n, updated_at: new Date().toISOString()}).then(({error}) => { if (error) console.warn(error); }), 800); }
}
async function loadUserData() {
  if (!user) { holdings = local.get("picker-holdings", []); watch = new Set(local.get("picker-watch", [])); return; }
  const [st, hd, wl] = await Promise.all([
    sb.from("user_settings").select("*").eq("user_id", user.id).maybeSingle(),
    sb.from("holdings").select("*").order("created_at"),
    sb.from("watchlist").select("code")
  ]);
  if (st.data) Object.assign(state, {budget: +st.data.budget, tNum: +st.data.t_num, tUnit: +st.data.t_unit, r: +st.data.risk, n: +st.data.n_pick});
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
  <li><b>資料</b>：證交所與櫃買中心官方 OpenAPI 的收盤價、本益比、殖利率、股價淨值比、月營收、公司基本資料，以及三大法人買賣超。每個交易日收盤後由 GitHub Actions 自動更新。目前資料日期 ${DB.date}，已累積 ${DB.historyDays} 天歷史。</li>
  <li><b>長期評分</b>（1–5 分）＝ 成長（月營收年增率，最高 2 分）＋ 估值（本益比和同產業中位數比，越低越高分；超過 80 倍扣分；虧損直接扣分）＋ 獲利品質（推算 ROE＝股價淨值比÷本益比）＋ 法人動向（最多 0.5 分）。記憶體是景氣循環股，估值分數最多 0.5 分；營收年增超過 300% 多半是基期太低，成長分數只給 1 分。</li>
  <li><b>波段評分</b> ＝ 三大法人近 20 日與 5 日買賣超（權重最高）＋ 近 20 日走勢（上漲但不過熱加分，20 日漲超過 25% 或 60 日漲超過 50% 扣分）＋ 成長與估值。${DB.shortMode !== "full" ? "歷史資料累積到 20 個交易日前，波段評分只用基本面估算。" : ""}</li>
  <li>評分 2 分以上、當日成交量至少 200 張的股票列入推薦清單。少數標的有人工研究筆記或調整，卡片上會寫明原因。</li>
  <li><b>公司規模</b>：大型股市值 1,000 億以上、中型 200–1,000 億、小型 200 億以下。小型股流動性較差，掛單建議用限價。</li>
  <li><b>預期波動</b>：年化波動假設低 18%、中 32%、高 50%，乘上持有時間（年）的平方根，得到這段期間的正常波動幅度。</li>
  <li><b>波段模式（6 個月以內）</b>：資金分兩筆，現價下方 0.25 與 0.6 個波動幅度。停損在平均成本下方 1 個波動幅度（上限 15%），停利一、二是停損距離的 1.5 與 2.5 倍。持有天數到了還沒碰到停利一就出場。</li>
  <li><b>長期模式（超過 6 個月）</b>：資金分三筆，現價、回檔 0.5 與 0.9 個波動幅度各 1/3（上限 40%）。最大虧損線上限 35%。漲到重新評估價時考慮先賣 1/3；月營收年增率連兩個月轉負就減碼一半。</li>
  <li>所有價位依證交所升降單位取整。</li></ul>`;
}

/* ---------------- events ---------------- */
function wire() {
  document.addEventListener("click", e => { const a = e.target.closest("a[data-view]"); if (a) { e.preventDefault(); show(a.dataset.view); } });
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));
  const reset = () => { state.page = 1; render(); };
  $("budget").addEventListener("change", e => { const v = +e.target.value; if (v > 0) { state.budget = v; reset(); } });
  $("budgetChips").addEventListener("click", e => { const b = e.target.closest("button[data-b]"); if (b) { state.budget = +b.dataset.b; reset(); } });
  $("tNum").addEventListener("change", e => { const v = +e.target.value; if (v > 0) { state.tNum = v; reset(); } });
  $("tUnit").addEventListener("change", e => { state.tUnit = +e.target.value; reset(); });
  $("timeChips").addEventListener("click", e => { const b = e.target.closest("button[data-n]"); if (b) { state.tNum = +b.dataset.n; state.tUnit = +b.dataset.u; reset(); } });
  $("risk").addEventListener("click", e => { const b = e.target.closest("button[data-v]"); if (b) { state.r = +b.dataset.v; render(); } });
  $("nPick").addEventListener("change", e => { state.n = +e.target.value; render(); });
  [["fGroup", "group"], ["fMkt", "mkt"], ["fSize", "size"], ["fAfford", "afford"], ["fSort", "sort"]].forEach(([id, k]) => $(id).addEventListener("change", e => { state[k] = e.target.value; if (k === "group") state.chip = "all"; reset(); }));
  $("fPer").addEventListener("change", e => { state.per = +e.target.value; reset(); });
  let qt; $("fQ").addEventListener("input", e => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value; reset(); }, 250); });
  $("indChips").addEventListener("click", e => { const b = e.target.closest("button[data-chip]"); if (b) { state.chip = b.dataset.chip; reset(); } });
  ["pagerTop", "pagerBot"].forEach(id => $(id).addEventListener("click", e => { const b = e.target.closest("button[data-p]"); if (b && !b.disabled) { state.page = +b.dataset.p; render(); $("listTitle").scrollIntoView({behavior: "smooth", block: "start"}); } }));
  document.addEventListener("click", async e => {
    const op = e.target.closest("[data-open]"); if (op) { const el = $(op.dataset.open); if (el) { el.open = true; el.scrollIntoView({behavior: "smooth", block: "center"}); } return; }
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
