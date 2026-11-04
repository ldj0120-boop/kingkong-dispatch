/* =====================================================================
   킹콩백화점 통합 물류 배차 · 정산 — 프로토타입 (바닐라 JS, 빌드 없음)
   - 주소에 ?v=업체이름 → 업체(모바일) · ?s=매장이름 → 매장 배송요청(모바일) · 없으면 킹콩 관리자 화면
   - 카톡 · 엑셀 글을 그대로 붙여넣으면 요청 · 배차 · 취소 · 회차가 들어가고, 저장하면 모든 화면이 실시간으로 바뀜
   - config.js 가 비어 있으면 데모 모드(localStorage), 채우면 Supabase
   ===================================================================== */
(() => {
"use strict";
const BUILD = "12";             // 화면 오른쪽 위(관리자) · 맨 아래(휴대폰)에 보이는 빌드 번호 — 고칠 때마다 1씩 올림
const CFG = window.KK_CONFIG || {};
// 태성로지스틱스 · 태성물류 = 더한물류(같은 곳). 옛 링크 · 카톡 이름도 더한물류로
const VENDOR_ALIAS = { "태성로지스틱스": "더한물류", "태성물류": "더한물류", "태성": "더한물류" };
const vendorCanon = n => { if (!n) return n; for (const k of Object.keys(VENDOR_ALIAS)) if (n === k || n.startsWith(k)) return VENDOR_ALIAS[k]; return n; };
// 연습 모드: 주소 끝 ?demo=1 (끄기 ?demo=0) — 실제 데이터는 건드리지 않고 이 기기 안의 연습용 데이터로만 동작
const PRACTICE = (() => { try { const q = new URLSearchParams(location.search).get("demo"); if (q === "1") localStorage.setItem("kk_practice", "1"); if (q === "0") localStorage.removeItem("kk_practice"); return localStorage.getItem("kk_practice") === "1"; } catch (_) { return false; } })();
const HAS_DB = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
const LIVE = HAS_DB && !PRACTICE;
// 1단계(파일럿) 범위: 쿠팡 출고 + 진천센터 → 매장 출고만. 신선(콜드체인) 센터 · 고객 배송은 2단계
const PHASE = +(CFG.PHASE || 1);
const PILOT_FROM = CFG.PILOT_CENTER || "진천센터";
let SHOW_ALL = (() => { try { return localStorage.getItem("kk_show_all") === "1"; } catch (_) { return false; } })();
const inScope = d => PHASE >= 2 || SHOW_ALL || !d || d.type === "coupang" || (d.type === "center" && (!d.from_place || d.from_place === PILOT_FROM || /진천/.test(d.from_place) || d.to_place === PILOT_FROM || /진천/.test(d.to_place || "")));
// 1단계 참여 그룹: 킹콩본사 · 진천센터 · 더한물류(매장 · 신선센터는 2단계). config.js STORES_OPEN: true 면 매장 화면도 열림
const STORES_OPEN = PHASE >= 2 || !!CFG.STORES_OPEN;
const ORDERERS = CFG.ORDERERS || ["킹콩본사", "킹콩백화점", "진천센터"];   // 발주처 그룹(차량 등록 알림을 받는 곳)

// ---------------- 공통 상수 ----------------
const TYPES = {
  coupang:  { label: "쿠팡 출고요청", short: "쿠팡", desc: "쿠팡 FC 출고요청 물량 → 센터·매장" },
  center:   { label: "센터·본사 요청", short: "센터/본사", desc: "매장 간 이동 · 외부업체 물품 → 진천센터·매장" },
  delivery: { label: "고객 배송", short: "고객배송", desc: "매장 대형가전·가구 판매 후 고객 집까지" },
};
if (PHASE < 2 && !SHOW_ALL) { TYPES.center.label = "진천센터 → 매장 출고"; TYPES.center.short = "센터→매장"; TYPES.center.desc = "진천센터에서 매장으로 나가는 출고 배차"; }
const ACTIVE_TYPES = () => (PHASE >= 2 || SHOW_ALL) ? Object.keys(TYPES) : ["coupang", "center"];
const STATUS = {
  requested: "배차 요청", assigned: "배차 완료", done: "운행 완료", checked: "확인 완료", confirmed: "정산 확정", canceled: "취소",
};
const FARE_KEYS = ["base_fare", "extra_fare", "extra_reason", "return_fare", "return_date", "return_driver", "return_from"];   // 더한물류만 입력 · 수정
const STATUS_ORDER = ["requested", "assigned", "done", "checked", "confirmed"];   // 운행 완료 → 본사 확인(최종 완료) → 정산 확정
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
const DEMO_KEY = PRACTICE ? "kk_dispatch_practice_v1" : "kk_dispatch_demo_v5";
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
  const checkers = [{ id: "c1", name: "본사물류", pin: "4321", active: true }];
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
  D.forEach(d => { if (d.status === "done" && d.run_date < addDays(base, -4)) { Object.assign(d, { status: "checked", checked_at: d.run_date + "T19:10:00", checked_by: "checker:본사물류" }); (d.events ||= []).push({ at: d.run_date + "T19:10:00", by: "checker:본사물류", kind: "check" }); } });   // 지난 건은 본사 확인까지 끝난 것으로
  // 병행 테스트 예시: 지난 14일 — 82% 앱 · 시트 둘 다(일치), 8% 시트에만, 10% 앱에만, 차이 몇 건
  const syncDiffs = [];
  D.forEach(d => { if (d.run_date >= addDays(base, -14) && d.run_date < base && d.status !== "canceled") { const r = rnd(); if (r < 0.82) d.sheet_key = "demo:" + d.id; else if (r < 0.9) { d.sheet_key = "demo:" + d.id; d.origin = "sheet"; }
    if (r < 0.82 && d.base_fare && rnd() < 0.06) syncDiffs.push({ id: syncDiffs.length + 1, at: d.run_date + "T20:05:00", dispatch_id: d.id, sheet_key: d.sheet_key, field: "base_fare", app_value: String(d.base_fare), sheet_value: String(d.base_fare + 20000) }); } });
  return { vendors, places, rates, stores, checkers, syncDiffs, dispatches: D, settlements: [], audit: [], attachments: [], nextId: id };
}
const AUDIT_SKIP = ["updated_at", "updated_by", "settle_month", "billed_amount", "rate_fare", "created_at", "events", "comments", "delivery", "_dup"];
function diffRow(a, b) {
  const d = {}; const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  keys.forEach(k => { if (AUDIT_SKIP.includes(k)) return; const x = a?.[k] ?? null, y = b?.[k] ?? null; if (JSON.stringify(x) !== JSON.stringify(y) && !(x === "" && y === null) && !(x === null && y === "")) d[k] = [x, y]; });
  return d;
}
const plainRow = d => { const x = {}; Object.keys(d).forEach(k => { if (!AUDIT_SKIP.includes(k)) x[k] = d[k]; }); return x; };
const Backup = {
  key: DEMO_KEY + "_backup",
  loadAll() { try { return JSON.parse(localStorage.getItem(this.key) || "[]"); } catch (_) { return []; } },
  saveAll(a) { try { localStorage.setItem(this.key, JSON.stringify(a)); } catch (_) { try { localStorage.setItem(this.key, JSON.stringify(a.slice(0, 5))); } catch (__) {} } },
};
const Demo = {
  db: null,
  load() { try { this.db = JSON.parse(localStorage.getItem(DEMO_KEY) || "null"); } catch (_) { this.db = null; } if (!this.db) { this.db = demoSeed(); this.save(); }
    if (!(this.db.stores || []).some(x => x.kind === "center")) { (this.db.stores ||= []).push({ id: "g1", name: "진천센터", pin: "2468", kind: "center", active: true }); this.db.dispatches.forEach(d => { if (!d.orderer) d.orderer = d.origin === "store" ? (d.type === "delivery" ? d.from_place : d.to_place) : "킹콩본사"; }); this.save(); }
    return this.db; },
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
  ch: null, cb: null, state: LIVE ? "connecting" : "local", last: null,
  async start(cb) {
    this.cb = cb;
    window.addEventListener("storage", e => { if (e.key === DEMO_KEY) this.fire(false); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") this.fire(true); });
    window.addEventListener("offline", () => this.set("offline"));
    window.addEventListener("online", () => { this.set(LIVE ? "connecting" : "local"); this.fire(true); });
    if (!LIVE) return;
    try { const c = await liveClient(); this.ch = c.channel("kk-dispatch").on("broadcast", { event: "changed" }, () => this.fire(false))
      .subscribe(st => this.set(st === "SUBSCRIBED" ? "ok" : ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(st) ? "err" : "connecting")); } catch (_) { this.set("err"); }
    setInterval(() => { if (document.visibilityState === "visible") this.fire(true); }, 90000);
  },
  set(st) { this.state = st; paintSync(); },
  mark(ok = true) { if (ok) { this.last = new Date(); if (this.state === "offline" && navigator.onLine) this.state = LIVE ? "connecting" : "local"; } else if (!navigator.onLine) this.state = "offline"; else if (LIVE) this.state = "err"; paintSync(); },
  fire(quiet) { if (this.cb) this.cb(quiet); },
  notify() { try { if (LIVE && this.ch) this.ch.send({ type: "broadcast", event: "changed", payload: { at: Date.now() } }); } catch (_) {} },
};
// ---- 동기화 상태 표시(모든 화면) · 연습 모드 표시 ----
const SYNC_TXT = { ok: "실시간 연결", connecting: "연결 중", err: "연결 끊김 · 90초마다 재확인", offline: "오프라인", local: PRACTICE ? "연습 모드" : "데모" };
const hm = d => d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}` : "";
const syncChipHtml = () => `<button type="button" class="sync-chip s-${Live.state}" data-sync title="동기화 상태 — 눌러서 자세히"><i aria-hidden="true"></i><span>${SYNC_TXT[Live.state]}${Live.last ? " · " + hm(Live.last) : ""}</span></button>`;
const modeTag = () => PRACTICE ? ` <span class="practice-tag">연습 모드</span>` : LIVE ? "" : " · 데모";
function paintSync() { $$("[data-sync]").forEach(b => { b.className = `sync-chip s-${Live.state}`; b.querySelector("span").textContent = SYNC_TXT[Live.state] + (Live.last ? " · " + hm(Live.last) : ""); }); }
function bindSyncChip() { $$("[data-sync]").forEach(b => b.onclick = openSyncInfo); }
function openSyncInfo() {
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "동기화 상태");
  const url = new URL(location.href); url.searchParams.set("demo", PRACTICE ? "0" : "1");
  el.innerHTML = `<header><button class="btn ghost" id="yx" aria-label="닫기">←</button><h3>동기화 상태</h3></header>
  <div class="body">
    <div class="req-box">${syncChipHtml().replace("data-sync", "")}<br><span class="muted">마지막으로 받은 시각 ${Live.last ? hm(Live.last) : "-"}</span></div>
    <ul class="plain">
      <li><b>실시간 연결</b> — 누가 저장하면 이 화면도 몇 초 안에 바뀝니다.</li>
      <li><b>연결 중 · 끊김</b> — 화면은 90초마다, 앱을 다시 열 때마다 새로 받습니다. 오래 끊겨 있으면 새로고침하세요.</li>
      <li><b>오프라인</b> — 인터넷이 없습니다. 저장은 연결된 뒤에 하세요.</li>
      ${S.user ? `<li><b>구글시트</b> — 1시간마다 들어옵니다(설정 → 구글시트 동기화에서 시각 확인).</li>` : ""}
    </ul>
    <div class="card" style="padding:14px;margin-top:10px"><b>${PRACTICE ? "지금은 연습 모드입니다" : "연습 모드"}</b>
      <p class="hint">${PRACTICE ? "이 기기 안의 연습용 데이터만 바뀝니다. 실제 배차 · 금액에는 아무 영향이 없습니다." : "실제 데이터를 건드리지 않고 이 기기 안에서 마음껏 눌러 볼 수 있는 모드입니다. 교육 · 시연용."}</p>
      <div class="row" style="gap:8px;flex-wrap:wrap"><a class="btn ${PRACTICE ? "" : "primary"}" href="${esc(url.toString())}">${PRACTICE ? "연습 모드 끄기(실제 데이터로)" : "연습 모드 켜기"}</a>${PRACTICE ? `<button class="btn" id="yreset">연습 데이터 처음으로</button>` : ""}</div></div>
  </div><footer><button class="btn" id="yx2">닫기</button></footer>`;
  document.body.appendChild(el);
  $("#yx", el).onclick = $("#yx2", el).onclick = () => el.remove();
  const r = $("#yreset", el); if (r) r.onclick = () => { if (!confirm("연습 데이터를 처음 상태로 되돌릴까요?")) return; try { localStorage.removeItem(DEMO_KEY); } catch (_) {} location.reload(); };
}
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
    if (!LIVE) return { email: "관리자(데모)", name: "관리자(데모)", can_delete: true, org: "킹콩본사" };
    const c = await liveClient(); const { data } = await c.auth.getSession(); if (!data.session) return null;
    const me = await c.rpc("staff_me").then(r => r.data || {}).catch(() => ({}));
    return { email: data.session.user.email, name: me.name || "", can_delete: !!me.can_delete, org: me.org || "킹콩본사" };
  },
  async login(email) { const c = await liveClient(); unwrap(await c.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split("#")[0] } })); },
  async logout() { if (LIVE) { const c = await liveClient(); await c.auth.signOut(); } location.reload(); },
  async refs() {
    if (!LIVE) { const db = Demo.load(); return { vendors: db.vendors, places: db.places, rates: db.rates, stores: db.stores || [], checkers: db.checkers || [] }; }
    const c = await liveClient();
    const [vendors, places, rates, stores] = await Promise.all([
      c.from("vendors").select("id,name,types,contact,active").order("name").then(unwrap),
      c.from("places").select("*").order("name").then(unwrap),
      c.from("rate_cards").select("*").then(unwrap),
      c.from("stores").select("id,name,active,kind").order("name").then(unwrap)]);
    const checkers = await c.from("checkers").select("id,name,active").order("name").then(unwrap).catch(() => []);
    return { vendors, places, rates, stores, checkers };
  },
  async list(from, to) {
    if (!LIVE) return Demo.load().dispatches.filter(d => !d.deleted_at && d.run_date >= from && d.run_date <= to).map(d => ({ ...d, rate_fare: Demo.rateFor(d) })).sort((x, y) => y.run_date.localeCompare(x.run_date) || y.id - x.id);
    const c = await liveClient();
    return unwrap(await c.from("dispatches").select("*, dispatch_delivery(*), dispatch_events(*), dispatch_comments(*)").is("deleted_at", null).gte("run_date", from).lte("run_date", to).order("run_date", { ascending: false }).order("id", { ascending: false }).limit(5000)).map(flatDelivery);
  },
  async save(d, actor) {
    const row = { ...d }; const del = row.delivery; delete row.delivery; delete row.rate_fare; delete row.billed_amount; delete row.settle_month; delete row.events; delete row._dup;
    if (!LIVE) {
      const db = Demo.load();
      FARE_KEYS.forEach(k => { if (row.id) delete row[k]; else row[k] = k === "extra_fare" ? 0 : null; });   // 금액은 더한물류만
      if (row.id) { const i = db.dispatches.findIndex(x => x.id === row.id); const prev = JSON.parse(JSON.stringify(db.dispatches[i])); db.dispatches[i] = { ...db.dispatches[i], ...row, delivery: del || db.dispatches[i].delivery, updated_at: new Date().toISOString(), updated_by: actor }; trackLocal(prev, db.dispatches[i], actor); Demo.logChange(row.id, actor, prev, db.dispatches[i]); }
      else { row.id = db.nextId++; row.orderer ||= S.user?.org || "킹콩본사"; const n = { ...row, delivery: del, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: actor }; trackLocal(null, n, actor); db.dispatches.push(n); Demo.log(row.id, actor, "insert", plainRow(n)); if (del) Demo.log(row.id, actor, "insert", { ...del }, "dispatch_delivery"); }
      Demo.save(); return row.id;
    }
    const c = await liveClient(); row.updated_by = actor; FARE_KEYS.forEach(k => delete row[k]);   // 금액은 더한물류만(DB도 막음)
    let saved;
    if (row.id) saved = unwrap(await c.from("dispatches").update(row).eq("id", row.id).select().single());
    else { delete row.id; saved = unwrap(await c.from("dispatches").insert(row).select().single()); }
    if (del) unwrap(await c.from("dispatch_delivery").upsert({ ...del, dispatch_id: saved.id }));
    Live.notify(); return saved.id;   // 수정 기록은 DB 트리거가 칸 단위로 남김
  },
  // ---- 삭제(휴지통) · 되살리기 — 삭제 권한자만 ----
  async remove(ids, reason, actor) {
    if (!LIVE) { const db = Demo.load(); let n = 0; const at = new Date().toISOString();
      db.dispatches.forEach(d => { if (ids.includes(d.id) && !d.deleted_at) { if (d.status === "confirmed") throw new Error("정산 확정된 건은 삭제할 수 없습니다"); const prev = { ...d }; Object.assign(d, { deleted_at: at, deleted_by: actor, delete_reason: reason, updated_by: actor, updated_at: at }); Demo.logChange(d.id, actor, prev, d); n++; } });
      Demo.save(); return n; }
    const c = await liveClient(); const n = unwrap(await c.rpc("dispatch_delete", { p_ids: ids, p_reason: reason })); Live.notify(); return n;
  },
  async restore(ids, actor) {
    if (!LIVE) { const db = Demo.load(); let n = 0; db.dispatches.forEach(d => { if (ids.includes(d.id) && d.deleted_at) { const prev = { ...d }; Object.assign(d, { deleted_at: null, deleted_by: null, delete_reason: null, updated_by: actor, updated_at: new Date().toISOString() }); Demo.logChange(d.id, actor, prev, d); n++; } }); Demo.save(); return n; }
    const c = await liveClient(); const n = unwrap(await c.rpc("dispatch_restore", { p_ids: ids })); Live.notify(); return n;
  },
  async trash() {
    if (!LIVE) return Demo.load().dispatches.filter(d => d.deleted_at).sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
    const c = await liveClient(); return unwrap(await c.from("dispatches").select("*").not("deleted_at", "is", null).order("deleted_at", { ascending: false }).limit(300));
  },
  // ---- 일별 백업 — 그날 처음 들어온 관리자 화면이 만들고(운영은 매일 00:05 자동도), 90일(데모 14일) 보관 ----
  async backupToday(force = false) {
    const day = today();
    if (!LIVE) { const all = Backup.loadAll(); if (!force && all.some(b => b.day === day)) return { day, new: false };
      const rows = JSON.parse(JSON.stringify(Demo.load().dispatches)); const b = { day, made_at: new Date().toISOString(), made_by: S.user?.email || "", row_count: rows.length, rows };
      Backup.saveAll([b, ...all.filter(x => x.day !== day)].sort((a, c) => c.day.localeCompare(a.day)).slice(0, 14)); return { day, new: true, row_count: rows.length }; }
    const c = await liveClient(); return unwrap(await c.rpc("backup_ledger", { p_force: force }));
  },
  async backups() {
    if (!LIVE) return Backup.loadAll().map(({ rows, ...b }) => b);
    const c = await liveClient(); return unwrap(await c.from("ledger_backups").select("day,made_at,made_by,row_count").order("day", { ascending: false }));
  },
  async backupRows(day) {
    if (!LIVE) return (Backup.loadAll().find(b => b.day === day) || {}).rows || [];
    const c = await liveClient(); const r = unwrap(await c.from("ledger_backups").select("rows").eq("day", day).single()); return r.rows || [];
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
  async syncDiffs(from) {
    if (!LIVE) return (Demo.load().syncDiffs || []).filter(x => x.at >= from);
    const c = await liveClient(); return unwrap(await c.from("sync_diffs").select("*").gte("at", from).order("at", { ascending: false }).limit(500));
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
    if (CFG.TEST_MODE) throw new Error("테스트 기간에는 정산 확정을 하지 않습니다");
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
    this.name = name; this.pin = pin; try { sessionStorage.setItem("kk_vpin_" + name, pin); localStorage.setItem("kk_vpin_" + name, pin); localStorage.setItem("kk_role", "v:" + name); } catch (_) {}
  },
  async list() {
    if (!LIVE) { const db = Demo.load(); const v = db.vendors.find(x => x.id === this.vid); const lo = addDays(today(), -45);
      return db.dispatches.filter(d => !d.deleted_at && (d.status !== "canceled" || (d.updated_at || "") >= addDays(today(), -3)) && d.run_date >= lo && (d.vendor_id === this.vid || (!d.vendor_id && v.types.includes(d.type)))).map(d => ({ ...d, rate_fare: Demo.rateFor({ ...d, vendor_id: this.vid }) })).sort((a, b) => b.run_date.localeCompare(a.run_date) || b.id - a.id); }
    const c = await liveClient(); return unwrap(await c.rpc("vendor_list", { p_vendor: this.name, p_pin: this.pin }));
  },
  async refs() {
    if (!LIVE) { const db = Demo.load(); return { places: db.places.map(p => p.name), place_list: db.places.map(p => ({ name: p.name, aliases: p.aliases || [] })), rates: db.rates.filter(r => r.vendor_id === this.vid) }; }
    const c = await liveClient(); return unwrap(await c.rpc("vendor_refs", { p_vendor: this.name, p_pin: this.pin }));
  },
  async save(id, p) {
    if (!LIVE) { const db = Demo.load(); const d = db.dispatches.find(x => x.id === id); if (d.status === "confirmed") throw new Error("정산 확정된 건은 고칠 수 없습니다");
      const { done_note, ...rest } = p; const prev = JSON.parse(JSON.stringify(d)); Object.assign(d, rest, { vendor_id: this.vid, updated_at: new Date().toISOString(), updated_by: "vendor:" + this.name }); if (d.delivery && done_note != null) d.delivery.done_note = done_note;
      if (d.type !== "delivery") d.run_date = prev.run_date;
      if (prev.status === "checked") Object.assign(d, { checked_at: null, checked_by: null });   // 확인 끝난 건을 고치면 다시 확인
      trackLocal(prev, d, "vendor:" + this.name);
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
    if (!LIVE) { const db = Demo.load(); const id = db.nextId++; const n = { ...p, id, vendor_id: this.vid, origin: p.status === "requested" ? "kingkong" : "vendor", status: ["assigned", "requested"].includes(p.status) ? p.status : "done", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: "vendor:" + this.name };
      trackLocal(null, n, "vendor:" + this.name); db.dispatches.push(n); Demo.log(id, "vendor:" + this.name, "insert", plainRow(n)); Demo.save(); return id; }
    const c = await liveClient(); const r = unwrap(await c.rpc("vendor_add", { p_vendor: this.name, p_pin: this.pin, p })); Live.notify(); return r?.id;
  },
};

// ---- 매장 쪽(링크 + 매장 PIN) — 고객배송 요청 ----
const Store = {
  name: null, pin: null,
  async login(name, pin) {
    if (!LIVE) { const s = (Demo.load().stores || []).find(x => x.name === name && x.active !== false && x.kind !== "center"); if (!s || s.pin !== pin) throw new Error("PIN이 맞지 않습니다"); }
    else { const c = await liveClient(); unwrap(await c.rpc("store_list", { p_store: name, p_pin: pin })); }
    this.name = name; this.pin = pin; try { sessionStorage.setItem("kk_spin_" + name, pin); localStorage.setItem("kk_spin_" + name, pin); localStorage.setItem("kk_role", "s:" + name); } catch (_) {}
  },
  async list() {
    if (!LIVE) { const db = Demo.load(); const lo = addDays(today(), -90);
      return db.dispatches.filter(d => !d.deleted_at && ((d.type === "delivery" && d.from_place === this.name) || (d.type !== "delivery" && d.to_place === this.name)) && (d.created_at || d.run_date) >= lo).map(d => ({ id: d.id, status: d.status, run_date: d.run_date, created_at: d.created_at,
        type: d.type, from_place: d.from_place, to_place: d.to_place, plt_qty: d.plt_qty, time_slot: d.time_slot, temp: d.temp, cargo_note: d.cargo_note, origin: d.origin, requested_by: d.requested_by, vehicle_ton: d.vehicle_ton, vehicle_body: d.vehicle_body,
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
  // 1단계: 진천센터 → 우리 매장 출고 요청(빠른 요청 · 최근 요청 복사)
  async request(p) {
    if (!(+p.plt_qty > 0)) throw new Error("PLT 수량을 넣어 주세요");
    if (p.run_date < today()) throw new Error("지난 날짜로는 요청할 수 없습니다");
    if (!LIVE) { const db = Demo.load(); const id = db.nextId++; const now = new Date().toISOString(); const actor = "store:" + this.name;
      const vd = db.vendors.find(v => v.active && v.types.includes("center"));
      const n = { type: "center", status: "requested", origin: "store", vendor_id: vd?.id || null, run_date: p.run_date, time_slot: p.time_slot || "", from_place: p.from_place || PILOT_FROM, to_place: this.name,
        plt_qty: +p.plt_qty, temp: p.temp || "상온", cargo_note: p.cargo_note || "", requested_by: p.requested_by || actor, extra_fare: 0, id, created_at: now, updated_at: now, updated_by: actor };
      trackLocal(null, n, actor); db.dispatches.push(n); Demo.log(id, actor, "insert", plainRow(n)); Demo.save(); return id; }
    const c = await liveClient(); const id = unwrap(await c.rpc("store_request", { p_store: this.name, p_pin: this.pin, p })); Live.notify(); return id;
  },
  async cancel(id) {
    if (!LIVE) { const db = Demo.load(); const d = db.dispatches.find(x => x.id === id); if (!d || d.status !== "requested" || !(d.type === "delivery" || d.origin === "store")) throw new Error("배차가 이미 잡힌 건은 본사에 연락해 주세요");
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
// 홈 화면 앱 · 알림을 눌러 열면 주소에 업체/매장 이름이 없으니, 이 휴대폰에서 마지막으로 쓴 화면으로
const appMode = params.has("app") || matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let savedRole = null; try { savedRole = localStorage.getItem("kk_role"); } catch (_) {}
const vendorParam = vendorCanon(params.get("v") || hashParam("v")) || (appMode && savedRole?.startsWith("v:") ? savedRole.slice(2) : null);
const storeParam = params.get("s") || hashParam("s") || (appMode && !vendorParam && savedRole?.startsWith("s:") ? savedRole.slice(2) : null);
const centerParam = params.get("g") || hashParam("g") || (appMode && savedRole?.startsWith("g:") ? savedRole.slice(2) : null);
const checkerParam = params.get("c") || hashParam("c") || (appMode && !vendorParam && !storeParam && savedRole?.startsWith("c:") ? savedRole.slice(2) : null);


// =====================================================================
//  관리자(PC) 화면
// =====================================================================
const S = { tab: "dash", month: today().slice(0, 7), refs: null, rows: [], filter: { type: "", status: "", vendor: "", q: "", flag: "" }, newType: "coupang", user: null };

async function adminBoot() {
  S.user = await Admin.session();
  if (!S.user) return adminLogin();
  try { const h = location.hash.slice(1); if (["dash", "cost", "new", "ledger", "settle", "audit", "setup"].includes(h)) S.tab = h; } catch (_) {}
  await reload(); whatsNew("admin");
  Admin.backupToday().then(r => { if (r && r.new) toast(`오늘 대장 백업을 만들었습니다(${r.row_count}건) — 설정 › 일별 백업`); }).catch(() => {});
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
    S.rowsAll = (await Admin.list(addDays(prev, -40), addDays(end, 40))).filter(inScope); Live.mark();   // 앞뒤 달까지 받아 전월 대비 · 다가오는 요청을 같이 본다
  } catch (e) { Live.mark(false); if (!quiet) app.innerHTML = `<div class="empty">불러오기 실패: ${esc(e.message)}</div>`; return; }
  const sig = S.rowsAll.map(d => d.id + d.status + (d.updated_at || "") + (d.events || []).length + "/" + (d.comments || []).length).join("|");
  if (quiet && S.prevRows) {   // 더한물류가 남긴 회차 · 기사 취소 · 답변, 매장 새 요청을 소리로 알림
    const old = new Map(S.prevRows.map(d => [d.id, d]));
    const trb = S.rowsAll.filter(d => old.has(d.id) && (d.events || []).filter(e => TROUBLE.includes(e.kind)).length > (old.get(d.id).events || []).filter(e => TROUBLE.includes(e.kind)).length);
    const ans = S.rowsAll.filter(d => (d.comments || []).filter(c => c.kind === "answer").length > (old.get(d.id)?.comments || []).filter(c => c.kind === "answer").length);
    const st = S.rowsAll.filter(d => d.origin === "store" && !old.has(d.id));
    const msg = [trb.length && `회차 · 기사 취소 ${trb.length}건`, ans.length && `더한물류 답변 ${ans.length}건`, st.length && `매장 배송 요청 ${st.length}건`].filter(Boolean).join(" · ");
    if (msg) alertLocal("킹콩 배차", msg, trb.length > 0);
  }
  S.prevRows = S.rowsAll;
  if (quiet && sig === S.sig) return; const changed = S.sig && sig !== S.sig; S.sig = sig;
  S.rows = S.rowsAll.filter(d => monthOf(d.run_date) === S.month);
  const y0 = scrollY; render(); if (quiet) scrollTo(0, y0);
  if (quiet && changed) toast("새 내용이 반영되었습니다");
}
const vName = id => (S.refs?.vendors.find(v => v.id === id) || {}).name || (id ? "?" : "미지정");

function render() {
  const nav = [["dash", "대시보드"], ["cost", "물류비"], ["new", "배차 요청"], ["ledger", "통합 대장"], ["settle", "정산"], ["audit", "수정 기록"], ["setup", "설정"]];
  app.innerHTML = `
  <div class="top"><div class="top-in">
    <div class="brand"><span class="logo" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg></span>
      <span>킹콩 물류 배차·정산<small>${esc(CFG.COMPANY || "킹콩백화점")} · 쿠팡 · 센터 · 고객배송 통합 대장 <span class="build-pill">build ${BUILD}</span></small></span></div>
    <nav class="nav" aria-label="메뉴">${nav.map(([k, l]) => `<button data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ""}>${l}</button>`).join("")}</nav>
    <span class="sp"></span>
    <label class="row" style="gap:6px;font-size:13px;font-weight:700;color:var(--muted)" title="기준 월"><input type="month" aria-label="기준 월" id="month" value="${S.month}" style="border:1px solid var(--line);border-radius:8px;padding:6px 8px;background:var(--panel)"></label>
    <button class="btn sm bell" id="a-bell">${bellLabel()}</button><button class="btn sm" id="guide-btn">양식 안내</button><button class="btn sm" id="man-btn">설명서</button>
    ${syncChipHtml()}<span class="mode-badge ${LIVE ? "" : "demo"}" title="${LIVE ? "Supabase 공유 DB에 저장" : PRACTICE ? "실제 데이터와 분리된 연습용 데이터(이 기기에만)" : "이 브라우저에만 저장되는 예시 데이터"}">${LIVE ? esc(S.user.email) : PRACTICE ? "연습 모드" : "데모 모드"}</span>
  </div></div>
  <main id="view"></main>`;
  $$(".nav button").forEach(b => b.onclick = () => { S.tab = b.dataset.tab; history.replaceState(null, "", "#" + S.tab); render(); }); bindSyncChip();
  $("#month").onchange = e => { S.month = e.target.value || S.month; reload(); };
  $("#guide-btn").onclick = () => openGuide("admin");
  $("#man-btn").onclick = () => openManuals("admin");
  bindBell($("#a-bell"), "staff", "", "");
  const v = $("#view");
  ({ dash: viewDash, cost: viewCost, new: viewNew, ledger: viewLedger, settle: viewSettle, audit: viewAudit, setup: viewSetup })[S.tab](v);
}

// ---------------- 물류비 대시보드 — 기본 · 추가(대기료 · 경유비 · 기타) · 회차 합산 + 정확도 검증 ----------------
//  데이터: 앱 대장 + 구글시트(숨김 탭 포함, 1시간마다 들어온 줄 = origin 'sheet')
const extraKind = d => { const r = String(d.extra_reason || ""); return /대기/.test(r) ? "wait" : /경유/.test(r) ? "via" : r ? "etc" : (d.via_place ? "via" : "none"); };
const pltBucket = p => p == null ? "미기재" : p <= 5 ? "1~5" : p <= 10 ? "6~10" : p <= 18 ? "11~18" : "19+";
const median = a => { const x = a.slice().sort((p, q) => p - q); const m = x.length >> 1; return x.length ? (x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2) : null; };
S.cost = { per: "month", src: "", type: "", check: "" };
function costRows() {
  const c = S.cost, [y, m] = S.month.split("-").map(Number), last = new Date(y, m, 0).getDate();
  const range = { month: [`${S.month}-01`, `${S.month}-${last}`], first: [`${S.month}-01`, `${S.month}-15`], second: [`${S.month}-16`, `${S.month}-${last}`],
    prev: [ymd(new Date(y, m - 2, 1)), ymd(new Date(y, m - 1, 0))], week: [addDays(today(), -6), today()] }[c.per];
  return S.rowsAll.filter(d => d.run_date >= range[0] && d.run_date <= range[1] && counted(d) && (!c.type || d.type === c.type) && (!c.src || (c.src === "sheet" ? d.origin === "sheet" : d.origin !== "sheet")));
}
// 검증 규칙: 운임 정확도를 떨어뜨리는 것들
function costChecks(R) {
  const fare = R.filter(d => d.base_fare != null && d.status !== "canceled");
  const grp = {}; fare.forEach(d => { const k = [d.type, d.from_place, d.to_place, d.vehicle_ton || ""].join("|"); (grp[k] ||= []).push(+d.base_fare); });
  const outlier = d => { const g = grp[[d.type, d.from_place, d.to_place, d.vehicle_ton || ""].join("|")]; if (!g || g.length < 3) return false; const md = median(g); return md && Math.abs(d.base_fare - md) / md > 0.3; };
  const dupKey = d => [d.run_date, d.from_place, d.to_place, d.plt_qty, d.driver_name || "", d.vehicle_no || ""].join("|"); const dk = {}; R.forEach(d => { if (d.status !== "canceled" && d.driver_name) dk[dupKey(d)] = (dk[dupKey(d)] || 0) + 1; });
  return [
    ["nofare", "금액 미입력", "운행 완료 · 확인 건인데 기본운임이 비어 있음", d => ["done", "checked", "confirmed"].includes(d.status) && d.base_fare == null, true],
    ["norate", "운임표 없음", "운임표에 없는 구간 · 톤수(설정 › 운임표에 추가하면 검증됨)", d => d.base_fare != null && (d.rate_fare == null || d.rate_fare === ""), false],
    ["over", "운임표 초과", "기본운임 > 운임표", d => d.base_fare != null && d.rate_fare && +d.base_fare > +d.rate_fare, true],
    ["under", "운임표 미달", "기본운임 < 운임표(입력 실수 확인)", d => d.base_fare != null && d.rate_fare && +d.base_fare < +d.rate_fare, false],
    ["noreason", "추가운임 사유 없음", "추가운임이 있는데 대기 · 경유 등 사유가 없음", d => +d.extra_fare > 0 && !String(d.extra_reason || "").trim(), true],
    ["vianofee", "경유인데 경유비 없음", "경유지가 있는데 추가운임이 0", d => !!d.via_place && !(+d.extra_fare > 0) && d.base_fare != null, false],
    ["outlier", "같은 구간 단가 이상", "같은 구간 · 톤수 중앙값과 30% 넘게 차이", d => d.base_fare != null && outlier(d), true],
    ["dup", "중복 의심", "같은 날 · 구간 · PLT · 기사 · 차량이 2건 이상", d => d.status !== "canceled" && d.driver_name && dk[dupKey(d)] > 1, true],
    ["noton", "톤수 미기재", "배차됐는데 톤수가 없어 운임표 검증 불가", d => ["assigned", "done", "checked", "confirmed"].includes(d.status) && !d.vehicle_ton, false],
  ];
}
function viewCost(v) {
  const c = S.cost, R = costRows(), checks = costChecks(R);
  const sum = (L, f) => L.reduce((a, d) => a + (+f(d) || 0), 0);
  const fare = R.filter(d => d.base_fare != null);
  const base = sum(R, d => d.status === "canceled" ? 0 : d.base_fare), ex = k => sum(R.filter(d => extraKind(d) === k), d => d.status === "canceled" ? 0 : d.extra_fare);
  const wait = ex("wait"), via = ex("via"), etc = ex("etc") + ex("none"), ret = sum(R, d => d.return_fare), total = base + wait + via + etc + ret;
  const plt = sum(R, d => d.status === "canceled" ? 0 : d.plt_qty), withRate = fare.filter(d => +d.rate_fare > 0), rateSum = sum(withRate, d => d.rate_fare), billedSum = sum(withRate, d => d.base_fare);
  const fareLive = fare.filter(d => d.status !== "canceled"), pltF = sum(fareLive, d => d.plt_qty), perPlt = pltF ? (sum(fareLive, d => billed(d)) + sum(fare, d => d.return_fare)) / pltF : null;
  const strict = checks.filter(x => x[4]); const bad = new Set(); fare.forEach(d => { if (strict.some(x => x[3](d))) bad.add(d.id); });
  const acc = fare.length ? Math.round((fare.length - bad.size) / fare.length * 1000) / 10 : null;
  const sheetN = R.filter(d => d.origin === "sheet").length;
  const chip = (k, val, label) => `<button class="fchip" data-ck="${k}" data-cv="${val}" aria-pressed="${c[k] === val}">${label}</button>`;
  const kpi = (l, val, sub, cls = "") => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v num">${val}</div><div class="s">${sub}</div></div>`;
  const table = (title, keyFn, label) => { const g = {}; R.forEach(d => { const k = keyFn(d); (g[k] ||= []).push(d); });
    const rows = Object.entries(g).map(([k, L]) => { const F = L.filter(d => d.base_fare != null && d.status !== "canceled"); return { k, n: L.length, plt: sum(L, d => d.plt_qty), base: sum(F, d => d.base_fare), extra: sum(F, d => d.extra_fare), ret: sum(L, d => d.return_fare), avg: F.length ? sum(F, d => d.base_fare) / F.length : null, diff: sum(F.filter(d => +d.rate_fare > 0), d => +d.rate_fare - +d.base_fare), nf: F.length }; })
      .sort((a, b) => (b.base + b.extra + b.ret) - (a.base + a.extra + a.ret));
    return `<div class="card"><h2>${title}</h2><div class="tbl-wrap" style="max-height:380px"><table class="tbl"><thead><tr><th>${label}</th><th class="r">건수</th><th class="r">PLT</th><th class="r">평균 기본운임</th><th class="r">기본</th><th class="r">추가</th><th class="r">회차</th><th class="r">합계</th><th class="r">PLT당</th><th class="r" title="운임표 − 청구(+면 절감, −면 초과)">운임표 차액</th></tr></thead><tbody>
      ${rows.map(r => `<tr data-cq="${esc(r.k)}"><td>${esc(r.k)}</td><td class="r num">${r.n}</td><td class="r num">${r.plt || ""}</td><td class="r num">${r.avg ? won(r.avg) : "-"}</td><td class="r num">${won(r.base)}</td><td class="r num">${r.extra ? won(r.extra) : ""}</td><td class="r num">${r.ret ? won(r.ret) : ""}</td><td class="r num"><b>${r.nf || r.ret ? won(r.base + r.extra + r.ret) : "-"}</b>${r.nf < r.n ? `<div class="kmeta">금액 ${r.nf}/${r.n}건</div>` : ""}</td><td class="r num">${r.nf && r.plt ? won((r.base + r.extra + r.ret) / sum((g[r.k] || []).filter(d => d.base_fare != null && d.status !== "canceled"), d => d.plt_qty) || 0) : "-"}</td><td class="r num ${r.diff < 0 ? "neg" : ""}">${r.diff ? (r.diff > 0 ? "▼" : "▲") + won(Math.abs(r.diff)) : ""}</td></tr>`).join("") || '<tr><td colspan="10" class="muted">없음</td></tr>'}</tbody></table></div></div>`; };
  const sel = c.check ? checks.find(x => x[0] === c.check) : null, selRows = sel ? R.filter(sel[3]) : [];
  v.innerHTML = `<div class="grid">
    <div class="card fbar"><div class="frow"><span class="flab">기간</span>${chip("per", "month", `${+S.month.slice(5)}월 전체`)}${chip("per", "first", "상반기(1~15일)")}${chip("per", "second", "하반기(16일~)")}${chip("per", "prev", "지난달")}${chip("per", "week", "최근 7일")}
      <span class="fsep"></span><span class="flab">출처</span>${chip("src", "", "전체")}${chip("src", "app", "앱")}${chip("src", "sheet", "구글시트(숨김 탭 포함)")}
      <span class="fsep"></span><span class="flab">유형</span>${chip("type", "", "전체")}${ACTIVE_TYPES().map(k => chip("type", k, TYPES[k].short)).join("")}</div>
      <p class="hint" style="margin:0">기준 월은 오른쪽 위에서 바꿉니다. 구글시트 줄 ${sheetN}건 포함 — 시트의 숨김 탭까지 1시간마다 들어옵니다. 취소 건은 회차금액만 셉니다.</p></div>
    <div class="kpis">
      ${kpi("총 물류비", man(total) + "원", `${R.length}건 · 부가세 별도`)}
      ${kpi("기본운임", man(base) + "원", `${fare.length}건 입력`)}
      ${kpi("대기료", man(wait) + "원", `${R.filter(d => extraKind(d) === "wait" && +d.extra_fare).length}건`)}
      ${kpi("경유비", man(via) + "원", `${R.filter(d => extraKind(d) === "via" && +d.extra_fare).length}건`)}
      ${kpi("기타 추가 · 회차", man(etc + ret) + "원", `기타 ${man(etc)} · 회차 ${man(ret)}`)}
      ${kpi("PLT당 물류비", perPlt ? won(perPlt) + "원" : "-", `금액 있는 ${pltF.toLocaleString()} PLT 기준 · 전체 ${plt.toLocaleString()} PLT`)}
      ${kpi("운임표 대비(기본운임)", rateSum ? (rateSum - billedSum >= 0 ? "▼" : "▲") + won(Math.abs(rateSum - billedSum)) + "원" : "-", rateSum ? `운임표 있는 ${withRate.length}건 · 운임표 ${man(rateSum)} / 실제 ${man(billedSum)}` : "운임표 있는 건 없음", rateSum && rateSum < billedSum ? "alert" : "")}
      ${kpi("물류비 정확도", acc == null ? "-" : acc + "%", `${fare.length}건 중 문제 ${bad.size}건`, acc != null && acc < 95 ? "alert" : "")}
    </div>
    <div class="card"><h2>정확도 검증</h2><p class="sub">빨간 항목은 정확도 계산에 들어갑니다. 누르면 그 건만 보이고, 줄을 누르면 고칠 수 있습니다. 금액은 더한물류만 고칠 수 있으니 질문으로 남겨 주세요.</p>
      <div class="chk-grid">${checks.map(([k, l, desc, f, strictF]) => { const n = R.filter(f).length; return `<button class="chk ${n ? (strictF ? "bad" : "warn") : "ok"}" data-chk="${k}" aria-pressed="${c.check === k}"><b>${n}</b><span>${l}</span><small>${desc}</small></button>`; }).join("")}</div>
      ${sel ? `<div class="tbl-wrap" style="margin-top:12px;max-height:360px"><table class="tbl"><thead><tr><th>#</th><th>운행일</th><th>유형</th><th>구간</th><th class="r">PLT</th><th>톤</th><th>기사</th><th class="r">기본</th><th class="r">추가</th><th>사유</th><th class="r">운임표</th><th>출처</th></tr></thead><tbody>
        ${selRows.map(d => `<tr data-id="${d.id}"><td class="num">${d.id}</td><td>${dLabel(d.run_date)}</td><td>${typeTag(d.type)}</td><td>${esc(d.from_place)} → ${esc(d.to_place)}${d.via_place ? ` <span class="muted">경유 ${esc(d.via_place)}</span>` : ""}</td><td class="r num">${d.plt_qty ?? ""}</td><td>${d.vehicle_ton ?? ""}</td><td>${esc(d.driver_name || "")}</td><td class="r num">${d.base_fare != null ? won(d.base_fare) : "-"}</td><td class="r num">${+d.extra_fare ? won(d.extra_fare) : ""}</td><td>${esc(d.extra_reason || "")}</td><td class="r num">${d.rate_fare ? won(d.rate_fare) : "-"}</td><td>${d.origin === "sheet" ? "시트" : "앱"}</td></tr>`).join("") || '<tr><td colspan="12" class="muted">없음 👍</td></tr>'}</tbody></table></div>` : ""}</div>
    ${table("구간별(상차지 → 하차지)", d => `${d.from_place} → ${d.type === "delivery" ? "고객" : d.to_place}`, "구간")}
    <div class="grid2">${table("톤수별", d => d.vehicle_ton ? d.vehicle_ton + "톤" : "미기재", "톤수")}${table("PLT 구간별", d => pltBucket(d.plt_qty) + (d.plt_qty != null ? " PLT" : ""), "PLT")}</div>
    ${table("추가운임 종류별", d => ({ wait: "대기료", via: "경유비", etc: "기타(수작업 · 야간 등)", none: "추가 없음" })[extraKind(d)], "종류")}
  </div>`;
  $$("[data-ck]", v).forEach(b => b.onclick = () => { c[b.dataset.ck] = b.dataset.cv; viewCost(v); });
  $$("[data-chk]", v).forEach(b => b.onclick = () => { c.check = c.check === b.dataset.chk ? "" : b.dataset.chk; viewCost(v); });
  $$("tr[data-id]", v).forEach(tr => tr.onclick = () => openEdit(S.rowsAll.find(d => d.id === +tr.dataset.id)));
  $$("tr[data-cq]", v).forEach(tr => tr.onclick = () => { const k = tr.dataset.cq; if (!k.includes("→")) return; const [f, t] = k.split(" → "); S.tab = "ledger"; S.filter = { type: c.type, status: "", vendor: "", q: f.trim() + " " , flag: "", day: "", place: "" }; S.filter.q = t.trim(); history.replaceState(null, "", "#ledger"); render(); });
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
    ${ACTIVE_TYPES().map(tp => `<div class="h">${typeTag(tp)}</div>` + STATUS_ORDER.map(s => { const L = R.filter(d => d.type === tp && d.status === s); const re = s === "requested" ? L.filter(d => (d.events || []).some(e => TROUBLE.includes(e.kind))).length : 0; return `<div class="c num" data-go="${tp}|${s}" tabindex="0" role="button">${L.length}<small>${re ? `<span style="color:var(--bad)">재배차 필요 ${re}</span>` : sum(L) ? man(sum(L)) + "원" : (L.length ? "금액 입력 전" : "&nbsp;")}</small></div>`; }).join("")).join("")}
  </div>`;
  // 유형별 · 업체별 비용 막대
  const byType = ACTIVE_TYPES().map(tp => ({ k: tp, v: sum(R.filter(d => d.type === tp)) }));
  const maxT = Math.max(1, ...byType.map(x => x.v));
  const vendors = S.refs.vendors.map(vd => ({ vd, L: R.filter(d => d.vendor_id === vd.id) })).filter(x => x.L.length);
  const maxV = Math.max(1, ...vendors.map(x => sum(x.L)));
  const typeBars = byType.map(x => `<div class="bar-row"><span>${typeTag(x.k)}</span><div class="track"><i style="width:${x.v / maxT * 100}%;background:var(--t${Object.keys(TYPES).indexOf(x.k) + 1})"></i></div><span class="v num">${won(x.v)}원</span></div>`).join("");
  const vendorBars = vendors.map(({ vd, L }) => { const s = sum(L); return `<div class="bar-row"><span>${esc(vd.name)}</span><div class="track">${ACTIVE_TYPES().map((tp, i) => { const x = sum(L.filter(d => d.type === tp)); return x ? `<i style="width:${x / maxV * 100}%;background:var(--t${i + 1})" title="${esc(TYPES[tp].short)} ${won(x)}원"></i>` : ""; }).join("")}</div><span class="v num">${won(s)}원</span></div>`; }).join("");
  // 일별 비용
  const dim = new Date(y, m, 0).getDate();
  const days = Array.from({ length: dim }, (_, i) => `${S.month}-${String(i + 1).padStart(2, "0")}`);
  const dayVals = days.map(dd => ACTIVE_TYPES().map(tp => sum(R.filter(d => d.run_date === dd && d.type === tp))));
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
      ${kpi("운행 건수", R.length.toLocaleString() + "건", ACTIVE_TYPES().map(tp => `${TYPES[tp].short} ${R.filter(d => d.type === tp).length}`).join(" · "))}
      ${kpi("배차 대기", waiting.length + "건", "오늘·내일 운행인데 업체 입력 전", waiting.length ? "alert" : "", "waiting")}
      ${kpi("금액 미입력", noFare.length + "건", "운행했는데 청구금액이 빈 칸", noFare.length ? "alert" : "", "nofare")}
      ${kpi("운임표 초과", over.length + "건", over.length ? `초과액 ${won(over.reduce((a, d) => a + billed(d) - d.rate_fare, 0))}원` : "청구금액 = 운임표", over.length ? "alert" : "", "over")}
      ${kpi("업체 직접 등록", vendorMade.length + "건", "킹콩 요청 없이 올라온 운행 — 확인 필요", vendorMade.length ? "alert" : "", "vendor")}
      ${kpi("확인 대기", S.rowsAll.filter(d => d.status === "done").length + "건", "운행 완료 — 본사 확인 담당 '확인' 전", S.rowsAll.some(d => d.status === "done" && d.run_date < addDays(today(), -2)) ? "alert" : "", "uncheck")}
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
        <div class="legend">${ACTIVE_TYPES().map((tp, i) => `<span><i style="background:var(--t${i + 1})"></i>${TYPES[tp].label}</span>`).join("")}</div>
        <div class="cols" style="margin-top:8px">${cols}</div><div class="cols-ax">${ax}</div></div>
      <div class="card"><h2>유형별 · 업체별 비용</h2><p class="sub">청구금액(기본+추가) + 회차 금액</p>
        <div class="bars">${typeBars}</div><hr style="border:0;border-top:1px solid var(--line2);margin:14px 0">
        <div class="bars">${vendorBars || '<div class="muted">자료 없음</div>'}</div></div>
    </div>
    ${CFG.TEST_MODE ? `<div class="card" id="par-card"><h2>병행 테스트 대조 — 최근 14일</h2><p class="sub">구글시트(1시간마다)와 앱에 들어온 배차를 날짜별로 맞춰 봅니다. <b>영업일 5일 연속 일치율 100%</b>(빠진 건 0)면 시트 입력을 멈추고 앱으로 전환하는 기준입니다. 숫자를 누르면 그 건만 대장에서 봅니다.</p><div id="par-body" class="muted">계산 중…</div></div>` : ""}
    <div class="card"><h2>비용이 큰 구간</h2><p class="sub">상차지 → 하차지 · 이번 달 합계 순</p>
      <div class="tbl-wrap" style="max-height:none"><table class="tbl"><thead><tr><th>구간</th><th>유형</th><th class="r">건수</th><th class="r">합계(원)</th><th class="r">건당 평균</th></tr></thead>
      <tbody>${topLanes.map(([k, x]) => `<tr data-q="${esc(k.split(" → ")[1])}"><td>${esc(k)}</td><td>${typeTag(x.t)}</td><td class="r num">${x.n}</td><td class="r num">${won(x.s)}</td><td class="r num">${won(x.s / x.n)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">자료 없음</td></tr>`}</tbody></table></div></div>
  </div>`;
  $$("[data-flag]", v).forEach(el => el.onclick = () => { S.filter = { type: "", status: "", vendor: "", q: "", flag: el.dataset.flag }; S.tab = "ledger"; render(); });
  $$("[data-go]", v).forEach(el => el.onclick = () => { const [tp, st] = el.dataset.go.split("|"); S.filter = { type: tp, status: st, vendor: "", q: "", flag: "" }; S.tab = "ledger"; render(); });
  if (CFG.TEST_MODE) drawParallel(v);
  $$(".feed li[data-id]", v).forEach(el => el.onclick = () => { const d = S.rowsAll.find(x => x.id === +el.dataset.id); if (d) openEdit(d); });
  $$("tr[data-q]", v).forEach(el => el.onclick = () => { S.filter = { type: "", status: "", vendor: "", q: el.dataset.q, flag: "" }; S.tab = "ledger"; render(); });
}

// ---------------- 배차 요청 등록 ----------------
function placeOptions(kinds) { return S.refs.places.filter(p => p.active && (!kinds || kinds.includes(p.kind))).map(p => `<option value="${esc(p.name)}">`).join(""); }
function vendorOptions(type, sel) { return `<option value="">업체 미지정(맡을 수 있는 업체 모두에게 보임)</option>` + S.refs.vendors.filter(v => v.active && v.types.includes(type)).map(v => `<option value="${v.id}" ${v.id === sel ? "selected" : ""}>${esc(v.name)}</option>`).join(""); }
function viewNew(v) {
  if (!ACTIVE_TYPES().includes(S.newType)) S.newType = "coupang";
  const t = S.newType;
  const tomorrow = addDays(today(), 1);
  const common = `
    <div class="fields">
      <div class="field"><label for="n-date">운행일</label><input id="n-date" type="date" value="${tomorrow}" required></div>
      ${t !== "delivery" ? `<div class="field"><label for="n-slot">시간대</label><select id="n-slot"><option value="">-</option>${SLOTS.map(s => `<option>${s}</option>`).join("")}</select></div>` : ""}
      <div class="field"><label for="n-vendor">업체</label><select id="n-vendor">${vendorOptions(t, S.refs.vendors.find(x => x.types.includes(t))?.id)}</select></div>
      <div class="field"><label for="n-org" title="배차(차량 등록)되면 이 그룹에 알림">발주처</label><select id="n-org">${ORDERERS.map(o => `<option ${o === (S.user.org || "킹콩본사") ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></div>
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
      <div class="field"><label for="n-from">상차지</label><input id="n-from" list="dl-all" ${PHASE < 2 && !SHOW_ALL ? `value="${esc(PILOT_FROM)}"` : 'placeholder="인천 11번가"'} required></div>
      <div class="field"><label for="n-to">하차지${PHASE < 2 && !SHOW_ALL ? " (매장)" : ""}</label><input id="n-to" list="${PHASE < 2 && !SHOW_ALL ? "dl-store" : "dl-all"}" placeholder="${PHASE < 2 && !SHOW_ALL ? "이천점" : "진천센터"}" required></div>
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
    ${quickCardHtml()}
    ${importCardHtml()}
    <p class="sec-t" style="margin:6px 0 -4px">또는 직접 입력</p>
    <div class="types" role="group" aria-label="요청 유형">${ACTIVE_TYPES().map(k => [k, TYPES[k]]).map(([k, x]) => `<button class="type-card" data-t="${k}" aria-pressed="${k === t}"><b>${typeTag(k)} ${esc(x.label)}</b><span>${esc(x.desc)}</span></button>`).join("")}</div>
    <form class="card" id="nf"><h2>${esc(TYPES[t].label)} 배차 요청</h2><p class="sub">킹콩이 채우는 칸만 있습니다. 기사 · 차량 · 금액은 업체가 휴대폰으로 채웁니다.</p>
      <div class="grid">${body}</div>
      <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn primary" type="submit">요청 등록</button></div></form>
    <datalist id="dl-fc">${placeOptions(["쿠팡FC"])}</datalist><datalist id="dl-all">${placeOptions()}</datalist><datalist id="dl-store">${placeOptions(["매장"])}</datalist><datalist id="dl-to">${placeOptions(["센터", "매장"])}</datalist>
  </div>`;
  $$(".type-card", v).forEach(b => b.onclick = () => { S.newType = b.dataset.t; viewNew(v); });
  bindImport(v); bindQuick(v);
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
    const base = { type: t, status: "requested", origin: "kingkong", orderer: $("#n-org")?.value || S.user.org || "킹콩본사", run_date: $("#n-date").value, time_slot: $("#n-slot")?.value || "", vendor_id: $("#n-vendor").value || null, requested_by: S.user.name || S.user.email, temp: "상온", extra_fare: 0 };
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

// ---------------- 통합 대장 — 고정 필터칩 · 표/보드 · Shift 범위 선택 · 일괄 작업줄 ----------------
// 날짜칩(오늘 · 내일 · 이번 주)은 기준 월과 상관없이 받아 둔 전체(앞뒤 달 포함)에서 찾는다
function filtered() {
  const f = S.filter, t = today();
  const wide = f.flag === "question" || f.day || f.date;
  return (wide ? S.rowsAll : S.rows).filter(d => {
    if (f.day === "today" && d.run_date !== t) return false;
    if (f.day === "tomorrow" && d.run_date !== addDays(t, 1)) return false;
    if (f.day === "week" && !(d.run_date >= t && d.run_date <= addDays(t, 6))) return false;
    if (f.type && d.type !== f.type) return false;
    if (f.status && d.status !== f.status) return false;
    if (f.place && d.from_place !== f.place && d.to_place !== f.place) return false;
    if (f.vendor && (f.vendor === "none" ? d.vendor_id : d.vendor_id !== f.vendor)) return false;
    if (f.flag === "waiting" && !(d.status === "requested" && d.run_date <= addDays(t, 1))) return false;
    if (f.flag === "unassigned" && d.status !== "requested") return false;
    if (f.flag === "nofare" && !(["assigned", "done"].includes(d.status) && !d.base_fare && d.run_date < t)) return false;
    if (f.flag === "over" && !(d.rate_fare && d.base_fare && billed(d) > d.rate_fare)) return false;
    if (f.flag === "vendor" && !(d.origin === "vendor" && d.status === "done")) return false;
    if (f.flag === "trouble" && !(d.events || []).some(e => TROUBLE.includes(e.kind))) return false;
    if (f.flag === "store" && d.origin !== "store") return false;
    if (f.flag === "mine" && !(d.requested_by && [S.user.name, S.user.email].filter(Boolean).some(x => d.requested_by === x || d.requested_by.includes(x)))) return false;
    if (f.org && (d.orderer || "킹콩본사") !== f.org) return false;
    if (f.flag === "question" && !qState(d)) return false;
    if (f.flag === "qwait" && qState(d) !== "waiting") return false;
    if (f.flag === "uncheck" && d.status !== "done") return false;
    if (f.date && d.run_date !== f.date) return false;
    if (f.flag === "sheetonly" && d.origin !== "sheet") return false;
    if (f.flag === "apponly" && !(!d.sheet_key && d.status !== "canceled" && d.origin !== "sheet")) return false;
    if (f.flag === "matched" && !(d.sheet_key && d.origin !== "sheet")) return false;
    if (!f.status && !f.flag && d.status === "canceled" && S.hideCanceled) return false;
    if (f.q) { const s = [d.id, d.from_place, d.to_place, d.driver_name, d.vehicle_no, d.ref_code, d.group_no, d.category, d.via_place, d.cargo_note, d.delivery?.customer_name, d.delivery?.address, d.delivery?.product].join(" "); if (!s.includes(f.q.replace(/^#/, ""))) return false; }
    return true;
  });
}
S.sel = new Set(); S.view = "table"; S.hideCanceled = false;
function viewLedger(v) {
  const f = S.filter;
  const flagNames = { waiting: "배차 대기(오늘·내일)", unassigned: "미배차 전체", nofare: "금액 미입력", over: "운임표 초과", vendor: "업체 직접 등록", trouble: "취소 · 회차", store: "매장 요청", question: "질문 있는 건", qwait: "답변 대기", uncheck: "확인 대기", sheetonly: "시트에만 있음", apponly: "앱에만 있음", matched: "시트 · 앱 일치" };
  const chip = (key, val, label, extra = "") => `<button type="button" class="fchip ${extra}" data-fk="${key}" data-fv="${val}" aria-pressed="${(f[key] || "") === val && val !== ""}">${label}</button>`;
  const places = [...new Set(S.rowsAll.flatMap(d => [d.from_place, d.type === "delivery" ? null : d.to_place]).filter(p => p && S.refs.places.some(x => x.name === p && x.kind === "매장")))].sort();
  v.innerHTML = `<div class="grid">
    <div class="card fbar">
      <div class="frow"><span class="flab">날짜</span>${chip("day", "today", "오늘")}${chip("day", "tomorrow", "내일")}${chip("day", "week", "7일")}${chip("day", "", `${+S.month.slice(5)}월 전체`, f.day ? "" : "on")}
        <span class="fsep"></span><span class="flab">상태</span>${chip("flag", "unassigned", "미배차")}${chip("flag", "qwait", "답변 대기")}${chip("flag", "trouble", "취소·회차")}${chip("flag", "mine", "내 요청")}${chip("flag", "store", "센터·매장 요청")}${chip("flag", "nofare", "금액 미입력")}${chip("flag", "uncheck", "확인 대기")}
        ${f.flag && !["unassigned", "qwait", "trouble", "store", "mine", "nofare", "uncheck"].includes(f.flag) ? `<button class="fchip" aria-pressed="true" id="f-clear">✕ ${flagNames[f.flag]}${f.date ? " · " + dLabel(f.date) : ""}</button>` : ""}</div>
      <div class="frow"><span class="flab">유형</span>${ACTIVE_TYPES().map(k => [k, TYPES[k]]).map(([k, x]) => chip("type", k, x.short, "t-" + k)).join("")}
        <span class="fsep"></span><select id="f-st" aria-label="상태"><option value="">상태 전체</option>${Object.entries(STATUS).map(([k, x]) => `<option value="${k}" ${f.status === k ? "selected" : ""}>${x}</option>`).join("")}</select>
        <select id="f-org" aria-label="발주처"><option value="">발주처 전체</option>${ORDERERS.map(o => `<option ${f.org === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>
        <select id="f-pl" aria-label="매장"><option value="">매장 전체</option>${places.map(p => `<option ${f.place === p ? "selected" : ""}>${esc(p)}</option>`).join("")}</select>
        <input id="f-q" type="search" value="${esc(f.q || "")}" placeholder="검색: #번호 · 지점 · 기사 · 차량 · 고객 · 그룹넘버" aria-label="검색">
        <span class="sp"></span><div class="seg2" role="group" aria-label="보기"><button data-view="table" aria-pressed="${S.view === "table"}">표</button><button data-view="board" aria-pressed="${S.view === "board"}">보드</button></div>
        <button class="btn sm" id="f-reset">필터 초기화</button><button class="btn sm primary" id="f-xlsx" title="구글시트(킹콩_쿠팡배차내역)와 같은 양식">엑셀(시트 양식)</button><button class="btn sm" id="f-csv">CSV</button></div>
    </div>
    <div id="tbl"></div>
  </div>
  <div class="bulkbar" id="bulkbar" hidden><b id="bk-n"></b><button class="btn sm" data-bk="done">운행 완료</button><button class="btn sm" data-bk="kakao">카톡 요청 문구</button><button class="btn sm" data-bk="ask">질문 한꺼번에</button><button class="btn sm danger" data-bk="canceled">취소</button>${S.user?.can_delete ? `<button class="btn sm danger" data-bk="delete">삭제</button>` : ""}<button class="btn sm ghost" data-bk="clear">선택 해제</button></div>`;
  let lastIdx = null;
  const syncBar = () => { const n = S.sel.size; const bar = $("#bulkbar"); bar.hidden = !n; $("#bk-n").textContent = `${n}건 선택`; const all = $("#ck-all"); if (all) { const L = filtered(); all.checked = L.length > 0 && L.every(d => S.sel.has(d.id)); all.indeterminate = !all.checked && L.some(d => S.sel.has(d.id)); } };
  const draw = () => {
    const L = filtered();
    S.sel.forEach(id => { if (!L.some(d => d.id === id)) S.sel.delete(id); });
    const tot = L.reduce((a, d) => a + (d.status === "canceled" ? 0 : billed(d)), 0), ret = L.reduce((a, d) => a + (+d.return_fare || 0), 0);
    const head = `<div class="row" style="justify-content:space-between;margin:0 0 8px"><span class="muted">${L.length}건 · 청구 ${won(tot)}원${ret ? ` · 회차 ${won(ret)}원` : ""}${f.day ? ` · ${f.day === "today" ? "오늘" : f.day === "tomorrow" ? "내일" : "7일"} 운행` : ""}</span><span class="hint">줄을 누르면 상세 · 체크박스는 Shift 를 누른 채 누르면 범위 선택</span></div>`;
    if (!L.length) { $("#tbl").innerHTML = `<div class="card empty">조건에 맞는 배차가 없습니다</div>`; syncBar(); return; }
    if (S.view === "board") {
      const cols = ["requested", "assigned", "done", "checked", "confirmed"];
      $("#tbl").innerHTML = head + `<div class="kanban">${cols.map(st => { const X = L.filter(d => d.status === st); return `<section class="kcol"><header>${stTag(st)}<b class="num">${X.length}</b></header>${X.slice(0, 120).map(d => `
        <article class="kcard t-${d.type}${S.sel.has(d.id) ? " sel" : ""}" data-id="${d.id}" tabindex="0"><div class="row" style="justify-content:space-between;gap:6px"><span class="row" style="gap:4px">${typeTag(d.type)}${evBadges(d)}${qBadge(d)}</span><input type="checkbox" class="ck" value="${d.id}" ${S.sel.has(d.id) ? "checked" : ""} aria-label="선택"></div>
          <div class="kroute">${esc(d.from_place)} → ${esc(d.type === "delivery" ? "고객" : d.to_place)}</div>
          <div class="kmeta">${dLabel(d.run_date)}${d.time_slot ? " " + esc(d.time_slot) : ""}${d.plt_qty != null ? ` · ${d.plt_qty}PLT` : ""}${d.temp && d.temp !== "상온" ? " · " + esc(d.temp) : ""}${d.driver_name ? ` · <b>${esc(d.driver_name)}</b>` : ""}${d.base_fare ? ` · ${won(billed(d))}원` : ""}</div></article>`).join("")}${X.length > 120 ? `<p class="muted">외 ${X.length - 120}건 — 필터로 좁혀 주세요</p>` : ""}</section>`; }).join("")}</div>`;
    } else {
      $("#tbl").innerHTML = head + `<div class="tbl-wrap"><table class="tbl"><thead><tr><th><input type="checkbox" id="ck-all" aria-label="보이는 줄 모두 선택"></th><th>운행일</th><th>유형</th><th>상태</th><th>상차지</th><th>하차지</th><th class="r">PLT</th><th>기사</th><th>차량</th><th class="r">톤</th><th class="r">기본</th><th class="r">추가</th><th class="r">청구</th><th class="r">운임표 차액</th><th>비고 · 질문</th><th>최종 수정</th></tr></thead>
      <tbody>${L.map((d, i) => { const df = d.rate_fare && d.base_fare ? billed(d) - d.rate_fare : null; return `<tr data-id="${d.id}" data-i="${i}" class="${S.sel.has(d.id) ? "sel" : ""} st-${d.status}">
        <td class="ckc"><input type="checkbox" class="ck" value="${d.id}" ${S.sel.has(d.id) ? "checked" : ""} aria-label="선택"></td>
        <td class="num">${dLabel(d.run_date)}${d.time_slot ? ` <span class="muted">${esc(d.time_slot)}</span>` : ""}</td><td>${typeTag(d.type)}</td><td>${stTag(d.status)}${d.origin === "vendor" ? '<span class="flag">업체 등록</span>' : d.origin === "store" ? `<span class="flag st-flag">${esc(d.orderer || "매장")} 요청</span>` : d.origin === "sheet" ? '<span class="flag sh-flag" title="구글시트에서 1시간마다 가져온 줄 — 시트에서 고치세요">시트</span>' : ""}${evBadges(d)}</td>
        <td>${esc(d.from_place)}${d.orderer && d.orderer !== "킹콩본사" && d.origin !== "store" ? `<div class="kmeta">발주 ${esc(d.orderer)}</div>` : ""}</td><td>${esc(d.type === "delivery" ? (d.delivery?.address || "고객") : d.to_place)}</td><td class="r num">${d.plt_qty ?? ""}${d.temp && d.temp !== "상온" ? ` <span class="muted">${esc(d.temp)}</span>` : ""}</td>
        <td>${esc(d.driver_name || "")}</td><td class="num">${esc(d.vehicle_no || "")}</td><td class="r num">${d.vehicle_ton ?? ""}${d.vehicle_body ? `<span class="muted"> ${esc(d.vehicle_body)}</span>` : ""}</td>
        <td class="r num">${won(d.base_fare)}</td><td class="r num">${d.extra_fare ? won(d.extra_fare) : ""}</td><td class="r num"><b>${d.base_fare ? won(billed(d)) : ""}</b></td>
        <td class="r num ${df > 0 ? "diff-up" : ""}">${df == null ? "" : (df > 0 ? "▲" : df < 0 ? "▼" : "") + won(Math.abs(df))}</td><td class="memo" onclick="event.stopPropagation()"><div class="memo-in">${qBadge(d)}<span class="muted">${esc((d.comments || []).slice(-1)[0]?.body || d.extra_reason || d.cargo_note || d.delivery?.product || "")}</span></div><button class="btn sm ghost ask" data-ask="${d.id}" title="이 건에 대해 더한물류에 질문">질문</button></td>
        <td class="num muted" title="${esc(d.updated_by || "")}">${fmtSec(d.updated_at)}<br>${esc(whoLabel(d.updated_by || ""))}</td></tr>`; }).join("")}</tbody>
      <tfoot><tr><td colspan="12">합계 ${L.length}건</td><td class="r num">${won(tot)}</td><td colspan="3"></td></tr></tfoot></table></div>`;
    }
    const open = id => openEdit(S.rowsAll.find(d => d.id === id));
    $$("#tbl tbody tr, #tbl .kcard").forEach(el => { el.onclick = e => { if (e.target.closest(".ck,.ckc,.memo")) return; open(+el.dataset.id); }; el.onkeydown = e => { if (e.key === "Enter") open(+el.dataset.id); }; });
    $$("[data-ask]").forEach(b => b.onclick = () => askQuestion(S.rowsAll.find(d => d.id === +b.dataset.ask), b));
    const ckList = $$("#tbl .ck");
    ckList.forEach((c, i) => c.onclick = e => {
      e.stopPropagation();
      if (e.shiftKey && lastIdx != null) { const [a, b] = [Math.min(lastIdx, i), Math.max(lastIdx, i)]; ckList.slice(a, b + 1).forEach(x => { x.checked = c.checked; c.checked ? S.sel.add(+x.value) : S.sel.delete(+x.value); x.closest("tr,.kcard")?.classList.toggle("sel", c.checked); }); }
      else { c.checked ? S.sel.add(+c.value) : S.sel.delete(+c.value); c.closest("tr,.kcard")?.classList.toggle("sel", c.checked); }
      lastIdx = i; syncBar();
    });
    $$("#tbl .ckc").forEach(td => td.onclick = e => { if (e.target === td) td.querySelector(".ck").click(); });
    const all = $("#ck-all"); if (all) all.onchange = () => { L.forEach(d => all.checked ? S.sel.add(d.id) : S.sel.delete(d.id)); draw(); };
    syncBar();
  };
  // 일괄 작업 — 화면부터 바꾸고(즉시 반영), 저장이 실패하면 되돌린다
  $$("[data-bk]").forEach(b => b.onclick = async () => {
    const ids = [...S.sel], sel = S.rowsAll.filter(d => ids.includes(d.id)), k = b.dataset.bk;
    if (k === "clear") { S.sel.clear(); draw(); return; }
    if (k === "kakao") return shareText(kakaoReqText(sel));
    if (k === "delete") return confirmDelete(sel, async () => { S.sel.clear(); await reload(true); });
    if (k === "ask") { const body = prompt(`${ids.length}건에 같은 질문을 남깁니다`); if (!body) return; for (const d of sel) { (d.comments ||= []).push({ id: Date.now() + d.id, at: new Date().toISOString(), author: S.user.email, kind: "question", body }); } draw();
      try { for (const id of ids) await Admin.comment(id, body); toast(`${ids.length}건에 질문을 남겼습니다`); } catch (e) { toast("저장 실패 — 되돌립니다: " + e.message); } await reload(true); return; }
    const locked = sel.filter(d => d.status === "confirmed"); if (locked.length) return toast(`정산 확정된 ${locked.length}건이 섞여 있어요 — 빼고 다시 골라 주세요`);
    if (k === "canceled" && !confirm(`${ids.length}건을 취소할까요?`)) return;
    if (k === "done") { const nf = sel.filter(d => !d.driver_name); if (nf.length && !confirm(`기사가 없는 ${nf.length}건이 있습니다. 그래도 운행 완료로 바꿀까요?`)) return; }
    const before = sel.map(d => [d, d.status]); sel.forEach(d => { d.status = k; }); S.sel.clear(); draw(); toast(`${ids.length}건 → ${STATUS[k]}`);
    try { await Admin.setStatus(ids, k, S.user.email); await reload(true); }
    catch (e) { before.forEach(([d, st]) => { d.status = st; }); draw(); toast("저장 실패 — 되돌렸습니다: " + e.message); }
  });
  $$("[data-fk]", v).forEach(b => b.onclick = () => { const k = b.dataset.fk, val = b.dataset.fv; f[k] = (f[k] || "") === val ? "" : val; S.sel.clear(); viewLedger(v); });
  $$("[data-view]", v).forEach(b => b.onclick = () => { S.view = b.dataset.view; if (S.view === "board" && !f.day) f.day = "week"; viewLedger(v); });
  $("#f-st").onchange = e => { f.status = e.target.value; draw(); };
  $("#f-pl").onchange = e => { f.place = e.target.value; draw(); };
  $("#f-org").onchange = e => { f.org = e.target.value; draw(); };
  $("#f-q").oninput = e => { f.q = e.target.value.trim(); draw(); };
  const fc = $("#f-clear"); if (fc) fc.onclick = () => { f.flag = ""; f.date = ""; viewLedger(v); };
  $("#f-reset").onclick = () => { S.filter = { type: "", status: "", vendor: "", q: "", flag: "", day: "", place: "" }; S.sel.clear(); viewLedger(v); };
  $("#f-csv").onclick = () => downloadCsv(filtered(), `통합대장_${S.month}.csv`);
  $("#f-xlsx").onclick = e => exportSheetXlsx(filtered(), `통합대장_${S.month}`, `${S.month.replace("-", ".")} 통합 대장`, e.currentTarget);
  draw();
}
// ---------------- 삭제 확인 배너 — 삭제 권한자만, 사유 + 확인 체크가 있어야 지워짐(휴지통으로) ----------------
function confirmDelete(rows, after) {
  if (!S.user?.can_delete) return toast("삭제 권한이 없습니다 — 설정 › 삭제 권한자");
  const lock = rows.filter(d => d.status === "confirmed"); if (lock.length) return toast(`정산 확정된 ${lock.length}건은 삭제할 수 없습니다`);
  const el = document.createElement("div"); el.className = "del-wrap"; el.setAttribute("role", "alertdialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "del-t");
  const fare = rows.filter(d => d.base_fare).length;
  el.innerHTML = `<div class="del-box">
    <div class="del-banner"><span class="del-ic" aria-hidden="true">!</span><div><b id="del-t">${rows.length}건을 통합 대장에서 삭제합니다</b><span>업체 · 매장 · 확인 담당자 화면에서도 사라집니다. 삭제한 건은 <b>설정 › 휴지통</b>에서 되살릴 수 있고, 누가 언제 왜 지웠는지 수정 기록에 남습니다.</span></div></div>
    ${fare ? `<div class="warn-box" style="margin:12px 16px 0">이 중 <b>${fare}건은 더한물류가 금액까지 넣은 건</b>입니다. 운행한 건이면 삭제 대신 '취소'나 질문으로 처리해 주세요.</div>` : ""}
    <div class="del-list"><table class="tbl"><thead><tr><th>#</th><th>운행일</th><th>구간</th><th>상태</th><th>기사</th><th class="r">금액</th></tr></thead><tbody>
      ${rows.map(d => `<tr><td class="num">${d.id}</td><td>${dLabel(d.run_date)}</td><td>${typeTag(d.type)} ${esc(d.from_place)} → ${esc(d.type === "delivery" ? (d.delivery?.customer_name || "고객") : d.to_place)}${d.plt_qty != null ? ` · ${d.plt_qty}PLT` : ""}</td><td>${stTag(d.status)}</td><td>${esc(d.driver_name || "")}</td><td class="r num">${d.base_fare ? won(billed(d)) : "-"}</td></tr>`).join("")}</tbody></table></div>
    <div class="del-form"><p class="sec-t">삭제 사유 (필수)</p><div class="chips">${["중복 등록", "잘못 입력", "요청 취소(배차 전)", "테스트 데이터"].map(x => `<button type="button" data-r="${x}">${x}</button>`).join("")}</div>
      <input id="del-r" placeholder="사유를 고르거나 직접 쓰세요" aria-label="삭제 사유">
      <label class="del-ck"><input type="checkbox" id="del-ok"> 위 <b>${rows.length}건</b>을 삭제하는 것이 맞습니다</label></div>
    <div class="del-foot"><button class="btn" id="del-no">취소</button><button class="btn danger-fill" id="del-go" disabled>${rows.length}건 삭제</button></div></div>`;
  document.body.appendChild(el);
  const r = $("#del-r", el), ok = $("#del-ok", el), go = $("#del-go", el), close = () => { el.remove(); document.removeEventListener("keydown", esc2); };
  const upd = () => { go.disabled = !(ok.checked && r.value.trim()); };
  const esc2 = e => { if (e.key === "Escape") close(); }; document.addEventListener("keydown", esc2);
  $$("[data-r]", el).forEach(b => b.onclick = () => { r.value = b.dataset.r; $$("[data-r]", el).forEach(x => x.setAttribute("aria-pressed", x === b)); upd(); });
  r.oninput = upd; ok.onchange = upd; $("#del-no", el).onclick = close; el.onclick = e => { if (e.target === el) close(); };
  $("#del-no", el).focus();
  go.onclick = async () => { go.disabled = true;
    try { const ids = rows.map(d => d.id); const n = await Admin.remove(ids, r.value.trim(), S.user.email); close();
      actionToast(`${n}건 삭제했습니다(휴지통)`, "되돌리기", async () => { await Admin.restore(ids, S.user.email); toast("되살렸습니다"); await reload(true); }); await after?.(); }
    catch (e) { go.disabled = false; toast("삭제 실패: " + e.message); } };
}

// ---------------- 엑셀 내려받기 — 구글시트 「킹콩_쿠팡배차내역」과 같은 양식(색 · 칸 · 수식 · 합계) ----------------
let excelLib = null;
async function loadExcel() {
  if (window.ExcelJS) return window.ExcelJS;
  excelLib ||= new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js"; s.onload = () => ok(window.ExcelJS); s.onerror = () => { excelLib = null; no(new Error("엑셀 도구를 불러오지 못했습니다(인터넷 확인)")); }; document.head.appendChild(s); });
  return excelLib;
}
const XL = { blue: "FFD0E2F3", blueH: "FFF3FEFF", gray: "FFCCCCCC", pink: "FFFFEFED", ret: "FFF3F3F3", red: "FFFF0000", font: "Malgun Gothic" };
const XL_DATE = 'yyyy"년 "mmmm" "d"일 "dddd';
const XL_DIFF = '[BLUE]▼#,##0;[RED]▲#,##0;[BLACK]#,##-';
function xlDate(s) { if (!s) return null; const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function sheetLayout(ws, L, title) {
  const thin = { style: "thin", color: { argb: "FF000000" } }, box = { top: thin, left: thin, bottom: thin, right: thin };
  const fill = c => c ? { type: "pattern", pattern: "solid", fgColor: { argb: c } } : undefined;
  const W = [21.63, 5.88, 15.5, 18.75, 8.25, 9.38, 31.63, 15.13, 13.88, 8.88, 15.13, 13, 61, 17.63, 15.13, 13, 3.88, 6.38, 21.38, 11.38, 13, 15.13];
  ws.columns = W.map(w => ({ width: w }));
  ws.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  // 1줄: 입력 구역 안내
  ws.getRow(1).height = 37.5;
  [["A1:F1", "킹콩 입력 (하늘색칸만 입력)", XL.blueH], ["G1", "회색칸 수정금지", XL.gray], ["H1:M1", "더한물류 입력 (분홍색칸만 입력)", XL.pink], ["N1:P1", "회색칸 수정금지", XL.gray], ["R1:V1", "회차기사", XL.ret]].forEach(([rg, t, c]) => {
    if (rg.includes(":")) ws.mergeCells(rg); const cell = ws.getCell(rg.split(":")[0]); cell.value = t;
    cell.font = { name: XL.font, size: rg === "R1:V1" ? 12 : 13, bold: true, color: { argb: XL.red } }; cell.fill = fill(c); cell.alignment = { horizontal: "center", vertical: "middle" }; cell.border = box; });
  // 2줄: 머리글
  const H = ["운행일자", "NO.", "상차지", "하차지", "PLT수량", "CATE", "상차지_하차지_PLT수량", "기사이름", "차량번호", "차량톤수", "기본운임", "추가운임", "추가운임내용", "청구금액", "운임표", "차액", "", "NO.", "회차일자", "상차지", "기사이름", "회차금액"];
  const hc = i => i < 6 ? XL.blueH : i === 6 || (i >= 13 && i <= 15) ? XL.gray : i >= 7 && i <= 12 ? XL.pink : i >= 17 ? XL.ret : null;
  const r2 = ws.getRow(2); r2.height = 26.25;
  H.forEach((t, i) => { if (!t) return; const c = r2.getCell(i + 1); c.value = t; c.font = { name: XL.font, size: 11, bold: i < 17 }; c.fill = fill(hc(i)); c.alignment = { horizontal: "center", vertical: "middle" }; c.border = box; });
  // 3줄~: 데이터
  L.forEach((d, k) => {
    const r = 3 + k, row = ws.getRow(r); row.height = 18.75;
    const to = d.type === "delivery" ? (d.delivery?.customer_name ? d.delivery.customer_name + " 고객" : "고객") : d.to_place;
    const bill = d.base_fare ? billed(d) : 0, rate = d.rate_fare != null && d.rate_fare !== "" ? +d.rate_fare : null;
    const v = [xlDate(d.run_date), k + 1, d.from_place || "", to || "", d.plt_qty ?? null, d.category || "",
      { formula: `$C${r}&"_"&$D${r}&"_"&$E${r}&"PLT"`, result: `${d.from_place}_${to}_${d.plt_qty ?? ""}PLT` },
      d.driver_name || null, d.vehicle_no || null, d.vehicle_ton ? `${d.vehicle_ton}톤${d.vehicle_body ? " " + d.vehicle_body : ""}` : null, d.base_fare ?? null, d.extra_fare || null,
      [d.extra_reason, d.status === "canceled" ? "취소" : "", (d.events || []).filter(e => e.kind === "return").length ? "회차" : "", d.cargo_note].filter(Boolean).join(" / ") || null,
      { formula: `K${r}+L${r}`, result: bill }, rate, { formula: `O${r}-N${r}`, result: (rate || 0) - bill }, null,
      k + 1, xlDate(d.return_date), d.return_from || null, d.return_driver || null, d.return_fare ?? null];
    v.forEach((x, i) => { if (i === 16) return; const c = row.getCell(i + 1); c.value = x; c.border = box; c.alignment = { horizontal: i >= 13 && i <= 15 ? "right" : i === 6 ? "left" : "center", vertical: "middle" };
      c.font = { name: XL.font, size: i < 6 ? 11 : 10, bold: i === 15 };
      const f = i < 6 ? XL.blue : i === 6 || (i >= 13 && i <= 15) ? XL.gray : i === 12 ? XL.pink : null; if (f) c.fill = fill(f);
      if (i === 0 || i === 18) c.numFmt = XL_DATE; if ([4, 10, 11, 13, 14, 21].includes(i)) c.numFmt = "#,##0"; if (i === 15) c.numFmt = XL_DIFF; if (i === 2 || i === 3 || i === 5 || i === 6 || i === 12) c.numFmt = "@"; });
  });
  // 합계(시트 아래 칸과 같은 자리)
  const last = 2 + L.length, f0 = last + 1;
  const sum = (col) => L.length ? `SUM($${col}$3:$${col}$${last})` : "0";
  const tot = L.reduce((a, d) => a + (d.base_fare ? billed(d) : 0), 0), totR = L.reduce((a, d) => a + (+d.rate_fare || 0), 0), plt = L.reduce((a, d) => a + (+d.plt_qty || 0), 0);
  const put = (addr, val, fmt) => { const c = ws.getCell(addr); c.value = val; c.font = { name: XL.font, size: 12, bold: true }; c.alignment = { horizontal: "center", vertical: "middle" }; c.border = box; if (fmt) c.numFmt = fmt; };
  ws.mergeCells(`A${f0}:H${f0 + 2}`); put(`A${f0}`, title);
  ws.getCell(`A${f0}`).font = { name: XL.font, size: 16, bold: true };
  ws.mergeCells(`I${f0}:J${f0 + 1}`); put(`I${f0}`, "배차내역"); ws.mergeCells(`K${f0}:K${f0 + 1}`); put(`K${f0}`, { formula: `COUNTA($A$3:$A$${Math.max(last, 3)})&" 건"`, result: `${L.length} 건` });
  ws.mergeCells(`I${f0 + 2}:J${f0 + 2}`); put(`I${f0 + 2}`, "출고PLT수량"); put(`K${f0 + 2}`, { formula: `${sum("E")}&" 개"`, result: `${plt} 개` });
  [["공급가액", { formula: sum("N"), result: tot }, { formula: sum("O"), result: totR }], ["세      액", { formula: `$N$${f0}*10%`, result: tot * 0.1 }, { formula: `$O$${f0}*10%`, result: totR * 0.1 }],
   ["합계금액", { formula: `SUM($N$${f0}:$N$${f0 + 1})`, result: tot * 1.1 }, { formula: `SUM($O$${f0}:$O$${f0 + 1})`, result: totR * 1.1 }]].forEach(([lab, n, o], i) => {
    const r = f0 + i; ws.mergeCells(`L${r}:M${r}`); put(`L${r}`, lab); put(`N${r}`, n, "#,##0"); put(`O${r}`, o, "#,##0"); put(`P${r}`, { formula: `$O$${r}-$N$${r}`, result: (o.result || 0) - (n.result || 0) }, XL_DIFF); ws.getRow(r).height = 26; });
  ws.autoFilter = { from: "A2", to: `P${Math.max(last, 2)}` };
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
}
async function exportSheetXlsx(L0, fname, title, btn) {
  const L = L0.filter(d => d.status !== "canceled" && !d.deleted_at).sort((a, b) => a.run_date.localeCompare(b.run_date) || a.id - b.id);
  if (!L0.length) return toast("내려받을 건이 없습니다");
  const old = btn?.textContent; if (btn) { btn.disabled = true; btn.textContent = "만드는 중…"; }
  try {
    const X = await loadExcel(); const wb = new X.Workbook(); wb.creator = "킹콩 배차"; wb.created = new Date();
    const groups = [["coupang", "쿠팡"], ["center", PHASE < 2 ? "진천센터→매장" : "센터·본사"], ["delivery", "고객배송"]].map(([t, n]) => [n, L.filter(d => d.type === t)]).filter(([, x]) => x.length);
    (groups.length ? groups : [["배차", []]]).forEach(([n, x]) => sheetLayout(wb.addWorksheet(n, { properties: { tabColor: { argb: n === "쿠팡" ? "FF3B3FD8" : n === "고객배송" ? "FFC2410C" : "FF0E7490" } } }), x, `${title} · ${n}`));
    // 마지막 탭: 앱 대장 전체 칸(상태 · 업체 · 이력 · 취소 건 포함) — 시트에 없는 정보 확인용
    const ws = wb.addWorksheet("대장 전체(앱)"); const cols = ledgerCols();
    ws.columns = cols.map(([h]) => ({ header: h, width: Math.min(40, Math.max(9, h.length * 2 + 4)) }));
    L0.slice().sort((a, b) => a.run_date.localeCompare(b.run_date) || a.id - b.id).forEach(d => ws.addRow(cols.map(([h, f]) => { const x = f(d); return h === "운행일" ? xlDate(x) : x ?? ""; })));
    ws.getRow(1).eachCell(c => { c.font = { name: XL.font, bold: true, size: 10 }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XL.gray } }; c.alignment = { horizontal: "center", vertical: "middle" }; });
    ws.eachRow((row, i) => { if (i > 1) row.eachCell(c => { c.font = { name: XL.font, size: 10 }; }); }); ws.getColumn(1).numFmt = "yyyy-mm-dd"; ws.views = [{ state: "frozen", ySplit: 1 }]; ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })); a.download = fname + ".xlsx"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`엑셀을 내려받았습니다 — ${L.length}건${L0.length - L.length ? ` (취소 ${L0.length - L.length}건은 '대장 전체' 탭에만)` : ""}`);
  } catch (e) { toast("엑셀 만들기 실패: " + e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
}
function ledgerCols() { return [["운행일", d => d.run_date], ["유형", d => TYPES[d.type].label], ["상태", d => STATUS[d.status]], ["업체", d => vName(d.vendor_id)], ["상차지", d => d.from_place], ["하차지", d => d.to_place], ["PLT", d => d.plt_qty], ["온도", d => d.temp],
    ["입차CODE", d => d.ref_code], ["그룹넘버", d => d.group_no], ["카테고리", d => d.category], ["경유", d => d.via_place], ["요청처", d => d.origin === "store" ? "센터·매장" : d.origin === "vendor" ? "업체" : "킹콩"], ["발주처", d => d.orderer || "킹콩본사"], ["요청자", d => d.requested_by],
    ["재배차", d => evOf(d, "cancel_driver").length || ""], ["회차", d => evOf(d, "return").length || ""], ["이력", d => (d.events || []).filter(e => !["request"].includes(e.kind)).map(e => `${fmtAt(e.at)} ${EVENT_KINDS[e.kind]}${e.driver_name ? " " + e.driver_name : ""}${e.reason ? "(" + e.reason + ")" : ""}`).join(" / ")], ["기사", d => d.driver_name], ["차량번호", d => d.vehicle_no], ["톤수", d => d.vehicle_ton], ["차종", d => d.vehicle_body], ["기본운임", d => d.base_fare], ["추가운임", d => d.extra_fare], ["추가 사유", d => d.extra_reason],
    ["청구금액", d => d.base_fare ? billed(d) : ""], ["운임표", d => d.rate_fare], ["회차일", d => d.return_date], ["회차 상차지", d => d.return_from], ["회차 기사", d => d.return_driver], ["회차금액", d => d.return_fare],
    ["주문자", d => d.delivery?.customer_name], ["연락처", d => d.delivery?.customer_phone], ["주소", d => d.delivery?.address], ["제품", d => d.delivery?.product], ["배송조건", d => d.delivery?.terms], ["완료 메모", d => d.delivery?.done_note], ["메모", d => d.cargo_note], ["번호", d => d.id]]; }
function downloadCsv(L, name) {
  const cols = ledgerCols();
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
    <footer>${S.user?.can_delete && d.status !== "confirmed" ? `<button class="btn danger" id="del1" style="margin-right:auto">삭제</button>` : ""}<button class="btn" id="cancel">닫기</button><button class="btn primary" id="save">저장</button></footer>`;
  document.body.append(bg, dr);
  const close = () => { bg.remove(); dr.remove(); };
  const d1 = $("#del1", dr); if (d1) d1.onclick = () => { close(); confirmDelete([d], () => reload(true)); };
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
  const R = S.rows.filter(d => ["done", "checked", "confirmed"].includes(d.status) || (d.status === "canceled" && +d.return_fare > 0));   // 운행 안 했어도 회차비는 정산
  const conf = await Admin.settlements(S.month).catch(() => []);
  const vendors = S.refs.vendors.filter(x => R.some(d => d.vendor_id === x.id));
  const card = vd => {
    const L = R.filter(d => d.vendor_id === vd.id);
    const sum = L.reduce((a, d) => a + cost(d), 0);
    const missing = L.filter(d => !d.base_fare && d.status !== "canceled").length;
    const unchecked = L.filter(d => d.status === "done").length;
    const testLock = !!CFG.TEST_MODE;
    const trb = L.filter(d => (d.events || []).some(e => TROUBLE.includes(e.kind))), retSum = L.reduce((a, d) => a + (+d.return_fare || 0), 0);
    const over = L.filter(d => d.rate_fare && d.base_fare && billed(d) > d.rate_fare);
    const vm = L.filter(d => d.origin === "vendor").length;
    const done = conf.find(s => s.vendor_id === vd.id);
    const byType = ACTIVE_TYPES().map(tp => { const X = L.filter(d => d.type === tp); return X.length ? `<tr><td>${typeTag(tp)}</td><td class="r num">${X.length}</td><td class="r num">${won(X.reduce((a, d) => a + cost(d), 0))}</td></tr>` : ""; }).join("");
    return `<div class="card"><div class="row" style="justify-content:space-between"><h2>${esc(vd.name)}</h2>${done ? `<span class="st confirmed">정산 확정 ${esc(String(done.confirmed_at).slice(0, 10))}</span>` : `<span class="st done">확정 전</span>`}</div>
      <p class="sub">${+S.month.slice(5)}월 운행 완료 ${L.length}건</p>
      <div class="kpis" style="grid-template-columns:repeat(3,1fr)"><div class="kpi"><div class="l">공급가액</div><div class="v num">${won(sum)}</div></div><div class="kpi"><div class="l">세액 10%</div><div class="v num">${won(sum * 0.1)}</div></div><div class="kpi"><div class="l">합계금액</div><div class="v num">${won(sum * 1.1)}</div></div></div>
      <div class="tbl-wrap" style="margin-top:12px;max-height:none"><table class="tbl"><thead><tr><th>유형</th><th class="r">건수</th><th class="r">금액(원)</th></tr></thead><tbody>${byType}</tbody></table></div>
      <ul class="alerts" style="padding-left:18px;font-size:13.5px">
        ${missing ? `<li style="color:var(--bad)">금액이 빈 운행 ${missing}건 — 더한물류 입력 필요</li>` : ""}
        ${unchecked ? `<li style="color:var(--bad)">본사 확인 전 ${unchecked}건 — 확인 담당자가 '확인'해야 확정할 수 있음</li>` : ""}
        ${L.some(d => qState(d) === "waiting") ? `<li style="color:var(--warn)">답변 대기 질문 ${L.filter(d => qState(d) === "waiting").length}건 — 확정 전에 확인</li>` : ""}
        ${over.length ? `<li style="color:var(--warn)">운임표보다 비싼 청구 ${over.length}건 · ${won(over.reduce((a, d) => a + billed(d) - d.rate_fare, 0))}원 — 사유 확인</li>` : ""}
        ${vm ? `<li>업체가 직접 올린 운행 ${vm}건 포함</li>` : ""}
        ${trb.length ? `<li>취소 · 회차가 있었던 건 ${trb.length}건${retSum ? ` · 회차비 ${won(retSum)}원 포함` : ""}</li>` : ""}
        ${!missing && !over.length ? `<li style="color:var(--good)">검증 문제 없음</li>` : ""}
      </ul>
      <div class="row" style="justify-content:flex-end"><button class="btn sm" data-xlsx="${vd.id}">운행내역서 엑셀</button><button class="btn sm" data-csv="${vd.id}">CSV</button><button class="btn primary sm" data-conf="${vd.id}" ${testLock ? `disabled title="테스트 기간에는 정산 확정을 잠가 둡니다 — 실제 정산은 기존 방식으로"` : missing || unchecked ? `disabled title="${missing ? "금액이 빈 건" : "본사 확인 전 건"}을 먼저 처리해 주세요"` : ""}>${done ? "다시 확정" : "정산 확정"}</button></div></div>`;
  };
  v.innerHTML = `<div class="grid"><div class="card"><h2>${S.month.replace("-", "년 ")}월 정산</h2><p class="sub">운행 완료 → 본사 확인 → 정산 확정 순서입니다. 운행 완료 · 확인 · 정산 확정 건만 셉니다(청구금액 = 기본 + 추가, 회차 포함). 확정하면 그 건은 업체가 고칠 수 없습니다.</p></div>
    ${CFG.TEST_MODE ? `<div class="warn-box"><b>테스트 운영 기간</b> — 정산 확정 버튼은 잠겨 있습니다. 실제 정산은 지금처럼 이메일 운행내역서로 하고, 이 화면은 금액이 맞는지 비교하는 데만 씁니다(정식 운영 때 config.js 의 TEST_MODE 를 false 로).</div>` : ""}
    <div class="card"><h2>더한물류 운행내역서 대조</h2><p class="sub">이메일로 받은 엑셀을 놓으면 대장과 비교해 <b>대장에 없는 운행 · 금액이 다른 운행 · 내역서에 빠진 운행</b>을 보여 줍니다. 금액은 여기서 고치지 않고(더한물류만 수정), 다른 건마다 질문을 남길 수 있습니다. 앞으로는 더한물류가 자기 화면 '운행내역서 올리기'로 직접 올립니다.</p>
      ${dropZoneHtml("rc-drop", "운행내역서 엑셀 대조하기")}<div id="rc-out"></div></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(360px,1fr))">${vendors.map(card).join("") || `<div class="card empty">이 달 운행 완료 건이 없습니다</div>`}</div></div>`;
  bindReconcile(v);
  $$("[data-xlsx]", v).forEach(b => b.onclick = () => { const vd = S.refs.vendors.find(x => x.id === b.dataset.xlsx); exportSheetXlsx(R.filter(d => d.vendor_id === vd.id), `${vd.name}_운행내역서_${S.month}`, `${vd.name} 운행내역서 ${S.month}`, b); });
  $$("[data-csv]", v).forEach(b => b.onclick = () => { const vd = S.refs.vendors.find(x => x.id === b.dataset.csv); downloadCsv(R.filter(d => d.vendor_id === vd.id).sort((a, c) => a.run_date.localeCompare(c.run_date)), `${vd.name}_운행내역서_${S.month}.csv`); });
  $$("[data-conf]", v).forEach(b => b.onclick = async () => {
    const vd = S.refs.vendors.find(x => x.id === b.dataset.conf); const L = R.filter(d => d.vendor_id === vd.id && d.status !== "done");
    const sum = L.reduce((a, d) => a + cost(d), 0);
    if (!confirm(`${vd.name} ${S.month} ${L.length}건 · 공급가액 ${won(sum)}원을 확정할까요?`)) return;
    await Admin.confirmSettlement(vd.id, S.month, sum, L.map(d => d.id), S.user.email); toast("정산을 확정했습니다"); await reload();
  });
}

// ---------------- 설정 ----------------
async function drawBackups(v) {
  const box = $("#bk-list", v); if (!box) return;
  try { const B = await Admin.backups();
    box.innerHTML = B.length ? `<div class="tbl-wrap" style="max-height:260px"><table class="tbl"><thead><tr><th>날짜</th><th>만든 시각</th><th class="r">건수</th><th>누가</th><th></th></tr></thead><tbody>${B.map(b => `<tr><td><b>${dLabel(b.day)}</b></td><td class="num">${fmtSec(b.made_at)}</td><td class="r num">${b.row_count}</td><td class="muted">${esc(whoLabel(b.made_by) || b.made_by || "")}</td>
      <td class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn sm" data-bkx="${b.day}">엑셀</button><button class="btn sm ghost" data-bkj="${b.day}">원본</button></td></tr>`).join("")}</tbody></table></div>` : "아직 백업이 없습니다";
    $$("[data-bkx]", box).forEach(b => b.onclick = async () => { const rows = (await Admin.backupRows(b.dataset.bkx)).filter(d => !d.deleted_at).map(d => ({ ...d, delivery: d.delivery || d.dispatch_delivery }));
      exportSheetXlsx(rows, `통합대장_백업_${b.dataset.bkx}`, `${b.dataset.bkx} 백업`, b); });
    $$("[data-bkj]", box).forEach(b => b.onclick = async () => { const rows = await Admin.backupRows(b.dataset.bkj);
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify({ day: b.dataset.bkj, rows }, null, 1)], { type: "application/json" })); a.download = `통합대장_백업_${b.dataset.bkj}.json`; a.click(); });
  } catch (e) { box.textContent = "불러오기 실패: " + e.message + (LIVE ? " (schema.sql 의 build 11 부분을 실행했는지 확인)" : ""); }
}
async function drawTrash(v) {
  const box = $("#tr-list", v); if (!box) return;
  try { const T = await Admin.trash();
    box.innerHTML = T.length ? `<div class="tbl-wrap" style="max-height:260px"><table class="tbl"><thead><tr><th>#</th><th>운행일</th><th>구간</th><th>삭제</th><th>사유</th><th></th></tr></thead><tbody>${T.map(d => `<tr><td class="num">${d.id}</td><td>${dLabel(d.run_date)}</td><td>${typeTag(d.type)} ${esc(d.from_place)} → ${esc(d.to_place)}</td><td class="num">${fmtSec(d.deleted_at)}<div class="kmeta">${esc(whoLabel(d.deleted_by) || d.deleted_by || "")}</div></td><td>${esc(d.delete_reason || "")}</td>
      <td>${S.user?.can_delete ? `<button class="btn sm" data-rs="${d.id}">되살리기</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : "휴지통이 비어 있습니다";
    $$("[data-rs]", box).forEach(b => b.onclick = async () => { try { await Admin.restore([+b.dataset.rs], S.user.email); toast("되살렸습니다 — 대장에 다시 보입니다"); await reload(true); drawTrash(v); } catch (e) { toast(e.message); } });
  } catch (e) { box.textContent = "불러오기 실패: " + e.message; }
}
function viewSetup(v) {
  const base = location.href.split(/[?#]/)[0];
  const vRows = S.refs.vendors.map(x => `<tr><td><b>${esc(x.name)}</b></td><td>${x.types.map(typeTag).join(" ")}</td><td>${LIVE ? '<span class="muted">SQL로 관리</span>' : `<span class="num">${esc(x.pin)}</span>`}</td>
    <td><input readonly value="${esc(base + "?v=" + encodeURIComponent(x.name))}" style="width:100%;border:1px solid var(--line);border-radius:7px;padding:5px 7px;background:var(--panel2)" onclick="this.select()"></td>
    <td class="row" style="gap:6px;flex-wrap:nowrap"><a class="btn sm" href="${esc(base + "?v=" + encodeURIComponent(x.name))}" target="_blank" rel="noopener">새 창</a><button class="btn sm" data-vprev="${esc(x.name)}">이 창에서 보기</button></td></tr>`).join("");
  const pRows = S.refs.places.map(p => `<tr><td>${esc(p.name)}</td><td>${esc(p.kind)}</td><td class="muted">${esc((p.aliases || []).join(", "))}</td><td class="r"><button class="btn ghost sm danger" data-delp="${p.id}" aria-label="${esc(p.name)} 지우기">✕</button></td></tr>`).join("");
  const rRows = S.refs.rates.map(r => `<tr><td>${esc(vName(r.vendor_id))}</td><td>${typeTag(r.type)}</td><td>${esc(r.from_place || "어디서든")}</td><td>${esc(r.to_place || "어디로든")}</td><td class="r">${r.vehicle_ton ?? "무관"}</td><td class="r num"><b>${won(r.base_fare)}</b></td><td class="muted">${esc(r.note || "")}</td><td class="r"><button class="btn ghost sm danger" data-delr="${r.id}" aria-label="운임 지우기">✕</button></td></tr>`).join("");
  v.innerHTML = `<div class="grid">
    <div class="card"><h2>운영 범위 · 연습 모드</h2><p class="sub">${PHASE < 2 ? `<b>1단계(파일럿)</b>: 쿠팡 출고 + ${esc(PILOT_FROM)} → 매장 출고만 다룹니다. 신선(콜드체인) 센터 · 고객 배송은 2단계(config.js 의 PHASE: 2).` : "<b>2단계</b>: 모든 유형을 다룹니다."}</p>
      <div class="row" style="gap:10px;flex-wrap:wrap">${PHASE < 2 ? `<label class="row" style="gap:6px"><input type="checkbox" id="show-all" ${SHOW_ALL ? "checked" : ""}> 이 PC에서만 2단계 유형도 보기(확인용)</label>` : ""}
        <a class="btn sm" href="${esc(base + "?demo=" + (PRACTICE ? "0" : "1"))}">${PRACTICE ? "연습 모드 끄기" : "연습 모드로 열기"}</a><span class="muted">연습 모드는 실제 데이터와 분리된 이 기기 전용 데이터로 동작합니다. 링크 끝에 <code>?demo=1</code>을 붙여 교육용으로 보내도 됩니다.</span></div></div>
    <div class="card" id="bk-card"><h2>일별 백업</h2><p class="sub">통합 대장 전체를 <b>하루 한 번</b> 통째로 저장합니다(운영: 매일 00:05 자동 + 그날 처음 들어온 관리자 화면, ${LIVE ? "90일" : "데모 14일"} 보관). 날짜를 골라 그날 상태 그대로 엑셀 · 원본(JSON)으로 받을 수 있습니다.</p>
      <div id="bk-list" class="muted">불러오는 중…</div><div class="row" style="margin-top:8px"><button class="btn sm" id="bk-now">지금 다시 백업</button></div></div>
    <div class="card" id="tr-card"><h2>휴지통 · 삭제 권한</h2><p class="sub">대장에서 지운 건은 여기 남습니다. ${S.user?.can_delete ? "<b>나는 삭제 권한자입니다</b> — 대장에서 건을 골라 아래 검은 줄의 '삭제'." : "<b>나는 삭제 권한이 없습니다.</b>"} 권한자 지정은 Supabase SQL: <code>update staff set can_delete = true where email = '이메일';</code></p>
      <div id="tr-list" class="muted">불러오는 중…</div></div>
    <div class="card"><h2>업체 · 접속 링크</h2><p class="sub">업체에 <b>링크 + PIN</b>을 보내면 휴대폰에서 로그인 없이 바로 입력합니다. 링크는 업체마다 다르고, PIN이 맞아야 열립니다.</p>
      <div class="tbl-wrap" style="max-height:none"><table class="tbl"><thead><tr><th>업체</th><th>맡는 유형</th><th>PIN</th><th>접속 링크</th><th></th></tr></thead><tbody>${vRows}</tbody></table></div></div>
    <div class="card"><h2>테스트 기간 의견</h2><p class="sub">관리자 · 더한물류 · 매장이 화면 위 '의견 남기기'로 보낸 내용입니다.</p><ul class="fb-list" id="fb-list"><li class="muted">불러오는 중…</li></ul></div>
    <div class="card"><h2>본사 확인 담당자 링크</h2><p class="sub">운행 완료 건을 확인(최종 완료)하는 담당자 화면입니다. 링크 + PIN으로 휴대폰 · PC에서 들어갑니다. 확인이 끝나야 정산 확정할 수 있습니다.</p>
      <div class="tbl-wrap" style="max-height:none"><table class="tbl"><thead><tr><th>이름</th><th>PIN</th><th>접속 링크</th><th></th></tr></thead><tbody>${(S.refs.checkers || []).map(x => `<tr><td><b>${esc(x.name)}</b></td><td>${LIVE ? '<span class="muted">SQL로 관리</span>' : `<span class="num">${esc(x.pin)}</span>`}</td>
        <td><input readonly value="${esc(base + "?c=" + encodeURIComponent(x.name))}" style="width:100%;border:1px solid var(--line);border-radius:7px;padding:5px 7px;background:var(--panel2)" onclick="this.select()"></td>
        <td class="row" style="gap:6px;flex-wrap:nowrap"><a class="btn sm" href="${esc(base + "?c=" + encodeURIComponent(x.name))}" target="_blank" rel="noopener">새 창</a><button class="btn sm" data-cprev="${esc(x.name)}">이 창에서 보기</button></td></tr>`).join("") || `<tr><td colspan="4" class="muted">등록된 확인 담당자가 없습니다(운영 가이드의 SQL로 추가)</td></tr>`}</tbody></table></div></div>
    <div class="card"><h2>구글시트 동기화(1시간마다)</h2><p class="sub">「킹콩_쿠팡배차내역」 · 「매장출고_고객배송내역」 · 「배차내역_경산2」에서 최근 45일 줄을 가져옵니다. 시트에서 온 줄은 대장에 <span class="flag sh-flag">시트</span> 표시 — 테스트 기간엔 시트가 원본이라 시트에서 고쳐 주세요. 확인 · 정산 확정된 줄은 덮어쓰지 않습니다.</p><div id="sync-st" class="muted">${LIVE ? "불러오는 중…" : "데모 화면 — DB(3단계) 연결과 시트 스크립트 설치 뒤 여기에 마지막 동기화 시각이 나옵니다"}</div></div>
    <div class="card"><h2>센터 링크 (1단계: 진천센터)</h2><p class="sub">센터 담당자가 휴대폰 · PC에서 <b>링크 + PIN</b>으로 들어와 출고 · 입고 요청과 진행(차량 등록)을 봅니다. 우리 센터 출발 · 도착 · 우리가 요청한 건만 보이고 <b>금액은 보이지 않습니다</b>. 차량이 등록되면 센터 휴대폰으로 알림이 갑니다.</p>
      <div class="tbl-wrap" style="max-height:none"><table class="tbl"><thead><tr><th>센터</th><th>PIN</th><th>접속 링크</th><th></th></tr></thead><tbody>${(S.refs.stores || []).filter(x => x.kind === "center").map(x => `<tr><td><b>${esc(x.name)}</b></td><td>${LIVE ? '<span class="muted">SQL로 관리</span>' : `<span class="num">${esc(x.pin)}</span>`}</td>
        <td><input readonly value="${esc(base + "?g=" + encodeURIComponent(x.name))}" style="width:100%;border:1px solid var(--line);border-radius:7px;padding:5px 7px;background:var(--panel2)" onclick="this.select()"></td>
        <td class="row" style="gap:6px;flex-wrap:nowrap"><a class="btn sm" href="${esc(base + "?g=" + encodeURIComponent(x.name))}" target="_blank" rel="noopener">새 창</a></td></tr>`).join("") || '<tr><td colspan="4" class="muted">센터가 없습니다 — SQL: insert into stores(name, kind, pin_hash) values (\'진천센터\', \'center\', crypt(\'PIN\', gen_salt(\'bf\')));</td></tr>'}</tbody></table></div></div>
    <div class="card"><h2>매장 · 배송요청 링크${STORES_OPEN ? "" : ' <span class="flag">2단계</span>'}</h2><p class="sub">${STORES_OPEN ? "" : "<b>지금은 닫혀 있습니다(2단계에 엶).</b> "}매장 직원이 휴대폰으로 고객 배송을 요청합니다(영수증 사진 + 배송요청서 항목). 종이 요청서 · 확인서는 매장에 보관합니다.</p>
      <div class="tbl-wrap" style="max-height:none"><table class="tbl"><thead><tr><th>매장</th><th>PIN</th><th>접속 링크</th><th></th></tr></thead><tbody>${(S.refs.stores || []).filter(x => x.kind !== "center").map(x => `<tr><td><b>${esc(x.name)}</b></td><td>${LIVE ? '<span class="muted">SQL로 관리</span>' : `<span class="num">${esc(x.pin)}</span>`}</td>
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
  drawBackups(v); drawTrash(v);
  $("#bk-now", v).onclick = async e => { e.target.disabled = true; try { const r = await Admin.backupToday(true); toast(`백업했습니다 — ${r.row_count ?? ""}건`); drawBackups(v); } catch (err) { toast("백업 실패: " + err.message); } e.target.disabled = false; };
  const sa = $("#show-all", v); if (sa) sa.onchange = async () => { SHOW_ALL = sa.checked; try { SHOW_ALL ? localStorage.setItem("kk_show_all", "1") : localStorage.removeItem("kk_show_all"); } catch (_) {} location.reload(); };
  $("#rf").onsubmit = async e => { e.preventDefault(); await Admin.saveRef("rates", { vendor_id: $("#rf-v").value, type: $("#rf-t").value, from_place: $("#rf-f").value.trim() || null, to_place: $("#rf-to").value.trim() || null, vehicle_ton: numOrNull($("#rf-ton").value), base_fare: +$("#rf-fare").value, note: "" }); toast("운임표에 추가했습니다"); await reload(); };
  $("#pf").onsubmit = async e => { e.preventDefault(); await Admin.saveRef("places", { name: $("#pf-n").value.trim(), kind: $("#pf-k").value, aliases: $("#pf-a").value.split(",").map(s => s.trim()).filter(Boolean), active: true }); toast("지점을 추가했습니다"); await reload(); };
  $$("[data-delp]", v).forEach(b => b.onclick = async () => { await Admin.removeRef("places", b.dataset.delp); await reload(); });
  $$("[data-delr]", v).forEach(b => b.onclick = async () => { await Admin.removeRef("rates", b.dataset.delr); await reload(); });
  $$("[data-vprev]", v).forEach(b => b.onclick = () => { location.hash = "v=" + encodeURIComponent(b.dataset.vprev); location.reload(); });
  Feedback.list().then(L => { $("#fb-list").innerHTML = L.length ? L.map(f => `<li${f.done_at ? ' class="muted"' : ""}><span class="num">${fmtSec(f.at)}</span> · <b>${esc(whoLabel(f.who))}</b> · ${esc(f.body)} ${f.done_at ? "(처리함)" : `<button class="btn sm ghost" data-fbd="${f.id}">처리함</button>`}</li>`).join("") : '<li class="muted">아직 없음</li>';
    $$("[data-fbd]", v).forEach(b => b.onclick = async () => { await Feedback.done(+b.dataset.fbd); viewSetup(v); }); }).catch(e => { $("#fb-list").textContent = e.message; });
  $$("[data-cprev]", v).forEach(b => b.onclick = () => { location.hash = "c=" + encodeURIComponent(b.dataset.cprev); location.reload(); });
  if (LIVE) liveClient().then(c => c.rpc("sheet_sync_status")).then(r => { const o = r.data || {}; $("#sync-st").innerHTML = Object.keys(o).length ? Object.entries(o).map(([k, x]) => `<div><b>${esc(k)}</b> · ${esc(x)}</div>`).join("") : "아직 동기화 기록이 없습니다 — 시트 스크립트 '설치'를 실행해 주세요"; }).catch(() => {});
  $$("[data-sprev]", v).forEach(b => b.onclick = () => { location.hash = "s=" + encodeURIComponent(b.dataset.sprev); location.reload(); });
  const rs = $("#reset"); if (rs) rs.onclick = async () => { if (confirm("예시 데이터를 처음 상태로 되돌릴까요?")) { Demo.reset(); await reload(); } };
}

// =====================================================================
//  업체(모바일) 화면 — 링크 + PIN
// =====================================================================
const V = { tab: "todo", day: "all", rows: [], refs: { places: [], rates: [] },
  view: (() => { try { return localStorage.getItem("kk_vview") || (innerWidth >= 1000 ? "desk" : "mobile"); } catch (_) { return "mobile"; } })(),
  dk: { day: "week", type: "", st: "open", q: "", mode: "table" }, sel: new Set() };
const setVView = v => { V.view = v; try { localStorage.setItem("kk_vview", v); } catch (_) {} vendorRender(); };
async function vendorBoot(name) {
  let saved = null; try { saved = sessionStorage.getItem("kk_vpin_" + name) || localStorage.getItem("kk_vpin_" + name); } catch (_) {}   // 휴대폰은 한 번 넣으면 기억(홈 화면 앱 · 알림 눌러 열 때)
  if (saved) { try { await Vendor.login(name, saved); return vendorLoad(); } catch (_) {} }
  app.innerHTML = `<div class="pin"><div class="card"><div class="brand" style="justify-content:center;margin-bottom:6px"><span class="logo" aria-hidden="true">K</span></div>
    <h2>${esc(name)}</h2><p class="sub">킹콩백화점 배차 입력 · PIN 4자리를 넣어 주세요${LIVE ? "" : "<br><span class='muted'>(데모: 더한물류 1357)</span>"}</p>
    <form id="pf"><div class="field"><label for="pin" class="hidden">PIN</label><input id="pin" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus aria-label="PIN"></div>
    <button class="btn primary" style="width:100%;margin-top:12px;min-height:52px;font-size:17px" type="submit">들어가기</button></form><p class="hint" id="err" role="alert"></p></div></div>`;
  $("#pf").onsubmit = async e => { e.preventDefault(); try { await Vendor.login(name, $("#pin").value.trim()); vendorLoad(); } catch (err) { $("#err").textContent = err.message; } };
}
async function vendorLoad(quiet) {
  const old = new Map(V.rows.map(d => [d.id, d]));
  try { [V.rows, V.refs] = await Promise.all([Vendor.list(), Vendor.refs()]); V.rows = V.rows.filter(inScope); Live.mark(); } catch (e) { Live.mark(false); if (!quiet) app.innerHTML = `<div class="empty">불러오기 실패: ${esc(e.message)}</div>`; return; }
  const was = V.loaded; V.loaded = true; vendorRender(); if (!was) whatsNew("vendor");   // 입력 시트는 목록 밖에 떠 있어서 다시 그려도 안 닫힘
  if (!was) return;
  // 화면이 열려 있을 때 알림(소리 · 진동). 화면이 꺼져 있으면 휴대폰 푸시가 대신 울림
  const fresh = V.rows.filter(d => d.status === "requested" && !old.has(d.id));
  const canceled = V.rows.filter(d => d.status === "canceled" && old.has(d.id) && old.get(d.id).status !== "canceled");
  const asked = V.rows.filter(d => (d.comments || []).filter(c => c.kind === "question").length > (old.get(d.id)?.comments || []).filter(c => c.kind === "question").length);
  const changed = V.rows.filter(d => old.has(d.id) && evOf(d, "change").length > evOf(old.get(d.id), "change").length && !evOf(d, "change").slice(-1)[0]?.by?.startsWith("vendor:"));
  const msg = [fresh.length && `새 배차 요청 ${fresh.length}건`, canceled.length && `취소 ${canceled.length}건 (${canceled.map(d => d.from_place + "→" + d.to_place).slice(0, 2).join(", ")})`, changed.length && `변경 ${changed.length}건`, asked.length && `킹콩 질문 ${asked.length}건`].filter(Boolean).join(" · ");
  if (msg) alertLocal("킹콩 배차", msg, canceled.length > 0);
}
const needsInput = d => d.status === "requested" || (d.status === "assigned" && !d.base_fare) || (["assigned", "done"].includes(d.status) && !d.driver_name);
function vendorRender() {
  if (V.view === "desk") return vendorDesk();
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
    <div class="m-head"><div class="who">킹콩백화점 배차 · ${esc(Vendor.name)}${modeTag()}</div>
      <div class="ttl">${todo.length ? `입력할 배차 ${todo.length}건` : "입력할 배차가 없습니다"}</div>
      <div class="paste-btn"><button class="btn sm" id="v-batch">한 번에 입력</button><button class="btn sm primary" id="v-paste">카톡 글 붙여넣기</button></div>
      <div class="paste-btn sub2"><button class="btn sm" id="v-stmt">운행내역서 올리기</button><button class="btn sm bell" id="v-bell">${bellLabel()}</button><button class="btn sm" id="v-guide">입력 양식</button><button class="btn sm" id="v-man">사용 설명서</button>${innerWidth >= 700 ? `<button class="btn sm" id="v-desk">PC 관제판</button>` : ""}</div>
      <div class="who">이번 달 청구 ${won(monthSum)}원${!LIVE && location.hash.includes("v=") ? ` · <a href="#" id="to-admin" style="color:inherit">관리자 화면으로</a>` : ""}</div>
      <div class="m-tabs" role="group" aria-label="보기">${[["todo", `입력 필요 ${todo.length}`], ["q", `질문 ${asked.length}`], ["done", `입력 완료 ${mine.length}`], ["all", "전체"]].map(([k, l]) => `<button data-vt="${k}" aria-pressed="${V.tab === k}">${l}</button>`).join("")}</div></div>
    <div class="m-days" role="group" aria-label="날짜">${[["all", "전체"], ["today", "오늘"], ["tomorrow", "내일"], ["later", "모레 이후"], ["past", "지난 운행"]].map(([k, l]) => `<button data-vd="${k}" aria-pressed="${V.day === k}">${l}</button>`).join("")}</div>
    <div class="m-list">${dates.length ? dates.map(dd => `<div class="m-date">${dLabel(dd)}${dd === t ? " · 오늘" : dd === addDays(t, 1) ? " · 내일" : ""}</div>` + groups[dd].map(cardHtml).join("")).join("") : `<div class="empty">해당하는 배차가 없습니다</div>`}</div>
    <p class="build">build ${BUILD} ${syncChipHtml()}</p><button class="fab" id="fab">+ 요청 없이 운행한 건 추가</button></div>`;
  bindSyncChip();
  $$("[data-vt]").forEach(b => b.onclick = () => { V.tab = b.dataset.vt; vendorRender(); });
  $$("[data-vd]").forEach(b => b.onclick = () => { V.day = b.dataset.vd; vendorRender(); });
  $$(".m-card").forEach(b => b.onclick = () => openSheet(V.rows.find(d => d.id === +b.dataset.id)));
  $("#fab").onclick = () => openSheet(null);
  $("#v-paste").onclick = () => openVendorPaste();
  $("#v-batch").onclick = () => openBatch();
  $("#v-stmt").onclick = () => openStatementUpload();
  $("#v-man").onclick = () => openManuals("vendor");
  const vd = $("#v-desk"); if (vd) vd.onclick = () => setVView("desk");
  $("#v-guide").onclick = () => openGuide("vendor");
  bindBell($("#v-bell"), "vendor", Vendor.name, Vendor.pin);
  const ta = $("#to-admin"); if (ta) ta.onclick = e => { e.preventDefault(); location.hash = ""; location.reload(); };
}
// =====================================================================
//  더한물류 PC 관제판 — 표 / 칸반 · 여러 건 선택 일괄 처리 · 표 안에서 바로 기사 · 차량 · 운임 입력(자동 저장)
// =====================================================================
const fullPay = d => ({ driver_name: d.driver_name || "", driver_phone: d.driver_phone || "", vehicle_no: d.vehicle_no || "", vehicle_ton: d.vehicle_ton ?? null, vehicle_body: d.vehicle_body || "",
  base_fare: d.base_fare ?? null, extra_fare: d.extra_fare || 0, extra_reason: d.extra_reason || "", status: d.status === "done" || d.status === "checked" ? "done" : "assigned" });
const KCOLS = [["requested", "배차 요청"], ["assigned", "배차 완료"], ["done", "운행 완료"], ["checked", "확인 · 정산"]];
const kcolOf = d => d.status === "confirmed" ? "checked" : d.status;
function deskRows() {
  const f = V.dk, t = today(), wk = addDays(t, 7);
  return V.rows.filter(d => {
    if (f.day === "today" && d.run_date !== t) return false;
    if (f.day === "tomorrow" && d.run_date !== addDays(t, 1)) return false;
    if (f.day === "week" && (d.run_date < addDays(t, -1) || d.run_date > wk)) return false;
    if (f.day === "past" && d.run_date >= t) return false;
    if (f.type && d.type !== f.type) return false;
    if (f.st === "open" && !["requested", "assigned"].includes(d.status) && !(d.status === "done" && !d.base_fare)) return false;
    if (f.st === "need" && !needsInput(d)) return false;
    if (f.st && !["open", "need"].includes(f.st) && kcolOf(d) !== f.st) return false;
    if (f.st !== "canceled" && f.st !== "" && d.status === "canceled") return false;
    if (f.q) { const q = f.q.toLowerCase(); if (![d.from_place, d.to_place, d.driver_name, d.vehicle_no, d.group_no, d.cargo_note, String(d.id)].some(x => String(x || "").toLowerCase().includes(q))) return false; }
    return true;
  }).sort((a, b) => a.run_date.localeCompare(b.run_date) || (a.time_slot || "").localeCompare(b.time_slot || "") || a.id - b.id);
}
function vendorDesk() {
  const f = V.dk, L = deskRows(), t = today();
  [...V.sel].forEach(id => { if (!L.some(d => d.id === id)) V.sel.delete(id); });
  const cnt = k => V.rows.filter(d => k === "need" ? needsInput(d) && d.status !== "canceled" : kcolOf(d) === k).length;
  const chip = (grp, k, l, cls = "") => `<button class="fchip ${cls}" data-${grp}="${k}" aria-pressed="${f[grp] === k}">${l}</button>`;
  const drv = recentDrivers().slice(0, 30);
  const inp = (d, k, attrs = "") => `<input class="di" data-k="${k}" value="${esc(d[k] ?? "")}" ${attrs} ${d.status === "confirmed" || d.status === "canceled" ? "disabled" : ""}>`;
  const row = d => { const r = rateHint(d); return `<tr data-id="${d.id}" class="${V.sel.has(d.id) ? "sel" : ""} st-${d.status}">
    <td class="ckc"><input type="checkbox" class="ck dck" ${V.sel.has(d.id) ? "checked" : ""} aria-label="선택"></td>
    <td>${dLabel(d.run_date)}${d.run_date === t ? ' <b class="today">오늘</b>' : ""}<div class="kmeta">${esc(d.time_slot || "")}</div></td>
    <td>${typeTag(d.type)}</td>
    <td class="rt"><b>${esc(d.from_place)} → ${esc(d.to_place)}</b><div class="kmeta">${[d.plt_qty != null ? d.plt_qty + "PLT" : "", d.group_no ? "그룹 " + esc(d.group_no) : "", d.via_place ? "경유 " + esc(d.via_place) : "", esc(d.cargo_note || "")].filter(Boolean).join(" · ")} ${evBadges(d)}${qBadge(d)}</div></td>
    <td>${stTag(d.status)}</td>
    <td>${inp(d, "driver_name", 'list="dl-ddrv" placeholder="기사" aria-label="기사" style="width:84px"')}</td>
    <td>${inp(d, "driver_phone", 'placeholder="010-" inputmode="tel" aria-label="연락처" style="width:112px"')}</td>
    <td>${inp(d, "vehicle_no", 'placeholder="차량번호" aria-label="차량번호" style="width:108px"')}</td>
    <td><select class="di" data-k="vehicle_ton" aria-label="톤수" ${d.status === "confirmed" ? "disabled" : ""}><option value="">-</option>${TONS.map(x => `<option value="${x}" ${+d.vehicle_ton === x ? "selected" : ""}>${x}</option>`).join("")}</select></td>
    <td>${inp(d, "base_fare", `type="number" inputmode="numeric" step="1000" placeholder="${r ? won(r) : "기본"}" aria-label="기본운임" style="width:92px"`)}</td>
    <td>${inp(d, "extra_fare", 'type="number" inputmode="numeric" step="1000" placeholder="0" aria-label="추가운임" style="width:80px"')}</td>
    <td>${inp(d, "extra_reason", 'list="dl-dreason" placeholder="추가 사유" aria-label="추가 사유" style="width:100px"')}</td>
    <td class="r num"><b class="sum">${d.base_fare ? won(billed(d)) : "-"}</b><span class="svst" aria-live="polite"></span></td>
    <td><button class="btn sm ghost dopen" type="button" aria-label="자세히">⋯</button></td></tr>`; };
  const kcard = d => `<div class="kcard t-${d.type} ${V.sel.has(d.id) ? "sel" : ""}" data-id="${d.id}" draggable="${["requested", "assigned"].includes(d.status)}" tabindex="0">
    <div class="row" style="justify-content:space-between"><span class="row" style="gap:4px"><input type="checkbox" class="ck dck" ${V.sel.has(d.id) ? "checked" : ""} aria-label="선택">${typeTag(d.type)}${evBadges(d)}${qBadge(d)}</span><span class="kmeta">${dLabel(d.run_date)} ${esc(d.time_slot || "")}</span></div>
    <div class="kroute">${esc(d.from_place)} → ${esc(d.to_place)}</div>
    <div class="kmeta">${[d.plt_qty != null ? d.plt_qty + "PLT" : "", d.driver_name ? esc(d.driver_name) + " " + esc(d.vehicle_no || "") : "", d.base_fare ? won(billed(d)) + "원" : d.status !== "requested" ? "<b style='color:var(--bad)'>운임 미입력</b>" : ""].filter(Boolean).join(" · ")}</div></div>`;
  const monthSum = V.rows.filter(d => monthOf(d.run_date) === t.slice(0, 7) && d.base_fare).reduce((a, d) => a + billed(d) + (+d.return_fare || 0), 0);
  app.innerHTML = `<div class="top"><div class="top-in">
    <div class="brand"><span class="logo" aria-hidden="true">K</span><span>배차 관제판 · ${esc(Vendor.name)}${modeTag()}<small>킹콩백화점 ${PHASE < 2 && !SHOW_ALL ? "1단계: 쿠팡 · 진천센터→매장" : "전체"} <span class="build-pill">build ${BUILD}</span></small></span></div>
    <span class="sp"></span>${syncChipHtml()}
    <button class="btn sm primary" id="d-paste">카톡 글 붙여넣기</button><button class="btn sm" id="d-stmt">운행내역서 올리기</button><button class="btn sm" id="d-add">요청 없이 운행한 건</button>
    <button class="btn sm bell" id="d-bell">${bellLabel()}</button><button class="btn sm" id="d-guide">입력 양식</button><button class="btn sm" id="d-man">설명서</button><button class="btn sm" id="d-mob">휴대폰 화면</button>
  </div></div>
  <main class="desk">
    <div class="kpis4">${[["need", "입력 필요", "var(--bad)"], ["requested", "배차 요청", "var(--brand)"], ["assigned", "배차 완료 · 운행 전", "var(--t2)"], ["done", "운행 완료 · 확인 대기", "var(--good)"]].map(([k, l, c]) => `<button class="kpi4" data-kst="${k}" style="--c:${c}"><small>${l}</small><b>${cnt(k)}</b></button>`).join("")}<div class="kpi4 static"><small>이번 달 청구</small><b>${man(monthSum)}원</b></div></div>
    <div class="card fbar">
      <div class="frow"><span class="flab">날짜</span>${[["today", "오늘"], ["tomorrow", "내일"], ["week", "이번 주"], ["past", "지난 운행"], ["all", "전체"]].map(([k, l]) => chip("day", k, l)).join("")}
        <span class="fsep"></span><span class="flab">유형</span>${chip("type", "", "전체")}${ACTIVE_TYPES().map(k => chip("type", k, TYPES[k].short, "t-" + k)).join("")}
        <span class="fsep"></span><span class="seg2" role="group" aria-label="보기">${[["table", "표"], ["kanban", "칸반"]].map(([k, l]) => `<button data-mode="${k}" aria-pressed="${f.mode === k}">${l}</button>`).join("")}</span></div>
      <div class="frow"><span class="flab">상태</span>${[["open", "진행 중"], ["need", "입력 필요"], ["requested", "요청"], ["assigned", "배차 완료"], ["done", "운행 완료"], ["checked", "확인 · 정산"], ["canceled", "취소"], ["", "전체"]].map(([k, l]) => chip("st", k, l)).join("")}
        <input type="search" id="d-q" placeholder="지점 · 기사 · 차량번호 · 그룹 · #번호 찾기" value="${esc(f.q)}" aria-label="찾기"><span class="muted">${L.length}건</span></div>
    </div>
    ${f.mode === "table" ? `<div class="tbl-wrap"><table class="tbl dtbl"><thead><tr><th class="ckc"><input type="checkbox" class="ck" id="d-all" aria-label="모두 선택"></th><th>운행일</th><th>유형</th><th>구간 · 물량</th><th>상태</th><th>기사</th><th>연락처</th><th>차량번호</th><th>톤</th><th class="r">기본운임</th><th class="r">추가</th><th>추가 사유</th><th class="r">합계</th><th></th></tr></thead>
      <tbody>${L.map(row).join("") || `<tr><td colspan="14" class="empty">해당하는 배차가 없습니다</td></tr>`}</tbody></table></div>
      <p class="hint">칸에 바로 쓰면 <b>칸을 벗어날 때 자동 저장</b>됩니다(배차 요청 건은 기사 이름을 넣으면 '배차 완료'로). 기사 이름을 고르면 최근 차량 · 연락처가 따라 들어옵니다. Shift+클릭으로 범위 선택.</p>`
    : `<div class="kanban">${KCOLS.map(([k, l]) => { const C = L.filter(d => kcolOf(d) === k); if (k === "done" || k === "checked") C.reverse(); return `<section class="kcol" data-col="${k}"><header><b>${l}</b><span class="muted">${C.length}</span></header>${C.map(kcard).join("") || '<div class="muted" style="padding:8px">없음</div>'}</section>`; }).join("")}</div>
      <p class="hint">카드를 <b>운행 완료</b> 칸으로 끌어 놓으면 운행 완료 처리됩니다. 배차 요청 카드를 <b>배차 완료</b>로 끌면 기사 입력 창이 열립니다.</p>`}
    <datalist id="dl-ddrv">${drv.map(x => `<option value="${esc(x.driver_name)}">${esc([x.vehicle_no, x.vehicle_ton ? x.vehicle_ton + "톤" : ""].filter(Boolean).join(" "))}</option>`).join("")}</datalist>
    <datalist id="dl-dreason">${EXTRA_REASONS.map(x => `<option value="${esc(x)}">`).join("")}</datalist>
  </main>
  <div class="bulkbar" id="d-bulk" ${V.sel.size ? "" : "hidden"}><b>${V.sel.size}건 선택</b><button class="btn" id="db-done">운행 완료</button><button class="btn" id="db-drv">같은 기사 · 차량 넣기</button><button class="btn" id="db-kakao">카톡 문구</button><button class="btn ghost" id="db-clear">해제</button></div>`;
  // 필터
  $$("[data-day]").forEach(b => b.onclick = () => { f.day = b.dataset.day; vendorDesk(); });
  $$("[data-type]").forEach(b => b.onclick = () => { f.type = b.dataset.type; vendorDesk(); });
  $$("[data-st]").forEach(b => b.onclick = () => { f.st = b.dataset.st; vendorDesk(); });
  $$("[data-kst]").forEach(b => b.onclick = () => { f.st = b.dataset.kst; f.day = "all"; vendorDesk(); });
  $$("[data-mode]").forEach(b => b.onclick = () => { f.mode = b.dataset.mode; vendorDesk(); });
  let qt; $("#d-q").oninput = e => { clearTimeout(qt); qt = setTimeout(() => { f.q = e.target.value.trim(); vendorDesk(); const q = $("#d-q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 250); };
  // 상단 버튼
  $("#d-paste").onclick = () => openVendorPaste(); $("#d-stmt").onclick = () => openStatementUpload(); $("#d-add").onclick = () => openSheet(null);
  $("#d-man").onclick = () => openManuals("vendor"); $("#d-guide").onclick = () => openGuide("vendor"); $("#d-mob").onclick = () => setVView("mobile");
  bindBell($("#d-bell"), "vendor", Vendor.name, Vendor.pin); bindSyncChip();
  // 선택(Shift 범위)
  let lastIdx = null; const ids = L.map(d => d.id);
  const toggle = (id, on, shift) => { const i = ids.indexOf(id); if (shift && lastIdx != null) { const [a, b] = [Math.min(i, lastIdx), Math.max(i, lastIdx)]; ids.slice(a, b + 1).forEach(x => on ? V.sel.add(x) : V.sel.delete(x)); } else on ? V.sel.add(id) : V.sel.delete(id); lastIdx = i; paintSel(); };
  const paintSel = () => { $$("[data-id]", app).forEach(el => { const on = V.sel.has(+el.dataset.id); el.classList.toggle("sel", on); const c = $(".dck", el); if (c) c.checked = on; });
    const bb = $("#d-bulk"); bb.hidden = !V.sel.size; $("b", bb).textContent = `${V.sel.size}건 선택`; };
  $$(".dck").forEach(c => c.onclick = e => { e.stopPropagation(); toggle(+c.closest("[data-id]").dataset.id, c.checked, e.shiftKey); });
  const all = $("#d-all"); if (all) all.onchange = () => { ids.forEach(x => all.checked ? V.sel.add(x) : V.sel.delete(x)); paintSel(); };
  $("#db-clear").onclick = () => { V.sel.clear(); paintSel(); };
  $$(".dopen").forEach(b => b.onclick = () => openSheet(V.rows.find(d => d.id === +b.closest("tr").dataset.id)));
  $$(".kcard").forEach(c => { c.onclick = e => { if (e.target.closest(".dck")) return; openSheet(V.rows.find(d => d.id === +c.dataset.id)); }; c.onkeydown = e => { if (e.key === "Enter") c.click(); };
    c.ondragstart = e => e.dataTransfer.setData("text/plain", c.dataset.id); });
  $$(".kcol").forEach(col => { col.ondragover = e => { e.preventDefault(); col.classList.add("over"); }; col.ondragleave = () => col.classList.remove("over");
    col.ondrop = async e => { e.preventDefault(); col.classList.remove("over"); const d = V.rows.find(x => x.id === +e.dataTransfer.getData("text/plain")); if (!d) return;
      if (col.dataset.col === "done" && d.status === "assigned") return bulkDone([d]);
      if (col.dataset.col === "assigned" && d.status === "requested") return openSheet(d);
      toast("운행 완료 칸이나(배차 완료 건) 배차 완료 칸(요청 건)으로만 옮길 수 있습니다"); }; });
  // 표 안 입력 → 자동 저장(낙관적: 화면 먼저 바꾸고, 실패하면 되돌림)
  $$(".dtbl tbody tr[data-id]").forEach(tr => {
    const d = V.rows.find(x => x.id === +tr.dataset.id); if (!d) return;
    const g = k => { const el = $(`[data-k="${k}"]`, tr); return el ? el.value.trim() : ""; };
    $(`[data-k="driver_name"]`, tr).addEventListener("change", e => { const p = drv.find(x => x.driver_name === e.target.value.trim()); if (!p) return;
      ["driver_phone", "vehicle_no"].forEach(k => { const el = $(`[data-k="${k}"]`, tr); if (!el.value) el.value = p[k] || ""; }); const tn = $(`[data-k="vehicle_ton"]`, tr); if (!tn.value && p.vehicle_ton) tn.value = p.vehicle_ton; d._body = p.vehicle_body || d.vehicle_body; });
    let timer;
    tr.addEventListener("change", e => { if (!e.target.classList.contains("di")) return; clearTimeout(timer); timer = setTimeout(save, 350); });
    async function save() {
      const p = { ...fullPay(d), driver_name: g("driver_name"), driver_phone: g("driver_phone"), vehicle_no: g("vehicle_no"), vehicle_ton: numOrNull(g("vehicle_ton")), vehicle_body: d._body || d.vehicle_body || "",
        base_fare: numOrNull(g("base_fare")), extra_fare: numOrNull(g("extra_fare")) || 0, extra_reason: g("extra_reason") };
      const same = ["driver_name", "driver_phone", "vehicle_no", "extra_reason"].every(k => (p[k] || "") === (d[k] || "")) && p.vehicle_ton === (d.vehicle_ton ?? null) && p.base_fare === (d.base_fare ?? null) && p.extra_fare === (d.extra_fare || 0);
      if (same) return;
      const st = $(".svst", tr);
      if (d.status === "requested" && !p.driver_name) { st.textContent = " 기사 먼저"; st.className = "svst warn"; return; }
      if (p.extra_fare && !p.extra_reason) { $(`[data-k="extra_reason"]`, tr).classList.add("err"); st.textContent = " 사유 필요"; st.className = "svst warn"; return; }
      const prev = { ...d }; Object.assign(d, p, { status: p.status === "done" ? "done" : "assigned" });
      $(".sum", tr).textContent = d.base_fare ? won(billed(d)) : "-"; st.textContent = " 저장 중"; st.className = "svst";
      try { await Vendor.save(d.id, p); st.textContent = " ✓ 저장"; st.className = "svst ok"; tr.querySelectorAll(".err").forEach(x => x.classList.remove("err"));
        if (prev.status === "requested") { const s2 = $(".st", tr); if (s2) s2.outerHTML = stTag("assigned"); } Live.mark(); }
      catch (err) { Object.assign(d, prev); st.textContent = " 실패"; st.className = "svst bad"; toast("저장 실패: " + err.message); }
    }
  });
  // 일괄 처리
  const selRows = () => V.rows.filter(d => V.sel.has(d.id));
  $("#db-done").onclick = () => { const R = selRows(); const ok = R.filter(d => d.status === "assigned" && d.driver_name), skip = R.length - ok.length;
    if (!ok.length) return toast("기사가 들어간 '배차 완료' 건만 운행 완료로 바꿀 수 있습니다");
    if (!confirm(`${ok.length}건을 운행 완료로 바꿀까요?${skip ? `\n(기사 없음 · 다른 상태 ${skip}건은 건너뜀)` : ""}`)) return; bulkDone(ok); };
  $("#db-kakao").onclick = () => { const R = selRows().filter(d => d.driver_name); if (!R.length) return toast("기사가 들어간 건을 골라 주세요"); shareText(R.map(kakaoDoneText).join("\n\n")); };
  $("#db-drv").onclick = () => bulkDriver(selRows());
}
async function bulkDone(R) {
  let ok = 0; for (const d of R) { try { await Vendor.save(d.id, { ...fullPay(d), status: "done" }); ok++; } catch (e) { toast(`#${d.id} 실패: ${e.message}`); } }
  V.sel.clear(); toast(`${ok}건 운행 완료 — 본사 확인 담당자 화면에 올라갑니다`); await vendorLoad();
}
function bulkDriver(R) {
  R = R.filter(d => !["confirmed", "canceled"].includes(d.status)); if (!R.length) return toast("고칠 수 있는 건을 골라 주세요");
  const drv = recentDrivers().slice(0, 30);
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "같은 기사 넣기");
  el.innerHTML = `<header><button class="btn ghost" id="bx" aria-label="닫기">←</button><h3>${R.length}건에 같은 기사 · 차량</h3></header>
  <div class="body"><p class="hint">한 기사가 여러 건(다회전 · 같은 그룹)을 도는 경우. 운임은 건마다 표에서 넣으세요.</p>
    <div class="fields" style="grid-template-columns:1fr 1fr">
      <div class="field"><label for="bd-n">기사</label><input id="bd-n" list="dl-bd"></div><div class="field"><label for="bd-p">연락처</label><input id="bd-p" inputmode="tel"></div>
      <div class="field"><label for="bd-v">차량번호</label><input id="bd-v"></div><div class="field"><label for="bd-t">톤</label><select id="bd-t"><option value="">-</option>${TONS.map(x => `<option>${x}</option>`).join("")}</select></div>
      <div class="field"><label for="bd-b">차종</label><select id="bd-b"><option value="">-</option>${BODIES.map(x => `<option>${x}</option>`).join("")}</select></div></div>
    <datalist id="dl-bd">${drv.map(x => `<option value="${esc(x.driver_name)}">`).join("")}</datalist></div>
  <footer><button class="btn" id="bx2">닫기</button><button class="btn primary" id="bgo">${R.length}건 저장</button></footer>`;
  document.body.appendChild(el); $("#bx", el).onclick = $("#bx2", el).onclick = () => el.remove();
  $("#bd-n", el).onchange = e => { const p = drv.find(x => x.driver_name === e.target.value.trim()); if (!p) return; $("#bd-p", el).value = p.driver_phone || ""; $("#bd-v", el).value = p.vehicle_no || ""; $("#bd-t", el).value = p.vehicle_ton ?? ""; $("#bd-b", el).value = p.vehicle_body || ""; };
  $("#bgo", el).onclick = async () => { const c = { driver_name: $("#bd-n", el).value.trim(), driver_phone: $("#bd-p", el).value.trim(), vehicle_no: $("#bd-v", el).value.trim(), vehicle_ton: numOrNull($("#bd-t", el).value), vehicle_body: $("#bd-b", el).value };
    if (!c.driver_name) return toast("기사 이름을 넣어 주세요"); $("#bgo", el).disabled = true; let ok = 0;
    for (const d of R) { try { await Vendor.save(d.id, { ...fullPay(d), ...c }); ok++; } catch (e) { toast(`#${d.id} 실패: ${e.message}`); } }
    el.remove(); V.sel.clear(); await vendorLoad(); actionToast(`${ok}건 저장 · 단톡방에도 알릴까요?`, "카톡 보내기", () => shareText(R.map(d => kakaoDoneText({ ...d, ...c })).join("\n\n"))); };
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

// 필요 시간: "13시 이후" · "10시까지" · "10:30 도착" · "오전 10시" → 시간 칸(정확한 시각이 있으면 시각, 아니면 오전/오후)
function reqTime(s) {
  s = String(s || "");
  let m = s.match(/(오전|오후)?\s*(\d{1,2})\s*시\s*(\d{1,2})?\s*분?\s*(이후|이전|까지|전|후|도착|입고|하차|상차)?/);
  if (m && +m[2] <= 24 && !/\d{3,}\s*시/.test(s)) { let h = +m[2]; if (m[1] === "오후" && h < 12) h += 12; const t = `${h}시${m[3] ? " " + m[3] + "분" : ""}`;
    const w = m[4] ? (/이후|후/.test(m[4]) ? " 이후" : /이전|까지|전/.test(m[4]) ? "까지" : " " + m[4]) : ""; return t + w; }
  m = s.match(/(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])\s*(이후|이전|까지|전|후|도착|입고|하차|상차)?/);
  if (m && +m[1] <= 24 && !/\[(오전|오후)\s*\d/.test(s)) { const w = m[3] ? (/이후|후/.test(m[3]) ? " 이후" : /이전|까지|전/.test(m[3]) ? "까지" : " " + m[3]) : ""; return `${m[1].padStart(2, "0")}:${m[2]}${w}`; }
  return null;
}
// 특이사항: 하차 조건 · 대기 · 연락처 같은 줄을 메모로
const NOTE_RE = /(지게차|수작업|수하역|까대기|하차\s*도크|도크|대기|행사|파손|주의|회수|반품|공\s*(?:파렛|PLT|plt)|리프트|엘리베이터|주차|출입|진입|높이|연락|전화|사이즈|무진동|랩핑|박스|입고\s*시간|오전\s*중|오후\s*중|당일|긴급|급히|꼭)/;
function specialNotes(lines, used) {
  const out = [];
  lines.forEach(l => { const x = l.trim(); if (!x || used.includes(x) || CHATTER.test(x)) return;
    const ph = x.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/);
    if (NOTE_RE.test(x) || ph) out.push(x.replace(/\s+/g, " ").slice(0, 60)); });
  return [...new Set(out)];
}
// 문장형: "내일 진천에서 이천점으로 12파렛 보내주세요" · "이천점으로 진천센터에서 6plt"
function looseRoute(line, places) {
  const a = line.match(/([가-힣A-Za-z0-9.]+?)\s*에서\s*(?:\S+\s+)?([가-힣A-Za-z0-9.]+?)\s*(?:으로|로|까지)(?![가-힣])/);
  const b = line.match(/([가-힣A-Za-z0-9.]+?)\s*(?:으로|로|까지)\s*(?:\S+\s+)?([가-힣A-Za-z0-9.]+?)\s*에서/);
  const fix = n => /^진천$/.test(n) ? "진천센터" : n;
  const r = a ? { from: fix(a[1]), to: fix(a[2]) } : b ? { from: fix(b[2]), to: fix(b[1]) } : null;
  return r && placeLike(r.from, places) && placeLike(r.to, places) ? r : null;
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
    const n0 = out.length;
    lines.forEach((line, li) => {
      const m = line.match(/^(.*?[가-힣A-Za-z0-9])\s*(?:~|-|–|→|->|=>|>)+\s*(.+)$/);
      if (!m) { const lr = looseRoute(line, places); if (lr) { const pl = line.match(PLT_RE) || line.match(/(\d+(?:\.\d+)?)\s*(?:빠렛트|파렛트|빠레트)/); const fN = resolvePlace(lr.from, places);
          out.push({ type: (places || []).find(p => p.name === fN)?.kind === "쿠팡FC" ? "coupang" : "center", run_date: dateHint(line, msg.date || today()) || mDate, time_slot: (line.match(/오전|오후|야간/) || [mSlot])[0], from_place: fN, to_place: resolvePlace(lr.to, places),
            via_place: "", plt_qty: pl ? +pl[1] : null, temp: /냉동/.test(line) ? "냉동" : /냉장|신선/.test(line) ? "냉장" : mTemp || "상온", group_no: "", cargo_note: "", requested_by: msg.who.replace(/^킹콩\s*/, "") || "", src: line, _used: [line], _rawFrom: lr.from, _rawTo: lr.to, _loose: true, _mdate: msg.date || "" }); }
        return; }
      if (/\d{2,4}-\d{3,4}/.test(line)) return;            // 전화번호 줄은 건너뜀
      const left = m[1].trim(); const words = left.split(/\s+/);
      const from = placeLike(left, places) ? left : placeLike(words[words.length - 1], places) ? words[words.length - 1] : null;
      if (!from) return;
      const stops = m[2].split(/경유/).map(part => {
        const p2 = part.trim(); const nm = ((p2.match(/^[가-힣A-Za-z0-9.]+?(?=\d+(?:\.\d+)?\s*(?:plt|파레트|파렛|팔레트|빠레트)|\s|$)/i) || [""])[0]).replace(/\.+$/, "");
        const pl = p2.match(PLT_RE); return { name: nm, plt: pl ? +pl[1] : null };
      }).filter(x => x.name && !/^(배차|부탁|요청)/.test(x.name));
      if (!stops.length || !placeLike(stops[stops.length - 1].name, places)) return;
      let plt = stops.reduce((a, x) => a + (x.plt || 0), 0) || null;
      let pltLine = null;
      if (plt == null) { for (let k = li + 1; k < lines.length; k++) { const n = lines[k].match(PLT_RE); if (n) { plt = +n[1]; pltLine = lines[k]; break; } if (/(~|-|→|>)/.test(lines[k])) break; } }
      const fromN = resolvePlace(from, places), to = stops[stops.length - 1];
      const fk = (places || []).find(p => p.name === fromN)?.kind;
      const temp = /냉동/.test(line) ? "냉동" : /냉장|신선/.test(line) ? "냉장" : mTemp || "상온";
      out.push({ type: fk === "쿠팡FC" ? "coupang" : "center", run_date: mDate, time_slot: (line.match(/오전|오후|야간/) || [mSlot])[0], from_place: fromN, to_place: resolvePlace(to.name, places),
        via_place: stops.length > 1 ? stops.slice(0, -1).map(x => resolvePlace(x.name, places)).join(", ") : "", plt_qty: plt, temp, group_no: "",
        cargo_note: stops.length > 1 ? "경유 " + stops.map(x => `${resolvePlace(x.name, places)}${x.plt ? " " + x.plt + "plt" : ""}`).join(" → ") : "",
        requested_by: msg.who.replace(/^킹콩\s*/, "") || "", src: line, _used: [line, pltLine].filter(Boolean), _rawFrom: from, _rawTo: to.name, _mdate: msg.date || "" });
    });
    // 이 메시지에서 나온 요청에 필요 시간 · 특이사항 붙이기
    const mine = out.slice(n0);
    if (mine.length) {
      const used = mine.flatMap(r => r._used);
      const notes = specialNotes(lines, used);
      mine.forEach(r => {
        const tm = reqTime(r.src) || (mine.length === 1 ? lines.map(reqTime).find(Boolean) : null);
        if (tm) { r.time_slot = tm; r._time = tm; }
        if (notes.length) { r.cargo_note = [r.cargo_note, ...notes].filter(Boolean).join(" / "); r._used.push(...notes.map(n => lines.find(l => l.replace(/\s+/g, " ").startsWith(n.slice(0, 20))) || n)); }
      });
      lines.filter(l => reqTime(l) && !used.includes(l) && !PLT_RE.test(l)).forEach(l => mine[0]._used.push(l));
    }
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
const EVENT_KINDS = { check: "본사 확인", assign: "배차", reassign: "재배차", cancel_driver: "배차 취소", return: "회차", change: "변경", done: "운행 완료", cancel: "요청 취소", note: "메모", request: "요청" };
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
    if (isRegion) { if (!b.driver_name && !b.region) b.src = []; b.region = line.replace(/^상차지\s*:\s*/, ""); b.src.push(line); continue; }
    if (/^(하차지|상차일시|하차일시|기사명|기사전화|기사연락처|연락처|차량번호|차종)\s*:|\[(차주|차량)정보\]|그룹\s*넘버|입니다\.?$/.test(line) || /^[\d,\s]+$/.test(line)) b.src.push(line);
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
//  conf: green = 확실(그룹넘버 · 날짜+상하차지 일치 · 글에 상하차지 있음) / yellow = 추정(바로 위 글 · 일부만 맞음 · 새 운행) / red = 붙일 곳 없음
//  newReqs: 같은 붙여넣기 안에서 새로 만들 요청(음수 id) — 요청 글 + 배차 글을 한 번에 넣어도 서로 연결됨
function buildPlan(items, rows, places, newReqs = []) {
  const all = [...newReqs, ...rows];
  const used = new Set(), byItem = new Map();
  return items.map(it => {
    if (it.kind === "assign") {
      const sc = all.map(d => [d, matchScore(it, d, places)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
      const free = sc.filter(([d]) => !used.has(d.id));
      const best = free[0] && free[0][1] >= 25 ? free[0][0] : null, score = best ? free[0][1] : 0;
      if (best) used.add(best.id);
      const conf = score >= 100 || score >= 45 ? "green" : "yellow";
      const how = score >= 100 ? "그룹넘버 일치" : score >= 45 ? "날짜 · 상하차지 일치" : best ? "일부만 일치 — 확인" : "맞는 요청 없음 — 새 운행으로";
      const pl = { it, target: best, conf, how, cands: sc.slice(0, 8).map(x => x[0]) }; byItem.set(it, pl); return pl;
    }
    let target = null, viaPlan = null, how = "";
    if (it.from && it.to) { const sc = all.map(d => [d, matchScore({ ...it, groups: [] }, d, places)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]); target = sc[0]?.[0] || null; if (target) how = "글에 적힌 상하차지로 찾음"; }
    if (!target && it.after) { const ap = byItem.get(it.after); if (ap) { target = ap.target; if (!target) viaPlan = ap; how = "바로 위 배차 글에 붙임(추정) — 맞는지 확인"; } }
    if (target) used.delete(target.id);   // 취소 · 회차 뒤 '재배차' 글이 같은 요청에 다시 붙도록
    const conf = how.startsWith("글에") ? "green" : target || viaPlan ? "yellow" : "red";
    const near = all.filter(d => d.driver_name && !["confirmed", "canceled"].includes(d.status)).sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))).slice(0, 8);
    return { it, target, viaPlan, conf, how: how || "어느 배차인지 알 수 없음 — 골라 주세요", cands: target ? [target, ...near.filter(d => d.id !== target.id)] : near };
  });
}
const rowLabel = d => `${d.id < 0 ? "새 요청" : "#" + d.id} ${dLabel(d.run_date)} ${d.from_place}→${d.type === "delivery" ? "고객" : d.to_place}${d.plt_qty ? " " + d.plt_qty + "PLT" : ""}${d.group_no ? " 그룹 " + d.group_no : ""}${d.id < 0 ? "" : " · " + STATUS[d.status]}${d.driver_name ? " · " + d.driver_name : ""}`;
const CONF = { green: "확실", yellow: "확인 필요", red: "못 찾음" };
function planHtml(plan) {
  if (!plan.length) return "";
  return `<div class="plan">${plan.map((p, i) => {
    const it = p.it, badge = `<span class="conf c-${p.conf}" title="${esc(p.how)}">${CONF[p.conf]}</span>`;
    if (it.kind === "assign") return `<div class="plan-it k-assign cf-${p.conf}"><div class="row" style="justify-content:space-between"><b>${badge} 배차 · ${esc(it.from || "?")} → ${esc(it.to || "?")}</b><span class="muted">${it.date ? dLabel(it.date) : ""} ${esc(whoLabel(it.who))}</span></div>
      <div class="muted">${esc(it.driver_name)} ${esc(it.driver_phone)} · ${esc(it.vehicle_body)} ${it.vehicle_ton ? it.vehicle_ton + "톤" : ""} · ${esc(it.vehicle_no)}${it.groups.length ? " · 그룹 " + esc(it.groups.join(",")) : ""}</div>
      <div class="how">${esc(p.how)}</div>
      <select data-pi="${i}" aria-label="연결할 요청">${p.cands.map(d => `<option value="${d.id}" ${p.target && p.target.id === d.id ? "selected" : ""}>요청에 연결: ${esc(rowLabel(d))}</option>`).join("")}
        <option value="new" ${p.target ? "" : "selected"}>요청 없음 → 새 운행으로 추가</option><option value="skip">건너뛰기</option></select></div>`;
    return `<div class="plan-it k-${it.ev} cf-${p.conf}"><div class="row" style="justify-content:space-between"><b>${badge} ${esc(EVENT_KINDS[it.ev])}${it.reason && it.ev !== "change" ? " · " + esc(it.reason) : ""}</b><span class="muted">${it.date ? dLabel(it.date) : ""} ${esc(whoLabel(it.who))}</span></div>
      <div class="muted">"${esc(it.note)}"</div><div class="how">${esc(p.how)}</div>
      <select data-pi="${i}" aria-label="적용할 배차">${p.viaPlan ? `<option value="via" selected>바로 위 새 운행</option>` : ""}${p.cands.map(d => `<option value="${d.id}" ${p.target && p.target.id === d.id ? "selected" : ""}>${esc(rowLabel(d))}</option>`).join("")}
        <option value="skip" ${p.target || p.viaPlan ? "" : "selected"}>건너뛰기</option></select></div>`;
  }).join("")}</div>`;
}
const carOf = it => ({ driver_name: it.driver_name, driver_phone: it.driver_phone, vehicle_no: it.vehicle_no, vehicle_ton: it.vehicle_ton, vehicle_body: it.vehicle_body });
// api = { assign(row, car), create(it) → id, event(id, ev) } · idMap: 이번에 만든 요청(음수 id → 실제 id)
async function applyPlan(plan, root, api, places, idMap = new Map()) {
  let n = 0; const made = new Map();
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i], v = $(`[data-pi="${i}"]`, root)?.value || "skip"; if (v === "skip") continue;
    if (p.it.kind === "assign") {
      if (v === "new") made.set(p, await api.create(p.it));
      else { let row = p.cands.find(d => String(d.id) === v); if (row.id < 0) { if (!idMap.get(row.id)) continue; row = { ...row, id: idMap.get(row.id) }; } await api.assign(row, carOf(p.it)); made.set(p, row.id); }
    } else {
      let id = v === "via" ? made.get(p.viaPlan) : +v; if (id < 0) id = idMap.get(id); if (!id) continue;
      const ev = { kind: p.it.ev, reason: p.it.reason, note: (p.it.at ? `카톡 ${p.it.at.slice(5, 10).replace("-", "/")} ${p.it.at.slice(11, 16)} · ` : "") + p.it.note, end: false };   // 순서가 꼬이지 않게 기록 시각은 반영한 때, 카톡 시각은 메모로
      if (p.it.ev === "change" && p.it.to_change) ev.to_place = resolvePlace(p.it.to_change, places);
      await api.event(id, ev);
    }
    n++;
  }
  return n;
}

// ---- 못 읽은 줄: 배차와 관련 있어 보이는데 요청 · 배차 · 취소 어디에도 안 잡힌 줄(조용히 버리지 않고 보여 줌) ----
const CHATTER = /^(네|넵|예|알겠|감사|확인\s*(했|하였)|수고|안녕|좋은|ㅇㅋ|ok|오케이|사진|파일:|동영상|이모티콘|삭제된 메시지)/i;
function leftoverLines(text, consumed, places) {
  const out = [];
  splitKakao(text).forEach(m => m.lines.forEach(raw => {
    const l = raw.trim(); if (!l || consumed.has(l) || CHATTER.test(l) || /^\[(차주|차량)정보\]/.test(l) || /^그룹\s*넘버/.test(l) || /^[\d,\s]+$/.test(l)) return;
    if (/(입니다\.?)$/.test(l) && !/(plt|파렛|빠렛|배차|출고)/i.test(l)) return;
    const toks = l.replace(/[(),.~\-→>]/g, " ").split(/\s+/).filter(t => placeLike(t, places));
    const meaningful = /(plt|PLT|파렛|빠렛|팔레트|배차|출고|상차|하차|취소|회차|합적|미출고|톤)/.test(l) || toks.length >= 2;
    if (!meaningful) return;
    const pl = l.match(PLT_RE) || l.match(/(\d+(?:\.\d+)?)\s*(?:빠렛트|파렛트|빠레트)/);
    out.push({ line: l, who: m.who, date: m.date || dateHint(l, today()) || today(), from: toks[0] ? resolvePlace(toks[0], places) : "", to: toks[1] ? resolvePlace(toks[1], places) : "", plt: pl ? +pl[1] : null,
      slot: (l.match(/오전|오후|야간/) || [""])[0], temp: /냉동/.test(l) ? "냉동" : /냉장/.test(l) ? "냉장" : "상온" });
  }));
  return out;
}
// 요청 줄 신뢰도: 지점 둘 다 아는 이름 + 수량 있음 → 확실
const knownName = (n, places) => (places || []).some(p => p.name === n);
const reqConf = (r, places) => r._dup || r._loose || r._out ? "yellow" : knownName(r.from_place, places) && knownName(r.to_place, places) && r.plt_qty != null ? "green" : "yellow";
// 요청 표(관리자 · 더한 공용): 칸을 고칠 수 있고, 모르는 지점 이름은 노랗게
function reqTableHtml(reqs, places, { vendorSel = null } = {}) {
  const unk = n => n && !knownName(n, places) ? "unk" : "";
  return `<div class="tbl-wrap imp" style="max-height:none"><table class="tbl"><thead><tr><th><input type="checkbox" class="imp-all" checked aria-label="모두"></th><th>판단</th><th>유형</th><th>운행일</th><th>시간</th><th>상차지</th><th>하차지</th><th>경유</th><th class="r">PLT</th><th>온도</th><th>그룹넘버</th>${vendorSel ? "<th>업체</th>" : ""}<th>메모</th></tr></thead><tbody>
    ${reqs.map((r, i) => { const cf = reqConf(r, places); return `<tr data-i="${i}" class="cf-${cf}${r._dup ? " dup" : ""}"><td><input type="checkbox" class="i-ck" ${r._dup ? "" : "checked"} aria-label="등록"></td>
      <td><span class="conf c-${r._manual ? "red" : cf}" title="${esc(r.src || "")}">${r._manual ? "직접 확인" : r._out ? "2단계(제외)" : r._loose ? "문장 · 확인" : CONF[cf]}</span>${r._time ? `<span class="kmeta" style="display:block">시간 ${esc(r._time)}</span>` : ""}</td>
      <td><select class="i-type">${Object.entries(TYPES).filter(([k]) => k !== "delivery").map(([k, x]) => `<option value="${k}" ${r.type === k ? "selected" : ""}>${x.short}</option>`).join("")}</select></td>
      <td><input type="date" class="i-date" value="${r.run_date}"></td><td><input class="i-slot" list="dl-slot" value="${esc(r.time_slot || "")}" placeholder="-" style="min-width:86px" aria-label="시간"></td>
      <td><input class="i-from ${unk(r.from_place)}" value="${esc(r.from_place)}" list="dl-imp-pl" title="${r._rawFrom && r._rawFrom !== r.from_place ? "카톡 표기: " + esc(r._rawFrom) : ""}"></td>
      <td><input class="i-to ${unk(r.to_place)}" value="${esc(r.to_place)}" list="dl-imp-pl"></td><td><input class="i-via" value="${esc(r.via_place || "")}" style="width:90px"></td>
      <td><input class="i-plt" type="number" step="0.5" value="${r.plt_qty ?? ""}" style="width:64px"></td>
      <td><select class="i-temp">${["상온", "냉장", "냉동"].map(x => `<option ${r.temp === x ? "selected" : ""}>${x}</option>`).join("")}</select></td>
      <td><input class="i-grp" value="${esc(r.group_no || "")}" style="width:110px"></td>${vendorSel ? `<td>${vendorSel(r)}</td>` : ""}
      <td><input class="i-note" value="${esc([r.category, r.cargo_note].filter(Boolean).join(" · "))}">${r._dup ? `<div class="hint warn">이미 있는 요청(#${r._dup.id}) — 체크하면 또 등록</div>` : ""}<div class="src">${esc(r.src || "")}</div></td></tr>`; }).join("")}</tbody></table></div><datalist id="dl-slot">${[...SLOTS, "13시 이후", "10시까지"].map(x => `<option value="${x}">`).join("")}</datalist>
    <datalist id="dl-imp-pl">${(places || []).map(p => `<option value="${esc(p.name)}">`).join("")}</datalist>`;
}
function leftoverHtml(left) {
  if (!left.length) return "";
  return `<div class="leftover"><p class="sec-t" style="margin:12px 0 6px"><span class="conf c-red">못 읽음</span> 배차와 관련 있어 보이지만 자동으로 못 읽은 글 ${left.length}줄 — 필요한 것만 '요청으로'</p>
    ${left.map((x, i) => `<div class="lo-row"><span class="muted">${esc(whoLabel(x.who))}</span> <span class="lo-line">"${esc(x.line)}"</span><button type="button" class="btn sm" data-lo="${i}">요청으로</button></div>`).join("")}</div>`;
}
// 표에서 고친 값 읽기 + 지점 별칭 배우기(카톡 표기 → 고른 지점)
function readReqRows(root, reqs, places) {
  const rows = [], learn = [];
  $$("tbody tr[data-i]", root).forEach(tr => {
    if (!$(".i-ck", tr).checked) return; const r = reqs[+tr.dataset.i]; const g = c => ($(c, tr)?.value || "").trim();
    const from = resolvePlace(g(".i-from"), places), to = resolvePlace(g(".i-to"), places);
    [[r._rawFrom, from], [r._rawTo, to]].forEach(([raw, fin]) => { if (raw && fin && raw !== fin && !knownName(raw, places) && knownName(fin, places)) learn.push([raw, fin]); });
    rows.push({ r, row: { type: g(".i-type"), run_date: g(".i-date"), time_slot: g(".i-slot"), from_place: from, to_place: to, via_place: g(".i-via"), plt_qty: numOrNull(g(".i-plt")), temp: g(".i-temp"), group_no: g(".i-grp"), cargo_note: g(".i-note"),
      ref_code: r.ref_code || "", bid_no: r.bid_no || "", category: r.category || "", pickup_addr: r.pickup_addr || "", pickup_contact: r.pickup_contact || "", requested_by: r.requested_by || "", vendor_id: $(".i-vendor", tr)?.value || null } });
  });
  return { rows: rows.filter(x => x.row.from_place && x.row.to_place && x.row.run_date), learn: [...new Map(learn.map(x => [x[0], x])).values()] };
}
async function learnAliases(learn) {   // 관리자만(지점 표는 관리자 권한)
  let n = 0;
  for (const [raw, fin] of learn) { const p = S.refs.places.find(x => x.name === fin); if (!p || (p.aliases || []).includes(raw)) continue; await Admin.saveRef("places", { ...p, aliases: [...(p.aliases || []), raw] }); n++; }
  return n;
}
// 붙여넣은 글 전체 해석: 출고요청서 표 · 표준 엑셀 · 카톡 요청 · 업체 배차/취소/회차 · 못 읽은 줄
function analyzePaste(text, places, rowsOpen, day) {
  const tpl = parseTemplateRows(text, places), sheet = mergeSheetRows(parseSheetRequests(text, places));
  const reqAll = parseKakaoRequests(text, places), vAll = parseVendorKakao(text);
  const days = [...new Set([...reqAll.map(r => r._mdate), ...vAll.map(x => x.date)].filter(Boolean))].sort();   // 카톡 대화 날짜(내보내기 파일) 기준
  const useDay = day || (days.length > 1 ? days[days.length - 1] : "");
  const inDay = x => { const d0 = x._mdate !== undefined ? x._mdate : x.date; return !useDay || days.length <= 1 || d0 === useDay || !d0; };
  const reqs = [...tpl, ...sheet, ...reqAll.filter(inDay)];
  const vitems = vAll.filter(inDay);
  reqs.forEach(r => { r._dup = rowsOpen.find(d => d.status !== "canceled" && ((r.group_no && String(d.group_no || "").split(",").some(g => r.group_no.split(",").includes(g))) ||
    (d.run_date === r.run_date && sameSpot(d.from_place, r.from_place, places) && sameSpot(d.to_place, r.to_place, places)))) || null; });
  const consumed = new Set([...reqAll.flatMap(r => r._used || [r.src]), ...vAll.flatMap(x => x.src || [])].map(s => String(s).trim()));
  // 요청을 이미 읽은 글의 인사 · 부탁 줄은 못 읽은 줄로 치지 않음
  reqAll.forEach(r => splitKakao(text).forEach(m => { if (m.lines.some(l => l.trim() === r.src)) m.lines.forEach(l => { if (/^(소장님|사장님|안녕|배차\s*부탁|부탁)/.test(l.trim())) consumed.add(l.trim()); }); }));
  const left = tpl.length || sheet.length ? [] : leftoverLines(text, consumed, places).filter(inDay);
  return { reqs, vitems, left, days, day: useDay };
}
const pseudoReqs = reqs => reqs.filter(r => !r._dup).map((r, i) => ({ ...r, id: -(i + 1), status: "requested", _ri: reqs.indexOf(r) }));

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
  if (d.status !== prev.status && ["done", "canceled", "checked"].includes(d.status) && !(d.status === "done" && prev.status === "checked")) evs.push({ at, by: actor, kind: d.status === "done" ? "done" : d.status === "checked" ? "check" : "cancel", ...snapCar(d) });
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
    <p class="sub">카톡방 글이나 쿠팡 출고요청서 표를 그대로 복사해 넣으세요. <b>배차 요청</b>(진천센터~이천점 18plt · 출고요청서 줄)과 <b>업체 글</b>(차주정보 · 취소 · 회차 · 변경)을 알아서 나눕니다. 카톡 '대화 내보내기' 파일(.txt)도 열 수 있습니다. <b>출고요청서 엑셀 파일은 이 칸에 끌어다 놓거나 '파일 열기'</b>로 바로 읽습니다.</p>
    <div class="field"><label for="imp-text" class="hidden">붙여넣을 내용</label><textarea id="imp-text" rows="6" placeholder="[킹콩 기흥 임희숙님] [오후 1:11] 기흥센터-인천점 3plt&#10;기흥센터-청주점 3plt&#10;&#10;또는 출고요청서 표 · 태성 카톡(경기 용인 -> 충남 아산 / [차주정보] … / 그룹넘버 …)"></textarea></div>
    <div class="row" style="margin-top:8px"><button class="btn primary" id="imp-read" type="button">읽기</button>
      <button class="btn sm" id="imp-guide" type="button">입력 양식 안내</button><a class="btn sm" href="배차요청_양식.xlsx" download>엑셀 양식</a>
      <label class="btn sm" style="display:inline-flex;align-items:center">파일 열기<input type="file" id="imp-file" accept=".xlsx,.xls,.xlsm,.csv,.txt,.tsv" hidden></label>
      <label class="row" style="gap:6px;font-size:13px;font-weight:700;color:var(--muted)">날짜 <input type="date" id="imp-day" style="border:1px solid var(--line);border-radius:8px;padding:5px 8px;background:var(--panel)"></label>
      <span class="muted" id="imp-sum"></span></div>
    <div id="imp-out"></div></div>`;
}
// 표 칸에서 고친 값을 다시 그리기 전에 저장(못 읽은 줄을 '요청으로' 추가해도 고친 값이 안 사라지게)
function syncReqs(root, reqs) {
  $$("tbody tr[data-i]", root).forEach(tr => { const r = reqs[+tr.dataset.i]; if (!r) return; const g = c => $(c, tr)?.value ?? "";
    Object.assign(r, { type: g(".i-type") || r.type, run_date: g(".i-date") || r.run_date, time_slot: g(".i-slot"), from_place: g(".i-from"), to_place: g(".i-to"), via_place: g(".i-via"), plt_qty: numOrNull(g(".i-plt")), temp: g(".i-temp") || r.temp, group_no: g(".i-grp"), _note: g(".i-note"), _off: !$(".i-ck", tr)?.checked }); });
}
// 붙여넣기 확인 화면(관리자 · 더한 공용) — mode: "admin" | "vendor"
function pasteReview(root, sumEl, A, mode, onDone) {
  const places = mode === "admin" ? S.refs.places : (V.refs.place_list || (V.refs.places || []).map(n => ({ name: n, aliases: [] })));
  const rowsOpen = (mode === "admin" ? S.rowsAll : V.rows).filter(d => d.status !== "confirmed");
  const reqs = A.reqs, left = A.left;
  reqs.forEach(r => { if (r._seen) return; r._seen = true; if (!inScope(r)) { r._out = true; r._off = true; } if (r._loose) r._off = true; });   // 1단계 밖 · 문장형은 체크 해제로 시작
  const guessVendor = (t, who) => { if (mode !== "admin") return null; const w = vendorCanon(who || ""); return (S.refs.vendors.find(x => w && (w.includes(x.name) || (w.includes("태성") && x.name === "더한물류"))) || S.refs.vendors.find(x => x.types.includes(t)) || {}).id; };
  const vendorSel = mode === "admin" ? r => `<select class="i-vendor"><option value="">미지정</option>${S.refs.vendors.filter(x => x.types.includes(r.type)).map(x => `<option value="${x.id}" ${x.id === guessVendor(r.type, r.vendorName) ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>` : null;
  let plan = [], pseudo = [];
  const draw = () => {
    if ($("tbody tr[data-i]", root)) syncReqs(root, reqs);
    pseudo = pseudoReqs(reqs); plan = buildPlan(A.vitems, rowsOpen, places, pseudo);
    const g = reqs.filter(r => !r._manual && reqConf(r, places) === "green").length + plan.filter(p => p.conf === "green").length;
    const y = reqs.filter(r => r._manual || reqConf(r, places) === "yellow").length + plan.filter(p => p.conf === "yellow").length;
    const rd = left.length + plan.filter(p => p.conf === "red").length;
    sumEl.innerHTML = `요청 ${reqs.length} · 업체 글 ${plan.length}${A.days.length > 1 ? ` (${A.days.length}일 중 ${dLabel(A.day)})` : ""} — <span class="conf c-green">확실 ${g}</span> <span class="conf c-yellow">확인 필요 ${y}</span> <span class="conf c-red">못 읽음 ${rd}</span>`;
    root.innerHTML = (reqs.length ? `<p class="sec-t" style="margin-top:14px">새 배차 요청 ${reqs.length}건 — <b>노란 칸</b>을 확인하세요${mode === "admin" ? ". 지점 이름을 고쳐 고르면 다음부터 그 표기를 자동으로 맞춥니다" : ""}</p>${reqTableHtml(reqs, places, { vendorSel })}` : "")
      + (plan.length ? `<p class="sec-t" style="margin-top:14px">업체 글 ${plan.length}건 — 초록은 그대로, <b>노랑은 연결 칸을 꼭 확인</b></p>${planHtml(plan)}` : "")
      + leftoverHtml(left)
      + (reqs.length || plan.length ? `<div class="row" style="justify-content:flex-end;margin-top:12px"><span class="hint">저장 전에는 아무것도 바뀌지 않습니다</span><button class="btn primary" data-go type="button">선택한 내용 반영</button></div>`
        : left.length ? "" : `<div class="empty">읽을 수 있는 요청 · 배차 글이 없습니다. 예) 진천센터 → 이천점 18plt</div>`);
    reqs.forEach((r, i) => { const tr = $(`tr[data-i="${i}"]`, root); if (tr && r._off) $(".i-ck", tr).checked = false; if (tr && r._note != null) $(".i-note", tr).value = r._note; });
    const all = $(".imp-all", root); if (all) all.onchange = () => $$(".i-ck", root).forEach(c => c.checked = all.checked);
    $$(".i-from,.i-to", root).forEach(inp => inp.oninput = () => inp.classList.toggle("unk", !!inp.value && !knownName(resolvePlace(inp.value, places), places)));
    $$("[data-lo]", root).forEach(b => b.onclick = () => { const x = left.splice(+b.dataset.lo, 1)[0];
      reqs.push({ type: places.find(p => p.name === x.from)?.kind === "쿠팡FC" ? "coupang" : "center", run_date: x.date, time_slot: x.slot, from_place: x.from, to_place: x.to, _rawFrom: x.from, _rawTo: x.to, via_place: "", plt_qty: x.plt, temp: x.temp, group_no: "", cargo_note: "", requested_by: whoLabel(x.who), src: x.line, _manual: true }); draw();
      $(`tr[data-i="${reqs.length - 1}"] .i-from`, root)?.focus(); });
    const go = $("[data-go]", root); if (go) go.onclick = () => apply(go);
  };
  async function apply(go) {
    go.disabled = true; syncReqs(root, reqs);
    const { rows, learn } = readReqRows(root, reqs, places), idMap = new Map(); let nReq = 0, nV = 0, nA = 0;
    try {
      for (const { r, row } of rows) {
        const id = mode === "admin" ? await Admin.save({ ...row, status: "requested", origin: "kingkong", extra_fare: 0, requested_by: row.requested_by || S.user.name || S.user.email }, S.user.email)
          : await Vendor.add({ ...row, status: "requested", requested_by: row.requested_by || "", cargo_note: row.cargo_note || "카톡 요청(더한 등록)" });
        const p = pseudo.find(x => x._ri === reqs.indexOf(r)); if (p && id) idMap.set(p.id, id); nReq++;
      }
      nV = await applyPlan(plan, root, mode === "admin" ? {
        assign: (row, car) => Admin.save({ ...(S.rowsAll.find(d => d.id === row.id) || row), id: row.id, ...car, vendor_id: row.vendor_id || guessVendor(row.type, ""), status: row.status === "done" ? "done" : "assigned" }, S.user.email),
        create: it => Admin.save({ type: it.groups.length ? "coupang" : "center", status: "assigned", origin: "vendor", run_date: it.date || today(), from_place: resolvePlace(it.from || it.region.split(/->|→/)[0] || "?", places),
          to_place: resolvePlace(it.to || (it.region.split(/->|→/)[1] || "?"), places), temp: it.temp || "상온", group_no: it.groups.join(","), extra_fare: 0, vendor_id: guessVendor("coupang", it.who), ...carOf(it) }, S.user.email),
        event: (id, ev) => Admin.event(id, ev, S.user.email),
      } : {
        assign: (row, car) => { const cur = V.rows.find(d => d.id === row.id) || row; return Vendor.save(row.id, { ...car, base_fare: cur.base_fare ?? null, extra_fare: cur.extra_fare || 0, extra_reason: cur.extra_reason || "", status: cur.status === "done" ? "done" : "assigned" }); },
        create: it => Vendor.add({ type: it.groups.length ? "coupang" : "center", run_date: it.date || today(), from_place: resolvePlace(it.from || it.region.split(/->|→/)[0], places), to_place: resolvePlace(it.to || it.region.split(/->|→/)[1] || "?", places),
          plt_qty: null, temp: it.temp || "상온", cargo_note: "", group_no: it.groups.join(","), ...carOf(it), extra_fare: 0, status: "assigned" }),
        event: (id, ev) => Vendor.event(id, ev),
      }, places, idMap);
      if (mode === "admin" && learn.length) nA = await learnAliases(learn);
      toast(`요청 ${nReq}건 등록 · 업체 글 ${nV}건 반영${nA ? ` · 지점 별칭 ${nA}개 기억` : ""} — 다른 화면에도 바로 보입니다`);
      onDone();
    } catch (e) { toast("반영 실패: " + e.message); go.disabled = false; }
  }
  draw();
}

// =====================================================================
//  관리자: 카톡 · 엑셀 붙여넣기
// =====================================================================
function bindImport(v) {
  const ta = $("#imp-text", v), out = $("#imp-out", v), sum = $("#imp-sum", v), dayEl = $("#imp-day", v);
  const take = async f => { if (!f) return; try { ta.value = await fileToText(f); dayEl.value = ""; read(); } catch (err) { toast("파일을 읽지 못했습니다: " + err.message); } };
  $("#imp-file", v).onchange = e => { take(e.target.files[0]); e.target.value = ""; };
  bindFileDrop($(".imp-card", v), take);
  $("#imp-read", v).onclick = () => read();
  $("#imp-guide", v).onclick = () => openGuide("admin");
  dayEl.onchange = () => read();
  function read() {
    if (!ta.value.trim()) return toast("붙여넣을 내용이 없습니다");
    const A = analyzePaste(ta.value, S.refs.places, S.rowsAll.filter(d => d.status !== "confirmed"), dayEl.value);
    if (!dayEl.value && A.days.length > 1) dayEl.value = A.day;
    pasteReview(out, sum, A, "admin", async () => { S.tab = "ledger"; S.filter = { type: "", status: "", vendor: "", q: "", flag: "" }; await reload(); });
  }
}

// =====================================================================
//  더한물류(모바일): 카톡 글을 그대로 붙여넣기 — 킹콩 요청 글 등록 + 배차 · 취소 · 회차 연결을 한 번에
// =====================================================================
function openVendorPaste() {
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "카톡 글 붙여넣기");
  el.innerHTML = `<header><button class="btn ghost" id="px" aria-label="닫기">←</button><h3>카톡 글 붙여넣기</h3></header>
  <div class="body big">
    <p class="hint" style="font-size:14px">단톡방 글을 길게 눌러 복사해 붙여넣으세요. <b>킹콩 요청 글</b>(진천센터~이천점 18plt)은 요청으로 등록하고, <b>배차 · 취소 · 회차 글</b>은 맞는 요청에 연결합니다. 둘을 한꺼번에 넣어도 됩니다.</p>
    <div class="field"><label for="p-text" class="hidden">카톡 글</label><textarea id="p-text" rows="7" placeholder="[킹콩 오태호 부장님] [오후 12:57] 진천센터~이천점&#10;18plt 배차부탁드립니다&#10;&#10;경기 진천 -> 경기 이천&#10;[차주정보] 김민수 / 01012345678&#10;[차량정보] 윙 / 11톤 / 경기89자1234&#10;진천센터 이천점 입니다"></textarea></div>
    <div class="row" style="gap:8px"><button class="btn" id="p-read" type="button" style="min-height:48px;flex:1">읽기</button><label class="btn" style="display:inline-flex;align-items:center;min-height:48px">엑셀 · 파일<input type="file" id="p-file" accept=".xlsx,.xls,.xlsm,.csv,.txt,.tsv" hidden></label></div>
    <p class="hint" id="p-sum"></p><div id="p-out"></div>
  </div>
  <footer><button class="btn" id="px2">닫기</button></footer>`;
  document.body.appendChild(el);
  const close = () => el.remove(); $("#px", el).onclick = close; $("#px2", el).onclick = close;
  const places = V.refs.place_list || (V.refs.places || []).map(n => ({ name: n, aliases: [] }));
  const read = () => { const t = $("#p-text", el).value; if (!t.trim()) return toast("붙여넣을 글이 없습니다");
    pasteReview($("#p-out", el), $("#p-sum", el), analyzePaste(t, places, V.rows.filter(d => d.status !== "confirmed"), ""), "vendor", async () => { close(); await vendorLoad(); }); };
  $("#p-read", el).onclick = read;
  const take = async f => { if (!f) return; try { $("#p-text", el).value = await fileToText(f); read(); } catch (err) { toast("파일을 읽지 못했습니다: " + err.message); } };
  $("#p-file", el).onchange = e => { take(e.target.files[0]); e.target.value = ""; };
  bindFileDrop($(".body", el), take);
  $("#p-text", el).addEventListener("paste", () => setTimeout(read, 50));
}
// =====================================================================
//  매장(모바일) 화면 — 링크 ?s=매장이름 + 매장 PIN
//  종이 배송요청서 · 확인서는 매장에 보관하고, 앱에는 내용 입력 + 영수증 사진만
// =====================================================================
// =====================================================================
//  센터(진천센터 · 2단계 신선센터) — 링크 ?g=진천센터 + PIN. 우리 센터 출발 · 도착 · 우리가 요청한 건만(금액 없음)
// =====================================================================
const Center = {
  name: null, pin: null,
  async login(name, pin) {
    if (!LIVE) { const c = (Demo.load().stores || []).find(x => x.name === name && x.kind === "center" && x.active !== false); if (!c || c.pin !== pin) throw new Error("PIN이 맞지 않습니다"); }
    else { const c = await liveClient(); unwrap(await c.rpc("center_list", { p_name: name, p_pin: pin })); }
    this.name = name; this.pin = pin; try { sessionStorage.setItem("kk_gpin_" + name, pin); localStorage.setItem("kk_gpin_" + name, pin); localStorage.setItem("kk_role", "g:" + name); } catch (_) {}
  },
  async list() {
    if (!LIVE) { const db = Demo.load(), lo = addDays(today(), -60), n = this.name;
      return db.dispatches.filter(d => !d.deleted_at && d.type !== "delivery" && d.run_date >= lo && (d.from_place === n || d.to_place === n || d.orderer === n))
        .map(({ base_fare, extra_fare, extra_reason, return_fare, rate_fare, comments, ...d }) => ({ ...d, vendor: (db.vendors.find(v => v.id === d.vendor_id) || {}).name })).sort((a, b) => b.run_date.localeCompare(a.run_date) || b.id - a.id); }
    const c = await liveClient(); return unwrap(await c.rpc("center_list", { p_name: this.name, p_pin: this.pin }));
  },
  async request(p) {
    if (!p.to_place) throw new Error("도착지를 넣어 주세요"); if (!(+p.plt_qty > 0)) throw new Error("PLT 수량을 넣어 주세요"); if (p.run_date < today()) throw new Error("지난 날짜로는 요청할 수 없습니다");
    if (!LIVE) { const db = Demo.load(); const id = db.nextId++; const now = new Date().toISOString(); const actor = "store:" + this.name; const vd = db.vendors.find(v => v.active && v.types.includes("center"));
      const n = { type: "center", status: "requested", origin: "store", orderer: this.name, vendor_id: vd?.id || null, run_date: p.run_date, time_slot: p.time_slot || "", from_place: p.from_place || this.name, to_place: p.to_place,
        plt_qty: +p.plt_qty, temp: p.temp || "상온", cargo_note: p.cargo_note || "", requested_by: p.requested_by || this.name, extra_fare: 0, id, created_at: now, updated_at: now, updated_by: actor };
      trackLocal(null, n, actor); db.dispatches.push(n); Demo.log(id, actor, "insert", plainRow(n)); Demo.save(); return id; }
    const c = await liveClient(); const id = unwrap(await c.rpc("center_request", { p_name: this.name, p_pin: this.pin, p })); Live.notify(); return id;
  },
  async cancel(id) {
    if (!LIVE) { const db = Demo.load(); const d = db.dispatches.find(x => x.id === id); if (!d || d.status !== "requested" || d.orderer !== this.name) throw new Error("배차가 이미 잡힌 건은 더한물류 · 본사에 연락해 주세요");
      const prev = { ...d }; d.status = "canceled"; d.updated_by = "store:" + this.name; trackLocal(prev, d, "store:" + this.name); Demo.log(id, "store:" + this.name, "update", { status: [prev.status, "canceled"] }); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.rpc("center_cancel", { p_name: this.name, p_pin: this.pin, p_id: id })); Live.notify();
  },
};
const CT = { tab: "mine", rows: [], me: (() => { try { return localStorage.getItem("kk_center_staff") || ""; } catch (_) { return ""; } })() };
async function centerBoot(name) {
  let saved = null; try { saved = sessionStorage.getItem("kk_gpin_" + name) || localStorage.getItem("kk_gpin_" + name); } catch (_) {}
  if (saved) { try { await Center.login(name, saved); return centerLoad(); } catch (_) {} }
  app.innerHTML = `<div class="pin"><div class="card"><div class="brand" style="justify-content:center;margin-bottom:6px"><span class="logo" aria-hidden="true">K</span></div>
    <h2>${esc(name)}</h2><p class="sub">센터 배차 요청 · 진행 확인 · PIN을 넣어 주세요${LIVE ? "" : "<br><span class='muted'>(데모: 진천센터 2468)</span>"}</p>
    <form id="pf"><div class="field"><input id="pin" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus aria-label="PIN"></div>
    <button class="btn primary" style="width:100%;margin-top:12px;min-height:52px;font-size:17px" type="submit">들어가기</button></form><p class="hint" id="err" role="alert"></p></div></div>`;
  $("#pf").onsubmit = async e => { e.preventDefault(); try { await Center.login(name, $("#pin").value.trim()); centerLoad(); } catch (err) { $("#err").textContent = err.message; } };
}
async function centerLoad(quiet) {
  const old = new Map(CT.rows.map(d => [d.id, d]));
  try { CT.rows = await Center.list(); Live.mark();
    const n = Center.name, uniq = a => [...new Set(a.filter(Boolean))].filter(x => x !== n);
    const demoPl = LIVE ? [] : Demo.load().places; CENTER_PLACES.out = uniq([...CT.rows.filter(d => d.from_place === n).map(d => d.to_place), ...demoPl.filter(p => p.kind === "매장").map(p => p.name)]);
    CENTER_PLACES.in = uniq([...CT.rows.filter(d => d.to_place === n).map(d => d.from_place), ...demoPl.filter(p => p.kind === "쿠팡FC" || p.kind === "센터").map(p => p.name)]); } catch (e) { Live.mark(false); if (!quiet) app.innerHTML = `<div class="empty">불러오기 실패: ${esc(e.message)}</div>`; return; }
  const first = !CT.loaded; CT.loaded = true; centerRender(); if (first) whatsNew("center");
  const got = CT.rows.filter(d => old.has(d.id) && d.driver_name && !old.get(d.id).driver_name);
  if (got.length) alertLocal("차량 등록(배차 완료)", got.map(d => `${d.from_place}→${d.to_place} ${dLabel(d.run_date)} ${d.driver_name} ${d.vehicle_no || ""}`).join(" · "));
}
const isMine = d => d.orderer === Center.name && (!CT.me || !d.requested_by || d.requested_by.includes(CT.me) || d.requested_by === Center.name);
function centerRender() {
  const n = Center.name, R = CT.rows, act = d => ["requested", "assigned"].includes(d.status);
  const tabs = [["mine", "내 요청", R.filter(isMine)], ["out", `${n} 출발`, R.filter(d => d.from_place === n)], ["in", `${n} 도착`, R.filter(d => d.to_place === n)], ["all", "전체", R]];
  const L = (tabs.find(t => t[0] === CT.tab) || tabs[0])[2];
  const open = L.filter(act), fin = L.filter(d => !act(d));
  app.innerHTML = `<div class="m">
    <div class="m-head store"><div class="paste-btn"><button class="btn sm bell" id="g-bell">${bellLabel()}</button><button class="btn sm" id="g-man">사용 설명서</button></div>
      <div class="who">킹콩 · ${esc(n)}${modeTag()}${CT.me ? ` · ${esc(CT.me)}` : ""}</div><div class="ttl">센터 배차</div>
      <div class="who">요청 ${R.filter(d => d.status === "requested").length}건 · 배차 완료 ${R.filter(d => d.status === "assigned").length}건 · 오늘 ${R.filter(d => d.run_date === today() && d.status !== "canceled").length}건</div>
      <div class="quick2"><button class="btn primary" id="g-out" type="button"><b>출고 요청</b><small>${esc(n)} → 매장</small></button><button class="btn" id="g-in" type="button"><b>입고 요청</b><small>다른 곳 → ${esc(n)}</small></button></div>
      <div class="m-tabs" role="group" aria-label="보기">${tabs.map(([k, l, X]) => `<button data-gt="${k}" aria-pressed="${CT.tab === k}">${l} ${X.filter(act).length}</button>`).join("")}</div></div>
    <div class="m-list">${open.length ? `<div class="m-date">진행 중 ${open.length}</div>` + open.map(d => centerCard(d)).join("") : ""}${fin.length ? `<div class="m-date">끝난 건 ${fin.length}</div>` + fin.slice(0, 40).map(d => centerCard(d)).join("") : ""}
      ${L.length ? "" : `<div class="empty">${CT.tab === "mine" ? "내가 요청한 건이 없습니다<br><span class='muted'>위의 출고 · 입고 요청으로 시작하세요</span>" : "해당하는 건이 없습니다"}</div>`}</div>
    <p class="build">build ${BUILD} ${syncChipHtml()}</p></div>`;
  $$("[data-gt]").forEach(b => b.onclick = () => { CT.tab = b.dataset.gt; centerRender(); });
  bindBell($("#g-bell"), "center", n, Center.pin); bindSyncChip();
  $("#g-man").onclick = () => openManuals("center");
  $("#g-out").onclick = () => centerForm("out"); $("#g-in").onclick = () => centerForm("in");
  $$(".m-card").forEach(b => b.onclick = () => centerDetail(CT.rows.find(d => d.id === +b.dataset.id)));
}
function centerCard(d) {
  const mine = isMine(d), last = (d.events || []).filter(e => TROUBLE.includes(e.kind) || e.kind === "change").slice(-1)[0];
  return `<button class="m-card t-${d.type}${mine ? " mine" : ""}" data-id="${d.id}">
    <div class="row" style="justify-content:space-between"><span class="row" style="gap:4px">${typeTag(d.type)}${mine ? '<span class="flag mine-flag">내 요청</span>' : d.orderer && d.orderer !== Center.name ? `<span class="flag">${esc(d.orderer)}</span>` : ""}</span><span class="muted">${dLabel(d.run_date)}${d.time_slot ? " · " + esc(d.time_slot) : ""}</span></div>
    <div class="route">${esc(d.from_place)} <span class="arw">→</span> ${esc(d.to_place)}</div>${outSteps(d.status)}
    <div class="meta">${d.plt_qty != null ? `<span><b>${d.plt_qty} PLT</b></span>` : ""}${d.driver_name ? `<span>${esc(d.driver_name)}</span><span>${esc(d.vehicle_no || "")}</span>${d.vehicle_ton ? `<span>${d.vehicle_ton}톤</span>` : ""}` : d.status === "requested" ? "<span>배차 기다리는 중</span>" : ""}${d.group_no ? `<span>그룹 ${esc(d.group_no)}</span>` : ""}${d.cargo_note ? `<span>${esc(d.cargo_note)}</span>` : ""}</div>
    ${last ? `<div class="meta"><span class="evb ${last.kind === "return" ? "ev-r" : last.kind === "change" ? "ev-ch" : "ev-c"}">${esc(EVENT_KINDS[last.kind])}</span><span>${esc(last.reason || last.note || "")}</span></div>` : ""}
  </button>`;
}
function centerDetail(d) {
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "배차 보기");
  el.innerHTML = `<header><button class="btn ghost" id="dx" aria-label="닫기">←</button><h3>${esc(d.from_place)} → ${esc(d.to_place)}</h3></header>
  <div class="body big">${outSteps(d.status, true)}
    <div class="req-box"><b>${dLabel(d.run_date)}${d.time_slot ? " · " + esc(d.time_slot) : ""}</b> · ${d.plt_qty ?? "-"} PLT · ${esc(d.temp || "상온")}${d.cargo_note ? `<br>${esc(d.cargo_note)}` : ""}<br><span class="muted">발주처 ${esc(d.orderer || "킹콩본사")} · 요청 ${esc((d.requested_by || "").replace(/^store:/, ""))}</span></div>
    ${d.driver_name ? `<div class="req-box"><b>차량 등록</b> · ${esc(d.vendor || "")}<br>기사 ${esc(d.driver_name)} ${d.driver_phone ? `<a href="tel:${esc(phoneDigits(d.driver_phone))}">${esc(d.driver_phone)}</a>` : ""} · ${esc(d.vehicle_no || "")} ${d.vehicle_ton ? d.vehicle_ton + "톤" : ""}${esc(d.vehicle_body || "")}</div>` : ""}
    <div><p class="sec-t">진행 기록</p>${timelineHtml(d.events, { compact: true })}</div></div>
  <footer><button class="btn" id="dx2">닫기</button>${d.status === "requested" && d.orderer === Center.name ? `<button class="btn danger" id="dcancel">요청 취소</button>` : ""}<button class="btn primary" id="dagain">같은 내용으로 다시 요청</button></footer>`;
  document.body.appendChild(el);
  const close = () => el.remove(); $("#dx", el).onclick = close; $("#dx2", el).onclick = close;
  $("#dagain", el).onclick = () => { close(); centerForm(d.from_place === Center.name ? "out" : "in", d); };
  const c = $("#dcancel", el); if (c) c.onclick = async () => { if (!confirm("이 요청을 취소할까요?")) return; try { await Center.cancel(d.id); toast("취소했습니다 — 더한물류에 알림"); close(); centerLoad(); } catch (e) { toast(e.message); } };
}
function centerForm(dir, pre) {
  const n = Center.name, t = today(); let date = pre && pre.run_date > t ? pre.run_date : addDays(t, 1), slot = pre?.time_slot || "", plt = pre?.plt_qty || 6, note = pre?.cargo_note || "", who = CT.me;
  let other = pre ? (dir === "out" ? pre.to_place : pre.from_place) : "";
  const recent = [...new Set(CT.rows.filter(d => d.orderer === n).map(d => dir === "out" ? d.to_place : d.from_place).filter(x => x && x !== n))].slice(0, 8);
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "센터 요청");
  const draw = () => {
    el.innerHTML = `<header><button class="btn ghost" id="qx" aria-label="닫기">←</button><h3>${dir === "out" ? "출고 요청" : "입고 요청"}</h3></header>
    <div class="body big">
      <section><p class="sec-t">${dir === "out" ? `${esc(n)} → 어디로` : `어디서 → ${esc(n)}`}</p>
        ${recent.length ? `<div class="chips">${recent.map(x => `<button type="button" data-pl="${esc(x)}" aria-pressed="${x === other}">${esc(x)}</button>`).join("")}</div>` : ""}
        <div class="field" style="margin-top:8px"><label for="q-pl">${dir === "out" ? "도착지(매장)" : "출발지"}</label><input id="q-pl" list="dl-cpl" value="${esc(other)}" placeholder="${dir === "out" ? "이천점" : "여주2 · 시흥3 …"}"></div>
        <datalist id="dl-cpl">${(CENTER_PLACES[dir] || []).map(x => `<option value="${esc(x)}">`).join("")}</datalist></section>
      <section><p class="sec-t">언제</p><div class="chips seg" id="q-day">${[[t, "오늘"], [addDays(t, 1), "내일"], [addDays(t, 2), "모레"]].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${date === v}">${l} ${dLabel(v)}</button>`).join("")}</div>
        <div class="field" style="margin-top:8px"><label for="q-date">다른 날짜</label><input type="date" id="q-date" min="${t}" value="${date}"></div></section>
      <section><p class="sec-t">시간</p><div class="chips seg" id="q-slot">${["", "오전", "오후", "13시 이후", "야간"].map(v => `<button type="button" data-v="${esc(v)}" aria-pressed="${slot === v}">${v || "시간 무관"}</button>`).join("")}</div></section>
      <section><p class="sec-t">파레트(PLT)</p><div class="stepper"><button type="button" id="q-m" aria-label="1 줄이기">−</button><input id="q-plt" type="number" inputmode="decimal" min="0.5" step="0.5" value="${plt}" aria-label="PLT 수량"><button type="button" id="q-p" aria-label="1 늘리기">+</button></div>
        <div class="chips" style="margin-top:8px">${[2, 4, 6, 9, 12, 18, 24].map(x => `<button type="button" data-plt="${x}">${x}</button>`).join("")}</div></section>
      <div class="field"><label for="q-note">특이사항 (선택)</label><input id="q-note" value="${esc(note)}" placeholder="예) 행사 물량 · 지게차 없음 · 13시 이후 하차"></div>
      <div class="field"><label for="q-who">요청자(내 요청 표시용)</label><input id="q-who" value="${esc(who)}" placeholder="이름"></div>
    </div>
    <footer><button class="btn" id="qx2">닫기</button><button class="btn primary" id="qgo">요청 보내기</button></footer>`;
    const close = () => el.remove(); $("#qx", el).onclick = close; $("#qx2", el).onclick = close;
    const keep = () => { plt = +$("#q-plt", el).value || plt; note = $("#q-note", el).value; who = $("#q-who", el).value; other = $("#q-pl", el).value.trim(); };
    $$("[data-pl]", el).forEach(b => b.onclick = () => { keep(); other = b.dataset.pl; draw(); });
    $$("#q-day button", el).forEach(b => b.onclick = () => { keep(); date = b.dataset.v; draw(); });
    $("#q-date", el).onchange = e => { keep(); date = e.target.value; draw(); };
    $$("#q-slot button", el).forEach(b => b.onclick = () => { keep(); slot = b.dataset.v; draw(); });
    const pi = $("#q-plt", el); $("#q-m", el).onclick = () => pi.value = Math.max(0.5, (+pi.value || 0) - 1); $("#q-p", el).onclick = () => pi.value = (+pi.value || 0) + 1;
    $$("[data-plt]", el).forEach(b => b.onclick = () => pi.value = b.dataset.plt);
    $("#qgo", el).onclick = async () => { keep(); CT.me = who.trim(); try { localStorage.setItem("kk_center_staff", CT.me); } catch (_) {}
      const btn = $("#qgo", el); btn.disabled = true;
      try { await Center.request({ run_date: date, time_slot: slot, plt_qty: +plt, temp: "상온", cargo_note: note.trim(), from_place: dir === "out" ? n : other, to_place: dir === "out" ? other : n, requested_by: CT.me ? `${n} ${CT.me}` : n });
        close(); toast(`${dLabel(date)} ${plt}PLT 요청 — 더한물류에 알림이 갔습니다`); CT.tab = "mine"; centerLoad(); }
      catch (e) { btn.disabled = false; toast(e.message); } };
  };
  document.body.appendChild(el); draw();
}
const CENTER_PLACES = { out: [], in: [] };
const ST = { tab: "open", rows: [] };
const STORE_STATUS = { requested: "접수 · 배차 대기", assigned: "배차 완료", done: "배송 완료", confirmed: "배송 완료", canceled: "취소" };
async function storeBoot(name) {
  if (!STORES_OPEN) { app.innerHTML = `<div class="pin"><div class="card"><h2>${esc(name)}</h2><p class="sub">매장 화면은 <b>2단계</b>에 열립니다.<br>지금(1단계)은 킹콩본사 · 진천센터 · 더한물류만 시범 운영 중입니다.<br>배차가 필요하면 진천센터 · 본사 물류 담당에게 요청해 주세요.</p><p class="build">build ${BUILD}</p></div></div>`; return; }
  let saved = null; try { saved = sessionStorage.getItem("kk_spin_" + name) || localStorage.getItem("kk_spin_" + name); } catch (_) {}
  if (saved) { try { await Store.login(name, saved); return storeLoad(); } catch (_) {} }
  app.innerHTML = `<div class="pin"><div class="card"><div class="brand" style="justify-content:center;margin-bottom:6px"><span class="logo" aria-hidden="true">K</span></div>
    <h2>${esc(name)}</h2><p class="sub">고객 배송 요청 · 매장 PIN을 넣어 주세요${LIVE ? "" : "<br><span class='muted'>(데모: 이천점 1111 · 시그니처인천점 2222 · 원주점 3333)</span>"}</p>
    <form id="pf"><div class="field"><input id="pin" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus aria-label="PIN"></div>
    <button class="btn primary" style="width:100%;margin-top:12px;min-height:52px;font-size:17px" type="submit">들어가기</button></form><p class="hint" id="err" role="alert"></p></div></div>`;
  $("#pf").onsubmit = async e => { e.preventDefault(); try { await Store.login(name, $("#pin").value.trim()); storeLoad(); } catch (err) { $("#err").textContent = err.message; } };
}
async function storeLoad(quiet) {
  const old = new Map(ST.rows.map(d => [d.id, d]));
  try { ST.rows = await Store.list(); Live.mark(); } catch (e) { Live.mark(false); if (!quiet) app.innerHTML = `<div class="empty">불러오기 실패: ${esc(e.message)}</div>`; return; }
  storeRender();
  const got = ST.rows.filter(d => old.has(d.id) && d.driver_name && !old.get(d.id).driver_name);
  if (got.length) alertLocal("배차 완료", got.map(d => `${isOut(d) ? `${d.from_place}→ ${d.plt_qty ?? ""}PLT` : d.delivery?.customer_name || ""} ${dLabel(d.run_date)} 기사 ${d.driver_name}`).join(" · "));
}
const STORE_DELIVERY = () => PHASE >= 2 || SHOW_ALL;   // 고객 배송은 2단계
const isOut = d => d.type !== "delivery";
function storeRender() {
  const rows = ST.rows.filter(d => isOut(d) ? inScope(d) : STORE_DELIVERY());
  const open = rows.filter(d => ["requested", "assigned"].includes(d.status)), fin = rows.filter(d => !["requested", "assigned"].includes(d.status));
  const L = ST.tab === "open" ? open : ST.tab === "done" ? fin : rows;
  const recent = lastOut();
  app.innerHTML = `<div class="m">
    <div class="m-head store"><div class="paste-btn"><button class="btn sm bell" id="s-bell">${bellLabel()}</button><button class="btn sm" id="s-man">사용 설명서</button></div><div class="who">킹콩백화점 · ${esc(Store.name)}${modeTag()}</div>
      <div class="ttl">${STORE_DELIVERY() ? "입고 · 배송 요청" : "센터 출고 요청"}</div>
      <div class="who">배차 대기 ${open.filter(d => d.status === "requested").length}건 · 배차 완료 ${open.filter(d => d.status === "assigned").length}건${!LIVE && location.hash.includes("s=") ? ` · <a href="#" id="to-admin" style="color:inherit">관리자 화면으로</a>` : ""}</div>
      <div class="quick2"><button class="btn primary" id="s-quick" type="button"><b>빠른 요청</b><small>${esc(PILOT_FROM)} → ${esc(Store.name)}</small></button>
        <button class="btn" id="s-copy" type="button" ${recent ? "" : "disabled"}><b>최근 요청 복사</b><small>${recent ? `${recent.plt_qty ?? "-"}PLT · ${esc(recent.time_slot || "시간 무관")}` : "아직 요청이 없습니다"}</small></button></div>
      <div class="m-tabs" role="group" aria-label="보기">${[["open", `진행 중 ${open.length}`], ["done", `끝난 요청 ${fin.length}`], ["all", "전체"]].map(([k, l]) => `<button data-st="${k}" aria-pressed="${ST.tab === k}">${l}</button>`).join("")}</div></div>
    <div class="m-list">${L.length ? L.map(d => isOut(d) ? storeOutCard(d) : storeDelCard(d)).join("") : `<div class="empty">요청이 없습니다<br><span class="muted">위의 <b>빠른 요청</b>으로 ${esc(PILOT_FROM)} 출고를 요청하세요</span></div>`}</div>
    <p class="build">build ${BUILD} ${syncChipHtml()}</p>${STORE_DELIVERY() ? `<button class="fab" id="fab">+ 고객 배송 요청</button>` : ""}</div>`;
  $$("[data-st]").forEach(b => b.onclick = () => { ST.tab = b.dataset.st; storeRender(); });
  bindBell($("#s-bell"), "store", Store.name, Store.pin);
  $("#s-man").onclick = () => openManuals("store");
  $("#s-quick").onclick = () => storeQuick();
  $("#s-copy").onclick = () => recent && storeQuick(recent);
  $$(".m-card").forEach(b => b.onclick = () => { const d = ST.rows.find(x => x.id === +b.dataset.id); isOut(d) ? storeOutDetail(d) : storeDetail(d); });
  const f = $("#fab"); if (f) f.onclick = () => storeForm();
  bindSyncChip();
  const ta = $("#to-admin"); if (ta) ta.onclick = e => { e.preventDefault(); location.hash = ""; location.reload(); };
}
const lastOut = () => ST.rows.filter(d => isOut(d) && d.type === "center" && d.status !== "canceled").sort((a, b) => b.id - a.id)[0];
const OUT_STEPS = [["requested", "요청"], ["assigned", "배차"], ["done", "입고 완료"]];
function outSteps(st, big) {
  if (st === "canceled") return `<div class="steps cancel">취소된 요청</div>`;
  const idx = ["checked", "confirmed"].includes(st) ? 2 : OUT_STEPS.findIndex(x => x[0] === st);
  return `<ol class="steps${big ? " big" : ""}" aria-label="진행 단계">${OUT_STEPS.map((x, i) => `<li class="${i < idx || (i === idx && i === 2) ? "ok" : i === idx ? "cur" : ""}">${x[1]}</li>`).join("")}</ol>`;
}
function storeOutCard(d) {
  const last = (d.events || []).filter(e => TROUBLE.includes(e.kind) || e.kind === "change").slice(-1)[0];
  return `<button class="m-card t-${d.type}" data-id="${d.id}">
    <div class="row" style="justify-content:space-between"><span class="row" style="gap:4px">${typeTag(d.type)}${d.origin === "store" ? '<span class="flag st-flag">우리 매장 요청</span>' : ""}</span><span class="muted">${dLabel(d.run_date)}${d.time_slot ? " · " + esc(d.time_slot) : ""}</span></div>
    <div class="route">${esc(d.from_place)} <span class="arw">→</span> ${esc(d.to_place)}</div>${outSteps(d.status)}
    <div class="meta">${d.plt_qty != null ? `<span><b>${d.plt_qty} PLT</b></span>` : ""}${d.driver_name ? `<span>기사 ${esc(d.driver_name)}</span><span>${esc(d.vehicle_no || "")}</span>` : d.status === "requested" ? "<span>배차 기다리는 중</span>" : ""}${d.cargo_note ? `<span>${esc(d.cargo_note)}</span>` : ""}</div>
    ${last ? `<div class="meta"><span class="evb ${last.kind === "return" ? "ev-r" : last.kind === "change" ? "ev-ch" : "ev-c"}">${esc(EVENT_KINDS[last.kind])}</span><span>${esc(last.reason || last.note || "")}</span></div>` : ""}
  </button>`;
}
function storeDelCard(d) {
  const x = d.delivery || {}; const last = (d.events || []).filter(e => TROUBLE.includes(e.kind) || e.kind === "change").slice(-1)[0];
  return `<button class="m-card t-delivery" data-id="${d.id}">
    <div class="row" style="justify-content:space-between"><b>${esc(x.customer_name || "")}</b>${stTag(d.status).replace(esc(STATUS[d.status] || ""), esc(STORE_STATUS[d.status] || ""))}</div>
    <div class="route" style="font-size:16px">${esc(x.product || "")} ${esc(x.qty || "")}</div>${stepHtml(d.status)}
    <div class="meta"><span>${esc((x.address || "").slice(0, 28))}</span></div>
    <div class="meta">${d.status === "requested" ? `<span>희망 ${x.asap ? "최대한 빨리" : dLabel(d.run_date)}</span>` : `<span><b>배송일 ${dLabel(d.run_date)}</b></span>`}${d.driver_name ? `<span>기사 ${esc(d.driver_name)}</span>` : ""}<span>영수증 ${d.receipts || 0}장</span></div>
    ${last ? `<div class="meta"><span class="evb ${last.kind === "return" ? "ev-r" : last.kind === "change" ? "ev-ch" : "ev-c"}">${esc(EVENT_KINDS[last.kind])}</span><span>${esc(last.reason || last.note || "")}</span></div>` : ""}
  </button>`;
}
function storeOutDetail(d) {
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "출고 요청 보기");
  el.innerHTML = `<header><button class="btn ghost" id="dx" aria-label="닫기">←</button><h3>${esc(d.from_place)} → ${esc(d.to_place)}</h3></header>
  <div class="body big">${outSteps(d.status, true)}
    <div class="req-box"><b>${dLabel(d.run_date)}${d.time_slot ? " · " + esc(d.time_slot) : ""}</b> · ${d.plt_qty ?? "-"} PLT · ${esc(d.temp || "상온")}${d.cargo_note ? `<br>${esc(d.cargo_note)}` : ""}<br><span class="muted">요청 ${esc((d.requested_by || "").replace(/^store:/, ""))}</span></div>
    ${d.driver_name ? `<div class="req-box"><b>배차 완료</b> · ${esc(d.vendor || "")}<br>기사 ${esc(d.driver_name)} ${d.driver_phone ? `<a href="tel:${esc(phoneDigits(d.driver_phone))}">${esc(d.driver_phone)}</a>` : ""} · ${esc(d.vehicle_no || "")} ${d.vehicle_ton ? d.vehicle_ton + "톤" : ""}${esc(d.vehicle_body || "")}</div>` : ""}
    <div><p class="sec-t">진행 기록</p>${timelineHtml(d.events, { compact: true })}</div></div>
  <footer><button class="btn" id="dx2">닫기</button>${d.status === "requested" && d.origin === "store" ? `<button class="btn danger" id="dcancel">요청 취소</button>` : ""}${d.type === "center" ? `<button class="btn primary" id="dagain">같은 내용으로 다시 요청</button>` : ""}</footer>`;
  document.body.appendChild(el);
  const close = () => el.remove(); $("#dx", el).onclick = close; $("#dx2", el).onclick = close;
  const ag = $("#dagain", el); if (ag) ag.onclick = () => { close(); storeQuick(d); };
  const c = $("#dcancel", el); if (c) c.onclick = async () => { if (!confirm("이 출고 요청을 취소할까요?")) return; try { await Store.cancel(d.id); toast("취소했습니다"); close(); storeLoad(); } catch (e) { toast(e.message); } };
}
// 빠른 요청 — 날짜 · 시간 · PLT 세 번 누르면 끝. pre 가 있으면 '최근 요청 복사'(날짜는 내일로)
function storeQuick(pre) {
  let staff = ""; try { staff = localStorage.getItem("kk_store_staff") || ""; } catch (_) {}
  const t = today(); let date = pre && pre.run_date > t ? pre.run_date : addDays(t, 1), slot = pre?.time_slot || "", plt = pre?.plt_qty || 6, note = pre?.cargo_note || "";
  if (date < t) date = addDays(t, 1);
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "빠른 요청");
  const draw = () => {
    el.innerHTML = `<header><button class="btn ghost" id="qx" aria-label="닫기">←</button><h3>${pre ? "최근 요청 복사" : "빠른 요청"}</h3></header>
    <div class="body big">
      <div class="req-box"><b>${esc(PILOT_FROM)} → ${esc(Store.name)}</b> · 상온 출고</div>
      <section><p class="sec-t">1. 언제</p><div class="chips seg" id="q-day">${[[t, "오늘"], [addDays(t, 1), "내일"], [addDays(t, 2), "모레"]].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${date === v}">${l} ${dLabel(v)}</button>`).join("")}</div>
        <div class="field" style="margin-top:8px"><label for="q-date">다른 날짜</label><input type="date" id="q-date" min="${t}" value="${date}"></div></section>
      <section><p class="sec-t">2. 입고 시간</p><div class="chips seg" id="q-slot">${["", "오전", "오후", "13시 이후", "야간"].map(v => `<button type="button" data-v="${esc(v)}" aria-pressed="${slot === v}">${v || "시간 무관"}</button>`).join("")}</div>
        <div class="field" style="margin-top:8px"><label for="q-time">시간 직접 (예: 10:30)</label><input type="time" id="q-time" value="${/^\d{1,2}:\d{2}$/.test(slot) ? slot.padStart(5, "0") : ""}"></div></section>
      <section><p class="sec-t">3. 파레트(PLT)</p><div class="stepper"><button type="button" id="q-m" aria-label="1 줄이기">−</button><input id="q-plt" type="number" inputmode="decimal" min="0.5" step="0.5" value="${plt}" aria-label="PLT 수량"><button type="button" id="q-p" aria-label="1 늘리기">+</button></div>
        <div class="chips" style="margin-top:8px">${[2, 4, 6, 12, 18, 24].map(n => `<button type="button" data-plt="${n}">${n}</button>`).join("")}</div></section>
      <div class="field"><label for="q-note">특이사항 (선택)</label><input id="q-note" value="${esc(note)}" placeholder="예) 하차 도크 2번 · 행사 물량 · 지게차 없음"></div>
      <div class="field"><label for="q-who">요청자</label><input id="q-who" value="${esc(staff)}" placeholder="이름"></div>
    </div>
    <footer><button class="btn" id="qx2">닫기</button><button class="btn primary" id="qgo">요청 보내기</button></footer>`;
    const close = () => el.remove(); $("#qx", el).onclick = close; $("#qx2", el).onclick = close;
    $$("#q-day button", el).forEach(b => b.onclick = () => { keep(); date = b.dataset.v; draw(); });
    $("#q-date", el).onchange = e => { keep(); date = e.target.value; draw(); };
    $$("#q-slot button", el).forEach(b => b.onclick = () => { keep(); slot = b.dataset.v; draw(); });
    $("#q-time", el).onchange = e => { keep(); slot = e.target.value; draw(); };
    const pi = $("#q-plt", el);
    $("#q-m", el).onclick = () => pi.value = Math.max(0.5, (+pi.value || 0) - 1);
    $("#q-p", el).onclick = () => pi.value = (+pi.value || 0) + 1;
    $$("[data-plt]", el).forEach(b => b.onclick = () => pi.value = b.dataset.plt);
    $("#qgo", el).onclick = async () => {
      keep(); const who = $("#q-who", el).value.trim(); try { localStorage.setItem("kk_store_staff", who); } catch (_) {}
      const btn = $("#qgo", el); btn.disabled = true;
      try { await Store.request({ run_date: date, time_slot: slot, plt_qty: +plt, temp: "상온", cargo_note: note.trim(), from_place: PILOT_FROM, requested_by: who ? `${Store.name} ${who}` : "" });
        close(); toast(`${dLabel(date)} ${plt}PLT 요청을 보냈습니다 — 더한물류 · 본사에 바로 보입니다`); ST.tab = "open"; storeLoad(); }
      catch (e) { btn.disabled = false; toast(e.message); }
    };
  };
  const keep = () => { const v = $("#q-plt", el)?.value; if (v != null) plt = +v || plt; const n = $("#q-note", el); if (n) note = n.value; const w = $("#q-who", el); if (w) staff = w.value; };
  document.body.appendChild(el); draw();
}
function storeDetail(d) {
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "배송 요청 보기");
  el.innerHTML = `<header><button class="btn ghost" id="dx" aria-label="닫기">←</button><h3>배송 요청 #${d.id}</h3>${stTag(d.status).replace(esc(STATUS[d.status] || ""), esc(STORE_STATUS[d.status] || ""))}</header>
  <div class="body">
    ${stepHtml(d.status, true)}
    ${d.status !== "requested" && d.driver_name ? `<div class="req-box"><b>배송일 ${dLabel(d.run_date)}</b> · ${esc(d.vendor || "")}<br>기사 ${esc(d.driver_name)} ${d.driver_phone ? `<a href="tel:${esc(phoneDigits(d.driver_phone))}">${esc(d.driver_phone)}</a>` : ""} · ${esc(d.vehicle_no || "")}</div>` : ""}
    <div class="card" style="padding:14px">${deliveryDetailHtml(d.delivery, { phoneLink: true })}</div>
    <div><p class="sec-t">진행 기록</p>${timelineHtml(d.events, { compact: true })}</div>
  </div>
  <footer><button class="btn" id="dx2">닫기</button>${d.status === "requested" ? `<button class="btn danger" id="dcancel">요청 취소</button>` : ""}<button class="btn primary" id="dagain">재배송 · 교환 요청</button></footer>`;
  document.body.appendChild(el);
  const close = () => el.remove(); $("#dx", el).onclick = close; $("#dx2", el).onclick = close;
  $("#dagain", el).onclick = () => { close(); storeForm(d); };   // 같은 고객 · 주소 · 제품을 채운 새 요청(영수증은 새로)
  const c = $("#dcancel", el); if (c) c.onclick = async () => { if (!confirm("이 배송 요청을 취소할까요?")) return; try { await Store.cancel(d.id); toast("취소했습니다"); close(); storeLoad(); } catch (e) { toast(e.message); } };
}
// 배송요청서(종이)와 같은 순서 · 같은 칸
function storeForm(pre) {
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
  // 재배송 · 교환: 지난 요청 내용으로 채우기
  if (pre && pre.delivery) { const x = pre.delivery; $("#q-name", el).value = x.customer_name || ""; $("#q-tel", el).value = x.customer_phone || ""; $("#q-addr", el).value = x.address || "";
    $("#q-note", el).value = `재배송 · 교환 (이전 요청 #${pre.id}) `;
    const its = Array.isArray(x.items) && x.items.length ? x.items : [{ name: x.product || "", qty: +x.qty || 1, size: "기본" }]; $("#q-items", el).innerHTML = "";
    its.forEach(it => { addItem(); const r = $$(".item-row", el).slice(-1)[0]; $(".it-name", r).value = it.name || ""; $(".it-qty", r).value = it.qty || 1; $$(".it-size button", r).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === (it.size || "기본")))); });
    toast("이전 요청 내용을 채웠습니다 — 영수증 사진만 새로 붙여 주세요"); }
  // 연락처 자동 하이픈 · 입력하면 오류 표시 지움
  $("#q-tel", el).addEventListener("input", e => { const n = e.target.value.replace(/[^\d]/g, ""); if (/^01\d{8,9}$/.test(n)) e.target.value = n.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1-$2-$3"); });
  el.addEventListener("input", e => clearErr(e.target)); el.addEventListener("click", e => { if (e.target.closest(".seg,.check")) clearErr(e.target); });
  // 영수증 사진
  const photos = [];
  const drawThumbs = () => { $("#q-thumbs", el).innerHTML = photos.map((p, i) => `<div class="thumb"><img src="${p}" alt="영수증 ${i + 1}"><button type="button" data-del="${i}" aria-label="사진 지우기">✕</button></div>`).join("");
    $$("[data-del]", el).forEach(b => b.onclick = () => { photos.splice(+b.dataset.del, 1); drawThumbs(); }); };
  $("#q-photo", el).onchange = async e => { for (const f of e.target.files) { try { photos.push(await shrinkImage(f)); } catch (err) { toast(err.message); } } e.target.value = ""; drawThumbs(); };
  $("#q-send", el).onclick = async () => {
    const g = id => ($("#" + id, el)?.value || "").trim();
    const items = $$(".item-row", el).map(r => ({ name: $(".it-name", r).value.trim(), qty: +$(".it-qty", r).value || 1, size: $(".it-size [aria-pressed='true']", r)?.dataset.v || "기본" })).filter(i => i.name);
    // 칸 옆 오류 안내 — 빠지거나 틀린 칸을 빨갛게 표시하고 첫 칸으로 이동
    $$(".err-msg", el).forEach(x => x.remove()); $$(".err", el).forEach(x => x.classList.remove("err"));
    const errs = [];
    const need = (ok, target, msg) => { if (!ok) errs.push([target, msg]); };
    need(photos.length, $("#q-thumbs", el).parentElement, "영수증 사진을 1장 이상 붙여 주세요");
    need(g("q-name"), $("#q-name", el), "고객 성함을 적어 주세요");
    need(/^01\d-?\d{3,4}-?\d{4}$/.test(g("q-tel")), $("#q-tel", el), g("q-tel") ? "연락처 형식이 맞지 않아요 (010-0000-0000)" : "연락처를 적어 주세요");
    need(g("q-addr"), $("#q-addr", el), "배송지 주소를 적어 주세요");
    need(items.length, $(".it-name", el), "제품명을 1개 이상 적어 주세요");
    need(segVal("q-terms"), $("#q-terms", el), "무료 / 유료 배송을 골라 주세요");
    need($("#q-paper", el).checked, $("#q-paper", el).closest(".check"), "종이 요청서 원본을 매장에 보관해 주세요");
    need($("#q-consent", el).checked, $("#q-consent", el).closest(".check"), "고객 확인서 서명을 받아 주세요");
    if (errs.length) { errs.forEach(([t, m]) => markErr(t, m)); errs[0][0].scrollIntoView({ behavior: "smooth", block: "center" }); return toast(`${errs.length}칸을 확인해 주세요`); }
    if (!/(층|호|동)/.test(g("q-addr")) && !confirm("주소에 동 · 호수 · 층수가 없습니다. 그대로 보낼까요?")) { markErr($("#q-addr", el), "동 · 호수 · 층수를 적으면 배송이 빨라요"); return; }
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


// =====================================================================
//  휴대폰 알림 — 화면이 꺼져 있어도(웹 푸시), 열려 있으면 소리 · 진동
// =====================================================================
const b64u8 = s => { const p = "=".repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };
const Push = {
  ios: () => /iphone|ipad|ipod/i.test(navigator.userAgent),
  supported: () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
  on: () => { try { return localStorage.getItem("kk_push") === "on" && window.Notification && Notification.permission === "granted"; } catch (_) { return false; } },
  async enable(kind, name, pin) {
    if (Push.ios() && !appMode) throw new Error("아이폰은 사파리 아래 공유 버튼 → '홈 화면에 추가' → 그 아이콘으로 연 뒤 다시 눌러 주세요");
    if (!Push.supported()) throw new Error("이 브라우저는 알림을 지원하지 않습니다 — 크롬 · 삼성 인터넷(안드로이드), 사파리 홈 화면 앱(아이폰)으로 열어 주세요");
    const perm = await Notification.requestPermission(); if (perm !== "granted") throw new Error("알림이 차단되어 있습니다 — 브라우저 설정 › 사이트 › 알림에서 허용해 주세요");
    const reg = await navigator.serviceWorker.register("sw.js"); await navigator.serviceWorker.ready;
    if (LIVE && CFG.VAPID_PUBLIC_KEY) {
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u8(CFG.VAPID_PUBLIC_KEY) });
      const c = await liveClient(); unwrap(await c.rpc("push_subscribe", { p_kind: kind, p_name: name || "", p_pin: pin || "", p_sub: sub.toJSON(), p_ua: navigator.userAgent.slice(0, 200) }));
    }
    try { localStorage.setItem("kk_push", "on"); } catch (_) {}
    reg.showNotification("킹콩 배차 알림이 켜졌습니다", { body: LIVE ? "새 요청 · 취소 · 변경 · 질문이 오면 이렇게 알려 드립니다" : "데모 화면이라 실제 알림은 DB 연결(3단계) 뒤부터 옵니다", icon: "icon-192.png" }).catch(() => {});
  },
};
const bellLabel = () => Push.on() ? "알림 켜짐" : "알림 켜기";
function bindBell(btn, kind, name, pin) {
  if (!btn) return; btn.classList.toggle("on", Push.on());
  btn.onclick = async () => { try { await Push.enable(kind, name, pin); btn.textContent = "알림 켜짐"; btn.classList.add("on"); toast("알림을 켰습니다"); } catch (e) { toast(e.message); } };
}
let audioCtx = null;
function beep(urgent) {
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); const t = audioCtx.currentTime;
    (urgent ? [880, 660, 880] : [740, 990]).forEach((f, i) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(.0001, t + i * .18); g.gain.exponentialRampToValueAtTime(.25, t + i * .18 + .02); g.gain.exponentialRampToValueAtTime(.0001, t + i * .18 + .16); o.start(t + i * .18); o.stop(t + i * .18 + .17); });
  } catch (_) {}
}
document.addEventListener("pointerdown", () => { try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch (_) {} }, { once: true });   // 휴대폰은 한 번 누른 뒤에 소리가 남
function alertLocal(title, body, urgent = false) {
  beep(urgent); try { navigator.vibrate && navigator.vibrate(urgent ? [300, 120, 300, 120, 300] : [200, 100, 200]); } catch (_) {}
  actionToast(body, "확인", () => {});
  if (document.visibilityState !== "visible" && window.Notification && Notification.permission === "granted") navigator.serviceWorker?.ready.then(r => r.showNotification(title, { body, icon: "icon-192.png" })).catch(() => {});
}

// ---- 테스트 기간 의견 ----
const Feedback = {
  async add(kind, page, body) {
    const who = kind === "vendor" ? "vendor:" + Vendor.name : kind === "store" ? "store:" + Store.name : kind === "checker" ? "checker:" + Checker.name : (S.user?.email || "관리자");
    if (!LIVE) { const db = Demo.load(); (db.feedback ||= []).push({ id: Date.now(), at: new Date().toISOString(), who, page, body }); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.rpc("feedback_add", { p_kind: kind === "admin" ? "staff" : kind, p_name: kind === "vendor" ? Vendor.name : kind === "store" ? Store.name : kind === "checker" ? Checker.name : "", p_pin: kind === "vendor" ? Vendor.pin : kind === "store" ? Store.pin : kind === "checker" ? Checker.pin : "", p_page: page, p_body: body }));
  },
  async list() { if (!LIVE) return (Demo.load().feedback || []).slice().reverse(); const c = await liveClient(); return unwrap(await c.from("feedback").select("*").order("at", { ascending: false }).limit(200)); },
  async done(id) { if (!LIVE) { const f = (Demo.load().feedback || []).find(x => x.id === id); if (f) f.done_at = new Date().toISOString(); Demo.save(); return; } const c = await liveClient(); unwrap(await c.from("feedback").update({ done_at: new Date().toISOString() }).eq("id", id)); },
};
function openFeedback(kind) {
  if ((kind === "vendor" && !Vendor.name) || (kind === "store" && !Store.name) || (kind === "checker" && !Checker.name)) return toast("PIN을 넣고 들어간 뒤 남겨 주세요");
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "의견 남기기");
  el.innerHTML = `<header><button class="btn ghost" id="fbx" aria-label="닫기">←</button><h3>의견 남기기</h3></header><div class="body big">
    <p class="hint" style="font-size:14px">테스트 기간에 불편한 점 · 틀리게 들어간 건 · 카톡과 다른 점을 적어 주세요. 관리자 '설정' 화면에 모입니다.</p>
    <div class="chips" id="fb-k">${["불편해요", "틀리게 들어갔어요", "알림이 안 와요", "이런 기능이 있으면"].map(x => `<button type="button" data-k="${x}" aria-pressed="false">${x}</button>`).join("")}</div>
    <div class="field"><label for="fb-body">내용</label><textarea id="fb-body" rows="5" placeholder="예) 11/4 진천센터→이천점 요청이 두 번 들어갔어요"></textarea></div></div>
    <footer><button class="btn" id="fbx2">닫기</button><button class="btn primary" id="fb-go">보내기</button></footer>`;
  document.body.appendChild(el); const close = () => el.remove(); $("#fbx", el).onclick = close; $("#fbx2", el).onclick = close;
  let k = ""; $$("#fb-k button", el).forEach(b => b.onclick = () => { k = b.dataset.k; $$("#fb-k button", el).forEach(x => x.setAttribute("aria-pressed", String(x === b))); });
  $("#fb-go", el).onclick = async () => { const body = $("#fb-body", el).value.trim(); if (!body && !k) return toast("내용을 적어 주세요");
    try { await Feedback.add(kind, location.search + location.hash, [k, body].filter(Boolean).join(" · ")); close(); toast("고맙습니다 — 의견을 보냈습니다"); } catch (e) { toast(e.message); } };
}

// =====================================================================
//  A. 자주 쓰는 구간으로 바로 요청(센터 · 본사 요청자) — 최근 60일 요청에서 많이 쓴 구간 · 최근 요청을 한 번에 다시
// =====================================================================
S.basket = [];
function laneStats() {
  const lo = addDays(today(), -60), L = S.rowsAll.filter(d => d.type !== "delivery" && d.origin !== "vendor" && d.run_date >= lo);
  const m = new Map();
  L.forEach(d => { const k = [d.type, d.from_place, d.to_place].join("|"); const x = m.get(k) || { type: d.type, from_place: d.from_place, to_place: d.to_place, n: 0, plts: {}, temps: {}, slots: {}, last: "" };
    x.n++; x.plts[d.plt_qty ?? ""] = (x.plts[d.plt_qty ?? ""] || 0) + 1; x.temps[d.temp || "상온"] = (x.temps[d.temp || "상온"] || 0) + 1; x.slots[d.time_slot || ""] = (x.slots[d.time_slot || ""] || 0) + 1; if (d.run_date > x.last) x.last = d.run_date; m.set(k, x); });
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  return [...m.values()].map(x => ({ ...x, plt: numOrNull(top(x.plts)), temp: top(x.temps) || "상온", slot: top(x.slots) })).sort((a, b) => b.n - a.n);
}
function quickCardHtml() {
  const lanes = laneStats().slice(0, 10);
  const recent = [...S.rowsAll].filter(d => d.type !== "delivery" && d.origin !== "vendor" && d.status !== "canceled").sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || b.id - a.id).slice(0, 6);
  return `<div class="card quick"><h2>자주 쓰는 구간으로 바로 요청</h2><p class="sub">누르면 아래 목록에 담깁니다. 날짜 · PLT만 확인하고 '요청 보내기' — 매일 같은 구간은 한 번 누르면 끝.</p>
    <div class="chips" id="qk-lanes">${lanes.map((x, i) => `<button type="button" data-lane="${i}" class="t-${x.type}"><b>${esc(x.from_place)} → ${esc(x.to_place)}</b><small>${x.plt ?? "-"}plt${x.temp !== "상온" ? " " + x.temp : ""} · ${x.n}회</small></button>`).join("") || '<span class="muted">요청이 쌓이면 여기에 자주 쓰는 구간이 생깁니다</span>'}</div>
    ${recent.length ? `<p class="sec-t" style="margin-top:12px">최근 요청 다시 보내기</p><div class="chips" id="qk-recent">${recent.map(d => `<button type="button" data-rid="${d.id}" class="t-${d.type}"><b>${esc(d.from_place)} → ${esc(d.to_place)}</b><small>${dLabel(d.run_date)} · ${d.plt_qty ?? "-"}plt</small></button>`).join("")}</div>` : ""}
    <div id="qk-basket"></div></div>`;
}
function bindQuick(v) {
  const lanes = laneStats().slice(0, 10), box = $("#qk-basket", v), tm = addDays(today(), 1);
  const add = x => { S.basket.push({ type: x.type, from_place: x.from_place, to_place: x.to_place, plt_qty: x.plt ?? x.plt_qty ?? null, temp: x.temp || "상온", time_slot: x.slot ?? x.time_slot ?? "", run_date: S.basket.slice(-1)[0]?.run_date || tm, via_place: x.via_place || "", cargo_note: x.cargo_note || "", group_no: "" }); draw(); };
  $$("[data-lane]", v).forEach(b => b.onclick = () => add(lanes[+b.dataset.lane]));
  $$("[data-rid]", v).forEach(b => b.onclick = () => add(S.rowsAll.find(d => d.id === +b.dataset.rid)));
  function draw() {
    if (!S.basket.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<p class="sec-t" style="margin-top:14px">보낼 요청 ${S.basket.length}건</p><div class="basket">${S.basket.map((r, i) => `<div class="brow t-${r.type}" data-bi="${i}">
      <input type="date" value="${r.run_date}" data-k="run_date" aria-label="운행일"><select data-k="time_slot" aria-label="시간대"><option value="">-</option>${SLOTS.map(x => `<option ${r.time_slot === x ? "selected" : ""}>${x}</option>`).join("")}</select>
      <span class="broute">${typeTag(r.type)} <b>${esc(r.from_place)} → ${esc(r.to_place)}</b></span>
      <label class="bplt"><input type="number" step="0.5" inputmode="decimal" value="${r.plt_qty ?? ""}" data-k="plt_qty" aria-label="PLT">plt</label>
      <select data-k="temp" aria-label="온도">${["상온", "냉장", "냉동"].map(x => `<option ${r.temp === x ? "selected" : ""}>${x}</option>`).join("")}</select>
      <button type="button" class="btn ghost sm" data-del="${i}" aria-label="빼기">✕</button></div>`).join("")}</div>
      <div class="row" style="justify-content:flex-end;margin-top:10px"><label class="check" style="font-size:14px"><input type="checkbox" id="qk-kakao" checked> 보낸 뒤 카톡 문구도 복사</label><button class="btn" id="qk-clear" type="button">비우기</button><button class="btn primary" id="qk-send" type="button">${S.basket.length}건 요청 보내기</button></div>`;
    $$("[data-k]", box).forEach(inp => inp.onchange = () => { const r = S.basket[+inp.closest("[data-bi]").dataset.bi], k = inp.dataset.k; r[k] = k === "plt_qty" ? numOrNull(inp.value) : inp.value; inp.classList.remove("err"); });
    $$("[data-del]", box).forEach(b => b.onclick = () => { S.basket.splice(+b.dataset.del, 1); draw(); });
    $("#qk-clear", box).onclick = () => { S.basket = []; draw(); };
    $("#qk-send", box).onclick = async () => {
      const bad = S.basket.map((r, i) => (!r.run_date || r.run_date < today()) ? i : -1).filter(i => i >= 0);
      if (bad.length) { bad.forEach(i => $(`[data-bi="${i}"] [data-k="run_date"]`, box).classList.add("err")); return toast("운행일을 확인해 주세요(지난 날짜)"); }
      const rows = S.basket.map(r => ({ ...r, status: "requested", origin: "kingkong", extra_fare: 0, requested_by: S.user.name || S.user.email, vendor_id: (S.refs.vendors.find(x => x.types.includes(r.type)) || {}).id || null }));
      $("#qk-send", box).disabled = true;
      try { for (const r of rows) await Admin.save(r, S.user.email); const copy = $("#qk-kakao", box).checked; S.basket = []; await reload();
        toast(`${rows.length}건 요청을 보냈습니다 — 더한물류 화면에 바로 보입니다`); if (copy) actionToast("카톡방에도 요청 문구를 보낼까요?", "카톡 문구 복사", () => shareText(kakaoReqText(rows)));
      } catch (e) { toast("저장 실패: " + e.message); $("#qk-send", box).disabled = false; }
    };
  }
  draw();
}

// =====================================================================
//  B. 매장: 진행 단계 · 칸 옆 오류
// =====================================================================
function stepHtml(st, big = false) {
  if (st === "canceled") return `<div class="steps cancel">취소된 요청</div>`;
  const steps = [["requested", "접수"], ["assigned", "배차"], ["done", "배송 완료"]];
  const idx = st === "confirmed" ? 2 : steps.findIndex(s => s[0] === st);
  return `<ol class="steps${big ? " big" : ""}" aria-label="진행 단계">${steps.map((s, i) => `<li class="${i < idx || (i === idx && i === 2) ? "ok" : i === idx ? "cur" : ""}">${s[1]}</li>`).join("")}</ol>`;
}
function markErr(target, msg) { if (!target) return; target.classList.add("err"); const m = document.createElement("div"); m.className = "err-msg"; m.textContent = msg; target.insertAdjacentElement("afterend", m); }
function clearErr(t) { const box = t.closest(".err") || (t.classList?.contains("err") ? t : null) || t.closest("section")?.querySelector(".err"); if (!box) return; box.classList.remove("err"); if (box.nextElementSibling?.classList.contains("err-msg")) box.nextElementSibling.remove(); }

// =====================================================================
//  D. 더한물류: 오늘(내일) 입력할 건을 한 화면에서 — 칸을 누른 뒤 '최근 기사'를 누르면 기사 · 차량 · 톤 · 차종이 한 번에
// =====================================================================
function openBatch() {
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "한 번에 입력");
  let day = "today"; let active = null;
  const drivers = recentDrivers().slice(0, 10);
  const list = () => { const t = today(); return V.rows.filter(d => d.status !== "canceled" && d.status !== "confirmed" && needsInput(d) && (day === "all" || (day === "today" ? d.run_date <= t : d.run_date === addDays(t, 1)))).sort((a, b) => a.run_date.localeCompare(b.run_date) || a.id - b.id); };
  const render2 = () => {
    const L = list();
    el.innerHTML = `<header><button class="btn ghost" id="bx" aria-label="닫기">←</button><h3>한 번에 입력</h3></header>
    <div class="body">
      <div class="m-days" style="padding:0">${[["today", "오늘까지"], ["tomorrow", "내일"], ["all", "입력 필요 전체"]].map(([k, l]) => `<button data-day="${k}" aria-pressed="${day === k}">${l}</button>`).join("")}</div>
      <div class="drv-bar"><p class="sec-t" style="margin:0 0 6px">최근 기사 — 아래 건을 먼저 누르고, 기사를 누르세요</p><div class="chips">${drivers.map((x, i) => `<button type="button" data-drv="${i}"><b>${esc(x.driver_name)}</b><small>${x.vehicle_ton ? x.vehicle_ton + "톤 " : ""}${esc(x.vehicle_body || "")}</small></button>`).join("") || '<span class="muted">아직 기록이 없습니다 — 이름을 직접 쓰면 다음부터 여기에 나옵니다</span>'}</div></div>
      ${L.length ? L.map(d => { const r = rateHint(d); return `<div class="bcard t-${d.type}" data-id="${d.id}" tabindex="0">
        <div class="row" style="justify-content:space-between"><span>${typeTag(d.type)} <span class="muted">${dLabel(d.run_date)} ${esc(d.time_slot || "")}</span></span><span class="muted">${d.plt_qty != null ? d.plt_qty + "PLT" : ""}${d.group_no ? " · 그룹 " + esc(d.group_no) : ""}</span></div>
        <div class="kroute">${esc(d.from_place)} → ${esc(d.type === "delivery" ? (d.delivery?.address || "고객") : d.to_place)}</div>
        <div class="bfields"><input data-f="driver_name" value="${esc(d.driver_name || "")}" placeholder="기사" list="dl-bdrv" aria-label="기사"><input data-f="vehicle_no" value="${esc(d.vehicle_no || "")}" placeholder="차량번호" aria-label="차량번호">
          <select data-f="vehicle_ton" aria-label="톤수"><option value="">톤</option>${TONS.map(x => `<option value="${x}" ${+d.vehicle_ton === x ? "selected" : ""}>${x}톤</option>`).join("")}</select>
          <input data-f="base_fare" type="number" inputmode="numeric" value="${d.base_fare ?? ""}" placeholder="${r ? "운임 " + won(r) : "기본운임"}" aria-label="기본운임"></div>
        <input type="hidden" data-f="vehicle_body" value="${esc(d.vehicle_body || "")}"><input type="hidden" data-f="driver_phone" value="${esc(d.driver_phone || "")}"></div>`; }).join("") : `<div class="empty">입력할 건이 없습니다</div>`}
      <datalist id="dl-bdrv">${drivers.map(x => `<option value="${esc(x.driver_name)}">`).join("")}</datalist>
    </div>
    <footer><button class="btn" id="bx2">닫기</button><button class="btn primary" id="bsave">입력한 건 저장</button></footer>`;
    $("#bx", el).onclick = $("#bx2", el).onclick = () => el.remove();
    $$("[data-day]", el).forEach(b => b.onclick = () => { day = b.dataset.day; active = null; render2(); });
    const fill = (card, p) => { const set = (f, v2) => { const i = $(`[data-f="${f}"]`, card); if (i && (f === "driver_name" || !i.value)) i.value = v2 ?? ""; };
      set("driver_name", p.driver_name); $(`[data-f="vehicle_no"]`, card).value = p.vehicle_no || ""; $(`[data-f="vehicle_ton"]`, card).value = p.vehicle_ton ?? ""; $(`[data-f="vehicle_body"]`, card).value = p.vehicle_body || ""; $(`[data-f="driver_phone"]`, card).value = p.driver_phone || "";
      card.classList.add("filled"); };
    $$(".bcard", el).forEach(c => { c.addEventListener("focusin", () => { active = c; $$(".bcard", el).forEach(x => x.classList.toggle("active", x === c)); }); c.onclick = () => { active = c; $$(".bcard", el).forEach(x => x.classList.toggle("active", x === c)); };
      $(`[data-f="driver_name"]`, c).onchange = e => { const p = drivers.find(x => x.driver_name === e.target.value.trim()); if (p) fill(c, p); }; });
    $$("[data-drv]", el).forEach(b => b.onclick = () => { const cards = $$(".bcard", el); const target = active || cards.find(c => !$(`[data-f="driver_name"]`, c).value); if (!target) return toast("먼저 건을 눌러 주세요");
      fill(target, drivers[+b.dataset.drv]); const next = cards[cards.indexOf(target) + 1]; active = next && !$(`[data-f="driver_name"]`, next).value ? next : null; $$(".bcard", el).forEach(x => x.classList.toggle("active", x === active)); active?.scrollIntoView({ block: "center", behavior: "smooth" }); });
    $("#bsave", el).onclick = async () => {
      const todo = $$(".bcard", el).map(c => { const d = V.rows.find(x => x.id === +c.dataset.id); const g = f => $(`[data-f="${f}"]`, c).value.trim();
        return { d, c, p: { driver_name: g("driver_name"), driver_phone: g("driver_phone"), vehicle_no: g("vehicle_no"), vehicle_ton: numOrNull(g("vehicle_ton")), vehicle_body: g("vehicle_body"), base_fare: numOrNull(g("base_fare")) ?? d.base_fare ?? null, extra_fare: d.extra_fare || 0, extra_reason: d.extra_reason || "", status: d.status === "done" ? "done" : "assigned" } }; })
        .filter(x => x.p.driver_name && (x.p.driver_name !== (x.d.driver_name || "") || x.p.vehicle_no !== (x.d.vehicle_no || "") || x.p.base_fare !== (x.d.base_fare ?? null)));
      if (!todo.length) return toast("바뀐 건이 없습니다 — 기사를 넣어 주세요");
      const noCar = todo.filter(x => !x.p.vehicle_no); noCar.forEach(x => $(`[data-f="vehicle_no"]`, x.c).classList.add("err"));
      if (noCar.length && !confirm(`차량번호가 빈 건이 ${noCar.length}건 있습니다. 그대로 저장할까요?`)) return;
      $("#bsave", el).disabled = true; let ok = 0;
      for (const x of todo) { try { await Vendor.save(x.d.id, x.p); ok++; x.c.classList.add("saved"); } catch (e) { x.c.classList.add("err"); toast(`#${x.d.id} 저장 실패: ${e.message}`); } }
      const saved = todo.filter(x => x.c.classList.contains("saved")).map(x => ({ ...x.d, ...x.p }));
      el.remove(); await vendorLoad();
      actionToast(`${ok}건 저장했습니다 · 단톡방에도 알릴까요?`, "카톡 보내기", () => shareText(saved.map(kakaoDoneText).join("\n\n")));
    };
  };
  document.body.appendChild(el); render2();
}

// =====================================================================
//  본사 확인 담당자(모바일 · PC) — 링크 ?c=이름 + PIN. 운행 완료 건을 보고 '확인'하면 최종 완료
// =====================================================================
const Checker = {
  name: null, pin: null,
  async login(name, pin) {
    if (!LIVE) { const c = (Demo.load().checkers || []).find(x => x.name === name && x.active !== false); if (!c || c.pin !== pin) throw new Error("PIN이 맞지 않습니다"); }
    else { const c = await liveClient(); unwrap(await c.rpc("checker_list", { p_name: name, p_pin: pin })); }
    this.name = name; this.pin = pin; try { sessionStorage.setItem("kk_cpin_" + name, pin); localStorage.setItem("kk_cpin_" + name, pin); localStorage.setItem("kk_role", "c:" + name); } catch (_) {}
  },
  async list() {
    if (!LIVE) { const db = Demo.load(); const lo = addDays(today(), -45);
      return db.dispatches.filter(d => !d.deleted_at && d.run_date >= lo && ["assigned", "done", "checked", "confirmed"].includes(d.status)).map(d => ({ ...d, vendor: (db.vendors.find(v => v.id === d.vendor_id) || {}).name })).sort((a, b) => b.run_date.localeCompare(a.run_date) || b.id - a.id); }
    const c = await liveClient(); return unwrap(await c.rpc("checker_list", { p_name: this.name, p_pin: this.pin }));
  },
  async confirm(ids) {
    const actor = "checker:" + this.name;
    if (!LIVE) { const db = Demo.load(); let n = 0; db.dispatches.forEach(d => { if (ids.includes(d.id) && d.status === "done") { const prev = JSON.parse(JSON.stringify(d)); Object.assign(d, { status: "checked", checked_at: new Date().toISOString(), checked_by: actor, updated_by: actor, updated_at: new Date().toISOString() }); trackLocal(prev, d, actor); Demo.logChange(d.id, actor, prev, d); n++; } }); Demo.save(); return n; }
    const c = await liveClient(); const n = unwrap(await c.rpc("checker_confirm", { p_name: this.name, p_pin: this.pin, p_ids: ids })); Live.notify(); return n;
  },
  async undo(id) {
    const actor = "checker:" + this.name;
    if (!LIVE) { const db = Demo.load(); const d = db.dispatches.find(x => x.id === id); if (d.status !== "checked") throw new Error("정산 확정된 건은 되돌릴 수 없습니다"); const prev = JSON.parse(JSON.stringify(d)); Object.assign(d, { status: "done", checked_at: null, checked_by: null, updated_by: actor }); Demo.logChange(id, actor, prev, d); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.rpc("checker_undo", { p_name: this.name, p_pin: this.pin, p_id: id })); Live.notify();
  },
  async comment(id, body) {
    const actor = "checker:" + this.name;
    if (!LIVE) { const db = Demo.load(); const d = db.dispatches.find(x => x.id === id); (d.comments ||= []).push({ id: Date.now(), at: new Date().toISOString(), author: actor, kind: "question", body }); Demo.log(id, actor, "insert", { kind: "question", body }, "dispatch_comments"); Demo.save(); return; }
    const c = await liveClient(); unwrap(await c.rpc("checker_comment", { p_name: this.name, p_pin: this.pin, p_id: id, p_body: body })); Live.notify();
  },
};
const CK = { tab: "todo", day: "all", rows: [], sel: new Set() };
async function checkerBoot(name) {
  let saved = null; try { saved = sessionStorage.getItem("kk_cpin_" + name) || localStorage.getItem("kk_cpin_" + name); } catch (_) {}
  if (saved) { try { await Checker.login(name, saved); return checkerLoad(); } catch (_) {} }
  app.innerHTML = `<div class="pin"><div class="card"><div class="brand" style="justify-content:center;margin-bottom:6px"><span class="logo" aria-hidden="true">K</span></div>
    <h2>${esc(name)} · 배차 확인</h2><p class="sub">운행 완료 건을 확인해 최종 완료합니다 · PIN을 넣어 주세요${LIVE ? "" : "<br><span class='muted'>(데모: 본사물류 4321)</span>"}</p>
    <form id="pf"><div class="field"><input id="pin" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus aria-label="PIN"></div>
    <button class="btn primary" style="width:100%;margin-top:12px;min-height:52px;font-size:17px" type="submit">들어가기</button></form><p class="hint" id="err" role="alert"></p></div></div>`;
  $("#pf").onsubmit = async e => { e.preventDefault(); try { await Checker.login(name, $("#pin").value.trim()); checkerLoad(); } catch (err) { $("#err").textContent = err.message; } };
}
async function checkerLoad(quiet) {
  const old = new Set(CK.rows.filter(d => d.status === "done").map(d => d.id));
  try { CK.rows = (await Checker.list()).filter(inScope); Live.mark(); } catch (e) { Live.mark(false); if (!quiet) app.innerHTML = `<div class="empty">불러오기 실패: ${esc(e.message)}</div>`; return; }
  const was = CK.loaded; CK.loaded = true; checkerRender();
  const fresh = CK.rows.filter(d => d.status === "done" && !old.has(d.id));
  if (was && fresh.length) alertLocal("확인 대기", `운행 완료 ${fresh.length}건이 확인을 기다립니다`);
}
function checkerRender() {
  const t = today();
  const todo = CK.rows.filter(d => d.status === "done"), fin = CK.rows.filter(d => ["checked", "confirmed"].includes(d.status)), run = CK.rows.filter(d => d.status === "assigned");
  const L0 = CK.tab === "todo" ? todo : CK.tab === "done" ? fin : CK.tab === "run" ? run : CK.rows;
  const L = L0.filter(d => CK.day === "all" || (CK.day === "today" ? d.run_date === t : CK.day === "yday" ? d.run_date === addDays(t, -1) : d.run_date < addDays(t, -1)));
  CK.sel.forEach(id => { if (!L.some(d => d.id === id && d.status === "done")) CK.sel.delete(id); });
  const groups = {}; L.forEach(d => (groups[d.run_date] ||= []).push(d));
  const sumTodo = todo.reduce((a, d) => a + cost(d), 0);
  app.innerHTML = `<div class="m">
    <div class="m-head chk"><div class="who">킹콩백화점 배차 확인 · ${esc(Checker.name)}${modeTag()}</div>
      <div class="ttl">${todo.length ? `확인할 운행 ${todo.length}건` : "확인할 운행이 없습니다"}</div>
      <div class="who">확인 대기 금액 ${won(sumTodo)}원 · 운행 완료 → <b>확인(최종 완료)</b> → 정산 확정</div>
      <div class="paste-btn"><button class="btn sm bell" id="c-bell">${bellLabel()}</button><button class="btn sm" id="c-man">사용 설명서</button></div>
      <div class="m-tabs" role="group" aria-label="보기">${[["todo", `확인 대기 ${todo.length}`], ["run", `운행 중 ${run.length}`], ["done", `확인 완료 ${fin.length}`], ["all", "전체"]].map(([k, l]) => `<button data-ct="${k}" aria-pressed="${CK.tab === k}">${l}</button>`).join("")}</div></div>
    <div class="m-days" role="group" aria-label="날짜">${[["all", "전체"], ["today", "오늘"], ["yday", "어제"], ["older", "그 전"]].map(([k, l]) => `<button data-cd="${k}" aria-pressed="${CK.day === k}">${l}</button>`).join("")}</div>
    <div class="m-list">${Object.keys(groups).sort((a, b) => b.localeCompare(a)).map(dd => `<div class="m-date">${dLabel(dd)}${dd === t ? " · 오늘" : ""}${CK.tab === "todo" ? ` <button class="btn sm ghost" data-allday="${dd}">이 날 모두 선택</button>` : ""}</div>` + groups[dd].map(d => `
      <div class="m-card ck-card t-${d.type}${CK.sel.has(d.id) ? " sel" : ""}" data-id="${d.id}">
        <div class="row" style="justify-content:space-between"><span class="row" style="gap:4px">${typeTag(d.type)}${evBadges(d)}${qBadge(d)}${d.origin === "sheet" ? '<span class="flag sh-flag">시트</span>' : ""}</span>
          ${d.status === "done" ? `<label class="ckbox"><input type="checkbox" class="cck" value="${d.id}" ${CK.sel.has(d.id) ? "checked" : ""} aria-label="선택"></label>` : stTag(d.status)}</div>
        <div class="route">${esc(d.from_place)} <span class="arw">→</span> ${esc(d.type === "delivery" ? (d.delivery?.customer_name ? d.delivery.customer_name + " 고객" : "고객") : d.to_place)}</div>
        <div class="meta">${d.plt_qty != null ? `<span>${d.plt_qty} PLT</span>` : ""}${d.driver_name ? `<span>${esc(d.driver_name)} · ${esc(d.vehicle_no || "")}</span>` : ""}${d.vehicle_ton ? `<span>${d.vehicle_ton}톤 ${esc(d.vehicle_body || "")}</span>` : ""}<span class="amt">${d.base_fare ? won(cost(d)) + "원" : "금액 전"}</span>${d.extra_reason ? `<span>추가: ${esc(d.extra_reason)}</span>` : ""}</div>
      </div>`).join("")).join("") || `<div class="empty">해당하는 운행이 없습니다</div>`}</div>
    <p class="build">build ${BUILD} ${syncChipHtml()}</p>
    <div class="ck-bar" ${CK.sel.size ? "" : "hidden"}><b>${CK.sel.size}건 선택</b><button class="btn" id="ck-clear">해제</button><button class="btn primary" id="ck-ok">확인(최종 완료)</button></div></div>`;
  bindSyncChip();
  $$("[data-ct]").forEach(b => b.onclick = () => { CK.tab = b.dataset.ct; checkerRender(); });
  $$("[data-cd]").forEach(b => b.onclick = () => { CK.day = b.dataset.cd; checkerRender(); });
  $$("[data-allday]").forEach(b => b.onclick = e => { e.stopPropagation(); (groups[b.dataset.allday] || []).filter(d => d.status === "done").forEach(d => CK.sel.add(d.id)); checkerRender(); });
  $$(".cck").forEach(c => { c.onclick = e => e.stopPropagation(); c.onchange = () => { c.checked ? CK.sel.add(+c.value) : CK.sel.delete(+c.value); checkerRender(); }; });
  $$(".ck-card").forEach(el => el.onclick = e => { if (e.target.closest(".ckbox")) return; checkerDetail(CK.rows.find(d => d.id === +el.dataset.id)); });
  const ok = $("#ck-ok"); if (ok) ok.onclick = () => doCheck([...CK.sel]);
  const cl = $("#ck-clear"); if (cl) cl.onclick = () => { CK.sel.clear(); checkerRender(); };
  bindBell($("#c-bell"), "checker", Checker.name, Checker.pin);
  $("#c-man").onclick = () => openManuals("checker");
}
async function doCheck(ids) {
  const sel = CK.rows.filter(d => ids.includes(d.id)); const noFare = sel.filter(d => !d.base_fare);
  if (noFare.length && !confirm(`금액이 빈 ${noFare.length}건이 있습니다. 그래도 확인할까요?`)) return;
  sel.forEach(d => { d._prev = d.status; d.status = "checked"; }); CK.sel.clear(); checkerRender(); toast(`${ids.length}건을 확인했습니다(최종 완료)`);   // 즉시 반영
  try { await Checker.confirm(ids); await checkerLoad(true); }
  catch (e) { sel.forEach(d => { d.status = d._prev; }); checkerRender(); toast("저장 실패 — 되돌렸습니다: " + e.message); }
}
function checkerDetail(d) {
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "운행 확인");
  el.innerHTML = `<header><button class="btn ghost" id="kx" aria-label="닫기">←</button><h3>#${d.id} 운행 확인</h3>${stTag(d.status)}</header>
  <div class="body">
    <div class="req-box">${typeTag(d.type)} <span class="muted">${dLabel(d.run_date)} ${esc(d.time_slot || "")} · ${esc(d.vendor || "")}</span>
      <div class="route" style="margin-top:4px">${esc(d.from_place)} → ${esc(d.type === "delivery" ? "고객" : d.to_place)}</div>
      <div class="muted">${d.plt_qty != null ? d.plt_qty + " PLT · " : ""}${esc(d.temp || "")}${d.group_no ? " · 그룹 " + esc(d.group_no) : ""}${d.cargo_note ? " · " + esc(d.cargo_note) : ""}</div>
      ${d.delivery ? `<div style="margin-top:6px">${esc(d.delivery.customer_name || "")} · ${esc(d.delivery.address || "")} · ${esc(d.delivery.product || "")}<br><span class="muted">${esc(d.delivery.done_note || "")}</span></div>` : ""}</div>
    <div class="kvs card" style="padding:12px">
      <div class="kv"><span>기사 · 차량</span><div>${esc(d.driver_name || "-")} · ${esc(d.vehicle_no || "")} ${d.vehicle_ton ? d.vehicle_ton + "톤" : ""} ${esc(d.vehicle_body || "")}</div></div>
      <div class="kv"><span>기본운임</span><div class="num">${won(d.base_fare)}원</div></div>
      <div class="kv"><span>추가운임</span><div class="num">${d.extra_fare ? won(d.extra_fare) + "원 · " + esc(d.extra_reason || "") : "-"}</div></div>
      ${d.return_fare ? `<div class="kv"><span>회차</span><div class="num">${won(d.return_fare)}원 · ${esc(d.return_driver || "")}</div></div>` : ""}
      <div class="kv"><span>청구 합계</span><div class="num"><b>${won(cost(d))}원</b>${d.rate_fare && billed(d) > d.rate_fare ? ` <span class="flag">운임표 ${won(d.rate_fare)}원보다 ${won(billed(d) - d.rate_fare)}원 많음</span>` : ""}</div></div>
      ${d.checked_at ? `<div class="kv"><span>확인</span><div>${fmtSec(d.checked_at)} · ${esc(whoLabel(d.checked_by || ""))}</div></div>` : ""}
    </div>
    <div><p class="sec-t">진행 이력</p>${timelineHtml(d.events)}</div>
    <div class="ev-box"><p class="sec-t">이상하면 더한물류에 질문 ${qBadge(d)}</p>${threadHtml(d)}<div class="row" style="margin-top:8px;flex-wrap:nowrap"><input id="k-q" class="q-input" placeholder="예) 대기 2시간 맞나요?" aria-label="질문"><button class="btn primary" id="k-qs" type="button">질문</button></div></div>
  </div>
  <footer><button class="btn" id="kx2">닫기</button>${d.status === "done" ? `<button class="btn primary" id="k-ok">확인(최종 완료)</button>` : d.status === "checked" ? `<button class="btn" id="k-undo">확인 취소</button>` : ""}</footer>`;
  document.body.appendChild(el); const close = () => el.remove(); $("#kx", el).onclick = close; $("#kx2", el).onclick = close;
  const ok = $("#k-ok", el); if (ok) ok.onclick = () => { close(); doCheck([d.id]); };
  const un = $("#k-undo", el); if (un) un.onclick = async () => { try { await Checker.undo(d.id); close(); await checkerLoad(); toast("확인을 취소했습니다"); } catch (e) { toast(e.message); } };
  $("#k-qs", el).onclick = async () => { const body = $("#k-q", el).value.trim(); if (!body) return toast("질문을 적어 주세요"); try { await Checker.comment(d.id, body); close(); await checkerLoad(); toast("질문을 남겼습니다 — 더한물류에 알림이 갑니다"); } catch (e) { toast(e.message); } };
}

// =====================================================================
//  더한물류 운행내역서(엑셀) 끌어다 놓기 — 더한물류 화면: 금액까지 반영 / 관리자 정산 화면: 대조만
// =====================================================================
let xlsxLib = null;
// 붙여넣기 칸에 넣을 파일 → 글자. 엑셀(.xlsx/.xls/.csv)은 시트마다 탭으로 나눈 표로 바꿔서(숨긴 시트 포함)
async function fileToText(f) {
  if (/\.(xlsx|xlsm|xls|csv)$/i.test(f.name)) {
    const X = await loadXlsx(); const wb = X.read(await f.arrayBuffer(), { type: "array", cellDates: true, dateNF: "yyyy-mm-dd" });
    const txt = wb.SheetNames.map(n => X.utils.sheet_to_csv(wb.Sheets[n], { FS: "\t", blankrows: false, dateNF: "yyyy-mm-dd" })).join("\n");
    if (!txt.trim()) throw new Error("빈 엑셀입니다");
    return txt;
  }
  return await f.text();
}
// 끌어다 놓기: 카드 어디에 놓아도 됨(브라우저가 파일을 열어버리지 않게)
function bindFileDrop(el, take) {
  if (!el) return;
  el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("drop-on"); });
  el.addEventListener("dragleave", e => { if (!el.contains(e.relatedTarget)) el.classList.remove("drop-on"); });
  el.addEventListener("drop", e => { e.preventDefault(); el.classList.remove("drop-on"); const f = e.dataTransfer.files[0]; if (f) take(f); });
}
window.addEventListener("dragover", e => e.preventDefault()); window.addEventListener("drop", e => e.preventDefault());
async function loadXlsx() {
  if (window.XLSX) return window.XLSX;
  xlsxLib ||= new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"; s.onload = () => ok(window.XLSX); s.onerror = () => no(new Error("엑셀 읽기 도구를 불러오지 못했습니다(인터넷 확인)")); document.head.appendChild(s); });
  return xlsxLib;
}
// 칸 이름이 조금씩 달라도 알아듣도록(운행일자 · 날짜 / 파레트수량 · PLT수량 / 기사 · 기사이름 / 청구금액 …)
const STMT_COLS = { date: /^(운행일자|운행일|날짜|일자|상차일|배송일자)$/, from: /^(상차지|출발지|출고매장)$/, to: /^(하차지|도착지|목적지)$/, plt: /(파레트|팔레트|PLT|plt)/, driver: /^(기사|기사이름|기사명|차주)$/,
  car: /^(차량번호|차번|차량)$/, ton: /(톤수|차량톤수|차종)/, base: /^(기본운임|운임|기본)$/, extra: /^(추가운임|추가비용|추가)$/, wait: /^대기료$/, reason: /(추가운임내용|추가내용|비고|사유)/, total: /(청구금액|합계|금액|운송료|비용)/ };
function parseStatement(aoa) {
  const norm = x => String(x ?? "").replace(/\s|\n/g, "").replace(/\(.*\)$/, "");
  const h = aoa.findIndex(r => { const n = r.map(norm); return n.some(x => STMT_COLS.date.test(x)) && n.some(x => STMT_COLS.from.test(x)) && n.some(x => STMT_COLS.to.test(x)); });
  if (h < 0) throw new Error("머리줄(운행일자 · 상차지 · 하차지)을 찾지 못했습니다");
  const H = aoa[h].map(norm), col = {}; Object.entries(STMT_COLS).forEach(([k, re]) => { const i = H.findIndex((x, j) => re.test(x) && !Object.values(col).includes(j)); if (i >= 0) col[k] = i; });
  const toDate = v => {   // 엑셀 날짜(일련번호)는 시간대와 상관없이 그날로
    if (typeof v === "number" && v > 30000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 864e5)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; }
    if (v instanceof Date) return ymd(v);
    const s = String(v || ""); let m = s.match(/(\d{2,4})\s*[년.\-\/]\s*(\d{1,2})\s*[월.\-\/]\s*(\d{1,2})/); if (m) return `${m[1].length === 2 ? "20" + m[1] : m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = s.match(/^(\d{1,2})[\/.](\d{1,2})$/); return m ? `${today().slice(0, 4)}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : ""; };
  const num = v => { if (typeof v === "number") return v; const x = String(v ?? "").replace(/[^\d.-]/g, ""); return x ? +x : null; };
  const out = [];
  for (let i = h + 1; i < aoa.length; i++) {
    const r = aoa[i], g = k => (col[k] != null ? r[col[k]] : ""); const run = toDate(g("date")); const from = String(g("from") || "").trim(), to = String(g("to") || "").trim();
    if (!run || !from || !to) continue;
    let drv = String(g("driver") || "").trim(), car = String(g("car") || "").replace(/\s/g, ""); if (/^[가-힣]{0,2}\d{2,3}[가-힣]\d{4}$/.test(drv) && !/^[가-힣]{0,2}\d{2,3}[가-힣]\d{4}$/.test(car)) [drv, car] = [car, drv];
    const tonS = String(g("ton") || ""), tm = tonS.match(/(\d+(?:\.\d+)?)/); const pltS = String(g("plt") ?? "");
    let base = num(g("base")), extra = (num(g("extra")) || 0) + (num(g("wait")) || 0); const total = num(g("total"));
    if (base == null && total != null) base = total - extra;   // 청구금액만 있는 내역서(센터 · 본사 운행내역서)
    out.push({ i: i + 1, run_date: run, from_place: from, to_place: to, plt_qty: num(pltS), temp: /냉동/.test(pltS + tonS) ? "냉동" : /냉장/.test(pltS + tonS) ? "냉장" : "", driver_name: drv, vehicle_no: car,
      vehicle_ton: tm ? +tm[1] : null, vehicle_body: tonS.replace(/(\d+(?:\.\d+)?)\s*(톤|T)?/i, "").replace(/냉장|냉동/, m => m + "").trim(), base_fare: base, extra_fare: extra || 0, extra_reason: String(g("reason") || "").trim() });
  }
  return { rows: out, cols: Object.keys(col) };
}
async function readStatementFile(file) {
  const X = await loadXlsx(); const wb = X.read(await file.arrayBuffer(), { type: "array", cellDates: false });
  const all = []; let cols = [];
  wb.SheetNames.forEach(n => { if (/단가|양식|요약/.test(n)) return; try { const p = parseStatement(X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" })); p.rows.forEach(r => r.tab = n); all.push(...p.rows); cols = p.cols; } catch (_) {} });
  if (!all.length) throw new Error("운행 줄을 찾지 못했습니다 — 운행일자 · 상차지 · 하차지 칸이 있는 엑셀인지 확인해 주세요");
  return { rows: all, cols };
}
// 내역서 줄 ↔ 대장 줄 짝짓기(같은 날 · 같은 상하차지, 기사 · 차량이 같으면 더 확실)
function matchStatement(rows, ledger, places) {
  const used = new Set();
  return rows.map(r => {
    const c = ledger.filter(d => !used.has(d.id) && d.status !== "canceled" && d.run_date === r.run_date && sameSpot(d.from_place, r.from_place, places) && (d.type === "delivery" || sameSpot(d.to_place, r.to_place, places)))
      .map(d => [d, (r.vehicle_no && d.vehicle_no === r.vehicle_no ? 4 : 0) + (r.driver_name && d.driver_name === r.driver_name ? 3 : 0) + (r.plt_qty != null && +d.plt_qty === +r.plt_qty ? 1 : 0) + (d.driver_name ? 0 : 1)]).sort((a, b) => b[1] - a[1]);
    const d = c[0]?.[0] || null; if (d) used.add(d.id);
    const diff = d ? (d.base_fare == null ? "new_fare" : (+d.base_fare !== +r.base_fare || +(d.extra_fare || 0) !== +r.extra_fare) ? "fare" : (r.driver_name && d.driver_name !== r.driver_name) ? "driver" : "same") : "missing";
    return { r, d, diff };
  });
}
function stmtTableHtml(M, { vendor = true } = {}) {
  const lab = { missing: vendor ? "새 운행으로 추가" : "대장에 없음", new_fare: "금액 채움", fare: vendor ? "금액 고침" : "금액 다름", driver: vendor ? "기사 고침" : "기사 다름", same: "같음" };
  return `<div class="tbl-wrap" style="max-height:50vh"><table class="tbl stmt"><thead><tr>${vendor ? "<th></th>" : ""}<th>결과</th><th>운행일</th><th>상차지 → 하차지</th><th>기사 · 차량</th><th class="r">내역서 금액</th><th class="r">대장 금액</th></tr></thead><tbody>${M.map((m, i) => `
    <tr class="sd-${m.diff}">${vendor ? `<td><input type="checkbox" class="sck" data-si="${i}" ${m.diff === "same" ? "" : "checked"} aria-label="반영"></td>` : ""}<td><b>${lab[m.diff]}</b>${m.d ? ` <span class="muted">#${m.d.id}</span>` : ""}</td><td class="num">${dLabel(m.r.run_date)}</td><td>${esc(m.r.from_place)} → ${esc(m.r.to_place)}</td>
    <td>${esc(m.r.driver_name)} ${esc(m.r.vehicle_no)}</td><td class="r num">${won(+m.r.base_fare + +m.r.extra_fare)}</td><td class="r num">${m.d && m.d.base_fare != null ? won(billed(m.d)) : "-"}</td></tr>`).join("")}</tbody></table></div>`;
}
function dropZoneHtml(id, text) { return `<label class="dropzone" id="${id}" tabindex="0"><input type="file" accept=".xlsx,.xls,.csv" hidden><b>${text}</b><span class="muted">엑셀 파일을 여기로 끌어다 놓거나 눌러서 고르기</span></label>`; }
function bindDrop(zone, onFile) {
  const inp = $("input", zone); inp.onchange = () => { if (inp.files[0]) onFile(inp.files[0]); inp.value = ""; };
  ["dragenter", "dragover"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove("over"); }));
  zone.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) onFile(f); });
}
// 더한물류: 이메일 대신 여기에 올리면 대장에 기사 · 금액까지 반영
function openStatementUpload() {
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "운행내역서 올리기");
  el.innerHTML = `<header><button class="btn ghost" id="ux" aria-label="닫기">←</button><h3>운행내역서 올리기</h3></header>
    <div class="body"><p class="hint" style="font-size:14px">그동안 이메일로 보내던 「킹콩 본사 운행내역서」 엑셀을 그대로 올리세요. 같은 날 · 같은 구간 요청을 찾아 <b>기사 · 차량 · 금액</b>을 채우고, 없는 운행은 새로 추가합니다. 반영 전에 확인 화면이 나옵니다.</p>
    ${dropZoneHtml("u-drop", "운행내역서 엑셀 올리기")}<div id="u-out"></div></div>
    <footer><button class="btn" id="ux2">닫기</button><button class="btn primary" id="u-go" disabled>반영하기</button></footer>`;
  document.body.appendChild(el); const close = () => el.remove(); $("#ux", el).onclick = close; $("#ux2", el).onclick = close;
  const places = V.refs.place_list || (V.refs.places || []).map(n => ({ name: n, aliases: [] })); let M = [];
  bindDrop($("#u-drop", el), async file => {
    try { $("#u-out", el).innerHTML = `<p class="muted">읽는 중… ${esc(file.name)}</p>`; const { rows } = await readStatementFile(file);
      M = matchStatement(rows, V.rows, places); const cnt = k => M.filter(m => m.diff === k).length;
      $("#u-out", el).innerHTML = `<p class="sec-t" style="margin-top:12px">${esc(file.name)} · ${M.length}줄 — 금액 채움 ${cnt("new_fare")} · 금액 고침 ${cnt("fare")} · 기사 고침 ${cnt("driver")} · 새 운행 ${cnt("missing")} · 같음 ${cnt("same")}</p>${stmtTableHtml(M)}`;
      $("#u-go", el).disabled = false; $("#u-go", el).textContent = `${M.filter(m => m.diff !== "same").length}건 반영하기`;
    } catch (e) { $("#u-out", el).innerHTML = `<p class="err-msg">${esc(e.message)}</p>`; }
  });
  $("#u-go", el).onclick = async () => {
    const pick = $$(".sck", el).filter(c => c.checked).map(c => M[+c.dataset.si]); if (!pick.length) return toast("반영할 줄을 골라 주세요");
    $("#u-go", el).disabled = true; let n = 0, fail = 0;
    for (const m of pick) {
      const r = m.r, car = { driver_name: r.driver_name || m.d?.driver_name || "", driver_phone: m.d?.driver_phone || "", vehicle_no: r.vehicle_no || m.d?.vehicle_no || "", vehicle_ton: r.vehicle_ton ?? m.d?.vehicle_ton ?? null, vehicle_body: r.vehicle_body || m.d?.vehicle_body || "" };
      try {
        if (m.d) await Vendor.save(m.d.id, { ...car, base_fare: r.base_fare, extra_fare: r.extra_fare, extra_reason: r.extra_reason || m.d.extra_reason || "", status: r.run_date <= today() ? "done" : "assigned" });
        else await Vendor.add({ type: "center", run_date: r.run_date, from_place: resolvePlace(r.from_place, places), to_place: resolvePlace(r.to_place, places), plt_qty: r.plt_qty, temp: r.temp || "상온", cargo_note: "운행내역서", ...car, base_fare: r.base_fare, extra_fare: r.extra_fare, extra_reason: r.extra_reason, status: "done" });
        n++;
      } catch (e) { fail++; }
    }
    close(); await vendorLoad(); toast(`운행내역서 ${n}건 반영${fail ? ` · 실패 ${fail}건` : ""} — 본사 확인 담당자에게 알림이 갑니다`);
  };
}
// 관리자 정산: 더한물류가 보낸 엑셀과 대장 대조(금액은 고치지 않음 — 다른 건은 질문으로)
function bindReconcile(v) {
  const z = $("#rc-drop", v); if (!z) return;
  bindDrop(z, async file => {
    const out = $("#rc-out", v);
    try { out.innerHTML = `<p class="muted">읽는 중… ${esc(file.name)}</p>`; const { rows } = await readStatementFile(file);
      const M = matchStatement(rows, S.rowsAll.filter(d => d.vendor_id), S.refs.places); const lo = rows.reduce((a, r) => r.run_date < a ? r.run_date : a, "9999"), hi = rows.reduce((a, r) => r.run_date > a ? r.run_date : a, "");
      const onlyLedger = S.rowsAll.filter(d => d.vendor_id && d.run_date >= lo && d.run_date <= hi && ["done", "checked", "confirmed"].includes(d.status) && !M.some(m => m.d && m.d.id === d.id));
      const bad = M.filter(m => m.diff !== "same");
      const sumS = rows.reduce((a, r) => a + (+r.base_fare || 0) + (+r.extra_fare || 0), 0), sumL = M.filter(m => m.d).reduce((a, m) => a + billed(m.d), 0) + onlyLedger.reduce((a, d) => a + billed(d), 0);
      out.innerHTML = `<p class="sec-t" style="margin-top:12px">${esc(file.name)} · ${dLabel(lo)}~${dLabel(hi)} · 내역서 ${rows.length}줄 ${won(sumS)}원 / 대장 ${won(sumL)}원 — <b style="color:${bad.length || onlyLedger.length ? "var(--bad)" : "var(--good)"}">${bad.length || onlyLedger.length ? `다른 곳 ${bad.length + onlyLedger.length}건` : "모두 같음"}</b></p>
        ${bad.length ? stmtTableHtml(bad, { vendor: false }) : ""}
        ${onlyLedger.length ? `<p class="sec-t" style="margin-top:10px">대장에만 있는 운행 ${onlyLedger.length}건(내역서에 빠짐)</p><ul class="fb-list">${onlyLedger.map(d => `<li>#${d.id} ${dLabel(d.run_date)} ${esc(d.from_place)}→${esc(d.to_place)} ${esc(d.driver_name || "")} ${won(billed(d))}원</li>`).join("")}</ul>` : ""}
        ${bad.some(m => m.d) ? `<div class="row" style="justify-content:flex-end"><button class="btn primary sm" id="rc-ask">다른 건마다 더한물류에 질문 남기기</button></div>` : ""}`;
      const ask = $("#rc-ask", v); if (ask) ask.onclick = async () => { let n = 0; for (const m of bad.filter(x => x.d)) { await Admin.comment(m.d.id, `[내역서 대조] 내역서 ${won(+m.r.base_fare + +m.r.extra_fare)}원(${m.r.driver_name || "-"}) · 대장 ${m.d.base_fare != null ? won(billed(m.d)) + "원" : "금액 없음"}(${m.d.driver_name || "-"}) — 확인 부탁드립니다`); n++; } toast(`${n}건에 질문을 남겼습니다`); await reload(); };
    } catch (e) { out.innerHTML = `<p class="err-msg">${esc(e.message)}</p>`; }
  });
}

