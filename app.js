/* =====================================================================
   킹콩백화점 통합 물류 배차 · 정산 — 프로토타입 (바닐라 JS, 빌드 없음)
   - 주소에 ?v=업체이름 → 업체(모바일) · ?s=매장이름 → 매장 배송요청(모바일) · 없으면 킹콩 관리자 화면
   - 카톡 · 엑셀 글을 그대로 붙여넣으면 요청 · 배차 · 취소 · 회차가 들어가고, 저장하면 모든 화면이 실시간으로 바뀜
   - config.js 가 비어 있으면 데모 모드(localStorage), 채우면 Supabase
   ===================================================================== */
(() => {
"use strict";
const BUILD = "4";             // 화면 오른쪽 위(관리자) · 맨 아래(휴대폰)에 보이는 빌드 번호 — 고칠 때마다 1씩 올림
const CFG = window.KK_CONFIG || {};
// 태성로지스틱스 · 태성물류 = 더한물류(같은 곳). 옛 링크 · 카톡 이름도 더한물류로
const VENDOR_ALIAS = { "태성로지스틱스": "더한물류", "태성물류": "더한물류", "태성": "더한물류" };
const vendorCanon = n => { if (!n) return n; for (const k of Object.keys(VENDOR_ALIAS)) if (n === k || n.startsWith(k)) return VENDOR_ALIAS[k]; return n; };
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
const FARE_KEYS = ["base_fare", "extra_fare", "extra_reason", "return_fare", "return_date", "return_driver", "return_from"];   // 더한물류만 입력 · 수정
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
const toast = msg => { document.querySelectorAll(".toast:not(.act)").forEach(x => x.remove()); const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2200); };
const typeTag = t => `<span class="tag t-${t}">${esc(TYPES[t]?.short || t)}</span>`;
const stTag = s => `<span class="st ${s}">${esc(STATUS[s] || s)}</span>`;
const monthOf = s => (s || "").slice(0, 7);

// =====================================================================
//  저장소 — 데모(localStorage) / Supabase 두 가지를 같은 함수 이름으로
// =====================================================================
const DEMO_KEY = "kk_dispatch_demo_v3";
function demoSeed() {
  const vendors = [
    { id: "v2", name: "더한물류", pin: "1357", types: ["coupang", "center", "delivery"], contact: "010-0000-2222", active: true },
  ];
  const places = [
    ["시흥3", "쿠팡FC"], ["여주2", "쿠팡FC"], ["인천37", "쿠팡FC"], ["용인5", "쿠팡FC"], ["성남2", "쿠팡FC"],
    ["진천센터", "센터"], ["광주센터", "센터"], ["이천센터", "센터"], ["기흥센터", "센터"], ["송파센터", "센터"], ["칠곡센터", "센터"],
    ["시그니처용인점", "매장"], ["이천점", "매장"], ["시그니처인천점", "매장"], ["경산2", "쿠팡FC"], ["고양3", "쿠팡FC"], ["부천1", "쿠팡FC"], ["김해점", "매장"], ["동김해점", "매장"], ["안중점", "매장"],
    ["남양주점", "매장"], ["아산점", "매장"], ["청주점", "매장"], ["경안점", "매장"], ["평택점", "매장"], ["기흥점", "매장"], ["양주점", "매장"],
    ["원주점", "매장"], ["충주점", "매장"], ["천안점", "매장"], ["수원점", "매장"], ["김포점", "매장"], ["동탄점", "매장"],
    ["부산제타", "외부업체"], ["화인통상", "외부업체"], ["인천 11번가", "외부업체"], ["창원컬리", "외부업체"],
  ].map(([name, kind], i) => ({ id: "p" + i, name, kind, aliases: name === "시그니처용인점" ? ["용인점"] : name === "시그니처인천점" ? ["인천점"] : [], active: true }));
  const stores = [{ id: "s1", name: "이천점", pin: "1111", active: true }, { id: "s2", name: "시그니처인천점", pin: "2222", active: true }, { id: "s3", name: "원주점", pin: "3333", active: true }];
  const rates = [
    { id: "r1", vendor_id: "v2", type: "coupang", from_place: null, to_place: "광주센터", vehicle_ton: null, base_fare: 200000, note: "쿠팡 FC → 광주센터" },
    { id: "r2", vendor_id: "v2", type: "coupang", from_place: null, to_place: "이천센터", vehicle_ton: null, base_fare: 190000, note: "" },
    { id: "r3", vendor_id: "v2", type: "coupang", from_place: null, to_place: null, vehicle_ton: 5, base_fare: 170000, note: "5톤 기본" },
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
      const d = { id: id++, type: "coupang", vendor_id: "v2", origin: "kingkong", run_date: day, time_slot: pick(["오전", "오후", "야간"]), from_place: pick(["시흥3", "여주2"]), to_place: to, plt_qty: plt, temp: "상온",
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
  // 오늘 요청 — 카톡 · 출고요청서 예시와 같은 건(업체 카톡 붙여넣기 연습용)
  const add = o => D.push({ id: id++, origin: "kingkong", temp: "상온", extra_fare: 0, status: "requested", run_date: base, requested_by: "이동주", ...o });
  add({ type: "coupang", vendor_id: "v2", time_slot: "오전", from_place: "경산2", to_place: "진천센터", plt_qty: 18, group_no: "101903,101938", ref_code: "AF426A30XQ, AF426A30XT", category: "XLE" });
  add({ type: "coupang", vendor_id: "v2", time_slot: "오후", from_place: "여주2", to_place: "진천센터", plt_qty: 7, group_no: "110240,110241", ref_code: "AFA26B02ZB", category: "기저귀/분유", cargo_note: "합적" });
  add({ type: "center", vendor_id: "v2", from_place: "진천센터", to_place: "이천점", plt_qty: 18, requested_by: "오태호" });
  add({ type: "center", vendor_id: "v2", from_place: "기흥센터", to_place: "시그니처인천점", plt_qty: 3, requested_by: "임희숙" });
  add({ type: "delivery", vendor_id: null, origin: "store", from_place: "이천점", to_place: "고객", run_date: addDays(base, 1), cargo_note: "수납장", requested_by: "store:이천점",
    delivery: { order_date: addDays(base, -1), store: "이천점", customer_name: "이OO", customer_phone: "010-0000-7777", address: "경기도 이천시 OO로 290번길 60, 101동 702호", product: "수납장", qty: "1", terms: "유료",
      items: [{ name: "수납장", qty: 1, size: "기본" }], tt_plt: null, elevator: "있음", disposal: "없음", distance: "20km 미만", multi_stop: false, extra_paid: 77000, buyer_same: true, asap: false, request_note: "", paper_kept: true, consent_signed: true, requested_by: "매장 담당" } });
  // 예시 이력: 요청 → (가끔 취소 · 회차) → 배차 → 완료
  const nowL = (() => { const n = new Date(); return `${ymd(n)}T${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}:00`; })();
  const at = (day, hm) => { const x = `${day}T${hm}:00`; return x > nowL ? nowL : x; };
  const fakeCar = () => { const x = pick(drivers); return { driver_name: x[0], driver_phone: "010-0000-" + String(1000 + Math.floor(rnd() * 8999)), vehicle_no: x[1], vehicle_ton: x[2], vehicle_body: x[3] }; };
  D.forEach(d => {
    const by = d.origin === "store" ? "store:" + d.from_place : "이동주";
    const vby = "vendor:" + (vendors.find(v => v.id === d.vendor_id) || vendors[0]).name;
    d.events = d.origin === "vendor" ? [] : [{ at: at(addDays(d.run_date, -1), "17:20"), by, kind: "request" }];
    if (d.driver_name) {
      const t = rnd();
      if (d.type !== "delivery" && t < .07) d.events.push({ at: at(d.run_date, "06:35"), by: vby, kind: "assign", ...fakeCar() }, { at: at(d.run_date, "08:07"), by: vby, kind: "cancel_driver", reason: pick(["차량고장", "기사 사정", ""]), ...fakeCar() });
      else if (d.type === "coupang" && t < .13) { const f = pick([null, 70000]); d.events.push({ at: at(d.run_date, "07:10"), by: vby, kind: "assign", ...fakeCar() }, { at: at(d.run_date, "11:56"), by: vby, kind: "return", reason: pick(["상차지연", "상차 순번 안 줄어듦", "상차지 물건 없음"]), fare: f, ...fakeCar() });
        if (f) Object.assign(d, { return_fare: (+d.return_fare || 0) + f, return_date: d.run_date, return_from: d.from_place }); }
      const re = d.events.some(e => TROUBLE.includes(e.kind));
      d.events.push({ at: at(d.run_date, re ? "12:40" : "06:50"), by: vby, kind: re ? "reassign" : "assign", ...snapCar(d) });
      if (["done", "confirmed"].includes(d.status)) d.events.push({ at: at(d.run_date, "18:30"), by: vby, kind: "done", ...snapCar(d) });
    }
  });
  D.forEach(d => { d.created_at = d.run_date + "T09:00:00"; d.updated_at = d.created_at; });
  return { vendors, places, rates, stores, dispatches: D, settlements: [], audit: [], attachments: [], nextId: id };
}
const AUDIT_SKIP = ["updated_at", "updated_by", "settle_month", "billed_amount", "rate_fare", "created_at", "events", "comments", "delivery", "_dup"];
function diffRow(a, b) {
  const d = {}; const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  keys.forEach(k => { if (AUDIT_SKIP.includes(k)) return; const x = a?.[k] ?? null, y = b?.[k] ?? null; if (JSON.stringify(x) !== JSON.stringify(y) && !(x === "" && y === null) && !(x === null && y === "")) d[k] = [x, y]; });
  return d;
}
const plainRow = d => { const x = {}; Object.keys(d).forEach(k => { if (!AUDIT_SKIP.includes(k)) x[k] = d[k]; }); return x; };
const Demo = {
  db: null,
  load() { try { this.db = JSON.parse(localStorage.getItem(DEMO_KEY) || "null"); } catch (_) { this.db = null; } if (!this.db) { this.db = demoSeed(); this.save(); } return this.db; },
  save() {
    if (this.db.attachments && this.db.attachments.length > 12) this.db.attachments = this.db.attachments.slice(-12);   // 데모는 브라우저 저장 공간이 작아 사진을 최근 12장만 둠
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(this.db)); } catch (_) { toast("브라우저 저장 공간이 꽉 찼습니다 — 설정 › 예시 데이터 초기화"); }
  },
  reset() { this.db = demoSeed(); this.save(); },
  rateFor(d) {
    const cand = this.db.rates.filter(r => (!r.vendor_id || r.vendor_id === d.vendor_id) && r.type === d.type && (!r.from_place || r.from_place === d.from_place) && (!r.to_place || r.to_place === d.to_place) && (r.vehicle_ton == null || +r.vehicle_ton === +d.vehicle_ton));
    cand.sort((a, b) => [b.from_place, b.to_place, b.vehicle_ton].filter(x => x != null).length - [a.from_place, a.to_place, a.vehicle_ton].filter(x => x != null).length);
    return cand[0] ? cand[0].base_fare : null;
  },
  // 수정 기록(운영은 DB 트리거 audit_row 가 같은 일): 칸 단위 이전 → 이후, 누가, 언제(밀리초까지)
  log(id, actor, action, diff, table = "dispatches") { if (diff && !Object.keys(diff).length) return; this.db.audit.push({ id: (this.db.audit.length ? this.db.audit[this.db.audit.length - 1].id : 0) + 1, table_name: table, row_id: String(id ?? ""), dispatch_id: table === "dispatches" || table === "dispatch_delivery" || table === "dispatch_comments" || table === "attachments" ? id : null, actor, action, diff, at: new Date().toISOString() }); },
  logChange(id, actor, prev, next) {
    const d = diffRow(prev, next); const dd = diffRow(prev.delivery || {}, next.delivery || {});
    if (Object.keys(d).length) this.log(id, actor, "update", d);
    if (Object.keys(dd).length) this.log(id, actor, prev.delivery ? "update" : "insert", dd, "dispatch_delivery");
  },
};

let sb = null;
async function liveClient() {
  if (sb) return sb;
  await new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  return sb;
}
const unwrap = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

// ---- 실시간: 누가 저장하면 열려 있는 모든 화면(관리자 · 업체 · 매장)이 다시 불러온다 ----
//  운영: Supabase Realtime 방송 채널(저장한 쪽이 'changed' 신호를 보냄) + 90초마다 확인
//  데모: 같은 브라우저의 다른 탭끼리 localStorage 변경 이벤트로 맞춤
const Live = {
  ch: null, cb: null,
  async start(cb) {
    this.cb = cb;
    window.addEventListener("storage", e => { if (e.key === DEMO_KEY) this.fire(false); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") this.fire(true); });
    if (!LIVE) return;
    try { const c = await liveClient(); this.ch = c.channel("kk-dispatch").on("broadcast", { event: "changed" }, () => this.fire(false)).subscribe(); } catch (_) {}
    setInterval(() => { if (document.visibilityState === "visible") this.fire(true); }, 90000);
  },
  fire(quiet) { if (this.cb) this.cb(quiet); },
  notify() { try { if (LIVE && this.ch) this.ch.send({ type: "broadcast", event: "changed", payload: { at: Date.now() } }); } catch (_) {} },
};
// 화면을 다시 그리면 안 되는 순간(입력 중 · 서랍/시트 열림)이면 '반영' 버튼만 띄운다
function remoteRefresh(quiet, isBusy, doReload) {
  if (isBusy()) {
    if ($("#live-pill")) return;
    const b = document.createElement("button"); b.id = "live-pill"; b.className = "live-pill"; b.textContent = "새로 바뀐 내용이 있습니다 · 반영";
    b.onclick = () => { b.remove(); doReload(); }; document.body.appendChild(b); return;
  }
  $("#live-pill")?.remove(); doReload(quiet);
}
const formBusy = () => !!document.querySelector(".drawer, .sheet") || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
const flatDelivery = d => { if (d && d.dispatch_delivery !== undefined) { d.delivery = Array.isArray(d.dispatch_delivery) ? d.dispatch_delivery[0] : d.dispatch_delivery; delete d.dispatch_delivery; }
  if (d && d.dispatch_comments !== undefined) { d.comments = (d.dispatch_comments || []).sort((a, b) => new Date(a.at) - new Date(b.at)); delete d.dispatch_comments; }
  if (d && d.dispatch_events !== undefined) { d.events = (d.dispatch_events || []).sort((a, b) => new Date(a.at) - new Date(b.at)); delete d.dispatch_events; } return d; };

// ---- 관리자 쪽 ----
const Admin = {
  async session() {
    if (!LIVE) return { email: "관리자(데모)", name: "관리자(데모)" };
    const c = await liveClient(); const { data } = await c.auth.getSession(); return data.session ? { email: data.session.user.email } : null;
  },
  async login(email) { const c = await liveClient(); unwrap(await c.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split("#")[0] } })); },
  async logout() { if (LIVE) { const c = await liveClient(); await c.auth.signOut(); } location.reload(); },
  async refs() {
    if (!LIVE) { const db = Demo.load(); return { vendors: db.vendors, places: db.places, rates: db.rates, stores: db.stores || [] }; }
    const c = await liveClient();
    const [vendors, places, rates, stores] = await Promise.all([
      c.from("vendors").select("id,name,types,contact,active").order("name").then(unwrap),
      c.from("places").select("*").order("name").then(unwrap),
      c.from("rate_cards").select("*").then(unwrap),
      c.from("stores").select("id,name,active").order("name").then(unwrap)]);
    return { vendors, places, rates, stores };
  },
  async list(from, to) {
    if (!LIVE) return Demo.load().dispatches.filter(d => d.run_date >= from && d.run_date <= to).map(d => ({ ...d, rate_fare: Demo.rateFor(d) })).sort((x, y) => y.run_date.localeCompare(x.run_date) || y.id - x.id);
    const c = await liveClient();
    return unwrap(await c.from("dispatches").select("*, dispatch_delivery(*), dispatch_events(*), dispatch_comments(*)").gte("run_date", from).lte("run_date", to).order("run_date", { ascending: false }).order("id", { ascending: false }).limit(5000)).map(flatDelivery);
  },
  async save(d, actor) {
    const row = { ...d }; const del = row.delivery; delete row.delivery; delete row.rate_fare; delete row.billed_amount; delete row.settle_month; delete row.events; delete row._dup;
    if (!LIVE) {
      const db = Demo.load();
      FARE_KEYS.forEach(k => { if (row.id) delete row[k]; else row[k] = k === "extra_fare" ? 0 : null; });   // 금액은 더한물류만
      if (row.id) { const i = db.dispatches.findIndex(x => x.id === row.id); const prev = JSON.parse(JSON.stringify(db.dispatches[i])); db.dispatches[i] = { ...db.dispatches[i], ...row, delivery: del || db.dispatches[i].delivery, updated_at: new Date().toISOString(), updated_by: actor }; trackLocal(prev, db.dispatches[i], actor); Demo.logChange(row.id, actor, prev, db.dispatches[i]); }
      else { row.id = db.nextId++; const n = { ...row, delivery: del, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: actor }; trackLocal(null, n, actor); db.dispatches.push(n); Demo.log(row.id, actor, "insert", plainRow(n)); if (del) Demo.log(row.id, actor, "insert", { ...del }, "dispatch_delivery"); }
      Demo.save(); return row.id;
    }
    const c = await liveClient(); row.updated_by = actor; FARE_KEYS.forEach(k => delete row[k]);   // 금액은 더한물류만(DB도 막음)
    let saved;
    if (row.id) saved = unwrap(await c.from("dispatches").update(row).eq("id", row.id).select().single());
    else { delete row.id; saved = unwrap(await c.from("dispatches").insert(row).select().single()); }
    if (del) unwrap(await c.from("dispatch_delivery").upsert({ ...del, dispatch_id: saved.id }));
    Live.notify(); return saved.id;   // 수정 기록은 DB 트리거가 칸 단위로 남김
  },
  async setStatus(ids, status, actor) {
    if (!LIVE) { const db = Demo.load(); db.dispatches.forEach(d => { if (ids.includes(d.id)) { const prev = { ...d }; d.status = status; d.updated_by = actor; d.updated_at = new Date().toISOString(); trackLocal(prev, d, actor); Demo.log(d.id, actor, "update", { status: [prev.status, status] }); } }); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.from("dispatches").update({ status, updated_by: actor }).in("id", ids)); Live.notify();
  },
  async event(id, ev, actor) {
    if (ev.fare) delete ev.fare;   // 회차금액도 더한물류만
    if (!LIVE) { const db = Demo.load(); const d = db.dispatches.find(x => x.id === id); const prev = JSON.parse(JSON.stringify(d)); applyEventLocal(d, ev, actor); Demo.logChange(id, actor, prev, d); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.rpc("staff_event", { p_id: id, ev })); Live.notify();
  },
  async attachments(id) {
    if (!LIVE) return (Demo.load().attachments || []).filter(a => a.dispatch_id === id);
    const c = await liveClient(); return unwrap(await c.from("attachments").select("id,kind,data,created_at").eq("dispatch_id", id).order("id"));
  },
  async audit(id) {
    if (!LIVE) return Demo.load().audit.filter(a => a.dispatch_id === id).reverse();
    const c = await liveClient(); return unwrap(await c.from("audit_log").select("*").eq("dispatch_id", id).order("at", { ascending: false }).limit(500));
  },
  async auditRange(from, to) {   // 수정 기록 화면: 기간 안의 모든 표 기록
    if (!LIVE) return Demo.load().audit.filter(a => a.at.slice(0, 10) >= from && a.at.slice(0, 10) <= to).reverse();
    const c = await liveClient(); return unwrap(await c.from("audit_log").select("*").gte("at", from + "T00:00:00+09:00").lte("at", to + "T23:59:59.999+09:00").order("at", { ascending: false }).limit(3000));
  },
  async comment(id, body, kind = "question") {
    if (!LIVE) { const db = Demo.load(); const d = db.dispatches.find(x => x.id === id); const cm = { id: Date.now(), at: new Date().toISOString(), author: S.user.email, kind, body }; (d.comments ||= []).push(cm); Demo.log(id, S.user.email, "insert", { kind, body }, "dispatch_comments"); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.from("dispatch_comments").insert({ dispatch_id: id, kind, body })); Live.notify();
  },
  async closeComment(id, cid) {
    if (!LIVE) { const db = Demo.load(); const cm = (db.dispatches.find(x => x.id === id).comments || []).find(x => x.id === cid); const at = new Date().toISOString(); Demo.log(id, S.user.email, "update", { closed_at: [null, at] }, "dispatch_comments"); Object.assign(cm, { closed_at: at, closed_by: S.user.email }); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.from("dispatch_comments").update({ closed_at: new Date().toISOString() }).eq("id", cid)); Live.notify();
  },
  async settlements(month) {
    if (!LIVE) return Demo.load().settlements.filter(s => s.month === month);
    const c = await liveClient(); return unwrap(await c.from("settlements").select("*").eq("month", month));
  },
  async confirmSettlement(vendor_id, month, sum, ids, actor) {
    await this.setStatus(ids, "confirmed", actor);
    const rec = { vendor_id, month, supply: sum, vat: Math.round(sum * 0.1), total: Math.round(sum * 1.1), count: ids.length, confirmed_by: actor, confirmed_at: new Date().toISOString() };
    if (!LIVE) { const db = Demo.load(); db.settlements = db.settlements.filter(s => !(s.vendor_id === vendor_id && s.month === month)).concat(rec); Demo.log(`${vendor_id}/${month}`, actor, "insert", { ...rec }, "settlements"); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.from("settlements").upsert(rec, { onConflict: "vendor_id,month" }));
  },
  async saveRef(kind, row) {
    if (!LIVE) { const db = Demo.load(); const L = db[kind]; const tb = { rates: "rate_cards" }[kind] || kind; if (row.id) { const i = L.findIndex(x => x.id === row.id); if (i >= 0) { Demo.log(row.id, S.user.email, "update", diffRow(L[i], { ...L[i], ...row }), tb); L[i] = { ...L[i], ...row }; } else L.push(row); } else { row.id = kind[0] + Date.now(); L.push(row); Demo.log(row.id, S.user.email, "insert", { ...row }, tb); } Demo.save(); return; }
    const c = await liveClient(); const table = { vendors: "vendors", places: "places", rates: "rate_cards" }[kind];
    if (kind === "vendors") { toast("업체 추가 · PIN 변경은 Supabase SQL Editor 에서 합니다(운영 가이드 참고)"); return; }
    unwrap(await c.from(table).upsert(row));
  },
  async removeRef(kind, id) {
    if (!LIVE) { const db = Demo.load(); const old = db[kind].find(x => x.id === id); db[kind] = db[kind].filter(x => x.id !== id); if (old) Demo.log(id, S.user.email, "delete", { ...old }, { rates: "rate_cards" }[kind] || kind); Demo.save(); return; }
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
      return db.dispatches.filter(d => (d.status !== "canceled" || (d.updated_at || "") >= addDays(today(), -3)) && d.run_date >= lo && (d.vendor_id === this.vid || (!d.vendor_id && v.types.includes(d.type)))).map(d => ({ ...d, rate_fare: Demo.rateFor({ ...d, vendor_id: this.vid }) })).sort((a, b) => b.run_date.localeCompare(a.run_date) || b.id - a.id); }
    const c = await liveClient(); return unwrap(await c.rpc("vendor_list", { p_vendor: this.name, p_pin: this.pin }));
  },
  async refs() {
    if (!LIVE) { const db = Demo.load(); return { places: db.places.map(p => p.name), place_list: db.places.map(p => ({ name: p.name, aliases: p.aliases || [] })), rates: db.rates.filter(r => r.vendor_id === this.vid) }; }
    const c = await liveClient(); return unwrap(await c.rpc("vendor_refs", { p_vendor: this.name, p_pin: this.pin }));
  },
  async save(id, p) {
    if (!LIVE) { const db = Demo.load(); const d = db.dispatches.find(x => x.id === id); if (d.status === "confirmed") throw new Error("정산 확정된 건은 고칠 수 없습니다");
      const { done_note, ...rest } = p; const prev = JSON.parse(JSON.stringify(d)); Object.assign(d, rest, { vendor_id: this.vid, updated_at: new Date().toISOString(), updated_by: "vendor:" + this.name }); if (d.delivery && done_note != null) d.delivery.done_note = done_note;
      if (d.type !== "delivery") d.run_date = prev.run_date; trackLocal(prev, d, "vendor:" + this.name);
      Demo.logChange(id, "vendor:" + this.name, prev, d); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.rpc("vendor_save", { p_vendor: this.name, p_pin: this.pin, p_id: id, p })); Live.notify();
  },
  async comment(id, body) {
    if (!LIVE) { const db = Demo.load(); const d = db.dispatches.find(x => x.id === id); (d.comments ||= []).push({ id: Date.now(), at: new Date().toISOString(), author: "vendor:" + this.name, kind: "answer", body }); Demo.log(id, "vendor:" + this.name, "insert", { kind: "answer", body }, "dispatch_comments"); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.rpc("vendor_comment", { p_vendor: this.name, p_pin: this.pin, p_id: id, p_body: body })); Live.notify();
  },
  async event(id, ev) {
    if (!LIVE) { const db = Demo.load(); const d = db.dispatches.find(x => x.id === id); if (d.vendor_id && d.vendor_id !== this.vid) throw new Error("다른 업체의 배차입니다"); const prev = JSON.parse(JSON.stringify(d)); applyEventLocal(d, ev, "vendor:" + this.name); Demo.logChange(id, "vendor:" + this.name, prev, d); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.rpc("vendor_event", { p_vendor: this.name, p_pin: this.pin, p_id: id, ev })); Live.notify();
  },
  async add(p) {
    if (!LIVE) { const db = Demo.load(); const id = db.nextId++; const n = { ...p, id, vendor_id: this.vid, origin: "vendor", status: p.status === "assigned" ? "assigned" : "done", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: "vendor:" + this.name };
      trackLocal(null, n, "vendor:" + this.name); db.dispatches.push(n); Demo.log(id, "vendor:" + this.name, "insert", plainRow(n)); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.rpc("vendor_add", { p_vendor: this.name, p_pin: this.pin, p })); Live.notify();
  },
};

