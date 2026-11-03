/* =====================================================================
   킹콩백화점 통합 물류 배차 · 정산 — 프로토타입 (바닐라 JS, 빌드 없음)
   - 주소에 ?v=업체이름 이 있으면 업체(모바일) 화면, 없으면 킹콩 관리자 화면
   - config.js 가 비어 있으면 데모 모드(localStorage), 채우면 Supabase
   ===================================================================== */
(() => {
"use strict";
const CFG = window.KK_CONFIG || {};
const LIVE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

// ---------------- 공통 상수 ----------------
const TYPES = {
  coupang:  { label: "쿠팡 출고요청", short: "쿠팡", desc: "쿠팡 FC 출고요청 물량 → 센터·매장" },
  center:   { label: "센터·본사 요청", short: "센터/본사", desc: "매장 간 이동 · 외부업체 물품 → 진천센터·매장" },
  delivery: { label: "고객 배송", short: "고객배송", desc: "매장 대형가전·가구 판매 후 고객 집까지" },
};
const STATUS = {
  requested: "배차 요청", assigned: "배차 완료", done: "운행 완료", confirmed: "정산 확정", canceled: "취소",
};
const STATUS_ORDER = ["requested", "assigned", "done", "confirmed"];
const TONS = [1, 1.4, 2.5, 3.5, 5, 11, 14, 18, 25];
const BODIES = ["카고", "윙", "탑", "냉동탑", "냉장탑", "플축윙", "초장축", "광폭윙"];
const EXTRA_REASONS = ["대기 1시간", "대기 2시간", "경유 1곳", "수작업 상하차", "야간", "고층·계단"];
const SLOTS = ["오전", "오후", "야간"];

// ---------------- 작은 도구 ----------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const won = v => (v == null || v === "" || isNaN(v)) ? "-" : Math.round(+v).toLocaleString("ko-KR");
const man = v => { v = +v || 0; return Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(2) + "억" : Math.round(v / 1e4).toLocaleString("ko-KR") + "만"; };
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return ymd(d); };
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const dLabel = s => s ? `${+s.slice(5, 7)}/${+s.slice(8, 10)}(${WD[new Date(s + "T00:00:00").getDay()]})` : "";
const numOrNull = v => (v === "" || v == null || isNaN(+v)) ? null : +v;
const billed = d => (+d.base_fare || 0) + (+d.extra_fare || 0);
const toast = msg => { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2200); };
const typeTag = t => `<span class="tag t-${t}">${esc(TYPES[t]?.short || t)}</span>`;
const stTag = s => `<span class="st ${s}">${esc(STATUS[s] || s)}</span>`;
const monthOf = s => (s || "").slice(0, 7);

// =====================================================================
//  저장소 — 데모(localStorage) / Supabase 두 가지를 같은 함수 이름으로
// =====================================================================
const DEMO_KEY = "kk_dispatch_demo_v1";
function demoSeed() {
  const vendors = [
    { id: "v1", name: "태성로지스틱스", pin: "2580", types: ["coupang", "center"], contact: "010-0000-1111", active: true },
    { id: "v2", name: "더한물류", pin: "1357", types: ["center", "delivery"], contact: "010-0000-2222", active: true },
  ];
  const places = [
    ["시흥3", "쿠팡FC"], ["여주2", "쿠팡FC"], ["인천37", "쿠팡FC"], ["용인5", "쿠팡FC"], ["성남2", "쿠팡FC"],
    ["진천센터", "센터"], ["광주센터", "센터"], ["이천센터", "센터"], ["기흥센터", "센터"], ["송파센터", "센터"], ["칠곡센터", "센터"],
    ["시그니처용인점", "매장"], ["시그니처이천점", "매장"], ["시그니처인천점", "매장"], ["김해점", "매장"], ["동김해점", "매장"], ["안중점", "매장"],
    ["남양주점", "매장"], ["아산점", "매장"], ["청주점", "매장"], ["경안점", "매장"], ["평택점", "매장"], ["기흥점", "매장"], ["양주점", "매장"],
    ["원주점", "매장"], ["충주점", "매장"], ["천안점", "매장"], ["수원점", "매장"], ["김포점", "매장"], ["동탄점", "매장"],
    ["부산제타", "외부업체"], ["화인통상", "외부업체"], ["인천 11번가", "외부업체"], ["창원컬리", "외부업체"],
  ].map(([name, kind], i) => ({ id: "p" + i, name, kind, aliases: name === "시그니처용인점" ? ["용인점"] : [], active: true }));
  const rates = [
    { id: "r1", vendor_id: "v1", type: "coupang", from_place: null, to_place: "광주센터", vehicle_ton: null, base_fare: 200000, note: "쿠팡 FC → 광주센터" },
    { id: "r2", vendor_id: "v1", type: "coupang", from_place: null, to_place: "이천센터", vehicle_ton: null, base_fare: 190000, note: "" },
    { id: "r3", vendor_id: "v1", type: "coupang", from_place: null, to_place: null, vehicle_ton: 5, base_fare: 170000, note: "5톤 기본" },
    { id: "r4", vendor_id: "v2", type: "center", from_place: null, to_place: null, vehicle_ton: 1, base_fare: 90000, note: "1톤 시내" },
    { id: "r5", vendor_id: "v2", type: "center", from_place: null, to_place: null, vehicle_ton: 3.5, base_fare: 190000, note: "" },
    { id: "r6", vendor_id: "v2", type: "center", from_place: "인천 11번가", to_place: "진천센터", vehicle_ton: 14, base_fare: 300000, note: "" },
    { id: "r7", vendor_id: "v2", type: "delivery", from_place: null, to_place: null, vehicle_ton: null, base_fare: 55000, note: "고객배송 기본" },
  ];
  // 예시 운행 — 실제 원본의 상·하차지 · 차종 · 금액대를 본떠 만든 가짜 데이터(기사 · 고객 이름 · 번호는 지어낸 것)
  const drivers = [["김민수", "경기89자1234", 11, "윙"], ["박준호", "서울82바5678", 14, "윙"], ["이성훈", "충남84바2831", 5, "윙"], ["정우진", "경기91사2898", 1, "냉동탑"],
    ["최영길", "서울87아9952", 14, "윙"], ["한동석", "경기80아6752", 1, "카고"], ["오세준", "서울82바1686", 3.5, "냉동탑"], ["윤재혁", "경기88사9839", 1.4, "카고"]];
  const rnd = (() => { let x = 7; return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const pick = a => a[Math.floor(rnd() * a.length)];
  const D = []; let id = 1;
  const base = today();
  for (let k = -55; k <= 3; k++) {
    const day = addDays(base, k); const dow = new Date(day + "T00:00:00").getDay(); if (dow === 0) continue;
    const past = k < 0, isToday = k === 0;
    // 쿠팡
    for (let j = 0; j < 2 + Math.floor(rnd() * 3); j++) {
      const to = pick(["광주센터", "이천센터", "시그니처용인점", "원주점"]); const plt = pick([9, 18, 18, 18]);
      const dr = pick(drivers.slice(0, 5)); const bf = to === "광주센터" ? 200000 : to === "이천센터" ? 190000 : 170000;
      const ex = rnd() < .35 ? pick([20000, 30000, 40000]) : 0;
      const d = { id: id++, type: "coupang", vendor_id: "v1", origin: "kingkong", run_date: day, time_slot: pick(["오전", "오후", "야간"]), from_place: pick(["시흥3", "여주2"]), to_place: to, plt_qty: plt, temp: "상온",
        ref_code: "AFA" + day.replace(/-/g, "").slice(2) + String.fromCharCode(65 + j) + "X", cargo_note: "", requested_by: "이동주" };
      if (past || (isToday && j === 0)) Object.assign(d, { driver_name: dr[0], vehicle_no: dr[1], vehicle_ton: dr[2], vehicle_body: dr[3], base_fare: bf, extra_fare: ex, extra_reason: ex ? pick(["대기 1시간", "대기 2시간", "대기 1시간 30분"]) : "", status: past ? (k < -20 ? "confirmed" : "done") : "assigned" });
      else d.status = "requested";
      if (past && rnd() < .12) Object.assign(d, { return_date: addDays(day, 1), return_from: "여주2", return_driver: dr[0], return_fare: pick([60000, 70000]) });
      D.push(d);
    }
    // 센터·본사
    for (let j = 0; j < 3 + Math.floor(rnd() * 4); j++) {
      const lane = pick([["인천 11번가", "진천센터", 18, "상온", 14, "윙", 300000], ["부산제타", "김해점", 1, "냉장", 1, "냉동탑", 100000], ["용인5", "청주점", 1, "냉장", 3.5, "냉동탑", 190000],
        ["송파센터", "남양주점", 2, "냉장", 1, "냉동탑", 90000], ["진천센터", "화인통상", 2, "상온", 1, "카고", 85000], ["이천센터", "안중점", 2, "냉장", 1, "냉동탑", 95000], ["칠곡센터", "동김해점", 3, "냉장", 1, "냉동탑", 110000]]);
      const dr = pick(drivers.slice(3));
      const vendorMade = past && rnd() < .15;
      const d = { id: id++, type: "center", vendor_id: "v2", origin: vendorMade ? "vendor" : "kingkong", run_date: day, time_slot: "", from_place: lane[0], to_place: lane[1], plt_qty: lane[2], temp: lane[3], cargo_note: lane[3] === "냉장" ? "신선" : "", requested_by: vendorMade ? "" : "물류센터" };
      if (past || vendorMade) Object.assign(d, { driver_name: dr[0], vehicle_no: dr[1], vehicle_ton: lane[4], vehicle_body: lane[5], base_fare: lane[6] + (rnd() < .1 ? 20000 : 0), extra_fare: 0, status: past ? (k < -20 ? "confirmed" : "done") : "done" });
      else d.status = isToday && j < 2 ? "assigned" : "requested";
      if (d.status === "assigned") Object.assign(d, { driver_name: dr[0], vehicle_no: dr[1], vehicle_ton: lane[4], vehicle_body: lane[5], base_fare: lane[6], extra_fare: 0 });
      D.push(d);
    }
    // 고객배송
    if (rnd() < .7) {
      const prod = pick([["양문형냉장고", "1"], ["안마의자", "1"], ["티비(100인치)", "1"], ["쇼파 · 의자", "2PLT"], ["런닝머신", "1"]]);
      const store = pick(["안중점", "양주점", "원주점", "김해점", "평택점"]);
      const fare = prod[0] === "안마의자" ? 75000 : 55000;
      const d = { id: id++, type: "delivery", vendor_id: "v2", origin: "kingkong", run_date: addDays(day, 2), time_slot: "", from_place: store, to_place: "고객", plt_qty: null, temp: "상온", cargo_note: prod[0], requested_by: store,
        delivery: { order_date: day, store, customer_name: pick(["김OO", "이OO", "박OO", "최OO"]), customer_phone: "010-0000-" + String(1000 + Math.floor(rnd() * 8999)), address: pick(["평택시 비전동 OO아파트 105동", "양주시 옥정동 OO로 130", "원주시 단계동 OO로 26", "화성시 동탄대로 OO길"]), product: prod[0], qty: prod[1], terms: pick(["무료", "유료", "무료(추가요금)"]), done_note: "" } };
      if (k < -2) Object.assign(d, { driver_name: "배송1팀", vehicle_no: "경기80아6752", vehicle_ton: 1, vehicle_body: "카고", base_fare: fare, extra_fare: rnd() < .15 ? 20000 : 0, extra_reason: "", status: k < -20 ? "confirmed" : "done" }), d.delivery.done_note = `${dLabel(d.run_date)} 배송완료`;
      else d.status = "requested";
      D.push(d);
    }
  }
  D.forEach(d => { d.created_at = d.run_date + "T09:00:00"; d.updated_at = d.created_at; });
  return { vendors, places, rates, dispatches: D, settlements: [], audit: [], nextId: id };
}
const Demo = {
  db: null,
  load() { try { this.db = JSON.parse(localStorage.getItem(DEMO_KEY) || "null"); } catch (_) { this.db = null; } if (!this.db) { this.db = demoSeed(); this.save(); } return this.db; },
  save() { try { localStorage.setItem(DEMO_KEY, JSON.stringify(this.db)); } catch (_) {} },
  reset() { this.db = demoSeed(); this.save(); },
  rateFor(d) {
    const cand = this.db.rates.filter(r => (!r.vendor_id || r.vendor_id === d.vendor_id) && r.type === d.type && (!r.from_place || r.from_place === d.from_place) && (!r.to_place || r.to_place === d.to_place) && (r.vehicle_ton == null || +r.vehicle_ton === +d.vehicle_ton));
    cand.sort((a, b) => [b.from_place, b.to_place, b.vehicle_ton].filter(x => x != null).length - [a.from_place, a.to_place, a.vehicle_ton].filter(x => x != null).length);
    return cand[0] ? cand[0].base_fare : null;
  },
  log(id, actor, action, diff) { this.db.audit.push({ dispatch_id: id, actor, action, diff, at: new Date().toISOString() }); },
};

let sb = null;
async function liveClient() {
  if (sb) return sb;
  await new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  return sb;
}
const unwrap = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const flatDelivery = d => { if (d && d.dispatch_delivery !== undefined) { d.delivery = Array.isArray(d.dispatch_delivery) ? d.dispatch_delivery[0] : d.dispatch_delivery; delete d.dispatch_delivery; } return d; };

// ---- 관리자 쪽 ----
const Admin = {
  async session() {
    if (!LIVE) return { email: "demo@kingkong", name: "데모 관리자" };
    const c = await liveClient(); const { data } = await c.auth.getSession(); return data.session ? { email: data.session.user.email } : null;
  },
  async login(email) { const c = await liveClient(); unwrap(await c.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split("#")[0] } })); },
  async logout() { if (LIVE) { const c = await liveClient(); await c.auth.signOut(); } location.reload(); },
  async refs() {
    if (!LIVE) { const db = Demo.load(); return { vendors: db.vendors, places: db.places, rates: db.rates }; }
    const c = await liveClient();
    const [vendors, places, rates] = await Promise.all([
      c.from("vendors").select("id,name,types,contact,active").order("name").then(unwrap),
      c.from("places").select("*").order("name").then(unwrap),
      c.from("rate_cards").select("*").then(unwrap)]);
    return { vendors, places, rates };
  },
  async list(from, to) {
    if (!LIVE) return Demo.load().dispatches.filter(d => d.run_date >= from && d.run_date <= to).map(d => ({ ...d, rate_fare: Demo.rateFor(d) })).sort((x, y) => y.run_date.localeCompare(x.run_date) || y.id - x.id);
    const c = await liveClient();
    return unwrap(await c.from("dispatches").select("*, dispatch_delivery(*)").gte("run_date", from).lte("run_date", to).order("run_date", { ascending: false }).order("id", { ascending: false }).limit(5000)).map(flatDelivery);
  },
  async save(d, actor) {
    const row = { ...d }; const del = row.delivery; delete row.delivery; delete row.rate_fare; delete row.billed_amount; delete row.settle_month;
    if (!LIVE) {
      const db = Demo.load();
      if (row.id) { const i = db.dispatches.findIndex(x => x.id === row.id); db.dispatches[i] = { ...db.dispatches[i], ...row, delivery: del || db.dispatches[i].delivery, updated_at: new Date().toISOString(), updated_by: actor }; Demo.log(row.id, actor, "update", row); }
      else { row.id = db.nextId++; db.dispatches.push({ ...row, delivery: del, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: actor }); Demo.log(row.id, actor, "insert", row); }
      Demo.save(); return row.id;
    }
    const c = await liveClient(); row.updated_by = actor;
    let saved;
    if (row.id) saved = unwrap(await c.from("dispatches").update(row).eq("id", row.id).select().single());
    else { delete row.id; saved = unwrap(await c.from("dispatches").insert(row).select().single()); }
    if (del) unwrap(await c.from("dispatch_delivery").upsert({ ...del, dispatch_id: saved.id }));
    await c.from("audit_log").insert({ dispatch_id: saved.id, actor, action: d.id ? "update" : "insert", diff: d });
    return saved.id;
  },
  async setStatus(ids, status, actor) {
    if (!LIVE) { const db = Demo.load(); db.dispatches.forEach(d => { if (ids.includes(d.id)) { d.status = status; d.updated_by = actor; Demo.log(d.id, actor, "status", { status }); } }); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.from("dispatches").update({ status, updated_by: actor }).in("id", ids));
  },
  async audit(id) {
    if (!LIVE) return Demo.load().audit.filter(a => a.dispatch_id === id).slice(-20).reverse();
    const c = await liveClient(); return unwrap(await c.from("audit_log").select("*").eq("dispatch_id", id).order("at", { ascending: false }).limit(20));
  },
  async settlements(month) {
    if (!LIVE) return Demo.load().settlements.filter(s => s.month === month);
    const c = await liveClient(); return unwrap(await c.from("settlements").select("*").eq("month", month));
  },
  async confirmSettlement(vendor_id, month, sum, ids, actor) {
    await this.setStatus(ids, "confirmed", actor);
    const rec = { vendor_id, month, supply: sum, vat: Math.round(sum * 0.1), total: Math.round(sum * 1.1), count: ids.length, confirmed_by: actor, confirmed_at: new Date().toISOString() };
    if (!LIVE) { const db = Demo.load(); db.settlements = db.settlements.filter(s => !(s.vendor_id === vendor_id && s.month === month)).concat(rec); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.from("settlements").upsert(rec, { onConflict: "vendor_id,month" }));
  },
  async saveRef(kind, row) {
    if (!LIVE) { const db = Demo.load(); const L = db[kind]; if (row.id) { const i = L.findIndex(x => x.id === row.id); if (i >= 0) L[i] = { ...L[i], ...row }; else L.push(row); } else { row.id = kind[0] + Date.now(); L.push(row); } Demo.save(); return; }
    const c = await liveClient(); const table = { vendors: "vendors", places: "places", rates: "rate_cards" }[kind];
    if (kind === "vendors") { toast("업체 추가 · PIN 변경은 Supabase SQL Editor 에서 합니다(운영 가이드 참고)"); return; }
    unwrap(await c.from(table).upsert(row));
  },
  async removeRef(kind, id) {
    if (!LIVE) { const db = Demo.load(); db[kind] = db[kind].filter(x => x.id !== id); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.from({ places: "places", rates: "rate_cards" }[kind]).delete().eq("id", id));
  },
};

