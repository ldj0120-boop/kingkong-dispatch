// =====================================================================
//  킹콩 물류 배차 · 정산 — 연결 설정
//  비워 두면 '데모 모드'(이 브라우저에만 저장, 예시 데이터)로 바로 열립니다.
//  Supabase 프로젝트를 만든 뒤 Project Settings › API 의 두 값을 넣으면 실제 공유 DB로 동작합니다.
//  anon key 는 공개용 키라 GitHub에 올려도 됩니다(접근은 schema.sql 의 RLS · PIN 함수가 막음).
// =====================================================================
window.KK_CONFIG = {
  SUPABASE_URL: "https://mlxnozcvtlqsmgyhslzf.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_c0ErFHj6ylcx4dXr5p4pGA_uEeVreu6",   // 공개용(publishable) 키 — 올려도 됨. secret 키는 절대 넣지 말 것
  COMPANY: "킹콩백화점",
  TEST_MODE: true,         // 테스트 운영 기간: 화면 위에 안내 띠 + '의견 남기기' + 정산 확정 잠금. 정식 운영 때 false
  PHASE: 1,                // 1 = 파일럿: 쿠팡 출고 + 진천센터 → 매장 출고만. 2 = 신선 센터 · 고객 배송까지
  PILOT_CENTER: "진천센터", // 1단계 매장 출고의 출발 센터
  STORES_OPEN: false,      // 1단계(킹콩본사 · 진천센터 · 더한물류)는 매장 화면을 닫아 둠. 2단계에 true(또는 PHASE: 2)
  STORE_PILOT: [],         // (예비) 여기에 적은 매장은 항상 열림. 보통은 진천센터 화면 '매장 관리 › 앱 열기'로 엶
  DISPATCH_DEADLINE: 22,   // 테스트 기간: 더한물류가 당일 22시까지 카톡 일괄 등록 → 경고도 22시 마감 기준. 정식 운영(실시간 등록) 때 이 줄을 지우면 2시간 · 30분 실시간 경고
  APP_ONLY_SETTLE: false,  // 정식 운영 때 true: 앱에 등록된 건만 정산(구글시트에서만 들어온 줄은 정산 제외)
  ORDERERS: ["킹콩본사", "킹콩백화점", "진천센터"],   // 발주처 그룹 — 차량 등록(배차 완료) 알림을 받는 곳
  VAPID_PUBLIC_KEY: "BM83zjDANcXX6gOY9lR9NI9IOTgPA8qu4rA9ZQBiAZMjoZoWZTNM-obrSqh4S6DItK3D5NgZSUoqxPUjQxxbms4",   // 휴대폰 알림용 공개키(공개해도 됨). 짝이 되는 비공개키는 Supabase Secrets 에만
};