// ---- 매장 쪽(링크 + 매장 PIN) — 고객배송 요청 ----
const Store = {
  name: null, pin: null,
  async login(name, pin) {
    if (!LIVE) { const s = (Demo.load().stores || []).find(x => x.name === name && x.active !== false); if (!s || s.pin !== pin) throw new Error("PIN이 맞지 않습니다"); }
    else { const c = await liveClient(); unwrap(await c.rpc("store_list", { p_store: name, p_pin: pin })); }
    this.name = name; this.pin = pin; try { sessionStorage.setItem("kk_spin_" + name, pin); } catch (_) {}
  },
  async list() {
    if (!LIVE) { const db = Demo.load(); const lo = addDays(today(), -90);
      return db.dispatches.filter(d => d.type === "delivery" && d.from_place === this.name && (d.created_at || d.run_date) >= lo).map(d => ({ id: d.id, status: d.status, run_date: d.run_date, created_at: d.created_at,
        driver_name: d.driver_name, driver_phone: d.driver_phone, vehicle_no: d.vehicle_no, vendor: (db.vendors.find(v => v.id === d.vendor_id) || {}).name,
        receipts: (db.attachments || []).filter(a => a.dispatch_id === d.id).length, delivery: d.delivery, events: d.events || [] })).sort((a, b) => b.id - a.id); }
    const c = await liveClient(); return unwrap(await c.rpc("store_list", { p_store: this.name, p_pin: this.pin }));
  },
  async add(p, files) {
    if (!LIVE) { const db = Demo.load(); const id = db.nextId++; const now = new Date().toISOString(); const actor = "store:" + this.name;
      db.dispatches.push({ ...p, id, type: "delivery", status: "requested", origin: "store", vendor_id: null, from_place: this.name, to_place: "고객", temp: "상온", extra_fare: 0, requested_by: actor,
        created_at: now, updated_at: now, updated_by: actor, delivery: { ...p.delivery, store: this.name } });
      trackLocal(null, db.dispatches[db.dispatches.length - 1], actor);
      (db.attachments ||= []).push(...files.map((f, i) => ({ id: `a${id}_${i}`, dispatch_id: id, kind: "receipt", data: f, created_at: now })));
      Demo.log(id, actor, "insert", plainRow(db.dispatches[db.dispatches.length - 1])); Demo.log(id, actor, "insert", { ...p.delivery }, "dispatch_delivery"); files.forEach((_, i) => Demo.log(id, actor, "insert", { kind: "receipt", 사진: i + 1 }, "attachments")); Demo.save(); return id; }
    const c = await liveClient(); const id = unwrap(await c.rpc("store_add", { p_store: this.name, p_pin: this.pin, p, p_files: files })); Live.notify(); return id;
  },
  async cancel(id) {
    if (!LIVE) { const db = Demo.load(); const d = db.dispatches.find(x => x.id === id); if (!d || d.status !== "requested") throw new Error("배차가 이미 잡힌 건은 본사에 연락해 주세요");
      const prev = { ...d }; d.status = "canceled"; d.updated_by = "store:" + this.name; trackLocal(prev, d, "store:" + this.name); Demo.log(id, "store:" + this.name, "update", { status: [prev.status, "canceled"] }); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.rpc("store_cancel", { p_store: this.name, p_pin: this.pin, p_id: id })); Live.notify();
  },
};

// =====================================================================
//  화면 시작
// =====================================================================
const app = $("#app");
const params = new URLSearchParams(location.search);
const hashParam = k => { const m = location.hash.match(new RegExp("(?:^#|&)" + k + "=([^&]+)")); return m ? decodeURIComponent(m[1]) : null; };
const vendorParam = vendorCanon(params.get("v") || hashParam("v"));
const storeParam = params.get("s") || hashParam("s");


// =====================================================================
//  관리자(PC) 화면
// =====================================================================
const S = { tab: "dash", month: today().slice(0, 7), refs: null, rows: [], filter: { type: "", status: "", vendor: "", q: "", flag: "" }, newType: "coupang", user: null };

async function adminBoot() {
  S.user = await Admin.session();
  if (!S.user) return adminLogin();
  try { const h = location.hash.slice(1); if (["dash", "new", "ledger", "settle", "audit", "setup"].includes(h)) S.tab = h; } catch (_) {}
  await reload();
}
function adminLogin() {
  app.innerHTML = `<div class="pin"><div class="card"><h2>킹콩 물류 관리자</h2><p class="sub">회사 이메일을 넣으면 로그인 링크를 보내 드립니다.</p>
    <div class="field"><label for="em">이메일</label><input id="em" type="email" autocomplete="email" placeholder="name@kinggo.ai"></div>
    <div class="row" style="margin-top:12px;justify-content:center"><button class="btn primary" id="go">로그인 링크 받기</button></div></div></div>`;
  $("#go").onclick = async () => { try { await Admin.login($("#em").value.trim()); toast("메일함에서 로그인 링크를 눌러 주세요"); } catch (e) { toast(e.message); } };
}
async function reload(quiet) {
  const [y, m] = S.month.split("-").map(Number);
  const prev = ymd(new Date(y, m - 2, 1)), end = ymd(new Date(y, m, 0));
  try {
    S.refs = await Admin.refs();
    S.rowsAll = await Admin.list(addDays(prev, -40), addDays(end, 40));   // 앞뒤 달까지 받아 전월 대비 · 다가오는 요청을 같이 본다
  } catch (e) { if (!quiet) app.innerHTML = `<div class="empty">불러오기 실패: ${esc(e.message)}</div>`; return; }
  const sig = S.rowsAll.map(d => d.id + d.status + (d.updated_at || "") + (d.events || []).length).join("|");
  if (quiet && sig === S.sig) return; const changed = S.sig && sig !== S.sig; S.sig = sig;
  S.rows = S.rowsAll.filter(d => monthOf(d.run_date) === S.month);
  const y0 = scrollY; render(); if (quiet) scrollTo(0, y0);
  if (quiet && changed) toast("새 내용이 반영되었습니다");
}
const vName = id => (S.refs?.vendors.find(v => v.id === id) || {}).name || (id ? "?" : "미지정");

function render() {
  const nav = [["dash", "대시보드"], ["new", "배차 요청"], ["ledger", "통합 대장"], ["settle", "정산"], ["audit", "수정 기록"], ["setup", "설정"]];
  app.innerHTML = `
  <div class="top"><div class="top-in">
    <div class="brand"><span class="logo" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg></span>
      <span>킹콩 물류 배차·정산<small>${esc(CFG.COMPANY || "킹콩백화점")} · 쿠팡 · 센터 · 고객배송 통합 대장 <span class="build-pill">build ${BUILD}</span></small></span></div>
    <nav class="nav" aria-label="메뉴">${nav.map(([k, l]) => `<button data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ""}>${l}</button>`).join("")}</nav>
    <span class="sp"></span>
    <label class="row" style="gap:6px;font-size:13px;font-weight:700;color:var(--muted)">기준 월 <input type="month" id="month" value="${S.month}" style="border:1px solid var(--line);border-radius:8px;padding:6px 8px;background:var(--panel)"></label>
    <button class="btn sm" id="guide-btn">입력 양식 안내</button>
    <span class="mode-badge ${LIVE ? "" : "demo"}" title="${LIVE ? "Supabase 공유 DB에 저장" : "이 브라우저에만 저장되는 예시 데이터"}">${LIVE ? "● 실시간 DB · " + esc(S.user.email) : "데모 모드"}</span>
  </div></div>
  <main id="view"></main>`;
  $$(".nav button").forEach(b => b.onclick = () => { S.tab = b.dataset.tab; history.replaceState(null, "", "#" + S.tab); render(); });
  $("#month").onchange = e => { S.month = e.target.value || S.month; reload(); };
  $("#guide-btn").onclick = () => openGuide("admin");
  const v = $("#view");
  ({ dash: viewDash, new: viewNew, ledger: viewLedger, settle: viewSettle, audit: viewAudit, setup: viewSetup })[S.tab](v);
}

