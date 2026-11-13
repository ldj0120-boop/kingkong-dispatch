/**
 * 킹콩 배차 — 구글시트 3개(숨김 탭 포함)를 1시간마다 통합 대장으로 보내기 (Google Apps Script, 단독 프로젝트)
 *
 * 설치(5분, 한 번만):
 *  1. https://script.google.com → 새 프로젝트 → 이 파일 내용을 전부 붙여넣기 → 저장
 *     (시트 3개를 '볼 수 있는' 구글 계정으로. 시트를 공개로 바꿀 필요 없음)
 *  2. 왼쪽 ⚙ 프로젝트 설정 → 시간대 '(GMT+09:00) 서울'
 *  3. 함수 고르기 '연결하기' → 실행 → 권한 허용 → Supabase SQL 에서  select sheet_pair_approve();  (15분 안에)
 *  4. 위쪽 함수 고르기에서 '설치' → 실행 → 권한 허용  ⇒ 지금 한 번 보내고, 이후 1시간마다 자동
 *  결과는 실행 기록(왼쪽 '실행')과 앱 관리자 화면 › 설정 › 구글시트 동기화 에서 확인
 *  규칙: 기사 · 운임이 빈 지난 줄도 '배차 요청(더한물류 입력 필요)'으로 넣음 · '수정전 · 사본 · 백업' 탭은 제외
 */
const ENDPOINT = 'https://mlxnozcvtlqsmgyhslzf.supabase.co/rest/v1/rpc/sheet_push';
const ANON_KEY = 'sb_publishable_c0ErFHj6ylcx4dXr5p4pGA_uEeVreu6';   // 공개용 키(앱 config.js 와 같음)
// 토큰은 사람이 복사·붙여넣기 하지 않습니다: '연결하기' 실행 → 스크립트가 새 토큰을 만들어 Supabase에 '연결 대기'로 등록
//   → 관리자가 Supabase SQL 에서 승인(select sheet_pair_approve();) → 이 프로젝트 속성(SHEET_TOKEN)에만 보관
const TOKEN    = PropertiesService.getScriptProperties().getProperty('SHEET_TOKEN') || '';
// 시트 3개 모두 보냄(앱 화면은 1단계 범위만 보여 주고, 물류비 자료는 전부 쌓임). 쿠팡만 보내려면 PHASE = 1
const PHASE = 2;
const SHEETS = [
  { id: '10NZtOsKVPGEnbC79n2N9_AfLLKIzTKGifxmtAN1uD8k', source: '쿠팡배차내역',   kind: 'coupang',  vendor: '더한물류', phase: 1 },
  { id: '1kTQ8aB8WA30PoHmy8XdYzTuddqWCrk-vg8cMAu72ZWY', source: '고객배송내역',   kind: 'delivery', vendor: '더한물류', phase: 2 },
  { id: '1enm8-jKhY3bsq4-X5Opp2HsD8bRr4ZoEuN0O1E-V2tQ', source: '배차내역_경산2', kind: 'gyeongsan', vendor: '한국파렛트풀', phase: 2 },
];
// 숨긴 탭도 읽습니다(getSheets 는 숨김 탭 포함). 열 이름으로 찾아서 운행일 · 구간 · 차량 · 상태 · 금액 · 비고 칸에 맞춥니다
const SKIP_TABS = /양식|단가|복사용|이전자료|요약|집계|수정전|사본|백업/;
const TZ = 'Asia/Seoul';

function 연결하기() {   // 새 토큰 생성 → Supabase 에 '연결 대기'로 보냄(15분 안에 승인해야 유효)
  const t = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const res = UrlFetchApp.fetch(ENDPOINT.replace('sheet_push', 'sheet_pair'), { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY }, payload: JSON.stringify({ p_token: t }) });
  if (res.getResponseCode() !== 200) throw new Error('연결 실패: ' + res.getContentText());
  PropertiesService.getScriptProperties().setProperty('SHEET_TOKEN', t);
  console.log('연결 대기 등록됨 — Supabase SQL 에서  select sheet_pair_approve();  실행 후 설치 를 실행하세요');
}
function 설치() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('지금보내기').timeBased().everyHours(1).inTimezone(TZ).create();   // 1시간마다
  ScriptApp.newTrigger('직출보내기').timeBased().everyMinutes(5).create();                 // 직출 알림 시트는 5분마다(매장 알림)
  지금보내기(); 직출보내기();
}
function 지금보내기() { run_(45); }
function 전체보내기() { run_(100000); }