// =====================================================================
//  사용 설명서 내려받기 — 역할별 PDF(manual 폴더)
// =====================================================================
// 바뀐 점(빌드마다 추가) — 설명서 창 맨 위 · 새 빌드로 처음 열 때 한 번 안내. who: 보여 줄 역할(없으면 모두)
const CHANGES = [
  { b: 12, who: ["admin"], t: "물류비 탭 — 기본 · 대기료 · 경유비 · 회차 합산, 운임표 대비, 정확도 검증(금액 미입력 · 운임표 초과 · 사유 없음 · 단가 이상 · 중복)" },
  { b: 12, who: ["admin"], t: "배차 요청에 '발주처'(킹콩본사 · 킹콩백화점 · 진천센터) — 차량 등록되면 그 그룹에 알림. 대장 '내 요청' 칩 · 발주처 필터" },
  { b: 12, who: ["center", "admin"], t: "진천센터 화면(링크 + PIN) — 출고 · 입고 요청, 내 요청 보기, 차량 등록 알림(금액은 안 보임)" },
  { b: 12, who: ["vendor"], t: "진천센터가 직접 요청한 건도 '새 배차 요청'으로 알림이 옵니다(발주처 표시)" },
  { b: 12, who: ["store"], t: "매장 화면은 2단계에 열립니다(1단계: 킹콩본사 · 진천센터 · 더한물류)" },
  { b: 11, who: ["admin"], t: "통합 대장 일별 백업 · 삭제는 권한자만(빨간 확인 배너 · 휴지통 되살리기) · 엑셀을 구글시트 양식 그대로" },
  { b: 10, who: ["admin", "vendor"], t: "출고요청서 엑셀 파일 열기 · 끌어다 놓기" },
  { b: 9, who: ["vendor"], t: "PC 관제판(표/칸반 · 표 안에서 바로 입력 · 여러 건 한 번에)" },
];
const changesFor = who => CHANGES.filter(c => !c.who || c.who.includes(who));
function whatsNew(who) {   // 새 빌드로 처음 열면 한 번만
  let seen = 0; try { seen = +localStorage.getItem("kk_seen_" + who) || 0; } catch (_) {}
  const L = changesFor(who).filter(c => c.b > seen && c.b <= +BUILD);
  try { localStorage.setItem("kk_seen_" + who, BUILD); } catch (_) {}
  if (!seen || !L.length) return;
  actionToast(`새로 바뀐 점 ${L.length}가지 (build ${BUILD})`, "보기", () => openManuals(who));
}
const MANUALS = [
  { who: "vendor", file: "manual/1_더한물류_사용설명서.pdf", title: "더한물류 사용 설명서", desc: "배차 입력 · 카톡 붙여넣기 · 취소/회차 · 운행내역서 올리기 · 질문 답변 (먼저 쓰실 분)" },
  { who: "admin", file: "manual/2_킹콩본사_사용설명서.pdf", title: "킹콩 본사 · 물류 담당 사용 설명서", desc: "배차 요청 · 통합 대장 · 질문 · 정산 · 내역서 대조 · 구글시트" },
  { who: "checker", file: "manual/3_확인담당자_사용설명서.pdf", title: "본사 확인 담당자 사용 설명서", desc: "운행 완료 건 확인(최종 완료) · 질문" },
  { who: "center", file: "manual/5_진천센터_사용설명서.pdf", title: "진천센터 사용 설명서", desc: "출고 · 입고 요청 · 내 요청 · 차량 등록 알림" },
  { who: "store", file: "manual/4_매장_사용설명서.pdf", title: "매장 사용 설명서", desc: "진천센터 출고 빠른 요청 · 최근 요청 복사 · 진행 확인" },
];
function openManuals(who) {
  const el = document.createElement("div"); el.className = "sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "사용 설명서");
  const L = [...MANUALS].sort((a, b) => (b.who === who) - (a.who === who));
  el.innerHTML = `<header><button class="btn ghost" id="mx" aria-label="닫기">←</button><h3>사용 설명서</h3></header><div class="body">
    ${changesFor(who).length ? `<div class="req-box"><b>최근 바뀐 점</b><ul class="plain" style="margin:6px 0 0">${changesFor(who).slice(0, 6).map(c => `<li><span class="build-pill">build ${c.b}</span> ${esc(c.t)}</li>`).join("")}</ul></div>` : ""}
    <p class="hint" style="font-size:14px">PDF로 내려받아 휴대폰 · PC에서 볼 수 있습니다. 내 역할 설명서가 맨 위에 있습니다. 설명서는 바뀔 때마다 새로 만들어 이 자리에 올라갑니다(설명서 아래쪽에 build 번호).</p>
    ${L.map(m => `<a class="man-card${m.who === who ? " mine" : ""}" href="${m.file}" download target="_blank" rel="noopener"><b>${esc(m.title)}${m.who === who ? ' <span class="flag">내 설명서</span>' : ""}</b><span class="muted">${esc(m.desc)}</span><span class="btn sm primary">PDF 내려받기</span></a>`).join("")}
  </div>`;
  document.body.appendChild(el); $("#mx", el).onclick = () => el.remove();
}