// ---- 업체 쪽(링크 + PIN) ----
const Vendor = {
  name: null, pin: null, vid: null,
  async login(name, pin) {
    if (!LIVE) { const v = Demo.load().vendors.find(x => x.name === name && x.active); if (!v || v.pin !== pin) throw new Error("PIN이 맞지 않습니다"); this.vid = v.id; }
    else { const c = await liveClient(); unwrap(await c.rpc("vendor_refs", { p_vendor: name, p_pin: pin })); }
    this.name = name; this.pin = pin; try { sessionStorage.setItem("kk_vpin_" + name, pin); } catch (_) {}
  },
  async list() {
    if (!LIVE) { const db = Demo.load(); const v = db.vendors.find(x => x.id === this.vid); const lo = addDays(today(), -45);
      return db.dispatches.filter(d => d.status !== "canceled" && d.run_date >= lo && (d.vendor_id === this.vid || (!d.vendor_id && v.types.includes(d.type)))).map(d => ({ ...d, rate_fare: Demo.rateFor({ ...d, vendor_id: this.vid }) })).sort((a, b) => b.run_date.localeCompare(a.run_date) || b.id - a.id); }
    const c = await liveClient(); return unwrap(await c.rpc("vendor_list", { p_vendor: this.name, p_pin: this.pin }));
  },
  async refs() {
    if (!LIVE) { const db = Demo.load(); return { places: db.places.map(p => p.name), rates: db.rates.filter(r => r.vendor_id === this.vid) }; }
    const c = await liveClient(); return unwrap(await c.rpc("vendor_refs", { p_vendor: this.name, p_pin: this.pin }));
  },
  async save(id, p) {
    if (!LIVE) { const db = Demo.load(); const d = db.dispatches.find(x => x.id === id); if (d.status === "confirmed") throw new Error("정산 확정된 건은 고칠 수 없습니다");
      const { done_note, ...rest } = p; Object.assign(d, rest, { vendor_id: this.vid, updated_at: new Date().toISOString(), updated_by: "vendor:" + this.name }); if (d.delivery && done_note != null) d.delivery.done_note = done_note;
      Demo.log(id, "vendor:" + this.name, "update", p); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.rpc("vendor_save", { p_vendor: this.name, p_pin: this.pin, p_id: id, p }));
  },
  async add(p) {
    if (!LIVE) { const db = Demo.load(); const id = db.nextId++; db.dispatches.push({ ...p, id, vendor_id: this.vid, origin: "vendor", status: "done", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: "vendor:" + this.name }); Demo.log(id, "vendor:" + this.name, "insert", p); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.rpc("vendor_add", { p_vendor: this.name, p_pin: this.pin, p }));
  },
};

// =====================================================================
//  화면 시작
// =====================================================================
const app = $("#app");
const params = new URLSearchParams(location.search);
const vendorParam = params.get("v") || (decodeURIComponent((location.hash.match(/v=([^&]+)/) || [])[1] || "") || null);


// =====================================================================
//  관리자(PC) 화면
// =====================================================================
const S = { tab: "dash", month: today().slice(0, 7), refs: null, rows: [], filter: { type: "", status: "", vendor: "", q: "", flag: "" }, newType: "coupang", user: null };