// ---------------- 대시보드 ----------------
function viewDash(v) {
  const R = S.rows.filter(counted);
  const [y, m] = S.month.split("-").map(Number); const pm = ymd(new Date(y, m - 2, 1)).slice(0, 7);
  const P = S.rowsAll.filter(d => monthOf(d.run_date) === pm && counted(d));
  const sum = L => L.reduce((a, d) => a + cost(d), 0);
  const trouble = S.rows.filter(d => (d.events || []).some(e => TROUBLE.includes(e.kind)));
  const nC = S.rows.reduce((a, d) => a + evOf(d, "cancel_driver").length, 0), nR = S.rows.reduce((a, d) => a + evOf(d, "return").length, 0);
  const nowT = Date.now();
  const feed = S.rowsAll.flatMap(d => (d.events || []).map(e => ({ e, d }))).filter(x => x.e.at && tms(x.e.at) <= nowT).sort((a, b) => tms(b.e.at) - tms(a.e.at)).slice(0, 14);
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
    ${Object.keys(TYPES).map(tp => `<div class="h">${typeTag(tp)}</div>` + STATUS_ORDER.map(s => { const L = R.filter(d => d.type === tp && d.status === s); const re = s === "requested" ? L.filter(d => (d.events || []).some(e => TROUBLE.includes(e.kind))).length : 0; return `<div class="c num" data-go="${tp}|${s}" tabindex="0" role="button">${L.length}<small>${re ? `<span style="color:var(--bad)">재배차 필요 ${re}</span>` : sum(L) ? man(sum(L)) + "원" : (L.length ? "금액 입력 전" : "&nbsp;")}</small></div>`; }).join("")).join("")}
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
      ${kpi("답변 대기 질문", S.rowsAll.filter(d => qState(d) === "waiting").length + "건", "비고란 질문에 더한물류 답이 아직 없음", S.rowsAll.some(d => qState(d) === "waiting") ? "alert" : "", "question")}
      ${kpi("취소 · 회차", trouble.length + "건", `기사 취소 ${nC} · 회차 ${nR}${R.some(d => +d.return_fare) ? ` · 회차비 ${won(R.reduce((a, d) => a + (+d.return_fare || 0), 0))}원` : ""}`, "", "trouble")}
    </div>
    <div class="two">
    <div class="card"><h2>진행 상태</h2><p class="sub">${+S.month.slice(5)}월 운행일 기준 · 칸을 누르면 그 건만 통합 대장에서 봅니다</p>${board}</div>
    <div class="card"><h2>실시간 이력</h2><p class="sub">요청 · 배차 · 취소 · 회차 · 완료 — 누가 언제 했는지(누르면 그 건)</p>
      <ul class="feed">${feed.map(({ e, d }) => `<li data-id="${d.id}" class="k-${e.kind}"><span class="ft">${esc(fmtAt(e.at))}</span><b>${esc(EVENT_KINDS[e.kind] || e.kind)}</b> <span>${esc(d.from_place)}→${esc(d.type === "delivery" ? "고객" : d.to_place)}</span>
        <span class="muted">${esc(e.driver_name || "")}${e.reason ? " · " + esc(e.reason) : ""} · ${esc(whoLabel(e.by))}</span></li>`).join("") || '<li class="muted">기록 없음</li>'}</ul></div></div>
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
  $$(".feed li[data-id]", v).forEach(el => el.onclick = () => { const d = S.rowsAll.find(x => x.id === +el.dataset.id); if (d) openEdit(d); });
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
    ${importCardHtml()}
    <p class="sec-t" style="margin:6px 0 -4px">또는 직접 입력</p>
    <div class="types" role="group" aria-label="요청 유형">${Object.entries(TYPES).map(([k, x]) => `<button class="type-card" data-t="${k}" aria-pressed="${k === t}"><b>${typeTag(k)} ${esc(x.label)}</b><span>${esc(x.desc)}</span></button>`).join("")}</div>
    <form class="card" id="nf"><h2>${esc(TYPES[t].label)} 배차 요청</h2><p class="sub">킹콩이 채우는 칸만 있습니다. 기사 · 차량 · 금액은 업체가 휴대폰으로 채웁니다.</p>
      <div class="grid">${body}</div>
      <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn primary" type="submit">요청 등록</button></div></form>
    <datalist id="dl-fc">${placeOptions(["쿠팡FC"])}</datalist><datalist id="dl-all">${placeOptions()}</datalist><datalist id="dl-store">${placeOptions(["매장"])}</datalist><datalist id="dl-to">${placeOptions(["센터", "매장"])}</datalist>
  </div>`;
  $$(".type-card", v).forEach(b => b.onclick = () => { S.newType = b.dataset.t; viewNew(v); });
  bindImport(v);
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
  return (f.flag === "question" ? S.rowsAll : S.rows).filter(d => {
    if (f.type && d.type !== f.type) return false;
    if (f.status && d.status !== f.status) return false;
    if (f.vendor && (f.vendor === "none" ? d.vendor_id : d.vendor_id !== f.vendor)) return false;
    if (f.flag === "waiting" && !(d.status === "requested" && d.run_date <= addDays(t, 1))) return false;
    if (f.flag === "nofare" && !(["assigned", "done"].includes(d.status) && !d.base_fare && d.run_date < t)) return false;
    if (f.flag === "over" && !(d.rate_fare && d.base_fare && billed(d) > d.rate_fare)) return false;
    if (f.flag === "vendor" && !(d.origin === "vendor" && d.status === "done")) return false;
    if (f.flag === "trouble" && !(d.events || []).some(e => TROUBLE.includes(e.kind))) return false;
    if (f.flag === "store" && d.origin !== "store") return false;
    if (f.flag === "question" && !qState(d)) return false;
    if (f.q) { const s = [d.from_place, d.to_place, d.driver_name, d.vehicle_no, d.ref_code, d.group_no, d.category, d.via_place, d.cargo_note, d.delivery?.customer_name, d.delivery?.address, d.delivery?.product].join(" "); if (!s.includes(f.q)) return false; }
    return true;
  });
}
function viewLedger(v) {
  const f = S.filter;
  const flagNames = { waiting: "배차 대기", nofare: "금액 미입력", over: "운임표 초과", vendor: "업체 직접 등록", trouble: "취소 · 회차", store: "매장 요청", question: "질문 있는 건" };
  v.innerHTML = `<div class="grid">
    <div class="card" style="padding:14px">
      <div class="row">
        <div class="field" style="min-width:140px"><label for="f-type">유형</label><select id="f-type"><option value="">전체</option>${Object.entries(TYPES).map(([k, x]) => `<option value="${k}" ${f.type === k ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select></div>
        <div class="field" style="min-width:130px"><label for="f-st">상태</label><select id="f-st"><option value="">전체</option>${Object.entries(STATUS).map(([k, x]) => `<option value="${k}" ${f.status === k ? "selected" : ""}>${x}</option>`).join("")}</select></div>
        <div class="field" style="min-width:150px"><label for="f-v">업체</label><select id="f-v"><option value="">전체</option><option value="none" ${f.vendor === "none" ? "selected" : ""}>미지정</option>${S.refs.vendors.map(x => `<option value="${x.id}" ${f.vendor === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></div>
        <div class="field" style="flex:1;min-width:180px"><label for="f-q">검색 (지점 · 기사 · 차량 · 고객 · 그룹넘버)</label><input id="f-q" type="search" value="${esc(f.q)}"></div>
        ${f.flag ? `<button class="btn sm" id="f-clear" style="align-self:end">✕ ${flagNames[f.flag]}만 보는 중</button>` : ""}
        <button class="btn sm" id="f-csv" style="align-self:end">CSV 내려받기</button>
      </div>
    </div>
    <div id="tbl"></div>
  </div>`;
  const draw = () => {
    const L = filtered();
    const tot = L.reduce((a, d) => a + (d.status === "canceled" ? 0 : billed(d)), 0), ret = L.reduce((a, d) => a + (+d.return_fare || 0), 0);
    $("#tbl").innerHTML = L.length ? `<div class="row" style="justify-content:space-between;margin:0 0 8px"><span class="muted">${L.length}건 · 청구 ${won(tot)}원${ret ? ` · 회차 ${won(ret)}원` : ""}</span>
      <span class="row" style="gap:6px"><button class="btn sm" id="bulk-kakao" title="고른 요청을 카톡 배차 요청 문구로 복사">선택 → 카톡 요청 문구</button><button class="btn sm" id="bulk-done">선택 → 운행 완료</button><button class="btn sm" id="bulk-cancel">선택 → 취소</button></span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th><input type="checkbox" id="ck-all" aria-label="모두 선택"></th><th>운행일</th><th>유형</th><th>상태</th><th>상차지</th><th>하차지</th><th class="r">PLT</th><th>업체</th><th>기사</th><th>차량</th><th class="r">톤</th><th class="r">기본</th><th class="r">추가</th><th class="r">청구</th><th class="r">운임표 차액</th><th>비고 · 질문</th><th>최종 수정</th></tr></thead>
      <tbody>${L.map(d => { const df = d.rate_fare && d.base_fare ? billed(d) - d.rate_fare : null; return `<tr data-id="${d.id}">
        <td onclick="event.stopPropagation()"><input type="checkbox" class="ck" value="${d.id}" aria-label="선택"></td>
        <td class="num">${dLabel(d.run_date)}${d.time_slot ? ` <span class="muted">${esc(d.time_slot)}</span>` : ""}</td><td>${typeTag(d.type)}</td><td>${stTag(d.status)}${d.origin === "vendor" ? '<span class="flag">업체 등록</span>' : d.origin === "store" ? '<span class="flag st-flag">매장 요청</span>' : ""}${evBadges(d)}</td>
        <td>${esc(d.from_place)}</td><td>${esc(d.type === "delivery" ? (d.delivery?.address || "고객") : d.to_place)}</td><td class="r num">${d.plt_qty ?? ""}${d.temp && d.temp !== "상온" ? ` <span class="muted">${esc(d.temp)}</span>` : ""}</td>
        <td>${esc(vName(d.vendor_id))}</td><td>${esc(d.driver_name || "")}</td><td class="num">${esc(d.vehicle_no || "")}</td><td class="r num">${d.vehicle_ton ?? ""}${d.vehicle_body ? `<span class="muted"> ${esc(d.vehicle_body)}</span>` : ""}</td>
        <td class="r num">${won(d.base_fare)}</td><td class="r num">${d.extra_fare ? won(d.extra_fare) : ""}</td><td class="r num"><b>${d.base_fare ? won(billed(d)) : ""}</b></td>
        <td class="r num ${df > 0 ? "diff-up" : ""}">${df == null ? "" : (df > 0 ? "▲" : df < 0 ? "▼" : "") + won(Math.abs(df))}</td><td class="memo" onclick="event.stopPropagation()"><div class="memo-in">${qBadge(d)}<span class="muted">${esc((d.comments || []).slice(-1)[0]?.body || d.extra_reason || d.cargo_note || d.delivery?.product || "")}</span></div><button class="btn sm ghost ask" data-ask="${d.id}" title="이 건에 대해 더한물류에 질문">질문</button></td>
        <td class="num muted" title="${esc(d.updated_by || "")}">${fmtSec(d.updated_at)}<br>${esc(whoLabel(d.updated_by || ""))}</td></tr>`; }).join("")}</tbody>
      <tfoot><tr><td colspan="13">합계 ${L.length}건</td><td class="r num">${won(tot)}</td><td colspan="3"></td></tr></tfoot></table></div>` : `<div class="card empty">조건에 맞는 배차가 없습니다</div>`;
    $$("#tbl tbody tr").forEach(tr => tr.onclick = () => openEdit(S.rowsAll.find(d => d.id === +tr.dataset.id)));
    $$("[data-ask]").forEach(b => b.onclick = () => askQuestion(S.rowsAll.find(d => d.id === +b.dataset.ask), b));
    const all = $("#ck-all"); if (all) all.onchange = () => $$(".ck").forEach(c => c.checked = all.checked);
    const bulk = async st => { const ids = $$(".ck:checked").map(c => +c.value); if (!ids.length) return toast("줄을 먼저 고르세요"); await Admin.setStatus(ids, st, S.user.email); toast(`${ids.length}건 → ${STATUS[st]}`); await reload(); };
    const bd = $("#bulk-done"); if (bd) { bd.onclick = () => bulk("done"); $("#bulk-cancel").onclick = () => bulk("canceled");
      $("#bulk-kakao").onclick = () => { const ids = $$(".ck:checked").map(c => +c.value); const sel = S.rows.filter(d => ids.includes(d.id)); if (!sel.length) return toast("줄을 먼저 고르세요"); shareText(kakaoReqText(sel)); }; }
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
    ["입차CODE", d => d.ref_code], ["그룹넘버", d => d.group_no], ["카테고리", d => d.category], ["경유", d => d.via_place], ["요청처", d => d.origin === "store" ? "매장" : d.origin === "vendor" ? "업체" : "킹콩"],
    ["재배차", d => evOf(d, "cancel_driver").length || ""], ["회차", d => evOf(d, "return").length || ""], ["이력", d => (d.events || []).filter(e => !["request"].includes(e.kind)).map(e => `${fmtAt(e.at)} ${EVENT_KINDS[e.kind]}${e.driver_name ? " " + e.driver_name : ""}${e.reason ? "(" + e.reason + ")" : ""}`).join(" / ")], ["기사", d => d.driver_name], ["차량번호", d => d.vehicle_no], ["톤수", d => d.vehicle_ton], ["차종", d => d.vehicle_body], ["기본운임", d => d.base_fare], ["추가운임", d => d.extra_fare], ["추가 사유", d => d.extra_reason],
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
  dr.innerHTML = `<header><h3>#${d.id} ${typeTag(d.type)} ${esc(d.from_place)} → ${esc(d.to_place)} ${stTag(d.status)}${evBadges(d)}</h3><button class="btn ghost" id="x" aria-label="닫기">✕</button></header>
    <div class="body">
      <div><p class="sec-t">진행 이력</p>${timelineHtml(d.events)}
        ${d.status !== "confirmed" ? `<div class="row ev-actions" style="margin-top:8px;gap:6px">${d.driver_name ? `<button class="btn sm" data-ev="cancel_driver">기사 취소 · 재배차</button><button class="btn sm" data-ev="return">회차</button>` : ""}
          <button class="btn sm" data-ev="change">변경(일정 · 하차지)</button><button class="btn sm" data-ev="note">메모</button>${d.status !== "canceled" ? `<button class="btn sm danger" data-ev="cancel">요청 취소</button>` : ""}
          <button class="btn sm ghost" id="kk-req">카톡 요청 문구</button>${d.driver_name ? `<button class="btn sm ghost" id="kk-done">카톡 배차 문구</button>` : ""}</div>` : ""}</div>
      ${d.type === "delivery" && d.delivery ? `<div><p class="sec-t">매장 배송요청서${d.origin === "store" ? " (매장 앱)" : ""}</p><div class="card" style="padding:12px">${deliveryDetailHtml(d.delivery, { phoneLink: true })}</div>
        <p class="sec-t" style="margin-top:12px">영수증 사진</p><div class="thumbs" id="rcpts"><span class="muted">불러오는 중…</span></div></div>` : ""}
      <div><p class="sec-t">요청 (킹콩)</p><div class="fields">
        ${fld("e-date", "운행일", x.run_date, "date")}
        <div class="field"><label for="e-slot">시간대</label><select id="e-slot"><option value="">-</option>${SLOTS.map(s => `<option ${x.time_slot === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        ${fld("e-from", "상차지", x.from_place, "text", 'list="dl-e"')}${fld("e-to", "하차지", x.to_place, "text", 'list="dl-e"')}
        ${fld("e-plt", "PLT", x.plt_qty, "number", 'step="0.5"')}
        <div class="field"><label for="e-temp">온도</label><select id="e-temp">${["상온", "냉장", "냉동"].map(s => `<option ${x.temp === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        ${fld("e-code", "입차CODE · 참조", x.ref_code)}${fld("e-grp", "그룹넘버", x.group_no)}${fld("e-via", "경유", x.via_place)}${fld("e-cat", "카테고리", x.category)}${fld("e-note", "품목 · 메모", x.cargo_note)}
        ${x.pickup_addr || x.pickup_contact ? `<div class="field" style="grid-column:1 / -1"><label>상차지 주소 · 담당자</label><div class="muted">${esc(x.pickup_addr || "")} ${esc(x.pickup_contact || "")}</div></div>` : ""}
        <div class="field"><label for="e-vendor">업체</label><select id="e-vendor">${vendorOptions(x.type, x.vendor_id)}</select></div>
        <div class="field"><label for="e-st">상태</label><select id="e-st">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${x.status === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      </div></div>
      ${x.type === "delivery" ? `<div><p class="sec-t">고객</p><div class="fields">
        ${fld("c-name", "주문자", x.delivery.customer_name)}${fld("c-phone", "연락처", x.delivery.customer_phone, "tel")}${fld("c-prod", "제품", x.delivery.product)}${fld("c-qty", "수량", x.delivery.qty)}
        <div class="field" style="grid-column:1 / -1"><label for="c-addr">주소</label><input id="c-addr" value="${esc(x.delivery.address || "")}"></div>
        ${fld("c-done", "완료 메모", x.delivery.done_note)}</div></div>` : ""}
      <div><p class="sec-t">비고 · 질문 (더한물류에 묻기)</p>${threadHtml(d, { admin: true })}
        <div class="row" style="margin-top:8px;flex-wrap:nowrap"><input id="q-body" class="q-input" placeholder="예) 대기 1시간 추가운임 맞나요? · 차량번호 확인 부탁드립니다" aria-label="질문"><button class="btn primary sm" id="q-send">질문 보내기</button></div></div>
      <div><p class="sec-t">배차 결과 (업체) <span class="lock">금액은 더한물류만 입력 · 수정</span></p><div class="fields">
        ${fld("e-drv", "기사", x.driver_name)}${fld("e-car", "차량번호", x.vehicle_no)}${fld("e-ton", "톤수", x.vehicle_ton, "number", 'step="0.1"')}${fld("e-body", "차종", x.vehicle_body)}
        ${fld("e-base", "기본운임", x.base_fare, "number", "disabled")}${fld("e-extra", "추가운임", x.extra_fare, "number", "disabled")}${fld("e-reason", "추가운임 사유", x.extra_reason, "text", "disabled")}
      </div><p class="hint">${d.rate_fare ? `운임표 기준 ${won(d.rate_fare)}원 · 지금 청구 ${won(billed(d))}원` : "맞는 운임표가 없습니다 — 설정 › 운임표에 추가하면 차액이 자동 계산됩니다"}</p></div>
      ${x.type === "coupang" ? `<div><p class="sec-t">회차</p><div class="fields">${fld("r-date", "회차일", x.return_date, "date")}${fld("r-from", "회차 상차지", x.return_from)}${fld("r-drv", "회차 기사", x.return_driver)}${fld("r-fare", "회차금액", x.return_fare, "number", "disabled")}</div></div>` : ""}
      <div><p class="sec-t">수정 기록 — 누가 · 언제(초) · 무엇을</p><div id="log">불러오는 중…</div></div>
      <datalist id="dl-e">${placeOptions()}</datalist>
    </div>
    <footer><button class="btn" id="cancel">닫기</button><button class="btn primary" id="save">저장</button></footer>`;
  document.body.append(bg, dr);
  const close = () => { bg.remove(); dr.remove(); };
  bg.onclick = close; $("#x", dr).onclick = close; $("#cancel", dr).onclick = close;
  document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", k); } });
  $$("[data-ev]", dr).forEach(b => b.onclick = () => openEventSheet(d, b.dataset.ev, async ev => {
    await Admin.event(d.id, ev, S.user.email); toast("이력에 남겼습니다"); close(); await reload();
    actionToast("카톡방에도 알릴까요?", "카톡 문구 복사", () => shareText(kakaoEventText(d, ev)));
  }, { admin: true }));
  const kr = $("#kk-req", dr); if (kr) kr.onclick = () => shareText(kakaoReqText([d]));
  const kd = $("#kk-done", dr); if (kd) kd.onclick = () => shareText(kakaoDoneText(d));
  if ($("#rcpts", dr)) Admin.attachments(d.id).then(L => { $("#rcpts", dr).innerHTML = L.length ? L.map(a => `<button class="thumb" data-src="${a.id}"><img src="${a.data}" alt="영수증"></button>`).join("") : '<span class="muted">사진 없음</span>';
    $$("#rcpts [data-src]", dr).forEach(b => b.onclick = () => showImage(L.find(a => String(a.id) === b.dataset.src).data)); }).catch(() => { $("#rcpts", dr).textContent = "-"; });
  Admin.audit(d.id).then(L => { $("#log", dr).innerHTML = auditRowsHtml(L); }).catch(e => { $("#log", dr).textContent = "-"; });
  $("#q-send", dr).onclick = async () => { const body = $("#q-body", dr).value.trim(); if (!body) return toast("질문을 적어 주세요");
    try { await Admin.comment(d.id, body); close(); await reload(); toast("질문을 남겼습니다 — 더한물류 화면에 바로 보입니다"); actionToast("카톡방에도 알릴까요?", "카톡 문구 복사", () => shareText(`[질문] #${d.id} ${dLabel(d.run_date)} ${d.from_place}→${d.to_place}\n${body}`)); } catch (e) { toast(e.message); } };
  $$("[data-close]", dr).forEach(b => b.onclick = async () => { await Admin.closeComment(d.id, +b.dataset.close); close(); await reload(); toast("해결로 닫았습니다"); });
  $("#save", dr).onclick = async () => {
    const g = id => $("#" + id, dr)?.value;
    Object.assign(x, { run_date: g("e-date"), time_slot: g("e-slot"), from_place: g("e-from"), to_place: g("e-to"), plt_qty: numOrNull(g("e-plt")), temp: g("e-temp"), ref_code: g("e-code"), group_no: g("e-grp"), via_place: g("e-via"), category: g("e-cat"), cargo_note: g("e-note"), vendor_id: g("e-vendor") || null, status: g("e-st"),
      driver_name: g("e-drv"), vehicle_no: g("e-car"), vehicle_ton: numOrNull(g("e-ton")), vehicle_body: g("e-body") });
    FARE_KEYS.forEach(k => delete x[k]);   // 금액 · 회차는 더한물류만
    if (x.type === "delivery") Object.assign(x.delivery, { customer_name: g("c-name"), customer_phone: g("c-phone"), product: g("c-prod"), qty: g("c-qty"), address: g("c-addr"), done_note: g("c-done") });
    if (x.origin === "vendor" && x.status === "done") x.origin = "vendor";   // 확인해도 업체 등록 표시는 남김
    try { await Admin.save(x, S.user.email); toast("저장했습니다"); close(); await reload(); } catch (e) { toast("저장 실패: " + e.message); }
  };
}

// ---------------- 정산 ----------------
async function viewSettle(v) {
  const R = S.rows.filter(d => ["done", "confirmed"].includes(d.status) || (d.status === "canceled" && +d.return_fare > 0));   // 운행 안 했어도 회차비는 정산
  const conf = await Admin.settlements(S.month).catch(() => []);
  const vendors = S.refs.vendors.filter(x => R.some(d => d.vendor_id === x.id));
  const card = vd => {
    const L = R.filter(d => d.vendor_id === vd.id);
    const sum = L.reduce((a, d) => a + cost(d), 0);
    const missing = L.filter(d => !d.base_fare && d.status !== "canceled").length;
    const trb = L.filter(d => (d.events || []).some(e => TROUBLE.includes(e.kind))), retSum = L.reduce((a, d) => a + (+d.return_fare || 0), 0);
    const over = L.filter(d => d.rate_fare && d.base_fare && billed(d) > d.rate_fare);
    const vm = L.filter(d => d.origin === "vendor").length;
    const done = conf.find(s => s.vendor_id === vd.id);
    const byType = Object.keys(TYPES).map(tp => { const X = L.filter(d => d.type === tp); return X.length ? `<tr><td>${typeTag(tp)}</td><td class="r num">${X.length}</td><td class="r num">${won(X.reduce((a, d) => a + cost(d), 0))}</td></tr>` : ""; }).join("");
    return `<div class="card"><div class="row" style="justify-content:space-between"><h2>${esc(vd.name)}</h2>${done ? `<span class="st confirmed">정산 확정 ${esc(String(done.confirmed_at).slice(0, 10))}</span>` : `<span class="st done">확정 전</span>`}</div>
      <p class="sub">${+S.month.slice(5)}월 운행 완료 ${L.length}건</p>
      <div class="kpis" style="grid-template-columns:repeat(3,1fr)"><div class="kpi"><div class="l">공급가액</div><div class="v num">${won(sum)}</div></div><div class="kpi"><div class="l">세액 10%</div><div class="v num">${won(sum * 0.1)}</div></div><div class="kpi"><div class="l">합계금액</div><div class="v num">${won(sum * 1.1)}</div></div></div>
      <div class="tbl-wrap" style="margin-top:12px;max-height:none"><table class="tbl"><thead><tr><th>유형</th><th class="r">건수</th><th class="r">금액(원)</th></tr></thead><tbody>${byType}</tbody></table></div>
      <ul class="alerts" style="padding-left:18px;font-size:13.5px">
        ${missing ? `<li style="color:var(--bad)">금액이 빈 운행 ${missing}건 — 더한물류 입력 필요</li>` : ""}
        ${L.some(d => qState(d) === "waiting") ? `<li style="color:var(--warn)">답변 대기 질문 ${L.filter(d => qState(d) === "waiting").length}건 — 확정 전에 확인</li>` : ""}
        ${over.length ? `<li style="color:var(--warn)">운임표보다 비싼 청구 ${over.length}건 · ${won(over.reduce((a, d) => a + billed(d) - d.rate_fare, 0))}원 — 사유 확인</li>` : ""}
        ${vm ? `<li>업체가 직접 올린 운행 ${vm}건 포함</li>` : ""}
        ${trb.length ? `<li>취소 · 회차가 있었던 건 ${trb.length}건${retSum ? ` · 회차비 ${won(retSum)}원 포함` : ""}</li>` : ""}
        ${!missing && !over.length ? `<li style="color:var(--good)">검증 문제 없음</li>` : ""}
      </ul>
      <div class="row" style="justify-content:flex-end"><button class="btn sm" data-csv="${vd.id}">운행내역서 CSV</button><button class="btn primary sm" data-conf="${vd.id}" ${missing ? "disabled title='금액이 빈 건을 먼저 채워 주세요'" : ""}>${done ? "다시 확정" : "정산 확정"}</button></div></div>`;
  };
  v.innerHTML = `<div class="grid"><div class="card"><h2>${S.month.replace("-", "년 ")}월 정산</h2><p class="sub">운행 완료 · 정산 확정 건만 셉니다(청구금액 = 기본 + 추가, 회차 포함). 확정하면 그 건은 업체가 고칠 수 없습니다.</p></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(360px,1fr))">${vendors.map(card).join("") || `<div class="card empty">이 달 운행 완료 건이 없습니다</div>`}</div></div>`;
  $$("[data-csv]", v).forEach(b => b.onclick = () => { const vd = S.refs.vendors.find(x => x.id === b.dataset.csv); downloadCsv(R.filter(d => d.vendor_id === vd.id).sort((a, c) => a.run_date.localeCompare(c.run_date)), `${vd.name}_운행내역서_${S.month}.csv`); });
  $$("[data-conf]", v).forEach(b => b.onclick = async () => {
    const vd = S.refs.vendors.find(x => x.id === b.dataset.conf); const L = R.filter(d => d.vendor_id === vd.id);
    const sum = L.reduce((a, d) => a + cost(d), 0);
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
    <div class="card"><h2>매장 · 배송요청 링크</h2><p class="sub">매장 직원이 휴대폰으로 고객 배송을 요청합니다(영수증 사진 + 배송요청서 항목). 종이 요청서 · 확인서는 매장에 보관합니다.</p>
      <div class="tbl-wrap" style="max-height:none"><table class="tbl"><thead><tr><th>매장</th><th>PIN</th><th>접속 링크</th><th></th></tr></thead><tbody>${(S.refs.stores || []).map(x => `<tr><td><b>${esc(x.name)}</b></td><td>${LIVE ? '<span class="muted">SQL로 관리</span>' : `<span class="num">${esc(x.pin)}</span>`}</td>
        <td><input readonly value="${esc(base + "?s=" + encodeURIComponent(x.name))}" style="width:100%;border:1px solid var(--line);border-radius:7px;padding:5px 7px;background:var(--panel2)" onclick="this.select()"></td>
        <td class="row" style="gap:6px;flex-wrap:nowrap"><a class="btn sm" href="${esc(base + "?s=" + encodeURIComponent(x.name))}" target="_blank" rel="noopener">새 창</a><button class="btn sm" data-sprev="${esc(x.name)}">이 창에서 보기</button></td></tr>`).join("") || `<tr><td colspan="4" class="muted">등록된 매장이 없습니다(운영 가이드의 SQL로 추가)</td></tr>`}</tbody></table></div></div>
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
  $$("[data-sprev]", v).forEach(b => b.onclick = () => { location.hash = "s=" + encodeURIComponent(b.dataset.sprev); location.reload(); });
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
    <h2>${esc(name)}</h2><p class="sub">킹콩백화점 배차 입력 · PIN 4자리를 넣어 주세요${LIVE ? "" : "<br><span class='muted'>(데모: 더한물류 1357)</span>"}</p>
    <form id="pf"><div class="field"><label for="pin" class="hidden">PIN</label><input id="pin" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus aria-label="PIN"></div>
    <button class="btn primary" style="width:100%;margin-top:12px;min-height:52px;font-size:17px" type="submit">들어가기</button></form><p class="hint" id="err" role="alert"></p></div></div>`;
  $("#pf").onsubmit = async e => { e.preventDefault(); try { await Vendor.login(name, $("#pin").value.trim()); vendorLoad(); } catch (err) { $("#err").textContent = err.message; } };
}
async function vendorLoad(quiet) {
  const before = new Set(V.rows.filter(d => d.status === "requested").map(d => d.id));
  try { [V.rows, V.refs] = await Promise.all([Vendor.list(), Vendor.refs()]); } catch (e) { if (!quiet) app.innerHTML = `<div class="empty">불러오기 실패: ${esc(e.message)}</div>`; return; }
  const fresh = V.loaded ? V.rows.filter(d => d.status === "requested" && !before.has(d.id)) : [];
  V.loaded = true; vendorRender();
  if (fresh.length) { toast(`새 배차 요청 ${fresh.length}건이 들어왔습니다`); try { navigator.vibrate && navigator.vibrate(200); } catch (_) {} }
}
const needsInput = d => d.status === "requested" || (d.status === "assigned" && !d.base_fare) || (["assigned", "done"].includes(d.status) && !d.driver_name);
function vendorRender() {
  const t = today();
  const todo = V.rows.filter(d => d.status !== "canceled" && needsInput(d)), mine = V.rows.filter(d => !needsInput(d) || d.status === "canceled");
  const asked = V.rows.filter(d => qState(d) === "waiting");
  const L0 = V.tab === "todo" ? todo : V.tab === "done" ? mine : V.tab === "q" ? V.rows.filter(d => qState(d)) : V.rows;
  const dayOk = d => V.day === "all" || (V.day === "today" ? d.run_date === t : V.day === "tomorrow" ? d.run_date === addDays(t, 1) : V.day === "past" ? d.run_date < t : d.run_date > addDays(t, 1));
  const L = L0.filter(dayOk);
  const groups = {}; L.forEach(d => (groups[d.run_date] ||= []).push(d));
  const dates = Object.keys(groups).sort((a, b) => V.tab === "todo" ? a.localeCompare(b) : b.localeCompare(a));
  const monthSum = V.rows.filter(d => monthOf(d.run_date) === t.slice(0, 7) && d.base_fare).reduce((a, d) => a + billed(d) + (+d.return_fare || 0), 0);
  app.innerHTML = `<div class="m">
    <div class="m-head"><div class="who">킹콩백화점 배차 · ${esc(Vendor.name)}${LIVE ? "" : " · 데모"}</div>
      <div class="ttl">${todo.length ? `입력할 배차 ${todo.length}건` : "입력할 배차가 없습니다"}</div>
      <div class="paste-btn"><button class="btn sm" id="v-guide">양식</button><button class="btn sm" id="v-paste">카톡 글 붙여넣기</button></div>
      <div class="who">이번 달 청구 ${won(monthSum)}원${!LIVE && location.hash.includes("v=") ? ` · <a href="#" id="to-admin" style="color:inherit">관리자 화면으로</a>` : ""}</div>
      <div class="m-tabs" role="group" aria-label="보기">${[["todo", `입력 필요 ${todo.length}`], ["q", `질문 ${asked.length}`], ["done", `입력 완료 ${mine.length}`], ["all", "전체"]].map(([k, l]) => `<button data-vt="${k}" aria-pressed="${V.tab === k}">${l}</button>`).join("")}</div></div>
    <div class="m-days" role="group" aria-label="날짜">${[["all", "전체"], ["today", "오늘"], ["tomorrow", "내일"], ["later", "모레 이후"], ["past", "지난 운행"]].map(([k, l]) => `<button data-vd="${k}" aria-pressed="${V.day === k}">${l}</button>`).join("")}</div>
    <div class="m-list">${dates.length ? dates.map(dd => `<div class="m-date">${dLabel(dd)}${dd === t ? " · 오늘" : dd === addDays(t, 1) ? " · 내일" : ""}</div>` + groups[dd].map(cardHtml).join("")).join("") : `<div class="empty">해당하는 배차가 없습니다</div>`}</div>
    <p class="build">build ${BUILD}</p><button class="fab" id="fab">+ 요청 없이 운행한 건 추가</button></div>`;
  $$("[data-vt]").forEach(b => b.onclick = () => { V.tab = b.dataset.vt; vendorRender(); });
  $$("[data-vd]").forEach(b => b.onclick = () => { V.day = b.dataset.vd; vendorRender(); });
  $$(".m-card").forEach(b => b.onclick = () => openSheet(V.rows.find(d => d.id === +b.dataset.id)));
  $("#fab").onclick = () => openSheet(null);
  $("#v-paste").onclick = () => openVendorPaste();
  $("#v-guide").onclick = () => openGuide("vendor");
  const ta = $("#to-admin"); if (ta) ta.onclick = e => { e.preventDefault(); location.hash = ""; location.reload(); };
}
function cardHtml(d) {
  const to = d.type === "delivery" ? (d.delivery?.address || "고객") : d.to_place;
  return `<button class="m-card t-${d.type}" data-id="${d.id}">
    <div class="row" style="justify-content:space-between"><span class="row" style="gap:4px">${typeTag(d.type)}${evBadges(d)}${qBadge(d)}${d.origin === "store" ? '<span class="flag st-flag">매장</span>' : ""}</span>${d.status === "canceled" ? stTag("canceled") : needsInput(d) ? `<span class="need">${d.status === "requested" && (d.events || []).some(e => TROUBLE.includes(e.kind)) ? "재배차 필요" : "입력 필요"}</span>` : stTag(d.status)}</div>
    <div class="route">${esc(d.from_place)} <span class="arw">→</span> ${esc(to)}</div>
    <div class="meta">${d.time_slot ? `<span>${esc(d.time_slot)}</span>` : ""}${d.plt_qty != null ? `<span>${d.plt_qty} PLT</span>` : ""}${d.group_no ? `<span>그룹 ${esc(d.group_no)}</span>` : ""}${d.via_place ? `<span>경유 ${esc(d.via_place)}</span>` : ""}${d.temp && d.temp !== "상온" ? `<span>${esc(d.temp)}</span>` : ""}${d.type === "delivery" ? `<span>${esc(d.delivery?.product || "")} ${esc(d.delivery?.qty || "")}</span>` : ""}${d.cargo_note && d.type !== "delivery" ? `<span>${esc(d.cargo_note)}</span>` : ""}</div>
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
  el.innerHTML = `<header><button class="btn ghost" id="sx" aria-label="닫기">←</button><h3>${isNew ? "요청 없이 운행한 건 추가" : "배차 입력"}</h3>${d0 && d.driver_name ? `<button class="btn sm" id="s-share">카톡 문구</button>` : ""}${d0 ? stTag(d.status) : ""}</header>
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
        ${d.pickup_addr ? `<div class="muted">상차지 ${esc(d.pickup_addr)} ${esc(d.pickup_contact || "")}</div>` : ""}
        ${d.type === "delivery" && d.delivery ? `<div style="margin-top:8px">${deliveryDetailHtml(d.delivery, { phoneLink: true })}</div>` : ""}</div>
      ${(d.events || []).length > 1 ? `<details ${(d.events || []).some(e => TROUBLE.includes(e.kind)) ? "open" : ""}><summary class="sec-t" style="cursor:pointer">진행 이력 ${evBadges(d)}</summary>${timelineHtml(d.events)}</details>` : ""}
      ${!locked && d.status !== "canceled" && d.driver_name ? `<div class="ev-box"><p class="sec-t">이 배차에 일이 생겼나요?</p><div class="row" style="gap:6px"><button class="btn" data-vev="cancel_driver">기사 취소 · 재배차</button><button class="btn" data-vev="return">회차</button><button class="btn" data-vev="change">변경</button></div></div>` : ""}
      ${d.type === "delivery" && !locked ? `<div class="field"><label for="s-rdate">배송일</label><input id="s-rdate" type="date" value="${d.run_date}"></div>` : ""}`}
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
    ${d0 ? `<div class="ev-box"><p class="sec-t">킹콩 질문 · 답변 ${qBadge(d)}</p>${threadHtml(d)}<div class="row" style="margin-top:8px;flex-wrap:nowrap"><input id="s-ans" class="q-input" placeholder="답변 · 메모 적기" aria-label="답변"><button class="btn primary" id="s-ans-btn" type="button">보내기</button></div></div>` : ""}
    <datalist id="dl-v">${(V.refs.places || []).map(p => `<option value="${esc(p)}">`).join("")}</datalist>
  </div>
  <footer>${locked ? `<button class="btn" id="sx2">닫기</button>` : isNew ? `<button class="btn primary" id="s-done-btn">운행 등록</button>` : `<button class="btn" id="s-asg">배차 저장</button><button class="btn primary" id="s-done-btn">운행 완료</button>`}</footer>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  $("#sx", el).onclick = close; const s2 = $("#sx2", el); if (s2) s2.onclick = close;
  const sh = $("#s-share", el); if (sh) sh.onclick = () => shareText(kakaoDoneText(d));
  const ab = $("#s-ans-btn", el); if (ab) ab.onclick = async () => { const body = $("#s-ans", el).value.trim(); if (!body) return toast("답변을 적어 주세요"); try { await Vendor.comment(d.id, body); close(); await vendorLoad(); toast("답변을 보냈습니다"); } catch (e) { toast(e.message); } };
  $$("[data-vev]", el).forEach(b => b.onclick = () => openEventSheet(d, b.dataset.vev, async ev => {
    await Vendor.event(d.id, ev); close(); await vendorLoad(); toast("저장했습니다");
    actionToast("단톡방에도 알릴까요?", "카톡 보내기", () => shareText(kakaoEventText(d, ev)));
  }));
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
    ...(d.type === "delivery" ? { done_note: val("s-done"), run_date: val("s-rdate") || d.run_date } : {}),
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
      close(); await vendorLoad();
      const after = { ...d, ...p, temp: d.temp || "상온" };
      if (!isNew && status === "assigned") actionToast("배차를 저장했습니다 · 단톡방에도 알릴까요?", "카톡 보내기", () => shareText(kakaoDoneText(after)));
      else toast(status === "done" ? "운행 완료로 저장했습니다" : "배차를 저장했습니다");
    } catch (e) { toast(e.message); }
  };
  const a = $("#s-asg", el); if (a) a.onclick = () => submit("assigned");
  const dn = $("#s-done-btn", el); if (dn) dn.onclick = () => submit("done");
}

// =====================================================================
//  카톡 · 엑셀 붙여넣기 해석 — 지금처럼 카톡/엑셀로 일하고, 그 글을 그대로 붙여넣으면 칸이 채워진다
// =====================================================================
const canon = s => String(s || "").replace(/\s+/g, "").replace(/^시그니처/, "");
// 지점 이름 맞추기: 표준 이름 · 별칭 · '시그니처' 유무 · 띄어쓰기 차이를 같은 곳으로
function resolvePlace(tok, list) {
  const t = String(tok || "").trim(); if (!t) return "";
  const c = canon(t);
  for (const p of list || []) { if (p.name === t || (p.aliases || []).includes(t)) return p.name; }
  for (const p of list || []) { if (canon(p.name) === c || (p.aliases || []).some(a => canon(a) === c)) return p.name; }
  return t;
}
const knownPlace = (tok, list) => (list || []).some(p => p.name === resolvePlace(tok, list));
const placeLike = (tok, list) => !!tok && /[가-힣A-Za-z]/.test(tok) && (knownPlace(tok, list) || /(센터|점|번가|물류|창고|FC|공장|본사)$/.test(tok) || /^[가-힣]{1,4}\d{1,2}$/.test(tok));
const sameSpot = (a, b, list) => !!a && !!b && canon(resolvePlace(a, list)) === canon(resolvePlace(b, list));

// 카톡 복사 머리말 떼기: "[킹콩 오태호 부장님] [오후 12:57] 내용" · "2026년 11월 3일 오후 12:57, 이름 : 내용" · "2026. 11. 3. 오후 12:57, 이름 : 내용"
const kTime = line => { const m = line.match(/(오전|오후)\s*(\d{1,2}):(\d{2})/); if (!m) return null; let h = +m[2] % 12; if (m[1] === "오후") h += 12; return `${String(h).padStart(2, "0")}:${m[3]}`; };
function splitKakao(text) {
  const msgs = []; let cur = null;
  const head1 = /^\[([^\]]+)\]\s*\[(오전|오후)\s*\d{1,2}:\d{2}\]\s?(.*)$/;
  const head2 = /^(\d{4})[년.]\s*(\d{1,2})[월.]\s*(\d{1,2})[일.]?\s*(?:(오전|오후)\s*\d{1,2}:\d{2})?,\s*([^:]+?)\s*:\s?(.*)$/;
  const dateLine = /^-*\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*[월화수목금토일]요일\s*-*$/;
  let day = null;   // 카톡 '대화 내보내기' 파일의 날짜 줄
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/​/g, "");
    const dl = line.trim().match(dateLine);
    if (dl) { day = `${dl[1]}-${dl[2].padStart(2, "0")}-${dl[3].padStart(2, "0")}`; cur = null; continue; }
    let m = line.match(head1);
    if (m) { cur = { who: m[1].trim(), date: day, time: kTime(line), lines: [m[3]] }; msgs.push(cur); continue; }
    m = line.match(head2);
    if (m) { cur = { who: m[5].trim(), date: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, time: kTime(line), lines: [m[6]] }; msgs.push(cur); continue; }
    if (!cur) { cur = { who: "", date: day, lines: [] }; msgs.push(cur); }
    cur.lines.push(line);
  }
  return msgs;
}
const PLT_RE = /(\d+(?:\.\d+)?)\s*(?:plt|PLT|Plt|파레트|파렛트|파렛|팔레트|빠레트)/;
function dateHint(s, base) {
  if (/내일/.test(s)) return addDays(base, 1);
  if (/모레/.test(s)) return addDays(base, 2);
  const m = s.match(/(\d{1,2})\s*[\/월.]\s*(\d{1,2})\s*일?/);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31 && !/\d{3,}/.test(m[0])) return `${base.slice(0, 4)}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

// 1) 킹콩 → 업체 배차 요청 카톡: "진천센터~이천점 18plt", "기흥센터-인천점 3plt", "기흥센터- 이천점2plt 경유 원주점2plt"
function parseKakaoRequests(text, places) {
  const out = [];
  for (const msg of splitKakao(text)) {
    const body = msg.lines.join("\n");
    const mDate = msg.date || dateHint(body, today()) || today();
    const head = msg.lines.find(l => /배차\s*요청|\d{1,2}\s*[\/월]\s*\d{1,2}/.test(l) && !/(~|→|->|-)\s*\S/.test(l)) || "";   // [배차요청] 11/4(화) 오전
    const mSlot = (head.match(/오전|오후|야간/) || [""])[0], mTemp = /냉동/.test(head) ? "냉동" : /냉장|신선/.test(head) ? "냉장" : "";
    const lines = msg.lines.map(l => l.trim()).filter(Boolean);
    lines.forEach((line, li) => {
      const m = line.match(/^(.*?[가-힣A-Za-z0-9])\s*(?:~|-|–|→|->|=>|>)+\s*(.+)$/);
      if (!m || /\d{2,4}-\d{3,4}/.test(line)) return;            // 전화번호 줄은 건너뜀
      const left = m[1].trim(); const words = left.split(/\s+/);
      const from = placeLike(left, places) ? left : placeLike(words[words.length - 1], places) ? words[words.length - 1] : null;
      if (!from) return;
      const stops = m[2].split(/경유/).map(part => {
        const p2 = part.trim(); const nm = (p2.match(/^[가-힣A-Za-z0-9]+?(?=\d+(?:\.\d+)?\s*(?:plt|파레트|파렛|팔레트|빠레트)|\s|$)/i) || [""])[0];
        const pl = p2.match(PLT_RE); return { name: nm, plt: pl ? +pl[1] : null };
      }).filter(x => x.name && !/^(배차|부탁|요청)/.test(x.name));
      if (!stops.length || !placeLike(stops[stops.length - 1].name, places)) return;
      let plt = stops.reduce((a, x) => a + (x.plt || 0), 0) || null;
      if (plt == null) { for (let k = li + 1; k < lines.length; k++) { const n = lines[k].match(PLT_RE); if (n) { plt = +n[1]; break; } if (/(~|-|→|>)/.test(lines[k])) break; } }
      const fromN = resolvePlace(from, places), to = stops[stops.length - 1];
      const fk = (places || []).find(p => p.name === fromN)?.kind;
      const temp = /냉동/.test(line) ? "냉동" : /냉장|신선/.test(line) ? "냉장" : mTemp || "상온";
      out.push({ type: fk === "쿠팡FC" ? "coupang" : "center", run_date: mDate, time_slot: (line.match(/오전|오후|야간/) || [mSlot])[0], from_place: fromN, to_place: resolvePlace(to.name, places),
        via_place: stops.length > 1 ? stops.slice(0, -1).map(x => resolvePlace(x.name, places)).join(", ") : "", plt_qty: plt, temp, group_no: "",
        cargo_note: stops.length > 1 ? "경유 " + stops.map(x => `${resolvePlace(x.name, places)}${x.plt ? " " + x.plt + "plt" : ""}`).join(" → ") : "",
        requested_by: msg.who.replace(/^킹콩\s*/, "") || "", src: line });
    });
  }
  return out;
}

// 2) 쿠팡 출고요청서(엑셀) 줄: NO · 낙찰일 · 입차CODE · 낙찰NO · Group Number · PLT수량 · 출고일시 · FC · (상차지 주소 · 담당자 · 연락처) · 도착지 · 카테. · 비고
function parseSheetRequests(text, places) {
  const rows = String(text || "").split(/\r?\n/).map(l => l.split("\t").map(c => c.trim()));
  let H = null; const raw = [];
  const isSlot = x => /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.]\d{1,2})\s*(오전|오후|야간)?$/.test(x) && /(오전|오후|야간)|\d{4}-/.test(x);
  for (const c of rows) {
    if (!c.some(Boolean)) continue;
    if (c.some(x => /group\s*number/i.test(x))) { H = {}; c.forEach((x, i) => { const k = x.replace(/[\s.]/g, ""); if (k && H[k] == null) H[k] = i; }); continue; }
    let r = null;
    if (H && H["출고일시"] != null && c[H["출고일시"]]) {
      const g = k => (H[k] != null ? c[H[k]] || "" : "");
      const noteIdx = H["비고"];
      r = { code: g("입차CODE"), bid: g("낙찰NO"), grp: g("GroupNumber"), plt: g("PLT수량"), when: g("출고일시"), fc: g("FC"), addr: g("상차지주소"), mgr: g("담당자"), tel: g("연락처"),
        dest: g("도착지"), cat: g("카테"), note: noteIdx != null ? c.slice(noteIdx).filter(Boolean).join(" / ") : "" };
    } else {
      const si = c.findIndex(isSlot); if (si < 4) continue;
      const rest = c.slice(si + 2); const addrLike = rest[0] && rest[0].length > 8 && /(시|도|군|구|로|길)\s/.test(rest[0] + " ");
      const tail = addrLike ? rest.slice(3) : rest;
      r = { code: c[si - 4], bid: c[si - 3], grp: c[si - 2], plt: c[si - 1], when: c[si], fc: c[si + 1], addr: addrLike ? rest[0] : "", mgr: addrLike ? rest[1] : "", tel: addrLike ? rest[2] : "",
        dest: tail[0] || "", cat: tail[1] || "", note: tail.slice(2).filter(Boolean).join(" / ") };
    }
    if (!r.fc || !r.dest || isNaN(parseFloat(r.plt))) continue;
    const w = r.when.match(/(\d{4})-(\d{1,2})-(\d{1,2})/) || r.when.match(/()(\d{1,2})[\/.](\d{1,2})/);
    const run = w ? `${w[1] || today().slice(0, 4)}-${w[2].padStart(2, "0")}-${w[3].padStart(2, "0")}` : today();
    raw.push({ type: "coupang", run_date: run, time_slot: (r.when.match(/오전|오후|야간/) || [""])[0], from_place: resolvePlace(r.fc, places), to_place: resolvePlace(r.dest, places), via_place: "",
      plt_qty: parseFloat(r.plt), temp: "상온", group_no: /^\d+$/.test(r.grp) ? r.grp : "", ref_code: r.code, bid_no: r.bid, category: r.cat, cargo_note: r.note,
      pickup_addr: r.addr, pickup_contact: [r.mgr, r.tel].filter(Boolean).join(" "), requested_by: "", src: `${r.fc} → ${r.dest} ${r.plt}PLT ${r.grp}` });
  }
  return raw;
}
// 같은 날 · 시간대 · FC → 도착지는 차 한 대(업체 카톡도 '그룹넘버 101903,101938' 처럼 묶어서 옴)
function mergeSheetRows(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = [r.run_date, r.time_slot, r.from_place, r.to_place].join("|");
    if (!m.has(k)) { m.set(k, { ...r, _n: 1 }); continue; }
    const x = m.get(k); x._n++;
    x.plt_qty = +(x.plt_qty || 0) + +(r.plt_qty || 0);
    const join = (a, b) => [...new Set([a, b].join(",").split(/\s*,\s*/).filter(Boolean))].join(",");
    x.group_no = join(x.group_no, r.group_no); x.ref_code = join(x.ref_code, r.ref_code); x.category = join(x.category, r.category);
    x.cargo_note = [...new Set([x.cargo_note, r.cargo_note].filter(Boolean))].join(" / "); x.src += " + " + r.src;
  }
  return [...m.values()];
}

// 3) 업체 → 킹콩 카톡(태성 양식 두 가지 + 취소 · 회차 · 변경 알림)
//   A) 경기 용인 -> 충남 아산 / [차주정보] 양현욱 / 01031045565 / [차량정보] 초장축냉동탑 / 1톤 / 경기94자5739 / 시그니처용인점 아산점 냉장 입니다 / 그룹넘버 101903,101938
//   B) 상차지 : 경기 여주 / 하차지 : … / 상차일시 : 12-04 / 기사명 : 민선기 / 기사전화 : 010… / 차량번호 : 서울84사1331 / 차종 : 윙바디16T / 여주2 방도리창고 입니다
//   알림: "취소입니다 재배차 하겠습니다" · "상차지연으로 회차 입니다 재배차 하겠습니다" · "하차지 이천센터로 변경 하였습니다" — 바로 위 배차 건(또는 줄에 적힌 상·하차지)에 붙는다
const EVENT_KINDS = { assign: "배차", reassign: "재배차", cancel_driver: "배차 취소", return: "회차", change: "변경", done: "운행 완료", cancel: "요청 취소", note: "메모", request: "요청" };
const EVENT_REASONS = { cancel_driver: ["상차지연", "기사 사정", "차량 고장", "상차지 물건 없음", "킹콩 요청 취소", "기타"], return: ["상차지연", "상차 순번 안 줄어듦", "상차지 물건 없음", "오전 상차 불가", "상차지 변경", "담당자 연락 안 됨", "기타"] };
function parseVendorKakao(text) {
  const items = []; let b = null;
  let li = 0;
  const start = () => { b = { kind: "assign", date: dateOf[li] || null, who: whoOf[li] || "", region: "", driver_name: "", driver_phone: "", vehicle_body: "", vehicle_ton: null, vehicle_no: "", from: "", to: "", temp: "", groups: [], src: [] }; items.push(b); };
  const raw = splitKakao(text).flatMap(m => m.lines.map(l => ({ l: l.trim(), who: m.who, date: m.date, time: m.time }))).filter(x => x.l);
  const lines = [], whoOf = [], dateOf = [], timeOf = []; raw.forEach(x => { if (/^입니다\.?$/.test(x.l) && lines.length) lines[lines.length - 1] += " 입니다"; else { lines.push(x.l); whoOf.push(x.who); dateOf.push(x.date); timeOf.push(x.time); } });
  const spotish = t => !!t && /[가-힣]/.test(t) && (/^[가-힣]{1,4}\d{1,2}(\.\w+)?$/.test(t) || /(센터|점|창고|번가|물류|허브|CFC)$/.test(t));   // '…시그니처용인점' / '입니다' 로 나뉜 메시지
  const setDesc = (bk, s) => { if (bk.to && s.split(/\s+/).length < 2) return; const toks = s.split(/\s+/).filter(t => { if (/^(냉장|냉동|상온)$/.test(t)) { bk.temp = t; return false; } return !/^(오전|오후|야간)$/.test(t) && !/파렛|빠렛|plt/i.test(t); }); bk.from = (toks[0] || "").replace(/\.$/, ""); bk.to = toks[1] || ""; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]; li = i;
    // 알림 줄(취소 · 회차 · 변경)
    const isCancel = /취소/.test(line) && !/\[/.test(line), isReturn = /회차/.test(line) && !/\[/.test(line), isChange = /(하차지|상차지|목적지|일정|날짜).{0,12}변경/.test(line) && !/:/.test(line);
    if (isCancel || isReturn || isChange) {
      const ev = isReturn ? "return" : isCancel ? "cancel_driver" : "change";
      const pre = line.split(/취소|회차|변경|으로|로\s/)[0].trim().split(/\s+/);
      const placed = pre.length >= 2 && spotish(pre[0]) && spotish(pre[1]);
      let reason = isChange ? line : line.replace(/(으로|로|되어서|해서|하여|어서|되어|이라|라서)?\s*(회차|취소).*$/, "").trim();
      if (placed) reason = reason.split(/\s+/).slice(2).join(" ");
      if (/^(이기사님|기사님)?$/.test(reason)) reason = "";
      const target = items.filter(x => x.kind === "assign").slice(-1)[0] || null;
      const toChg = isChange ? (line.match(/하차지\s*:?\s*(\S+?)(?:으로|로)?\s*변경/) || [])[1] || "" : "";
      items.push({ kind: "event", ev, reason: reason.slice(0, 60), note: line, who: whoOf[i] || "", date: dateOf[i] || null, at: timeOf[i] ? `${dateOf[i] || today()}T${timeOf[i]}:00` : null, to_change: toChg, from: placed ? pre[0] : "", to: placed ? pre[1] : "", after: target, rebook: /재배차/.test(line), src: [line] });
      b = null; continue;
    }
    const isRegion = (/(->|→|=>)/.test(line) && !/\[/.test(line)) || /^상차지\s*:/.test(line);
    if (isRegion || (/(\[차주정보\]|^기사명\s*:)/.test(line) && (!b || b.driver_name))) { if (!b || b.driver_name || b.region) start(); }
    if (!b) start();
    b.src.push(line);
    if (isRegion) { b.region = line.replace(/^상차지\s*:\s*/, ""); continue; }
    let m = line.match(/^(하차지|상차일시|하차일시)\s*:\s*(.*)$/);
    if (m) { if (m[1] === "하차지") b.region += " -> " + m[2]; if (m[1] === "상차일시") { const md = m[2].match(/(\d{1,2})-(\d{1,2})/); if (md) b.date = `${(b.date || today()).slice(0, 4)}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`; } continue; }
    m = line.match(/^기사명\s*:\s*(.*)$/); if (m) { b.driver_name = m[1].trim(); continue; }
    m = line.match(/^(?:기사전화|기사연락처|연락처)\s*:\s*(.*)$/); if (m) { const ph = m[1].replace(/[^\d]/g, ""); b.driver_phone = ph.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1-$2-$3"); continue; }
    m = line.match(/^차량번호\s*:\s*(.*)$/); if (m) { b.vehicle_no = m[1].replace(/\s/g, ""); continue; }
    m = line.match(/^차종\s*:\s*(.*)$/); if (m) { const t = m[1].trim(); const tn = t.match(/(\d+(?:\.\d+)?)\s*(?:T|톤)/i); if (tn) b.vehicle_ton = +tn[1]; b.vehicle_body = t.replace(/(\d+(?:\.\d+)?)\s*(?:T|톤)/i, "").trim(); continue; }
    m = line.match(/\[차주정보\]\s*(.*)$/);
    if (m) { const parts = m[1].split("/").map(x => x.trim()).filter(Boolean); b.driver_name = parts[0] || ""; const ph = m[1].replace(/[^\d]/g, "").match(/01\d{8,9}/); b.driver_phone = ph ? ph[0].replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1-$2-$3") : ""; continue; }
    m = line.match(/\[차량정보\]\s*(.*)$/);
    if (m) {
      let rest = m[1]; if (lines[i + 1] && /^\d{1,4}$/.test(lines[i + 1])) { rest += lines[++i]; }   // 카톡에서 줄이 넘어간 차량번호 끝자리
      const parts = rest.split("/").map(x => x.trim()).filter(Boolean); const body = [];
      parts.forEach(p => { const t = p.match(/^(\d+(?:\.\d+)?)\s*(?:톤|T)$/i); const no = p.replace(/\s/g, "").match(/^[가-힣]{0,2}\d{2,3}[가-힣]\d{4}$/);
        if (t) b.vehicle_ton = +t[1]; else if (no) b.vehicle_no = no[0]; else body.push(p); });
      b.vehicle_body = body.join(" "); continue;
    }
    m = line.match(/그룹\s*넘버\s*[:：]?\s*(.*)$/);
    if (m) { let g = m[1]; while (lines[i + 1] && /^[\d,\s]+$/.test(lines[i + 1])) g += "," + lines[++i]; b.groups = (g.match(/\d{5,}/g) || []); continue; }
    m = line.match(/^(.+?)\s*입니다\.?$/);
    if (m) { setDesc(b, m[1]); continue; }
    if (!b.to && b.driver_name) { const tk = line.split(/\s+/); if (tk.length >= 2 && tk.length <= 4 && spotish(tk[0]) && spotish(tk[1])) setDesc(b, line); }
  }
  return items.filter(x => x.kind === "event" || x.driver_name || x.vehicle_no);
}
// 업체 카톡 한 덩어리 ↔ 요청 건 짝 찾기(그룹넘버 > 상·하차지 > 날짜 가까운 순)
function matchScore(bk, d, list) {
  if (["confirmed", "canceled"].includes(d.status)) return -1;
  let s = 0;
  const g = String(d.group_no || "").split(/\s*,\s*/).filter(Boolean);
  if (bk.groups.length && g.some(x => bk.groups.includes(x))) s += 100;
  if (bk.to && sameSpot(bk.to, d.type === "delivery" ? "" : d.to_place, list)) s += 30;
  if (bk.from && sameSpot(bk.from, d.from_place, list)) s += 20;
  if (s === 0) return 0;
  const gap = Math.abs((new Date(d.run_date) - new Date(bk.date || today())) / 864e5); if (gap > 3 && s < 100) return 0; s -= Math.min(gap, 10) * 3;
  if (d.status === "requested") s += 5; if (!d.driver_name) s += 5;
  return s;
}

// ---- 카톡으로 보내기: 휴대폰은 공유창(카톡 선택), PC는 복사 ----
async function shareText(text, title = "킹콩 배차") {
  const mobile = matchMedia("(pointer:coarse)").matches;
  if (mobile && navigator.share) { try { await navigator.share({ text, title }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
  try { await navigator.clipboard.writeText(text); toast("복사했습니다 — 카톡방에 붙여넣기(Ctrl+V) 하세요"); }
  catch (_) { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("복사했습니다 — 카톡방에 붙여넣으세요"); } catch (_) { prompt("아래 글을 복사하세요", text); } ta.remove(); }
}
const phoneDigits = p => String(p || "").replace(/[^\d]/g, "");
// 업체 → 단톡방: 지금 쓰는 양식 그대로
function kakaoDoneText(d) {
  const to = d.type === "delivery" ? (d.delivery?.address || "고객") : d.to_place;
  return [`${d.from_place} -> ${to}`, `[차주정보] ${d.driver_name || ""} / ${phoneDigits(d.driver_phone)}`, `[차량정보] ${[d.vehicle_body, d.vehicle_ton ? d.vehicle_ton + "톤" : "", d.vehicle_no].filter(Boolean).join(" / ")}`, "",
    `${d.from_place} ${d.type === "delivery" ? "고객배송" : d.to_place}${d.temp && d.temp !== "상온" ? " " + d.temp : ""} 입니다`, d.group_no ? `그룹넘버\n${d.group_no}` : "",
    d.type === "delivery" ? `배송일 ${dLabel(d.run_date)}` : ""].filter((x, i) => x !== "" || i === 3).join("\n").trim();
}
// 킹콩 → 단톡방: 배차 요청 문구
function kakaoReqText(L) {
  const byDate = {}; L.forEach(d => (byDate[d.run_date] ||= []).push(d));
  return Object.keys(byDate).sort().map(dd => `${dLabel(dd)} 배차 부탁드립니다\n` + byDate[dd].map(d => `${d.from_place}~${d.via_place ? d.via_place + " 경유 " : ""}${d.type === "delivery" ? "고객(" + (d.delivery?.address || "") + ")" : d.to_place}` +
    `${d.plt_qty ? " " + d.plt_qty + "plt" : ""}${d.temp && d.temp !== "상온" ? " " + d.temp : ""}${d.time_slot ? " " + d.time_slot : ""}${d.group_no ? " (그룹 " + d.group_no + ")" : ""}`).join("\n")).join("\n\n");
}
// 저장 뒤 '카톡방에 알리기' 같은 버튼이 달린 알림
function actionToast(msg, label, fn) {
  $("#act-toast")?.remove();
  const t = document.createElement("div"); t.id = "act-toast"; t.className = "toast act"; t.innerHTML = `<span>${esc(msg)}</span><button class="btn sm">${esc(label)}</button>`;
  t.querySelector("button").onclick = () => { t.remove(); fn(); }; document.body.appendChild(t); setTimeout(() => t.remove(), 9000);
}

// ---- 고객배송 요청서 내용 보기(관리자 · 업체 · 매장 공용) ----
function deliveryDetailHtml(x, { phoneLink = false } = {}) {
  if (!x) return "";
  const row = (k, v) => (v === "" || v == null) ? "" : `<div class="kv"><span>${k}</span><div>${v}</div></div>`;
  const items = Array.isArray(x.items) && x.items.length ? x.items.map(i => `${esc(i.name)} <b>${esc(i.qty ?? "")}</b>${i.size === "대형" ? ' <span class="flag">대형</span>' : ""}`).join("<br>") : esc(`${x.product || ""} ${x.qty || ""}`.trim());
  const who = x.buyer_same === false ? `구매인 ${esc(x.buyer_name || "")} · 수화인 ${esc(x.receiver_name || "")}` : esc(x.customer_name || "");
  const tel = x.customer_phone ? (phoneLink ? `<a href="tel:${esc(phoneDigits(x.customer_phone))}">${esc(x.customer_phone)} 전화</a>` : esc(x.customer_phone)) : "";
  return `<div class="kvs">
    ${row("제품", items)}${row("T/T 파레트", x.tt_plt != null && x.tt_plt !== "" ? esc(x.tt_plt) : "")}
    ${row("고객", [who, tel].filter(Boolean).join(" · "))}${row("주소", esc(x.address || ""))}
    ${row("엘리베이터", esc(x.elevator || ""))}${row("폐가구·가전 이동", esc(x.disposal || ""))}${row("거리", esc(x.distance || ""))}
    ${row("2곳 이상 배송", x.multi_stop == null ? "" : x.multi_stop ? '<b style="color:var(--bad)">있음</b>' : "없음")}
    ${row("배송 조건", [esc(x.terms || ""), x.extra_paid ? `추가 결제 ${won(x.extra_paid)}원` : ""].filter(Boolean).join(" · "))}
    ${row("희망일", x.asap ? "<b>최대한 빠른 날짜</b>" : "")}${row("요청사항", esc(x.request_note || ""))}
    ${row("완료 메모", esc(x.done_note || ""))}
    ${x.paper_kept != null || x.consent_signed != null ? row("서류", `${x.paper_kept ? "요청서 원본 매장 보관" : '<span style="color:var(--bad)">요청서 원본 보관 안 됨</span>'} · ${x.consent_signed ? "고객 확인서 서명 받음" : '<span style="color:var(--bad)">확인서 서명 없음</span>'}`) : ""}
  </div>`;
}
function showImage(src) {
  const bg = document.createElement("div"); bg.className = "lightbox"; bg.innerHTML = `<img alt="영수증 사진" src="${esc(src)}"><button class="btn" aria-label="닫기">✕ 닫기</button>`;
  bg.onclick = () => bg.remove(); document.body.appendChild(bg);
}
async function shrinkImage(file, max = LIVE ? 1400 : 1000, q = LIVE ? 0.72 : 0.6) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("사진을 읽지 못했습니다")); i.src = url; });
    const r = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement("canvas");
    c.width = Math.round(img.width * r); c.height = Math.round(img.height * r); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", q);
  } finally { URL.revokeObjectURL(url); }
}

// ---- 업체 카톡 글 → 어느 요청에 붙일지 계획(관리자 · 업체 공용) ----
function buildPlan(items, rows, places) {
  const used = new Set(), byItem = new Map();
  return items.map(it => {
    if (it.kind === "assign") {
      const sc = rows.map(d => [d, matchScore(it, d, places)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
      const free = sc.filter(([d]) => !used.has(d.id));
      const best = free[0] && free[0][1] >= 25 ? free[0][0] : null;
      if (best) used.add(best.id);
      const pl = { it, target: best, cands: sc.slice(0, 8).map(x => x[0]) }; byItem.set(it, pl); return pl;
    }
    let target = null, viaPlan = null;
    if (it.from && it.to) { const sc = rows.map(d => [d, matchScore({ ...it, groups: [] }, d, places)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]); target = sc[0]?.[0] || null; }
    if (!target && it.after) { const ap = byItem.get(it.after); if (ap) { target = ap.target; if (!target) viaPlan = ap; } }
    if (target) used.delete(target.id);   // 취소 · 회차 뒤 '재배차' 글이 같은 요청에 다시 붙도록
    const near = rows.filter(d => d.driver_name && !["confirmed", "canceled"].includes(d.status)).sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))).slice(0, 8);
    return { it, target, viaPlan, cands: target ? [target, ...near.filter(d => d.id !== target.id)] : near };
  });
}
const rowLabel = d => `#${d.id} ${dLabel(d.run_date)} ${d.from_place}→${d.type === "delivery" ? "고객" : d.to_place}${d.plt_qty ? " " + d.plt_qty + "PLT" : ""}${d.group_no ? " 그룹 " + d.group_no : ""} · ${STATUS[d.status]}${d.driver_name ? " · " + d.driver_name : ""}`;
function planHtml(plan) {
  if (!plan.length) return "";
  return `<div class="plan">${plan.map((p, i) => {
    const it = p.it;
    if (it.kind === "assign") return `<div class="plan-it k-assign"><div class="row" style="justify-content:space-between"><b>배차 · ${esc(it.from || "?")} → ${esc(it.to || "?")}</b><span class="muted">${it.date ? dLabel(it.date) : ""} ${esc(whoLabel(it.who))}</span></div>
      <div class="muted">${esc(it.driver_name)} ${esc(it.driver_phone)} · ${esc(it.vehicle_body)} ${it.vehicle_ton ? it.vehicle_ton + "톤" : ""} · ${esc(it.vehicle_no)}${it.groups.length ? " · 그룹 " + esc(it.groups.join(",")) : ""}</div>
      <select data-pi="${i}" aria-label="연결할 요청">${p.cands.map(d => `<option value="${d.id}" ${p.target && p.target.id === d.id ? "selected" : ""}>요청에 연결: ${esc(rowLabel(d))}</option>`).join("")}
        <option value="new" ${p.target ? "" : "selected"}>요청 없음 → 새 운행으로 추가</option><option value="skip">건너뛰기</option></select></div>`;
    const lab = EVENT_KINDS[it.ev];
    return `<div class="plan-it k-${it.ev}"><div class="row" style="justify-content:space-between"><b>${esc(lab)}${it.reason && it.ev !== "change" ? " · " + esc(it.reason) : ""}</b><span class="muted">${it.date ? dLabel(it.date) : ""} ${esc(whoLabel(it.who))}</span></div>
      <div class="muted">"${esc(it.note)}"</div>
      <select data-pi="${i}" aria-label="적용할 배차">${p.viaPlan ? `<option value="via" selected>바로 위 새 운행</option>` : ""}${p.cands.map(d => `<option value="${d.id}" ${p.target && p.target.id === d.id ? "selected" : ""}>${esc(rowLabel(d))}</option>`).join("")}
        <option value="skip" ${p.target || p.viaPlan ? "" : "selected"}>건너뛰기</option></select></div>`;
  }).join("")}</div>`;
}
const carOf = it => ({ driver_name: it.driver_name, driver_phone: it.driver_phone, vehicle_no: it.vehicle_no, vehicle_ton: it.vehicle_ton, vehicle_body: it.vehicle_body });
// api = { assign(row, car), create(it) → id, event(id, ev) }
async function applyPlan(plan, root, api, places) {
  let n = 0; const made = new Map();
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i], v = $(`[data-pi="${i}"]`, root)?.value || "skip"; if (v === "skip") continue;
    if (p.it.kind === "assign") {
      if (v === "new") made.set(p, await api.create(p.it));
      else { const row = p.cands.find(d => String(d.id) === v); await api.assign(row, carOf(p.it)); made.set(p, row.id); }
    } else {
      const id = v === "via" ? made.get(p.viaPlan) : +v; if (!id) continue;
      const ev = { kind: p.it.ev, reason: p.it.reason, note: (p.it.at ? `카톡 ${p.it.at.slice(5, 10).replace("-", "/")} ${p.it.at.slice(11, 16)} · ` : "") + p.it.note, end: false };   // 순서가 꼬이지 않게 기록 시각은 반영한 때, 카톡 시각은 메모로
      if (p.it.ev === "change" && p.it.to_change) ev.to_place = resolvePlace(p.it.to_change, places);
      await api.event(id, ev);
    }
    n++;
  }
  return n;
}

// =====================================================================
//  배차 이력(타임라인) — 요청 → 배차 → 취소 · 회차 · 변경 → 재배차 → 완료
// =====================================================================
const TROUBLE = ["cancel_driver", "return"];
const tms = at => { const t = new Date(at).getTime(); return isNaN(t) ? 0 : t; };   // 운영(UTC) · 데모(현지) 시간 모두 현지 시각으로
const fmtAt = at => { const d = new Date(at); return isNaN(d) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const evOf = (d, k) => (d.events || []).filter(e => e.kind === k);
const cost = d => (d.status === "canceled" ? 0 : billed(d)) + (+d.return_fare || 0);   // 취소된 건도 회차비는 남는다
const counted = d => d.status !== "canceled" || +d.return_fare > 0;
function evBadges(d) {
  const c = evOf(d, "cancel_driver").length, r = evOf(d, "return").length, ch = evOf(d, "change").length;
  return (c ? `<span class="evb ev-c" title="기사 취소 후 다시 배차">재배차 ${c}</span>` : "") + (r ? `<span class="evb ev-r" title="상차 못 하고 돌아옴">회차 ${r}</span>` : "") + (ch ? `<span class="evb ev-ch">변경 ${ch}</span>` : "");
}
const whoLabel = by => !by ? "" : by.startsWith("vendor:") ? by.slice(7) : by.startsWith("store:") ? by.slice(6) : by.split("@")[0];
function timelineHtml(evs, { compact = false } = {}) {
  if (!evs || !evs.length) return `<div class="muted">기록 없음</div>`;
  const L = [...evs].sort((a, b) => tms(a.at) - tms(b.at));
  return `<ol class="tl">${L.map(e => {
    const t = fmtAt(e.at);
    const car = e.driver_name ? `${esc(e.driver_name)}${e.vehicle_no ? " · " + esc(e.vehicle_no) : ""}${e.vehicle_ton ? " · " + e.vehicle_ton + "톤" : ""}${e.vehicle_body ? " " + esc(e.vehicle_body) : ""}` : "";
    const showCar = ["assign", "reassign", "cancel_driver", "return"].includes(e.kind) && car && !compact;
    return `<li class="k-${e.kind}"><div class="tl-h"><b>${esc(EVENT_KINDS[e.kind] || e.kind)}</b><span class="muted">${esc(t)}${e.by ? " · " + esc(whoLabel(e.by)) : ""}</span></div>
      ${showCar ? `<div>${car}</div>` : ""}${e.reason ? `<div class="tl-r">${esc(e.reason)}</div>` : ""}${e.note ? `<div class="muted">${esc(e.note)}</div>` : ""}${e.fare ? `<div>회차금액 <b class="num">${won(e.fare)}원</b></div>` : ""}</li>`;
  }).join("")}</ol>`;
}
const snapCar = d => ({ driver_name: d.driver_name || "", driver_phone: d.driver_phone || "", vehicle_no: d.vehicle_no || "", vehicle_ton: d.vehicle_ton ?? null, vehicle_body: d.vehicle_body || "" });
// 데모 저장소에서 이벤트 적용(운영은 DB 함수 dispatch_event_apply 가 같은 일을 함)
function applyEventLocal(d, ev, actor) {
  if (d.status === "confirmed") throw new Error("정산 확정된 건은 고칠 수 없습니다");
  const e = { at: ev.at || new Date().toISOString(), by: actor, kind: ev.kind, reason: ev.reason || "", note: ev.note || "", fare: numOrNull(ev.fare), ...snapCar(d) };
  if (ev.kind === "cancel_driver" || ev.kind === "return") {
    if (ev.kind === "return" && e.fare) Object.assign(d, { return_fare: (+d.return_fare || 0) + e.fare, return_date: today(), return_driver: d.driver_name, return_from: d.from_place });
    Object.assign(d, { driver_name: "", driver_phone: "", vehicle_no: "", vehicle_ton: null, vehicle_body: "", status: ev.end ? "canceled" : "requested" });
  }
  if (ev.kind === "change") {
    const lab = { run_date: "운행일", time_slot: "시간대", to_place: "하차지" };
    Object.keys(lab).forEach(k => { if (ev[k] && ev[k] !== d[k]) { e.note += ` ${lab[k]} ${d[k] || "-"}→${ev[k]}`; d[k] = ev[k]; } }); e.note = e.note.trim();
  }
  if (ev.kind === "cancel") d.status = "canceled";
  (d.events ||= []).push(e); d.updated_at = e.at; d.updated_by = actor;
}
function trackLocal(prev, d, actor) {
  const evs = (d.events ||= []); const at = new Date().toISOString();
  if (!prev) { evs.push({ at, by: actor, kind: d.origin === "vendor" ? (d.status === "done" ? "done" : "assign") : "request", ...snapCar(d) }); return; }
  if (d.driver_name && (d.driver_name !== prev.driver_name || d.vehicle_no !== prev.vehicle_no))
    evs.push({ at, by: actor, kind: evs.some(e => TROUBLE.includes(e.kind)) || prev.driver_name ? "reassign" : "assign", ...snapCar(d) });
  if (d.status !== prev.status && ["done", "canceled"].includes(d.status)) evs.push({ at, by: actor, kind: d.status === "done" ? "done" : "cancel", ...snapCar(d) });
}
// 카톡방에 보낼 알림 문구(업체 양식)
function kakaoEventText(d, ev) {
  const where = `${d.from_place} ${d.type === "delivery" ? "고객배송" : d.to_place}`;
  if (ev.kind === "cancel_driver") return `${where} ${ev.reason ? ev.reason + "으로 " : ""}취소입니다${ev.end ? "" : " 재배차 하겠습니다"}`;
  if (ev.kind === "return") return `${where} ${ev.reason ? ev.reason + "으로 " : ""}회차 입니다${ev.end ? "" : " 재배차 하겠습니다"}`;
  if (ev.kind === "change") return `${where} ${ev.note || "변경"} 하였습니다`;
  if (ev.kind === "cancel") return `${where} 배차 취소합니다${ev.reason ? " (" + ev.reason + ")" : ""}`;
  return `${where} ${ev.note || ""}`;
}
// '일이 생겼어요' 입력창 — 업체(기사 취소 · 회차 · 변경)와 관리자(+요청 취소)가 같이 씀
function openEventSheet(d, kind, onSave, { admin = false } = {}) {
  const title = { cancel_driver: "기사 취소 · 재배차", return: "회차(상차 못 하고 돌아옴)", change: "변경(하차지 · 일정)", cancel: "요청 취소", note: "메모 남기기" }[kind];
  const el = document.createElement("div"); el.className = "sheet ev-sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", title);
  const reasons = EVENT_REASONS[kind] || (kind === "cancel" ? ["쿠팡 출고 취소", "물량 없음", "일정 변경", "중복 요청", "기타"] : []);
  el.innerHTML = `<header><button class="btn ghost" id="ex" aria-label="닫기">←</button><h3>${esc(title)}</h3></header>
  <div class="body big">
    <div class="req-box">${typeTag(d.type)} <span class="muted">${dLabel(d.run_date)} ${esc(d.time_slot || "")}</span><div class="route">${esc(d.from_place)} → ${esc(d.type === "delivery" ? "고객" : d.to_place)}</div>
      ${d.driver_name ? `<div class="muted">지금 기사: ${esc(d.driver_name)} · ${esc(d.vehicle_no || "")}</div>` : ""}</div>
    ${reasons.length ? `<div><p class="sec-t">사유</p><div class="chips" id="e-reasons">${reasons.map(r => `<button type="button" data-r="${esc(r)}" aria-pressed="false">${esc(r)}</button>`).join("")}</div>
      <div class="field" style="margin-top:8px"><label for="e-reason" class="hidden">사유 직접 입력</label><input id="e-reason" placeholder="직접 입력"></div></div>` : ""}
    ${kind === "return" ? `<div class="field"><label for="e-fare">회차금액 (원, 청구할 때)</label><input id="e-fare" type="number" inputmode="numeric" placeholder="예: 70000"></div>` : ""}
    ${kind === "change" ? `<div class="fields" style="grid-template-columns:1fr 1fr">
      <div class="field"><label for="e-date">운행일</label><input id="e-date" type="date" value="${d.run_date}"></div>
      <div class="field"><label for="e-slot">시간대</label><select id="e-slot"><option value="">그대로</option>${SLOTS.map(s => `<option ${d.time_slot === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      ${d.type !== "delivery" ? `<div class="field" style="grid-column:1 / -1"><label for="e-to">하차지</label><input id="e-to" value="${esc(d.to_place)}"></div>` : ""}</div>` : ""}
    ${kind === "cancel_driver" || kind === "return" ? `<div><p class="sec-t">그다음은?</p><div class="chips" id="e-next"><button type="button" data-n="re" aria-pressed="true">다시 배차할게요(재배차)</button><button type="button" data-n="end" aria-pressed="false">이 요청은 끝(운행 안 함)</button></div></div>` : ""}
    <div class="field"><label for="e-note">메모</label><input id="e-note" placeholder="${kind === "change" ? "익일 오전으로 변경 · 하차지 담당자 변경" : "필요하면 적어 주세요"}"></div>
    <p class="hint">저장하면 이력에 남고, 같은 문구를 카톡방에 바로 보낼 수 있습니다.</p>
  </div>
  <footer><button class="btn" id="ex2">닫기</button><button class="btn primary" id="esave">저장</button></footer>`;
  document.body.appendChild(el);
  const close = () => el.remove(); $("#ex", el).onclick = close; $("#ex2", el).onclick = close;
  $$("#e-reasons button", el).forEach(b => b.onclick = () => { const inp = $("#e-reason", el); inp.value = inp.value === b.dataset.r ? "" : b.dataset.r; $$("#e-reasons button", el).forEach(x => x.setAttribute("aria-pressed", String(x.dataset.r === inp.value))); });
  let end = false; $$("#e-next button", el).forEach(b => b.onclick = () => { end = b.dataset.n === "end"; $$("#e-next button", el).forEach(x => x.setAttribute("aria-pressed", String(x === b))); });
  $("#esave", el).onclick = async () => {
    const g = id => ($("#" + id, el)?.value || "").trim();
    const ev = { kind, reason: g("e-reason"), note: g("e-note"), end };
    if (kind === "return") ev.fare = g("e-fare");
    if (kind === "change") Object.assign(ev, { run_date: g("e-date"), time_slot: g("e-slot"), to_place: g("e-to") });
    if ((kind === "cancel_driver" || kind === "return" || kind === "cancel") && !ev.reason) return toast("사유를 골라 주세요");
    try { await onSave(ev); close(); } catch (e) { toast(e.message); }
  };
}


// =====================================================================
//  관리자: 카톡 · 엑셀 붙여넣기 → 요청 등록 + 업체 배차 글(배차 · 취소 · 회차 · 변경) 반영
// =====================================================================
function importCardHtml() {
  return `<div class="card imp-card"><h2>카톡 · 엑셀 붙여넣기로 한 번에</h2>
    <p class="sub">카톡방 글이나 쿠팡 출고요청서 표를 그대로 복사해 넣으세요. <b>배차 요청</b>(진천센터~이천점 18plt · 출고요청서 줄)과 <b>업체 글</b>(차주정보 · 취소 · 회차 · 변경)을 알아서 나눕니다. 카톡 '대화 내보내기' 파일(.txt)도 열 수 있습니다.</p>
    <div class="field"><label for="imp-text" class="hidden">붙여넣을 내용</label><textarea id="imp-text" rows="6" placeholder="[킹콩 기흥 임희숙님] [오후 1:11] 기흥센터-인천점 3plt&#10;기흥센터-청주점 3plt&#10;&#10;또는 출고요청서 표 · 태성 카톡(경기 용인 -> 충남 아산 / [차주정보] … / 그룹넘버 …)"></textarea></div>
    <div class="row" style="margin-top:8px"><button class="btn primary" id="imp-read" type="button">읽기</button>
      <button class="btn sm" id="imp-guide" type="button">입력 양식 안내</button><a class="btn sm" href="배차요청_양식.xlsx" download>엑셀 양식</a>
      <label class="btn sm" style="display:inline-flex;align-items:center">파일 열기<input type="file" id="imp-file" accept=".txt,.csv,.tsv" hidden></label>
      <label class="row" style="gap:6px;font-size:13px;font-weight:700;color:var(--muted)">날짜 <input type="date" id="imp-day" style="border:1px solid var(--line);border-radius:8px;padding:5px 8px;background:var(--panel)"></label>
      <span class="muted" id="imp-sum"></span></div>
    <div id="imp-out"></div></div>`;
}
function bindImport(v) {
  const ta = $("#imp-text", v), out = $("#imp-out", v), sum = $("#imp-sum", v), dayEl = $("#imp-day", v);
  $("#imp-file", v).onchange = async e => { const f = e.target.files[0]; if (!f) return; ta.value = await f.text(); dayEl.value = ""; read(); };
  $("#imp-read", v).onclick = () => read();
  $("#imp-guide", v).onclick = () => openGuide("admin");
  dayEl.onchange = () => read();
  function read() {
    const text = ta.value; if (!text.trim()) return toast("붙여넣을 내용이 없습니다");
    const places = S.refs.places;
    const sheet = mergeSheetRows(parseSheetRequests(text, places));
    const reqAll = parseKakaoRequests(text, places).filter(r => !sheet.length || true);
    const vAll = parseVendorKakao(text);
    // 대화 내보내기처럼 여러 날이면 하루씩(기본: 가장 최근 날)
    const days = [...new Set([...reqAll.map(r => r.run_date), ...vAll.map(x => x.date)].filter(Boolean))].sort();
    if (!dayEl.value && days.length > 1) dayEl.value = days[days.length - 1];
    const day = dayEl.value;
    const inDay = x => !day || days.length <= 1 || (x.date || x.run_date) === day || !(x.date || x.run_date);
    const tpl = parseTemplateRows(text, places);
    const reqs = [...tpl, ...sheet, ...reqAll.filter(inDay)];
    const vitems = vAll.filter(inDay);
    const rowsOpen = S.rowsAll.filter(d => d.status !== "confirmed");
    reqs.forEach(r => { r._dup = S.rowsAll.find(d => d.status !== "canceled" && ((r.group_no && String(d.group_no || "").split(",").some(g => r.group_no.split(",").includes(g))) ||
      (d.run_date === r.run_date && sameSpot(d.from_place, r.from_place, places) && sameSpot(d.to_place, r.to_place, places)))) || null; });
    const plan = buildPlan(vitems, rowsOpen, places);
    sum.textContent = `요청 ${reqs.length}건 · 업체 글 ${vitems.length}건${days.length > 1 ? ` (${days.length}일 중 ${day ? dLabel(day) : "전체"})` : ""}`;
    const vendorSel = (t, sel) => `<select class="i-vendor"><option value="">미지정</option>${S.refs.vendors.filter(x => x.types.includes(t)).map(x => `<option value="${x.id}" ${x.id === sel ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`;
    const guessVendor = (t, who) => { const w = vendorCanon(who || ""); return (S.refs.vendors.find(x => w && (w.includes(x.name) || x.name.includes(w.slice(0, 2)) || (w.includes("태성") && x.name === "더한물류"))) || S.refs.vendors.find(x => x.types.includes(t)) || {}).id; };
    out.innerHTML = (reqs.length ? `<p class="sec-t" style="margin-top:14px">새 배차 요청 ${reqs.length}건 — 칸을 고쳐도 됩니다</p>
      <div class="tbl-wrap imp" style="max-height:none"><table class="tbl"><thead><tr><th><input type="checkbox" id="imp-all" checked aria-label="모두"></th><th>유형</th><th>운행일</th><th>시간</th><th>상차지</th><th>하차지</th><th>경유</th><th class="r">PLT</th><th>온도</th><th>그룹넘버</th><th>업체</th><th>메모</th></tr></thead><tbody>
      ${reqs.map((r, i) => `<tr data-i="${i}" class="${r._dup ? "dup" : ""}"><td><input type="checkbox" class="i-ck" ${r._dup ? "" : "checked"} aria-label="등록"></td>
        <td><select class="i-type">${Object.entries(TYPES).filter(([k]) => k !== "delivery").map(([k, x]) => `<option value="${k}" ${r.type === k ? "selected" : ""}>${x.short}</option>`).join("")}</select></td>
        <td><input type="date" class="i-date" value="${r.run_date}"></td><td><select class="i-slot"><option value="">-</option>${SLOTS.map(s => `<option ${r.time_slot === s ? "selected" : ""}>${s}</option>`).join("")}</select></td>
        <td><input class="i-from" value="${esc(r.from_place)}" list="dl-all"></td><td><input class="i-to" value="${esc(r.to_place)}" list="dl-all"></td><td><input class="i-via" value="${esc(r.via_place || "")}" style="width:90px"></td>
        <td><input class="i-plt" type="number" step="0.5" value="${r.plt_qty ?? ""}" style="width:64px"></td>
        <td><select class="i-temp">${["상온", "냉장", "냉동"].map(x => `<option ${r.temp === x ? "selected" : ""}>${x}</option>`).join("")}</select></td>
        <td><input class="i-grp" value="${esc(r.group_no || "")}" style="width:120px"></td><td>${vendorSel(r.type, guessVendor(r.type, r.vendorName || ""))}</td>
        <td><input class="i-note" value="${esc([r.category, r.cargo_note].filter(Boolean).join(" · "))}">${r._dup ? `<div class="hint warn">이미 있는 요청(#${r._dup.id}) — 체크하면 또 등록</div>` : ""}</td></tr>`).join("")}</tbody></table></div>` : "")
      + (plan.length ? `<p class="sec-t" style="margin-top:14px">업체 글 ${plan.length}건 — 맞는 요청에 붙입니다(그룹넘버 · 상하차지 · 날짜로 자동 선택)</p>${planHtml(plan)}` : "")
      + (reqs.length || plan.length ? `<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" id="imp-go" type="button">선택한 내용 반영</button></div>` : `<div class="empty">읽을 수 있는 요청 · 배차 글이 없습니다. 예) 진천센터~이천점 18plt</div>`);
    const all = $("#imp-all", out); if (all) all.onchange = () => $$(".i-ck", out).forEach(c => c.checked = all.checked);
    const go = $("#imp-go", out); if (!go) return;
    go.onclick = async () => {
      go.disabled = true; let nReq = 0, nV = 0;
      try {
        for (const tr of $$("tbody tr[data-i]", out)) {
          if (!$(".i-ck", tr).checked) continue; const r = reqs[+tr.dataset.i]; const g = c => $(c, tr).value.trim();
          const row = { type: g(".i-type"), status: "requested", origin: "kingkong", run_date: g(".i-date"), time_slot: g(".i-slot"), from_place: resolvePlace(g(".i-from"), places), to_place: resolvePlace(g(".i-to"), places),
            via_place: g(".i-via"), plt_qty: numOrNull(g(".i-plt")), temp: g(".i-temp"), group_no: g(".i-grp"), vendor_id: g(".i-vendor") || null, cargo_note: g(".i-note"), extra_fare: 0,
            ref_code: r.ref_code || "", bid_no: r.bid_no || "", category: r.category || "", pickup_addr: r.pickup_addr || "", pickup_contact: r.pickup_contact || "", requested_by: r.requested_by || S.user.name || S.user.email };
          if (!row.from_place || !row.to_place || !row.run_date) continue;
          await Admin.save(row, S.user.email); nReq++;
        }
        nV = await applyPlan(plan, out, {
          assign: (row, car) => Admin.save({ ...row, ...car, vendor_id: row.vendor_id || guessVendor(row.type, ""), status: row.status === "done" ? "done" : "assigned" }, S.user.email),
          create: it => Admin.save({ type: it.groups.length ? "coupang" : "center", status: "assigned", origin: "vendor", run_date: it.date || today(), from_place: resolvePlace(it.from || it.region.split(/->|→/)[0] || "?", places),
            to_place: resolvePlace(it.to || (it.region.split(/->|→/)[1] || "?"), places), temp: it.temp || "상온", group_no: it.groups.join(","), extra_fare: 0, vendor_id: guessVendor("coupang", it.who), ...carOf(it) }, S.user.email),
          event: (id, ev) => Admin.event(id, ev, S.user.email),
        }, places);
        toast(`요청 ${nReq}건 등록 · 업체 글 ${nV}건 반영 — 업체 · 매장 화면에 바로 보입니다`);
        S.tab = "ledger"; S.filter = { type: "", status: "", vendor: "", q: "", flag: "" }; await reload();
      } catch (e) { toast("반영 실패: " + e.message); go.disabled = false; }
    };
  }
}

// =====================================================================
//  업체(모바일): 카톡에 보낸 글을 그대로 붙여넣기 → 배차 · 취소 · 회차가 한 번에 입력
// =====================================================================
function openVendorPaste() {
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "카톡 글 붙여넣기");
  el.innerHTML = `<header><button class="btn ghost" id="px" aria-label="닫기">←</button><h3>카톡 글 붙여넣기</h3></header>
  <div class="body big">
    <p class="hint" style="font-size:14px">단톡방에 보낸 글(차주정보 · 차량정보 · 그룹넘버 · 취소 · 회차)을 길게 눌러 복사한 뒤 붙여넣으세요. 여러 건을 한꺼번에 넣어도 됩니다.</p>
    <div class="field"><label for="p-text" class="hidden">카톡 글</label><textarea id="p-text" rows="8" placeholder="경북 경산 -> 충북 진천&#10;[차주정보] 김홍길 / 01035488111&#10;[차량정보] 플축윙 / 15톤 / 경북86아7358&#10;경산2 진천센터 입니다&#10;그룹넘버 101903,101938"></textarea></div>
    <button class="btn" id="p-read" type="button" style="min-height:48px">읽기</button>
    <div id="p-out"></div>
  </div>
  <footer><button class="btn" id="px2">닫기</button><button class="btn primary" id="p-go" disabled>저장</button></footer>`;
  document.body.appendChild(el);
  const close = () => el.remove(); $("#px", el).onclick = close; $("#px2", el).onclick = close;
  const places = V.refs.place_list || (V.refs.places || []).map(n => ({ name: n, aliases: [] }));
  let plan = [];
  const read = () => {
    const items = parseVendorKakao($("#p-text", el).value);
    plan = buildPlan(items, V.rows.filter(d => d.status !== "confirmed"), places);
    $("#p-out", el).innerHTML = plan.length ? planHtml(plan) : `<div class="empty">차주정보 · 취소 · 회차 글을 찾지 못했습니다</div>`;
    $("#p-go", el).disabled = !plan.length; $("#p-go", el).textContent = plan.length ? `${plan.length}건 저장` : "저장";
  };
  $("#p-read", el).onclick = read;
  $("#p-text", el).addEventListener("paste", () => setTimeout(read, 50));
  $("#p-go", el).onclick = async () => {
    $("#p-go", el).disabled = true;
    try {
      const n = await applyPlan(plan, el, {
        assign: (row, car) => Vendor.save(row.id, { ...car, base_fare: row.base_fare, extra_fare: row.extra_fare || 0, extra_reason: row.extra_reason || "", status: row.status === "done" ? "done" : "assigned" }),
        create: async it => { await Vendor.add({ type: it.groups.length ? "coupang" : "center", run_date: it.date || today(), from_place: resolvePlace(it.from || it.region.split(/->|→/)[0], places), to_place: resolvePlace(it.to || it.region.split(/->|→/)[1] || "?", places),
          plt_qty: null, temp: it.temp || "상온", cargo_note: "", group_no: it.groups.join(","), ...carOf(it), extra_fare: 0, status: "assigned" });
          const L = await Vendor.list(); return (L.find(d => d.driver_name === it.driver_name && d.origin === "vendor") || {}).id; },
        event: (id, ev) => Vendor.event(id, ev),
      }, places);
      toast(`${n}건 저장했습니다 — 킹콩 화면에 바로 보입니다`); close(); vendorLoad();
    } catch (e) { toast(e.message); $("#p-go", el).disabled = false; }
  };
}

// =====================================================================
//  매장(모바일) 화면 — 링크 ?s=매장이름 + 매장 PIN
//  종이 배송요청서 · 확인서는 매장에 보관하고, 앱에는 내용 입력 + 영수증 사진만
// =====================================================================
const ST = { tab: "open", rows: [] };
const STORE_STATUS = { requested: "접수 · 배차 대기", assigned: "배차 완료", done: "배송 완료", confirmed: "배송 완료", canceled: "취소" };
async function storeBoot(name) {
  let saved = null; try { saved = sessionStorage.getItem("kk_spin_" + name); } catch (_) {}
  if (saved) { try { await Store.login(name, saved); return storeLoad(); } catch (_) {} }
  app.innerHTML = `<div class="pin"><div class="card"><div class="brand" style="justify-content:center;margin-bottom:6px"><span class="logo" aria-hidden="true">K</span></div>
    <h2>${esc(name)}</h2><p class="sub">고객 배송 요청 · 매장 PIN을 넣어 주세요${LIVE ? "" : "<br><span class='muted'>(데모: 이천점 1111 · 시그니처인천점 2222 · 원주점 3333)</span>"}</p>
    <form id="pf"><div class="field"><input id="pin" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus aria-label="PIN"></div>
    <button class="btn primary" style="width:100%;margin-top:12px;min-height:52px;font-size:17px" type="submit">들어가기</button></form><p class="hint" id="err" role="alert"></p></div></div>`;
  $("#pf").onsubmit = async e => { e.preventDefault(); try { await Store.login(name, $("#pin").value.trim()); storeLoad(); } catch (err) { $("#err").textContent = err.message; } };
}
async function storeLoad(quiet) {
  try { ST.rows = await Store.list(); } catch (e) { if (!quiet) app.innerHTML = `<div class="empty">불러오기 실패: ${esc(e.message)}</div>`; return; }
  storeRender();
}
function storeRender() {
  const open = ST.rows.filter(d => ["requested", "assigned"].includes(d.status)), fin = ST.rows.filter(d => !["requested", "assigned"].includes(d.status));
  const L = ST.tab === "open" ? open : ST.tab === "done" ? fin : ST.rows;
  app.innerHTML = `<div class="m">
    <div class="m-head store"><div class="who">킹콩백화점 · ${esc(Store.name)}${LIVE ? "" : " · 데모"}</div>
      <div class="ttl">고객 배송 요청</div>
      <div class="who">배차 대기 ${open.filter(d => d.status === "requested").length}건 · 배차 완료 ${open.filter(d => d.status === "assigned").length}건${!LIVE && location.hash.includes("s=") ? ` · <a href="#" id="to-admin" style="color:inherit">관리자 화면으로</a>` : ""}</div>
      <div class="m-tabs" role="group" aria-label="보기">${[["open", `진행 중 ${open.length}`], ["done", `끝난 요청 ${fin.length}`], ["all", "전체"]].map(([k, l]) => `<button data-st="${k}" aria-pressed="${ST.tab === k}">${l}</button>`).join("")}</div></div>
    <div class="m-list">${L.length ? L.map(d => { const x = d.delivery || {}; const last = (d.events || []).filter(e => TROUBLE.includes(e.kind) || e.kind === "change").slice(-1)[0];
      return `<button class="m-card t-delivery" data-id="${d.id}">
        <div class="row" style="justify-content:space-between"><b>${esc(x.customer_name || "")}</b>${stTag(d.status).replace(esc(STATUS[d.status] || ""), esc(STORE_STATUS[d.status] || ""))}</div>
        <div class="route" style="font-size:16px">${esc(x.product || "")} ${esc(x.qty || "")}</div>
        <div class="meta"><span>${esc((x.address || "").slice(0, 28))}</span></div>
        <div class="meta">${d.status === "requested" ? `<span>희망 ${x.asap ? "최대한 빨리" : dLabel(d.run_date)}</span>` : `<span><b>배송일 ${dLabel(d.run_date)}</b></span>`}${d.driver_name ? `<span>기사 ${esc(d.driver_name)}</span>` : ""}<span>영수증 ${d.receipts || 0}장</span></div>
        ${last ? `<div class="meta"><span class="evb ${last.kind === "return" ? "ev-r" : last.kind === "change" ? "ev-ch" : "ev-c"}">${esc(EVENT_KINDS[last.kind])}</span><span>${esc(last.reason || last.note || "")}</span></div>` : ""}
      </button>`; }).join("") : `<div class="empty">요청이 없습니다</div>`}</div>
    <p class="build">build ${BUILD}</p><button class="fab" id="fab">+ 배송 요청</button></div>`;
  $$("[data-st]").forEach(b => b.onclick = () => { ST.tab = b.dataset.st; storeRender(); });
  $$(".m-card").forEach(b => b.onclick = () => storeDetail(ST.rows.find(d => d.id === +b.dataset.id)));
  $("#fab").onclick = () => storeForm();
  const ta = $("#to-admin"); if (ta) ta.onclick = e => { e.preventDefault(); location.hash = ""; location.reload(); };
}
function storeDetail(d) {
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "배송 요청 보기");
  el.innerHTML = `<header><button class="btn ghost" id="dx" aria-label="닫기">←</button><h3>배송 요청 #${d.id}</h3>${stTag(d.status).replace(esc(STATUS[d.status] || ""), esc(STORE_STATUS[d.status] || ""))}</header>
  <div class="body">
    ${d.status !== "requested" && d.driver_name ? `<div class="req-box"><b>배송일 ${dLabel(d.run_date)}</b> · ${esc(d.vendor || "")}<br>기사 ${esc(d.driver_name)} ${d.driver_phone ? `<a href="tel:${esc(phoneDigits(d.driver_phone))}">${esc(d.driver_phone)}</a>` : ""} · ${esc(d.vehicle_no || "")}</div>` : ""}
    <div class="card" style="padding:14px">${deliveryDetailHtml(d.delivery, { phoneLink: true })}</div>
    <div><p class="sec-t">진행 기록</p>${timelineHtml(d.events, { compact: true })}</div>
  </div>
  <footer><button class="btn" id="dx2">닫기</button>${d.status === "requested" ? `<button class="btn danger" id="dcancel">요청 취소</button>` : ""}</footer>`;
  document.body.appendChild(el);
  const close = () => el.remove(); $("#dx", el).onclick = close; $("#dx2", el).onclick = close;
  const c = $("#dcancel", el); if (c) c.onclick = async () => { if (!confirm("이 배송 요청을 취소할까요?")) return; try { await Store.cancel(d.id); toast("취소했습니다"); close(); storeLoad(); } catch (e) { toast(e.message); } };
}
// 배송요청서(종이)와 같은 순서 · 같은 칸
function storeForm() {
  let staff = ""; try { staff = localStorage.getItem("kk_store_staff") || ""; } catch (_) {}
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "배송 요청");
  const seg = (id, opts, cur) => `<div class="chips seg" id="${id}">${opts.map(o => `<button type="button" data-v="${esc(o)}" aria-pressed="${o === cur}">${esc(o)}</button>`).join("")}</div>`;
  el.innerHTML = `<header><button class="btn ghost" id="fx" aria-label="닫기">←</button><h3>고객 배송 요청</h3></header>
  <div class="body big">
    <section><p class="sec-t">1. 영수증 사진 (필수)</p>
      <div class="thumbs" id="q-thumbs"></div>
      <label class="btn" style="display:flex;justify-content:center;align-items:center;min-height:52px">사진 찍기 · 고르기<input type="file" id="q-photo" accept="image/*" capture="environment" multiple hidden></label>
      <p class="hint">제품 영수증 · 배송비 영수증 모두 찍어 주세요. 사진은 자동으로 줄여서 올립니다.</p></section>
    <section><p class="sec-t">2. 고객</p>
      <div class="fields" style="grid-template-columns:1fr 1fr">
        <div class="field"><label for="q-name">성함</label><input id="q-name" autocomplete="off"></div>
        <div class="field"><label for="q-tel">연락처</label><input id="q-tel" type="tel" inputmode="tel" placeholder="010-"></div></div>
      <div style="margin-top:10px"><p class="sec-t">구매인 · 수화인</p>${seg("q-same", ["일치", "불일치"], "일치")}</div>
      <div class="fields hidden" id="q-diff" style="grid-template-columns:1fr 1fr;margin-top:8px">
        <div class="field"><label for="q-buyer">구매인 성명</label><input id="q-buyer"></div><div class="field"><label for="q-recv">수화인 성명</label><input id="q-recv"></div></div>
      <div class="field" style="margin-top:10px"><label for="q-addr">배송지 상세주소 (동 · 호수 · <b>층수 꼭</b>)</label><textarea id="q-addr" rows="2" style="min-height:70px"></textarea></div></section>
    <section><p class="sec-t">3. 제품</p><div id="q-items"></div>
      <button class="btn sm" id="q-add" type="button">+ 제품 추가</button>
      <div class="field" style="margin-top:10px;max-width:220px"><label for="q-tt">T/T 파레트 수량</label><input id="q-tt" type="number" inputmode="decimal" step="0.5"></div></section>
    <section><p class="sec-t">4. 현장</p>
      <div class="ff"><span>엘리베이터</span>${seg("q-elev", ["있음", "없음"], "있음")}<input id="q-floor" class="hidden" type="number" inputmode="numeric" placeholder="몇 층" aria-label="층수"></div>
      <div class="ff"><span>폐가구 · 가전 이동</span>${seg("q-disp", ["없음", "있음"], "없음")}<span id="q-dispn" class="hidden row" style="gap:6px"><input id="q-db" type="number" inputmode="numeric" placeholder="기본 개" aria-label="기본 개수"><input id="q-dl" type="number" inputmode="numeric" placeholder="대형 개" aria-label="대형 개수"></span></div>
      <div class="ff"><span>거리</span>${seg("q-dist", ["20km 미만", "20km 초과"], "20km 미만")}<input id="q-km" class="hidden" type="number" inputmode="numeric" placeholder="몇 km" aria-label="거리 km"></div>
      <div class="ff"><span>2곳 이상 배송</span>${seg("q-multi", ["없음", "있음"], "없음")}</div></section>
    <section><p class="sec-t">5. 배송 조건</p>
      <div class="ff"><span>배송비</span>${seg("q-terms", ["무료 배송", "유료 배송"], "")}</div>
      <div class="field" style="max-width:260px"><label for="q-paid">추가 결제 금액 (원)</label><input id="q-paid" type="number" inputmode="numeric" placeholder="예: 33000"></div></section>
    <section><p class="sec-t">6. 희망 배송일 · 요청사항</p>
      <div class="ff"><input id="q-date" type="date" value="${addDays(today(), 1)}" aria-label="희망 배송일">${seg("q-asap", ["최대한 빠른 날짜"], "")}</div>
      <div class="field" style="margin-top:8px"><label for="q-note">기타 내용 · 고객 요청사항</label><textarea id="q-note" rows="2" style="min-height:70px" placeholder="오전 배송 원함 · 중문 탈거 필요 · 주차 어려움"></textarea></div></section>
    <section><p class="sec-t">7. 확인</p>
      <label class="check"><input type="checkbox" id="q-paper"> 종이 배송요청서 원본을 매장에 보관했습니다</label>
      <label class="check"><input type="checkbox" id="q-consent"> 고객에게 '배송 확인서' 동의 · 서명을 받았습니다</label>
      <div class="field" style="margin-top:8px;max-width:260px"><label for="q-staff">요청한 직원</label><input id="q-staff" value="${esc(staff)}"></div></section>
  </div>
  <footer><button class="btn" id="fx2">닫기</button><button class="btn primary" id="q-send">요청 보내기</button></footer>`;
  document.body.appendChild(el);
  const close = () => el.remove(); $("#fx", el).onclick = close; $("#fx2", el).onclick = close;
  const segVal = id => $(`#${id} [aria-pressed="true"]`, el)?.dataset.v || "";
  const show = (id, on) => $("#" + id, el).classList.toggle("hidden", !on);
  $$(".seg", el).forEach(g => $$("button", g).forEach(b => b.onclick = () => {
    const single = $$("button", g).length === 1; const on = b.getAttribute("aria-pressed") !== "true";
    $$("button", g).forEach(x => x.setAttribute("aria-pressed", String(single ? on : x === b)));
    show("q-diff", segVal("q-same") === "불일치"); show("q-floor", segVal("q-elev") === "없음"); show("q-dispn", segVal("q-disp") === "있음"); show("q-km", segVal("q-dist") === "20km 초과");
    $("#q-date", el).disabled = segVal("q-asap") !== "";
  }));
  // 제품 줄
  const addItem = () => { const r = document.createElement("div"); r.className = "item-row";
    r.innerHTML = `<input class="it-name" placeholder="제품명 (안마의자)" aria-label="제품명"><input class="it-qty" type="number" inputmode="numeric" value="1" aria-label="수량"><div class="chips seg it-size"><button type="button" data-v="기본" aria-pressed="true">기본</button><button type="button" data-v="대형" aria-pressed="false">대형</button></div><button type="button" class="btn ghost sm" aria-label="이 제품 지우기">✕</button>`;
    $$(".it-size button", r).forEach(b => b.onclick = () => $$(".it-size button", r).forEach(x => x.setAttribute("aria-pressed", String(x === b))));
    r.querySelector(".btn.ghost").onclick = () => { if ($$(".item-row", el).length > 1) r.remove(); };
    $("#q-items", el).appendChild(r); };
  addItem(); $("#q-add", el).onclick = addItem;
  // 영수증 사진
  const photos = [];
  const drawThumbs = () => { $("#q-thumbs", el).innerHTML = photos.map((p, i) => `<div class="thumb"><img src="${p}" alt="영수증 ${i + 1}"><button type="button" data-del="${i}" aria-label="사진 지우기">✕</button></div>`).join("");
    $$("[data-del]", el).forEach(b => b.onclick = () => { photos.splice(+b.dataset.del, 1); drawThumbs(); }); };
  $("#q-photo", el).onchange = async e => { for (const f of e.target.files) { try { photos.push(await shrinkImage(f)); } catch (err) { toast(err.message); } } e.target.value = ""; drawThumbs(); };
  $("#q-send", el).onclick = async () => {
    const g = id => ($("#" + id, el)?.value || "").trim();
    const items = $$(".item-row", el).map(r => ({ name: $(".it-name", r).value.trim(), qty: +$(".it-qty", r).value || 1, size: $(".it-size [aria-pressed='true']", r)?.dataset.v || "기본" })).filter(i => i.name);
    const miss = [!photos.length && "영수증 사진", !g("q-name") && "고객 성함", !g("q-tel") && "연락처", !g("q-addr") && "주소", !items.length && "제품", !segVal("q-terms") && "배송비(무료/유료)",
      !$("#q-paper", el).checked && "요청서 원본 보관 확인", !$("#q-consent", el).checked && "확인서 서명 확인"].filter(Boolean);
    if (miss.length) return toast("빠진 칸: " + miss.join(", "));
    const elev = segVal("q-elev") === "없음" ? `없음${g("q-floor") ? " · " + g("q-floor") + "층(계단)" : ""}` : "있음";
    const disp = segVal("q-disp") === "있음" ? `기본 ${g("q-db") || 0}개 · 대형 ${g("q-dl") || 0}개` : "없음";
    const dist = segVal("q-dist") === "20km 초과" ? `20km 초과${g("q-km") ? " · " + g("q-km") + "km" : ""}` : "20km 미만";
    const asap = segVal("q-asap") !== "";
    const delivery = { order_date: today(), customer_name: g("q-name"), customer_phone: g("q-tel"), address: g("q-addr"), product: items.map(i => i.name).join(", "), qty: String(items.reduce((a, i) => a + i.qty, 0)),
      terms: segVal("q-terms").replace(" 배송", ""), items, tt_plt: numOrNull(g("q-tt")), elevator: elev, disposal: disp, distance: dist, multi_stop: segVal("q-multi") === "있음", extra_paid: numOrNull(g("q-paid")),
      buyer_same: segVal("q-same") !== "불일치", buyer_name: g("q-buyer"), receiver_name: g("q-recv"), asap, request_note: g("q-note"), paper_kept: true, consent_signed: true, requested_by: g("q-staff") };
    try { localStorage.setItem("kk_store_staff", g("q-staff")); } catch (_) {}
    $("#q-send", el).disabled = true;
    try { await Store.add({ run_date: asap ? addDays(today(), 1) : g("q-date"), cargo_note: delivery.product, delivery }, photos); toast("배송 요청을 보냈습니다 — 배차되면 여기서 바로 보입니다"); close(); storeLoad(); }
    catch (e) { toast(e.message); $("#q-send", el).disabled = false; }
  };
}