// =====================================================================
//  병행 테스트 대조표 — 날짜별 시트 · 앱 일치율(대시보드)
//   일치: 앱에서 넣은 건에 시트 줄이 붙음 / 시트에만: 시트에서만 들어옴(앱 입력 빠짐) / 앱에만: 시트에 없음(시트 입력 빠짐 또는 앱 중복)
//   값 다름: 붙을 때 기사 · 차량 · 금액 · PLT가 달랐던 칸(시트 값으로 바뀜)
// =====================================================================
async function drawParallel(v) {
  const box = $("#par-body", v); if (!box) return;
  const t = today(), from = addDays(t, -14);
  const L = S.rowsAll.filter(d => d.run_date >= from && d.run_date < t && d.status !== "canceled" && (d.sheet_key || d.type !== "delivery" || true));
  let diffs = []; try { diffs = await Admin.syncDiffs(from); } catch (_) {}
  const days = [...new Set(L.map(d => d.run_date))].sort().reverse();
  const stat = dd => { const X = L.filter(d => d.run_date === dd); const m = X.filter(d => d.sheet_key && d.origin !== "sheet").length, so = X.filter(d => d.origin === "sheet").length, ao = X.filter(d => !d.sheet_key && d.origin !== "sheet").length;
    const df = diffs.filter(x => X.some(d => d.id === x.dispatch_id)).length; const tot = m + so + ao; return { m, so, ao, df, tot, rate: tot ? Math.round(m / tot * 100) : 0 }; };
  const rows = days.map(dd => [dd, stat(dd)]);
  let streak = 0; for (const [, x] of rows) { if (x.tot && x.rate === 100 && !x.df) streak++; else break; }
  const sum = rows.reduce((a, [, x]) => ({ m: a.m + x.m, so: a.so + x.so, ao: a.ao + x.ao, df: a.df + x.df }), { m: 0, so: 0, ao: 0, df: 0 }), all = sum.m + sum.so + sum.ao;
  box.className = "";
  box.innerHTML = `<div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:10px">
      <div class="kpi"><div class="l">14일 일치율</div><div class="v num">${all ? Math.round(sum.m / all * 100) : 0}%</div><div class="s">일치 ${sum.m} / 전체 ${all}건</div></div>
      <div class="kpi ${sum.so ? "alert" : ""}"><div class="l">시트에만(앱 입력 빠짐)</div><div class="v num">${sum.so}</div></div>
      <div class="kpi ${sum.ao ? "alert" : ""}"><div class="l">앱에만(시트 빠짐)</div><div class="v num">${sum.ao}</div></div>
      <div class="kpi ${sum.df ? "alert" : ""}"><div class="l">값 다름</div><div class="v num">${sum.df}</div></div></div>
    <p class="hint" style="margin:0 0 8px">100% 연속 <b>${streak}일</b> / 전환 기준 5일 ${streak >= 5 ? '— <b style="color:var(--good)">전환 가능</b>' : ""}</p>
    <div class="tbl-wrap" style="max-height:330px"><table class="tbl par"><thead><tr><th>운행일</th><th class="r">전체</th><th class="r">일치</th><th class="r">시트에만</th><th class="r">앱에만</th><th class="r">값 다름</th><th>일치율</th></tr></thead><tbody>
    ${rows.map(([dd, x]) => `<tr><td class="num">${dLabel(dd)}</td><td class="r num">${x.tot}</td><td class="r num"><a href="#" data-par="matched|${dd}">${x.m}</a></td><td class="r num ${x.so ? "diff-up" : ""}"><a href="#" data-par="sheetonly|${dd}">${x.so}</a></td><td class="r num ${x.ao ? "diff-up" : ""}"><a href="#" data-par="apponly|${dd}">${x.ao}</a></td><td class="r num ${x.df ? "diff-up" : ""}">${x.df}</td>
      <td><div class="pbar"><i style="width:${x.rate}%;background:${x.rate === 100 && !x.df ? "var(--good)" : x.rate >= 90 ? "var(--warn)" : "var(--bad)"}"></i></div><span class="num">${x.rate}%</span></td></tr>`).join("") || `<tr><td colspan="7" class="muted">아직 비교할 자료가 없습니다 — 시트 동기화가 돌기 시작하면 채워집니다</td></tr>`}</tbody></table></div>
    ${diffs.length ? `<p class="sec-t" style="margin-top:10px">값이 달랐던 칸(최근)</p><ul class="fb-list">${diffs.slice(0, 8).map(x => `<li><a href="#" data-did="${x.dispatch_id}">#${x.dispatch_id}</a> ${esc(COL_KO[x.field] || x.field)}: 앱 <b>${esc(shortVal(x.app_value))}</b> → 시트 <b>${esc(shortVal(x.sheet_value))}</b></li>`).join("")}</ul>` : ""}`;
  $$("[data-par]", box).forEach(a => a.onclick = e => { e.preventDefault(); const [flag, date] = a.dataset.par.split("|"); S.filter = { type: "", status: "", vendor: "", q: "", flag, date, day: "" }; S.tab = "ledger"; render(); });
  $$("[data-did]", box).forEach(a => a.onclick = e => { e.preventDefault(); const d = S.rowsAll.find(x => x.id === +a.dataset.did); if (d) openEdit(d); });
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
    const tmp = { id: Date.now(), at: new Date().toISOString(), author: S.user.email, kind: "question", body }; (d.comments ||= []).push(tmp); pop.remove(); render(); toast("질문을 남겼습니다 — 더한물류 화면에 바로 보입니다");   // 즉시 반영
    try { await Admin.comment(d.id, body); await reload(true); } catch (e) { d.comments = d.comments.filter(c => c !== tmp); render(); toast("저장 실패 — 되돌렸습니다: " + e.message); } };
}