async function adminBoot() {
  S.user = await Admin.session();
  if (!S.user) return adminLogin();
  try { const h = location.hash.slice(1); if (["dash", "new", "ledger", "settle", "setup"].includes(h)) S.tab = h; } catch (_) {}
  await reload();
}
function adminLogin() {
  app.innerHTML = `<div class="pin"><div class="card"><h2>킹콩 물류 관리자</h2><p class="sub">회사 이메일을 넣으면 로그인 링크를 보내 드립니다.</p>
    <div class="field"><label for="em">이메일</label><input id="em" type="email" autocomplete="email" placeholder="name@kinggo.ai"></div>
    <div class="row" style="margin-top:12px;justify-content:center"><button class="btn primary" id="go">로그인 링크 받기</button></div></div></div>`;
  $("#go").onclick = async () => { try { await Admin.login($("#em").value.trim()); toast("메일함에서 로그인 링크를 눌러 주세요"); } catch (e) { toast(e.message); } };
}
async function reload() {
  const [y, m] = S.month.split("-").map(Number);
  const prev = ymd(new Date(y, m - 2, 1)), end = ymd(new Date(y, m, 0));
  try {
    S.refs = await Admin.refs();
    S.rowsAll = await Admin.list(addDays(prev, -40), addDays(end, 40));   // 앞뒤 달까지 받아 전월 대비 · 다가오는 요청을 같이 본다
  } catch (e) { app.innerHTML = `<div class="empty">불러오기 실패: ${esc(e.message)}</div>`; return; }
  S.rows = S.rowsAll.filter(d => monthOf(d.run_date) === S.month);
  render();
}
const vName = id => (S.refs?.vendors.find(v => v.id === id) || {}).name || (id ? "?" : "미지정");

function render() {
  const nav = [["dash", "대시보드"], ["new", "배차 요청"], ["ledger", "통합 대장"], ["settle", "정산"], ["setup", "설정"]];
  app.innerHTML = `
  <div class="top"><div class="top-in">
    <div class="brand"><span class="logo" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg></span>
      <span>킹콩 물류 배차·정산<small>${esc(CFG.COMPANY || "킹콩백화점")} · 통합 대장</small></span></div>
    <nav class="nav" aria-label="메뉴">${nav.map(([k, l]) => `<button data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ""}>${l}</button>`).join("")}</nav>
    <span class="sp"></span>
    <label class="row" style="gap:6px;font-size:13px;font-weight:700;color:var(--muted)">기준 월 <input type="month" id="month" value="${S.month}" style="border:1px solid var(--line);border-radius:8px;padding:6px 8px;background:var(--panel)"></label>
    <span class="mode-badge ${LIVE ? "" : "demo"}" title="${LIVE ? "Supabase 공유 DB에 저장" : "이 브라우저에만 저장되는 예시 데이터"}">${LIVE ? "실시간 DB · " + esc(S.user.email) : "데모 모드"}</span>
  </div></div>
  <main id="view"></main>`;
  $$(".nav button").forEach(b => b.onclick = () => { S.tab = b.dataset.tab; history.replaceState(null, "", "#" + S.tab); render(); });
  $("#month").onchange = e => { S.month = e.target.value || S.month; reload(); };
  const v = $("#view");
  ({ dash: viewDash, new: viewNew, ledger: viewLedger, settle: viewSettle, setup: viewSetup })[S.tab](v);
}