// =====================================================================
//  비고(질문 ↔ 답변) · 수정 기록 · 입력 양식 안내
// =====================================================================
// 답변 대기 = 킹콩 질문 뒤에 더한물류 답이 아직 없고, '해결'로 닫지도 않은 것
function qState(d) {
  const L = d.comments || []; if (!L.length) return null;
  const lastQ = [...L].reverse().find(c => c.kind === "question" && !c.closed_at);
  if (!lastQ) return "done";
  const ans = L.some(c => c.kind === "answer" && tms(c.at) > tms(lastQ.at));
  return ans ? "answered" : "waiting";
}
function qBadge(d) {
  const st = qState(d); if (!st) return "";
  return st === "waiting" ? `<span class="evb ev-q">답변 대기</span>` : st === "answered" ? `<span class="evb ev-a">답변 옴</span>` : `<span class="evb">해결</span>`;
}
const fmtSec = at => { const d = new Date(at); if (isNaN(d)) return ""; const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
function threadHtml(d, { admin = false } = {}) {
  const L = d.comments || [];
  return `<div class="thread">${L.length ? L.map(c => `<div class="msg ${c.kind === "answer" ? "a" : "q"}${c.closed_at ? " closed" : ""}">
      <div class="mh"><b>${c.kind === "answer" ? "더한물류" : esc(whoLabel(c.author)) + (c.kind === "question" ? " · 질문" : "")}</b><span class="muted num">${fmtSec(c.at)}</span></div>
      <div>${esc(c.body)}</div>
      ${c.closed_at ? `<div class="muted">해결 ${fmtSec(c.closed_at)} · ${esc(whoLabel(c.closed_by))}</div>` : admin && c.kind === "question" ? `<button class="btn sm ghost" data-close="${c.id}">해결로 닫기</button>` : ""}</div>`).join("") : `<div class="muted">질문 · 답변이 없습니다</div>`}</div>`;
}
// 칸 이름(수정 기록 표시용)
const COL_KO = { status: "상태", run_date: "운행일", time_slot: "시간대", from_place: "상차지", to_place: "하차지", via_place: "경유", plt_qty: "PLT", temp: "온도", cargo_note: "메모", ref_code: "입차CODE", group_no: "그룹넘버",
  category: "카테고리", vendor_id: "업체", driver_name: "기사", driver_phone: "기사 연락처", vehicle_no: "차량번호", vehicle_ton: "톤수", vehicle_body: "차종", base_fare: "기본운임", extra_fare: "추가운임", extra_reason: "추가운임 사유",
  return_fare: "회차금액", return_date: "회차일", return_driver: "회차 기사", return_from: "회차 상차지", origin: "요청처", type: "유형", requested_by: "요청자", customer_name: "고객", customer_phone: "고객 연락처", address: "주소",
  product: "제품", qty: "수량", terms: "배송조건", done_note: "완료 메모", body: "내용", kind: "구분", closed_at: "해결", base: "기본", name: "이름", aliases: "별칭", pickup_addr: "상차지 주소", pickup_contact: "상차지 담당" };
const TABLE_KO = { dispatches: "배차", dispatch_delivery: "고객배송", dispatch_comments: "비고(질문·답변)", attachments: "영수증", rate_cards: "운임표", places: "지점", vendors: "업체", stores: "매장", settlements: "정산", staff: "관리자" };
const VAL_KO = { coupang: "쿠팡", center: "센터/본사", delivery: "고객배송", requested: "배차 요청", assigned: "배차 완료", done: "운행 완료", confirmed: "정산 확정", canceled: "취소", kingkong: "킹콩", vendor: "업체", store: "매장", question: "질문", answer: "답변", note: "메모" };
const shortVal = v => { if (v == null || v === "") return "(빈칸)"; if (typeof v === "string" && VAL_KO[v]) return VAL_KO[v]; if (typeof v === "object") v = JSON.stringify(v); v = String(v); if (FARE_KEYS.includes(v)) return v; return v.length > 40 ? v.slice(0, 40) + "…" : v; };
function auditRowsHtml(L, { showId = false } = {}) {
  if (!L.length) return `<div class="muted">기록 없음</div>`;
  return `<div class="tbl-wrap" style="max-height:${showId ? "calc(100vh - 300px)" : "340px"}"><table class="tbl audit"><thead><tr><th>일시(초)</th><th>누가</th>${showId ? "<th>건</th>" : ""}<th>무엇</th><th>바뀐 내용</th></tr></thead><tbody>${L.map(a => {
    const diff = a.diff || {};
    const body = a.action === "update" ? Object.entries(diff).map(([k, v]) => `<div><b>${esc(COL_KO[k] || k)}</b> ${esc(shortVal(Array.isArray(v) ? v[0] : ""))} → <b class="new">${esc(shortVal(Array.isArray(v) ? v[1] : v))}</b></div>`).join("")
      : `<div class="muted">${a.action === "insert" ? "새로 만듦" : "지움"}${Object.keys(diff).length ? ": " + esc(Object.entries(diff).filter(([k, v]) => v != null && v !== "" && !["id", "dispatch_id", "vendor_id"].includes(k)).slice(0, 6).map(([k, v]) => `${COL_KO[k] || k} ${shortVal(v)}`).join(" · ")) : ""}</div>`;
    return `<tr${showId && a.dispatch_id ? ` data-id="${a.dispatch_id}"` : ""}><td class="num">${fmtSec(a.at)}</td><td>${esc(whoLabel(a.actor) || a.actor)}</td>${showId ? `<td class="num">${a.dispatch_id ? "#" + a.dispatch_id : esc(a.row_id || "")}</td>` : ""}<td>${esc(TABLE_KO[a.table_name] || a.table_name || "배차")} ${a.action === "insert" ? "추가" : a.action === "delete" ? "삭제" : "수정"}</td><td class="wrap">${body}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}
function auditCsv(L, name) {
  const q = v => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const rows = L.flatMap(a => a.action === "update" ? Object.entries(a.diff || {}).map(([k, v]) => [fmtSec(a.at), a.actor, a.dispatch_id || a.row_id, TABLE_KO[a.table_name] || a.table_name, "수정", COL_KO[k] || k, shortVal(v[0]), shortVal(v[1])])
    : [[fmtSec(a.at), a.actor, a.dispatch_id || a.row_id, TABLE_KO[a.table_name] || a.table_name, a.action === "insert" ? "추가" : "삭제", "", "", JSON.stringify(a.diff || {})]]);
  const csv = "﻿" + [["일시", "누가", "건", "표", "작업", "칸", "이전", "이후"], ...rows].map(r => r.map(q).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// ---------------- 수정 기록 화면(관리자) ----------------
async function viewAudit(v) {
  const [y, m] = S.month.split("-").map(Number); const from = `${S.month}-01`, to = ymd(new Date(y, m, 0));
  v.innerHTML = `<div class="grid"><div class="card"><h2>수정 기록</h2><p class="sub">${+S.month.slice(5)}월에 누가 · 언제(초까지) · 무엇을 · 어떻게 바꿨는지 전부입니다. 기록은 고치거나 지울 수 없습니다(DB가 막음).</p>
    <div class="row"><div class="field" style="min-width:160px"><label for="a-who">누가</label><select id="a-who"><option value="">전체</option></select></div>
      <div class="field" style="min-width:160px"><label for="a-tb">무엇</label><select id="a-tb"><option value="">전체</option>${Object.entries(TABLE_KO).map(([k, x]) => `<option value="${k}">${x}</option>`).join("")}</select></div>
      <div class="field" style="flex:1;min-width:180px"><label for="a-q">검색 (건 번호 · 칸 · 값)</label><input id="a-q" type="search" placeholder="#358 · 기본운임 · 김홍길"></div>
      <button class="btn sm" id="a-csv" style="align-self:end">CSV 내려받기</button></div></div><div id="a-list" class="card" style="padding:12px">불러오는 중…</div></div>`;
  let L = []; try { L = await Admin.auditRange(from, to); } catch (e) { $("#a-list").textContent = "불러오기 실패: " + e.message; return; }
  const whos = [...new Set(L.map(a => a.actor))].sort(); $("#a-who").innerHTML += whos.map(w => `<option value="${esc(w)}">${esc(whoLabel(w) || w)}</option>`).join("");
  const draw = () => {
    const who = $("#a-who").value, tb = $("#a-tb").value, q = $("#a-q").value.trim().replace(/^#/, "");
    const X = L.filter(a => (!who || a.actor === who) && (!tb || a.table_name === tb) && (!q || String(a.dispatch_id) === q || JSON.stringify(a.diff || {}).includes(q) || Object.keys(a.diff || {}).some(k => (COL_KO[k] || "").includes(q))));
    $("#a-list").innerHTML = `<p class="muted" style="margin:0 0 8px">${X.length.toLocaleString()}건</p>` + auditRowsHtml(X.slice(0, 1500), { showId: true });
    $$("#a-list tr[data-id]").forEach(tr => tr.onclick = () => { const d = S.rowsAll.find(x => x.id === +tr.dataset.id); if (d) openEdit(d); else toast("이 달 범위 밖의 건입니다"); });
    $("#a-csv").onclick = () => auditCsv(X, `수정기록_${S.month}.csv`);
  };
  ["a-who", "a-tb"].forEach(id => $("#" + id).onchange = draw); $("#a-q").oninput = draw; draw();
}

// ---------------- 입력 양식 안내(카톡 공지 · 엑셀) ----------------
const GUIDE = {
  req: `[배차요청] 11/4(화) 오전
진천센터 → 이천점 18plt
기흥센터 → 인천점 3plt 냉장
기흥센터 → 이천점 2plt 경유 원주점 2plt`,
  done: `경북 경산 -> 충북 진천
[차주정보] 김홍길 / 01035488111
[차량정보] 플축윙 / 15톤 / 경북86아7358
경산2 진천센터 입니다
그룹넘버 101903,101938`,
  trouble: `경산2 진천센터 취소입니다 (차량고장) 재배차 하겠습니다
경산2 진천센터 상차지연으로 회차 입니다 재배차 하겠습니다
고양3 인천점 하차지 이천센터로 변경 하였습니다`,
};
function openGuide(who = "admin") {
  const el = document.createElement("div"); el.className = "sheet guide"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "입력 양식 안내");
  const block = (k, title, desc) => `<section><div class="row" style="justify-content:space-between"><p class="sec-t" style="margin:0">${title}</p><button class="btn sm" data-copy="${k}">복사</button></div><p class="hint">${desc}</p><pre>${esc(GUIDE[k])}</pre></section>`;
  el.innerHTML = `<header><button class="btn ghost" id="gx" aria-label="닫기">←</button><h3>입력 양식 안내</h3><button class="btn sm" id="g-all">카톡 공지용 전체 복사</button></header>
  <div class="body">
    <p class="hint" style="font-size:14px">이 양식대로 쓰면 카톡에 보낸 글을 그대로 붙여넣어도 앱이 정확히 알아듣습니다. <b>한 줄에 한 대</b>, <b>상차지 → 하차지 수량</b> 순서만 지키면 됩니다.</p>
    ${block("req", "① 배차 요청 (킹콩 → 더한물류)", "첫 줄에 날짜 · 시간대(오전/오후/야간), 다음 줄부터 한 줄에 한 대. 화살표는 → · -> · ~ · - 모두 됩니다. 냉장/냉동은 줄 끝에. 경유는 '하차지1 수량 경유 하차지2 수량'.")}
    ${block("done", "② 배차 완료 (더한물류 → 킹콩)", "지금 쓰는 양식 그대로. 마지막 '상차지 하차지 입니다' 줄과 쿠팡 건의 그룹넘버가 있어야 자동으로 정확히 연결됩니다.")}
    ${block("trouble", "③ 취소 · 회차 · 변경 (더한물류)", "앞에 '상차지 하차지'를 붙여 주세요. 사유는 '…으로 회차', '(차량고장)'처럼. 회차금액은 앱에서 더한물류가 입력합니다.")}
    <section><p class="sec-t" style="margin:0">④ 엑셀로 한 번에 (킹콩)</p>
      <p class="hint">'배차요청 양식' 엑셀을 내려받아 줄을 채운 뒤, 표를 통째로 복사(제목 줄 포함)해서 '배차 요청' 탭에 붙여넣으세요. 쿠팡 출고요청서도 그대로 됩니다.</p>
      <table class="tbl" style="font-size:12.5px"><thead><tr>${TEMPLATE_COLS.map(c => `<th>${c[0]}</th>`).join("")}</tr></thead><tbody><tr>${TEMPLATE_COLS.map(c => `<td>${esc(c[1])}</td>`).join("")}</tr></tbody></table>
      <div class="row" style="margin-top:8px"><a class="btn sm primary" href="배차요청_양식.xlsx" download>배차요청 양식.xlsx 내려받기</a><button class="btn sm" id="g-csv">CSV 양식</button></div></section>
    ${who === "vendor" ? "" : `<section><p class="sec-t" style="margin:0">⑤ 휴대폰으로 바로</p><p class="hint">'배차 요청' 탭의 붙여넣기 칸에 ①양식대로 직접 쓰고 '읽기' → '반영'. 카톡에 보낼 문구는 통합 대장에서 줄을 고른 뒤 '카톡 요청 문구'.</p></section>`}
  </div>`;
  document.body.appendChild(el);
  $("#gx", el).onclick = () => el.remove();
  $$("[data-copy]", el).forEach(b => b.onclick = () => shareText(GUIDE[b.dataset.copy]));
  $("#g-all", el).onclick = () => shareText(`[킹콩 배차 카톡 양식]\n\n① 배차 요청(킹콩)\n${GUIDE.req}\n\n② 배차 완료(더한물류)\n${GUIDE.done}\n\n③ 취소 · 회차 · 변경(더한물류)\n${GUIDE.trouble}`);
  $("#g-csv", el).onclick = () => { const csv = "﻿" + TEMPLATE_COLS.map(c => c[0]).join(",") + "\n" + TEMPLATE_COLS.map(c => c[1]).join(",") + "\n";
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "배차요청_양식.csv"; a.click(); };
}
// 표준 엑셀 양식(배차요청_양식.xlsx 와 같은 순서)
const TEMPLATE_COLS = [["운행일", "2026-11-04"], ["시간대", "오전"], ["상차지", "진천센터"], ["하차지", "이천점"], ["경유", ""], ["PLT", "18"], ["온도", "상온"], ["그룹넘버", ""], ["업체", "더한물류"], ["메모", "오전 하차"]];
function parseTemplateRows(text, places) {
  const rows = String(text || "").split(/\r?\n/).map(l => l.split("\t").map(c => c.trim())); let H = null; const out = [];
  for (const c of rows) {
    if (!c.some(Boolean)) continue;
    if (c.includes("상차지") && c.includes("하차지") && !c.some(x => /group\s*number/i.test(x))) { H = {}; c.forEach((x, i) => { if (x && H[x] == null) H[x] = i; }); continue; }
    let g;
    if (H) g = k => (H[k] != null ? c[H[k]] || "" : "");
    else if (/^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.]\d{1,2})/.test(c[0] || "") && c.length >= 6 && !c.some(x => /(오전|오후)$/.test(x) && /\d{4}-/.test(x))) { const idx = Object.fromEntries(TEMPLATE_COLS.map((x, i) => [x[0], i])); g = k => c[idx[k]] || ""; }
    else continue;
    const from = g("상차지"), to = g("하차지"); if (!from || !to) continue;
    const dm = g("운행일").match(/(\d{4})-(\d{1,2})-(\d{1,2})/) || g("운행일").match(/()(\d{1,2})[\/.](\d{1,2})/);
    const run = dm ? `${dm[1] || today().slice(0, 4)}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}` : today();
    const fromN = resolvePlace(from, places); const fk = (places || []).find(p => p.name === fromN)?.kind;
    out.push({ type: fk === "쿠팡FC" || g("그룹넘버") ? "coupang" : "center", run_date: run, time_slot: (g("시간대").match(/오전|오후|야간/) || [""])[0], from_place: fromN, to_place: resolvePlace(to, places), via_place: g("경유"),
      plt_qty: numOrNull(g("PLT").replace(/[^\d.]/g, "")), temp: /냉동/.test(g("온도")) ? "냉동" : /냉장/.test(g("온도")) ? "냉장" : "상온", group_no: g("그룹넘버").replace(/\s/g, ""), cargo_note: g("메모"), vendorName: g("업체"), requested_by: "", src: `${from} → ${to}` });
  }
  return out;
}


// 통합 대장 비고란에서 바로 질문
function askQuestion(d, anchor) {
  $("#ask-pop")?.remove();
  const pop = document.createElement("div"); pop.id = "ask-pop"; pop.className = "ask-pop";
  pop.innerHTML = `<p class="sec-t" style="margin:0 0 6px">#${d.id} ${esc(d.from_place)} → ${esc(d.to_place)} — 더한물류에 질문</p>${(d.comments || []).length ? threadHtml(d) : ""}
    <textarea rows="2" placeholder="예) 추가운임 3만원 사유가 뭔가요?" aria-label="질문"></textarea><div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn sm" data-x>닫기</button><button class="btn sm primary" data-s>질문 보내기</button></div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect(); pop.style.top = Math.min(innerHeight - pop.offsetHeight - 10, r.bottom + 4) + "px"; pop.style.left = Math.max(10, Math.min(innerWidth - pop.offsetWidth - 10, r.right - pop.offsetWidth)) + "px";
  const ta = $("textarea", pop); ta.focus();
  $("[data-x]", pop).onclick = () => pop.remove();
  $("[data-s]", pop).onclick = async () => { const body = ta.value.trim(); if (!body) return toast("질문을 적어 주세요");
    try { await Admin.comment(d.id, body); pop.remove(); await reload(); toast("질문을 남겼습니다 — 더한물류 화면에 바로 보입니다"); } catch (e) { toast(e.message); } };
}

// 시작(모든 선언이 끝난 뒤) — 주소로 화면을 고르고, 실시간 갱신을 건다
if (vendorParam) { vendorBoot(vendorParam); Live.start(q => { if (Vendor.name) remoteRefresh(q, formBusy, quiet => vendorLoad(quiet)); }); }
else if (storeParam) { storeBoot(storeParam); Live.start(q => { if (Store.name) remoteRefresh(q, formBusy, quiet => storeLoad(quiet)); }); }
else { adminBoot(); Live.start(q => { if (S.user && S.refs) remoteRefresh(q, () => formBusy() || S.tab === "new", quiet => reload(quiet)); }); }
})();