// 시작(모든 선언이 끝난 뒤) — 주소로 화면을 고르고, 실시간 갱신을 건다
const role = vendorParam ? "vendor" : storeParam ? "store" : checkerParam ? "checker" : "admin";
if (CFG.TEST_MODE) {
  const bar = document.createElement("div"); bar.className = "test-bar"; bar.innerHTML = `<span>테스트 운영 기간 — 카톡도 평소처럼 함께 써 주세요</span><button type="button">의견 남기기</button>`;
  bar.querySelector("button").onclick = () => openFeedback(role); document.body.prepend(bar);
}
if ("serviceWorker" in navigator) { navigator.serviceWorker.register("sw.js").catch(() => {}); navigator.serviceWorker.addEventListener("message", e => { if (e.data?.kk === "refresh") Live.fire(false); }); }
if (centerParam && !vendorParam && !params.get("s") && !params.get("c")) { centerBoot(centerParam); Live.start(q => { if (Center.name) remoteRefresh(q, formBusy, quiet => centerLoad(quiet)); }); }
else if (vendorParam) { vendorBoot(vendorParam); Live.start(q => { if (Vendor.name) remoteRefresh(q, formBusy, quiet => vendorLoad(quiet)); }); }
else if (storeParam) { storeBoot(storeParam); Live.start(q => { if (Store.name) remoteRefresh(q, formBusy, quiet => storeLoad(quiet)); }); }
else if (checkerParam) { checkerBoot(checkerParam); Live.start(q => { if (Checker.name) remoteRefresh(q, formBusy, quiet => checkerLoad(quiet)); }); }
else { adminBoot(); Live.start(q => { if (S.user && S.refs) remoteRefresh(q, () => formBusy() || S.tab === "new", quiet => reload(quiet)); }); }
})();