// ---------------- 대시보드 ----------------
function viewDash(v) {
  const R = S.rows.filter(d => d.status !== "canceled");
  const [y, m] = S.month.split("-").map(Number); const pm = ymd(new Date(y, m - 2, 1)).slice(0, 7);
  const P = S.rowsAll.filter(d => monthOf(d.run_date) === pm && d.status !== "canceled");
  const sum = L => L.reduce((a, d) => a + billed(d) + (+d.return_fare || 0), 0);
  const total = sum(R), ptotal = sum(P);
  const t = today();
  const waiting = S.rowsAll.filter(d => d.status === "requested" && d.run_date <= addDays(t, 1));
  const noFare = R.filter(d => ["assigned", "done"].includes(d.status) && !d.base_fare && d.run_date < t);
  const over = R.filter(d => d.rate_fare && d.base_fare && billed(d) > d.rate_fare);
  const vendorMade = R.filter(d => d.origin === "vendor" && d.status === "done");
  const pct = ptotal ? ((total / ptotal - 1) * 100) : null;
  const kpi = (l, val, s, cls = "", flag = "") => `<div class="kpi ${cls} ${flag ? "clickable" : ""}" ${flag ? `data-flag="${flag}" tabindex="0" role="button"` : ""}><div class="l">${l}</div><div class="v num">${val}</div><div class="s">${s}</div></div>`;
  // 유형 × 상태 보드
  const board = `<div class="board" role="table" aria-label="유형별 진행 상태">
    <div class="h">유형</div>${STATUS_ORDER.map(s => `<div class="h">${stTag(s)}</div>`).join("")}
    ${Object.keys(TYPES).map(tp => `<div class="h">${typeTag(tp)}</div>` + STATUS_ORDER.map(s => { const L = R.filter(d => d.type === tp && d.status === s); return `<div class="c num" data-go="${tp}|${s}" tabindex="0" role="button">${L.length}<small>${sum(L) ? man(sum(L)) + "원" : (L.length ? "금액 입력 전" : "&nbsp;")}</small></div>`; }).join("")).join("")}
  </div>`;
  // 유형별 · 업체별 비용 막대
  const byType = Object.keys(TYPES).map(tp => ({ k: tp, v: sum(R.filter(d => d.type === tp)) }));
  const maxT = Math.max(1, ...byType.map(x => x.v));
  const vendors = S.refs.vendors.map(vd => ({ vd, L: R.filter(d => d.vendor_id === vd.id) })).filter(x => x.L.length);
  const maxV = Math.max(1, ...vendors.map(x => sum(x.L)));
  const typeBars = byType.map(x => `<div class="bar-row"><span>${typeTag(x.k)}</span><div class="track"><i style="width:${x.v / maxT * 100}%;background:var(--t${Object.keys(TYPES).indexOf(x.k) + 1})"></i></div><span class="v num">${won(x.v)}원</span></div>`).join("");
  const vendorBars = vendors.map(({ vd, L }) => { const s = sum(L); return `<div class="bar-row"><span>${esc(vd.name)}</span><div class="track">${Object.keys(TYPES).map((tp, i) => { const x = sum(L.filter(d => d.type === tp)); return x ? `<i style="width:${x / maxV * 100}%;background:var(--t${i + 1})" title="${esc(TYPES[tp].short)} ${won(x)}원"></i>` : ""; }).join("")}</div><span class="v num">${won(s)}원</span></div>`; }).join("");
  // 일별 비용
  const dim = new Date(y, m, 0).getDate();
  const days = Array.from({ length: dim }, (_, i) => `${S.month}-${String(i + 1).padStart(2, "0")}`);
  const dayVals = days.map(dd => Object.keys(TYPES).map(tp => sum(R.filter(d => d.run_date === dd && d.type === tp))));
  const maxD = Math.max(1, ...dayVals.map(a => a.reduce((x, y2) => x + y2, 0)));
  const cols = days.map((dd, i) => `<div class="c" title="${dLabel(dd)} ${won(dayVals[i].reduce((a, b) => a + b, 0))}원">${dayVals[i].map((x, j) => x ? `<i style="height:${x / maxD * 150}px;background:var(--t${j + 1})"></i>` : "").join("")}</div>`).join("");
  const ax = days.map((dd, i) => `<span>${(i % 5 === 0 || i === dim - 1) ? +dd.slice(8) : ""}</span>`).join("");
  // 많이 쓴 구간
  const lanes = {}; R.forEach(d => { const k = `${d.from_place} → ${d.to_place}`; (lanes[k] ||= { n: 0, s: 0, t: d.type }); lanes[k].n++; lanes[k].s += billed(d); });
  const topLanes = Object.entries(lanes).sort((a, b) => b[1].s - a[1].s).slice(0, 8);
  v.innerHTML = `
  <div class="grid">
    <div class="kpis">
      ${kpi(`${+S.month.slice(5)}월 물류비 합계`, won(total) + "원", pct == null ? "전월 자료 없음" : `전월 ${man(ptotal)}원 대비 <b style="color:${pct > 0 ? "var(--up)" : "var(--down)"}">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}%</b> (VAT 별도)`)}
      ${kpi("운행 건수", R.length.toLocaleString() + "건", Object.keys(TYPES).map(tp => `${TYPES[tp].short} ${R.filter(d => d.type === tp).length}`).join(" · "))}
      ${kpi("배차 대기", waiting.length + "건", "오늘·내일 운행인데 업체 입력 전", waiting.length ? "alert" : "", "waiting")}
      ${kpi("금액 미입력", noFare.length + "건", "운행했는데 청구금액이 빈 칸", noFare.length ? "alert" : "", "nofare")}
      ${kpi("운임표 초과", over.length + "건", over.length ? `초과액 ${won(over.reduce((a, d) => a + billed(d) - d.rate_fare, 0))}원` : "청구금액 = 운임표", over.length ? "alert" : "", "over")}
      ${kpi("업체 직접 등록", vendorMade.length + "건", "킹콩 요청 없이 올라온 운행 — 확인 필요", vendorMade.length ? "alert" : "", "vendor")}
    </div>
    <div class="card"><h2>진행 상태</h2><p class="sub">${+S.month.slice(5)}월 운행일 기준 · 칸을 누르면 그 건만 통합 대장에서 봅니다</p>${board}</div>
    <div class="two">
      <div class="card"><h2>일별 물류비</h2><p class="sub">운행일 기준 · 막대에 마우스를 올리면 금액</p>
        <div class="legend">${Object.keys(TYPES).map((tp, i) => `<span><i style="background:var(--t${i + 1})"></i>${TYPES[tp].label}</span>`).join("")}</div>
        <div class="cols" style="margin-top:8px">${cols}</div><div class="cols-ax">${ax}</div></div>
      <div class="card"><h2>유형별 · 업체별 비용</h2><p class="sub">청구금액(기본+추가) + 회차 금액</p>
        <div class="bars">${typeBars}</div><hr style="border:0;border-top:1px solid var(--line2);margin:14px 0">
        <div class="bars">${vendorBars || '<div class="muted">자료 없음</div>'}</div></div>
    </div>
    <div class="card"><h2>비용이 큰 구간</h2><p class="sub">상차지 → 하차지 · 이번 달 합계 순</p>
      <div class="tbl-wrap" style="max-height:none"><table class="tbl"><thead><tr><th>구간</th><th>유형</th><th class="r">건수</th><th class="r">합계(원)</th><th class="r">건당 평균</th></tr></thead>
      <tbody>${topLanes.map(([k, x]) => `<tr data-q="${esc(k.split(" → ")[1])}"><td>${esc(k)}</td><td>${typeTag(x.t)}</td><td class="r num">${x.n}</td><td class="r num">${won(x.s)}</td><td class="r num">${won(x.s / x.n)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">자료 없음</td></tr>`}</tbody></table></div></div>
  </div>`;
  $$("[data-flag]", v).forEach(el => el.onclick = () => { S.filter = { type: "", status: "", vendor: "", q: "", flag: el.dataset.flag }; S.tab = "ledger"; render(); });
  $$("[data-go]", v).forEach(el => el.onclick = () => { const [tp, st] = el.dataset.go.split("|"); S.filter = { type: tp, status: st, vendor: "", q: "", flag: "" }; S.tab = "ledger"; render(); });
  $$("tr[data-q]", v).forEach(el => el.onclick = () => { S.filter = { type: "", status: "", vendor: "", q: el.dataset.q, flag: "" }; S.tab = "ledger"; render(); });
}

// ---------------- 배차 요청 등록 ----------------
function placeOptions(kinds) { return S.refs.places.filter(p => p.active && (!kinds || kinds.includes(p.kind))).map(p => `<option value="${esc(p.name)}">`).join(""); }
function vendorOptions(type, sel) { return `<option value="">업체 미지정(맡을 수 있는 업체 모두에게 보임)</option>` + S.refs.vendors.filter(v => v.active && v.types.includes(type)).map(v => `<option value="${v.id}" ${v.id === sel ? "selected" : ""}>${esc(v.name)}</option>`).join(""); }
function viewNew(v) {
  const t = S.newType;
  const tomorrow = addDays(today(), 1);
  const common = `
    <div class="fields">
      <div class="field"><label for="n-date">운행일</label><input id="n-date" type="date" value="${tomorrow}" required></div>
      ${t !== "delivery" ? `<div class="field"><label for="n-slot">시간대</label><select id="n-slot"><option value="">-</option>${SLOTS.map(s => `<option>${s}</option>`).join("")}</select></div>` : ""}
      <div class="field"><label for="n-vendor">업체</label><select id="n-vendor">${vendorOptions(t, S.refs.vendors.find(x => x.types.includes(t))?.id)}</select></div>
    </div>`;
  let body = "";
  if (t === "coupang") body = `${common}
    <div class="fields"><div class="field"><label for="n-from">상차지 (쿠팡 FC)</label><input id="n-from" list="dl-fc" placeholder="시흥3" required></div></div>
    <div><p class="sec-t">하차지별 수량 — 줄을 늘려 여러 대를 한 번에</p><div class="lines" id="lines"></div>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="add-line" type="button">+ 줄 추가</button>
      <details style="flex:1"><summary class="muted" style="cursor:pointer">시트에서 복사해 붙여넣기</summary>
        <div class="field" style="margin-top:8px"><label for="paste">시트의 줄을 그대로 붙여넣으세요 — '하차지 · PLT · 입차CODE' 세 칸, 또는 태성배차요청표(NO · 낙찰일 · 낙찰NO · FC · 도착지 · PLT · 출고일시 · 입차CODE)</label>
        <textarea id="paste" placeholder="광주센터	18	AFA25407BM"></textarea></div><button class="btn sm" id="do-paste" type="button">붙여넣은 줄 넣기</button></details></div></div>`;
  if (t === "center") body = `${common}
    <div class="fields">
      <div class="field"><label for="n-from">상차지</label><input id="n-from" list="dl-all" placeholder="인천 11번가" required></div>
      <div class="field"><label for="n-to">하차지</label><input id="n-to" list="dl-all" placeholder="진천센터" required></div>
      <div class="field"><label for="n-plt">파레트 수량</label><input id="n-plt" type="number" min="0" step="0.5" inputmode="decimal" placeholder="18"></div>
      <div class="field"><label for="n-temp">온도</label><select id="n-temp"><option>상온</option><option>냉장</option><option>냉동</option></select></div>
      <div class="field" style="grid-column:span 2"><label for="n-note">품목 · 특이사항 · 원하는 차종</label><input id="n-note" placeholder="신선 · 1톤 냉동탑 · 오전 하차"></div>
    </div>`;
  if (t === "delivery") body = `${common}
    <div class="fields">
      <div class="field"><label for="d-order">주문일</label><input id="d-order" type="date" value="${today()}"></div>
      <div class="field"><label for="d-store">출고 매장</label><input id="d-store" list="dl-store" required></div>
      <div class="field"><label for="d-name">주문자</label><input id="d-name" autocomplete="off"></div>
      <div class="field"><label for="d-phone">배송지 연락처</label><input id="d-phone" type="tel" inputmode="tel" placeholder="010-"></div>
      <div class="field" style="grid-column:1 / -1"><label for="d-addr">배송지 주소</label><input id="d-addr"></div>
      <div class="field"><label for="d-prod">제품</label><input id="d-prod" placeholder="양문형냉장고"></div>
      <div class="field"><label for="d-qty">수량</label><input id="d-qty" placeholder="1 · 2PLT"></div>
      <div class="field"><label for="d-terms">배송 조건</label><select id="d-terms"><option>무료</option><option>유료</option><option>무료(추가요금)</option></select></div>
    </div>`;
  v.innerHTML = `<div class="grid">
    <div class="types" role="group" aria-label="요청 유형">${Object.entries(TYPES).map(([k, x]) => `<button class="type-card" data-t="${k}" aria-pressed="${k === t}"><b>${typeTag(k)} ${esc(x.label)}</b><span>${esc(x.desc)}</span></button>`).join("")}</div>
    <form class="card" id="nf"><h2>${esc(TYPES[t].label)} 배차 요청</h2><p class="sub">킹콩이 채우는 칸만 있습니다. 기사 · 차량 · 금액은 업체가 휴대폰으로 채웁니다.</p>
      <div class="grid">${body}</div>
      <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn primary" type="submit">요청 등록</button></div></form>
    <datalist id="dl-fc">${placeOptions(["쿠팡FC"])}</datalist><datalist id="dl-all">${placeOptions()}</datalist><datalist id="dl-store">${placeOptions(["매장"])}</datalist><datalist id="dl-to">${placeOptions(["센터", "매장"])}</datalist>
  </div>`;
  $$(".type-card", v).forEach(b => b.onclick = () => { S.newType = b.dataset.t; viewNew(v); });
  if (t === "coupang") {
    const add = (to = "", plt = "", code = "") => { const div = document.createElement("div"); div.className = "line";
      div.innerHTML = `<div class="field"><label>하차지</label><input class="l-to" list="dl-to" value="${esc(to)}" required></div><div class="field"><label>PLT</label><input class="l-plt" type="number" inputmode="decimal" value="${esc(plt)}"></div><div class="field f-code"><label>입차CODE · Group</label><input class="l-code" value="${esc(code)}"></div><button type="button" class="btn ghost sm" aria-label="이 줄 지우기">✕</button>`;
      div.querySelector("button").onclick = () => div.remove(); $("#lines").appendChild(div); };
    add(); $("#add-line").onclick = () => add();
    $("#do-paste").onclick = () => {
      const lines = $("#paste").value.split(/\r?\n/).map(l => l.split("\t").map(x => x.trim())).filter(c => c.some(Boolean));
      if (!lines.length) return; $("#lines").innerHTML = ""; let n = 0;
      lines.forEach(c => { if (c.length >= 8) { if (!$("#n-from").value) $("#n-from").value = c[3]; add(c[4], c[5], c[7] + (c[8] ? " / " + c[8] : "")); n++; } else if (c.length >= 2 && !isNaN(+c[1])) { add(c[0], c[1], c[2] || ""); n++; } });
      toast(`${n}줄을 넣었습니다`);
    };
  }
  $("#nf").onsubmit = async e => {
    e.preventDefault();
    const base = { type: t, status: "requested", origin: "kingkong", run_date: $("#n-date").value, time_slot: $("#n-slot")?.value || "", vendor_id: $("#n-vendor").value || null, requested_by: S.user.name || S.user.email, temp: "상온", extra_fare: 0 };
    const rows = [];
    if (t === "coupang") $$("#lines .line").forEach(l => { const to = $(".l-to", l).value.trim(); if (to) rows.push({ ...base, from_place: $("#n-from").value.trim(), to_place: to, plt_qty: numOrNull($(".l-plt", l).value), ref_code: $(".l-code", l).value.trim() }); });
    if (t === "center") rows.push({ ...base, from_place: $("#n-from").value.trim(), to_place: $("#n-to").value.trim(), plt_qty: numOrNull($("#n-plt").value), temp: $("#n-temp").value, cargo_note: $("#n-note").value.trim() });
    if (t === "delivery") rows.push({ ...base, from_place: $("#d-store").value.trim(), to_place: "고객", cargo_note: $("#d-prod").value.trim(),
      delivery: { order_date: $("#d-order").value, store: $("#d-store").value.trim(), customer_name: $("#d-name").value.trim(), customer_phone: $("#d-phone").value.trim(), address: $("#d-addr").value.trim(), product: $("#d-prod").value.trim(), qty: $("#d-qty").value.trim(), terms: $("#d-terms").value, done_note: "" } });
    if (!rows.length || rows.some(r => !r.from_place || !r.to_place || !r.run_date)) return toast("상차지 · 하차지 · 운행일을 채워 주세요");
    try { for (const r of rows) await Admin.save(r, S.user.email); toast(`${rows.length}건 요청을 등록했습니다 — 업체 화면에 바로 보입니다`); S.month = rows[0].run_date.slice(0, 7); S.tab = "ledger"; S.filter = { type: t, status: "requested", vendor: "", q: "", flag: "" }; await reload(); }
    catch (err) { toast("저장 실패: " + err.message); }
  };
}

// ---------------- 통합 대장 ----------------
function filtered() {
  const f = S.filter, t = today();
  return S.rows.filter(d => {
    if (f.type && d.type !== f.type) return false;
    if (f.status && d.status !== f.status) return false;
    if (f.vendor && (f.vendor === "none" ? d.vendor_id : d.vendor_id !== f.vendor)) return false;
    if (f.flag === "waiting" && !(d.status === "requested" && d.run_date <= addDays(t, 1))) return false;
    if (f.flag === "nofare" && !(["assigned", "done"].includes(d.status) && !d.base_fare && d.run_date < t)) return false;
    if (f.flag === "over" && !(d.rate_fare && d.base_fare && billed(d) > d.rate_fare)) return false;
    if (f.flag === "vendor" && !(d.origin === "vendor" && d.status === "done")) return false;
    if (f.q) { const s = [d.from_place, d.to_place, d.driver_name, d.vehicle_no, d.ref_code, d.cargo_note, d.delivery?.customer_name, d.delivery?.address, d.delivery?.product].join(" "); if (!s.includes(f.q)) return false; }
    return true;
  });
}
function viewLedger(v) {
  const f = S.filter;
  const flagNames = { waiting: "배차 대기", nofare: "금액 미입력", over: "운임표 초과", vendor: "업체 직접 등록" };
  v.innerHTML = `<div class="grid">
    <div class="card" style="padding:14px">
      <div class="row">
        <div class="field" style="min-width:140px"><label for="f-type">유형</label><select id="f-type"><option value="">전체</option>${Object.entries(TYPES).map(([k, x]) => `<option value="${k}" ${f.type === k ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select></div>
        <div class="field" style="min-width:130px"><label for="f-st">상태</label><select id="f-st"><option value="">전체</option>${Object.entries(STATUS).map(([k, x]) => `<option value="${k}" ${f.status === k ? "selected" : ""}>${x}</option>`).join("")}</select></div>
        <div class="field" style="min-width:150px"><label for="f-v">업체</label><select id="f-v"><option value="">전체</option><option value="none" ${f.vendor === "none" ? "selected" : ""}>미지정</option>${S.refs.vendors.map(x => `<option value="${x.id}" ${f.vendor === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></div>
        <div class="field" style="flex:1;min-width:180px"><label for="f-q">검색 (지점 · 기사 · 차량 · 고객 · 입차CODE)</label><input id="f-q" type="search" value="${esc(f.q)}"></div>
        ${f.flag ? `<button class="btn sm" id="f-clear" style="align-self:end">✕ ${flagNames[f.flag]}만 보는 중</button>` : ""}
        <button class="btn sm" id="f-csv" style="align-self:end">CSV 내려받기</button>
      </div>
    </div>
    <div id="tbl"></div>
  </div>`;
  const draw = () => {
    const L = filtered();
    const tot = L.reduce((a, d) => a + billed(d), 0), ret = L.reduce((a, d) => a + (+d.return_fare || 0), 0);
    $("#tbl").innerHTML = L.length ? `<div class="row" style="justify-content:space-between;margin:0 0 8px"><span class="muted">${L.length}건 · 청구 ${won(tot)}원${ret ? ` · 회차 ${won(ret)}원` : ""}</span>
      <span class="row" style="gap:6px"><button class="btn sm" id="bulk-done">선택 → 운행 완료</button><button class="btn sm" id="bulk-cancel">선택 → 취소</button></span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th><input type="checkbox" id="ck-all" aria-label="모두 선택"></th><th>운행일</th><th>유형</th><th>상태</th><th>상차지</th><th>하차지</th><th class="r">PLT</th><th>업체</th><th>기사</th><th>차량</th><th class="r">톤</th><th class="r">기본</th><th class="r">추가</th><th class="r">청구</th><th class="r">운임표 차액</th><th>메모</th></tr></thead>
      <tbody>${L.map(d => { const df = d.rate_fare && d.base_fare ? billed(d) - d.rate_fare : null; return `<tr data-id="${d.id}">
        <td onclick="event.stopPropagation()"><input type="checkbox" class="ck" value="${d.id}" aria-label="선택"></td>
        <td class="num">${dLabel(d.run_date)}${d.time_slot ? ` <span class="muted">${esc(d.time_slot)}</span>` : ""}</td><td>${typeTag(d.type)}</td><td>${stTag(d.status)}${d.origin === "vendor" ? '<span class="flag">업체 등록</span>' : ""}</td>
        <td>${esc(d.from_place)}</td><td>${esc(d.type === "delivery" ? (d.delivery?.address || "고객") : d.to_place)}</td><td class="r num">${d.plt_qty ?? ""}${d.temp && d.temp !== "상온" ? ` <span class="muted">${esc(d.temp)}</span>` : ""}</td>
        <td>${esc(vName(d.vendor_id))}</td><td>${esc(d.driver_name || "")}</td><td class="num">${esc(d.vehicle_no || "")}</td><td class="r num">${d.vehicle_ton ?? ""}${d.vehicle_body ? `<span class="muted"> ${esc(d.vehicle_body)}</span>` : ""}</td>
        <td class="r num">${won(d.base_fare)}</td><td class="r num">${d.extra_fare ? won(d.extra_fare) : ""}</td><td class="r num"><b>${d.base_fare ? won(billed(d)) : ""}</b></td>
        <td class="r num ${df > 0 ? "diff-up" : ""}">${df == null ? "" : (df > 0 ? "▲" : df < 0 ? "▼" : "") + won(Math.abs(df))}</td><td class="muted">${esc(d.extra_reason || d.cargo_note || d.delivery?.product || "")}</td></tr>`; }).join("")}</tbody>
      <tfoot><tr><td colspan="13">합계 ${L.length}건</td><td class="r num">${won(tot)}</td><td colspan="2"></td></tr></tfoot></table></div>` : `<div class="card empty">조건에 맞는 배차가 없습니다</div>`;
    $$("#tbl tbody tr").forEach(tr => tr.onclick = () => openEdit(S.rows.find(d => d.id === +tr.dataset.id)));
    const all = $("#ck-all"); if (all) all.onchange = () => $$(".ck").forEach(c => c.checked = all.checked);
    const bulk = async st => { const ids = $$(".ck:checked").map(c => +c.value); if (!ids.length) return toast("줄을 먼저 고르세요"); await Admin.setStatus(ids, st, S.user.email); toast(`${ids.length}건 → ${STATUS[st]}`); await reload(); };
    const bd = $("#bulk-done"); if (bd) { bd.onclick = () => bulk("done"); $("#bulk-cancel").onclick = () => bulk("canceled"); }
  };
  draw();
  $("#f-type").onchange = e => { f.type = e.target.value; draw(); };
  $("#f-st").onchange = e => { f.status = e.target.value; draw(); };
  $("#f-v").onchange = e => { f.vendor = e.target.value; draw(); };
  $("#f-q").oninput = e => { f.q = e.target.value.trim(); draw(); };
  const fc = $("#f-clear"); if (fc) fc.onclick = () => { f.flag = ""; viewLedger(v); };
  $("#f-csv").onclick = () => downloadCsv(filtered(), `통합대장_${S.month}.csv`);
}
function downloadCsv(L, name) {
  const cols = [["운행일", d => d.run_date], ["유형", d => TYPES[d.type].label], ["상태", d => STATUS[d.status]], ["업체", d => vName(d.vendor_id)], ["상차지", d => d.from_place], ["하차지", d => d.to_place], ["PLT", d => d.plt_qty], ["온도", d => d.temp],
    ["입차CODE", d => d.ref_code], ["기사", d => d.driver_name], ["차량번호", d => d.vehicle_no], ["톤수", d => d.vehicle_ton], ["차종", d => d.vehicle_body], ["기본운임", d => d.base_fare], ["추가운임", d => d.extra_fare], ["추가 사유", d => d.extra_reason],
    ["청구금액", d => d.base_fare ? billed(d) : ""], ["운임표", d => d.rate_fare], ["회차일", d => d.return_date], ["회차 상차지", d => d.return_from], ["회차 기사", d => d.return_driver], ["회차금액", d => d.return_fare],
    ["주문자", d => d.delivery?.customer_name], ["연락처", d => d.delivery?.customer_phone], ["주소", d => d.delivery?.address], ["제품", d => d.delivery?.product], ["배송조건", d => d.delivery?.terms], ["완료 메모", d => d.delivery?.done_note], ["메모", d => d.cargo_note]];
  const q = v => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const csv = "﻿" + [cols.map(c => c[0]).join(","), ...L.map(d => cols.map(c => q(c[1](d))).join(","))].join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------- 편집 서랍(관리자) ----------------
async function openEdit(d) {
  const x = JSON.parse(JSON.stringify(d)); x.delivery ||= (d.type === "delivery" ? {} : undefined);
  const bg = document.createElement("div"); bg.className = "drawer-bg";
  const dr = document.createElement("aside"); dr.className = "drawer"; dr.setAttribute("role", "dialog"); dr.setAttribute("aria-label", "배차 상세");
  const fld = (id, label, val, type = "text", extra = "") => `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(val ?? "")}" ${extra}></div>`;
  dr.innerHTML = `<header><h3>#${d.id} ${typeTag(d.type)} ${esc(d.from_place)} → ${esc(d.to_place)}</h3><button class="btn ghost" id="x" aria-label="닫기">✕</button></header>
    <div class="body">
      <div><p class="sec-t">요청 (킹콩)</p><div class="fields">
        ${fld("e-date", "운행일", x.run_date, "date")}
        <div class="field"><label for="e-slot">시간대</label><select id="e-slot"><option value="">-</option>${SLOTS.map(s => `<option ${x.time_slot === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        ${fld("e-from", "상차지", x.from_place, "text", 'list="dl-e"')}${fld("e-to", "하차지", x.to_place, "text", 'list="dl-e"')}
        ${fld("e-plt", "PLT", x.plt_qty, "number", 'step="0.5"')}
        <div class="field"><label for="e-temp">온도</label><select id="e-temp">${["상온", "냉장", "냉동"].map(s => `<option ${x.temp === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        ${fld("e-code", "입차CODE · 참조", x.ref_code)}${fld("e-note", "품목 · 메모", x.cargo_note)}
        <div class="field"><label for="e-vendor">업체</label><select id="e-vendor">${vendorOptions(x.type, x.vendor_id)}</select></div>
        <div class="field"><label for="e-st">상태</label><select id="e-st">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${x.status === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      </div></div>
      ${x.type === "delivery" ? `<div><p class="sec-t">고객</p><div class="fields">
        ${fld("c-name", "주문자", x.delivery.customer_name)}${fld("c-phone", "연락처", x.delivery.customer_phone, "tel")}${fld("c-prod", "제품", x.delivery.product)}${fld("c-qty", "수량", x.delivery.qty)}
        <div class="field" style="grid-column:1 / -1"><label for="c-addr">주소</label><input id="c-addr" value="${esc(x.delivery.address || "")}"></div>
        ${fld("c-done", "완료 메모", x.delivery.done_note)}</div></div>` : ""}
      <div><p class="sec-t">배차 결과 (업체)</p><div class="fields">
        ${fld("e-drv", "기사", x.driver_name)}${fld("e-car", "차량번호", x.vehicle_no)}${fld("e-ton", "톤수", x.vehicle_ton, "number", 'step="0.1"')}${fld("e-body", "차종", x.vehicle_body)}
        ${fld("e-base", "기본운임", x.base_fare, "number")}${fld("e-extra", "추가운임", x.extra_fare, "number")}${fld("e-reason", "추가운임 사유", x.extra_reason)}
      </div><p class="hint">${d.rate_fare ? `운임표 기준 ${won(d.rate_fare)}원 · 지금 청구 ${won(billed(d))}원` : "맞는 운임표가 없습니다 — 설정 › 운임표에 추가하면 차액이 자동 계산됩니다"}</p></div>
      ${x.type === "coupang" ? `<div><p class="sec-t">회차</p><div class="fields">${fld("r-date", "회차일", x.return_date, "date")}${fld("r-from", "회차 상차지", x.return_from)}${fld("r-drv", "회차 기사", x.return_driver)}${fld("r-fare", "회차금액", x.return_fare, "number")}</div></div>` : ""}
      <div><p class="sec-t">수정 기록</p><div class="log" id="log">불러오는 중…</div></div>
      <datalist id="dl-e">${placeOptions()}</datalist>
    </div>
    <footer><button class="btn" id="cancel">닫기</button><button class="btn primary" id="save">저장</button></footer>`;
  document.body.append(bg, dr);
  const close = () => { bg.remove(); dr.remove(); };
  bg.onclick = close; $("#x", dr).onclick = close; $("#cancel", dr).onclick = close;
  document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", k); } });
  Admin.audit(d.id).then(L => { $("#log", dr).innerHTML = L.length ? L.map(a => `<div>${esc(String(a.at).slice(0, 16).replace("T", " "))} · ${esc(a.actor)} · ${esc(a.action)}</div>`).join("") : "기록 없음"; }).catch(() => { $("#log", dr).textContent = "-"; });
  $("#save", dr).onclick = async () => {
    const g = id => $("#" + id, dr)?.value;
    Object.assign(x, { run_date: g("e-date"), time_slot: g("e-slot"), from_place: g("e-from"), to_place: g("e-to"), plt_qty: numOrNull(g("e-plt")), temp: g("e-temp"), ref_code: g("e-code"), cargo_note: g("e-note"), vendor_id: g("e-vendor") || null, status: g("e-st"),
      driver_name: g("e-drv"), vehicle_no: g("e-car"), vehicle_ton: numOrNull(g("e-ton")), vehicle_body: g("e-body"), base_fare: numOrNull(g("e-base")), extra_fare: numOrNull(g("e-extra")) || 0, extra_reason: g("e-reason") });
    if (x.type === "coupang") Object.assign(x, { return_date: g("r-date") || null, return_from: g("r-from"), return_driver: g("r-drv"), return_fare: numOrNull(g("r-fare")) });
    if (x.type === "delivery") Object.assign(x.delivery, { customer_name: g("c-name"), customer_phone: g("c-phone"), product: g("c-prod"), qty: g("c-qty"), address: g("c-addr"), done_note: g("c-done") });
    if (x.origin === "vendor" && x.status === "done") x.origin = "vendor";   // 확인해도 업체 등록 표시는 남김
    try { await Admin.save(x, S.user.email); toast("저장했습니다"); close(); await reload(); } catch (e) { toast("저장 실패: " + e.message); }
  };
}

// ---------------- 정산 ----------------
async function viewSettle(v) {
  const R = S.rows.filter(d => ["done", "confirmed"].includes(d.status));
  const conf = await Admin.settlements(S.month).catch(() => []);
  const vendors = S.refs.vendors.filter(x => R.some(d => d.vendor_id === x.id));
  const card = vd => {
    const L = R.filter(d => d.vendor_id === vd.id);
    const sum = L.reduce((a, d) => a + billed(d) + (+d.return_fare || 0), 0);
    const missing = L.filter(d => !d.base_fare).length;
    const over = L.filter(d => d.rate_fare && d.base_fare && billed(d) > d.rate_fare);
    const vm = L.filter(d => d.origin === "vendor").length;
    const done = conf.find(s => s.vendor_id === vd.id);
    const byType = Object.keys(TYPES).map(tp => { const X = L.filter(d => d.type === tp); return X.length ? `<tr><td>${typeTag(tp)}</td><td class="r num">${X.length}</td><td class="r num">${won(X.reduce((a, d) => a + billed(d) + (+d.return_fare || 0), 0))}</td></tr>` : ""; }).join("");
    return `<div class="card"><div class="row" style="justify-content:space-between"><h2>${esc(vd.name)}</h2>${done ? `<span class="st confirmed">정산 확정 ${esc(String(done.confirmed_at).slice(0, 10))}</span>` : `<span class="st done">확정 전</span>`}</div>
      <p class="sub">${+S.month.slice(5)}월 운행 완료 ${L.length}건</p>
      <div class="kpis" style="grid-template-columns:repeat(3,1fr)"><div class="kpi"><div class="l">공급가액</div><div class="v num">${won(sum)}</div></div><div class="kpi"><div class="l">세액 10%</div><div class="v num">${won(sum * 0.1)}</div></div><div class="kpi"><div class="l">합계금액</div><div class="v num">${won(sum * 1.1)}</div></div></div>
      <div class="tbl-wrap" style="margin-top:12px;max-height:none"><table class="tbl"><thead><tr><th>유형</th><th class="r">건수</th><th class="r">금액(원)</th></tr></thead><tbody>${byType}</tbody></table></div>
      <ul class="alerts" style="padding-left:18px;font-size:13.5px">
        ${missing ? `<li style="color:var(--bad)">금액이 빈 운행 ${missing}건 — 업체 입력 필요</li>` : ""}
        ${over.length ? `<li style="color:var(--warn)">운임표보다 비싼 청구 ${over.length}건 · ${won(over.reduce((a, d) => a + billed(d) - d.rate_fare, 0))}원 — 사유 확인</li>` : ""}
        ${vm ? `<li>업체가 직접 올린 운행 ${vm}건 포함</li>` : ""}
        ${!missing && !over.length ? `<li style="color:var(--good)">검증 문제 없음</li>` : ""}
      </ul>
      <div class="row" style="justify-content:flex-end"><button class="btn sm" data-csv="${vd.id}">운행내역서 CSV</button><button class="btn primary sm" data-conf="${vd.id}" ${missing ? "disabled title='금액이 빈 건을 먼저 채워 주세요'" : ""}>${done ? "다시 확정" : "정산 확정"}</button></div></div>`;
  };
  v.innerHTML = `<div class="grid"><div class="card"><h2>${S.month.replace("-", "년 ")}월 정산</h2><p class="sub">운행 완료 · 정산 확정 건만 셉니다(청구금액 = 기본 + 추가, 회차 포함). 확정하면 그 건은 업체가 고칠 수 없습니다.</p></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(360px,1fr))">${vendors.map(card).join("") || `<div class="card empty">이 달 운행 완료 건이 없습니다</div>`}</div></div>`;
  $$("[data-csv]", v).forEach(b => b.onclick = () => { const vd = S.refs.vendors.find(x => x.id === b.dataset.csv); downloadCsv(R.filter(d => d.vendor_id === vd.id).sort((a, c) => a.run_date.localeCompare(c.run_date)), `${vd.name}_운행내역서_${S.month}.csv`); });
  $$("[data-conf]", v).forEach(b => b.onclick = async () => {
    const vd = S.refs.vendors.find(x => x.id === b.dataset.conf); const L = R.filter(d => d.vendor_id === vd.id);
    const sum = L.reduce((a, d) => a + billed(d) + (+d.return_fare || 0), 0);
    if (!confirm(`${vd.name} ${S.month} ${L.length}건 · 공급가액 ${won(sum)}원을 확정할까요?`)) return;
    await Admin.confirmSettlement(vd.id, S.month, sum, L.map(d => d.id), S.user.email); toast("정산을 확정했습니다"); await reload();
  });
}

// ---------------- 설정 ----------------
function viewSetup(v) {
  const base = location.href.split(/[?#]/)[0];
  const vRows = S.refs.vendors.map(x => `<tr><td><b>${esc(x.name)}</b></td><td>${x.types.map(typeTag).join(" ")}</td><td>${LIVE ? '<span class="muted">SQL로 관리</span>' : `<span class="num">${esc(x.pin)}</span>`}</td>
    <td><input readonly value="${esc(base + "?v=" + encodeURIComponent(x.name))}" style="width:100%;border:1px solid var(--line);border-radius:7px;padding:5px 7px;background:var(--panel2)" onclick="this.select()"></td>
    <td class="row" style="gap:6px;flex-wrap:nowrap"><a class="btn sm" href="${esc(base + "?v=" + encodeURIComponent(x.name))}" target="_blank" rel="noopener">새 창</a><button class="btn sm" data-vprev="${esc(x.name)}">이 창에서 보기</button></td></tr>`).join("");
  const pRows = S.refs.places.map(p => `<tr><td>${esc(p.name)}</td><td>${esc(p.kind)}</td><td class="muted">${esc((p.aliases || []).join(", "))}</td><td class="r"><button class="btn ghost sm danger" data-delp="${p.id}" aria-label="${esc(p.name)} 지우기">✕</button></td></tr>`).join("");
  const rRows = S.refs.rates.map(r => `<tr><td>${esc(vName(r.vendor_id))}</td><td>${typeTag(r.type)}</td><td>${esc(r.from_place || "어디서든")}</td><td>${esc(r.to_place || "어디로든")}</td><td class="r">${r.vehicle_ton ?? "무관"}</td><td class="r num"><b>${won(r.base_fare)}</b></td><td class="muted">${esc(r.note || "")}</td><td class="r"><button class="btn ghost sm danger" data-delr="${r.id}" aria-label="운임 지우기">✕</button></td></tr>`).join("");
  v.innerHTML = `<div class="grid">
    <div class="card"><h2>업체 · 접속 링크</h2><p class="sub">업체에 <b>링크 + PIN</b>을 보내면 휴대폰에서 로그인 없이 바로 입력합니다. 링크는 업체마다 다르고, PIN이 맞아야 열립니다.</p>
      <div class="tbl-wrap" style="max-height:none"><table class="tbl"><thead><tr><th>업체</th><th>맡는 유형</th><th>PIN</th><th>접속 링크</th><th></th></tr></thead><tbody>${vRows}</tbody></table></div></div>
    <div class="card"><h2>운임표</h2><p class="sub">청구금액을 이 표와 비교해 '운임표 초과'를 자동으로 잡습니다. 칸을 비우면 '무관'(더 구체적인 줄이 먼저 적용).</p>
      <div class="tbl-wrap" style="max-height:none"><table class="tbl"><thead><tr><th>업체</th><th>유형</th><th>상차지</th><th>하차지</th><th class="r">톤</th><th class="r">기본운임</th><th>메모</th><th></th></tr></thead><tbody>${rRows}</tbody></table></div>
      <form class="row" id="rf" style="margin-top:10px;align-items:end">
        <div class="field"><label for="rf-v">업체</label><select id="rf-v">${S.refs.vendors.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></div>
        <div class="field"><label for="rf-t">유형</label><select id="rf-t">${Object.entries(TYPES).map(([k, x]) => `<option value="${k}">${esc(x.short)}</option>`).join("")}</select></div>
        <div class="field"><label for="rf-f">상차지</label><input id="rf-f" list="dl-s"></div><div class="field"><label for="rf-to">하차지</label><input id="rf-to" list="dl-s"></div>
        <div class="field" style="width:90px"><label for="rf-ton">톤</label><input id="rf-ton" type="number" step="0.1"></div><div class="field" style="width:130px"><label for="rf-fare">기본운임</label><input id="rf-fare" type="number" required></div>
        <button class="btn primary" type="submit">추가</button></form></div>
    <div class="card"><h2>지점 · 별칭</h2><p class="sub">같은 곳을 다르게 적은 이름(별칭)을 묶어 지점별 비용이 한 줄로 모이게 합니다.</p>
      <div class="tbl-wrap" style="max-height:340px"><table class="tbl"><thead><tr><th>표준 이름</th><th>종류</th><th>별칭</th><th></th></tr></thead><tbody>${pRows}</tbody></table></div>
      <form class="row" id="pf" style="margin-top:10px;align-items:end"><div class="field"><label for="pf-n">이름</label><input id="pf-n" required></div>
        <div class="field"><label for="pf-k">종류</label><select id="pf-k">${["쿠팡FC", "센터", "매장", "외부업체", "기타"].map(k => `<option>${k}</option>`).join("")}</select></div>
        <div class="field" style="flex:1"><label for="pf-a">별칭(쉼표로)</label><input id="pf-a"></div><button class="btn primary" type="submit">추가</button></form></div>
    ${LIVE ? "" : `<div class="card"><h2>데모 데이터</h2><p class="sub">이 브라우저에만 저장된 예시 데이터입니다. 처음 상태로 되돌릴 수 있습니다.</p><button class="btn danger" id="reset">예시 데이터 초기화</button></div>`}
    <datalist id="dl-s">${placeOptions()}</datalist></div>`;
  $("#rf").onsubmit = async e => { e.preventDefault(); await Admin.saveRef("rates", { vendor_id: $("#rf-v").value, type: $("#rf-t").value, from_place: $("#rf-f").value.trim() || null, to_place: $("#rf-to").value.trim() || null, vehicle_ton: numOrNull($("#rf-ton").value), base_fare: +$("#rf-fare").value, note: "" }); toast("운임표에 추가했습니다"); await reload(); };
  $("#pf").onsubmit = async e => { e.preventDefault(); await Admin.saveRef("places", { name: $("#pf-n").value.trim(), kind: $("#pf-k").value, aliases: $("#pf-a").value.split(",").map(s => s.trim()).filter(Boolean), active: true }); toast("지점을 추가했습니다"); await reload(); };
  $$("[data-delp]", v).forEach(b => b.onclick = async () => { await Admin.removeRef("places", b.dataset.delp); await reload(); });
  $$("[data-delr]", v).forEach(b => b.onclick = async () => { await Admin.removeRef("rates", b.dataset.delr); await reload(); });
  $$("[data-vprev]", v).forEach(b => b.onclick = () => { location.hash = "v=" + encodeURIComponent(b.dataset.vprev); location.reload(); });
  const rs = $("#reset"); if (rs) rs.onclick = async () => { if (confirm("예시 데이터를 처음 상태로 되돌릴까요?")) { Demo.reset(); await reload(); } };
}

// =====================================================================
//  업체(모바일) 화면 — 링크 + PIN
// =====================================================================
const V = { tab: "todo", day: "all", rows: [], refs: { places: [], rates: [] } };
async function vendorBoot(name) {
  let saved = null; try { saved = sessionStorage.getItem("kk_vpin_" + name); } catch (_) {}
  if (saved) { try { await Vendor.login(name, saved); return vendorLoad(); } catch (_) {} }
  app.innerHTML = `<div class="pin"><div class="card"><div class="brand" style="justify-content:center;margin-bottom:6px"><span class="logo" aria-hidden="true">K</span></div>
    <h2>${esc(name)}</h2><p class="sub">킹콩백화점 배차 입력 · PIN 4자리를 넣어 주세요${LIVE ? "" : "<br><span class='muted'>(데모: 태성로지스틱스 2580 · 더한물류 1357)</span>"}</p>
    <form id="pf"><div class="field"><label for="pin" class="hidden">PIN</label><input id="pin" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus aria-label="PIN"></div>
    <button class="btn primary" style="width:100%;margin-top:12px;min-height:52px;font-size:17px" type="submit">들어가기</button></form><p class="hint" id="err" role="alert"></p></div></div>`;
  $("#pf").onsubmit = async e => { e.preventDefault(); try { await Vendor.login(name, $("#pin").value.trim()); vendorLoad(); } catch (err) { $("#err").textContent = err.message; } };
}
async function vendorLoad() {
  try { [V.rows, V.refs] = await Promise.all([Vendor.list(), Vendor.refs()]); } catch (e) { app.innerHTML = `<div class="empty">불러오기 실패: ${esc(e.message)}</div>`; return; }
  vendorRender();
}
const needsInput = d => d.status === "requested" || (d.status === "assigned" && !d.base_fare) || (["assigned", "done"].includes(d.status) && !d.driver_name);
function vendorRender() {
  const t = today();
  const todo = V.rows.filter(needsInput), mine = V.rows.filter(d => !needsInput(d));
  const L0 = V.tab === "todo" ? todo : V.tab === "done" ? mine : V.rows;
  const dayOk = d => V.day === "all" || (V.day === "today" ? d.run_date === t : V.day === "tomorrow" ? d.run_date === addDays(t, 1) : V.day === "past" ? d.run_date < t : d.run_date > addDays(t, 1));
  const L = L0.filter(dayOk);
  const groups = {}; L.forEach(d => (groups[d.run_date] ||= []).push(d));
  const dates = Object.keys(groups).sort((a, b) => V.tab === "todo" ? a.localeCompare(b) : b.localeCompare(a));
  const monthSum = V.rows.filter(d => monthOf(d.run_date) === t.slice(0, 7) && d.base_fare).reduce((a, d) => a + billed(d) + (+d.return_fare || 0), 0);
  app.innerHTML = `<div class="m">
    <div class="m-head"><div class="who">킹콩백화점 배차 · ${esc(Vendor.name)}${LIVE ? "" : " · 데모"}</div>
      <div class="ttl">${todo.length ? `입력할 배차 ${todo.length}건` : "입력할 배차가 없습니다"}</div>
      <div class="who">이번 달 청구 ${won(monthSum)}원${!LIVE && location.hash.includes("v=") ? ` · <a href="#" id="to-admin" style="color:inherit">관리자 화면으로</a>` : ""}</div>
      <div class="m-tabs" role="group" aria-label="보기">${[["todo", `입력 필요 ${todo.length}`], ["done", `입력 완료 ${mine.length}`], ["all", "전체"]].map(([k, l]) => `<button data-vt="${k}" aria-pressed="${V.tab === k}">${l}</button>`).join("")}</div></div>
    <div class="m-days" role="group" aria-label="날짜">${[["all", "전체"], ["today", "오늘"], ["tomorrow", "내일"], ["later", "모레 이후"], ["past", "지난 운행"]].map(([k, l]) => `<button data-vd="${k}" aria-pressed="${V.day === k}">${l}</button>`).join("")}</div>
    <div class="m-list">${dates.length ? dates.map(dd => `<div class="m-date">${dLabel(dd)}${dd === t ? " · 오늘" : dd === addDays(t, 1) ? " · 내일" : ""}</div>` + groups[dd].map(cardHtml).join("")).join("") : `<div class="empty">해당하는 배차가 없습니다</div>`}</div>
    <button class="fab" id="fab">+ 요청 없이 운행한 건 추가</button></div>`;
  $$("[data-vt]").forEach(b => b.onclick = () => { V.tab = b.dataset.vt; vendorRender(); });
  $$("[data-vd]").forEach(b => b.onclick = () => { V.day = b.dataset.vd; vendorRender(); });
  $$(".m-card").forEach(b => b.onclick = () => openSheet(V.rows.find(d => d.id === +b.dataset.id)));
  $("#fab").onclick = () => openSheet(null);
  const ta = $("#to-admin"); if (ta) ta.onclick = e => { e.preventDefault(); location.hash = ""; location.reload(); };
}
function cardHtml(d) {
  const to = d.type === "delivery" ? (d.delivery?.address || "고객") : d.to_place;
  return `<button class="m-card t-${d.type}" data-id="${d.id}">
    <div class="row" style="justify-content:space-between">${typeTag(d.type)}${needsInput(d) ? `<span class="need">입력 필요</span>` : stTag(d.status)}</div>
    <div class="route">${esc(d.from_place)} <span class="arw">→</span> ${esc(to)}</div>
    <div class="meta">${d.time_slot ? `<span>${esc(d.time_slot)}</span>` : ""}${d.plt_qty != null ? `<span>${d.plt_qty} PLT</span>` : ""}${d.temp && d.temp !== "상온" ? `<span>${esc(d.temp)}</span>` : ""}${d.type === "delivery" ? `<span>${esc(d.delivery?.product || "")} ${esc(d.delivery?.qty || "")}</span>` : ""}${d.cargo_note && d.type !== "delivery" ? `<span>${esc(d.cargo_note)}</span>` : ""}</div>
    ${d.driver_name ? `<div class="meta"><span>${esc(d.driver_name)}</span><span>${esc(d.vehicle_no || "")}</span><span>${d.vehicle_ton ? d.vehicle_ton + "톤" : ""}${esc(d.vehicle_body || "")}</span>${d.base_fare ? `<span class="amt">${won(billed(d))}원</span>` : ""}</div>` : ""}
  </button>`;
}
function rateHint(d) {
  const R = V.refs.rates || [];
  const c = R.filter(r => r.type === d.type && (!r.from_place || r.from_place === d.from_place) && (!r.to_place || r.to_place === d.to_place) && (r.vehicle_ton == null || +r.vehicle_ton === +d.vehicle_ton));
  c.sort((a, b) => [b.from_place, b.to_place, b.vehicle_ton].filter(x => x != null).length - [a.from_place, a.to_place, a.vehicle_ton].filter(x => x != null).length);
  return c[0] ? +c[0].base_fare : null;
}
function recentDrivers() {
  const m = new Map();
  V.rows.filter(d => d.driver_name).sort((a, b) => b.run_date.localeCompare(a.run_date)).forEach(d => { if (!m.has(d.driver_name)) m.set(d.driver_name, d); });
  return [...m.values()].slice(0, 30);
}
function openSheet(d0) {
  const isNew = !d0;
  const d = d0 ? JSON.parse(JSON.stringify(d0)) : { type: "center", run_date: today(), from_place: "", to_place: "", plt_qty: null, temp: "상온", extra_fare: 0 };
  const drivers = recentDrivers();
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "배차 입력");
  const locked = d.status === "confirmed";
  const chip = (group, val, cur, label) => `<button type="button" data-chip="${group}" data-val="${esc(val)}" aria-pressed="${String(cur) === String(val)}">${esc(label ?? val)}</button>`;
  el.innerHTML = `<header><button class="btn ghost" id="sx" aria-label="닫기">←</button><h3>${isNew ? "요청 없이 운행한 건 추가" : "배차 입력"}</h3>${d0 ? stTag(d.status) : ""}</header>
  <div class="body big">
    ${isNew ? `<div class="req-box"><div class="fields" style="grid-template-columns:1fr 1fr">
        <div class="field"><label for="s-type">유형</label><select id="s-type">${Object.entries(TYPES).filter(([k]) => k !== "delivery").map(([k, x]) => `<option value="${k}">${esc(x.short)}</option>`).join("")}</select></div>
        <div class="field"><label for="s-date">운행일</label><input id="s-date" type="date" value="${d.run_date}"></div>
        <div class="field"><label for="s-from">상차지</label><input id="s-from" list="dl-v"></div><div class="field"><label for="s-to">하차지</label><input id="s-to" list="dl-v"></div>
        <div class="field"><label for="s-plt">PLT</label><input id="s-plt" type="number" inputmode="decimal" step="0.5"></div>
        <div class="field"><label for="s-temp">온도</label><select id="s-temp"><option>상온</option><option>냉장</option><option>냉동</option></select></div></div>
        <p class="hint">킹콩 담당자가 확인한 뒤 정산에 들어갑니다.</p></div>`
      : `<div class="req-box">${typeTag(d.type)} <span class="muted">${dLabel(d.run_date)} ${esc(d.time_slot || "")}</span>
        <div class="route" style="margin-top:4px">${esc(d.from_place)} → ${esc(d.type === "delivery" ? "고객" : d.to_place)}</div>
        <div class="muted">${d.plt_qty != null ? d.plt_qty + " PLT · " : ""}${esc(d.temp || "")}${d.ref_code ? " · " + esc(d.ref_code) : ""}${d.cargo_note ? " · " + esc(d.cargo_note) : ""}</div>
        ${d.type === "delivery" && d.delivery ? `<div style="margin-top:8px;font-size:15px"><b>${esc(d.delivery.product || "")} ${esc(d.delivery.qty || "")}</b> · ${esc(d.delivery.terms || "")}<br>${esc(d.delivery.address || "")}<br>
          ${d.delivery.customer_phone ? `<a href="tel:${esc(d.delivery.customer_phone)}">${esc(d.delivery.customer_name || "고객")} ${esc(d.delivery.customer_phone)} 전화</a>` : ""}</div>` : ""}</div>`}
    ${locked ? `<p class="hint warn">정산이 확정된 건이라 고칠 수 없습니다.</p>` : ""}
    <div class="field"><label for="s-drv">기사 이름</label><input id="s-drv" list="dl-drv" value="${esc(d.driver_name || "")}" autocomplete="off" placeholder="이름을 쓰면 지난번 차량이 자동으로 채워집니다"></div>
    <datalist id="dl-drv">${drivers.map(x => `<option value="${esc(x.driver_name)}">${esc(x.vehicle_no || "")} ${x.vehicle_ton || ""}톤</option>`).join("")}</datalist>
    <div class="fields" style="grid-template-columns:1fr 1fr">
      <div class="field"><label for="s-car">차량번호</label><input id="s-car" value="${esc(d.vehicle_no || "")}" placeholder="경기89자1234"></div>
      <div class="field"><label for="s-tel">기사 연락처</label><input id="s-tel" type="tel" inputmode="tel" value="${esc(d.driver_phone || "")}" placeholder="010-"></div></div>
    <div><p class="sec-t">톤수</p><div class="chips" id="c-ton">${TONS.map(x => chip("ton", x, d.vehicle_ton, x + "톤")).join("")}</div></div>
    <div><p class="sec-t">차종</p><div class="chips" id="c-body">${BODIES.map(x => chip("body", x, d.vehicle_body)).join("")}</div></div>
    <div class="fields" style="grid-template-columns:1fr 1fr">
      <div class="field"><label for="s-base">기본운임 (원)</label><input id="s-base" type="number" inputmode="numeric" value="${d.base_fare ?? ""}"></div>
      <div class="field"><label for="s-extra">추가운임 (원)</label><input id="s-extra" type="number" inputmode="numeric" value="${d.extra_fare || ""}"></div></div>
    <p class="hint" id="rate-hint"></p>
    <div><p class="sec-t">추가운임 사유</p><div class="chips" id="c-reason">${EXTRA_REASONS.map(x => chip("reason", x, d.extra_reason)).join("")}</div>
      <div class="field" style="margin-top:8px"><label for="s-reason" class="hidden">사유 직접 입력</label><input id="s-reason" value="${esc(d.extra_reason || "")}" placeholder="직접 입력"></div></div>
    ${d.type === "coupang" ? `<details ${d.return_date ? "open" : ""}><summary class="sec-t" style="cursor:pointer">회차가 있었나요?</summary><div class="fields" style="grid-template-columns:1fr 1fr;margin-top:8px">
      <div class="field"><label for="s-rd">회차일</label><input id="s-rd" type="date" value="${d.return_date || ""}"></div><div class="field"><label for="s-rf">회차 상차지</label><input id="s-rf" value="${esc(d.return_from || "")}"></div>
      <div class="field"><label for="s-rdr">회차 기사</label><input id="s-rdr" value="${esc(d.return_driver || "")}"></div><div class="field"><label for="s-rfa">회차금액</label><input id="s-rfa" type="number" inputmode="numeric" value="${d.return_fare ?? ""}"></div></div></details>` : ""}
    ${d.type === "delivery" ? `<div class="field"><label for="s-done">배송 완료 메모</label><input id="s-done" value="${esc(d.delivery?.done_note || "")}" placeholder="6/24 완료 · 중문 탈거 후 안착"></div>` : ""}
    <div class="total"><span>청구금액</span><b class="num" id="s-total">0원</b></div>
    <datalist id="dl-v">${(V.refs.places || []).map(p => `<option value="${esc(p)}">`).join("")}</datalist>
  </div>
  <footer>${locked ? `<button class="btn" id="sx2">닫기</button>` : isNew ? `<button class="btn primary" id="s-done-btn">운행 등록</button>` : `<button class="btn" id="s-asg">배차 저장</button><button class="btn primary" id="s-done-btn">운행 완료</button>`}</footer>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  $("#sx", el).onclick = close; const s2 = $("#sx2", el); if (s2) s2.onclick = close;
  const val = id => $("#" + id, el)?.value ?? "";
  const cur = { ton: d.vehicle_ton, body: d.vehicle_body };
  const ctx = () => ({ type: isNew ? val("s-type") : d.type, from_place: isNew ? val("s-from") : d.from_place, to_place: isNew ? val("s-to") : d.to_place, vehicle_ton: cur.ton });
  const recalc = () => {
    const b = +val("s-base") || 0, x = +val("s-extra") || 0; $("#s-total", el).textContent = won(b + x) + "원";
    const r = rateHint(ctx()); const h = $("#rate-hint", el);
    h.className = "hint" + (r && b && b + x > r ? " warn" : "");
    h.textContent = r ? (b ? (b + x > r ? `운임표 ${won(r)}원보다 ${won(b + x - r)}원 많습니다 — 추가운임 사유를 꼭 적어 주세요` : `운임표 ${won(r)}원`) : `운임표 ${won(r)}원 — 누르면 기본운임에 넣습니다`) : "";
    h.onclick = () => { if (r && !b) { $("#s-base", el).value = r; recalc(); } };
  };
  $$("[data-chip]", el).forEach(b => b.onclick = () => {
    const g = b.dataset.chip, v2 = b.dataset.val;
    if (g === "reason") { const inp = $("#s-reason", el); inp.value = inp.value === v2 ? "" : v2; $$('[data-chip="reason"]', el).forEach(c => c.setAttribute("aria-pressed", String(c.dataset.val === inp.value))); return; }
    cur[g] = g === "ton" ? (cur.ton === +v2 ? null : +v2) : (cur.body === v2 ? null : v2);
    $$(`[data-chip="${g}"]`, el).forEach(c => c.setAttribute("aria-pressed", String(String(cur[g]) === c.dataset.val)));
    recalc();
  });
  $("#s-drv", el).onchange = () => { const p = drivers.find(x => x.driver_name === val("s-drv")); if (!p) return;
    if (!val("s-car")) $("#s-car", el).value = p.vehicle_no || ""; if (!val("s-tel")) $("#s-tel", el).value = p.driver_phone || "";
    if (cur.ton == null && p.vehicle_ton) { cur.ton = +p.vehicle_ton; $$('[data-chip="ton"]', el).forEach(c => c.setAttribute("aria-pressed", String(+c.dataset.val === cur.ton))); }
    if (!cur.body && p.vehicle_body) { cur.body = p.vehicle_body; $$('[data-chip="body"]', el).forEach(c => c.setAttribute("aria-pressed", String(c.dataset.val === cur.body))); }
    recalc(); };
  ["s-base", "s-extra", "s-from", "s-to", "s-type"].forEach(id => { const e2 = $("#" + id, el); if (e2) e2.oninput = recalc; });
  recalc();
  const collect = status => ({
    status, driver_name: val("s-drv").trim(), driver_phone: val("s-tel").trim(), vehicle_no: val("s-car").trim(), vehicle_ton: cur.ton, vehicle_body: cur.body || "",
    base_fare: numOrNull(val("s-base")), extra_fare: numOrNull(val("s-extra")) || 0, extra_reason: val("s-reason").trim(),
    ...(d.type === "coupang" ? { return_date: val("s-rd") || null, return_from: val("s-rf"), return_driver: val("s-rdr"), return_fare: numOrNull(val("s-rfa")) } : {}),
    ...(d.type === "delivery" ? { done_note: val("s-done") } : {}),
  });
  const submit = async status => {
    const p = collect(status);
    if (!p.driver_name) return toast("기사 이름을 넣어 주세요");
    if (status === "done" && !p.base_fare) return toast("운행 완료는 기본운임을 넣어야 합니다");
    const r = rateHint(ctx()); if (r && p.base_fare && p.base_fare + p.extra_fare > r && !p.extra_reason) return toast("운임표보다 많아요 — 추가운임 사유를 적어 주세요");
    try {
      if (isNew) { const n = { type: val("s-type"), run_date: val("s-date"), from_place: val("s-from").trim(), to_place: val("s-to").trim(), plt_qty: numOrNull(val("s-plt")), temp: val("s-temp"), cargo_note: "", ...p, status: "done" };
        if (!n.from_place || !n.to_place) return toast("상차지 · 하차지를 넣어 주세요"); await Vendor.add(n); }
      else await Vendor.save(d.id, p);
      toast(status === "done" ? "운행 완료로 저장했습니다" : "배차를 저장했습니다"); close(); vendorLoad();
    } catch (e) { toast(e.message); }
  };
  const a = $("#s-asg", el); if (a) a.onclick = () => submit("assigned");
  const dn = $("#s-done-btn", el); if (dn) dn.onclick = () => submit("done");
}

// 시작(모든 선언이 끝난 뒤)
if (vendorParam) vendorBoot(vendorParam); else adminBoot();
})();