function run_(days) {
  if (!TOKEN) throw new Error("먼저 '연결하기' 를 실행하고 Supabase 에서 승인하세요");
  const since = Utilities.formatDate(new Date(Date.now() - days * 864e5), TZ, 'yyyy-MM-dd');
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  SHEETS.filter(cfg => (cfg.phase || 1) <= PHASE).forEach(cfg => {
    const ss = SpreadsheetApp.openById(cfg.id); const rows = [];
    ss.getSheets().forEach(sh => {
      if (SKIP_TABS.test(sh.getName()) && days < 100000) return;
      if (/양식|단가|복사용|수정전|사본|백업/.test(sh.getName())) return;
      const v = sh.getDataRange().getValues();
      const parsed = cfg.kind === 'delivery' ? parseDelivery_(v, cfg, sh.getName(), today) : parseRun_(v, cfg, sh.getName(), today);
      parsed.forEach(r => { if (r.run_date >= since) rows.push(r); });
    });
    for (let k = 0; k < rows.length; k += 500) {   // 500줄씩 나눠 보냄
      const res = UrlFetchApp.fetch(ENDPOINT, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY }, payload: JSON.stringify({ p_token: TOKEN, p_source: cfg.source, p_rows: rows.slice(k, k + 500) }) });
      console.log(cfg.source, (k + 1) + '~' + Math.min(k + 500, rows.length) + '줄 →', res.getResponseCode(), res.getContentText());
    }
  });
}

