// =====================================================================
//  킹콩 물류 배차 · 정산 — 연결 설정
//  비워 두면 '데모 모드'(이 브라우저에만 저장, 예시 데이터)로 바로 열립니다.
//  Supabase 프로젝트를 만든 뒤 Project Settings › API 의 두 값을 넣으면 실제 공유 DB로 동작합니다.
//  anon key 는 공개용 키라 GitHub에 올려도 됩니다(접근은 schema.sql 의 RLS · PIN 함수가 막음).
// =====================================================================
window.KK_CONFIG = {
  SUPABASE_URL: "",        // 예: "https://abcdxyz.supabase.co"
  SUPABASE_ANON_KEY: "",   // 예: "eyJhbGciOi..." 또는 "sb_publishable_..."
  COMPANY: "킹콩백화점",
};