// ---------- 공통 ----------
function d_(x) {   // 날짜 칸 → 'yyyy-MM-dd'  (날짜 형식 · '2024년 11월 18일 월요일' · '26년 08월 01일 토')
  if (x instanceof Date) return Utilities.formatDate(x, TZ, 'yyyy-MM-dd');
  const m = String(x || '').match(/(\d{2,4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (!m) return '';
  const y = m[1].length === 2 ? 2000 + +m[1] : +m[1];
  return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}
function n_(x) { if (typeof x === 'number') return x; const s = String(x || '').replace(/[^\d.-]/g, ''); return s ? +s : null; }
function s_(x) { return String(x == null ? '' : x).trim(); }
function idx_(head, name, from) { const names = [].concat(name); for (let i = from || 0; i < head.length; i++) if (names.indexOf(s_(head[i]).replace(/\s/g, '')) >= 0) return i; return -1; }
const PLATE = /^[가-힣]{0,2}\d{2,3}[가-힣]\d{4}$/;
function ton_(x) { if (typeof x === 'number') return { ton: x, body: '' }; const s = s_(x); const m = s.match(/(\d+(?:\.\d+)?)\s*(톤|T)?/i); return { ton: m ? +m[1] : null, body: s.replace(/(\d+(?:\.\d+)?)\s*(톤|T)?/i, '').trim() }; }
function status_(run, today, driver, fare) { if (driver && fare) return run <= today ? 'done' : 'assigned'; if (driver) return 'assigned'; return run < today ? 'canceled' : 'requested'; }

// ---------- 쿠팡배차내역 · 배차내역_경산2 (운행일자 · NO. · 상차지 · 하차지 · PLT수량 · 기사이름 · 차량번호 · 차량톤수 · 기본운임 · 추가운임 … · 회차) ----------
function parseRun_(v, cfg, tab, today) {
  const h = v.findIndex(r => r.some(c => s_(c) === '운행일자') && r.some(c => s_(c) === '상차지')); if (h < 0) return [];
  const H = v[h];
  const c = { date: idx_(H, '운행일자'), no: idx_(H, 'NO.'), from: idx_(H, '상차지'), to: idx_(H, '하차지'), plt: idx_(H, 'PLT수량'), drv: idx_(H, '기사이름'), car: idx_(H, '차량번호'),
    ton: idx_(H, '차량톤수'), base: idx_(H, '기본운임'), extra: idx_(H, '추가운임'), wait: idx_(H, '대기료'), reason: idx_(H, '추가운임내용'), note: idx_(H, '비고'), rdate: idx_(H, '회차일자') };
  if (c.rdate >= 0) { c.rfrom = idx_(H, '상차지', c.rdate); c.rdrv = idx_(H, '기사이름', c.rdate); c.rfare = Math.max(idx_(H, '회차금액', c.rdate), idx_(H, '회차운임', c.rdate)); }
  const out = [], seen = {};
  for (let i = h + 1; i < v.length; i++) {
    const r = v[i], run = d_(r[c.date]); if (!run) continue;
    const from = s_(r[c.from]), to = s_(r[c.to]); if (!from || !to) continue;
    let drv = s_(r[c.drv]), car = s_(r[c.car]);
    if (PLATE.test(drv.replace(/\s/g, '')) && !PLATE.test(car.replace(/\s/g, ''))) { const t = drv; drv = car; car = t; }   // 기사 · 차량번호 칸이 바뀐 줄
    if (drv === '0') drv = '';
    const blank = !drv && n_(r[c.base]) == null && run < today;   // 기사 · 운임이 빈 지난 줄 → 더한물류가 입력할 '배차 요청'으로
    const t = ton_(r[c.ton]), base = n_(r[c.base]), extra = (n_(r[c.extra]) || 0) + (c.wait >= 0 ? (n_(r[c.wait]) || 0) : 0);
    const no = uniqNo_(seen, c.no >= 0 && s_(r[c.no]) ? s_(r[c.no]) : 'r' + (i + 1), tab);
    out.push({ key: cfg.source + ':' + tab + ':' + no, type: 'coupang', vendor: cfg.vendor, run_date: run, from_place: from, to_place: to,
      plt_qty: n_(r[c.plt]), temp: /냉장/.test(s_(r[c.plt])) ? '냉장' : '', driver_name: drv, vehicle_no: car.replace(/\s/g, ''), vehicle_ton: t.ton, vehicle_body: t.body,
      base_fare: base, extra_fare: extra || null, extra_reason: s_(c.reason >= 0 ? r[c.reason] : '') || s_(c.note >= 0 ? r[c.note] : ''),
      return_date: c.rdate >= 0 ? d_(r[c.rdate]) : '', return_from: c.rfrom >= 0 ? s_(r[c.rfrom]) : '', return_driver: c.rdrv >= 0 ? s_(r[c.rdrv]) : '', return_fare: c.rfare >= 0 && (d_(r[c.rdate]) || s_(r[c.rfrom]) || s_(r[c.rdrv])) ? n_(r[c.rfare]) : null,   // 회차 구역 아래 합계 칸(예: V29 47,125,047)을 그 줄 회차금액으로 읽지 않게 — 회차일 · 상차지 · 기사가 있는 줄만
      status: blank ? 'requested' : status_(run, today, drv, base), note: blank ? '시트: 기사 · 운임 비어 있음 — 더한물류 입력 필요' : '' });
  }
  return out;
}

// ---------- 매장출고_고객배송내역 (NO. · 주문일자 · 출고매장 · 배송일자 · 주문자명 · 배송지 연락처 · 배송지 주소 · 제품 · 수량 · 배송조건 · 비용 · 추가비용 · 비고) ----------
function parseDelivery_(v, cfg, tab, today) {
  const h = v.findIndex(r => r.some(c => s_(c) === '주문일자') && r.some(c => s_(c) === '출고매장')); if (h < 0) return [];
  const H = v[h];
  const c = { no: idx_(H, 'NO.'), order: idx_(H, '주문일자'), store: idx_(H, '출고매장'), ship: idx_(H, ['배송완료일', '배송일자', '요청일자']), name: idx_(H, '주문자명'), tel: idx_(H, '배송지연락처'), addr: idx_(H, '배송지주소'),
    prod: idx_(H, '제품'), qty: idx_(H, '수량'), terms: idx_(H, ['배송조건1', '배송조건']), fee: idx_(H, ['기본요금', '비용', '결제비용(vat포함)']), extra: idx_(H, '추가비용'), note: idx_(H, ['비고(지우지마세요)', '비고']) };
  const out = [], seen = {};
  for (let i = h + 1; i < v.length; i++) {
    const r = v[i], order = d_(r[c.order]); if (!order) continue;
    const store = s_(r[c.store]); if (!store) continue;
    const run = d_(r[c.ship]) || order, note = s_(r[c.note]), fee = n_(r[c.fee]);
    const st = /취소/.test(note) || /취소/.test(s_(r[c.fee])) ? 'canceled' : /완료/.test(note) ? 'done' : fee ? 'assigned' : 'requested';
    const no = uniqNo_(seen, c.no >= 0 && s_(r[c.no]) ? s_(r[c.no]) : 'r' + (i + 1), tab);
    out.push({ key: cfg.source + ':' + tab + ':' + no, type: 'delivery', vendor: cfg.vendor, run_date: run, from_place: store, to_place: '고객', base_fare: fee, extra_fare: n_(r[c.extra]),
      status: st, note: s_(r[c.prod]),
      delivery: { order_date: order, customer_name: s_(r[c.name]), customer_phone: s_(r[c.tel]), address: s_(r[c.addr]), product: s_(r[c.prod]), qty: s_(r[c.qty]), terms: s_(r[c.terms]), done_note: note } });
  }
  return out;
}

// 같은 탭에 NO.가 겹친 줄(예: 73이 두 줄) — 두 번째부터 73#2, 73#3 … 으로 따로 보냄(같은 배차 1건에 번갈아 덮어쓰지 않게)
function uniqNo_(seen, no, tab) {
  seen[no] = (seen[no] || 0) + 1; if (seen[no] === 1) return no;
  console.log('NO. 겹침: ' + tab + ' NO.' + no + ' (' + seen[no] + '번째 줄) → ' + no + '#' + seen[no]);
  return no + '#' + seen[no];
}

// ---------- 직출 알림: 「낙찰건 로케이션」 2026 탭 → 매장별 입고 안내(build 28) ----------
// 칸: 낙찰일 · NO. · 그룹NO. · 낙찰NO. · 부분 · FC · 도착지 · PLT수량 · CATE · 직출여부 · 입고일자 · 오전/오후 · 사진(비고)
const DIRECT = { id: '1-dfbTyMUiTyTZBbCkIeb9livCV_5626r3qPKaP_7gcY', back: 3, ahead: 21 };
function 직출보내기() {
  if (!TOKEN) return;
  const lock = LockService.getScriptLock(); if (!lock.tryLock(20000)) return;   // 겹쳐 돌지 않게
  try {
    const lo = Utilities.formatDate(new Date(Date.now() - DIRECT.back * 864e5), TZ, 'yyyy-MM-dd'), hi = Utilities.formatDate(new Date(Date.now() + DIRECT.ahead * 864e5), TZ, 'yyyy-MM-dd');
    const tab = Utilities.formatDate(new Date(), TZ, 'yyyy');   // 올해 탭(2026) — 시트를 이 계정(ldj0120@kinggo.ai)에 보기 권한으로 공유해야 읽힘
    const sh = SpreadsheetApp.openById(DIRECT.id).getSheetByName(tab); if (!sh) throw new Error('직출 시트에 ' + tab + ' 탭이 없음');
    const last = sh.getLastRow(), nc = Math.min(sh.getLastColumn(), 20);
    const head = sh.getRange(1, 1, 3, nc).getDisplayValues(); const hr = head.findIndex(r => r.some(x => s_(x) === '도착지')); if (hr < 0) throw new Error('직출 시트 머리글(도착지)을 못 찾음');
    const H = head[hr], c = { bid: idx_(H, '낙찰일'), no: idx_(H, 'NO.'), grp: idx_(H, '그룹NO.'), bno: idx_(H, '낙찰NO.'), part: idx_(H, '부분'), fc: idx_(H, 'FC'), dest: idx_(H, '도착지'),
      plt: idx_(H, 'PLT수량'), cate: idx_(H, 'CATE'), dir: idx_(H, '직출여부'), ind: idx_(H, '입고일자'), slot: idx_(H, '오전/오후'), note: idx_(H, '사진') };
    const from = Math.max(hr + 2, last - 800);   // 최근 800줄만(빠르게)
    const v = sh.getRange(from, 1, last - from + 1, nc).getValues(), dv = sh.getRange(from, 1, last - from + 1, nc).getDisplayValues();
    const rows = [];
    v.forEach((r, i) => {
      const ind = d_(r[c.ind]) || d_(dv[i][c.ind]); if (!ind || ind < lo || ind > hi) return;
      const no = s_(dv[i][c.no]); if (!no) return;
      rows.push({ key: tab + ':' + no, bid_date: d_(r[c.bid]) || d_(dv[i][c.bid]), no: n_(dv[i][c.no]), group_no: s_(dv[i][c.grp]), bid_no: s_(dv[i][c.bno]), part: c.part >= 0 ? s_(dv[i][c.part]) : '',
        fc: s_(dv[i][c.fc]), dest: s_(dv[i][c.dest]), plt: s_(dv[i][c.plt]), cate: s_(dv[i][c.cate]), direct: /직출/.test(s_(dv[i][c.dir])), in_date: ind, slot: s_(dv[i][c.slot]), note: c.note >= 0 ? s_(dv[i][c.note]) : '' });
    });
    const res = UrlFetchApp.fetch(ENDPOINT.replace('sheet_push', 'direct_push'), { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY }, payload: JSON.stringify({ p_token: TOKEN, p_rows: rows }) });
    console.log('직출 알림', rows.length + '줄 →', res.getResponseCode(), res.getContentText());
  } finally { lock.releaseLock(); }
}
