-- =====================================================================
--  킹콩백화점 통합 물류 배차 · 정산 시스템 — Supabase(Postgres) 스키마
--  Supabase 대시보드 › SQL Editor 에 이 파일 전체를 붙여넣고 Run.
--  구조: 3가지 요청 유형(쿠팡 · 센터/본사 · 고객배송)을 dispatches 한 테이블(통합 대장)에 모으고,
--        유형별 추가 항목은 dispatch_delivery(고객 정보) / 같은 행의 회차 칸으로 둔다.
--  접근: 킹콩 관리자 = Supabase Auth 로그인(staff 테이블에 등록된 이메일)
--        외주 업체   = 업체 링크 + PIN → 아래 vendor_* 함수(security definer)로만 읽고 쓴다.
--        테이블 직접 접근은 anon 에게 막혀 있다(RLS).
-- =====================================================================

create extension if not exists pgcrypto;   -- Supabase는 extensions 스키마에 설치됨(아래 함수들이 search_path 로 찾음)

-- ---------- 기준 정보 ----------
create table if not exists vendors (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,              -- 더한물류 (옛 이름 태성로지스틱스 · 태성물류 는 같은 곳)
  pin_hash    text not null,                     -- crypt(pin, gen_salt('bf'))
  types       text[] not null default '{coupang,center,delivery}', -- 맡는 유형
  contact     text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists places (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,              -- 표준 이름: 시그니처용인점, 진천센터, 시흥3 …
  kind        text not null check (kind in ('쿠팡FC','센터','매장','외부업체','기타')),
  aliases     text[] not null default '{}',      -- '용인점','시그니처 용인' 처럼 다르게 적힌 이름
  active      boolean not null default true
);

-- 운임표: 업체 · 유형 · 상차 → 하차 · 차종(톤) 별 기본 운임. 청구금액 검증(차액)에 쓴다.
create table if not exists rate_cards (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid references vendors(id) on delete cascade,
  type        text not null check (type in ('coupang','center','delivery')),
  from_place  text,                              -- null = 어디서든
  to_place    text,
  vehicle_ton numeric,                           -- null = 차종 무관
  plt_max     numeric,
  base_fare   integer not null,
  valid_from  date not null default current_date,
  note        text
);

create table if not exists staff (                -- 킹콩 관리자(로그인 이메일)
  email       text primary key,
  name        text,
  role        text not null default 'admin' check (role in ('admin','viewer'))
);

-- ---------- 통합 대장 ----------
create table if not exists dispatches (
  id            bigint generated always as identity primary key,
  type          text not null check (type in ('coupang','center','delivery')),
  status        text not null default 'requested'
                check (status in ('requested','assigned','done','checked','confirmed','canceled')),   -- checked = 본사 확인(최종 완료)
  vendor_id     uuid references vendors(id),
  origin        text not null default 'kingkong' check (origin in ('kingkong','vendor','store','sheet')), -- 업체 직접 등록 = vendor, 매장 앱 = store, 구글시트에서 온 줄 = sheet
  -- 킹콩이 요청할 때 채우는 칸
  run_date      date not null,                   -- 운행(상차) 예정일
  time_slot     text,                            -- 오전 · 오후 · 야간
  from_place    text not null,
  to_place      text not null,
  plt_qty       numeric,                         -- 파레트 수량(대형파렛 · 개수 단위는 cargo_note)
  temp          text not null default '상온' check (temp in ('상온','냉장','냉동')),
  cargo_note    text,                            -- 품목 · 특이사항
  ref_code      text,                            -- 쿠팡 입차CODE
  sheet_key     text unique,                     -- 구글시트에서 온 줄의 자리표(시트:탭:NO) — 1시간마다 같은 줄을 찾아 덮어씀
  checked_at    timestamptz,                     -- 본사 확인(최종 완료) 시각
  checked_by    text,
  group_no      text,                            -- 쿠팡 Group Number(여러 개면 쉼표) — 업체 카톡 '그룹넘버'와 자동 연결
  bid_no        text,                            -- 낙찰NO
  category      text,                            -- 카테고리(XLE, 기저귀/분유 …)
  pickup_addr   text,                            -- 상차지 주소 · 담당자 · 연락처(출고요청서)
  pickup_contact text,
  via_place     text,                            -- 경유지(카톡 '이천점2plt 경유 원주점2plt')
  requested_by  text,
  -- 업체가 채우는 칸
  driver_name   text,
  driver_phone  text,
  vehicle_no    text,
  vehicle_ton   numeric,                         -- 1, 1.4, 2.5, 3.5, 5, 11, 14, 18, 25
  vehicle_body  text,                            -- 윙 · 카고 · 탑 · 냉동탑 · 플축윙 · 초장축 …
  base_fare     integer,
  extra_fare    integer not null default 0,
  extra_reason  text,                            -- 대기 1시간 · 상하차 지연 · 경유 …
  billed_amount integer generated always as (coalesce(base_fare,0) + coalesce(extra_fare,0)) stored,
  -- 회차(돌아오는 길에 다른 물건을 실은 경우, 쿠팡 시트의 회차 칸)
  return_date   date,
  return_from   text,
  return_driver text,
  return_fare   integer,
  -- 정산
  rate_fare     integer,                         -- 운임표 기준 금액(저장 시 자동)
  settle_month  text,                             -- 'YYYY-MM' (트리거가 run_date 로 채움)
  memo          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    text
);
-- build 11: 삭제는 '휴지통'(되살리기 가능) · 삭제 권한자만
alter table dispatches add column if not exists deleted_at timestamptz;
alter table dispatches add column if not exists deleted_by text;
alter table dispatches add column if not exists delete_reason text;
alter table staff add column if not exists can_delete boolean not null default false;
create index if not exists dispatches_month_idx  on dispatches (settle_month, type);
create index if not exists dispatches_vendor_idx on dispatches (vendor_id, run_date);

-- 유형 3(고객 배송)만 쓰는 고객 정보 — 개인정보라 따로 둔다(업체에는 배송에 필요한 칸만 보여줌)
create table if not exists dispatch_delivery (
  dispatch_id    bigint primary key references dispatches(id) on delete cascade,
  order_date     date,
  store          text,                           -- 출고 매장
  customer_name  text,
  customer_phone text,
  address        text,
  product        text,                           -- 양문형냉장고, 안마의자 …
  qty            text,
  terms          text check (terms in ('무료','유료','무료(추가요금)')),
  done_note      text,                           -- '6/24 완료 / 중문 탈거 후 안착'
  -- 매장 배송요청서(종이) 항목 — 매장 앱에서 입력
  items          jsonb,                          -- [{"name":"수납장","qty":1,"size":"기본"}]  기본/대형
  tt_plt         numeric,                        -- T/T 파레트 수량
  elevator       text,                           -- 있음 · 없음 · '3층(계단)'
  disposal       text,                           -- 폐가구·가전 이동: 없음 · '기본 1개 / 대형 0개'
  distance       text,                           -- 20km 미만 · 20km 초과 · '35km'
  multi_stop     boolean,                        -- 2곳 이상 배송
  extra_paid     integer,                        -- 추가 결제 금액(영수증)
  buyer_same     boolean,                        -- 구매인 = 수화인
  buyer_name     text,
  receiver_name  text,
  asap           boolean,                        -- '최대한 빠른 날짜'
  request_note   text,                           -- 기타 내용 · 고객 요청사항
  paper_kept     boolean,                        -- 종이 배송요청서 원본 매장 보관
  consent_signed boolean,                        -- 배송 확인서(고객 서명) 받음
  requested_by   text                            -- 매장 담당자
);

-- 매장(앱으로 배송요청) — 링크 ?s=매장이름 + 매장 PIN
create table if not exists stores (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,              -- 이천점, 시그니처인천점 …
  pin_hash    text not null,
  active      boolean not null default true
);

-- 첨부(영수증 사진). 휴대폰에서 줄인 JPEG(약 150KB)를 data URL 로 저장 — 건수가 많아지면 Storage 버킷으로 옮김
create table if not exists attachments (
  id          bigint generated always as identity primary key,
  dispatch_id bigint not null references dispatches(id) on delete cascade,
  kind        text not null default 'receipt',
  data        text not null,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists attachments_dispatch_idx on attachments (dispatch_id);

create table if not exists settlements (          -- 업체 · 달 별 정산 확정
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references vendors(id),
  month        text not null,                    -- 'YYYY-MM'
  supply       integer not null,                 -- 공급가액
  vat          integer not null,
  total        integer not null,
  count        integer not null,
  confirmed_by text,
  confirmed_at timestamptz not null default now(),
  unique (vendor_id, month)
);

-- 배차 이력(타임라인): 요청 → 배차 → 배차 취소 · 회차 · 변경 → 재배차 → 운행 완료
--  카톡방에서 오가던 '취소입니다 재배차 하겠습니다', '상차지연으로 회차 입니다' 를 건마다 쌓아 누구나 같은 흐름을 본다
create table if not exists dispatch_events (
  id           bigint generated always as identity primary key,
  dispatch_id  bigint not null references dispatches(id) on delete cascade,
  at           timestamptz not null default now(),
  by           text,                             -- 이메일 · 'vendor:더한물류' · 'store:이천점'
  kind         text not null check (kind in ('request','assign','reassign','cancel_driver','return','change','done','check','cancel','note')),
  reason       text,                             -- 상차지연 · 차량고장 · 상차지 물건 없음 …
  note         text,
  fare         integer,                          -- 회차금액
  driver_name  text, driver_phone text, vehicle_no text, vehicle_ton numeric, vehicle_body text   -- 그때의 기사 · 차량
);
create index if not exists dispatch_events_idx on dispatch_events (dispatch_id, at);

-- 수정 기록: 모든 표의 추가 · 수정 · 삭제를 칸 단위(이전 → 이후)로, 누가 · 언제(초까지) 남긴다. 아래 audit_row 트리거가 자동으로 씀
create table if not exists audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default clock_timestamp(),
  table_name  text not null,                     -- dispatches · dispatch_delivery · dispatch_comments · rate_cards …
  row_id      text,
  dispatch_id bigint,                            -- 배차 건과 관련된 기록이면 그 번호(건이 지워져도 기록은 남음)
  actor       text not null,                     -- 관리자 이메일 · 'vendor:더한물류' · 'store:이천점'
  action      text not null,                     -- insert · update · delete
  diff        jsonb                              -- {"칸": [이전, 이후]} (insert/delete 는 그 행 전체)
);
create index if not exists audit_log_dispatch_idx on audit_log (dispatch_id, at);
create index if not exists audit_log_at_idx on audit_log (at desc);

-- 물류 담당자 질문 ↔ 더한물류 답변(통합 대장 비고란)
create table if not exists dispatch_comments (
  id          bigint generated always as identity primary key,
  dispatch_id bigint not null references dispatches(id) on delete cascade,
  at          timestamptz not null default clock_timestamp(),
  author      text not null default '',
  kind        text not null default 'question' check (kind in ('question','answer','note')),
  body        text not null check (length(body) between 1 and 1000),
  closed_at   timestamptz,                       -- 관리자가 '해결'로 닫은 시각
  closed_by   text
);
create index if not exists dispatch_comments_idx on dispatch_comments (dispatch_id, at);

-- ---------- 운임표 자동 매칭 · 수정 기록 ----------
create or replace function dispatches_before_write() returns trigger language plpgsql as $$
begin
  -- 금액(기본 · 추가 · 사유 · 회차금액)은 더한물류(업체 링크)만 입력 · 수정. 킹콩 관리자 로그인 세션이면 막는다
  if coalesce(auth.jwt() ->> 'email', '') <> '' then
    if tg_op = 'INSERT' and (new.base_fare is not null or coalesce(new.extra_fare, 0) <> 0 or new.return_fare is not null) then
      raise exception '금액은 더한물류만 입력할 수 있습니다'; end if;
    if tg_op = 'UPDATE' and (new.base_fare is distinct from old.base_fare or new.extra_fare is distinct from old.extra_fare
        or new.extra_reason is distinct from old.extra_reason or new.return_fare is distinct from old.return_fare) then
      raise exception '금액은 더한물류만 입력 · 수정할 수 있습니다'; end if;
  end if;
  new.updated_at := clock_timestamp();
  new.settle_month := to_char(new.run_date, 'YYYY-MM');
  select r.base_fare into new.rate_fare
    from rate_cards r
   where (r.vendor_id is null or r.vendor_id = new.vendor_id)
     and r.type = new.type
     and (r.from_place is null or r.from_place = new.from_place)
     and (r.to_place   is null or r.to_place   = new.to_place)
     and (r.vehicle_ton is null or r.vehicle_ton = new.vehicle_ton)
     and r.valid_from <= new.run_date
   order by (r.from_place is not null)::int + (r.to_place is not null)::int + (r.vehicle_ton is not null)::int desc,
            r.valid_from desc
   limit 1;
  return new;
end $$;
drop trigger if exists trg_dispatches_bw on dispatches;
create trigger trg_dispatches_bw before insert or update on dispatches
  for each row execute function dispatches_before_write();

-- 저장될 때 이력 자동 기록(요청 · 배차/재배차 · 완료 · 취소). 취소 · 회차 · 변경은 dispatch_event_apply 가 직접 남김
create or replace function dispatches_track() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare had_trouble boolean;
begin
  if coalesce(current_setting('kk.skip_track', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' then
    insert into dispatch_events(dispatch_id, by, kind, driver_name, driver_phone, vehicle_no, vehicle_ton, vehicle_body)
    values (new.id, new.updated_by, case when new.origin = 'vendor' then (case when new.status = 'done' then 'done' else 'assign' end) else 'request' end,
            new.driver_name, new.driver_phone, new.vehicle_no, new.vehicle_ton, new.vehicle_body);
    return new;
  end if;
  if coalesce(new.driver_name,'') <> '' and (new.driver_name is distinct from old.driver_name or new.vehicle_no is distinct from old.vehicle_no) then
    select exists(select 1 from dispatch_events where dispatch_id = new.id and kind in ('cancel_driver','return')) into had_trouble;
    insert into dispatch_events(dispatch_id, by, kind, driver_name, driver_phone, vehicle_no, vehicle_ton, vehicle_body)
    values (new.id, new.updated_by, case when had_trouble or coalesce(old.driver_name,'') <> '' then 'reassign' else 'assign' end,
            new.driver_name, new.driver_phone, new.vehicle_no, new.vehicle_ton, new.vehicle_body);
  end if;
  if new.status is distinct from old.status and new.status in ('done','canceled','checked') and not (new.status = 'done' and old.status = 'checked') then
    insert into dispatch_events(dispatch_id, by, kind, driver_name, driver_phone, vehicle_no, vehicle_ton, vehicle_body)
    values (new.id, new.updated_by, case when new.status = 'done' then 'done' when new.status = 'checked' then 'check' else 'cancel' end, new.driver_name, new.driver_phone, new.vehicle_no, new.vehicle_ton, new.vehicle_body);
  end if;
  return new;
end $$;
drop trigger if exists trg_dispatches_track on dispatches;
create trigger trg_dispatches_track after insert or update on dispatches
  for each row execute function dispatches_track();

-- 취소 · 회차 · 변경 적용(관리자 · 업체 공용 본체 — 직접 부를 수 없고 staff_event / vendor_event 를 거침)
--  ev = {"kind":"cancel_driver"|"return"|"change"|"cancel"|"note", "reason", "note", "fare"(회차금액), "end"(회차 후 요청 종료), "run_date","time_slot","to_place"(변경), "at"(카톡 메시지 시각)}
create or replace function dispatch_event_apply(p_id bigint, ev jsonb, actor text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare r dispatches; k text := ev->>'kind'; chg text := '';
begin
  select * into r from dispatches where id = p_id for update;
  if r.id is null then raise exception '없는 배차입니다'; end if;
  if r.status = 'confirmed' then raise exception '정산 확정된 건은 고칠 수 없습니다'; end if;
  if k not in ('cancel_driver','return','change','cancel','note') then raise exception '알 수 없는 기록'; end if;
  if k in ('cancel_driver','return') and r.status in ('done','checked') then raise exception '운행 완료된 건은 회차 · 기사 취소로 되돌릴 수 없습니다 — 회차비는 배차 입력의 회차금액 칸에'; end if;   -- build 24: 시뮬레이션에서 발견(완료 건이 배차 요청으로 되돌아감)
  if k = 'change' then
    if coalesce(ev->>'run_date','') <> '' and (ev->>'run_date')::date <> r.run_date then chg := chg || format(' 운행일 %s→%s', r.run_date, ev->>'run_date'); end if;
    if coalesce(ev->>'time_slot','') <> '' and ev->>'time_slot' is distinct from r.time_slot then chg := chg || format(' 시간대 %s→%s', coalesce(r.time_slot,'-'), ev->>'time_slot'); end if;
    if coalesce(ev->>'to_place','') <> '' and ev->>'to_place' <> r.to_place then chg := chg || format(' 하차지 %s→%s', r.to_place, ev->>'to_place'); end if;
  end if;
  insert into dispatch_events(dispatch_id, at, by, kind, reason, note, fare, driver_name, driver_phone, vehicle_no, vehicle_ton, vehicle_body)
  values (p_id, coalesce(nullif(ev->>'at','')::timestamptz, now()), actor, k, ev->>'reason', trim(coalesce(ev->>'note','') || chg), nullif(ev->>'fare','')::int,
          r.driver_name, r.driver_phone, r.vehicle_no, r.vehicle_ton, r.vehicle_body);
  perform set_config('kk.skip_track', '1', true);
  if k in ('cancel_driver','return') then
    update dispatches set
      return_fare   = case when k = 'return' and coalesce(ev->>'fare','') <> '' then coalesce(return_fare,0) + (ev->>'fare')::int else return_fare end,
      return_date   = case when k = 'return' and coalesce(ev->>'fare','') <> '' then current_date else return_date end,
      return_driver = case when k = 'return' and coalesce(ev->>'fare','') <> '' then r.driver_name else return_driver end,
      return_from   = case when k = 'return' and coalesce(ev->>'fare','') <> '' then r.from_place else return_from end,
      driver_name = null, driver_phone = null, vehicle_no = null, vehicle_ton = null, vehicle_body = null,
      status = case when coalesce((ev->>'end')::boolean, false) then 'canceled' else 'requested' end,
      updated_by = actor
    where id = p_id;
  elsif k = 'change' then
    update dispatches set
      run_date  = coalesce(nullif(ev->>'run_date','')::date, run_date),
      time_slot = coalesce(nullif(ev->>'time_slot',''), time_slot),
      to_place  = coalesce(nullif(ev->>'to_place',''), to_place),
      updated_by = actor
    where id = p_id;
  elsif k = 'cancel' then
    update dispatches set status = 'canceled', updated_by = actor where id = p_id;
  end if;
  perform set_config('kk.skip_track', '', true);
end $$;
revoke all on function dispatch_event_apply(bigint, jsonb, text) from public, anon, authenticated;

create or replace function staff_event(p_id bigint, ev jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_staff() then raise exception '권한이 없습니다'; end if;
  perform dispatch_event_apply(p_id, ev, auth.jwt() ->> 'email');
end $$;

-- ---------- 수정 기록 트리거(모든 표) ----------
create or replace function audit_row() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  d jsonb := '{}'; k text;
  skip text[] := array['updated_at','updated_by','settle_month','billed_amount','rate_fare','pin_hash','data','created_at'];
  who text; rid text; did bigint;
begin
  who := coalesce(nullif(auth.jwt() ->> 'email', ''), nullif(current_setting('kk.actor', true), ''), n ->> 'updated_by', o ->> 'updated_by', n ->> 'author', n ->> 'by', current_user);
  rid := coalesce(n ->> 'id', o ->> 'id', n ->> 'dispatch_id', o ->> 'dispatch_id');
  did := case when tg_table_name = 'dispatches' then rid::bigint else nullif(coalesce(n ->> 'dispatch_id', o ->> 'dispatch_id'), '')::bigint end;
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(n) loop
      if not (k = any(skip)) and (o -> k) is distinct from (n -> k) then d := d || jsonb_build_object(k, jsonb_build_array(o -> k, n -> k)); end if;
    end loop;
    if (o ? 'pin_hash') and (o ->> 'pin_hash') is distinct from (n ->> 'pin_hash') then d := d || '{"PIN": ["****", "변경"]}'; end if;
    if d = '{}' then return new; end if;
  elsif tg_op = 'INSERT' then d := n - skip;
  else d := o - skip; end if;
  insert into audit_log(table_name, row_id, dispatch_id, actor, action, diff) values (tg_table_name, rid, did, who, lower(tg_op), d);
  return coalesce(new, old);
end $$;
do $$ declare t text; begin
  foreach t in array array['dispatches','dispatch_delivery','dispatch_comments','attachments','rate_cards','places','vendors','stores','settlements','staff'] loop
    execute format('drop trigger if exists trg_audit on %I', t);
    execute format('create trigger trg_audit after insert or update or delete on %I for each row execute function audit_row()', t);
  end loop;
end $$;
-- 질문 · 답변 작성자는 서버가 정한다
create or replace function comments_before() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'INSERT' then
    new.at := clock_timestamp();
    new.author := coalesce(nullif(auth.jwt() ->> 'email', ''), nullif(current_setting('kk.actor', true), ''), new.author);
  end if;
  if tg_op = 'UPDATE' and new.closed_at is not null and old.closed_at is null then new.closed_by := coalesce(nullif(auth.jwt() ->> 'email', ''), new.closed_by); end if;
  return new;
end $$;
drop trigger if exists trg_comments_before on dispatch_comments;
create trigger trg_comments_before before insert or update on dispatch_comments for each row execute function comments_before();

-- ---------- 보안(RLS) ----------
alter table vendors           enable row level security;
alter table places            enable row level security;
alter table rate_cards        enable row level security;
alter table staff             enable row level security;
alter table dispatches        enable row level security;
alter table dispatch_delivery enable row level security;
alter table settlements       enable row level security;
alter table audit_log         enable row level security;
alter table stores            enable row level security;
alter table attachments       enable row level security;
alter table dispatch_events   enable row level security;
alter table dispatch_comments enable row level security;

create or replace function is_staff() returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from staff where email = auth.jwt() ->> 'email');
$$;

do $$ declare t text; begin
  foreach t in array array['vendors','places','rate_cards','staff','dispatches','dispatch_delivery','settlements','audit_log','stores','attachments','dispatch_events','dispatch_comments'] loop
    execute format('drop policy if exists staff_all on %I', t);
    execute format('create policy staff_all on %I for all to authenticated using (is_staff()) with check (is_staff())', t);
  end loop;
end $$;
-- 수정 기록은 읽기만(관리자도 고치거나 지울 수 없음)
drop policy if exists staff_all on audit_log;
drop policy if exists staff_read on audit_log;
create policy staff_read on audit_log for select to authenticated using (is_staff());

-- ---------- 업체용 함수(링크 + PIN). anon 은 이 함수들만 부를 수 있다 ----------
create or replace function vendor_check(p_vendor text, p_pin text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid;
begin
  select id into v from vendors
   where name = p_vendor and active and pin_hash = crypt(p_pin, pin_hash);
  if v is null then raise exception 'PIN이 맞지 않습니다'; end if;
  perform set_config('kk.actor', 'vendor:' || p_vendor, true);   -- 수정 기록의 '누가'
  return v;
end $$;

-- 업체 화면 목록: 자기 업체 건 + 아직 업체가 정해지지 않은 요청(맡을 유형만), 최근 45일
create or replace function vendor_list(p_vendor text, p_pin text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin); vt text[];
begin
  select types into vt from vendors where id = v;
  return query
    select to_jsonb(d) - 'memo' || jsonb_build_object(
             'delivery', (select to_jsonb(x) - 'dispatch_id' from dispatch_delivery x where x.dispatch_id = d.id),
             'events',   (select coalesce(jsonb_agg(to_jsonb(e) - 'dispatch_id' order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id),
             'comments', (select coalesce(jsonb_agg(to_jsonb(c) - 'dispatch_id' order by c.at), '[]') from dispatch_comments c where c.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null and (d.status <> 'canceled' or d.updated_at >= now() - interval '3 days')
       and d.run_date >= current_date - 45
       and (d.vendor_id = v or (d.vendor_id is null and d.type = any(vt)))
     order by d.run_date desc, d.id desc;
end $$;

-- 업체가 배차 결과 입력 · 수정 (확정된 건은 못 고침)
create or replace function vendor_save(p_vendor text, p_pin text, p_id bigint, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin); r dispatches;
begin
  select * into r from dispatches where id = p_id;
  if r.id is null then raise exception '없는 배차입니다'; end if;
  if r.vendor_id is not null and r.vendor_id <> v then raise exception '다른 업체의 배차입니다'; end if;
  if r.status = 'confirmed' then raise exception '정산 확정된 건은 고칠 수 없습니다'; end if;
  update dispatches set
    vendor_id    = v,
    driver_name  = p->>'driver_name',
    driver_phone = p->>'driver_phone',
    vehicle_no   = p->>'vehicle_no',
    vehicle_ton  = nullif(p->>'vehicle_ton','')::numeric,
    vehicle_body = p->>'vehicle_body',
    base_fare    = nullif(p->>'base_fare','')::int,
    extra_fare   = coalesce(nullif(p->>'extra_fare','')::int, 0),
    extra_reason = p->>'extra_reason',
    return_date  = case when p ? 'return_date'   then nullif(p->>'return_date','')::date else return_date end,   -- 회차 칸은 보낼 때만 바꿈
    return_from  = case when p ? 'return_from'   then p->>'return_from' else return_from end,
    return_driver= case when p ? 'return_driver' then p->>'return_driver' else return_driver end,
    return_fare  = case when p ? 'return_fare'   then nullif(p->>'return_fare','')::int else return_fare end,
    run_date     = case when r.type = 'delivery' and coalesce(p->>'run_date','') <> '' then (p->>'run_date')::date else r.run_date end, -- 고객배송은 업체가 배송일을 정함
    status       = case when coalesce(p->>'status','') in ('assigned','done') then p->>'status' else 'assigned' end,   -- 확인 끝난 건을 고치면 '운행 완료'로 돌아가 다시 확인
    checked_at   = case when r.status = 'checked' then null else checked_at end,
    checked_by   = case when r.status = 'checked' then null else checked_by end,
    updated_by   = 'vendor:' || p_vendor
  where id = p_id returning * into r;
  if r.type = 'delivery' and p ? 'done_note' then
    update dispatch_delivery set done_note = p->>'done_note' where dispatch_id = p_id;
  end if;
  return to_jsonb(r);
end $$;

-- 업체가 '기사 취소 · 재배차' · '회차' · '변경'을 기록(카톡 알림과 같은 내용)
create or replace function vendor_event(p_vendor text, p_pin text, p_id bigint, ev jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin); r dispatches;
begin
  select * into r from dispatches where id = p_id;
  if r.id is null or (r.vendor_id is not null and r.vendor_id <> v) then raise exception '다른 업체의 배차입니다'; end if;
  if ev->>'kind' = 'cancel' then raise exception '요청 취소는 킹콩만 할 수 있습니다'; end if;
  perform dispatch_event_apply(p_id, ev, 'vendor:' || p_vendor);
end $$;

-- 더한물류가 비고란 질문에 답변
create or replace function vendor_comment(p_vendor text, p_pin text, p_id bigint, p_body text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin); r dispatches;
begin
  select * into r from dispatches where id = p_id;
  if r.id is null or (r.vendor_id is not null and r.vendor_id <> v) then raise exception '다른 업체의 배차입니다'; end if;
  insert into dispatch_comments(dispatch_id, author, kind, body) values (p_id, 'vendor:' || p_vendor, 'answer', left(p_body, 1000));
end $$;

-- 업체가 요청 없이 직접 운행한 건 올리기(유형 2에서 흔함) → origin='vendor', 킹콩이 확인
create or replace function vendor_add(p_vendor text, p_pin text, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin); r dispatches;
begin
  insert into dispatches(type, status, vendor_id, origin, run_date, time_slot, via_place, requested_by, from_place, to_place, plt_qty, temp, cargo_note, group_no,
                         driver_name, driver_phone, vehicle_no, vehicle_ton, vehicle_body, base_fare, extra_fare, extra_reason, updated_by)
  values (coalesce(p->>'type','center'), case when p->>'status' in ('assigned','requested') then p->>'status' else 'done' end, v,
          case when p->>'status' = 'requested' then 'kingkong' else 'vendor' end,   -- 더한이 카톡 요청 글을 등록하면 '킹콩 요청'으로
          (p->>'run_date')::date, nullif(p->>'time_slot',''), nullif(p->>'via_place',''), nullif(p->>'requested_by',''), p->>'from_place', p->>'to_place',
          nullif(p->>'plt_qty','')::numeric, coalesce(p->>'temp','상온'), p->>'cargo_note', p->>'group_no',
          p->>'driver_name', p->>'driver_phone', p->>'vehicle_no', nullif(p->>'vehicle_ton','')::numeric, p->>'vehicle_body',
          nullif(p->>'base_fare','')::int, coalesce(nullif(p->>'extra_fare','')::int,0), p->>'extra_reason', 'vendor:' || p_vendor)
  returning * into r;
  return to_jsonb(r);
end $$;

-- 업체 화면의 자동완성(지점 · 운임표)
create or replace function vendor_refs(p_vendor text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin);
begin
  return jsonb_build_object(
    'places', (select coalesce(jsonb_agg(name order by name), '[]') from places where active),
    'place_list', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'aliases', aliases)), '[]') from places where active),
    'rates',  (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from rate_cards r where r.vendor_id = v or r.vendor_id is null));
end $$;

-- ---------- 매장용 함수(링크 + 매장 PIN) — 고객배송 요청 등록 · 내 매장 요청 보기 ----------
create or replace function store_check(p_store text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare n text;
begin
  select name into n from stores where name = p_store and active and pin_hash = crypt(p_pin, pin_hash);
  if n is null then raise exception 'PIN이 맞지 않습니다'; end if;
  perform set_config('kk.actor', 'store:' || p_store, true);
  return n;
end $$;

create or replace function store_list(p_store text, p_pin text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin);
begin
  return query
    select jsonb_build_object('id', d.id, 'status', d.status, 'run_date', d.run_date, 'created_at', d.created_at,
             'type', d.type, 'from_place', d.from_place, 'to_place', d.to_place, 'plt_qty', d.plt_qty, 'time_slot', d.time_slot, 'temp', d.temp, 'cargo_note', d.cargo_note, 'origin', d.origin, 'requested_by', d.requested_by,
             'vehicle_ton', d.vehicle_ton, 'vehicle_body', d.vehicle_body,
             'driver_name', d.driver_name, 'driver_phone', d.driver_phone, 'vehicle_no', d.vehicle_no,
             'vendor', (select name from vendors v where v.id = d.vendor_id),
             'receipts', (select count(*) from attachments a where a.dispatch_id = d.id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'note', e.note) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id),
             'delivery', (select to_jsonb(x) - 'dispatch_id' from dispatch_delivery x where x.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null and ((d.type = 'delivery' and d.from_place = s) or (d.type <> 'delivery' and d.to_place = s))   -- 우리 매장 고객배송 + 우리 매장으로 오는 쿠팡 · 센터 출고
       and coalesce(d.created_at, now()) >= now() - interval '90 days'
     order by d.id desc;
end $$;

create or replace function store_add(p_store text, p_pin text, p jsonb, p_files jsonb default '[]')
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin); nid bigint; f jsonb; x jsonb := p->'delivery';
begin
  if jsonb_array_length(coalesce(p_files,'[]')) = 0 then raise exception '영수증 사진을 1장 이상 붙여 주세요'; end if;
  insert into dispatches(type, status, origin, run_date, from_place, to_place, temp, cargo_note, requested_by, updated_by)
  values ('delivery', 'requested', 'store', (p->>'run_date')::date, s, '고객', '상온', p->>'cargo_note', 'store:' || s, 'store:' || s)
  returning id into nid;
  insert into dispatch_delivery(dispatch_id, order_date, store, customer_name, customer_phone, address, product, qty, terms,
      items, tt_plt, elevator, disposal, distance, multi_stop, extra_paid, buyer_same, buyer_name, receiver_name,
      asap, request_note, paper_kept, consent_signed, requested_by)
  values (nid, coalesce(nullif(x->>'order_date','')::date, current_date), s, x->>'customer_name', x->>'customer_phone', x->>'address',
      x->>'product', x->>'qty', nullif(x->>'terms',''), x->'items', nullif(x->>'tt_plt','')::numeric, x->>'elevator', x->>'disposal',
      x->>'distance', (x->>'multi_stop')::boolean, nullif(x->>'extra_paid','')::int, (x->>'buyer_same')::boolean, x->>'buyer_name',
      x->>'receiver_name', (x->>'asap')::boolean, x->>'request_note', (x->>'paper_kept')::boolean, (x->>'consent_signed')::boolean, x->>'requested_by');
  for f in select * from jsonb_array_elements(p_files) loop
    if length(f #>> '{}') > 1500000 then raise exception '사진이 너무 큽니다'; end if;
    insert into attachments(dispatch_id, kind, data, created_by) values (nid, 'receipt', f #>> '{}', 'store:' || s);
  end loop;
  return nid;
end $$;

-- 매장이 접수 단계(배차 전)의 요청만 취소
create or replace function store_cancel(p_store text, p_pin text, p_id bigint)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin);
begin
  update dispatches set status = 'canceled', updated_by = 'store:' || s
   where id = p_id and status = 'requested' and ((type = 'delivery' and from_place = s) or (origin = 'store' and to_place = s));
  if not found then raise exception '배차가 이미 잡힌 건은 본사에 연락해 주세요'; end if;
end $$;

revoke all on function store_check(text,text) from public;
grant execute on function store_list(text,text), store_add(text,text,jsonb,jsonb), store_cancel(text,text,bigint) to anon, authenticated;

revoke all on function vendor_check(text,text) from public;
grant execute on function staff_event(bigint,jsonb) to authenticated;
grant execute on function vendor_event(text,text,bigint,jsonb), vendor_comment(text,text,bigint,text) to anon, authenticated;
revoke all on function audit_row() from public, anon, authenticated;
grant execute on function vendor_list(text,text), vendor_save(text,text,bigint,jsonb),
                         vendor_add(text,text,jsonb), vendor_refs(text,text) to anon, authenticated;

-- 업체 등록(관리자가 SQL Editor 에서 실행): PIN 은 업체에 따로 전달
-- insert into vendors(name, pin_hash, types) values ('더한물류', crypt('1357', gen_salt('bf')), '{coupang,center,delivery}');
-- insert into staff(email, name) values ('ldj0120@kinggo.ai', '이동주');
-- insert into stores(name, pin_hash) values ('이천점', crypt('1111', gen_salt('bf'))), ('시그니처인천점', crypt('2222', gen_salt('bf')));

-- ---------- 대시보드용 집계 뷰 ----------
create or replace view v_monthly_cost as
select settle_month, type, vendor_id, count(*) as runs,
       sum(billed_amount) as billed, sum(coalesce(return_fare,0)) as return_fare,
       sum(case when rate_fare is not null then billed_amount - rate_fare end) as over_rate
  from dispatches where status <> 'canceled'
 group by 1,2,3;

-- =====================================================================
--  휴대폰 알림(웹 푸시) — 새 요청 · 취소 · 변경 · 질문은 더한물류로, 회차 · 배차 취소 · 답변은 킹콩으로, 배차 완료는 매장으로
--  흐름: dispatch_events / dispatch_comments 에 줄이 생김 → kk_notify() 가 Edge Function 'notify' 를 부름(pg_net) → 등록된 휴대폰에 알림
--  app_config 에 notify_url · notify_secret · anon_key 를 넣기 전에는 아무것도 보내지 않는다(설치 순서와 상관없이 안전)
-- =====================================================================
create extension if not exists pg_net;   -- Supabase 기본 제공(없으면 이 줄만 실패해도 나머지는 동작)

create table if not exists app_config (key text primary key, value text not null);   -- 비밀값: 정책 없음 → 아무도 직접 못 읽음
alter table app_config enable row level security;

create table if not exists push_subs (
  id         bigint generated always as identity primary key,
  who        text not null,                      -- 'vendor:더한물류' · 'store:이천점' · 관리자 이메일
  endpoint   text not null unique,
  sub        jsonb not null,                     -- 브라우저 PushSubscription
  ua         text,
  created_at timestamptz not null default now()
);
alter table push_subs enable row level security;
drop policy if exists staff_all on push_subs;
create policy staff_all on push_subs for all to authenticated using (is_staff()) with check (is_staff());

-- 테스트 기간 의견(누구나 화면에서 '의견 남기기')
create table if not exists feedback (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default clock_timestamp(),
  who     text not null,
  page    text,
  body    text not null check (length(body) between 1 and 2000),
  done_at timestamptz
);
alter table feedback enable row level security;
drop policy if exists staff_all on feedback;
create policy staff_all on feedback for all to authenticated using (is_staff()) with check (is_staff());

create or replace function push_subscribe(p_kind text, p_name text, p_pin text, p_sub jsonb, p_ua text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare who text;
begin
  if p_kind = 'vendor' then perform vendor_check(p_name, p_pin); who := 'vendor:' || p_name;
  elsif p_kind = 'store' then perform store_check(p_name, p_pin); who := 'store:' || p_name;
  elsif p_kind = 'staff' and is_staff() then who := auth.jwt() ->> 'email';
  else raise exception '권한이 없습니다'; end if;
  insert into push_subs(who, endpoint, sub, ua) values (who, p_sub ->> 'endpoint', p_sub, p_ua)
  on conflict (endpoint) do update set who = excluded.who, sub = excluded.sub, ua = excluded.ua, created_at = now();
end $$;

create or replace function feedback_add(p_kind text, p_name text, p_pin text, p_page text, p_body text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare who text;
begin
  if p_kind = 'vendor' then perform vendor_check(p_name, p_pin); who := 'vendor:' || p_name;
  elsif p_kind = 'store' then perform store_check(p_name, p_pin); who := 'store:' || p_name;
  elsif is_staff() then who := auth.jwt() ->> 'email';
  else raise exception '권한이 없습니다'; end if;
  insert into feedback(who, page, body) values (who, p_page, left(p_body, 2000));
end $$;
grant execute on function push_subscribe(text,text,text,jsonb,text), feedback_add(text,text,text,text,text) to anon, authenticated;

-- 알림 보내기(받는 쪽: 'vendor:더한물류' · 'vendor:*' · 'store:이천점' · 'staff')
create or replace function kk_notify(p_to text[], p_title text, p_body text, p_url text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare u text; s text; k text;
begin
  select value into u from app_config where key = 'notify_url';
  select value into s from app_config where key = 'notify_secret';
  select value into k from app_config where key = 'anon_key';
  if u is null or s is null or to_regproc('net.http_post') is null then return; end if;
  if coalesce(current_setting('kk.no_notify', true), '') = '1' then return; end if;   -- 구글시트 1시간 동기화 때는 알림을 보내지 않음
  execute 'select net.http_post(url := $1, headers := $2, body := $3)'
    using u, jsonb_build_object('Content-Type', 'application/json', 'x-kk-secret', s, 'Authorization', 'Bearer ' || coalesce(k, '')),
          jsonb_build_object('to', p_to, 'title', p_title, 'body', p_body, 'url', coalesce(p_url, ''));
exception when others then null;   -- 알림이 실패해도 저장은 그대로
end $$;
revoke all on function kk_notify(text[], text, text, text) from public, anon, authenticated;

create or replace function notify_on_event() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare d dispatches; vn text; route text; tag text; who text := coalesce(to_jsonb(new) ->> 'by', '');
begin
  select * into d from dispatches where id = new.dispatch_id;
  select 'vendor:' || name into vn from vendors where id = d.vendor_id;
  route := format('%s %s→%s%s%s', to_char(d.run_date, 'MM/DD'), d.from_place, case when d.type = 'delivery' then '고객' else d.to_place end,
                  case when d.plt_qty is not null then ' ' || d.plt_qty || 'plt' else '' end, case when d.time_slot <> '' then ' ' || d.time_slot else '' end);
  tag := '#' || d.id || ' ';
  if new.kind = 'request' then
    perform kk_notify(array[coalesce(vn, 'vendor:*')] || case when d.origin = 'store' then array['staff'] else '{}'::text[] end,
                      case when d.origin = 'store' then '매장 배송 요청' else '새 배차 요청' end, tag || route, '?v=');
  elsif new.kind = 'cancel' then
    perform kk_notify(array[coalesce(vn, 'vendor:*')] || case when who not like 'staff%' and who like 'store:%' then array['staff'] else '{}'::text[] end, '배차 취소', tag || route, '?v=');
  elsif new.kind = 'change' and who not like 'vendor:%' then
    perform kk_notify(array[coalesce(vn, 'vendor:*')], '배차 변경', tag || route || ' · ' || coalesce(new.note, ''), '?v=');
  elsif new.kind in ('cancel_driver', 'return') then
    perform kk_notify(array['staff'], case when new.kind = 'return' then '회차' else '기사 취소 · 재배차' end, tag || route || ' · ' || coalesce(new.reason, ''), '');
  elsif new.kind in ('assign', 'reassign') and d.origin = 'store' then
    perform kk_notify(array['store:' || d.from_place], '배송 배차 완료', tag || to_char(d.run_date, 'MM/DD') || ' 기사 ' || coalesce(new.driver_name, ''), '?s=');
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_event on dispatch_events;
create trigger trg_notify_event after insert on dispatch_events for each row execute function notify_on_event();

create or replace function notify_on_comment() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare d dispatches; vn text;
begin
  select * into d from dispatches where id = new.dispatch_id;
  select 'vendor:' || name into vn from vendors where id = d.vendor_id;
  if new.kind = 'answer' then perform kk_notify(array['staff'], '더한물류 답변', '#' || d.id || ' ' || left(new.body, 80), '');
  else perform kk_notify(array[coalesce(vn, 'vendor:*')], '킹콩 질문', '#' || d.id || ' ' || d.from_place || '→' || d.to_place || ' · ' || left(new.body, 80), '?v='); end if;
  return new;
end $$;
drop trigger if exists trg_notify_comment on dispatch_comments;
create trigger trg_notify_comment after insert on dispatch_comments for each row execute function notify_on_comment();


-- =====================================================================
--  본사 확인(최종 완료) — 확인 담당자 링크 ?c=이름 + PIN. 운행 완료 건을 보고 '확인' → checked
-- =====================================================================
create table if not exists checkers (
  id       uuid primary key default gen_random_uuid(),
  name     text not null unique,                 -- 본사물류 · 진천센터 …(이름만 다를 뿐 모두 전체 건을 확인)
  pin_hash text not null,
  active   boolean not null default true
);
alter table checkers enable row level security;
drop policy if exists staff_all on checkers;
create policy staff_all on checkers for all to authenticated using (is_staff()) with check (is_staff());
drop trigger if exists trg_audit on checkers;
create trigger trg_audit after insert or update or delete on checkers for each row execute function audit_row();

create or replace function checker_check(p_name text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare n text;
begin
  select name into n from checkers where name = p_name and active and pin_hash = crypt(p_pin, pin_hash);
  if n is null then raise exception 'PIN이 맞지 않습니다'; end if;
  perform set_config('kk.actor', 'checker:' || p_name, true);
  return n;
end $$;
-- 확인 화면 목록: 최근 45일 운행 완료 · 확인 · 정산 확정 건(금액 · 기사 · 이력 · 질문 포함, 고객 개인정보는 이름 · 주소만)
create or replace function checker_list(p_name text, p_pin text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform checker_check(p_name, p_pin);
  return query
    select to_jsonb(d) - 'memo' || jsonb_build_object(
             'vendor', (select name from vendors v where v.id = d.vendor_id),
             'delivery', (select jsonb_build_object('customer_name', x.customer_name, 'address', x.address, 'product', x.product, 'qty', x.qty, 'done_note', x.done_note) from dispatch_delivery x where x.dispatch_id = d.id),
             'events',   (select coalesce(jsonb_agg(to_jsonb(e) - 'dispatch_id' order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id),
             'comments', (select coalesce(jsonb_agg(to_jsonb(c) - 'dispatch_id' order by c.at), '[]') from dispatch_comments c where c.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null and d.run_date >= current_date - 45 and d.status in ('assigned','done','checked','confirmed')
     order by d.run_date desc, d.id desc;
end $$;
create or replace function checker_confirm(p_name text, p_pin text, p_ids bigint[])
returns int language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  perform checker_check(p_name, p_pin);
  update dispatches set status = 'checked', checked_at = clock_timestamp(), checked_by = 'checker:' || p_name, updated_by = 'checker:' || p_name
   where id = any(p_ids) and status = 'done';
  get diagnostics n = row_count; return n;
end $$;
create or replace function checker_undo(p_name text, p_pin text, p_id bigint)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform checker_check(p_name, p_pin);
  update dispatches set status = 'done', checked_at = null, checked_by = null, updated_by = 'checker:' || p_name where id = p_id and status = 'checked';
  if not found then raise exception '정산 확정된 건은 되돌릴 수 없습니다'; end if;
end $$;
create or replace function checker_comment(p_name text, p_pin text, p_id bigint, p_body text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform checker_check(p_name, p_pin);
  insert into dispatch_comments(dispatch_id, author, kind, body) values (p_id, 'checker:' || p_name, 'question', left(p_body, 1000));
end $$;
revoke all on function checker_check(text,text) from public;
grant execute on function checker_list(text,text), checker_confirm(text,text,bigint[]), checker_undo(text,text,bigint), checker_comment(text,text,bigint,text) to anon, authenticated;
-- push_subscribe / feedback_add 에 확인 담당자도
create or replace function push_subscribe(p_kind text, p_name text, p_pin text, p_sub jsonb, p_ua text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare who text;
begin
  if p_kind = 'vendor' then perform vendor_check(p_name, p_pin); who := 'vendor:' || p_name;
  elsif p_kind = 'store' then perform store_check(p_name, p_pin); who := 'store:' || p_name;
  elsif p_kind = 'checker' then perform checker_check(p_name, p_pin); who := 'checker:' || p_name;
  elsif p_kind = 'staff' and is_staff() then who := auth.jwt() ->> 'email';
  else raise exception '권한이 없습니다'; end if;
  insert into push_subs(who, endpoint, sub, ua) values (who, p_sub ->> 'endpoint', p_sub, p_ua)
  on conflict (endpoint) do update set who = excluded.who, sub = excluded.sub, ua = excluded.ua, created_at = now();
end $$;
create or replace function feedback_add(p_kind text, p_name text, p_pin text, p_page text, p_body text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare who text;
begin
  if p_kind = 'vendor' then perform vendor_check(p_name, p_pin); who := 'vendor:' || p_name;
  elsif p_kind = 'store' then perform store_check(p_name, p_pin); who := 'store:' || p_name;
  elsif p_kind = 'checker' then perform checker_check(p_name, p_pin); who := 'checker:' || p_name;
  elsif is_staff() then who := auth.jwt() ->> 'email';
  else raise exception '권한이 없습니다'; end if;
  insert into feedback(who, page, body) values (who, p_page, left(p_body, 2000));
end $$;
-- 운행 완료되면 확인 담당자에게 알림
create or replace function notify_on_done() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.kind = 'done' then
    perform kk_notify(array['checker:*'], '확인 대기', (select format('#%s %s %s→%s', d.id, to_char(d.run_date, 'MM/DD'), d.from_place, case when d.type = 'delivery' then '고객' else d.to_place end) from dispatches d where d.id = new.dispatch_id), '?c=');
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_done on dispatch_events;
create trigger trg_notify_done after insert on dispatch_events for each row execute function notify_on_done();
-- insert into checkers(name, pin_hash) values ('본사물류', crypt('4321', gen_salt('bf')));

-- =====================================================================
--  구글시트 → 통합 대장(1시간마다). Edge Function 'sheet-sync' 가 service role 로 부름 — 일반 사용자는 못 부름
--  p_rows: [{key, type, run_date, time_slot, from_place, to_place, plt_qty, temp, driver_name, vehicle_no, vehicle_ton, vehicle_body,
--            base_fare, extra_fare, extra_reason, return_date, return_from, return_driver, return_fare, status, note, vendor, delivery:{…}}]
--  같은 key 는 덮어쓰고, 앱에서 먼저 만든 같은 날 · 같은 구간 요청이 있으면 그 줄에 붙인다(중복 방지). 확인 · 정산 확정된 줄은 손대지 않음
-- =====================================================================
-- 병행 테스트: 앱에 먼저 들어온 값과 시트 값이 다르면 남겨 둔다(시트가 원본이라 대장은 시트 값으로 바뀜)
create table if not exists sync_diffs (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default clock_timestamp(),
  dispatch_id bigint references dispatches(id) on delete cascade,
  sheet_key   text,
  field       text not null,
  app_value   text,
  sheet_value text,
  unique (dispatch_id, field, sheet_value)
);
alter table sync_diffs enable row level security;
drop policy if exists staff_read on sync_diffs;
create policy staff_read on sync_diffs for select to authenticated using (is_staff());

create or replace function sheet_upsert(p_source text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare x jsonb; r dispatches; vid uuid; ins int := 0; upd int := 0; skip int := 0; st text;
begin
  perform set_config('kk.actor', 'sheet:' || p_source, true);
  perform set_config('kk.no_notify', '1', true);
  for x in select * from jsonb_array_elements(p_rows) loop
    select id into vid from vendors where name = x->>'vendor';
    select * into r from dispatches where sheet_key = x->>'key';
    if r.id is null then
      select * into r from dispatches d where d.sheet_key is null and d.status <> 'canceled' and d.type = coalesce(x->>'type','coupang')
         and d.run_date = (x->>'run_date')::date and d.from_place = x->>'from_place' and (d.to_place = x->>'to_place' or d.type = 'delivery')
         and (d.type <> 'delivery' or exists (select 1 from dispatch_delivery dd where dd.dispatch_id = d.id and dd.customer_phone = x->'delivery'->>'customer_phone'))
       order by d.id limit 1;
    end if;
    if r.id is null and position('#' in split_part(x->>'key', ':', 3)) = 0 then   -- b25-a: 겹친 NO.(73#2)로 들어갔던 줄의 NO.를 시트에서 고친 경우 → 그 배차를 이어받음
      select * into r from dispatches d where d.sheet_key like regexp_replace(x->>'key', ':[^:]*$', ':') || '%#%' and d.origin = 'sheet'
         and d.run_date = (x->>'run_date')::date and d.from_place = x->>'from_place' and d.to_place = coalesce(nullif(x->>'to_place',''), d.to_place)
         and not exists (select 1 from jsonb_array_elements(p_rows) y where y->>'key' = d.sheet_key)
       order by d.id limit 1;
    end if;
    if r.id is not null and r.status in ('checked','confirmed') then skip := skip + 1; continue; end if;
    if r.id is not null and r.origin <> 'sheet' then   -- 앱에서 넣은 값 ↔ 시트 값 비교(병행 대조표)
      insert into sync_diffs(dispatch_id, sheet_key, field, app_value, sheet_value)
      select r.id, x->>'key', f.k, f.a, f.b from (values
        ('driver_name', r.driver_name, nullif(x->>'driver_name','')), ('vehicle_no', r.vehicle_no, nullif(x->>'vehicle_no','')),
        ('base_fare', r.base_fare::text, nullif(x->>'base_fare','')), ('extra_fare', nullif(r.extra_fare,0)::text, nullif(nullif(x->>'extra_fare',''),'0')),
        ('plt_qty', trim(trailing '.' from trim(trailing '0' from r.plt_qty::text)), nullif(x->>'plt_qty',''))) f(k, a, b)
      where f.a is not null and f.b is not null and replace(f.a, ' ', '') <> replace(f.b, ' ', '') and not (f.k in ('base_fare','extra_fare','plt_qty') and f.a::numeric = f.b::numeric)
      on conflict do nothing;
    end if;
    st := coalesce(nullif(x->>'status',''), 'requested');
    if r.id is null then
      insert into dispatches(type, status, vendor_id, origin, run_date, time_slot, from_place, to_place, plt_qty, temp, cargo_note, group_no, sheet_key,
                             driver_name, vehicle_no, vehicle_ton, vehicle_body, base_fare, extra_fare, extra_reason, return_date, return_from, return_driver, return_fare, updated_by)
      values (coalesce(x->>'type','coupang'), st, vid, 'sheet', (x->>'run_date')::date, x->>'time_slot', x->>'from_place', coalesce(nullif(x->>'to_place',''),'고객'),
              nullif(x->>'plt_qty','')::numeric, coalesce(nullif(x->>'temp',''),'상온'), x->>'note', x->>'group_no', x->>'key',
              nullif(x->>'driver_name',''), nullif(x->>'vehicle_no',''), nullif(x->>'vehicle_ton','')::numeric, nullif(x->>'vehicle_body',''),
              nullif(x->>'base_fare','')::int, coalesce(nullif(x->>'extra_fare','')::int,0), nullif(x->>'extra_reason',''),
              nullif(x->>'return_date','')::date, nullif(x->>'return_from',''), nullif(x->>'return_driver',''), nullif(x->>'return_fare','')::int, 'sheet:' || p_source)
      returning * into r; ins := ins + 1;
    else
      update dispatches set sheet_key = x->>'key', vendor_id = coalesce(vid, vendor_id), run_date = (x->>'run_date')::date, time_slot = coalesce(nullif(x->>'time_slot',''), time_slot),
        from_place = x->>'from_place', to_place = coalesce(nullif(x->>'to_place',''), to_place), plt_qty = coalesce(nullif(x->>'plt_qty','')::numeric, plt_qty),
        temp = coalesce(nullif(x->>'temp',''), temp), cargo_note = coalesce(nullif(x->>'note',''), cargo_note), group_no = coalesce(nullif(x->>'group_no',''), group_no),
        driver_name = coalesce(nullif(x->>'driver_name',''), driver_name), vehicle_no = coalesce(nullif(x->>'vehicle_no',''), vehicle_no),
        vehicle_ton = coalesce(nullif(x->>'vehicle_ton','')::numeric, vehicle_ton), vehicle_body = coalesce(nullif(x->>'vehicle_body',''), vehicle_body),
        base_fare = coalesce(nullif(x->>'base_fare','')::int, base_fare), extra_fare = coalesce(nullif(x->>'extra_fare','')::int, extra_fare), extra_reason = coalesce(nullif(x->>'extra_reason',''), extra_reason),
        return_date = coalesce(nullif(x->>'return_date','')::date, return_date), return_from = coalesce(nullif(x->>'return_from',''), return_from),
        return_driver = coalesce(nullif(x->>'return_driver',''), return_driver), return_fare = coalesce(nullif(x->>'return_fare','')::int, return_fare),
        status = case when st = 'canceled' then 'canceled' when array_position(array['requested','assigned','done'], st) > array_position(array['requested','assigned','done'], status) then st else status end,
        updated_by = 'sheet:' || p_source
      where id = r.id
        and row(run_date, from_place, to_place, plt_qty, driver_name, vehicle_no, base_fare, extra_fare, return_fare, status, sheet_key)
            is distinct from row((x->>'run_date')::date, x->>'from_place', coalesce(nullif(x->>'to_place',''), to_place), coalesce(nullif(x->>'plt_qty','')::numeric, plt_qty),
                                 coalesce(nullif(x->>'driver_name',''), driver_name), coalesce(nullif(x->>'vehicle_no',''), vehicle_no), coalesce(nullif(x->>'base_fare','')::int, base_fare),
                                 coalesce(nullif(x->>'extra_fare','')::int, extra_fare), coalesce(nullif(x->>'return_fare','')::int, return_fare), status, x->>'key');
      if found then upd := upd + 1; end if;
    end if;
    if x ? 'delivery' then
      insert into dispatch_delivery(dispatch_id, order_date, store, customer_name, customer_phone, address, product, qty, terms, done_note)
      values (r.id, nullif(x->'delivery'->>'order_date','')::date, x->>'from_place', x->'delivery'->>'customer_name', x->'delivery'->>'customer_phone', x->'delivery'->>'address',
              x->'delivery'->>'product', x->'delivery'->>'qty', case when x->'delivery'->>'terms' in ('무료','유료','무료(추가요금)') then x->'delivery'->>'terms' end, x->'delivery'->>'done_note')
      on conflict (dispatch_id) do update set customer_name = excluded.customer_name, customer_phone = excluded.customer_phone, address = excluded.address,
        product = excluded.product, qty = excluded.qty, terms = coalesce(excluded.terms, dispatch_delivery.terms), done_note = excluded.done_note
      where (dispatch_delivery.customer_name, dispatch_delivery.customer_phone, dispatch_delivery.address, dispatch_delivery.product, dispatch_delivery.qty, dispatch_delivery.done_note)
            is distinct from (excluded.customer_name, excluded.customer_phone, excluded.address, excluded.product, excluded.qty, excluded.done_note);
    end if;
  end loop;
  insert into app_config(key, value) values ('sheet_sync:' || p_source, to_char(clock_timestamp() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') || format(' · 새 %s · 바뀜 %s · 확정이라 건너뜀 %s', ins, upd, skip))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('inserted', ins, 'updated', upd, 'skipped', skip);
end $$;
revoke all on function sheet_upsert(text, jsonb) from public, anon, authenticated;
-- 관리자 화면에 '마지막 동기화' 표시용
create or replace function sheet_sync_status() returns jsonb language sql security definer set search_path = public, extensions as $$
  select case when is_staff() then coalesce(jsonb_object_agg(substr(key, 12), value), '{}') else '{}' end from app_config where key like 'sheet_sync:%';
$$;
grant execute on function sheet_sync_status() to authenticated;


-- =====================================================================
--  1차 테스트: 매장이 진천센터 → 우리 매장 출고 배차를 직접 요청(빠른 요청 · 최근 요청 복사)
-- =====================================================================
create or replace function store_request(p_store text, p_pin text, p jsonb)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin); nid bigint; vid uuid;
begin
  if coalesce(nullif(p->>'plt_qty',''),'0')::numeric <= 0 then raise exception 'PLT 수량을 넣어 주세요'; end if;
  if (p->>'run_date')::date < current_date then raise exception '지난 날짜로는 요청할 수 없습니다'; end if;
  select id into vid from vendors where active and 'center' = any(types) order by name limit 1;
  insert into dispatches(type, status, vendor_id, origin, run_date, time_slot, from_place, to_place, plt_qty, temp, cargo_note, requested_by, updated_by)
  values ('center', 'requested', vid, 'store', (p->>'run_date')::date, nullif(p->>'time_slot',''), coalesce(nullif(p->>'from_place',''), '진천센터'), s,
          (p->>'plt_qty')::numeric, coalesce(nullif(p->>'temp',''),'상온'), nullif(p->>'cargo_note',''), coalesce(nullif(p->>'requested_by',''), 'store:' || s), 'store:' || s)
  returning id into nid;
  return nid;
end $$;
grant execute on function store_request(text,text,jsonb) to anon, authenticated;


-- =====================================================================
--  build 11: 통합 대장 삭제(권한자 · 휴지통) + 일별 백업
-- =====================================================================
-- 진짜 지우기(DELETE)는 막고, deleted_at 을 채우는 '휴지통' 방식만 허용
create or replace function dispatches_no_hard_delete() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('kk.allow_hard_delete', true), '') <> '1' then
    raise exception '대장 건은 지울 수 없습니다 — 앱의 삭제(휴지통)를 쓰세요';
  end if;
  return old;
end $$;
drop trigger if exists dispatches_no_hard_delete on dispatches;
create trigger dispatches_no_hard_delete before delete on dispatches for each row execute function dispatches_no_hard_delete();

create or replace function staff_can_delete() returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists(select 1 from staff where lower(email) = lower(coalesce(auth.jwt()->>'email','')) and role = 'admin' and can_delete);
$$;
create or replace function staff_me() returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select jsonb_build_object('email', email, 'name', name, 'role', role, 'can_delete', can_delete) from staff where lower(email) = lower(coalesce(auth.jwt()->>'email',''))), '{}'::jsonb);
$$;

create or replace function dispatch_delete(p_ids bigint[], p_reason text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not staff_can_delete() then raise exception '삭제 권한이 없습니다(설정 › 삭제 권한자)'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception '삭제 사유를 넣어 주세요'; end if;
  if exists(select 1 from dispatches where id = any(p_ids) and status = 'confirmed') then raise exception '정산 확정된 건은 삭제할 수 없습니다'; end if;
  perform set_config('kk.actor', auth.jwt()->>'email', true);
  perform set_config('kk.no_notify', '1', true);
  perform set_config('kk.skip_track', '1', true);
  update dispatches set deleted_at = now(), deleted_by = auth.jwt()->>'email', delete_reason = trim(p_reason), updated_by = auth.jwt()->>'email'
   where id = any(p_ids) and deleted_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function dispatch_restore(p_ids bigint[]) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not staff_can_delete() then raise exception '되살리기 권한이 없습니다'; end if;
  perform set_config('kk.actor', auth.jwt()->>'email', true);
  perform set_config('kk.no_notify', '1', true);
  perform set_config('kk.skip_track', '1', true);
  update dispatches set deleted_at = null, deleted_by = null, delete_reason = null, updated_by = auth.jwt()->>'email' where id = any(p_ids) and deleted_at is not null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function dispatch_delete(bigint[], text), dispatch_restore(bigint[]), staff_me() from public, anon;
grant execute on function dispatch_delete(bigint[], text), dispatch_restore(bigint[]), staff_me(), staff_can_delete() to authenticated;

-- 일별 백업: 하루 한 번 대장 전체(최근 400일 · 휴지통 포함)를 통째로 저장, 90일 보관
create table if not exists ledger_backups (
  day        date primary key,
  made_at    timestamptz not null default now(),
  made_by    text,
  row_count  int not null default 0,
  rows       jsonb not null default '[]'
);
alter table ledger_backups enable row level security;
drop policy if exists staff_read on ledger_backups;
create policy staff_read on ledger_backups for select to authenticated using (is_staff());

create or replace function backup_ledger(p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare d date := (now() at time zone 'Asia/Seoul')::date; r jsonb; n int;
begin
  if coalesce(auth.jwt()->>'email', '') <> '' and not is_staff() then raise exception '권한이 없습니다'; end if;
  if not p_force and exists(select 1 from ledger_backups where day = d) then
    return (select jsonb_build_object('day', day, 'made_at', made_at, 'row_count', row_count, 'new', false) from ledger_backups where day = d);
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'), count(*) into r, n from (
    select dd.*, (select to_jsonb(y) - 'dispatch_id' from dispatch_delivery y where y.dispatch_id = dd.id) as delivery,
           (select coalesce(jsonb_agg(to_jsonb(e) - 'dispatch_id' order by e.at), '[]') from dispatch_events e where e.dispatch_id = dd.id) as events,
           (select coalesce(jsonb_agg(to_jsonb(c) - 'dispatch_id' order by c.at), '[]') from dispatch_comments c where c.dispatch_id = dd.id) as comments
      from dispatches dd where dd.run_date >= d - 400) x;
  insert into ledger_backups(day, made_at, made_by, row_count, rows) values (d, now(), coalesce(auth.jwt()->>'email', 'cron'), n, r)
    on conflict (day) do update set made_at = excluded.made_at, made_by = excluded.made_by, row_count = excluded.row_count, rows = excluded.rows;
  delete from ledger_backups where day < d - 90;
  return jsonb_build_object('day', d, 'made_at', now(), 'row_count', n, 'new', true);
end $$;
revoke all on function backup_ledger(boolean) from public, anon;
grant execute on function backup_ledger(boolean) to authenticated;

-- 매일 00:05(한국시간) 자동 백업 — Supabase 에서 pg_cron 확장을 켠 경우. 안 켜도 관리자가 그날 처음 접속할 때 앱이 백업을 만듭니다
do $$ begin
  if exists(select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'kk-daily-backup';
    perform cron.schedule('kk-daily-backup', '5 15 * * *', 'select public.backup_ledger(false)');
  end if;
end $$;


-- =====================================================================
--  build 12: 발주처(orderer) · 그룹(킹콩본사 / 킹콩백화점 / 진천센터 / 매장 / 더한물류) · 그룹 알림
--   1단계: 킹콩본사 · 진천센터 · 더한물류  /  2단계: 신선센터 · 각 매장
-- =====================================================================
alter table dispatches add column if not exists orderer text;            -- 발주처 그룹: 킹콩본사 · 킹콩백화점 · 진천센터 · 이천점 …
alter table staff      add column if not exists org text not null default '킹콩본사';   -- 관리자 소속(알림 받을 그룹)
alter table stores     add column if not exists kind text not null default 'store';     -- store = 매장, center = 센터(진천센터 · 신선센터)
alter table stores     add column if not exists places text[] not null default '{}';    -- 센터가 맡는 지점 이름(비우면 자기 이름)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stores_kind_chk') then
    alter table stores add constraint stores_kind_chk check (kind in ('store','center'));
  end if;
end $$;

-- 발주처가 비어 들어오면 채움: 관리자 = 소속(org), 매장 · 센터 = 그 이름, 그 밖 = 킹콩본사
create or replace function dispatches_orderer() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.orderer is null or new.orderer = '' then
    new.orderer := coalesce(
      (select org from staff where lower(email) = lower(coalesce(auth.jwt()->>'email',''))),
      case when new.origin = 'store' and new.type = 'delivery' then new.from_place
           when new.origin = 'store' then new.to_place end,
      '킹콩본사');
  end if;
  return new;
end $$;
drop trigger if exists dispatches_orderer on dispatches;
create trigger dispatches_orderer before insert on dispatches for each row execute function dispatches_orderer();
update dispatches set orderer = case when origin = 'store' and type = 'delivery' then from_place when origin = 'store' then to_place else '킹콩본사' end where orderer is null;

-- 센터(링크 + PIN): 우리 센터 출발 · 도착 · 우리가 요청한 건만, 금액은 안 보임
create or replace function center_check(p_name text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare n text;
begin
  select name into n from stores where name = p_name and kind = 'center' and active and pin_hash = crypt(p_pin, pin_hash);
  if n is null then raise exception 'PIN이 맞지 않습니다'; end if;
  perform set_config('kk.actor', 'store:' || p_name, true);
  return n;
end $$;
revoke all on function center_check(text,text) from public;

create or replace function center_places(p_name text) returns text[] language sql stable security definer set search_path = public, extensions as $$
  select array[p_name] || coalesce((select places from stores where name = p_name), '{}');
$$;

create or replace function center_list(p_name text, p_pin text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); pl text[] := center_places(s);
begin
  return query
    select jsonb_build_object('id', d.id, 'status', d.status, 'run_date', d.run_date, 'created_at', d.created_at, 'type', d.type,
             'from_place', d.from_place, 'to_place', d.to_place, 'via_place', d.via_place, 'plt_qty', d.plt_qty, 'time_slot', d.time_slot, 'temp', d.temp,
             'cargo_note', d.cargo_note, 'group_no', d.group_no, 'origin', d.origin, 'orderer', d.orderer, 'requested_by', d.requested_by,
             'driver_name', d.driver_name, 'driver_phone', d.driver_phone, 'vehicle_no', d.vehicle_no, 'vehicle_ton', d.vehicle_ton, 'vehicle_body', d.vehicle_body,
             'vendor', (select name from vendors v where v.id = d.vendor_id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'note', e.note, 'driver_name', e.driver_name) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null and d.type <> 'delivery'
       and (d.from_place = any(pl) or d.to_place = any(pl) or d.orderer = s)
       and d.run_date >= current_date - 60
     order by d.run_date desc, d.id desc;
end $$;

create or replace function center_request(p_name text, p_pin text, p jsonb) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); nid bigint; vid uuid; fr text := coalesce(nullif(p->>'from_place',''), s); tt text := nullif(p->>'to_place','');
begin
  if tt is null then raise exception '도착지를 넣어 주세요'; end if;
  if coalesce(nullif(p->>'plt_qty',''),'0')::numeric <= 0 then raise exception 'PLT 수량을 넣어 주세요'; end if;
  if (p->>'run_date')::date < current_date then raise exception '지난 날짜로는 요청할 수 없습니다'; end if;
  select id into vid from vendors where active and 'center' = any(types) order by name limit 1;
  insert into dispatches(type, status, vendor_id, origin, orderer, run_date, time_slot, from_place, to_place, plt_qty, temp, cargo_note, requested_by, updated_by)
  values ('center', 'requested', vid, 'store', s, (p->>'run_date')::date, nullif(p->>'time_slot',''), fr, tt,
          (p->>'plt_qty')::numeric, coalesce(nullif(p->>'temp',''),'상온'), nullif(p->>'cargo_note',''), coalesce(nullif(p->>'requested_by',''), s), 'store:' || s)
  returning id into nid;
  return nid;
end $$;

create or replace function center_cancel(p_name text, p_pin text, p_id bigint) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin);
begin
  update dispatches set status = 'canceled', updated_by = 'store:' || s where id = p_id and status = 'requested' and orderer = s and deleted_at is null;
  if not found then raise exception '배차가 이미 잡힌 건은 더한물류 · 본사에 연락해 주세요'; end if;
end $$;
grant execute on function center_list(text,text), center_request(text,text,jsonb), center_cancel(text,text,bigint) to anon, authenticated;

-- 알림 받을 곳: 발주처 그룹(관리자 = 그 소속 이메일들, 매장 · 센터 = 그 링크로 알림 켠 기기)
create or replace function orderer_targets(p_orderer text) returns text[] language sql stable security definer set search_path = public, extensions as $$
  select case
    when p_orderer is null or p_orderer = '' then array['staff']
    when exists(select 1 from stores where name = p_orderer) then array['store:' || p_orderer]
    else coalesce(nullif((select array_agg(email) from staff where org = p_orderer), '{}'), array['staff']) end;
$$;

-- 알림 흐름(build 12)
--  · 배차 요청(본사 · 센터 · 매장)          → 더한물류 (+ 센터 · 매장 요청은 본사에도)
--  · 차량 등록(배차 · 재배차)               → 발주처 그룹(킹콩본사 / 킹콩백화점 / 진천센터 / 매장)
--  · 취소 · 회차 · 기사 취소               → 더한물류 / 발주처
create or replace function notify_on_event() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare d dispatches; vn text; route text; tag text; who text := coalesce(to_jsonb(new) ->> 'by', ''); tg text[];
begin
  select * into d from dispatches where id = new.dispatch_id;
  select 'vendor:' || name into vn from vendors where id = d.vendor_id;
  tg := orderer_targets(d.orderer);
  route := format('%s %s→%s%s%s', to_char(d.run_date, 'MM/DD'), d.from_place, case when d.type = 'delivery' then '고객' else d.to_place end,
                  case when d.plt_qty is not null then ' ' || d.plt_qty || 'plt' else '' end, case when coalesce(d.time_slot,'') <> '' then ' ' || d.time_slot else '' end);
  tag := '#' || d.id || ' ';
  if new.kind = 'request' then
    perform kk_notify(array[coalesce(vn, 'vendor:*')] || case when d.origin = 'store' then array['staff'] else '{}'::text[] end,
                      '새 배차 요청 · ' || coalesce(d.orderer, '킹콩'), tag || route, '?v=');
  elsif new.kind = 'cancel' then
    perform kk_notify(array[coalesce(vn, 'vendor:*')] || case when who like 'store:%' then array['staff'] else '{}'::text[] end, '배차 취소', tag || route, '?v=');
  elsif new.kind = 'change' and who not like 'vendor:%' then
    perform kk_notify(array[coalesce(vn, 'vendor:*')], '배차 변경', tag || route || ' · ' || coalesce(new.note, ''), '?v=');
  elsif new.kind in ('cancel_driver', 'return') then
    perform kk_notify(array['staff'] || tg, case when new.kind = 'return' then '회차' else '기사 취소 · 재배차' end, tag || route || ' · ' || coalesce(new.reason, ''), '');
  elsif new.kind in ('assign', 'reassign') then
    perform kk_notify(tg, case when new.kind = 'reassign' then '재배차 · 차량 변경' else '차량 등록(배차 완료)' end,
                      tag || route || ' · ' || coalesce(new.driver_name, d.driver_name, '') || ' ' || coalesce(d.vehicle_no, ''),
                      case when tg[1] like 'store:%' then (case when exists(select 1 from stores where name = d.orderer and kind = 'center') then '?g=' else '?s=' end) else '' end);
  end if;
  return new;
end $$;

-- 휴대폰 알림 등록에 센터도
create or replace function push_subscribe(p_kind text, p_name text, p_pin text, p_sub jsonb, p_ua text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare who text;
begin
  if p_kind = 'vendor' then perform vendor_check(p_name, p_pin); who := 'vendor:' || p_name;
  elsif p_kind = 'store' then perform store_check(p_name, p_pin); who := 'store:' || p_name;
  elsif p_kind = 'center' then perform center_check(p_name, p_pin); who := 'store:' || p_name;
  elsif p_kind = 'checker' then perform checker_check(p_name, p_pin); who := 'checker:' || p_name;
  elsif p_kind = 'staff' and is_staff() then who := auth.jwt() ->> 'email';
  else raise exception '권한이 없습니다'; end if;
  insert into push_subs(who, endpoint, sub, ua) values (who, p_sub ->> 'endpoint', p_sub, p_ua)
  on conflict (endpoint) do update set who = excluded.who, sub = excluded.sub, ua = excluded.ua, created_at = now();
end $$;
create or replace function feedback_add(p_kind text, p_name text, p_pin text, p_page text, p_body text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare who text;
begin
  if p_kind = 'vendor' then perform vendor_check(p_name, p_pin); who := 'vendor:' || p_name;
  elsif p_kind = 'store' then perform store_check(p_name, p_pin); who := 'store:' || p_name;
  elsif p_kind = 'center' then perform center_check(p_name, p_pin); who := 'store:' || p_name;
  elsif p_kind = 'checker' then perform checker_check(p_name, p_pin); who := 'checker:' || p_name;
  elsif is_staff() then who := auth.jwt() ->> 'email';
  else raise exception '권한이 없습니다'; end if;
  insert into feedback(who, page, body) values (who, p_page, left(p_body, 2000));
end $$;

-- 매장 화면 함수는 kind = 'store' 만(센터 PIN 으로 매장 화면에 못 들어가게)
create or replace function store_check(p_store text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare n text;
begin
  select name into n from stores where name = p_store and kind = 'store' and active and pin_hash = crypt(p_pin, pin_hash);
  if n is null then raise exception 'PIN이 맞지 않습니다'; end if;
  perform set_config('kk.actor', 'store:' || p_store, true);
  return n;
end $$;
-- staff_me 에 소속 포함
create or replace function staff_me() returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select jsonb_build_object('email', email, 'name', name, 'role', role, 'can_delete', can_delete, 'org', org) from staff where lower(email) = lower(coalesce(auth.jwt()->>'email',''))), '{}'::jsonb);
$$;
-- 예) 진천센터 링크 만들기:  insert into stores(name, kind, pin_hash) values ('진천센터', 'center', crypt('PIN4자리', gen_salt('bf')));
--     관리자 소속 정하기:    update staff set org = '킹콩백화점' where email = '...';

-- =====================================================================
--  권한(Data API): 새 프로젝트에서 'Automatically expose new tables' 를 끈 경우에도 동작하도록 직접 부여
--  · 로그인한 관리자(authenticated)만 표에 접근 — 실제로 볼 수 있는 줄은 위의 RLS(is_staff) 가 막음
--  · anon(업체 · 센터 · 매장 링크)은 표에 직접 접근 못 하고, PIN 확인 함수(RPC)로만
-- =====================================================================
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke select, insert, update, delete on all tables in schema public from anon;

-- =====================================================================
--  build 14: 본사도 링크(?h=이름) + PIN — 메일 인증 없이
--   사람 추가 · PIN 바꾸기(SQL Editor 에서 한 줄):
--     select kk_add_hq('이동주', '123456', '킹콩본사', true);     -- 마지막 true = 삭제 권한
--     select kk_add_hq('홍길동', '654321', '킹콩백화점');
--   보낼 링크: https://ldj0120-boop.github.io/kingkong-dispatch/?h=이동주   (PIN 은 따로)
--   내부적으로 그 사람의 로그인 계정을 만들고(비밀번호 = 'kk#' || PIN, 이메일 확인 생략), staff 명단에 넣음
-- =====================================================================
create or replace function hq_login_id(p_name text) returns text
language plpgsql stable security definer set search_path = public, extensions as $$
declare e text;
begin
  select email into e from staff where name = trim(p_name) order by email limit 1;
  if e is null then raise exception '등록되지 않은 이름입니다'; end if;
  return e;
end $$;
grant execute on function hq_login_id(text) to anon, authenticated;

create or replace function kk_add_hq(p_name text, p_pin text, p_org text default '킹콩본사', p_can_delete boolean default false) returns text
language plpgsql security definer set search_path = public, extensions, auth as $$
declare e text; uid uuid; pw text := 'kk#' || trim(p_pin);
begin
  if coalesce(trim(p_name), '') = '' then raise exception '이름을 넣어 주세요'; end if;
  if length(trim(coalesce(p_pin, ''))) < 4 then raise exception 'PIN 은 4자리 이상'; end if;
  select email into e from staff where name = trim(p_name) order by email limit 1;
  e := coalesce(e, 'hq-' || substr(md5(trim(p_name)), 1, 12) || '@kingkong.local');
  select id into uid from auth.users where lower(email) = lower(e);
  if uid is null then
    uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, email_change, email_change_token_new, recovery_token)
    values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', lower(e), crypt(pw, gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}', jsonb_build_object('name', trim(p_name)), now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', lower(e), 'email_verified', true), 'email', uid::text, now(), now(), now());
  else
    update auth.users set encrypted_password = crypt(pw, gen_salt('bf')), email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = uid;
  end if;
  insert into staff(email, name, org, can_delete) values (lower(e), trim(p_name), coalesce(nullif(p_org, ''), '킹콩본사'), coalesce(p_can_delete, false))
    on conflict (email) do update set name = excluded.name, org = excluded.org, can_delete = excluded.can_delete;
  return '링크: https://ldj0120-boop.github.io/kingkong-dispatch/?h=' || trim(p_name) || '  (PIN 은 따로 알려 주세요)';
end $$;
revoke all on function kk_add_hq(text, text, text, boolean) from public, anon, authenticated;

-- =====================================================================
--  build 18: 구글시트 자동 가져오기 — Apps Script 가 직접 호출(Edge Function · 비밀키 설정 없이)
--   토큰은 DB 안에서 만들어짐: select value from app_config where key = 'sheet_token';  ← 이 값을 Apps Script 의 TOKEN 에
-- =====================================================================
insert into app_config(key, value) values ('sheet_token', encode(gen_random_bytes(24), 'hex')) on conflict (key) do nothing;
create or replace function sheet_push(p_token text, p_source text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_token is null or p_token <> (select value from app_config where key = 'sheet_token') then raise exception 'token'; end if;
  if p_source not in ('쿠팡배차내역', '배차내역_경산2', '고객배송내역') then raise exception 'source'; end if;
  return sheet_upsert(p_source, p_rows);
end $$;
revoke all on function sheet_push(text, text, jsonb) from public;
grant execute on function sheet_push(text, text, jsonb) to anon;

-- ===== build 18-a: 시트 토큰 '연결(페어링)' — 사람이 토큰을 복사·붙여넣기 하지 않음 =====
-- Apps Script '연결하기' 가 새 토큰을 만들어 sheet_pair 로 '대기' 등록 → 관리자가 SQL 편집기에서 15분 안에 sheet_pair_approve() 로 승인
create or replace function sheet_pair(p_token text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if p_token is null or length(p_token) < 48 or p_token !~ '^[0-9a-f]+$' then raise exception 'token format'; end if;
  insert into app_config(key, value) values ('sheet_token_pending', p_token || '|' || extract(epoch from now())::bigint)
  on conflict (key) do update set value = excluded.value;
  return 'pending';
end $$;
revoke all on function sheet_pair(text) from public;
grant execute on function sheet_pair(text) to anon;

create or replace function sheet_pair_approve() returns text
language plpgsql security definer set search_path = public as $$
declare p text;
begin
  select value into p from app_config where key = 'sheet_token_pending';
  if p is null then return '대기 중인 연결 없음 — Apps Script 에서 연결하기 를 먼저 실행'; end if;
  if now() - to_timestamp(split_part(p, '|', 2)::bigint) > interval '15 minutes' then
    delete from app_config where key = 'sheet_token_pending'; return '15분이 지나 만료 — 연결하기 를 다시 실행';
  end if;
  update app_config set value = split_part(p, '|', 1) where key = 'sheet_token';
  delete from app_config where key = 'sheet_token_pending';
  return '연결 승인 완료';
end $$;
revoke all on function sheet_pair_approve() from public, anon, authenticated;   -- SQL 편집기(관리자)에서만

-- =====================================================================
--  build 18: 3개 배차 채널 통합 · 중계 · 정산 편의
--   · 노선 템플릿(즐겨찾기: 출발지 · 목적지 · 차종) — 기본 18개는 카톡방 히스토리에서 많이 쓴 구간
--   · 표준운임 대비 변동 사유(정산 확정 전에 기록)
--   [충돌 알림 및 개선 제안] 상태값(requested · assigned · done · checked · confirmed · canceled)은 바꾸지 않음
-- =====================================================================
alter table dispatches add column if not exists variance_reason text;      -- 표준운임 대비 변동 사유
alter table dispatches add column if not exists variance_by text;
alter table dispatches add column if not exists variance_at timestamptz;

create table if not exists route_templates (
  id           bigint generated always as identity primary key,
  type         text not null check (type in ('coupang','center','delivery')),
  from_place   text not null,
  to_place     text not null,
  vehicle_ton  numeric,
  vehicle_body text not null default '',
  plt_qty      numeric,
  temp         text not null default '상온' check (temp in ('상온','냉장','냉동')),
  label        text,
  pinned       boolean not null default false,
  active       boolean not null default true,
  uses         integer not null default 0,
  created_by   text,
  created_at   timestamptz not null default now()
);
alter table route_templates enable row level security;
drop policy if exists staff_all on route_templates;
create policy staff_all on route_templates for all to authenticated using (is_staff()) with check (is_staff());
grant select, insert, update, delete on route_templates to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke all on route_templates from anon;

create or replace function route_template_used(p_id bigint) returns void
language sql security definer set search_path = public as $$
  update route_templates set uses = uses + 1 where id = p_id and is_staff();
$$;
revoke all on function route_template_used(bigint) from public, anon;
grant execute on function route_template_used(bigint) to authenticated;

insert into route_templates (type, from_place, to_place, vehicle_ton, vehicle_body, plt_qty, temp, uses)
select * from (values
  ('coupang','여주2','이천센터',14,'플축윙',18,'상온',0),
  ('coupang','고양3','이천센터',11,'플축윙',9,'상온',0),
  ('coupang','시흥3','이천센터',14,'플축윙',9,'상온',0),
  ('coupang','금왕3','충주점',14,'플축윙',null,'상온',0),
  ('coupang','여주2','방도리창고',18,'플축윙',9,'상온',0),
  ('coupang','경산2','이천센터',11,'플축윙',18,'상온',0),
  ('coupang','청주1','방도리창고',14,'플축윙',null,'상온',0),
  ('coupang','고양3','김포점',1,'카고',null,'상온',0),
  ('coupang','경산2','김해점',1,'카고',null,'상온',0),
  ('coupang','시흥3','인천점',1,'카고',null,'상온',0),
  ('coupang','인천43','이천센터',11,'플축윙',null,'상온',0),
  ('coupang','금왕3','이천센터',14,'플축윙',null,'상온',0),
  ('center','이천센터','인천점',5,'윙',null,'상온',0),
  ('center','이천센터','시그니처용인점',18,'플축윙',null,'상온',0),
  ('center','시그니처용인점','평택점',1,'냉동탑',1,'냉동',0),
  ('center','시그니처용인점','기흥점',1,'냉동탑',2,'냉동',0),
  ('center','송파센터','남양주점',1,'냉동탑',null,'냉동',0),
  ('center','인천37','수원점',2.5,'냉동탑',null,'냉동',0)
) v(type, from_place, to_place, vehicle_ton, vehicle_body, plt_qty, temp, uses)
where not exists (select 1 from route_templates);

-- =====================================================================
--  build 20: 통합 대장을 더한물류 · 진천센터도 함께 봄(매장 · 고객 직배송은 제외)
--   · 더한물류: 자기 배차(+ 아직 업체 없는 요청) · 운임 포함
--   · 진천센터: 쿠팡 · 킹콩 내부물류 전체 · 운임 포함(build 21 사용자 요청)
--   · 한 번에 최대 400일
-- =====================================================================
create or replace function vendor_ledger(p_vendor text, p_pin text, p_from date, p_to date)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin);
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception '기간은 400일 안으로 골라 주세요'; end if;
  return query
    select to_jsonb(d) - 'memo' - 'variance_reason' - 'variance_by' - 'variance_at' || jsonb_build_object(
             'vendor', (select name from vendors x where x.id = d.vendor_id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'driver_name', e.driver_name) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null and d.type <> 'delivery'
       and d.run_date between p_from and p_to
       and (d.vendor_id = v or d.vendor_id is null)
     order by d.run_date desc, d.id desc;
end $$;

create or replace function center_ledger(p_name text, p_pin text, p_from date, p_to date)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin);
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception '기간은 400일 안으로 골라 주세요'; end if;
  return query
    select to_jsonb(d) - 'memo' - 'variance_reason' - 'variance_by' - 'variance_at' - 'updated_by' - 'deleted_by' - 'delete_reason' || jsonb_build_object(   -- build 21: 운임 포함
             'vendor', (select name from vendors x where x.id = d.vendor_id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'driver_name', e.driver_name) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null and d.type <> 'delivery'
       and d.run_date between p_from and p_to
     order by d.run_date desc, d.id desc;
end $$;

revoke all on function vendor_ledger(text, text, date, date), center_ledger(text, text, date, date) from public;
grant execute on function vendor_ledger(text, text, date, date), center_ledger(text, text, date, date) to anon, authenticated;

-- ===================================================================
-- b25 — 개선 요청(더한물류 · 진천센터 · 매장 → 본사 접수 · 답변 → 요청 글에 답글 자동)
-- ===================================================================
alter table feedback add column if not exists kind      text;                      -- vendor · center · store · checker · staff
alter table feedback add column if not exists src_name  text;                      -- 더한물류 · 진천센터 · 이천점 …
alter table feedback add column if not exists category  text default '기타';        -- 기능 추가 · 불편/개선 · 오류 · 기타
alter table feedback add column if not exists status    text default '접수';        -- 접수 · 검토 중 · 반영 예정 · 완료 · 보류
alter table feedback add column if not exists replies   jsonb not null default '[]'; -- [{at, by, from:'staff'|'user', body}]
alter table feedback add column if not exists replied_at timestamptz;              -- 본사 마지막 답변
alter table feedback add column if not exists user_at    timestamptz;              -- 요청자 마지막 글(처음 글 포함)
alter table feedback add column if not exists seen_at    timestamptz;              -- 요청자가 답변을 읽은 때

create or replace function fb_who(p_kind text, p_name text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_kind = 'vendor' then perform vendor_check(p_name, p_pin); return 'vendor:' || p_name;
  elsif p_kind = 'center' then perform center_check(p_name, p_pin); return 'center:' || p_name;
  elsif p_kind = 'store' then perform store_check(p_name, p_pin); return 'store:' || p_name;
  elsif p_kind = 'checker' then perform checker_check(p_name, p_pin); return 'checker:' || p_name;
  elsif is_staff() then return auth.jwt() ->> 'email';
  end if;
  raise exception '권한이 없습니다';
end $$;
revoke all on function fb_who(text,text,text) from public, anon, authenticated;

-- 알림 받는 이름(센터 휴대폰 알림은 'store:센터이름'으로 등록됨)
create or replace function fb_to(p_who text) returns text language sql immutable as $$
  select case when p_who like 'center:%' then 'store:' || substr(p_who, 8) else p_who end $$;

create or replace function feedback_post(p_kind text, p_name text, p_pin text, p_cat text, p_page text, p_body text)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare w text := fb_who(p_kind, p_name, p_pin); nid bigint; k text := split_part(w, ':', 1);
begin
  if coalesce(trim(p_body), '') = '' then raise exception '내용을 적어 주세요'; end if;
  insert into feedback(who, page, body, kind, src_name, category, user_at)
  values (w, left(p_page, 300), left(p_body, 2000), case when w like '%:%' then k else 'staff' end,
          case when w like '%:%' then split_part(w, ':', 2) else w end, coalesce(nullif(p_cat, ''), '기타'), now())
  returning id into nid;
  if w like '%:%' then perform kk_notify(array['staff'], '개선 요청 접수 · ' || split_part(w, ':', 2), left(p_body, 80), '#fb'); end if;
  return nid;
end $$;

-- 예전 '의견 남기기'도 같은 곳으로(센터 포함)
create or replace function feedback_add(p_kind text, p_name text, p_pin text, p_page text, p_body text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin perform feedback_post(p_kind, p_name, p_pin, '기타', p_page, p_body); end $$;

create or replace function feedback_mine(p_kind text, p_name text, p_pin text)
returns setof feedback language plpgsql security definer set search_path = public, extensions as $$
declare w text := fb_who(p_kind, p_name, p_pin);
begin return query select * from feedback where who = w order by coalesce(replied_at, at) desc limit 200; end $$;

-- 요청자: 이어 쓰기(추가 설명 · 다시 문의)
create or replace function feedback_user_reply(p_kind text, p_name text, p_pin text, p_id bigint, p_body text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare w text := fb_who(p_kind, p_name, p_pin); f feedback;
begin
  select * into f from feedback where id = p_id and who = w; if not found then raise exception '내 요청이 아닙니다'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception '내용을 적어 주세요'; end if;
  update feedback set replies = replies || jsonb_build_array(jsonb_build_object('at', now(), 'by', split_part(w, ':', 2), 'from', 'user', 'body', left(p_body, 2000))),
         user_at = now(), done_at = null, status = case when status in ('완료','보류') then '접수' else status end where id = p_id;
  perform kk_notify(array['staff'], '개선 요청 추가 글 · ' || split_part(w, ':', 2), '#' || p_id || ' ' || left(p_body, 70), '#fb');
end $$;

-- 요청자: 답변 읽음
create or replace function feedback_seen(p_kind text, p_name text, p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare w text := fb_who(p_kind, p_name, p_pin);
begin update feedback set seen_at = now() where who = w and replied_at is not null and (seen_at is null or seen_at < replied_at); end $$;

-- 본사: 답변(요청 글 아래에 답글로 붙고, 요청자에게 알림) · 상태 바꾸기
create or replace function feedback_answer(p_id bigint, p_body text, p_status text default null)
returns feedback language plpgsql security definer set search_path = public, extensions as $$
declare f feedback; me text := auth.jwt() ->> 'email';
begin
  if not is_staff() then raise exception '권한이 없습니다'; end if;
  if p_status is not null and p_status not in ('접수','검토 중','반영 예정','완료','보류') then raise exception '상태 값이 올바르지 않습니다'; end if;
  if coalesce(trim(p_body), '') <> '' then
    update feedback set replies = replies || jsonb_build_array(jsonb_build_object('at', now(), 'by', '킹콩 본사', 'staff', me, 'from', 'staff', 'body', left(p_body, 2000))),
           replied_at = now(), status = coalesce(p_status, case when status = '접수' then '검토 중' else status end),
           done_at = case when coalesce(p_status, status) in ('완료','보류') then now() else null end
     where id = p_id returning * into f;
  else
    update feedback set status = coalesce(p_status, status), done_at = case when coalesce(p_status, status) in ('완료','보류') then now() else null end
     where id = p_id returning * into f;
  end if;
  if f.id is null then raise exception '요청을 찾을 수 없습니다'; end if;
  if f.who like '%:%' and coalesce(trim(p_body), '') <> '' then
    perform kk_notify(array[fb_to(f.who)], '개선 요청에 본사 답변', '#' || f.id || ' ' || left(p_body, 80), '');
  end if;
  return f;
end $$;
grant execute on function feedback_post(text,text,text,text,text,text), feedback_add(text,text,text,text,text), feedback_mine(text,text,text),
  feedback_user_reply(text,text,text,bigint,text), feedback_seen(text,text,text), feedback_answer(bigint,text,text) to anon, authenticated;

-- ===================================================================
-- b27 — 업체(더한물류)도 '입력 대기'(배차 요청 · 기사 없음) 건 삭제 — 본사가 허용한 업체만, 사유 필수, 휴지통 + 수정 기록
-- ===================================================================
alter table vendors add column if not exists can_delete boolean not null default false;

create or replace function vendor_perm(p_vendor text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin);
begin return jsonb_build_object('can_delete', coalesce((select can_delete from vendors where id = v), false)); end $$;

create or replace function vendor_delete(p_vendor text, p_pin text, p_ids bigint[], p_reason text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin); n int; bad int;
begin
  if not coalesce((select can_delete from vendors where id = v), false) then raise exception '삭제 권한이 없습니다 — 킹콩 본사에 요청해 주세요(설정 › 휴지통 · 삭제 권한)'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception '삭제 사유를 넣어 주세요'; end if;
  select count(*) into bad from dispatches where id = any(p_ids) and deleted_at is null
     and (status <> 'requested' or coalesce(driver_name, '') <> '' or (vendor_id is not null and vendor_id <> v));
  if bad > 0 then raise exception '입력 대기(기사 · 차량 없는 배차 요청) 건만 지울 수 있습니다'; end if;
  perform set_config('kk.actor', 'vendor:' || p_vendor, true);
  perform set_config('kk.no_notify', '1', true);
  perform set_config('kk.skip_track', '1', true);
  update dispatches set deleted_at = now(), deleted_by = 'vendor:' || p_vendor, delete_reason = trim(p_reason), updated_by = 'vendor:' || p_vendor
   where id = any(p_ids) and deleted_at is null;
  get diagnostics n = row_count;
  perform set_config('kk.no_notify', '', true);
  if n > 0 then perform kk_notify(array['staff'], '입력 대기 건 삭제 · ' || p_vendor, n || '건 · ' || left(trim(p_reason), 60), '#setup'); end if;
  return n;
end $$;
revoke all on function vendor_perm(text,text), vendor_delete(text,text,bigint[],text) from public;
grant execute on function vendor_perm(text,text), vendor_delete(text,text,bigint[],text) to anon, authenticated;

-- ===================================================================
-- b28 — 직출 알림: 구글시트 「낙찰건 로케이션」(2026 탭) → 5분마다 동기화 → 매장별 입고 안내
--   · 새 줄이 들어오면 그 도착지(매장 · 진천센터)에 바로 알림
--   · 센터 · 본사가 매장별로 묶인 글을 복사(카톡) 하거나 '매장 앱으로 전달' → 매장 화면 '센터 알림'에 남음
-- ===================================================================
create table if not exists direct_ship (
  key        text primary key,                 -- 2026:NO
  bid_date   date, no int, group_no text, bid_no text, part text,
  fc         text, dest text, dest_store text,  -- dest_store: '김해점(이관용)' → 김해점
  plt        text, cate text, direct boolean default false,
  in_date    date, slot text, note text,
  updated_at timestamptz default now(), created_at timestamptz default now()
);
create index if not exists direct_ship_in on direct_ship(in_date, dest_store);
alter table direct_ship enable row level security;
drop policy if exists staff_all on direct_ship;
create policy staff_all on direct_ship for all to authenticated using (is_staff()) with check (is_staff());

create table if not exists store_msgs (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  store     text not null,          -- 받는 곳(매장 · 진천센터)
  in_date   date,
  kind      text default 'direct',  -- direct(직출 안내) · note
  title     text, body text not null,
  sent_by   text, read_at timestamptz
);
create index if not exists store_msgs_store on store_msgs(store, at desc);
alter table store_msgs enable row level security;
drop policy if exists staff_all on store_msgs;
create policy staff_all on store_msgs for all to authenticated using (is_staff()) with check (is_staff());

create or replace function direct_store(p text) returns text language sql immutable as $$
  select nullif(trim(regexp_replace(regexp_replace(coalesce(p, ''), '\(.*?\)|-.*$', '', 'g'), '\s+', '', 'g')), '') $$;

-- 구글시트 → (Apps Script 5분마다) — 토큰은 쿠팡 시트와 같은 sheet_token
create or replace function direct_push(p_token text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare x jsonb; ins int := 0; upd int := 0; k text; ds text; prev direct_ship; fresh jsonb := '{}'::jsonb; s text;
begin
  if p_token is null or p_token <> (select value from app_config where key = 'sheet_token') then raise exception 'token'; end if;
  for x in select * from jsonb_array_elements(p_rows) loop
    k := x->>'key'; ds := direct_store(x->>'dest');
    select * into prev from direct_ship where key = k;
    insert into direct_ship(key, bid_date, no, group_no, bid_no, part, fc, dest, dest_store, plt, cate, direct, in_date, slot, note, updated_at)
    values (k, nullif(x->>'bid_date','')::date, nullif(x->>'no','')::int, x->>'group_no', x->>'bid_no', x->>'part', x->>'fc', x->>'dest', ds, x->>'plt', x->>'cate',
            coalesce((x->>'direct')::boolean, false), nullif(x->>'in_date','')::date, x->>'slot', x->>'note', now())
    on conflict (key) do update set bid_date = excluded.bid_date, no = excluded.no, group_no = excluded.group_no, bid_no = excluded.bid_no, part = excluded.part, fc = excluded.fc,
      dest = excluded.dest, dest_store = excluded.dest_store, plt = excluded.plt, cate = excluded.cate, direct = excluded.direct, in_date = excluded.in_date, slot = excluded.slot, note = excluded.note, updated_at = now()
    where (direct_ship.fc, direct_ship.dest, direct_ship.plt, direct_ship.cate, direct_ship.direct, direct_ship.in_date, direct_ship.slot, direct_ship.bid_no, direct_ship.group_no)
          is distinct from (excluded.fc, excluded.dest, excluded.plt, excluded.cate, excluded.direct, excluded.in_date, excluded.slot, excluded.bid_no, excluded.group_no);
    if found then
      if prev.key is null then ins := ins + 1; else upd := upd + 1; end if;
      -- 오늘 이후 입고 · 도착지가 새로 정해졌거나 바뀐 줄 → 그 매장에 알림(매장별로 모아서 한 번)
      if ds is not null and nullif(x->>'in_date','')::date >= (now() at time zone 'Asia/Seoul')::date
         and (prev.key is null or prev.dest_store is distinct from ds or prev.in_date is distinct from nullif(x->>'in_date','')::date) then
        fresh := jsonb_set(fresh, array[ds], to_jsonb(coalesce((fresh->>ds)::int, 0) + 1));
      end if;
    end if;
  end loop;
  for s in select jsonb_object_keys(fresh) loop
    perform kk_notify(array['store:' || s], '직출 입고 안내 · ' || s, '새 입고 ' || (fresh->>s) || '건 — 센터 알림에서 확인', '?s=');
  end loop;
  insert into app_config(key, value) values ('sheet_sync:낙찰건로케이션', to_char(clock_timestamp() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') || format(' · 새 %s · 바뀜 %s', ins, upd))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('inserted', ins, 'updated', upd, 'notified', fresh);
end $$;
revoke all on function direct_push(text, jsonb) from public;
grant execute on function direct_push(text, jsonb) to anon;

-- 센터(진천센터 PIN) · 본사가 보는 목록
create or replace function direct_list(p_kind text, p_name text, p_pin text, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_kind = 'center' then perform center_check(p_name, p_pin); elsif not is_staff() then raise exception '권한이 없습니다'; end if;
  if p_to - p_from > 62 then raise exception '기간은 두 달까지'; end if;
  return jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(d) order by d.in_date, d.dest_store, d.slot, d.no) from direct_ship d where d.in_date between p_from and p_to), '[]'),
    'sent', coalesce((select jsonb_agg(jsonb_build_object('store', m.store, 'in_date', m.in_date, 'at', m.at, 'by', m.sent_by, 'read_at', m.read_at) order by m.at) from store_msgs m where m.kind = 'direct' and m.in_date between p_from and p_to), '[]'));
end $$;

-- '매장 앱으로 전달' — 매장 화면 '센터 알림'에 남고 휴대폰 알림
create or replace function direct_send(p_kind text, p_name text, p_pin text, p_store text, p_in_date date, p_title text, p_body text) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare who text; nid bigint;
begin
  if p_kind = 'center' then perform center_check(p_name, p_pin); who := 'center:' || p_name;
  elsif is_staff() then who := auth.jwt() ->> 'email'; else raise exception '권한이 없습니다'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception '보낼 내용이 없습니다'; end if;
  insert into store_msgs(store, in_date, kind, title, body, sent_by) values (p_store, p_in_date, 'direct', left(p_title, 200), left(p_body, 6000), who) returning id into nid;
  perform kk_notify(array['store:' || p_store], coalesce(p_title, '센터 알림'), left(p_body, 120), '?s=');
  return nid;
end $$;

-- 매장(매장 PIN · 진천센터 PIN)이 받은 알림 · 읽음
create or replace function store_msgs_mine(p_kind text, p_name text, p_pin text) returns setof store_msgs
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_kind = 'center' then perform center_check(p_name, p_pin); else perform store_check(p_name, p_pin); end if;
  return query select * from store_msgs where store = p_name and at >= now() - interval '30 days' order by at desc limit 100;
end $$;
create or replace function store_msgs_read(p_kind text, p_name text, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_kind = 'center' then perform center_check(p_name, p_pin); else perform store_check(p_name, p_pin); end if;
  update store_msgs set read_at = now() where store = p_name and read_at is null;
end $$;
grant execute on function direct_list(text,text,text,date,date), direct_send(text,text,text,text,date,text,text), store_msgs_mine(text,text,text), store_msgs_read(text,text,text) to anon, authenticated;

-- ===================================================================
-- b31 — 진천센터가 매장 계정(이름 · PIN) 만들기 · PIN 바꾸기 · 앱 열기/닫기 (수정 기록 audit_row 에 '누가' 남음, PIN 은 기록 안 함)
-- ===================================================================
alter table stores add column if not exists app_open boolean not null default false;   -- 1단계 중 매장 화면 시범 오픈
alter table stores add column if not exists created_by text;
alter table stores add column if not exists updated_at timestamptz default now();

create or replace function store_is_open(p_store text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select app_open and active from stores where name = p_store and kind = 'store'), false) $$;

create or replace function center_store_list(p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform center_check(p_name, p_pin);
  return coalesce((select jsonb_agg(jsonb_build_object('name', name, 'active', active, 'app_open', app_open, 'created_by', created_by, 'updated_at', updated_at) order by name)
                     from stores where kind = 'store'), '[]');
end $$;

-- p_new_pin 이 비면 PIN 은 그대로(열기/닫기 · 사용 중지만)
create or replace function center_store_save(p_name text, p_pin text, p_store text, p_new_pin text, p_open boolean, p_active boolean default true) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s text := trim(coalesce(p_store, '')); ex stores;
begin
  perform center_check(p_name, p_pin);
  perform set_config('kk.actor', 'center:' || p_name, true);
  if s !~ '^[가-힣A-Za-z0-9()\-]{2,20}$' then raise exception '매장 이름은 2~20자(한글 · 영문 · 숫자)로 넣어 주세요'; end if;
  if p_new_pin is not null and p_new_pin <> '' and p_new_pin !~ '^\d{4,8}$' then raise exception 'PIN은 숫자 4~8자리로 넣어 주세요'; end if;
  select * into ex from stores where name = s;
  if ex.id is not null and ex.kind <> 'store' then raise exception '센터 계정은 여기서 바꿀 수 없습니다'; end if;
  if ex.id is null then
    if coalesce(p_new_pin, '') = '' then raise exception '새 매장은 PIN이 필요합니다'; end if;
    insert into stores(name, kind, pin_hash, active, app_open, created_by, updated_at) values (s, 'store', crypt(p_new_pin, gen_salt('bf')), true, coalesce(p_open, true), 'center:' || p_name, now());
  else
    update stores set pin_hash = case when coalesce(p_new_pin, '') <> '' then crypt(p_new_pin, gen_salt('bf')) else pin_hash end,
                      app_open = coalesce(p_open, app_open), active = coalesce(p_active, active), updated_at = now() where id = ex.id;
  end if;
  perform kk_notify(array['staff'], '매장 계정 ' || case when ex.id is null then '생성' else '변경' end || ' · ' || s, '진천센터(' || p_name || ')' || case when coalesce(p_new_pin, '') <> '' then ' · PIN 설정' else '' end, '#setup');
  return jsonb_build_object('name', s, 'created', ex.id is null);
end $$;
revoke all on function center_store_list(text,text), center_store_save(text,text,text,text,boolean,boolean) from public;
grant execute on function store_is_open(text), center_store_list(text,text), center_store_save(text,text,text,text,boolean,boolean) to anon, authenticated;

-- b31-a: 진천센터 화면 '앱 설치 링크' — 더한물류(업체) · 다른 센터(콜드체인 등) · 전 매장 이름(링크 만들기용, PIN 은 없음)
create or replace function center_link_list(p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform center_check(p_name, p_pin);
  return jsonb_build_object(
    'vendors', coalesce((select jsonb_agg(name order by name) from vendors where active), '[]'),
    'centers', coalesce((select jsonb_agg(name order by name) from stores where kind = 'center' and active and name <> p_name), '[]'),
    'stores',  coalesce((select jsonb_agg(jsonb_build_object('name', name, 'app_open', app_open) order by name) from stores where kind = 'store' and active), '[]'));
end $$;
revoke all on function center_link_list(text,text) from public;
grant execute on function center_link_list(text,text) to anon, authenticated;


-- ===================================================================
-- b32 — 매장: 요청 취소 · 다시 요청 없음(진행 상황만), '입고 완료'는 매장이 누름
-- ===================================================================
alter table dispatches add column if not exists received_at timestamptz;
alter table dispatches add column if not exists received_by text;
create or replace function store_list(p_store text, p_pin text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin);
begin
  return query
    select jsonb_build_object('id', d.id, 'status', d.status, 'run_date', d.run_date, 'created_at', d.created_at,
             'type', d.type, 'from_place', d.from_place, 'to_place', d.to_place, 'plt_qty', d.plt_qty, 'time_slot', d.time_slot, 'temp', d.temp, 'cargo_note', d.cargo_note, 'origin', d.origin, 'requested_by', d.requested_by,
             'vehicle_ton', d.vehicle_ton, 'vehicle_body', d.vehicle_body,
             'driver_name', d.driver_name, 'driver_phone', d.driver_phone, 'vehicle_no', d.vehicle_no,
             'vendor', (select name from vendors v where v.id = d.vendor_id), 'received_at', d.received_at, 'received_by', d.received_by,
             'receipts', (select count(*) from attachments a where a.dispatch_id = d.id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'note', e.note) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id),
             'delivery', (select to_jsonb(x) - 'dispatch_id' from dispatch_delivery x where x.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null and ((d.type = 'delivery' and d.from_place = s) or (d.type <> 'delivery' and d.to_place = s))   -- 우리 매장 고객배송 + 우리 매장으로 오는 쿠팡 · 센터 출고
       and coalesce(d.created_at, now()) >= now() - interval '90 days'
     order by d.id desc;
end $$;

create or replace function store_receive(p_store text, p_pin text, p_id bigint, p_note text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin); d dispatches; vn text;
begin
  select * into d from dispatches where id = p_id and deleted_at is null and type <> 'delivery' and to_place = s;
  if d.id is null then raise exception '우리 매장으로 오는 배차가 아닙니다'; end if;
  if d.status not in ('assigned','done','checked','confirmed') then raise exception '배차(기사 · 차량)가 정해진 뒤에 입고 완료를 누를 수 있습니다'; end if;
  if d.received_at is not null then return; end if;
  perform set_config('kk.skip_track', '1', true);
  update dispatches set received_at = now(), received_by = 'store:' || s || coalesce(' · ' || nullif(trim(p_note), ''), ''), updated_by = 'store:' || s where id = d.id;
  select 'vendor:' || name into vn from vendors where id = d.vendor_id;
  perform kk_notify(array['staff', 'store:' || d.from_place] || case when vn is not null then array[vn] else '{}'::text[] end,
                    '입고 완료 · ' || s, '#' || d.id || ' ' || d.from_place || '→' || s || coalesce(' ' || d.plt_qty || 'plt', ''), '');
end $$;
revoke all on function store_receive(text,text,bigint,text) from public;
grant execute on function store_receive(text,text,bigint,text) to anon, authenticated;

-- 매장은 센터 → 매장 출고 요청을 취소할 수 없음(고객 배송 요청만 취소 가능)
create or replace function store_cancel(p_store text, p_pin text, p_id bigint)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin);
begin
  if exists (select 1 from dispatches where id = p_id and type <> 'delivery') then raise exception '센터 출고 요청은 매장에서 취소할 수 없습니다 — 진천센터 · 본사에 연락해 주세요'; end if;
  update dispatches set status = 'canceled', updated_by = 'store:' || s where id = p_id and status = 'requested' and type = 'delivery' and from_place = s;
  if not found then raise exception '배차가 이미 잡힌 건은 본사에 연락해 주세요'; end if;
end $$;

-- b32: 진천센터 화면에도 매장 입고 완료 표시
create or replace function center_list(p_name text, p_pin text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); pl text[] := center_places(s);
begin
  return query
    select jsonb_build_object('id', d.id, 'status', d.status, 'received_at', d.received_at, 'received_by', d.received_by, 'run_date', d.run_date, 'created_at', d.created_at, 'type', d.type,
             'from_place', d.from_place, 'to_place', d.to_place, 'via_place', d.via_place, 'plt_qty', d.plt_qty, 'time_slot', d.time_slot, 'temp', d.temp,
             'cargo_note', d.cargo_note, 'group_no', d.group_no, 'origin', d.origin, 'orderer', d.orderer, 'requested_by', d.requested_by,
             'driver_name', d.driver_name, 'driver_phone', d.driver_phone, 'vehicle_no', d.vehicle_no, 'vehicle_ton', d.vehicle_ton, 'vehicle_body', d.vehicle_body,
             'vendor', (select name from vendors v where v.id = d.vendor_id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'note', e.note, 'driver_name', e.driver_name) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null and d.type <> 'delivery'
       and (d.from_place = any(pl) or d.to_place = any(pl) or d.orderer = s)
       and d.run_date >= current_date - 60
     order by d.run_date desc, d.id desc;
end $$;


-- b32-a: 매장이 직접 올린 출고 요청(빠른 요청 · orderer 없음)은 배차 전까지 매장이 취소 가능. 진천센터가 올린 건(orderer = 센터)은 취소 불가
create or replace function store_list(p_store text, p_pin text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin);
begin
  return query
    select jsonb_build_object('id', d.id, 'status', d.status, 'run_date', d.run_date, 'created_at', d.created_at,
             'type', d.type, 'from_place', d.from_place, 'to_place', d.to_place, 'plt_qty', d.plt_qty, 'time_slot', d.time_slot, 'temp', d.temp, 'cargo_note', d.cargo_note, 'origin', d.origin, 'requested_by', d.requested_by,
             'vehicle_ton', d.vehicle_ton, 'vehicle_body', d.vehicle_body,
             'driver_name', d.driver_name, 'driver_phone', d.driver_phone, 'vehicle_no', d.vehicle_no,
             'vendor', (select name from vendors v where v.id = d.vendor_id), 'received_at', d.received_at, 'received_by', d.received_by, 'orderer', d.orderer,
             'receipts', (select count(*) from attachments a where a.dispatch_id = d.id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'note', e.note) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id),
             'delivery', (select to_jsonb(x) - 'dispatch_id' from dispatch_delivery x where x.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null and ((d.type = 'delivery' and d.from_place = s) or (d.type <> 'delivery' and d.to_place = s))   -- 우리 매장 고객배송 + 우리 매장으로 오는 쿠팡 · 센터 출고
       and coalesce(d.created_at, now()) >= now() - interval '90 days'
     order by d.id desc;
end $$;
create or replace function store_cancel(p_store text, p_pin text, p_id bigint)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin);
begin
  if exists (select 1 from dispatches where id = p_id and type <> 'delivery' and (origin <> 'store' or orderer is not null)) then raise exception '센터가 올린 출고 요청은 매장에서 취소할 수 없습니다 — 진천센터 · 본사에 연락해 주세요'; end if;
  update dispatches set status = 'canceled', updated_by = 'store:' || s
   where id = p_id and status = 'requested' and ((type = 'delivery' and from_place = s) or (type <> 'delivery' and origin = 'store' and orderer is null and to_place = s));
  if not found then raise exception '배차가 이미 잡힌 건은 본사에 연락해 주세요'; end if;
end $$;

-- ===================================================================
-- b33 — 매장 요청 → 더한물류(자동) + 진천센터에도 알림 · 센터 [상차 준비 확인] → 매장에 '센터 확인됨'
-- ===================================================================
alter table dispatches add column if not exists center_ok_at timestamptz;
alter table dispatches add column if not exists center_ok_by text;

-- 매장이 올린 출고 요청이 들어오면 출발 센터(진천센터)에 바로 알림(더한물류 알림은 기존 notify_on_event 그대로)
create or replace function notify_center_on_store_req() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare cn text;
begin
  if new.origin = 'store' and new.orderer is null and new.type <> 'delivery' and new.status = 'requested' then
    select name into cn from stores where kind = 'center' and active is not false and (name = new.from_place or new.from_place = any(coalesce(places, '{}'))) limit 1;
    if cn is not null then
      perform kk_notify(array['store:' || cn], '매장 요청 · ' || new.to_place, '#' || new.id || ' ' || new.from_place || '→' || new.to_place || coalesce(' ' || new.plt_qty || 'plt', '')
                        || ' ' || to_char(new.run_date, 'MM/DD') || coalesce(' ' || nullif(new.time_slot, ''), '') || ' — 앱에서 [상차 준비 확인]', '?g=');
    end if;
  end if;
  return new;
end $$;
drop trigger if exists t_notify_center_store_req on dispatches;
create trigger t_notify_center_store_req after insert on dispatches for each row execute function notify_center_on_store_req();

-- 진천센터: [상차 준비 확인] → 매장 화면에 '센터 확인됨' + 매장 알림
create or replace function center_ack(p_name text, p_pin text, p_id bigint, p_who text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); pl text[] := center_places(s); d dispatches;
begin
  select * into d from dispatches where id = p_id and deleted_at is null and type <> 'delivery' and (from_place = any(pl) or to_place = any(pl));
  if d.id is null then raise exception '우리 센터 배차가 아닙니다'; end if;
  if d.status = 'canceled' then raise exception '취소된 요청입니다'; end if;
  if d.center_ok_at is not null then return; end if;
  perform set_config('kk.skip_track', '1', true);
  update dispatches set center_ok_at = now(), center_ok_by = s || coalesce(' ' || nullif(trim(p_who), ''), ''), updated_by = 'store:' || s where id = d.id;
  perform kk_notify(array['store:' || d.to_place], '센터 확인 · 상차 준비', '#' || d.id || ' ' || d.from_place || '→' || d.to_place || coalesce(' ' || d.plt_qty || 'plt', '') || ' ' || to_char(d.run_date, 'MM/DD'), '?s=');
end $$;
revoke all on function center_ack(text,text,bigint,text) from public;
grant execute on function center_ack(text,text,bigint,text) to anon, authenticated;

create or replace function store_list(p_store text, p_pin text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin);
begin
  return query
    select jsonb_build_object('id', d.id, 'status', d.status, 'run_date', d.run_date, 'created_at', d.created_at,
             'type', d.type, 'from_place', d.from_place, 'to_place', d.to_place, 'plt_qty', d.plt_qty, 'time_slot', d.time_slot, 'temp', d.temp, 'cargo_note', d.cargo_note, 'origin', d.origin, 'requested_by', d.requested_by,
             'vehicle_ton', d.vehicle_ton, 'vehicle_body', d.vehicle_body,
             'driver_name', d.driver_name, 'driver_phone', d.driver_phone, 'vehicle_no', d.vehicle_no,
             'vendor', (select name from vendors v where v.id = d.vendor_id), 'received_at', d.received_at, 'received_by', d.received_by, 'orderer', d.orderer, 'center_ok_at', d.center_ok_at, 'center_ok_by', d.center_ok_by,
             'receipts', (select count(*) from attachments a where a.dispatch_id = d.id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'note', e.note) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id),
             'delivery', (select to_jsonb(x) - 'dispatch_id' from dispatch_delivery x where x.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null and ((d.type = 'delivery' and d.from_place = s) or (d.type <> 'delivery' and d.to_place = s))   -- 우리 매장 고객배송 + 우리 매장으로 오는 쿠팡 · 센터 출고
       and coalesce(d.created_at, now()) >= now() - interval '90 days'
     order by d.id desc;
end $$;

create or replace function center_list(p_name text, p_pin text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); pl text[] := center_places(s);
begin
  return query
    select jsonb_build_object('id', d.id, 'status', d.status, 'received_at', d.received_at, 'received_by', d.received_by, 'center_ok_at', d.center_ok_at, 'center_ok_by', d.center_ok_by, 'run_date', d.run_date, 'created_at', d.created_at, 'type', d.type,
             'from_place', d.from_place, 'to_place', d.to_place, 'via_place', d.via_place, 'plt_qty', d.plt_qty, 'time_slot', d.time_slot, 'temp', d.temp,
             'cargo_note', d.cargo_note, 'group_no', d.group_no, 'origin', d.origin, 'orderer', d.orderer, 'requested_by', d.requested_by,
             'driver_name', d.driver_name, 'driver_phone', d.driver_phone, 'vehicle_no', d.vehicle_no, 'vehicle_ton', d.vehicle_ton, 'vehicle_body', d.vehicle_body,
             'vendor', (select name from vendors v where v.id = d.vendor_id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'note', e.note, 'driver_name', e.driver_name) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null and d.type <> 'delivery'
       and (d.from_place = any(pl) or d.to_place = any(pl) or d.orderer = s)
       and d.run_date >= current_date - 60
     order by d.run_date desc, d.id desc;
end $$;

select 'b33ok-' || count(*) as r from pg_proc where proname in ('center_ack','notify_center_on_store_req','store_list','center_list');

-- ===================================================================
-- b33-b — 매장은 센터 출고를 임의로 요청하지 않음 · 매장이 하는 요청은 '고객 배송 요청'
--   매장 배송 요청 → 더한물류(기존 알림) + 진천센터(app_config delivery_center, 기본 진천센터)에도 알림 · 목록 · [상차 준비 확인]
-- ===================================================================
create or replace function notify_center_on_store_req() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare cn text;
begin
  if new.origin = 'store' and new.orderer is null and new.status = 'requested' then
    if new.type = 'delivery' then
      cn := coalesce((select value from app_config where key = 'delivery_center'), '진천센터');
      perform kk_notify(array['store:' || cn], '매장 배송 요청 · ' || new.from_place, '#' || new.id || ' ' || new.from_place || ' → 고객 · 희망 ' || to_char(new.run_date, 'MM/DD') || ' — 앱에서 [상차 준비 확인]', '?g=');
    else
      select name into cn from stores where kind = 'center' and active is not false and (name = new.from_place or new.from_place = any(coalesce(places, '{}'))) limit 1;
      if cn is not null then
        perform kk_notify(array['store:' || cn], '매장 요청 · ' || new.to_place, '#' || new.id || ' ' || new.from_place || '→' || new.to_place || coalesce(' ' || new.plt_qty || 'plt', '') || ' ' || to_char(new.run_date, 'MM/DD') || ' — 앱에서 [상차 준비 확인]', '?g=');
      end if;
    end if;
  end if;
  return new;
end $$;

create or replace function center_ack(p_name text, p_pin text, p_id bigint, p_who text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); pl text[] := center_places(s); d dispatches; dc text := coalesce((select value from app_config where key = 'delivery_center'), '진천센터'); st text;
begin
  select * into d from dispatches where id = p_id and deleted_at is null
     and ((type <> 'delivery' and (from_place = any(pl) or to_place = any(pl))) or (type = 'delivery' and origin = 'store' and s = dc));
  if d.id is null then raise exception '우리 센터 배차가 아닙니다'; end if;
  if d.status = 'canceled' then raise exception '취소된 요청입니다'; end if;
  if d.center_ok_at is not null then return; end if;
  perform set_config('kk.skip_track', '1', true);
  update dispatches set center_ok_at = now(), center_ok_by = s || coalesce(' ' || nullif(trim(p_who), ''), ''), updated_by = 'store:' || s where id = d.id;
  st := case when d.type = 'delivery' then d.from_place else d.to_place end;
  perform kk_notify(array['store:' || st], '센터 확인 · 상차 준비', '#' || d.id || ' ' || d.from_place || '→' || d.to_place || coalesce(' ' || d.plt_qty || 'plt', '') || ' ' || to_char(d.run_date, 'MM/DD'), '?s=');
end $$;

create or replace function center_list(p_name text, p_pin text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); pl text[] := center_places(s); dc text := coalesce((select value from app_config where key = 'delivery_center'), '진천센터');
begin
  return query
    select jsonb_build_object('id', d.id, 'status', d.status, 'received_at', d.received_at, 'received_by', d.received_by, 'center_ok_at', d.center_ok_at, 'center_ok_by', d.center_ok_by, 'run_date', d.run_date, 'created_at', d.created_at, 'type', d.type,
             'from_place', d.from_place, 'to_place', d.to_place, 'via_place', d.via_place, 'plt_qty', d.plt_qty, 'time_slot', d.time_slot, 'temp', d.temp,
             'cargo_note', d.cargo_note, 'group_no', d.group_no, 'origin', d.origin, 'orderer', d.orderer, 'requested_by', d.requested_by,
             'driver_name', d.driver_name, 'driver_phone', d.driver_phone, 'vehicle_no', d.vehicle_no, 'vehicle_ton', d.vehicle_ton, 'vehicle_body', d.vehicle_body,
             'vendor', (select name from vendors v where v.id = d.vendor_id),
             'delivery', (select jsonb_build_object('product', x.product, 'qty', x.qty, 'customer_name', x.customer_name, 'address', x.address, 'order_date', x.order_date, 'asap', x.asap) from dispatch_delivery x where x.dispatch_id = d.id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'note', e.note, 'driver_name', e.driver_name) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null
       and ((d.type <> 'delivery' and (d.from_place = any(pl) or d.to_place = any(pl) or d.orderer = s))
            or (d.type = 'delivery' and d.origin = 'store' and s = dc))   -- b33: 매장 배송 요청도 진천센터에 보임
       and d.run_date >= current_date - 60
     order by d.run_date desc, d.id desc;
end $$;

select 'b33bok-' || count(*) as r from pg_proc where proname in ('center_ack','notify_center_on_store_req','center_list');

-- ===================================================================
-- b33-c — 더한물류 '매장 배송 체크리스트': 매장이 영수증 붙여 올린 배송 요청을 확인했으면 체크
-- ===================================================================
create table if not exists vendor_checks (
  dispatch_id bigint primary key references dispatches(id) on delete cascade,
  vendor text not null, at timestamptz not null default now(), note text
);
alter table vendor_checks enable row level security;
drop policy if exists staff_all on vendor_checks;
create policy staff_all on vendor_checks for all to authenticated using (is_staff()) with check (is_staff());
create or replace function vendor_checks_list(p_vendor text, p_pin text) returns setof vendor_checks
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform vendor_check(p_vendor, p_pin);
  return query select * from vendor_checks where at >= now() - interval '60 days';
end $$;
create or replace function vendor_check_set(p_vendor text, p_pin text, p_id bigint, p_on boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform vendor_check(p_vendor, p_pin);
  if not exists (select 1 from dispatches where id = p_id and deleted_at is null) then raise exception '없는 배차입니다'; end if;
  if p_on then insert into vendor_checks(dispatch_id, vendor) values (p_id, p_vendor) on conflict (dispatch_id) do update set at = now(), vendor = excluded.vendor;
  else delete from vendor_checks where dispatch_id = p_id; end if;
end $$;
revoke all on function vendor_checks_list(text,text), vendor_check_set(text,text,bigint,boolean) from public;
grant execute on function vendor_checks_list(text,text), vendor_check_set(text,text,bigint,boolean) to anon, authenticated;
select 'b33cok-' || count(*) as r from pg_proc where proname in ('vendor_checks_list','vendor_check_set');

-- b33-d — 더한물류가 직접 등록한 입력 대기 요청은 삭제 권한 없이도 지움
create or replace function vendor_delete(p_vendor text, p_pin text, p_ids bigint[], p_reason text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin); n int; bad int;
begin
  -- b33: 삭제 권한이 없어도, 더한물류가 직접 등록한(붙여넣기 · 사진) 입력 대기 요청은 7일 안에 지울 수 있음
  if not coalesce((select can_delete from vendors where id = v), false)
     and exists (select 1 from dispatches where id = any(p_ids) and deleted_at is null
                  and not (origin = 'kingkong' and vendor_id = v and updated_by = 'vendor:' || p_vendor and created_at > now() - interval '7 days')) then
    raise exception '삭제 권한이 없습니다 — 직접 등록한 요청만 지울 수 있습니다(다른 건은 킹콩 본사에 요청)'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception '삭제 사유를 넣어 주세요'; end if;
  select count(*) into bad from dispatches where id = any(p_ids) and deleted_at is null
     and (status <> 'requested' or coalesce(driver_name, '') <> '' or (vendor_id is not null and vendor_id <> v));
  if bad > 0 then raise exception '입력 대기(기사 · 차량 없는 배차 요청) 건만 지울 수 있습니다'; end if;
  perform set_config('kk.actor', 'vendor:' || p_vendor, true);
  perform set_config('kk.no_notify', '1', true);
  perform set_config('kk.skip_track', '1', true);
  update dispatches set deleted_at = now(), deleted_by = 'vendor:' || p_vendor, delete_reason = trim(p_reason), updated_by = 'vendor:' || p_vendor
   where id = any(p_ids) and deleted_at is null;
  get diagnostics n = row_count;
  perform set_config('kk.no_notify', '', true);
  if n > 0 then perform kk_notify(array['staff'], '입력 대기 건 삭제 · ' || p_vendor, n || '건 · ' || left(trim(p_reason), 60), '#setup'); end if;
  return n;
end $$;
select 'b33dok' as r;

-- ===================================================================
-- b33-e — 진천센터에도 '물류비 이상 · 절감 솔루션'(본사와 같은 기준) — 진천 관련 건의 운임만 · 최근 120일
-- ===================================================================
create or replace function center_cost(p_name text, p_pin text) returns setof jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); pl text[] := center_places(s);
begin
  return query select to_jsonb(d) - 'memo' - 'pin_hash'
    from dispatches d where d.deleted_at is null and d.run_date >= current_date - 120
     and (d.from_place = any(pl) or d.to_place = any(pl) or d.orderer = s);
end $$;
-- 센터가 더한물류에 질문(물류비 확인) — 더한물류 · 본사에 알림, 더한물류 '질문' 탭에 뜸
create or replace function center_ask(p_name text, p_pin text, p_id bigint, p_body text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); pl text[] := center_places(s); d dispatches; vn text;
begin
  select * into d from dispatches where id = p_id and deleted_at is null and (from_place = any(pl) or to_place = any(pl) or orderer = s);
  if d.id is null then raise exception '우리 센터 배차가 아닙니다'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception '내용을 적어 주세요'; end if;
  insert into dispatch_comments(dispatch_id, author, kind, body) values (d.id, 'center:' || s, 'question', left(trim(p_body), 1000));
  select 'vendor:' || name into vn from vendors where id = d.vendor_id;
  perform kk_notify(array['staff'] || case when vn is not null then array[vn] else '{}'::text[] end, '물류비 질문 · ' || s, '#' || d.id || ' ' || d.from_place || '→' || d.to_place || ' — ' || left(trim(p_body), 60), '?v=');
end $$;
revoke all on function center_cost(text,text), center_ask(text,text,bigint,text) from public;
grant execute on function center_cost(text,text), center_ask(text,text,bigint,text) to anon, authenticated;
select 'b33eok-' || count(*) as r from pg_proc where proname in ('center_cost','center_ask');

-- ===================================================================
-- b33-f — 매장 계정 관리: 진천센터 · 본사 모두(만들기 · PIN · 앱 열기/닫기 · 사용 중지 · 삭제)
--   삭제 = 목록 · 링크에서 빠지고 로그인 안 됨(기록 · 배차 이력은 그대로, 같은 이름으로 다시 만들면 되살아남)
-- ===================================================================
alter table stores add column if not exists deleted_at timestamptz;
alter table stores add column if not exists deleted_by text;
alter table stores add column if not exists delete_reason text;
create or replace function store_mgr_actor(p_kind text, p_name text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_kind = 'center' then perform center_check(p_name, p_pin); return 'center:' || p_name;
  elsif is_staff() then return coalesce(auth.jwt() ->> 'email', 'staff');
  else raise exception '권한이 없습니다'; end if;
end $$;
create or replace function store_mgr_list(p_kind text, p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform store_mgr_actor(p_kind, p_name, p_pin);
  return coalesce((select jsonb_agg(jsonb_build_object('name', name, 'active', active, 'app_open', app_open, 'created_by', created_by, 'updated_at', updated_at) order by name)
                     from stores where kind = 'store' and deleted_at is null), '[]');
end $$;
create or replace function store_mgr_save(p_kind text, p_name text, p_pin text, p_store text, p_new_pin text, p_open boolean, p_active boolean default true) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a text := store_mgr_actor(p_kind, p_name, p_pin); s text := trim(coalesce(p_store, '')); ex stores;
begin
  perform set_config('kk.actor', a, true);
  if s !~ '^[가-힣A-Za-z0-9()\-]{2,20}$' then raise exception '매장 이름은 2~20자(한글 · 영문 · 숫자)로 넣어 주세요'; end if;
  if p_new_pin is not null and p_new_pin <> '' and p_new_pin !~ '^\d{4,8}$' then raise exception 'PIN은 숫자 4~8자리로 넣어 주세요'; end if;
  select * into ex from stores where name = s;
  if ex.id is not null and ex.kind <> 'store' then raise exception '센터 계정은 여기서 바꿀 수 없습니다'; end if;
  if ex.id is null then
    if coalesce(p_new_pin, '') = '' then raise exception '새 매장은 PIN이 필요합니다'; end if;
    insert into stores(name, kind, pin_hash, active, app_open, created_by, updated_at) values (s, 'store', crypt(p_new_pin, gen_salt('bf')), true, coalesce(p_open, true), a, now());
  elsif ex.deleted_at is not null then   -- 지운 매장을 같은 이름으로 다시 만들면 되살림
    if coalesce(p_new_pin, '') = '' then raise exception '새 매장은 PIN이 필요합니다'; end if;
    update stores set pin_hash = crypt(p_new_pin, gen_salt('bf')), active = true, app_open = coalesce(p_open, true), deleted_at = null, deleted_by = null, delete_reason = null, updated_at = now() where id = ex.id;
  else
    update stores set pin_hash = case when coalesce(p_new_pin, '') <> '' then crypt(p_new_pin, gen_salt('bf')) else pin_hash end,
                      app_open = coalesce(p_open, app_open), active = coalesce(p_active, active), updated_at = now() where id = ex.id;
  end if;
  if p_kind = 'center' then perform kk_notify(array['staff'], '매장 계정 ' || case when ex.id is null then '생성' else '변경' end || ' · ' || s, p_name || case when coalesce(p_new_pin, '') <> '' then ' · PIN 설정' else '' end, '#setup'); end if;
  return jsonb_build_object('name', s, 'created', ex.id is null);
end $$;
create or replace function store_mgr_delete(p_kind text, p_name text, p_pin text, p_store text, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare a text := store_mgr_actor(p_kind, p_name, p_pin); ex stores;
begin
  select * into ex from stores where name = trim(coalesce(p_store, '')) and deleted_at is null;
  if ex.id is null then raise exception '없는 매장입니다'; end if;
  if ex.kind <> 'store' then raise exception '센터 계정은 지울 수 없습니다'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception '삭제 사유를 넣어 주세요'; end if;
  perform set_config('kk.actor', a, true);
  update stores set deleted_at = now(), deleted_by = a, delete_reason = trim(p_reason), active = false, app_open = false, updated_at = now() where id = ex.id;
  if p_kind = 'center' then perform kk_notify(array['staff'], '매장 계정 삭제 · ' || ex.name, p_name || ' · ' || left(trim(p_reason), 60), '#setup'); end if;
end $$;
revoke all on function store_mgr_actor(text,text,text), store_mgr_list(text,text,text), store_mgr_save(text,text,text,text,text,boolean,boolean), store_mgr_delete(text,text,text,text,text) from public;
grant execute on function store_mgr_list(text,text,text), store_mgr_save(text,text,text,text,text,boolean,boolean), store_mgr_delete(text,text,text,text,text) to anon, authenticated;
select 'b33fok-' || count(*) as r from pg_proc where proname in ('store_mgr_actor','store_mgr_list','store_mgr_save','store_mgr_delete');

-- ===================================================================
-- b33-g — 진천센터 물류비 일별 · 주별 · 월별 · 매장별 · 구간별(본사와 같은 화면) — 기간을 골라 운임 칸만(최대 2년)
-- ===================================================================
create or replace function center_cost_range(p_name text, p_pin text, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); pl text[] := center_places(s);
begin
  if p_from is null or p_to is null or p_to < p_from then raise exception '기간을 확인해 주세요'; end if;
  if p_to - p_from > 800 then raise exception '기간은 2년 이내로 골라 주세요'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'run_date', d.run_date, 'type', d.type, 'status', d.status, 'origin', d.origin, 'orderer', d.orderer,
      'from_place', d.from_place, 'to_place', d.to_place, 'via_place', d.via_place, 'plt_qty', d.plt_qty, 'vehicle_ton', d.vehicle_ton, 'driver_name', d.driver_name,
      'base_fare', d.base_fare, 'extra_fare', d.extra_fare, 'extra_reason', d.extra_reason, 'return_fare', d.return_fare) order by d.run_date, d.id)
    from dispatches d where d.deleted_at is null and d.run_date between p_from and p_to
     and (d.from_place = any(pl) or d.to_place = any(pl) or d.orderer = s)), '[]');
end $$;
revoke all on function center_cost_range(text,text,date,date) from public;
grant execute on function center_cost_range(text,text,date,date) to anon, authenticated;
select 'b33gok-' || count(*) as r from pg_proc where proname = 'center_cost_range';

-- ===================================================================
-- b34 — 접속 현황(본사 '접속 현황' 탭): 앱을 열어 둔 동안 1분마다 신호 → 누가 · 언제부터 · 어느 기기 · IP · 어느 화면
--   보기만 해도 남음 · 180일 보관 · 본사 외 계정이 6시간 만에 처음 들어오면 본사에 알림
-- ===================================================================
create table if not exists access_sessions (
  sess     text primary key,                  -- 브라우저 탭마다 하나(임의 값)
  who      text not null,                     -- 'vendor:더한물류' · 'center:진천센터' · 'store:경안점' · 'checker:…' · 관리자 이메일
  kind     text not null,
  first_at timestamptz not null default now(),
  last_at  timestamptz not null default now(),
  pings    integer not null default 1,
  page     text, ua text, ip text
);
create index if not exists access_sessions_last on access_sessions (last_at desc);
create index if not exists access_sessions_who on access_sessions (who, last_at desc);
alter table access_sessions enable row level security;
drop policy if exists staff_read on access_sessions;
create policy staff_read on access_sessions for select to authenticated using (is_staff());
create or replace function access_ping(p_kind text, p_name text, p_pin text, p_sess text, p_page text, p_ua text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare w text; ip text; fresh boolean;
begin
  if p_kind = 'vendor' then perform vendor_check(p_name, p_pin); w := 'vendor:' || p_name;
  elsif p_kind = 'store' then perform store_check(p_name, p_pin); w := 'store:' || p_name;
  elsif p_kind = 'center' then perform center_check(p_name, p_pin); w := 'center:' || p_name;
  elsif p_kind = 'checker' then perform checker_check(p_name, p_pin); w := 'checker:' || p_name;
  elsif p_kind = 'staff' and is_staff() then w := coalesce(auth.jwt() ->> 'email', 'staff');
  else raise exception '권한이 없습니다'; end if;
  if coalesce(p_sess, '') !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'bad session'; end if;
  ip := nullif(trim(split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''), ',', 1)), '');
  fresh := p_kind <> 'staff' and not exists (select 1 from access_sessions where who = w and last_at > now() - interval '6 hours');
  insert into access_sessions(sess, who, kind, page, ua, ip) values (p_sess, w, p_kind, left(p_page, 80), left(p_ua, 200), ip)
  on conflict (sess) do update set who = excluded.who, kind = excluded.kind, last_at = now(), pings = access_sessions.pings + 1,
                                   page = excluded.page, ip = coalesce(excluded.ip, access_sessions.ip);
  if fresh then begin perform kk_notify(array['staff'], '접속 · ' || regexp_replace(w, '^[a-z]+:', ''), left(coalesce(p_page, ''), 40), '#access'); exception when others then null; end; end if;
  if random() < 0.01 then delete from access_sessions where last_at < now() - interval '180 days'; end if;
end $$;
revoke all on function access_ping(text,text,text,text,text,text) from public;
grant execute on function access_ping(text,text,text,text,text,text) to anon, authenticated;
select 'b34ok-' || count(*) as r from pg_proc where proname = 'access_ping';

-- ===================================================================
-- b35 — 센터 출고 PLT 등록(출고 전 PLT 라벨 스캔 · 사진 → PLT No 목록 → 전산 담당 '매장이동 전표' 작업)
--   plt_ref : 지난 출고내역서에서 배운 규칙(접두 번호 · LOT 리스트명) — 공개 저장소에 두지 않고 DB에만
--   plt_out : 센터 · 날짜 · 하차지 · PLT No · CATE · REMARKS · 확인 사진(작게, 45일 뒤 지움) · 전표 완료
-- ===================================================================
create table if not exists plt_ref (kind text not null, key text not null, val text not null, primary key (kind, key));
alter table plt_ref enable row level security;
create table if not exists plt_out (
  id         bigint generated always as identity primary key,
  center     text not null,
  out_date   date not null,
  store      text not null,
  seq        integer,
  plt_no     text not null,
  cate       text, remark text,
  how        text,                 -- scan · photo · ocr · hand
  photo      text,                 -- 확인용 작은 사진(data URL)
  created_by text, created_at timestamptz not null default now(),
  updated_by text, updated_at timestamptz,
  deleted_at timestamptz, deleted_by text,
  slip_at    timestamptz, slip_by text
);
create index if not exists plt_out_day on plt_out (center, out_date) where deleted_at is null;
create index if not exists plt_out_no on plt_out (plt_no) where deleted_at is null;
alter table plt_out enable row level security;
drop policy if exists staff_read on plt_out;
create policy staff_read on plt_out for select to authenticated using (is_staff());
-- 누가: 센터(PIN) → 'center:이름' · 본사 → 이메일. 센터는 자기 센터 줄만
create or replace function plt_actor(p_kind text, p_name text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_kind = 'center' then perform center_check(p_name, p_pin); return 'center:' || p_name;
  elsif is_staff() then return coalesce(auth.jwt() ->> 'email', 'staff');
  else raise exception '권한이 없습니다'; end if;
end $$;
create or replace function plt_ref_get(p_kind text, p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform plt_actor(p_kind, p_name, p_pin);
  return jsonb_build_object('pfx', coalesce((select jsonb_object_agg(key, val) from plt_ref where kind = 'pfx'), '{}'),
                            'rem', coalesce((select jsonb_object_agg(key, val) from plt_ref where kind = 'rem'), '{}'));
end $$;
create or replace function plt_out_list(p_kind text, p_name text, p_pin text, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a text := plt_actor(p_kind, p_name, p_pin);
begin
  if p_to - p_from > 400 then raise exception '기간이 너무 깁니다'; end if;
  return coalesce((select jsonb_agg(to_jsonb(o) - 'photo' || jsonb_build_object('has_photo', o.photo is not null) order by o.out_date desc, o.store, o.seq, o.id)
    from plt_out o where o.deleted_at is null and o.out_date between p_from and p_to and (p_kind <> 'center' or o.center = p_name)), '[]');
end $$;
create or replace function plt_out_photo(p_kind text, p_name text, p_pin text, p_id bigint) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform plt_actor(p_kind, p_name, p_pin);
  return (select photo from plt_out where id = p_id and (p_kind <> 'center' or center = p_name));
end $$;
-- 저장: id 있으면 고침(전표 완료였으면 다시 '전표 필요'로) · 없으면 새로
create or replace function plt_out_save(p_kind text, p_name text, p_pin text, p_center text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a text := plt_actor(p_kind, p_name, p_pin); c text := case when p_kind = 'center' then p_name else coalesce(nullif(p_center, ''), '진천센터') end;
        r jsonb; ids bigint[] := '{}'; nid bigint; ex plt_out;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 400 then raise exception '한 번에 400줄까지 저장할 수 있습니다'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    -- 번호 없는 PLT(FC · 사입 · 코렐 …)는 PLT NO. 비우고 REMARKS에 품목(지난 출고내역서와 같게)
    if (coalesce(trim(r ->> 'plt_no'), '') = '' and coalesce(trim(r ->> 'remark'), '') = '') or coalesce(trim(r ->> 'store'), '') = '' or (r ->> 'out_date') is null then raise exception 'PLT No(또는 품목) · 하차지 · 날짜를 확인해 주세요'; end if;
    if (r ->> 'id') is not null then
      select * into ex from plt_out where id = (r ->> 'id')::bigint and deleted_at is null and center = c;
      if ex.id is null then raise exception '없는 줄입니다(#%)', r ->> 'id'; end if;
      update plt_out set out_date = (r ->> 'out_date')::date, store = trim(r ->> 'store'), seq = (r ->> 'seq')::int, plt_no = left(trim(r ->> 'plt_no'), 60),
             cate = left(r ->> 'cate', 60), remark = left(r ->> 'remark', 120), how = coalesce(r ->> 'how', how),
             photo = case when r ? 'photo' then left(r ->> 'photo', 200000) else photo end, updated_by = a, updated_at = now(),
             slip_at = case when plt_no is distinct from trim(r ->> 'plt_no') or store is distinct from trim(r ->> 'store') or out_date is distinct from (r ->> 'out_date')::date then null else slip_at end,
             slip_by = case when plt_no is distinct from trim(r ->> 'plt_no') or store is distinct from trim(r ->> 'store') or out_date is distinct from (r ->> 'out_date')::date then null else slip_by end
       where id = ex.id;
      ids := ids || ex.id;
    else
      insert into plt_out(center, out_date, store, seq, plt_no, cate, remark, how, photo, created_by)
      values (c, (r ->> 'out_date')::date, trim(r ->> 'store'), (r ->> 'seq')::int, left(trim(r ->> 'plt_no'), 60), left(r ->> 'cate', 60), left(r ->> 'remark', 120), r ->> 'how', left(r ->> 'photo', 200000), a)
      returning id into nid; ids := ids || nid;
    end if;
  end loop;
  update plt_out set photo = null where photo is not null and created_at < now() - interval '45 days';
  return to_jsonb(ids);
end $$;
create or replace function plt_out_delete(p_kind text, p_name text, p_pin text, p_ids bigint[]) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare a text := plt_actor(p_kind, p_name, p_pin); n integer;
begin
  update plt_out set deleted_at = now(), deleted_by = a where id = any(p_ids) and deleted_at is null and (p_kind <> 'center' or center = p_name);
  get diagnostics n = row_count; return n;
end $$;
create or replace function plt_out_slip(p_kind text, p_name text, p_pin text, p_ids bigint[], p_on boolean) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare a text := plt_actor(p_kind, p_name, p_pin); n integer;
begin
  update plt_out set slip_at = case when p_on then now() end, slip_by = case when p_on then a end
   where id = any(p_ids) and deleted_at is null and (p_kind <> 'center' or center = p_name);
  get diagnostics n = row_count; return n;
end $$;
-- 이미 출고 등록된 PLT No인지(모든 센터 · 지운 줄 제외)
create or replace function plt_out_dups(p_kind text, p_name text, p_pin text, p_nos text[]) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform plt_actor(p_kind, p_name, p_pin);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'plt_no', plt_no, 'out_date', out_date, 'store', store, 'center', center))
    from plt_out where deleted_at is null and plt_no = any(p_nos) and plt_no ~ '^\d{1,4}-[A-Z]'), '[]');
end $$;
revoke all on function plt_actor(text,text,text), plt_ref_get(text,text,text), plt_out_list(text,text,text,date,date), plt_out_photo(text,text,text,bigint),
  plt_out_save(text,text,text,text,jsonb), plt_out_delete(text,text,text,bigint[]), plt_out_slip(text,text,text,bigint[],boolean), plt_out_dups(text,text,text,text[]) from public;
grant execute on function plt_ref_get(text,text,text), plt_out_list(text,text,text,date,date), plt_out_photo(text,text,text,bigint),
  plt_out_save(text,text,text,text,jsonb), plt_out_delete(text,text,text,bigint[]), plt_out_slip(text,text,text,bigint[],boolean), plt_out_dups(text,text,text,text[]) to anon, authenticated;
select 'b35ok-' || count(*) as r from pg_proc where proname like 'plt_%';
-- 규칙 데이터(plt_ref)는 저장소에 넣지 않고 운영 DB에 따로 넣음(지난 출고내역서에서 뽑음)

-- ===================================================================
-- b36 — 매장 입고 사진 보고(XLG 등 PLT 입고 → 사진 → 진천센터): 매장이 올리고 센터가 보고 '확인'
--   사진은 작게(긴 변 900px) 최대 12장 · 60일 뒤 사진만 지움(보고 줄은 남음)
-- ===================================================================
create table if not exists rcv_reports (
  id         bigint generated always as identity primary key,
  store      text not null,
  center     text not null,
  rcv_date   date not null,
  cate       text, plt_qty integer, memo text,
  plt_nos    text[] not null default '{}',
  photos     jsonb not null default '[]',
  n_photos   integer not null default 0,
  created_by text, created_at timestamptz not null default now(),
  seen_at    timestamptz, seen_by text,
  deleted_at timestamptz, deleted_by text
);
create index if not exists rcv_reports_center on rcv_reports (center, rcv_date desc) where deleted_at is null;
create index if not exists rcv_reports_store on rcv_reports (store, created_at desc) where deleted_at is null;
alter table rcv_reports enable row level security;
drop policy if exists staff_read on rcv_reports;
create policy staff_read on rcv_reports for select to authenticated using (is_staff());
create or replace function rcv_actor(p_kind text, p_name text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_kind = 'store' then perform store_check(p_name, p_pin); return 'store:' || p_name;
  elsif p_kind = 'center' then perform center_check(p_name, p_pin); return 'center:' || p_name;
  elsif is_staff() then return coalesce(auth.jwt() ->> 'email', 'staff');
  else raise exception '권한이 없습니다'; end if;
end $$;
create or replace function rcv_add(p_store text, p_pin text, p jsonb) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare a text := rcv_actor('store', p_store, p_pin); ph jsonb := coalesce(p -> 'photos', '[]'); c text := coalesce(nullif(trim(p ->> 'center'), ''), '진천센터'); nid bigint; x jsonb;
begin
  if jsonb_typeof(ph) <> 'array' or jsonb_array_length(ph) = 0 then raise exception '사진을 한 장 이상 넣어 주세요'; end if;
  if jsonb_array_length(ph) > 12 then raise exception '사진은 한 번에 12장까지 보낼 수 있습니다'; end if;
  for x in select * from jsonb_array_elements(ph) loop if length(x #>> '{}') > 400000 then raise exception '사진이 너무 큽니다'; end if; end loop;
  insert into rcv_reports(store, center, rcv_date, cate, plt_qty, memo, plt_nos, photos, n_photos, created_by)
  values (p_store, c, coalesce((p ->> 'rcv_date')::date, current_date), left(p ->> 'cate', 30), nullif(p ->> 'plt_qty', '')::int, left(p ->> 'memo', 300),
          coalesce((select array_agg(left(v, 60)) from jsonb_array_elements_text(coalesce(p -> 'plt_nos', '[]')) v), '{}'), ph, jsonb_array_length(ph), a)
  returning id into nid;
  update rcv_reports set photos = '[]' where photos <> '[]' and created_at < now() - interval '60 days';
  begin perform kk_notify(array['store:' || c, 'staff'], '입고 사진 · ' || p_store, coalesce(p ->> 'cate', '') || ' ' || coalesce(p ->> 'plt_qty', '?') || 'PLT · 사진 ' || jsonb_array_length(ph) || '장' || coalesce(' · ' || nullif(left(p ->> 'memo', 40), ''), ''), '?g=');
  exception when others then null; end;
  return nid;
end $$;
-- 목록(사진 빼고) — 매장은 자기 매장 것, 센터는 자기 센터로 온 것, 본사는 전부
create or replace function rcv_list(p_kind text, p_name text, p_pin text, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform rcv_actor(p_kind, p_name, p_pin);
  if p_to - p_from > 400 then raise exception '기간이 너무 깁니다'; end if;
  return coalesce((select jsonb_agg(to_jsonb(r) - 'photos' order by r.created_at desc) from rcv_reports r
    where r.deleted_at is null and r.rcv_date between p_from and p_to
      and (p_kind = 'staff' or (p_kind = 'store' and r.store = p_name) or (p_kind = 'center' and r.center = p_name))), '[]');
end $$;
create or replace function rcv_photos(p_kind text, p_name text, p_pin text, p_id bigint) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform rcv_actor(p_kind, p_name, p_pin);
  return (select photos from rcv_reports where id = p_id and deleted_at is null
    and (p_kind = 'staff' or (p_kind = 'store' and store = p_name) or (p_kind = 'center' and center = p_name)));
end $$;
create or replace function rcv_seen(p_kind text, p_name text, p_pin text, p_id bigint, p_on boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare a text;
begin
  if p_kind = 'store' then raise exception '권한이 없습니다'; end if;
  a := rcv_actor(p_kind, p_name, p_pin);
  update rcv_reports set seen_at = case when p_on then now() end, seen_by = case when p_on then a end
   where id = p_id and deleted_at is null and (p_kind = 'staff' or center = p_name);
end $$;
create or replace function rcv_delete(p_kind text, p_name text, p_pin text, p_id bigint) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare a text := rcv_actor(p_kind, p_name, p_pin);
begin
  update rcv_reports set deleted_at = now(), deleted_by = a, photos = '[]'   -- 지우면 사진도 바로 지움
   where id = p_id and deleted_at is null and (p_kind = 'staff' or (p_kind = 'store' and store = p_name) or (p_kind = 'center' and center = p_name));
end $$;
revoke all on function rcv_actor(text,text,text), rcv_add(text,text,jsonb), rcv_list(text,text,text,date,date), rcv_photos(text,text,text,bigint), rcv_seen(text,text,text,bigint,boolean), rcv_delete(text,text,text,bigint) from public;
grant execute on function rcv_add(text,text,jsonb), rcv_list(text,text,text,date,date), rcv_photos(text,text,text,bigint), rcv_seen(text,text,text,bigint,boolean), rcv_delete(text,text,text,bigint) to anon, authenticated;
select 'b36ok-' || count(*) as r from pg_proc where proname like 'rcv\_%';

-- ===================================================================
-- b37 — 토트박스 회수 요청(신선 취급 매장 → 더한물류): 배차 한 건으로 들어가 더한물류가 기사 · 운임을 넣음
--   stores.fresh = 신선 취급 매장(매장 관리에서 켜고 끔) · dispatches.tote = 토트박스 회수 건(더한물류 '토트박스 회수'에 따로 모임)
-- ===================================================================
alter table stores add column if not exists fresh boolean not null default false;
alter table dispatches add column if not exists tote boolean not null default false;
alter table dispatches add column if not exists tote_qty integer;
create or replace function store_info(p_store text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin);
begin
  return jsonb_build_object('fresh', coalesce((select fresh from stores where name = s), false));
end $$;
create or replace function store_mgr_fresh(p_kind text, p_name text, p_pin text, p_store text, p_on boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare a text := store_mgr_actor(p_kind, p_name, p_pin);
begin
  perform set_config('kk.actor', a, true);
  update stores set fresh = coalesce(p_on, false), updated_at = now() where name = p_store and kind = 'store' and deleted_at is null;
  if not found then raise exception '없는 매장입니다'; end if;
end $$;
create or replace function store_mgr_list(p_kind text, p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform store_mgr_actor(p_kind, p_name, p_pin);
  return coalesce((select jsonb_agg(jsonb_build_object('name', name, 'active', active, 'app_open', app_open, 'fresh', fresh, 'created_by', created_by, 'updated_at', updated_at) order by name)
                     from stores where kind = 'store' and deleted_at is null), '[]');
end $$;
create or replace function tote_request(p_store text, p_pin text, p jsonb) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin); q int := nullif(p ->> 'qty', '')::int; dst text := coalesce(nullif(trim(p ->> 'to'), ''), '진천센터'); nid bigint;
begin
  if not coalesce((select fresh from stores where name = s), false) then raise exception '신선 취급 매장만 토트박스 회수를 요청할 수 있습니다 — 본사 · 진천센터에 말씀해 주세요'; end if;
  if q is null or q < 1 or q > 5000 then raise exception '토트박스 수량을 넣어 주세요'; end if;
  insert into dispatches(type, status, origin, run_date, time_slot, from_place, to_place, temp, plt_qty, cargo_note, requested_by, updated_by, orderer, tote, tote_qty)
  values ('center', 'requested', 'store', coalesce((p ->> 'run_date')::date, current_date + 1), nullif(p ->> 'slot', ''), s, dst, '상온', nullif(p ->> 'plt', '')::numeric,
          left('토트박스 회수 ' || q || '개' || coalesce(' · ' || nullif(trim(p ->> 'note'), ''), ''), 300), 'store:' || s || coalesce(' ' || nullif(trim(p ->> 'who'), ''), ''), 'store:' || s, s, true, q)
  returning id into nid;
  begin perform kk_notify(array['store:' || dst], '토트박스 회수 · ' || s, q || '개 → ' || dst || ' · ' || to_char(coalesce((p ->> 'run_date')::date, current_date + 1), 'MM/DD'), '?g='); exception when others then null; end;
  return nid;
end $$;
create or replace function store_cancel(p_store text, p_pin text, p_id bigint)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin);
begin
  if exists (select 1 from dispatches where id = p_id and type <> 'delivery' and not tote and (origin <> 'store' or orderer is not null)) then raise exception '센터가 올린 출고 요청은 매장에서 취소할 수 없습니다 — 진천센터 · 본사에 연락해 주세요'; end if;
  update dispatches set status = 'canceled', updated_by = 'store:' || s
   where id = p_id and status = 'requested' and ((type = 'delivery' and from_place = s) or (tote and origin = 'store' and from_place = s) or (type <> 'delivery' and origin = 'store' and orderer is null and to_place = s));
  if not found then raise exception '배차가 이미 잡힌 건은 더한물류 · 본사에 연락해 주세요'; end if;
end $$;
create or replace function store_list(p_store text, p_pin text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin);
begin
  return query
    select jsonb_build_object('id', d.id, 'status', d.status, 'run_date', d.run_date, 'created_at', d.created_at,
             'type', d.type, 'from_place', d.from_place, 'to_place', d.to_place, 'plt_qty', d.plt_qty, 'time_slot', d.time_slot, 'temp', d.temp, 'cargo_note', d.cargo_note, 'origin', d.origin, 'requested_by', d.requested_by,
             'vehicle_ton', d.vehicle_ton, 'vehicle_body', d.vehicle_body,
             'driver_name', d.driver_name, 'driver_phone', d.driver_phone, 'vehicle_no', d.vehicle_no,
             'vendor', (select name from vendors v where v.id = d.vendor_id), 'received_at', d.received_at, 'received_by', d.received_by, 'orderer', d.orderer, 'tote', d.tote, 'tote_qty', d.tote_qty, 'center_ok_at', d.center_ok_at, 'center_ok_by', d.center_ok_by,
             'receipts', (select count(*) from attachments a where a.dispatch_id = d.id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'note', e.note) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id),
             'delivery', (select to_jsonb(x) - 'dispatch_id' from dispatch_delivery x where x.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null and ((d.type = 'delivery' and d.from_place = s) or (d.type <> 'delivery' and d.to_place = s)
                                  or (d.origin = 'store' and d.tote and d.from_place = s))   -- b37: 우리 매장 토트박스 회수 요청   -- 우리 매장 고객배송 + 우리 매장으로 오는 쿠팡 · 센터 출고
       and coalesce(d.created_at, now()) >= now() - interval '90 days'
     order by d.id desc;
end $$;


revoke all on function store_info(text,text), store_mgr_fresh(text,text,text,text,boolean), tote_request(text,text,jsonb) from public;
grant execute on function store_info(text,text), store_mgr_fresh(text,text,text,text,boolean), tote_request(text,text,jsonb) to anon, authenticated;
select 'b37ok-' || count(*) from pg_proc where proname in ('store_info','store_mgr_fresh','tote_request');

-- b37-b — 토트박스 회수: 신선 매장 목록은 자주 바뀌므로 전 매장에서 요청 가능 · 회수지는 콜드체인센터
create or replace function tote_request(p_store text, p_pin text, p jsonb) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin); q int := nullif(p ->> 'qty', '')::int; dst text := coalesce(nullif(trim(p ->> 'to'), ''), '콜드체인센터'); nid bigint;
begin
  if q is null or q < 1 or q > 5000 then raise exception '토트박스 수량을 넣어 주세요'; end if;
  insert into dispatches(type, status, origin, run_date, time_slot, from_place, to_place, temp, plt_qty, cargo_note, requested_by, updated_by, orderer, tote, tote_qty)
  values ('center', 'requested', 'store', coalesce((p ->> 'run_date')::date, current_date + 1), nullif(p ->> 'slot', ''), s, dst, '상온', nullif(p ->> 'plt', '')::numeric,
          left('토트박스 회수 ' || q || '개' || coalesce(' · ' || nullif(trim(p ->> 'note'), ''), ''), 300), 'store:' || s || coalesce(' ' || nullif(trim(p ->> 'who'), ''), ''), 'store:' || s, s, true, q)
  returning id into nid;
  begin perform kk_notify(array['store:' || dst], '토트박스 회수 · ' || s, q || '개 → ' || dst || ' · ' || to_char(coalesce((p ->> 'run_date')::date, current_date + 1), 'MM/DD'), '?g='); exception when others then null; end;
  return nid;
end $$;
select 'b37b-' || (position('콜드체인센터' in prosrc) > 0)::text from pg_proc where proname = 'tote_request';

-- ===================================================================
-- b38 — 매장 요청(고객 배송 · 토트박스 회수) 수정 · 삭제 — 매장 ↔ 더한물류 서로 알림, 기록은 남김(삭제도 '삭제됨'으로 보임)
-- ===================================================================
create or replace function store_req_edit(p_store text, p_pin text, p_id bigint, p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin); d dispatches; chg text := ''; q int := nullif(p ->> 'qty', '')::int; x jsonb := p -> 'delivery';
begin
  select * into d from dispatches where id = p_id and deleted_at is null and origin = 'store' and from_place = s and (type = 'delivery' or tote);
  if d.id is null then raise exception '우리 매장이 올린 고객 배송 · 토트박스 회수 요청만 고칠 수 있습니다'; end if;
  if d.status in ('done', 'checked', 'confirmed', 'canceled') then raise exception '끝났거나 취소된 요청은 고칠 수 없습니다 — 더한물류에 연락해 주세요'; end if;
  if p ? 'run_date' and (p ->> 'run_date')::date is distinct from d.run_date then chg := chg || ' 날짜 ' || to_char(d.run_date, 'MM/DD') || '→' || to_char((p ->> 'run_date')::date, 'MM/DD'); end if;
  if p ? 'slot' and nullif(p ->> 'slot', '') is distinct from d.time_slot then chg := chg || ' 시간 ' || coalesce(nullif(p ->> 'slot', ''), '무관'); end if;
  if d.tote and q is not null and q is distinct from d.tote_qty then chg := chg || ' 수량 ' || coalesce(d.tote_qty::text, '?') || '→' || q || '개'; end if;
  if x is not null and exists (select 1 from dispatch_delivery z where z.dispatch_id = p_id and exists (select 1 from jsonb_each_text(x) e where e.key in ('customer_name', 'customer_phone', 'address', 'product', 'qty', 'request_note')
       and coalesce(e.value, '') is distinct from coalesce(to_jsonb(z) ->> e.key, ''))) then chg := chg || ' 배송 정보'; end if;
  if d.tote and p ? 'note' and coalesce(trim(p ->> 'note'), '') is distinct from regexp_replace(coalesce(d.cargo_note, ''), '^토트박스 회수 \d+개( · )?', '') then chg := chg || ' 특이사항'; end if;
  perform set_config('kk.actor', 'store:' || s, true);
  update dispatches set run_date = coalesce((p ->> 'run_date')::date, run_date),
         time_slot = case when p ? 'slot' then nullif(p ->> 'slot', '') else time_slot end,
         plt_qty = case when p ? 'plt' then nullif(p ->> 'plt', '')::numeric else plt_qty end,
         tote_qty = case when tote and q is not null then q else tote_qty end,
         cargo_note = case when tote and p ? 'note' then left('토트박스 회수 ' || coalesce(q, tote_qty) || '개' || coalesce(' · ' || nullif(trim(p ->> 'note'), ''), ''), 300)
                           when tote and q is not null then regexp_replace(coalesce(cargo_note, '토트박스 회수 0개'), '^토트박스 회수 \d+개', '토트박스 회수 ' || q || '개')
                           when p ? 'note' then left(p ->> 'note', 300) else cargo_note end,
         updated_by = 'store:' || s
   where id = p_id;
  if d.type = 'delivery' and x is not null then
    update dispatch_delivery set customer_name = coalesce(x ->> 'customer_name', customer_name), customer_phone = coalesce(x ->> 'customer_phone', customer_phone),
           address = coalesce(x ->> 'address', address), product = coalesce(x ->> 'product', product), qty = coalesce(x ->> 'qty', qty), request_note = coalesce(x ->> 'request_note', request_note)
     where dispatch_id = p_id;
  end if;
  insert into dispatch_events(dispatch_id, by, kind, note) values (p_id, 'store:' || s, 'change', left('매장 수정:' || coalesce(nullif(chg, ''), ' 내용'), 200));   -- → 더한물류에 '배차 변경' 알림
end $$;
create or replace function store_req_delete(p_store text, p_pin text, p_id bigint, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin); d dispatches; vn text;
begin
  select * into d from dispatches where id = p_id and deleted_at is null and origin = 'store' and from_place = s and (type = 'delivery' or tote);
  if d.id is null then raise exception '우리 매장이 올린 고객 배송 · 토트박스 회수 요청만 지울 수 있습니다'; end if;
  if d.status in ('done', 'checked', 'confirmed') then raise exception '운행이 끝난 요청은 지울 수 없습니다 — 더한물류 · 본사에 연락해 주세요'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception '삭제 사유를 넣어 주세요'; end if;
  perform set_config('kk.actor', 'store:' || s, true);
  perform set_config('kk.skip_track', '1', true);
  update dispatches set deleted_at = now(), deleted_by = 'store:' || s, delete_reason = left(trim(p_reason), 200), updated_by = 'store:' || s where id = p_id;
  perform set_config('kk.skip_track', '', true);
  select 'vendor:' || name into vn from vendors where id = d.vendor_id;
  begin perform kk_notify(array[coalesce(vn, 'vendor:*'), 'staff'], '매장이 요청을 삭제했습니다 · ' || s,
    '#' || d.id || ' ' || case when d.tote then '토트박스 회수' else '고객 배송' end || ' ' || to_char(d.run_date, 'MM/DD')
      || case when coalesce(d.driver_name, '') <> '' then ' · 배정 기사 ' || d.driver_name || ' 확인 필요' else '' end || ' · 사유: ' || left(trim(p_reason), 60), '?v=');
  exception when others then null; end;
end $$;
-- 더한물류가 매장 요청 내용 고치기(날짜 · 시간 · 수량 · 특이사항) → 매장에 알림
create or replace function vendor_req_edit(p_vendor text, p_pin text, p_id bigint, p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin); d dispatches; chg text := ''; q int := nullif(p ->> 'qty', '')::int;
begin
  select * into d from dispatches where id = p_id and deleted_at is null and origin = 'store' and (type = 'delivery' or tote);
  if d.id is null then raise exception '매장 요청(고객 배송 · 토트박스 회수)만 여기서 고칠 수 있습니다'; end if;
  if d.vendor_id is not null and d.vendor_id <> v then raise exception '다른 업체의 배차입니다'; end if;
  if d.status in ('checked', 'confirmed') then raise exception '확인 · 정산된 건은 고칠 수 없습니다'; end if;
  if p ? 'run_date' and (p ->> 'run_date')::date is distinct from d.run_date then chg := chg || ' 날짜 ' || to_char(d.run_date, 'MM/DD') || '→' || to_char((p ->> 'run_date')::date, 'MM/DD'); end if;
  if p ? 'slot' and nullif(p ->> 'slot', '') is distinct from d.time_slot then chg := chg || ' 시간 ' || coalesce(nullif(p ->> 'slot', ''), '무관'); end if;
  if d.tote and q is not null and q is distinct from d.tote_qty then chg := chg || ' 수량 ' || coalesce(d.tote_qty::text, '?') || '→' || q || '개'; end if;
  if coalesce(trim(p ->> 'msg'), '') <> '' then chg := chg || ' · ' || left(trim(p ->> 'msg'), 80); end if;
  perform set_config('kk.actor', 'vendor:' || p_vendor, true);
  update dispatches set run_date = coalesce((p ->> 'run_date')::date, run_date),
         time_slot = case when p ? 'slot' then nullif(p ->> 'slot', '') else time_slot end,
         tote_qty = case when tote and q is not null then q else tote_qty end,
         cargo_note = case when tote and q is not null then regexp_replace(cargo_note, '^토트박스 회수 \d+개', '토트박스 회수 ' || q || '개') else cargo_note end,
         updated_by = 'vendor:' || p_vendor
   where id = p_id;
  insert into dispatch_events(dispatch_id, by, kind, note) values (p_id, 'vendor:' || p_vendor, 'change', left('더한물류 수정:' || coalesce(nullif(chg, ''), ' 내용'), 200));
  begin perform kk_notify(array['store:' || d.from_place], '더한물류가 요청을 고쳤습니다 · ' || case when d.tote then '토트박스 회수' else '고객 배송' end,
    '#' || d.id || coalesce(chg, ''), '?s='); exception when others then null; end;
end $$;
create or replace function vendor_delete(p_vendor text, p_pin text, p_ids bigint[], p_reason text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin); n int; bad int; r dispatches;
begin
  -- b33: 삭제 권한이 없어도, 더한물류가 직접 등록한(붙여넣기 · 사진) 입력 대기 요청은 7일 안에 지울 수 있음
  if not coalesce((select can_delete from vendors where id = v), false)
     and exists (select 1 from dispatches where id = any(p_ids) and deleted_at is null
                  and not (origin = 'kingkong' and vendor_id = v and updated_by = 'vendor:' || p_vendor and created_at > now() - interval '7 days')) then
    raise exception '삭제 권한이 없습니다 — 직접 등록한 요청만 지울 수 있습니다(다른 건은 킹콩 본사에 요청)'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception '삭제 사유를 넣어 주세요'; end if;
  select count(*) into bad from dispatches where id = any(p_ids) and deleted_at is null
     and ((vendor_id is not null and vendor_id <> v)
          or ((status <> 'requested' or coalesce(driver_name, '') <> '')
              and not (origin = 'store' and status in ('requested', 'assigned'))));   -- b38: 매장 요청은 기사 배정 뒤에도(운행 전) 지울 수 있음
  if bad > 0 then raise exception '입력 대기(기사 · 차량 없는 배차 요청) 건만 지울 수 있습니다'; end if;
  perform set_config('kk.actor', 'vendor:' || p_vendor, true);
  perform set_config('kk.no_notify', '1', true);
  perform set_config('kk.skip_track', '1', true);
  update dispatches set deleted_at = now(), deleted_by = 'vendor:' || p_vendor, delete_reason = trim(p_reason), updated_by = 'vendor:' || p_vendor
   where id = any(p_ids) and deleted_at is null;
  get diagnostics n = row_count;
  perform set_config('kk.no_notify', '', true);
  if n > 0 then perform kk_notify(array['staff'], '입력 대기 건 삭제 · ' || p_vendor, n || '건 · ' || left(trim(p_reason), 60), '#setup'); end if;
  -- b38: 매장이 올린 요청(고객 배송 · 토트박스 회수)을 더한물류가 지우면 그 매장에 알림
  for r in select * from dispatches where id = any(p_ids) and origin = 'store' and deleted_by = 'vendor:' || p_vendor loop
    begin perform kk_notify(array['store:' || r.from_place], '더한물류가 요청을 삭제했습니다 · ' || case when r.tote then '토트박스 회수' else '고객 배송' end,
      '#' || r.id || ' ' || to_char(r.run_date, 'MM/DD') || ' · 사유: ' || left(trim(p_reason), 60), '?s='); exception when others then null; end;
  end loop;
  return n;
end $$;
-- b38: 매장이 올린 요청은 지워져도 '삭제됨 · 사유'로 기록이 남아 보임
create or replace function store_list(p_store text, p_pin text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin);
begin
  return query
    select jsonb_build_object('id', d.id, 'status', d.status, 'run_date', d.run_date, 'created_at', d.created_at,
             'type', d.type, 'from_place', d.from_place, 'to_place', d.to_place, 'plt_qty', d.plt_qty, 'time_slot', d.time_slot, 'temp', d.temp, 'cargo_note', d.cargo_note, 'origin', d.origin, 'requested_by', d.requested_by,
             'vehicle_ton', d.vehicle_ton, 'vehicle_body', d.vehicle_body,
             'driver_name', d.driver_name, 'driver_phone', d.driver_phone, 'vehicle_no', d.vehicle_no,
             'vendor', (select name from vendors v where v.id = d.vendor_id), 'received_at', d.received_at, 'received_by', d.received_by, 'orderer', d.orderer, 'tote', d.tote, 'tote_qty', d.tote_qty, 'center_ok_at', d.center_ok_at, 'deleted_at', d.deleted_at, 'deleted_by', d.deleted_by, 'delete_reason', d.delete_reason, 'center_ok_by', d.center_ok_by,
             'receipts', (select count(*) from attachments a where a.dispatch_id = d.id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'note', e.note) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id),
             'delivery', (select to_jsonb(x) - 'dispatch_id' from dispatch_delivery x where x.dispatch_id = d.id))
      from dispatches d
     where (d.deleted_at is null or (d.origin = 'store' and d.from_place = s and (d.type = 'delivery' or d.tote))) and ((d.type = 'delivery' and d.from_place = s) or (d.type <> 'delivery' and d.to_place = s)
                                  or (d.origin = 'store' and d.tote and d.from_place = s))   -- b37: 우리 매장 토트박스 회수 요청   -- 우리 매장 고객배송 + 우리 매장으로 오는 쿠팡 · 센터 출고
       and coalesce(d.created_at, now()) >= now() - interval '90 days'
     order by d.id desc;
end $$;
-- b38: 입고사진 공유 — 올린 매장이 고치고 지움(센터에 알림), 센터가 지우면 매장에 알림
create or replace function rcv_edit(p_store text, p_pin text, p_id bigint, p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare a text := rcv_actor('store', p_store, p_pin); r rcv_reports; ph jsonb := p -> 'photos'; x jsonb;
begin
  select * into r from rcv_reports where id = p_id and deleted_at is null and store = p_store;
  if r.id is null then raise exception '우리 매장이 올린 입고사진만 고칠 수 있습니다'; end if;
  if ph is not null then
    if jsonb_typeof(ph) <> 'array' or jsonb_array_length(ph) = 0 then raise exception '사진을 한 장 이상 남겨 주세요'; end if;
    if jsonb_array_length(ph) > 12 then raise exception '사진은 12장까지입니다'; end if;
    for x in select * from jsonb_array_elements(ph) loop if length(x #>> '{}') > 400000 then raise exception '사진이 너무 큽니다'; end if; end loop;
  end if;
  update rcv_reports set rcv_date = coalesce((p ->> 'rcv_date')::date, rcv_date),
         cate = case when p ? 'cate' then left(p ->> 'cate', 30) else cate end,
         plt_qty = case when p ? 'plt_qty' then nullif(p ->> 'plt_qty', '')::int else plt_qty end,
         memo = case when p ? 'memo' then left(p ->> 'memo', 300) else memo end,
         plt_nos = case when p ? 'plt_nos' then coalesce((select array_agg(left(v, 60)) from jsonb_array_elements_text(p -> 'plt_nos') v), '{}') else plt_nos end,
         photos = coalesce(ph, photos), n_photos = coalesce(jsonb_array_length(ph), n_photos),
         seen_at = null, seen_by = null   -- 고치면 센터가 다시 확인
   where id = p_id;
  begin perform kk_notify(array['store:' || r.center], '입고사진 수정 · ' || p_store, '#' || p_id || ' ' || coalesce(p ->> 'cate', r.cate, '') || ' ' || coalesce(p ->> 'plt_qty', r.plt_qty::text, '?') || 'PLT', '?g=');
  exception when others then null; end;
end $$;
create or replace function rcv_delete(p_kind text, p_name text, p_pin text, p_id bigint) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare a text := rcv_actor(p_kind, p_name, p_pin); r rcv_reports;
begin
  select * into r from rcv_reports where id = p_id and deleted_at is null and (p_kind = 'staff' or (p_kind = 'store' and store = p_name) or (p_kind = 'center' and center = p_name));
  if r.id is null then return; end if;
  update rcv_reports set deleted_at = now(), deleted_by = a, photos = '[]' where id = p_id;   -- 지우면 사진도 바로 지움
  begin
    if p_kind = 'store' then perform kk_notify(array['store:' || r.center], '입고사진 삭제 · ' || r.store, '#' || p_id || ' ' || coalesce(r.cate, '') || ' ' || to_char(r.rcv_date, 'MM/DD'), '?g=');
    else perform kk_notify(array['store:' || r.store], '입고사진이 삭제됐습니다 · ' || p_name, '#' || p_id || ' ' || coalesce(r.cate, '') || ' ' || to_char(r.rcv_date, 'MM/DD') || ' — 필요하면 다시 올려 주세요', '?s='); end if;
  exception when others then null; end;
end $$;
revoke all on function store_req_edit(text,text,bigint,jsonb), store_req_delete(text,text,bigint,text), vendor_req_edit(text,text,bigint,jsonb), rcv_edit(text,text,bigint,jsonb) from public;
grant execute on function store_req_edit(text,text,bigint,jsonb), store_req_delete(text,text,bigint,text), vendor_req_edit(text,text,bigint,jsonb), rcv_edit(text,text,bigint,jsonb), rcv_delete(text,text,text,bigint), store_list(text,text), vendor_delete(text,text,bigint[],text) to anon, authenticated;
select 'b38ok-' || count(*) as r from pg_proc where proname in ('store_req_edit','store_req_delete','vendor_req_edit','rcv_edit');

-- ===================================================================
-- b39 — 보관 삭제(권한자): 개선 요청 글 · 답글, 배차 질문 · 답변을 목록에서 치우되 원본은 kk_trash 에 그대로 보관 → 설정 › 휴지통에서 되살리기
--   누가 · 언제 · 왜 지웠는지 남음. 삭제 권한자(staff.can_delete)만.
-- ===================================================================
create table if not exists kk_trash (
  id          bigint generated always as identity primary key,
  kind        text not null,        -- feedback · feedback_reply · comment
  ref_id      bigint not null,      -- feedback.id · dispatch_comments.id
  parent_id   bigint,               -- 답글: feedback.id / 질문: dispatch_id
  title       text,                 -- 목록에 보일 한 줄
  data        jsonb not null,       -- 지운 원본 그대로
  reason      text,
  deleted_by  text, deleted_at timestamptz not null default now(),
  restored_at timestamptz, restored_by text
);
create index if not exists kk_trash_at on kk_trash (deleted_at desc);
alter table kk_trash enable row level security;
drop policy if exists staff_read on kk_trash;
create policy staff_read on kk_trash for select to authenticated using (is_staff());
create or replace function kk_trash_put(p_kind text, p_id bigint, p_sub int, p_reason text) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare me text := coalesce(auth.jwt() ->> 'email', 'staff'); f feedback; c dispatch_comments; r jsonb; nid bigint;
begin
  if not staff_can_delete() then raise exception '삭제 권한이 없습니다(설정 › 삭제 권한자)'; end if;
  if p_kind = 'feedback' then
    select * into f from feedback where id = p_id; if f.id is null then raise exception '이미 지워졌습니다'; end if;
    insert into kk_trash(kind, ref_id, title, data, reason, deleted_by)
    values ('feedback', f.id, '개선 요청 #' || f.id || ' · ' || coalesce(f.src_name, f.who, '') || ' · ' || left(f.body, 60), to_jsonb(f), left(p_reason, 200), me) returning id into nid;
    delete from feedback where id = p_id;
  elsif p_kind = 'feedback_reply' then
    select * into f from feedback where id = p_id; if f.id is null then raise exception '요청 글이 없습니다'; end if;
    r := f.replies -> p_sub; if r is null then raise exception '이미 지워졌습니다'; end if;
    insert into kk_trash(kind, ref_id, parent_id, title, data, reason, deleted_by)
    values ('feedback_reply', f.id, f.id, '개선 요청 #' || f.id || ' 답글 · ' || left(r ->> 'body', 60), r, left(p_reason, 200), me) returning id into nid;
    update feedback set replies = replies - p_sub where id = p_id;
  elsif p_kind = 'comment' then
    select * into c from dispatch_comments where id = p_id; if c.id is null then raise exception '이미 지워졌습니다'; end if;
    insert into kk_trash(kind, ref_id, parent_id, title, data, reason, deleted_by)
    values ('comment', c.id, c.dispatch_id, '배차 #' || c.dispatch_id || ' ' || case when c.kind = 'answer' then '답변' else '질문' end || ' · ' || left(c.body, 60), to_jsonb(c), left(p_reason, 200), me) returning id into nid;
    delete from dispatch_comments where id = p_id;
  else raise exception '지울 수 없는 종류입니다'; end if;
  return nid;
end $$;
create or replace function kk_trash_restore(p_id bigint) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare me text := coalesce(auth.jwt() ->> 'email', 'staff'); t kk_trash;
begin
  if not staff_can_delete() then raise exception '되살리기 권한이 없습니다'; end if;
  select * into t from kk_trash where id = p_id and restored_at is null; if t.id is null then raise exception '이미 되살렸거나 없는 기록입니다'; end if;
  perform set_config('kk.no_notify', '1', true);   -- 되살릴 때는 알림을 다시 보내지 않음
  if t.kind = 'feedback' then
    insert into feedback overriding system value select * from jsonb_populate_record(null::feedback, t.data) on conflict (id) do nothing;
  elsif t.kind = 'feedback_reply' then
    update feedback set replies = (select coalesce(jsonb_agg(e order by e ->> 'at'), '[]') from jsonb_array_elements(replies || jsonb_build_array(t.data)) e) where id = t.parent_id;
    if not found then raise exception '요청 글이 지워져 있습니다 — 요청 글부터 되살려 주세요'; end if;
  elsif t.kind = 'comment' then
    if not exists (select 1 from dispatches where id = t.parent_id) then raise exception '배차 건이 없습니다'; end if;
    insert into dispatch_comments overriding system value select * from jsonb_populate_record(null::dispatch_comments, t.data) on conflict (id) do nothing;
    update dispatch_comments set at = (t.data ->> 'at')::timestamptz, author = t.data ->> 'author' where id = t.ref_id;   -- 입력 트리거가 바꾼 시각 · 작성자를 원래대로
  end if;
  update kk_trash set restored_at = now(), restored_by = me where id = p_id;
  perform set_config('kk.no_notify', '', true);
end $$;
revoke all on function kk_trash_put(text,bigint,int,text), kk_trash_restore(bigint) from public;
grant execute on function kk_trash_put(text,bigint,int,text), kk_trash_restore(bigint) to authenticated;
select 'b39ok-' || count(*) as r from pg_proc where proname in ('kk_trash_put','kk_trash_restore');

-- ===================================================================
-- b40 — 사진 모아보기(카톡 사진첩처럼): 매장 입고사진 · 센터 출고 PLT 사진을 날짜별 격자로, 누르면 크게, 골라서 삭제
-- ===================================================================
create or replace function rcv_gallery(p_kind text, p_name text, p_pin text, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform rcv_actor(p_kind, p_name, p_pin);
  if p_to - p_from > 62 then raise exception '기간이 너무 깁니다'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'store', r.store, 'center', r.center, 'rcv_date', r.rcv_date, 'cate', r.cate, 'plt_qty', r.plt_qty,
                                                       'memo', r.memo, 'created_at', r.created_at, 'photos', r.photos) order by r.rcv_date desc, r.created_at desc)
    from rcv_reports r where r.deleted_at is null and r.n_photos > 0 and r.rcv_date between p_from and p_to
      and (p_kind = 'staff' or (p_kind = 'store' and r.store = p_name) or (p_kind = 'center' and r.center = p_name))), '[]');
end $$;
-- 사진 골라 지우기: p_items = [{id, idx}] — 매장은 자기 매장 것, 센터는 자기 센터로 온 것. 상대에게 알림 한 번
create or replace function rcv_photo_del(p_kind text, p_name text, p_pin text, p_items jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare a text := rcv_actor(p_kind, p_name, p_pin); r rcv_reports; ids bigint[]; ix int[]; n int := 0; tg text[] := '{}'; k bigint;
begin
  select array_agg(distinct (e ->> 'id')::bigint) into ids from jsonb_array_elements(p_items) e;
  foreach k in array coalesce(ids, '{}') loop
    select * into r from rcv_reports where id = k and deleted_at is null and (p_kind = 'staff' or (p_kind = 'store' and store = p_name) or (p_kind = 'center' and center = p_name));
    continue when r.id is null;
    select array_agg((e ->> 'idx')::int) into ix from jsonb_array_elements(p_items) e where (e ->> 'id')::bigint = k;
    update rcv_reports set photos = coalesce((select jsonb_agg(x.v order by x.o) from jsonb_array_elements(photos) with ordinality x(v, o) where (x.o - 1) <> all(ix)), '[]')
     where id = k;
    update rcv_reports set n_photos = jsonb_array_length(photos) where id = k;
    n := n + coalesce(array_length(ix, 1), 0);
    tg := tg || case when p_kind = 'store' then 'store:' || r.center else 'store:' || r.store end;
  end loop;
  if n > 0 then begin perform kk_notify(array(select distinct unnest(tg)), '입고사진 ' || n || '장 삭제 · ' || coalesce(nullif(p_name, ''), '본사'), '지운 사진은 되살릴 수 없습니다', case when p_kind = 'store' then '?g=' else '?s=' end);
  exception when others then null; end; end if;
  return n;
end $$;
create or replace function plt_gallery(p_kind text, p_name text, p_pin text, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform plt_actor(p_kind, p_name, p_pin);
  if p_to - p_from > 62 then raise exception '기간이 너무 깁니다'; end if;
  -- 같은 사진에서 읽힌 줄은 사진 하나로 묶음
  return coalesce((select jsonb_agg(jsonb_build_object('ids', g.ids, 'out_date', g.out_date, 'stores', g.stores, 'nos', g.nos, 'created_at', g.at, 'photo', g.photo) order by g.out_date desc, g.at desc)
    from (select md5(photo) h, min(photo) photo, max(out_date) out_date, min(created_at) at, array_agg(id order by seq, id) ids,
                 array_agg(distinct store) stores, array_agg(coalesce(nullif(plt_no, ''), remark) order by seq, id) nos
            from plt_out where deleted_at is null and photo is not null and out_date between p_from and p_to and (p_kind <> 'center' or center = p_name)
           group by md5(photo)) g), '[]');
end $$;
create or replace function plt_photo_del(p_kind text, p_name text, p_pin text, p_ids bigint[]) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare a text := plt_actor(p_kind, p_name, p_pin); n int;
begin
  update plt_out set photo = null, updated_by = a, updated_at = now() where id = any(p_ids) and deleted_at is null and photo is not null and (p_kind <> 'center' or center = p_name);
  get diagnostics n = row_count; return n;
end $$;
revoke all on function rcv_gallery(text,text,text,date,date), rcv_photo_del(text,text,text,jsonb), plt_gallery(text,text,text,date,date), plt_photo_del(text,text,text,bigint[]) from public;
grant execute on function rcv_gallery(text,text,text,date,date), rcv_photo_del(text,text,text,jsonb), plt_gallery(text,text,text,date,date), plt_photo_del(text,text,text,bigint[]) to anon, authenticated;
select 'b40ok-' || count(*) as r from pg_proc where proname in ('rcv_gallery','rcv_photo_del','plt_gallery','plt_photo_del');

-- ===================================================================
-- b41 — PIN 관리(본사 설정, 삭제 권한자만): 센터 · 더한물류 · 확인 담당자 · 전 매장 PIN 보기 · 바꾸기
--   로그인 확인은 지금처럼 pin_hash(되돌릴 수 없음). 볼 수 있도록 pin_enc 에 암호화(pgp_sym_encrypt)해서 따로 보관 — 키는 app_config(앱에서 못 읽음)
--   이 기능 전에 정한 PIN은 원래 숫자를 알 수 없음 → '모름'으로 보이고, 한 번 바꾸면 그다음부터 보임
-- ===================================================================
alter table stores   add column if not exists pin_enc bytea;
alter table vendors  add column if not exists pin_enc bytea;
alter table checkers add column if not exists pin_enc bytea;
insert into app_config(key, value) values ('pin_key', encode(extensions.gen_random_bytes(32), 'hex')) on conflict (key) do nothing;
create or replace function kk_pin_enc(p text) returns bytea language sql security definer set search_path = public, extensions as $$
  select case when coalesce(p, '') = '' then null else pgp_sym_encrypt(p, (select value from app_config where key = 'pin_key')) end;
$$;
create or replace function kk_pin_dec(b bytea) returns text language sql security definer set search_path = public, extensions as $$
  select case when b is null then null else pgp_sym_decrypt(b, (select value from app_config where key = 'pin_key')) end;
$$;
revoke all on function kk_pin_enc(text), kk_pin_dec(bytea) from public, anon, authenticated;
-- 매장 관리(진천센터 · 본사)에서 PIN을 넣으면 같이 암호화 보관, 다른 길로 PIN이 바뀌면 '모름'
create or replace function stores_pin_enc() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'INSERT' or new.pin_hash is distinct from old.pin_hash then
    new.pin_enc := case when coalesce(current_setting('kk.newpin', true), '') <> '' and new.pin_hash = crypt(current_setting('kk.newpin', true), new.pin_hash)
                        then kk_pin_enc(current_setting('kk.newpin', true)) else null end;
  end if;
  return new;
end $$;
drop trigger if exists trg_stores_pin_enc on stores;
create trigger trg_stores_pin_enc before insert or update of pin_hash on stores for each row execute function stores_pin_enc();
create or replace function store_mgr_save(p_kind text, p_name text, p_pin text, p_store text, p_new_pin text, p_open boolean, p_active boolean default true) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a text := store_mgr_actor(p_kind, p_name, p_pin); s text := trim(coalesce(p_store, '')); ex stores;
begin
  perform set_config('kk.actor', a, true);
  perform set_config('kk.newpin', coalesce(p_new_pin, ''), true);   -- b41: 본사 PIN 관리에서 볼 수 있게(암호화 보관)
  if s !~ '^[가-힣A-Za-z0-9()\-]{2,20}$' then raise exception '매장 이름은 2~20자(한글 · 영문 · 숫자)로 넣어 주세요'; end if;
  if p_new_pin is not null and p_new_pin <> '' and p_new_pin !~ '^\d{4,8}$' then raise exception 'PIN은 숫자 4~8자리로 넣어 주세요'; end if;
  select * into ex from stores where name = s;
  if ex.id is not null and ex.kind <> 'store' then raise exception '센터 계정은 여기서 바꿀 수 없습니다'; end if;
  if ex.id is null then
    if coalesce(p_new_pin, '') = '' then raise exception '새 매장은 PIN이 필요합니다'; end if;
    insert into stores(name, kind, pin_hash, active, app_open, created_by, updated_at) values (s, 'store', crypt(p_new_pin, gen_salt('bf')), true, coalesce(p_open, true), a, now());
  elsif ex.deleted_at is not null then   -- 지운 매장을 같은 이름으로 다시 만들면 되살림
    if coalesce(p_new_pin, '') = '' then raise exception '새 매장은 PIN이 필요합니다'; end if;
    update stores set pin_hash = crypt(p_new_pin, gen_salt('bf')), active = true, app_open = coalesce(p_open, true), deleted_at = null, deleted_by = null, delete_reason = null, updated_at = now() where id = ex.id;
  else
    update stores set pin_hash = case when coalesce(p_new_pin, '') <> '' then crypt(p_new_pin, gen_salt('bf')) else pin_hash end,
                      app_open = coalesce(p_open, app_open), active = coalesce(p_active, active), updated_at = now() where id = ex.id;
  end if;
  if p_kind = 'center' then perform kk_notify(array['staff'], '매장 계정 ' || case when ex.id is null then '생성' else '변경' end || ' · ' || s, p_name || case when coalesce(p_new_pin, '') <> '' then ' · PIN 설정' else '' end, '#setup'); end if;
  return jsonb_build_object('name', s, 'created', ex.id is null);
end $$;
-- 암호화된 PIN(pin_enc)은 수정 기록에 남기지 않음
create or replace function audit_row() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  d jsonb := '{}'; k text;
  skip text[] := array['updated_at','updated_by','settle_month','billed_amount','rate_fare','pin_hash','pin_enc','data','created_at'];
  who text; rid text; did bigint;
begin
  who := coalesce(nullif(auth.jwt() ->> 'email', ''), nullif(current_setting('kk.actor', true), ''), n ->> 'updated_by', o ->> 'updated_by', n ->> 'author', n ->> 'by', current_user);
  rid := coalesce(n ->> 'id', o ->> 'id', n ->> 'dispatch_id', o ->> 'dispatch_id');
  did := case when tg_table_name = 'dispatches' then rid::bigint else nullif(coalesce(n ->> 'dispatch_id', o ->> 'dispatch_id'), '')::bigint end;
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(n) loop
      if not (k = any(skip)) and (o -> k) is distinct from (n -> k) then d := d || jsonb_build_object(k, jsonb_build_array(o -> k, n -> k)); end if;
    end loop;
    if (o ? 'pin_hash') and (o ->> 'pin_hash') is distinct from (n ->> 'pin_hash') then d := d || '{"PIN": ["****", "변경"]}'; end if;
    if d = '{}' then return new; end if;
  elsif tg_op = 'INSERT' then d := n - skip;
  else d := o - skip; end if;
  insert into audit_log(table_name, row_id, dispatch_id, actor, action, diff) values (tg_table_name, rid, did, who, lower(tg_op), d);
  return coalesce(new, old);
end $$;
create or replace function kk_pins_list() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not staff_can_delete() then raise exception 'PIN은 삭제 권한자만 볼 수 있습니다'; end if;
  return coalesce((select jsonb_agg(x order by x ->> 'ord', x ->> 'name') from (
      select jsonb_build_object('kind', case when kind = 'center' then 'center' else 'store' end, 'ord', case when kind = 'center' then '1' else '4' end, 'name', name,
             'active', active and deleted_at is null, 'pin', kk_pin_dec(pin_enc), 'updated_at', updated_at) x from stores where deleted_at is null
      union all select jsonb_build_object('kind', 'vendor', 'ord', '2', 'name', name, 'active', active, 'pin', kk_pin_dec(pin_enc)) from vendors
      union all select jsonb_build_object('kind', 'checker', 'ord', '3', 'name', name, 'active', active, 'pin', kk_pin_dec(pin_enc)) from checkers) t), '[]');
end $$;
create or replace function kk_pin_set(p_kind text, p_name text, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare me text := coalesce(auth.jwt() ->> 'email', 'staff'); n int;
begin
  if not staff_can_delete() then raise exception 'PIN은 삭제 권한자만 바꿀 수 있습니다'; end if;
  if coalesce(p_pin, '') !~ '^\d{4,8}$' then raise exception 'PIN은 숫자 4~8자리로 넣어 주세요'; end if;
  perform set_config('kk.actor', me, true);
  perform set_config('kk.newpin', p_pin, true);
  if p_kind in ('store', 'center') then update stores set pin_hash = crypt(p_pin, gen_salt('bf')), updated_at = now() where name = p_name and kind = p_kind and deleted_at is null;
  elsif p_kind = 'vendor' then update vendors set pin_hash = crypt(p_pin, gen_salt('bf')), pin_enc = kk_pin_enc(p_pin) where name = p_name;
  elsif p_kind = 'checker' then update checkers set pin_hash = crypt(p_pin, gen_salt('bf')), pin_enc = kk_pin_enc(p_pin) where name = p_name;
  else raise exception '바꿀 수 없는 종류입니다'; end if;
  get diagnostics n = row_count; if n = 0 then raise exception '해당 이름이 없습니다'; end if;
  perform set_config('kk.newpin', '', true);
end $$;
revoke all on function kk_pins_list(), kk_pin_set(text,text,text) from public, anon;
grant execute on function kk_pins_list(), kk_pin_set(text,text,text) to authenticated;
select 'b41ok-' || count(*) as r from pg_proc where proname in ('kk_pins_list','kk_pin_set','kk_pin_enc','kk_pin_dec','stores_pin_enc');

-- ===================================================================
-- b42 — 토트박스 회수: 콜드체인센터(회수 센터)에도 더한물류와 같은 정보(요청 · 변경 · 취소 · 차량 등록 · 삭제)
-- ===================================================================
create or replace function notify_on_event() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare d dispatches; vn text; route text; tag text; who text := coalesce(to_jsonb(new) ->> 'by', ''); tg text[]; tc text[];
begin
  select * into d from dispatches where id = new.dispatch_id;
  select 'vendor:' || name into vn from vendors where id = d.vendor_id;
  tg := orderer_targets(d.orderer);
  route := format('%s %s→%s%s%s', to_char(d.run_date, 'MM/DD'), d.from_place, case when d.type = 'delivery' then '고객' else d.to_place end,
                  case when d.plt_qty is not null then ' ' || d.plt_qty || 'plt' else '' end, case when coalesce(d.time_slot,'') <> '' then ' ' || d.time_slot else '' end);
  tag := '#' || d.id || ' ';
  -- b42: 토트박스 회수 건은 회수 센터(콜드체인센터)에도 더한물류와 같은 내용으로
  tc := case when d.tote then array['store:' || d.to_place] else '{}'::text[] end;
  if d.tote then route := route || ' · 토트박스 ' || coalesce(d.tote_qty::text, '?') || '개' || coalesce(' · ' || nullif(regexp_replace(coalesce(d.cargo_note, ''), '^토트박스 회수 \d+개( · )?', ''), ''), ''); end if;
  if new.kind = 'request' then
    perform kk_notify(array[coalesce(vn, 'vendor:*')] || case when d.origin = 'store' then array['staff'] else '{}'::text[] end,
                      case when d.tote then '토트박스 회수 요청 · ' else '새 배차 요청 · ' end || coalesce(d.orderer, '킹콩'), tag || route, '?v=');
    if d.tote then perform kk_notify(tc, '토트박스 회수 요청 · ' || coalesce(d.orderer, d.from_place), tag || route, '?g='); end if;
  elsif new.kind = 'cancel' then
    perform kk_notify(array[coalesce(vn, 'vendor:*')] || case when who like 'store:%' then array['staff'] else '{}'::text[] end, '배차 취소', tag || route, '?v=');
    if d.tote then perform kk_notify(tc, '토트박스 회수 취소 · ' || d.from_place, tag || route, '?g='); end if;
  elsif new.kind = 'change' and who not like 'vendor:%' then
    perform kk_notify(array[coalesce(vn, 'vendor:*')], '배차 변경', tag || route || ' · ' || coalesce(new.note, ''), '?v=');
    if d.tote then perform kk_notify(tc, '토트박스 회수 변경 · ' || d.from_place, tag || route || ' · ' || coalesce(new.note, ''), '?g='); end if;
  elsif new.kind = 'change' and d.tote then   -- 더한물류가 고친 토트 회수 건도 센터에
    perform kk_notify(tc, '토트박스 회수 변경 · 더한물류', tag || route || ' · ' || coalesce(new.note, ''), '?g=');
  elsif new.kind in ('cancel_driver', 'return') then
    perform kk_notify(array['staff'] || tg, case when new.kind = 'return' then '회차' else '기사 취소 · 재배차' end, tag || route || ' · ' || coalesce(new.reason, ''), '');
  elsif new.kind in ('assign', 'reassign') then
    if d.tote then perform kk_notify(tc, case when new.kind = 'reassign' then '토트 회수 차량 변경' else '토트 회수 차량 등록' end, tag || route || ' · ' || coalesce(new.driver_name, d.driver_name, '') || ' ' || coalesce(d.driver_phone, '') || ' ' || coalesce(d.vehicle_no, ''), '?g='); end if;
    perform kk_notify(tg, case when new.kind = 'reassign' then '재배차 · 차량 변경' else '차량 등록(배차 완료)' end,
                      tag || route || ' · ' || coalesce(new.driver_name, d.driver_name, '') || ' ' || coalesce(d.vehicle_no, ''),
                      case when tg[1] like 'store:%' then (case when exists(select 1 from stores where name = d.orderer and kind = 'center') then '?g=' else '?s=' end) else '' end);
  end if;
  return new;
end $$;
create or replace function tote_request(p_store text, p_pin text, p jsonb) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin); q int := nullif(p ->> 'qty', '')::int; dst text := coalesce(nullif(trim(p ->> 'to'), ''), '콜드체인센터'); nid bigint;
begin
  if q is null or q < 1 or q > 5000 then raise exception '토트박스 수량을 넣어 주세요'; end if;
  insert into dispatches(type, status, origin, run_date, time_slot, from_place, to_place, temp, plt_qty, cargo_note, requested_by, updated_by, orderer, tote, tote_qty)
  values ('center', 'requested', 'store', coalesce((p ->> 'run_date')::date, current_date + 1), nullif(p ->> 'slot', ''), s, dst, '상온', nullif(p ->> 'plt', '')::numeric,
          left('토트박스 회수 ' || q || '개' || coalesce(' · ' || nullif(trim(p ->> 'note'), ''), ''), 300), 'store:' || s || coalesce(' ' || nullif(trim(p ->> 'who'), ''), ''), 'store:' || s, s, true, q)
  returning id into nid;
  -- b42: 센터 알림은 notify_on_event 가 더한물류와 같은 내용으로 보냄
  return nid;
end $$;
create or replace function store_req_delete(p_store text, p_pin text, p_id bigint, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin); d dispatches; vn text;
begin
  select * into d from dispatches where id = p_id and deleted_at is null and origin = 'store' and from_place = s and (type = 'delivery' or tote);
  if d.id is null then raise exception '우리 매장이 올린 고객 배송 · 토트박스 회수 요청만 지울 수 있습니다'; end if;
  if d.status in ('done', 'checked', 'confirmed') then raise exception '운행이 끝난 요청은 지울 수 없습니다 — 더한물류 · 본사에 연락해 주세요'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception '삭제 사유를 넣어 주세요'; end if;
  perform set_config('kk.actor', 'store:' || s, true);
  perform set_config('kk.skip_track', '1', true);
  update dispatches set deleted_at = now(), deleted_by = 'store:' || s, delete_reason = left(trim(p_reason), 200), updated_by = 'store:' || s where id = p_id;
  perform set_config('kk.skip_track', '', true);
  select 'vendor:' || name into vn from vendors where id = d.vendor_id;
  begin perform kk_notify(array[coalesce(vn, 'vendor:*'), 'staff'] || case when d.tote then array['store:' || d.to_place] else '{}'::text[] end, '매장이 요청을 삭제했습니다 · ' || s,
    '#' || d.id || ' ' || case when d.tote then '토트박스 회수' else '고객 배송' end || ' ' || to_char(d.run_date, 'MM/DD')
      || case when coalesce(d.driver_name, '') <> '' then ' · 배정 기사 ' || d.driver_name || ' 확인 필요' else '' end || ' · 사유: ' || left(trim(p_reason), 60), '?v=');
  exception when others then null; end;
end $$;
create or replace function vendor_delete(p_vendor text, p_pin text, p_ids bigint[], p_reason text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin); n int; bad int; r dispatches;
begin
  -- b33: 삭제 권한이 없어도, 더한물류가 직접 등록한(붙여넣기 · 사진) 입력 대기 요청은 7일 안에 지울 수 있음
  if not coalesce((select can_delete from vendors where id = v), false)
     and exists (select 1 from dispatches where id = any(p_ids) and deleted_at is null
                  and not (origin = 'kingkong' and vendor_id = v and updated_by = 'vendor:' || p_vendor and created_at > now() - interval '7 days')) then
    raise exception '삭제 권한이 없습니다 — 직접 등록한 요청만 지울 수 있습니다(다른 건은 킹콩 본사에 요청)'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception '삭제 사유를 넣어 주세요'; end if;
  select count(*) into bad from dispatches where id = any(p_ids) and deleted_at is null
     and ((vendor_id is not null and vendor_id <> v)
          or ((status <> 'requested' or coalesce(driver_name, '') <> '')
              and not (origin = 'store' and status in ('requested', 'assigned'))));   -- b38: 매장 요청은 기사 배정 뒤에도(운행 전) 지울 수 있음
  if bad > 0 then raise exception '입력 대기(기사 · 차량 없는 배차 요청) 건만 지울 수 있습니다'; end if;
  perform set_config('kk.actor', 'vendor:' || p_vendor, true);
  perform set_config('kk.no_notify', '1', true);
  perform set_config('kk.skip_track', '1', true);
  update dispatches set deleted_at = now(), deleted_by = 'vendor:' || p_vendor, delete_reason = trim(p_reason), updated_by = 'vendor:' || p_vendor
   where id = any(p_ids) and deleted_at is null;
  get diagnostics n = row_count;
  perform set_config('kk.no_notify', '', true);
  if n > 0 then perform kk_notify(array['staff'], '입력 대기 건 삭제 · ' || p_vendor, n || '건 · ' || left(trim(p_reason), 60), '#setup'); end if;
  -- b38: 매장이 올린 요청(고객 배송 · 토트박스 회수)을 더한물류가 지우면 그 매장에 알림
  for r in select * from dispatches where id = any(p_ids) and origin = 'store' and deleted_by = 'vendor:' || p_vendor loop
    begin perform kk_notify(array['store:' || r.from_place] || case when r.tote then array['store:' || r.to_place] else '{}'::text[] end, '더한물류가 요청을 삭제했습니다 · ' || case when r.tote then '토트박스 회수' else '고객 배송' end,
      '#' || r.id || ' ' || to_char(r.run_date, 'MM/DD') || ' · 사유: ' || left(trim(p_reason), 60), '?s='); exception when others then null; end;
  end loop;
  return n;
end $$;
create or replace function center_list(p_name text, p_pin text)
returns setof jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); pl text[] := center_places(s); dc text := coalesce((select value from app_config where key = 'delivery_center'), '진천센터');
begin
  return query
    select jsonb_build_object('id', d.id, 'status', d.status, 'received_at', d.received_at, 'received_by', d.received_by, 'center_ok_at', d.center_ok_at, 'center_ok_by', d.center_ok_by, 'run_date', d.run_date, 'created_at', d.created_at, 'type', d.type,
             'from_place', d.from_place, 'to_place', d.to_place, 'via_place', d.via_place, 'plt_qty', d.plt_qty, 'time_slot', d.time_slot, 'temp', d.temp,
             'cargo_note', d.cargo_note, 'tote', d.tote, 'tote_qty', d.tote_qty, 'group_no', d.group_no, 'origin', d.origin, 'orderer', d.orderer, 'requested_by', d.requested_by,
             'driver_name', d.driver_name, 'driver_phone', d.driver_phone, 'vehicle_no', d.vehicle_no, 'vehicle_ton', d.vehicle_ton, 'vehicle_body', d.vehicle_body,
             'vendor', (select name from vendors v where v.id = d.vendor_id),
             'delivery', (select jsonb_build_object('product', x.product, 'qty', x.qty, 'customer_name', x.customer_name, 'address', x.address, 'order_date', x.order_date, 'asap', x.asap) from dispatch_delivery x where x.dispatch_id = d.id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'note', e.note, 'driver_name', e.driver_name) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id))
      from dispatches d
     where d.deleted_at is null
       and ((d.type <> 'delivery' and (d.from_place = any(pl) or d.to_place = any(pl) or d.orderer = s))
            or (d.type = 'delivery' and d.origin = 'store' and s = dc))   -- b33: 매장 배송 요청도 진천센터에 보임
       and d.run_date >= current_date - 60
     order by d.run_date desc, d.id desc;
end $$;
select 'b42ok' as r;

-- b42-b: 기흥센터 계정(센터 링크 ?g=기흥센터) — PIN은 임의 6자리로 만들어 암호화 보관 → 본사 설정 › PIN 관리에서 확인 · 변경
do $$ declare p text := lpad((floor(random() * 1000000))::int::text, 6, '0'); begin
  if not exists (select 1 from stores where name = '기흥센터') then
    perform set_config('kk.newpin', p, true);
    insert into stores(name, kind, pin_hash, active, app_open) values ('기흥센터', 'center', crypt(p, gen_salt('bf')), true, true);
    perform set_config('kk.newpin', '', true);
  end if;
  if not exists (select 1 from places where name = '기흥센터') then insert into places(name, kind) values ('기흥센터', '센터'); end if;
end $$;
select 'b42bok-' || count(*) as r from stores where name = '기흥센터' and kind = 'center' and pin_enc is not null;

-- ===================================================================
-- b44 — 진천센터 통합 관제: 기흥센터 · 콜드체인센터 배차까지 진천센터 화면에서 보고 요청 · 관리
--   + 진천센터가 전 매장(과 다른 센터) PIN을 만들고 · 보고 · 바꿈(본사 PIN 관리와 같은 암호화 보관)
-- ===================================================================
insert into app_config(key, value) values ('hub_center', '진천센터') on conflict (key) do nothing;
create or replace function kk_hub() returns text language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select value from app_config where key = 'hub_center'), '진천센터');
$$;
-- 허브(진천센터)는 모든 센터 + 각 센터의 지점을 자기 것처럼 — 목록 · 요청 · 물류비 · 확인 등 center_* 함수가 모두 이걸 씀
create or replace function center_places(p_name text) returns text[] language sql stable security definer set search_path = public, extensions as $$
  select case when p_name = kk_hub()
    then array[p_name] || coalesce((select array_agg(name) from stores where kind = 'center' and name <> p_name and deleted_at is null), '{}')
         || coalesce((select array_agg(x) from stores, unnest(coalesce(places, '{}')) x where kind = 'center'), '{}')
    else array[p_name] || coalesce((select places from stores where name = p_name), '{}') end;
$$;
create or replace function center_info(p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin);
begin
  return jsonb_build_object('hub', s = kk_hub(), 'centers', coalesce((select jsonb_agg(name order by name = kk_hub() desc, name) from stores where kind = 'center' and active and deleted_at is null), '[]'));
end $$;
create or replace function center_pins_list(p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin);
begin
  if s <> kk_hub() then raise exception 'PIN은 %에서만 볼 수 있습니다', kk_hub(); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'name', name, 'active', active, 'app_open', app_open, 'pin', kk_pin_dec(pin_enc)) order by kind <> 'center', name)
                     from stores where deleted_at is null), '[]');
end $$;
create or replace function center_pin_set(p_name text, p_pin text, p_kind text, p_target text, p_new text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); n int;
begin
  if s <> kk_hub() then raise exception 'PIN은 %에서만 바꿀 수 있습니다', kk_hub(); end if;
  if coalesce(p_new, '') !~ '^\d{4,8}$' then raise exception 'PIN은 숫자 4~8자리로 넣어 주세요'; end if;
  if p_kind not in ('store', 'center') then raise exception '매장 · 센터 PIN만 바꿀 수 있습니다'; end if;
  perform set_config('kk.actor', 'center:' || s, true);
  perform set_config('kk.newpin', p_new, true);
  update stores set pin_hash = crypt(p_new, gen_salt('bf')), updated_at = now() where name = p_target and kind = p_kind and deleted_at is null;
  get diagnostics n = row_count; if n = 0 then raise exception '해당 이름이 없습니다'; end if;
  perform set_config('kk.newpin', '', true);
end $$;
revoke all on function kk_hub(), center_info(text,text), center_pins_list(text,text), center_pin_set(text,text,text,text,text) from public;
grant execute on function center_info(text,text), center_pins_list(text,text), center_pin_set(text,text,text,text,text) to anon, authenticated;
select 'b44ok-' || array_length(center_places('진천센터'), 1) as r;

-- ===================================================================
-- b45 — 센터별 물류비 보기 범위(총괄은 진천센터)
--   진천센터(허브): 전체 물류비 · 콜드체인센터: 자기가 요청한 건 + 자기 센터가 낀 냉장 · 냉동 건 · 기흥센터 등: 자기가 요청한 건 + 자기 센터로 입고된 건
-- ===================================================================
create or replace function center_cost_ok(s text, pl text[], d dispatches) returns boolean language sql stable security definer set search_path = public, extensions as $$
  select case
    when s = kk_hub() then true
    when s like '%콜드체인%' then d.orderer = s or (coalesce(d.temp, '') in ('냉장', '냉동') and (d.from_place = any(pl) or d.to_place = any(pl)))
    else d.orderer = s or d.to_place = any(pl) end;
$$;
revoke all on function center_cost_ok(text, text[], dispatches) from public, anon, authenticated;
create or replace function center_cost(p_name text, p_pin text) returns setof jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); pl text[] := center_places(s);
begin
  return query select to_jsonb(d) - 'memo' - 'pin_hash'
    from dispatches d where d.deleted_at is null and d.run_date >= current_date - 120
     and center_cost_ok(s, pl, d);
end $$;
create or replace function center_cost_range(p_name text, p_pin text, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); pl text[] := center_places(s);
begin
  if p_from is null or p_to is null or p_to < p_from then raise exception '기간을 확인해 주세요'; end if;
  if p_to - p_from > 800 then raise exception '기간은 2년 이내로 골라 주세요'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'run_date', d.run_date, 'type', d.type, 'status', d.status, 'origin', d.origin, 'orderer', d.orderer,
      'from_place', d.from_place, 'to_place', d.to_place, 'via_place', d.via_place, 'plt_qty', d.plt_qty, 'vehicle_ton', d.vehicle_ton, 'driver_name', d.driver_name,
      'base_fare', d.base_fare, 'extra_fare', d.extra_fare, 'extra_reason', d.extra_reason, 'return_fare', d.return_fare) order by d.run_date, d.id)
    from dispatches d where d.deleted_at is null and d.run_date between p_from and p_to
     and center_cost_ok(s, pl, d)), '[]');
end $$;
select 'b45ok' as r;

-- ===================================================================
-- b46 — 진천센터(허브) 모든 권한: 더한물류(운송사) · 확인 담당자 PIN까지 보기 · 바꾸기 / 토트 회수 건은 콜드체인센터 물류비에도
-- ===================================================================
create or replace function center_pins_list(p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin);
begin
  if s <> kk_hub() then raise exception 'PIN은 %에서만 볼 수 있습니다', kk_hub(); end if;
  return coalesce((select jsonb_agg(x order by x ->> 'ord', x ->> 'name') from (
      select jsonb_build_object('kind', kind, 'ord', case when kind = 'center' then '1' else '4' end, 'name', name, 'active', active, 'app_open', app_open, 'pin', kk_pin_dec(pin_enc)) x from stores where deleted_at is null
      union all select jsonb_build_object('kind', 'vendor', 'ord', '2', 'name', name, 'active', active, 'pin', kk_pin_dec(pin_enc)) from vendors
      union all select jsonb_build_object('kind', 'checker', 'ord', '3', 'name', name, 'active', active, 'pin', kk_pin_dec(pin_enc)) from checkers) t), '[]');
end $$;
create or replace function center_pin_set(p_name text, p_pin text, p_kind text, p_target text, p_new text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); n int;
begin
  if s <> kk_hub() then raise exception 'PIN은 %에서만 바꿀 수 있습니다', kk_hub(); end if;
  if coalesce(p_new, '') !~ '^\d{4,8}$' then raise exception 'PIN은 숫자 4~8자리로 넣어 주세요'; end if;
  perform set_config('kk.actor', 'center:' || s, true);
  perform set_config('kk.newpin', p_new, true);
  if p_kind in ('store', 'center') then update stores set pin_hash = crypt(p_new, gen_salt('bf')), updated_at = now() where name = p_target and kind = p_kind and deleted_at is null;
  elsif p_kind = 'vendor' then update vendors set pin_hash = crypt(p_new, gen_salt('bf')), pin_enc = kk_pin_enc(p_new) where name = p_target;
  elsif p_kind = 'checker' then update checkers set pin_hash = crypt(p_new, gen_salt('bf')), pin_enc = kk_pin_enc(p_new) where name = p_target;
  else raise exception '바꿀 수 없는 종류입니다'; end if;
  get diagnostics n = row_count; if n = 0 then raise exception '해당 이름이 없습니다'; end if;
  perform set_config('kk.newpin', '', true);
end $$;
create or replace function center_cost_ok(s text, pl text[], d dispatches) returns boolean language sql stable security definer set search_path = public, extensions as $$
  select case
    when s = kk_hub() then true
    when s like '%콜드체인%' then d.orderer = s or (coalesce(d.temp, '') in ('냉장', '냉동') and (d.from_place = any(pl) or d.to_place = any(pl))) or (d.tote and d.to_place = any(pl))
    else d.orderer = s or d.to_place = any(pl) end;
$$;
select 'b46ok' as r;

-- ===================================================================
-- b47 — 매장 입출고 담당자 연락처(매장 · 진천센터 · 본사가 적고, 더한물류가 봄) / 진천센터 → 매장 텍스트 알림(사진 · 자료 요청)
-- ===================================================================
alter table stores add column if not exists contact_name  text;
alter table stores add column if not exists contact_phone text;
alter table stores add column if not exists contact_note  text;   -- 하역장 위치 · 받는 시간 등
create or replace function store_info(p_store text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin);
begin
  return (select jsonb_build_object('fresh', coalesce(fresh, false), 'contact_name', contact_name, 'contact_phone', contact_phone, 'contact_note', contact_note) from stores where name = s);
end $$;
create or replace function store_contact_set(p_store text, p_pin text, p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := store_check(p_store, p_pin);
begin
  perform set_config('kk.actor', 'store:' || s, true);
  update stores set contact_name = left(nullif(trim(p ->> 'name'), ''), 30), contact_phone = left(nullif(trim(p ->> 'phone'), ''), 30), contact_note = left(nullif(trim(p ->> 'note'), ''), 120), updated_at = now() where name = s;
end $$;
create or replace function store_mgr_list(p_kind text, p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform store_mgr_actor(p_kind, p_name, p_pin);
  return coalesce((select jsonb_agg(jsonb_build_object('name', name, 'active', active, 'app_open', app_open, 'fresh', fresh, 'created_by', created_by, 'updated_at', updated_at,
                                                       'contact_name', contact_name, 'contact_phone', contact_phone, 'contact_note', contact_note) order by name)
                     from stores where kind = 'store' and deleted_at is null), '[]');
end $$;
create or replace function store_mgr_contact(p_kind text, p_name text, p_pin text, p_store text, p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare a text := store_mgr_actor(p_kind, p_name, p_pin);
begin
  perform set_config('kk.actor', a, true);
  update stores set contact_name = left(nullif(trim(p ->> 'name'), ''), 30), contact_phone = left(nullif(trim(p ->> 'phone'), ''), 30), contact_note = left(nullif(trim(p ->> 'note'), ''), 120), updated_at = now()
   where name = p_store and kind = 'store' and deleted_at is null;
end $$;
-- 더한물류: 매장별 입출고 담당자 연락처
create or replace function vendor_store_contacts(p_vendor text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform vendor_check(p_vendor, p_pin);
  return coalesce((select jsonb_agg(jsonb_build_object('name', name, 'kind', kind, 'contact_name', contact_name, 'contact_phone', contact_phone, 'contact_note', contact_note) order by kind <> 'center', name)
                     from stores where deleted_at is null and active), '[]');
end $$;
-- 진천센터(모든 센터) → 매장 텍스트 알림: 매장 '센터 알림'에 남고 휴대폰 알림
create or replace function center_notify_store(p_name text, p_pin text, p_stores text[], p_title text, p_body text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); st text; n int := 0;
begin
  if coalesce(trim(p_body), '') = '' then raise exception '보낼 내용을 적어 주세요'; end if;
  if coalesce(array_length(p_stores, 1), 0) = 0 or array_length(p_stores, 1) > 200 then raise exception '받을 매장을 골라 주세요'; end if;
  foreach st in array p_stores loop
    continue when not exists (select 1 from stores where name = st and deleted_at is null);
    insert into store_msgs(store, in_date, kind, title, body, sent_by) values (st, current_date, 'note', left(coalesce(nullif(trim(p_title), ''), s || ' 알림'), 200), left(p_body, 2000), 'center:' || s);
    begin perform kk_notify(array['store:' || st], left(coalesce(nullif(trim(p_title), ''), s || ' 알림'), 60), left(p_body, 120), '?s='); exception when others then null; end;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function store_contact_set(text,text,jsonb), store_mgr_contact(text,text,text,text,jsonb), vendor_store_contacts(text,text), center_notify_store(text,text,text[],text,text) from public;
grant execute on function store_contact_set(text,text,jsonb), store_mgr_contact(text,text,text,text,jsonb), vendor_store_contacts(text,text), center_notify_store(text,text,text[],text,text), store_info(text,text), store_mgr_list(text,text,text) to anon, authenticated;
select 'b47ok' as r;

-- =====================================================================
--  b48 — 본사 공용 계정 하나(이름 '본사', PIN 하나, 여러 명 동시 접속) · 개인 본사 계정은 '사용 중지'로 정리
--   PIN 은 앱 › 설정 › PIN 관리 › 구분 '본사' 줄에서 정함(처음 정하면 계정이 만들어짐). 링크: ?h=본사
-- =====================================================================
alter table staff add column if not exists shared boolean not null default false;
alter table staff add column if not exists pin_enc text;
create or replace function staff_me() returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select jsonb_build_object('email', email, 'name', name, 'role', role, 'can_delete', can_delete, 'org', org, 'shared', shared) from staff where lower(email) = lower(coalesce(auth.jwt()->>'email',''))), '{}'::jsonb);
$$;
create or replace function kk_pins_list() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare me text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not staff_can_delete() then raise exception 'PIN은 삭제 권한자만 볼 수 있습니다'; end if;
  return coalesce((select jsonb_agg(x order by x ->> 'ord', x ->> 'name') from (
      select jsonb_build_object('kind', 'hq', 'ord', '0', 'name', '본사', 'shared', true, 'active', true, 'pin', (select kk_pin_dec(pin_enc) from staff where shared and name = '본사' limit 1),
             'exists', exists(select 1 from staff where shared and name = '본사')) x
      union all select jsonb_build_object('kind', 'hq', 'ord', '0', 'name', name, 'shared', false, 'active', true, 'pin', null, 'can_delete', can_delete) from staff
        where not shared and lower(email) <> me
      union all select jsonb_build_object('kind', case when kind = 'center' then 'center' else 'store' end, 'ord', case when kind = 'center' then '1' else '4' end, 'name', name,
             'active', active and deleted_at is null, 'pin', kk_pin_dec(pin_enc), 'updated_at', updated_at) from stores where deleted_at is null
      union all select jsonb_build_object('kind', 'vendor', 'ord', '2', 'name', name, 'active', active, 'pin', kk_pin_dec(pin_enc)) from vendors
      union all select jsonb_build_object('kind', 'checker', 'ord', '3', 'name', name, 'active', active, 'pin', kk_pin_dec(pin_enc)) from checkers) t), '[]');
end $$;
create or replace function kk_pin_set(p_kind text, p_name text, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare me text := coalesce(auth.jwt() ->> 'email', 'staff'); n int;
begin
  if not staff_can_delete() then raise exception 'PIN은 삭제 권한자만 바꿀 수 있습니다'; end if;
  if coalesce(p_pin, '') !~ '^\d{4,8}$' then raise exception 'PIN은 숫자 4~8자리로 넣어 주세요'; end if;
  perform set_config('kk.actor', me, true);
  perform set_config('kk.newpin', p_pin, true);
  if p_kind = 'hq' then
    if p_name <> '본사' then raise exception '개인 본사 계정은 PIN 대신 사용 중지로 정리해 주세요'; end if;
    perform kk_add_hq('본사', p_pin, '킹콩본사', false);
    update staff set shared = true, pin_enc = kk_pin_enc(p_pin) where name = '본사';
  elsif p_kind in ('store', 'center') then update stores set pin_hash = crypt(p_pin, gen_salt('bf')), updated_at = now() where name = p_name and kind = p_kind and deleted_at is null;
  elsif p_kind = 'vendor' then update vendors set pin_hash = crypt(p_pin, gen_salt('bf')), pin_enc = kk_pin_enc(p_pin) where name = p_name;
  elsif p_kind = 'checker' then update checkers set pin_hash = crypt(p_pin, gen_salt('bf')), pin_enc = kk_pin_enc(p_pin) where name = p_name;
  else raise exception '바꿀 수 없는 종류입니다'; end if;
  get diagnostics n = row_count; if n = 0 then raise exception '해당 이름이 없습니다'; end if;
  perform set_config('kk.newpin', '', true);
end $$;
-- 개인 본사 계정 사용 중지: 명단에서 빼고 열려 있던 기기도 로그아웃(본인 · 삭제 권한자 · 공용 계정은 안 됨)
create or replace function kk_hq_off(p_name text) returns void
language plpgsql security definer set search_path = public, extensions, auth as $$
declare e text; cd boolean; sh boolean;
begin
  if not staff_can_delete() then raise exception '삭제 권한자만 할 수 있습니다'; end if;
  select email, can_delete, shared into e, cd, sh from staff where name = p_name and lower(email) <> lower(coalesce(auth.jwt() ->> 'email', '')) order by email limit 1;
  if e is null then raise exception '해당 이름이 없습니다'; end if;
  if sh then raise exception '공용 계정은 사용 중지할 수 없습니다'; end if;
  if cd then raise exception '삭제 권한자 계정은 여기서 끌 수 없습니다'; end if;
  delete from staff where email = e;
  delete from push_subs where who = e;
  delete from auth.sessions where user_id in (select id from auth.users where lower(email) = lower(e));
  perform kk_notify(array['staff'], '본사 개인 계정 사용 중지 · ' || p_name, '이제 본사 공용 계정(?h=본사)으로 들어옵니다', '#setup');
end $$;
revoke all on function kk_pins_list(), kk_pin_set(text,text,text), kk_hq_off(text) from public, anon;
grant execute on function kk_pins_list(), kk_pin_set(text,text,text), kk_hq_off(text) to authenticated;
select 'b48ok' as r;

-- ===================================================================
-- b55 — 콜드체인센터 물류비 = 냉장 · 냉동 차량(콜드체인 관련) + 토트박스 회수 차량만. 상온 차량은 요청자가 콜드체인이어도 빠짐
-- ===================================================================
create or replace function center_cost_ok(s text, pl text[], d dispatches) returns boolean language sql stable security definer set search_path = public, extensions as $$
  select case
    when s = kk_hub() then true
    when s like '%콜드체인%' then (coalesce(d.tote, false) and d.to_place = any(pl))
      or (coalesce(d.temp, '') in ('냉장', '냉동') and (d.orderer = s or d.from_place = any(pl) or d.to_place = any(pl)))
    else d.orderer = s or d.to_place = any(pl) end;
$$;
select 'b55ok' as r;

-- ===================================================================
-- b56 — 쿠팡 신선센터 주소 목록: 콜드체인센터(또는 진천센터)가 엑셀로 올림 → 본사 · 센터가 봄
--        목록에 있는 FC에서 온 직출 = 신선 직출(콜드체인 사진 요청 대상)
-- ===================================================================
create table if not exists fresh_fc (
  name       text primary key,
  addr       text,
  note       text,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table fresh_fc enable row level security;
create table if not exists fresh_fc_hist (           -- 올리기 전 목록을 통째로 보관(잘못 올려도 되돌릴 수 있게)
  id bigint generated always as identity primary key, at timestamptz not null default now(), by text, data jsonb not null);
alter table fresh_fc_hist enable row level security;
drop policy if exists staff_all on fresh_fc_hist;
create policy staff_all on fresh_fc_hist for select to authenticated using (is_staff());
drop policy if exists staff_all on fresh_fc;
create policy staff_all on fresh_fc for select to authenticated using (is_staff());
create or replace function fresh_fc_list(p_kind text, p_name text, p_pin text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if p_kind = 'center' then perform center_check(p_name, p_pin);
  elsif not is_staff() then raise exception '권한이 없습니다'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('name', name, 'addr', addr, 'note', note, 'updated_by', updated_by, 'updated_at', updated_at) order by name) from fresh_fc), '[]');
end $$;
create or replace function fresh_fc_save(p_center text, p_pin text, p_rows jsonb, p_replace boolean default true) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_center, p_pin); n int;
begin
  if not (s like '%콜드체인%' or s = kk_hub()) then raise exception '쿠팡 신선센터 주소는 콜드체인센터 · 진천센터만 올릴 수 있습니다'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception '올릴 줄이 없습니다'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception '한 번에 500줄까지 올릴 수 있습니다'; end if;
  insert into fresh_fc_hist(by, data) select 'center:' || s, coalesce(jsonb_agg(to_jsonb(f)), '[]') from fresh_fc f;
  if p_replace then delete from fresh_fc where true; end if;
  insert into fresh_fc(name, addr, note, updated_by, updated_at)
    select distinct on (trim(r ->> 'name')) trim(r ->> 'name'), nullif(trim(r ->> 'addr'), ''), nullif(trim(r ->> 'note'), ''), 'center:' || s, now()
    from jsonb_array_elements(p_rows) r where coalesce(trim(r ->> 'name'), '') <> ''
  on conflict (name) do update set addr = excluded.addr, note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
  get diagnostics n = row_count;
  perform kk_notify(array['staff'], '쿠팡 신선센터 주소 업로드 · ' || s, n || '곳 — 본사 설정에서 볼 수 있습니다', '#setup');
  return n;
end $$;
revoke all on function fresh_fc_list(text,text,text), fresh_fc_save(text,text,jsonb,boolean) from public;
grant execute on function fresh_fc_list(text,text,text), fresh_fc_save(text,text,jsonb,boolean) to anon, authenticated;
select 'b56ok' as r;

-- ===================================================================
-- b58 — 나중에 만든 표는 기본 권한이 없어 본사 화면이 빈 목록으로 보이던 문제(접속 현황 · 보관 삭제 · 신선센터 주소)
--        읽기 권한만 줌 — 누가 읽을 수 있는지는 각 표의 RLS(is_staff)가 그대로 막음
-- ===================================================================
grant select on access_sessions, kk_trash, fresh_fc, fresh_fc_hist to authenticated;
select 'b58ok-' || count(*) as r from (values (has_table_privilege('authenticated', 'access_sessions', 'select')), (has_table_privilege('authenticated', 'kk_trash', 'select'))) v(x) where x;

-- ===================================================================
-- b60 — 입고사진 한 번에 최대 40장: 처음 몇 장으로 보고를 만들고(rcv_add) 나머지는 나눠서 붙임(rcv_add_photos)
--        한 번에 큰 요청을 보내다 일부가 빠지던 것을 막고, 실패한 묶음은 앱이 다시 시도
-- ===================================================================
create or replace function rcv_add(p_store text, p_pin text, p jsonb) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare a text := rcv_actor('store', p_store, p_pin); ph jsonb := coalesce(p -> 'photos', '[]'); c text := coalesce(nullif(trim(p ->> 'center'), ''), '진천센터'); nid bigint; x jsonb;
begin
  if jsonb_typeof(ph) <> 'array' or jsonb_array_length(ph) = 0 then raise exception '사진을 한 장 이상 넣어 주세요'; end if;
  if jsonb_array_length(ph) > 40 then raise exception '사진은 한 번에 40장까지 보낼 수 있습니다'; end if;
  for x in select * from jsonb_array_elements(ph) loop if length(x #>> '{}') > 400000 then raise exception '사진이 너무 큽니다'; end if; end loop;
  insert into rcv_reports(store, center, rcv_date, cate, plt_qty, memo, plt_nos, photos, n_photos, created_by)
  values (p_store, c, coalesce((p ->> 'rcv_date')::date, current_date), left(p ->> 'cate', 30), nullif(p ->> 'plt_qty', '')::int, left(p ->> 'memo', 300),
          coalesce((select array_agg(left(v, 60)) from jsonb_array_elements_text(coalesce(p -> 'plt_nos', '[]')) v), '{}'), ph, jsonb_array_length(ph), a)
  returning id into nid;
  update rcv_reports set photos = '[]' where photos <> '[]' and created_at < now() - interval '60 days';
  begin perform kk_notify(array['store:' || c, 'staff'], '입고 사진 · ' || p_store, coalesce(p ->> 'cate', '') || ' ' || coalesce(p ->> 'plt_qty', '?') || 'PLT · 사진 ' || coalesce(nullif(p ->> 'n_total', ''), jsonb_array_length(ph)::text) || '장' || coalesce(' · ' || nullif(left(p ->> 'memo', 40), ''), ''), '?g=');
  exception when others then null; end;
  return nid;
end $$;

create or replace function rcv_edit(p_store text, p_pin text, p_id bigint, p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare a text := rcv_actor('store', p_store, p_pin); r rcv_reports; ph jsonb := p -> 'photos'; x jsonb;
begin
  select * into r from rcv_reports where id = p_id and deleted_at is null and store = p_store;
  if r.id is null then raise exception '우리 매장이 올린 입고사진만 고칠 수 있습니다'; end if;
  if ph is not null then
    if jsonb_typeof(ph) <> 'array' or jsonb_array_length(ph) = 0 then raise exception '사진을 한 장 이상 남겨 주세요'; end if;
    if jsonb_array_length(ph) > 40 then raise exception '사진은 40장까지입니다'; end if;
    for x in select * from jsonb_array_elements(ph) loop if length(x #>> '{}') > 400000 then raise exception '사진이 너무 큽니다'; end if; end loop;
  end if;
  update rcv_reports set rcv_date = coalesce((p ->> 'rcv_date')::date, rcv_date),
         cate = case when p ? 'cate' then left(p ->> 'cate', 30) else cate end,
         plt_qty = case when p ? 'plt_qty' then nullif(p ->> 'plt_qty', '')::int else plt_qty end,
         memo = case when p ? 'memo' then left(p ->> 'memo', 300) else memo end,
         plt_nos = case when p ? 'plt_nos' then coalesce((select array_agg(left(v, 60)) from jsonb_array_elements_text(p -> 'plt_nos') v), '{}') else plt_nos end,
         photos = coalesce(ph, photos), n_photos = coalesce(jsonb_array_length(ph), n_photos),
         seen_at = null, seen_by = null   -- 고치면 센터가 다시 확인
   where id = p_id;
  begin perform kk_notify(array['store:' || r.center], '입고사진 수정 · ' || p_store, '#' || p_id || ' ' || coalesce(p ->> 'cate', r.cate, '') || ' ' || coalesce(p ->> 'plt_qty', r.plt_qty::text, '?') || 'PLT', '?g=');
  exception when others then null; end;
end $$;

create or replace function rcv_add_photos(p_store text, p_pin text, p_id bigint, p_photos jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare a text := rcv_actor('store', p_store, p_pin); r rcv_reports; x jsonb; n int;
begin
  select * into r from rcv_reports where id = p_id and deleted_at is null and store = p_store and created_at > now() - interval '1 day';
  if r.id is null then raise exception '방금 올린 우리 매장 입고사진에만 사진을 더 붙일 수 있습니다'; end if;
  if jsonb_typeof(p_photos) <> 'array' or jsonb_array_length(p_photos) = 0 then return r.n_photos; end if;
  if jsonb_array_length(r.photos) + jsonb_array_length(p_photos) > 40 then raise exception '사진은 40장까지입니다'; end if;
  for x in select * from jsonb_array_elements(p_photos) loop if length(x #>> '{}') > 400000 then raise exception '사진이 너무 큽니다'; end if; end loop;
  update rcv_reports set photos = photos || p_photos, n_photos = jsonb_array_length(photos || p_photos) where id = p_id returning n_photos into n;
  return n;
end $$;
revoke all on function rcv_add_photos(text,text,bigint,jsonb) from public;
grant execute on function rcv_add_photos(text,text,bigint,jsonb) to anon, authenticated;
select 'b60ok' as r;

-- ===================================================================
-- b61 — 개선 요청 '반영한 내용'(fix_note): 고친 쪽이 적어 두면 본사가 [✓ 완료]를 누를 때 그 내용이 답글로 달림(요청자 · 본사가 같은 히스토리)
-- ===================================================================
alter table feedback add column if not exists fix_note  text;
alter table feedback add column if not exists fix_build text;
update feedback set fix_build = '60', fix_note = case id
  when 4 then '출고 요청 도착지에 [▼ 전체 매장에서 고르기]를 넣었습니다. 앱에 등록된 모든 매장(현재 약 20곳)이 버튼으로 나오고, 찾기 칸에 이름 일부를 치면 걸러집니다. 최근에 보낸 매장은 위에 따로 보입니다. 출고 PLT 등록의 하차지 목록에도 전 매장이 들어갑니다.'
  when 5 then '화면이 바뀌면 뜨는 안내에 [바뀐 점 보기] 버튼을 넣었습니다. 누르면 이번에 바뀐 항목이 목록으로 보이고, 설명서 창 아래 [최근 바뀐 점 보기]에서도 언제든 다시 볼 수 있습니다.'
  when 6 then '휴대폰 뒤로가기를 고쳤습니다. 열린 창 · 사진 · 상세가 있으면 뒤로가기로 그 창만 닫히고(닫기 버튼도 그대로), 첫 화면에서는 「뒤로 한 번 더 누르면 앱이 닫힙니다」 안내 후 한 번 더 눌러야 종료됩니다.'
  when 7 then '입고사진을 한 번에 최대 40장까지 올릴 수 있게 했습니다(전에는 12장). 많을 때는 8장씩 나눠 보내 끊기지 않게 했습니다.'
  when 8 then '① 사진 일부만 올라가던 문제: 사진을 나눠 보내고 실패하면 3번까지 다시 시도합니다. 그래도 빠지면 「몇 장 보냈고 몇 장 못 보냄」으로 알려 줍니다. 큰 사진에서 메모리가 모자라 건너뛰던 것도 줄였습니다.
② PLT 번호 글자 인식: 바코드를 흑백 · 확대 · 사진 4조각으로 다시 읽고, 글자는 영문 · 숫자 · - 만 읽게 한 뒤 지난 출고에 나온 LOT 코드에 맞춰 O/0 · I/1 · S/5 · 앞 FC 번호(예: 963 → 953)를 바로잡습니다. 지난 라벨 사진 53장으로 시험하니 자동으로 읽힌 사진이 26장 → 31장으로 늘었고, 엉뚱한 번호로 읽히던 것은 걸러졌습니다. 다 읽으면 「몇 장 → 몇 줄 · 이미 있는 번호 · 못 읽은 줄 · 열지 못한 사진」을 알려 줍니다.'
  end where id in (4, 5, 6, 7, 8) and fix_note is null;
select 'b61ok-' || count(*) as r from feedback where fix_note is not null;

-- b62: 개선 요청 #9 반영 내용
update feedback set fix_build = '62', fix_note = '출고 · 입고 요청의 [카톡 글 · 캡처로 바로 채우기]를 고쳤습니다. 원인은 최근에 보낸 매장 이름만 알고 있어서 처음 보내는 매장(원주점 · 수원점 등)을 못 찾던 것이었습니다. 이제 앱에 등록된 전 매장과 줄임말(경안 · 수원 · 동탄 …)을 알아보고, 「1. 이천점 18plt / 2. 원주점 12plt」 같은 여러 줄 목록이나 「동탄 9p, 청주 6p」처럼 한 줄에 쓴 것도 건별로 나눠 채운 뒤 [고른 건 한꺼번에 요청]으로 보낼 수 있습니다. 캡처 사진에서 「→」가 「ㅜ」로, 「12plt」가 「120!」로 읽히던 것도 바로잡습니다. 시험한 카톡 글 10가지와 캡처 사진 모두 매장 · PLT · 날짜 · 시간이 채워졌습니다.'
 where id = 9 and fix_note is null;

-- ===================================================================
-- b63 — 화면 오류 자동 수집(client_errors · log_error) / 시트 동기화: 같은 배차가 시트에 두 줄이면 첫 줄만(기사 바뀜 기록이 번갈아 쌓이던 것)
-- ===================================================================
create table if not exists client_errors (
  id    bigint generated always as identity primary key,
  at    timestamptz not null default now(),
  who   text, page text, msg text, stack text, ua text, build text
);
create index if not exists client_errors_at on client_errors (at desc);
alter table client_errors enable row level security;
drop policy if exists staff_read on client_errors;
create policy staff_read on client_errors for select to authenticated using (is_staff());
grant select on client_errors to authenticated;
create or replace function log_error(p_who text, p_page text, p_msg text, p_stack text, p_ua text, p_build text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if coalesce(trim(p_msg), '') = '' then return; end if;
  if (select count(*) from client_errors where at > now() - interval '1 hour') >= 500 then return; end if;   -- 폭주 막기
  if exists (select 1 from client_errors where who = left(p_who, 80) and msg = left(p_msg, 300) and at > now() - interval '10 minutes') then return; end if;
  insert into client_errors(who, page, msg, stack, ua, build) values (left(p_who, 80), left(p_page, 120), left(p_msg, 300), left(p_stack, 1500), left(p_ua, 200), left(p_build, 10));
  if random() < 0.02 then delete from client_errors where at < now() - interval '60 days'; end if;
end $$;
revoke all on function log_error(text,text,text,text,text,text) from public;
grant execute on function log_error(text,text,text,text,text,text) to anon, authenticated;
create or replace function sheet_upsert(p_source text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare x jsonb; r dispatches; vid uuid; ins int := 0; upd int := 0; skip int := 0; st text; seen bigint[] := '{}'; dup int := 0;
begin
  perform set_config('kk.actor', 'sheet:' || p_source, true);
  perform set_config('kk.no_notify', '1', true);
  for x in select * from jsonb_array_elements(p_rows) loop
    select id into vid from vendors where name = x->>'vendor';
    select * into r from dispatches where sheet_key = x->>'key';
    if r.id is null then
      select * into r from dispatches d where d.sheet_key is null and d.status <> 'canceled' and d.type = coalesce(x->>'type','coupang')
         and d.run_date = (x->>'run_date')::date and d.from_place = x->>'from_place' and (d.to_place = x->>'to_place' or d.type = 'delivery')
         and (d.type <> 'delivery' or exists (select 1 from dispatch_delivery dd where dd.dispatch_id = d.id and dd.customer_phone = x->'delivery'->>'customer_phone'))
       order by d.id limit 1;
    end if;
    if r.id is null and position('#' in split_part(x->>'key', ':', 3)) = 0 then   -- b25-a: 겹친 NO.(73#2)로 들어갔던 줄의 NO.를 시트에서 고친 경우 → 그 배차를 이어받음
      select * into r from dispatches d where d.sheet_key like regexp_replace(x->>'key', ':[^:]*$', ':') || '%#%' and d.origin = 'sheet'
         and d.run_date = (x->>'run_date')::date and d.from_place = x->>'from_place' and d.to_place = coalesce(nullif(x->>'to_place',''), d.to_place)
         and not exists (select 1 from jsonb_array_elements(p_rows) y where y->>'key' = d.sheet_key)
       order by d.id limit 1;
    end if;
    if r.id is not null and r.id = any(seen) then dup := dup + 1; continue; end if;   -- b63: 시트에 같은 배차가 두 줄이면 첫 줄만(번갈아 덮어써 '기사 바뀜'이 쌓이던 것)
    if r.id is not null and r.status in ('checked','confirmed') then skip := skip + 1; continue; end if;
    if r.id is not null and r.origin <> 'sheet' then   -- 앱에서 넣은 값 ↔ 시트 값 비교(병행 대조표)
      insert into sync_diffs(dispatch_id, sheet_key, field, app_value, sheet_value)
      select r.id, x->>'key', f.k, f.a, f.b from (values
        ('driver_name', r.driver_name, nullif(x->>'driver_name','')), ('vehicle_no', r.vehicle_no, nullif(x->>'vehicle_no','')),
        ('base_fare', r.base_fare::text, nullif(x->>'base_fare','')), ('extra_fare', nullif(r.extra_fare,0)::text, nullif(nullif(x->>'extra_fare',''),'0')),
        ('plt_qty', trim(trailing '.' from trim(trailing '0' from r.plt_qty::text)), nullif(x->>'plt_qty',''))) f(k, a, b)
      where f.a is not null and f.b is not null and replace(f.a, ' ', '') <> replace(f.b, ' ', '') and not (f.k in ('base_fare','extra_fare','plt_qty') and f.a::numeric = f.b::numeric)
      on conflict do nothing;
    end if;
    st := coalesce(nullif(x->>'status',''), 'requested');
    if r.id is null then
      insert into dispatches(type, status, vendor_id, origin, run_date, time_slot, from_place, to_place, plt_qty, temp, cargo_note, group_no, sheet_key,
                             driver_name, vehicle_no, vehicle_ton, vehicle_body, base_fare, extra_fare, extra_reason, return_date, return_from, return_driver, return_fare, updated_by)
      values (coalesce(x->>'type','coupang'), st, vid, 'sheet', (x->>'run_date')::date, x->>'time_slot', x->>'from_place', coalesce(nullif(x->>'to_place',''),'고객'),
              nullif(x->>'plt_qty','')::numeric, coalesce(nullif(x->>'temp',''),'상온'), x->>'note', x->>'group_no', x->>'key',
              nullif(x->>'driver_name',''), nullif(x->>'vehicle_no',''), nullif(x->>'vehicle_ton','')::numeric, nullif(x->>'vehicle_body',''),
              nullif(x->>'base_fare','')::int, coalesce(nullif(x->>'extra_fare','')::int,0), nullif(x->>'extra_reason',''),
              nullif(x->>'return_date','')::date, nullif(x->>'return_from',''), nullif(x->>'return_driver',''), nullif(x->>'return_fare','')::int, 'sheet:' || p_source)
      returning * into r; ins := ins + 1;
    else
      update dispatches set sheet_key = x->>'key', vendor_id = coalesce(vid, vendor_id), run_date = (x->>'run_date')::date, time_slot = coalesce(nullif(x->>'time_slot',''), time_slot),
        from_place = x->>'from_place', to_place = coalesce(nullif(x->>'to_place',''), to_place), plt_qty = coalesce(nullif(x->>'plt_qty','')::numeric, plt_qty),
        temp = coalesce(nullif(x->>'temp',''), temp), cargo_note = coalesce(nullif(x->>'note',''), cargo_note), group_no = coalesce(nullif(x->>'group_no',''), group_no),
        driver_name = coalesce(nullif(x->>'driver_name',''), driver_name), vehicle_no = coalesce(nullif(x->>'vehicle_no',''), vehicle_no),
        vehicle_ton = coalesce(nullif(x->>'vehicle_ton','')::numeric, vehicle_ton), vehicle_body = coalesce(nullif(x->>'vehicle_body',''), vehicle_body),
        base_fare = coalesce(nullif(x->>'base_fare','')::int, base_fare), extra_fare = coalesce(nullif(x->>'extra_fare','')::int, extra_fare), extra_reason = coalesce(nullif(x->>'extra_reason',''), extra_reason),
        return_date = coalesce(nullif(x->>'return_date','')::date, return_date), return_from = coalesce(nullif(x->>'return_from',''), return_from),
        return_driver = coalesce(nullif(x->>'return_driver',''), return_driver), return_fare = coalesce(nullif(x->>'return_fare','')::int, return_fare),
        status = case when st = 'canceled' then 'canceled' when array_position(array['requested','assigned','done'], st) > array_position(array['requested','assigned','done'], status) then st else status end,
        updated_by = 'sheet:' || p_source
      where id = r.id
        and row(run_date, from_place, to_place, plt_qty, driver_name, vehicle_no, base_fare, extra_fare, return_fare, status, sheet_key)
            is distinct from row((x->>'run_date')::date, x->>'from_place', coalesce(nullif(x->>'to_place',''), to_place), coalesce(nullif(x->>'plt_qty','')::numeric, plt_qty),
                                 coalesce(nullif(x->>'driver_name',''), driver_name), coalesce(nullif(x->>'vehicle_no',''), vehicle_no), coalesce(nullif(x->>'base_fare','')::int, base_fare),
                                 coalesce(nullif(x->>'extra_fare','')::int, extra_fare), coalesce(nullif(x->>'return_fare','')::int, return_fare), status, x->>'key');
      if found then upd := upd + 1; end if;
    end if;
    if x ? 'delivery' then
      insert into dispatch_delivery(dispatch_id, order_date, store, customer_name, customer_phone, address, product, qty, terms, done_note)
      values (r.id, nullif(x->'delivery'->>'order_date','')::date, x->>'from_place', x->'delivery'->>'customer_name', x->'delivery'->>'customer_phone', x->'delivery'->>'address',
              x->'delivery'->>'product', x->'delivery'->>'qty', case when x->'delivery'->>'terms' in ('무료','유료','무료(추가요금)') then x->'delivery'->>'terms' end, x->'delivery'->>'done_note')
      on conflict (dispatch_id) do update set customer_name = excluded.customer_name, customer_phone = excluded.customer_phone, address = excluded.address,
        product = excluded.product, qty = excluded.qty, terms = coalesce(excluded.terms, dispatch_delivery.terms), done_note = excluded.done_note
      where (dispatch_delivery.customer_name, dispatch_delivery.customer_phone, dispatch_delivery.address, dispatch_delivery.product, dispatch_delivery.qty, dispatch_delivery.done_note)
            is distinct from (excluded.customer_name, excluded.customer_phone, excluded.address, excluded.product, excluded.qty, excluded.done_note);
    end if;
  if r.id is not null then seen := seen || r.id; end if;
  end loop;
  insert into app_config(key, value) values ('sheet_sync:' || p_source, to_char(clock_timestamp() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') || format(' · 새 %s · 바뀜 %s · 확정이라 건너뜀 %s', ins, upd, skip) || case when dup > 0 then format(' · 시트 중복 줄 %s', dup) else '' end)
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('inserted', ins, 'updated', upd, 'skipped', skip);
end $$;
select 'b63ok' as r;

-- b63-b: 콜드체인센터 물류비 = 콜드체인센터가 요청한 냉장 · 냉동 차량 + 토트박스 회수 차량만(다른 곳이 요청한 건은 콜드체인 출발 · 도착이어도 제외)
create or replace function center_cost_ok(s text, pl text[], d dispatches) returns boolean language sql stable security definer set search_path = public, extensions as $$
  select case
    when s = kk_hub() then true
    when s like '%콜드체인%' then (coalesce(d.tote, false) and d.to_place = any(pl)) or (d.orderer = s and coalesce(d.temp, '') in ('냉장', '냉동'))
    else d.orderer = s or d.to_place = any(pl) end;
$$;
select 'b63bok' as r;

-- ===================================================================
-- b64 — 고도화 2 · 3단계: 정기 출고(center_routines) · 센터가 [차주정보] 붙여넣어 기사 등록(center_set_driver)
--        · 주간 한 장 요약(weekly_summary · 월요일 아침 본사 알림) · 구글드라이브 주간 백업용 내보내기(sheet_export, 시트 토큰)
-- ===================================================================
create table if not exists center_routines (
  id         bigint generated always as identity primary key,
  center     text not null,
  store      text not null,
  days       int[] not null default '{}',     -- 0=일 … 6=토
  time_slot  text default '',
  plt_qty    numeric,
  temp       text default '상온',
  note       text,
  active     boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table center_routines enable row level security;
drop policy if exists staff_read on center_routines;
create policy staff_read on center_routines for select to authenticated using (is_staff());
grant select on center_routines to authenticated;
create or replace function routine_list(p_center text, p_pin text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s text := center_check(p_center, p_pin); pl text[] := center_places(s);
begin
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.center, r.store) from center_routines r where r.center = s or r.center = any(pl)), '[]');
end $$;
create or replace function routine_save(p_center text, p_pin text, p jsonb) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_center, p_pin); pl text[] := center_places(s); c text := coalesce(nullif(p ->> 'center', ''), s); nid bigint;
begin
  if not (c = s or c = any(pl)) then raise exception '이 센터의 정기 출고만 고칠 수 있습니다'; end if;
  if coalesce(trim(p ->> 'store'), '') = '' then raise exception '도착 매장을 넣어 주세요'; end if;
  if (p ->> 'id') is not null then
    update center_routines set center = c, store = trim(p ->> 'store'), days = coalesce((select array_agg(v::int) from jsonb_array_elements_text(p -> 'days') v), '{}'),
           time_slot = coalesce(p ->> 'time_slot', ''), plt_qty = nullif(p ->> 'plt_qty', '')::numeric, temp = coalesce(nullif(p ->> 'temp', ''), '상온'), note = p ->> 'note',
           active = coalesce((p ->> 'active')::boolean, true), updated_by = 'center:' || s, updated_at = now()
     where id = (p ->> 'id')::bigint and (center = s or center = any(pl)) returning id into nid;
    if nid is null then raise exception '없는 정기 출고입니다'; end if;
  else
    insert into center_routines(center, store, days, time_slot, plt_qty, temp, note, updated_by)
    values (c, trim(p ->> 'store'), coalesce((select array_agg(v::int) from jsonb_array_elements_text(p -> 'days') v), '{}'), coalesce(p ->> 'time_slot', ''),
            nullif(p ->> 'plt_qty', '')::numeric, coalesce(nullif(p ->> 'temp', ''), '상온'), p ->> 'note', 'center:' || s) returning id into nid;
  end if;
  return nid;
end $$;
create or replace function routine_delete(p_center text, p_pin text, p_id bigint) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_center, p_pin); pl text[] := center_places(s);
begin
  delete from center_routines where id = p_id and (center = s or center = any(pl));
end $$;
revoke all on function routine_list(text,text), routine_save(text,text,jsonb), routine_delete(text,text,bigint) from public;
grant execute on function routine_list(text,text), routine_save(text,text,jsonb), routine_delete(text,text,bigint) to anon, authenticated;

-- 센터가 단톡방 [차주정보] 글을 붙여넣어 기사 · 차량을 넣음(운임은 그대로 — 더한물류만)
create or replace function center_set_driver(p_center text, p_pin text, p_id bigint, p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_center, p_pin); pl text[] := center_places(s); d dispatches;
begin
  select * into d from dispatches where id = p_id and deleted_at is null;
  if d.id is null or not (d.from_place = any(pl) or d.to_place = any(pl) or d.orderer = s) then raise exception '우리 센터 배차만 기사를 넣을 수 있습니다'; end if;
  if d.status not in ('requested', 'assigned') then raise exception '운행이 끝난 배차는 기사를 바꿀 수 없습니다'; end if;
  if coalesce(trim(p ->> 'driver_name'), '') = '' and coalesce(trim(p ->> 'vehicle_no'), '') = '' then raise exception '기사 이름이나 차량번호를 넣어 주세요'; end if;
  perform set_config('kk.actor', 'center:' || s, true);
  update dispatches set driver_name = coalesce(nullif(trim(p ->> 'driver_name'), ''), driver_name), driver_phone = coalesce(nullif(trim(p ->> 'driver_phone'), ''), driver_phone),
         vehicle_no = coalesce(nullif(trim(p ->> 'vehicle_no'), ''), vehicle_no), vehicle_ton = coalesce(nullif(p ->> 'vehicle_ton', '')::numeric, vehicle_ton),
         vehicle_body = coalesce(nullif(trim(p ->> 'vehicle_body'), ''), vehicle_body), status = case when status = 'requested' then 'assigned' else status end, updated_by = 'center:' || s
   where id = p_id;
end $$;
revoke all on function center_set_driver(text,text,bigint,jsonb) from public;
grant execute on function center_set_driver(text,text,bigint,jsonb) to anon, authenticated;

-- 주간 한 장 요약(지난주 월~일) — 본사 대시보드 · 월요일 아침 알림
create or replace function weekly_summary(p_end date default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare e date := coalesce(p_end, (date_trunc('week', (now() at time zone 'Asia/Seoul')::date)::date - 1)); b date := e - 6; pb date := b - 7; pe date := b - 1;
begin
  if not (is_staff() or current_user in ('postgres', 'supabase_admin')) then raise exception '본사만 볼 수 있습니다'; end if;
  return jsonb_build_object('from', b, 'to', e,
    'cost', (select coalesce(sum(coalesce(base_fare,0) + coalesce(extra_fare,0) + coalesce(return_fare,0)), 0) from dispatches where deleted_at is null and run_date between b and e and (status in ('done','checked','confirmed') or (status = 'canceled' and coalesce(return_fare,0) > 0))),
    'prev_cost', (select coalesce(sum(coalesce(base_fare,0) + coalesce(extra_fare,0) + coalesce(return_fare,0)), 0) from dispatches where deleted_at is null and run_date between pb and pe and (status in ('done','checked','confirmed') or (status = 'canceled' and coalesce(return_fare,0) > 0))),
    'runs', (select count(*) from dispatches where deleted_at is null and run_date between b and e and status in ('done','checked','confirmed')),
    'by_type', (select coalesce(jsonb_object_agg(type, n), '{}') from (select type, count(*) n from dispatches where deleted_at is null and run_date between b and e and status in ('done','checked','confirmed') group by type) t),
    'no_fare', (select count(*) from dispatches where deleted_at is null and run_date between b and e and status in ('done','checked') and base_fare is null),
    'stale', (select count(*) from dispatches where deleted_at is null and status = 'requested' and run_date <= e),
    'returns', (select count(*) from dispatch_events where kind = 'return' and at::date between b and e),
    'rcv_reports', (select count(*) from rcv_reports where deleted_at is null and rcv_date between b and e),
    'rcv_unseen', (select count(*) from rcv_reports where deleted_at is null and seen_at is null and rcv_date between b and e),
    'fb_open', (select count(*) from feedback where coalesce(status, '접수') not in ('완료', '보류')),
    'errors', (select count(*) from client_errors where at::date between b and e),
    'store_req', (select count(*) from dispatches where origin = 'store' and created_at::date between b and e));
end $$;
revoke all on function weekly_summary(date) from public, anon;
grant execute on function weekly_summary(date) to authenticated;
create or replace function kk_weekly_push() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare w jsonb := weekly_summary(null); pct text;
begin
  pct := case when (w ->> 'prev_cost')::numeric > 0 then to_char(((w ->> 'cost')::numeric / (w ->> 'prev_cost')::numeric - 1) * 100, 'SG990') || '%' else '-' end;
  perform kk_notify(array['staff'], '주간 요약 · ' || to_char((w ->> 'from')::date, 'MM/DD') || '~' || to_char((w ->> 'to')::date, 'MM/DD'),
    '물류비 ' || to_char((w ->> 'cost')::numeric, 'FM999,999,999') || '원(전주 대비 ' || pct || ') · 운행 ' || (w ->> 'runs') || '건 · 금액 빈 운행 ' || (w ->> 'no_fare') || ' · 지난 요청 ' || (w ->> 'stale') || ' · 개선 요청 ' || (w ->> 'fb_open') || ' · 화면 오류 ' || (w ->> 'errors'), '#dash');
end $$;
revoke all on function kk_weekly_push() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'kk-weekly';
    perform cron.schedule('kk-weekly', '41 23 * * 0', 'select public.kk_weekly_push()');   -- 월요일 08:41(한국시간)
  end if;
end $$;

-- 구글드라이브 주간 백업(Apps Script '주간백업')이 받는 대장 — 시트 토큰이 맞을 때만. 연락처는 빼고 보냄
create or replace function sheet_export(p_token text, p_days int default 120) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if p_token is null or p_token <> (select value from app_config where key = 'sheet_token') then raise exception 'token'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'type', type, 'status', status, 'origin', origin, 'run_date', run_date, 'time_slot', time_slot, 'from_place', from_place, 'to_place', to_place,
      'plt_qty', plt_qty, 'temp', temp, 'orderer', orderer, 'driver_name', driver_name, 'vehicle_no', vehicle_no, 'vehicle_ton', vehicle_ton, 'vehicle_body', vehicle_body,
      'base_fare', base_fare, 'extra_fare', extra_fare, 'return_fare', return_fare, 'group_no', group_no, 'cargo_note', cargo_note, 'received_at', received_at, 'updated_at', updated_at) order by run_date, id)
    from dispatches where deleted_at is null and run_date >= current_date - least(greatest(coalesce(p_days, 120), 7), 400)), '[]');
end $$;
revoke all on function sheet_export(text, int) from public;
grant execute on function sheet_export(text, int) to anon;
select 'b64ok' as r;

-- b65: 개선 요청 #10 반영 내용
update feedback set fix_build = '65', fix_note = '출고 · 입고 요청 화면의 날짜가 처음부터 오늘로 잡히도록 바꿨습니다(전에는 내일). 카톡 글 · 캡처를 붙여넣었는데 글에 날짜가 없을 때도 오늘로 채웁니다. 다른 날은 지금처럼 [내일] · [모레] 버튼이나 날짜 칸에서 고르시면 됩니다.' where id = 10 and fix_note is null;

-- =====================================================================
-- b66 — ① 매장 앱 고객배송 요청 → 구글시트 「고객배송내역」의 '앱요청_복사용' 탭(Apps Script가 1시간마다 씀)
--        시트에서 그 줄을 옮겨 적으면 같은 배차로 이어짐(희망일 ±14일 · 연락처 숫자만 비교 · '이천' = '이천점')
--       ② 출고 PLT: 못 읽었거나 고쳐 넣은 사진을 모아 다음 글자 인식 개선에 씀(90일 · 최대 300장)
-- =====================================================================
create or replace function sheet_upsert(p_source text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare x jsonb; r dispatches; vid uuid; ins int := 0; upd int := 0; skip int := 0; st text; seen bigint[] := '{}'; dup int := 0;
begin
  perform set_config('kk.actor', 'sheet:' || p_source, true);
  perform set_config('kk.no_notify', '1', true);
  for x in select * from jsonb_array_elements(p_rows) loop
    select id into vid from vendors where name = x->>'vendor';
    select * into r from dispatches where sheet_key = x->>'key';
    if r.id is null then
      select * into r from dispatches d where d.sheet_key is null and d.status <> 'canceled' and d.type = coalesce(x->>'type','coupang')
         and (case when d.type = 'delivery' then d.run_date between (x->>'run_date')::date - 14 and (x->>'run_date')::date + 14 else d.run_date = (x->>'run_date')::date end)   -- b66: 고객배송은 희망일 ↔ 배송일이 달라도(±14일)
         and (d.from_place = x->>'from_place' or (d.type = 'delivery' and regexp_replace(d.from_place, '점$', '') = regexp_replace(x->>'from_place', '점$', '')))
         and (d.to_place = x->>'to_place' or d.type = 'delivery')
         and (d.type <> 'delivery' or exists (select 1 from dispatch_delivery dd where dd.dispatch_id = d.id and length(regexp_replace(coalesce(dd.customer_phone,''), '\D', '', 'g')) >= 9
              and regexp_replace(dd.customer_phone, '\D', '', 'g') = regexp_replace(coalesce(x->'delivery'->>'customer_phone',''), '\D', '', 'g')))   -- b66: 010-1234-5678 = 01012345678
       order by abs(d.run_date - (x->>'run_date')::date), d.id limit 1;
    end if;
    if r.id is null and position('#' in split_part(x->>'key', ':', 3)) = 0 then   -- b25-a: 겹친 NO.(73#2)로 들어갔던 줄의 NO.를 시트에서 고친 경우 → 그 배차를 이어받음
      select * into r from dispatches d where d.sheet_key like regexp_replace(x->>'key', ':[^:]*$', ':') || '%#%' and d.origin = 'sheet'
         and d.run_date = (x->>'run_date')::date and d.from_place = x->>'from_place' and d.to_place = coalesce(nullif(x->>'to_place',''), d.to_place)
         and not exists (select 1 from jsonb_array_elements(p_rows) y where y->>'key' = d.sheet_key)
       order by d.id limit 1;
    end if;
    if r.id is not null and r.id = any(seen) then dup := dup + 1; continue; end if;   -- b63: 시트에 같은 배차가 두 줄이면 첫 줄만(번갈아 덮어써 '기사 바뀜'이 쌓이던 것)
    if r.id is not null and r.status in ('checked','confirmed') then skip := skip + 1; continue; end if;
    if r.id is not null and r.origin <> 'sheet' then   -- 앱에서 넣은 값 ↔ 시트 값 비교(병행 대조표)
      insert into sync_diffs(dispatch_id, sheet_key, field, app_value, sheet_value)
      select r.id, x->>'key', f.k, f.a, f.b from (values
        ('driver_name', r.driver_name, nullif(x->>'driver_name','')), ('vehicle_no', r.vehicle_no, nullif(x->>'vehicle_no','')),
        ('base_fare', r.base_fare::text, nullif(x->>'base_fare','')), ('extra_fare', nullif(r.extra_fare,0)::text, nullif(nullif(x->>'extra_fare',''),'0')),
        ('plt_qty', trim(trailing '.' from trim(trailing '0' from r.plt_qty::text)), nullif(x->>'plt_qty',''))) f(k, a, b)
      where f.a is not null and f.b is not null and replace(f.a, ' ', '') <> replace(f.b, ' ', '') and not (f.k in ('base_fare','extra_fare','plt_qty') and f.a::numeric = f.b::numeric)
      on conflict do nothing;
    end if;
    st := coalesce(nullif(x->>'status',''), 'requested');
    if r.id is null then
      insert into dispatches(type, status, vendor_id, origin, run_date, time_slot, from_place, to_place, plt_qty, temp, cargo_note, group_no, sheet_key,
                             driver_name, vehicle_no, vehicle_ton, vehicle_body, base_fare, extra_fare, extra_reason, return_date, return_from, return_driver, return_fare, updated_by)
      values (coalesce(x->>'type','coupang'), st, vid, 'sheet', (x->>'run_date')::date, x->>'time_slot', x->>'from_place', coalesce(nullif(x->>'to_place',''),'고객'),
              nullif(x->>'plt_qty','')::numeric, coalesce(nullif(x->>'temp',''),'상온'), x->>'note', x->>'group_no', x->>'key',
              nullif(x->>'driver_name',''), nullif(x->>'vehicle_no',''), nullif(x->>'vehicle_ton','')::numeric, nullif(x->>'vehicle_body',''),
              nullif(x->>'base_fare','')::int, coalesce(nullif(x->>'extra_fare','')::int,0), nullif(x->>'extra_reason',''),
              nullif(x->>'return_date','')::date, nullif(x->>'return_from',''), nullif(x->>'return_driver',''), nullif(x->>'return_fare','')::int, 'sheet:' || p_source)
      returning * into r; ins := ins + 1;
    else
      update dispatches set sheet_key = x->>'key', vendor_id = coalesce(vid, vendor_id), run_date = (x->>'run_date')::date, time_slot = coalesce(nullif(x->>'time_slot',''), time_slot),
        from_place = x->>'from_place', to_place = coalesce(nullif(x->>'to_place',''), to_place), plt_qty = coalesce(nullif(x->>'plt_qty','')::numeric, plt_qty),
        temp = coalesce(nullif(x->>'temp',''), temp), cargo_note = coalesce(nullif(x->>'note',''), cargo_note), group_no = coalesce(nullif(x->>'group_no',''), group_no),
        driver_name = coalesce(nullif(x->>'driver_name',''), driver_name), vehicle_no = coalesce(nullif(x->>'vehicle_no',''), vehicle_no),
        vehicle_ton = coalesce(nullif(x->>'vehicle_ton','')::numeric, vehicle_ton), vehicle_body = coalesce(nullif(x->>'vehicle_body',''), vehicle_body),
        base_fare = coalesce(nullif(x->>'base_fare','')::int, base_fare), extra_fare = coalesce(nullif(x->>'extra_fare','')::int, extra_fare), extra_reason = coalesce(nullif(x->>'extra_reason',''), extra_reason),
        return_date = coalesce(nullif(x->>'return_date','')::date, return_date), return_from = coalesce(nullif(x->>'return_from',''), return_from),
        return_driver = coalesce(nullif(x->>'return_driver',''), return_driver), return_fare = coalesce(nullif(x->>'return_fare','')::int, return_fare),
        status = case when st = 'canceled' then 'canceled' when array_position(array['requested','assigned','done'], st) > array_position(array['requested','assigned','done'], status) then st else status end,
        updated_by = 'sheet:' || p_source
      where id = r.id
        and row(run_date, from_place, to_place, plt_qty, driver_name, vehicle_no, base_fare, extra_fare, return_fare, status, sheet_key)
            is distinct from row((x->>'run_date')::date, x->>'from_place', coalesce(nullif(x->>'to_place',''), to_place), coalesce(nullif(x->>'plt_qty','')::numeric, plt_qty),
                                 coalesce(nullif(x->>'driver_name',''), driver_name), coalesce(nullif(x->>'vehicle_no',''), vehicle_no), coalesce(nullif(x->>'base_fare','')::int, base_fare),
                                 coalesce(nullif(x->>'extra_fare','')::int, extra_fare), coalesce(nullif(x->>'return_fare','')::int, return_fare), status, x->>'key');
      if found then upd := upd + 1; end if;
    end if;
    if x ? 'delivery' then
      insert into dispatch_delivery(dispatch_id, order_date, store, customer_name, customer_phone, address, product, qty, terms, done_note)
      values (r.id, nullif(x->'delivery'->>'order_date','')::date, x->>'from_place', x->'delivery'->>'customer_name', x->'delivery'->>'customer_phone', x->'delivery'->>'address',
              x->'delivery'->>'product', x->'delivery'->>'qty', case when x->'delivery'->>'terms' in ('무료','유료','무료(추가요금)') then x->'delivery'->>'terms' end, x->'delivery'->>'done_note')
      on conflict (dispatch_id) do update set customer_name = excluded.customer_name, customer_phone = excluded.customer_phone, address = excluded.address,
        product = excluded.product, qty = excluded.qty, terms = coalesce(excluded.terms, dispatch_delivery.terms), done_note = excluded.done_note
      where (dispatch_delivery.customer_name, dispatch_delivery.customer_phone, dispatch_delivery.address, dispatch_delivery.product, dispatch_delivery.qty, dispatch_delivery.done_note)
            is distinct from (excluded.customer_name, excluded.customer_phone, excluded.address, excluded.product, excluded.qty, excluded.done_note);
    end if;
  if r.id is not null then seen := seen || r.id; end if;
  end loop;
  insert into app_config(key, value) values ('sheet_sync:' || p_source, to_char(clock_timestamp() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') || format(' · 새 %s · 바뀜 %s · 확정이라 건너뜀 %s', ins, upd, skip) || case when dup > 0 then format(' · 시트 중복 줄 %s', dup) else '' end)
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('inserted', ins, 'updated', upd, 'skipped', skip);
end $$;
select 'b66-a' as r;

create or replace function sheet_app_deliveries(p_token text, p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if p_token is null or p_token <> (select value from app_config where key = 'sheet_token') then raise exception 'token'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'status', d.status, 'run_date', d.run_date, 'store', d.from_place, 'created_at', d.created_at,
      'order_date', coalesce(dd.order_date, (d.created_at at time zone 'Asia/Seoul')::date), 'customer_name', dd.customer_name, 'customer_phone', dd.customer_phone, 'address', dd.address,
      'product', dd.product, 'qty', dd.qty, 'terms', dd.terms, 'elevator', dd.elevator, 'request_note', dd.request_note, 'asap', dd.asap, 'requested_by', dd.requested_by,
      'driver_name', d.driver_name, 'sheet_key', d.sheet_key) order by d.id)
    from dispatches d join dispatch_delivery dd on dd.dispatch_id = d.id
    where d.deleted_at is null and d.type = 'delivery' and d.origin = 'store' and d.created_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 120))), '[]');
end $$;
revoke all on function sheet_app_deliveries(text, int) from public;
grant execute on function sheet_app_deliveries(text, int) to anon;

create table if not exists plt_ocr_miss (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  center text, created_by text,
  read_no text,           -- 앱이 읽은 번호(못 읽었으면 빈 값)
  final_no text,          -- 사람이 고쳐 넣은 번호
  how text,               -- hand(못 읽음) · ocr(글자 읽기) · shot(찍어서 읽기)
  photo text not null     -- jpeg data URL(긴 변 1600px)
);
alter table plt_ocr_miss enable row level security;
drop policy if exists plt_ocr_miss_staff on plt_ocr_miss;
create policy plt_ocr_miss_staff on plt_ocr_miss for select to authenticated using (is_staff());
grant select on plt_ocr_miss to authenticated;

create or replace function plt_miss_add(p_kind text, p_name text, p_pin text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare who text := plt_actor(p_kind, p_name, p_pin); n int;
begin
  insert into plt_ocr_miss(center, created_by, read_no, final_no, how, photo)
  select nullif(p_name, ''), who, left(x->>'read', 60), left(x->>'final', 60), left(x->>'how', 10), x->>'photo'
  from jsonb_array_elements(coalesce(p_rows, '[]')) x
  where x->>'photo' like 'data:image/%' and length(x->>'photo') < 900000
  limit 20;
  get diagnostics n = row_count;
  delete from plt_ocr_miss where created_at < now() - interval '90 days' or id <= (select id from plt_ocr_miss order by id desc offset 300 limit 1);
  return n;
end $$;
revoke all on function plt_miss_add(text, text, text, jsonb) from public;
grant execute on function plt_miss_add(text, text, text, jsonb) to anon, authenticated;
select 'b66ok' as r;

-- =====================================================================
-- b67 — 구글시트 동기화가 멈추면 휴대폰 알림(본사 · 진천센터). 15분마다 확인, 멈춘 동안 한 번만 · 다시 들어오면 '복구' 알림
--   기준: 낙찰건 로케이션(5분마다) 40분 · 쿠팡/고객배송/경산(1시간마다) 2시간 30분 넘게 소식 없음 · 밤 10시~아침 7시는 보내지 않음
--   (2026-11-18 15시 Apps Script 를 다시 붙여넣다 '연결하기'가 실행돼 토큰이 바뀌어 19시간 멈춘 일 — 그때 바로 알았어야 함)
-- =====================================================================
create or replace function kk_sync_watch() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare r record; lim interval; stale text[] := '{}'; was text; hr int := extract(hour from now() at time zone 'Asia/Seoul');
begin
  for r in select key, value, to_timestamp(left(value, 19), 'YYYY-MM-DD HH24:MI:SS') at time zone 'Asia/Seoul' as ts from app_config where key like 'sheet_sync:%' loop
    lim := case when r.key = 'sheet_sync:낙찰건로케이션' then interval '40 minutes' else interval '150 minutes' end;
    if r.ts < now() - lim then
      stale := stale || (replace(r.key, 'sheet_sync:', '') || ' ' || to_char(r.ts at time zone 'Asia/Seoul', 'MM/DD HH24:MI'));
    end if;
  end loop;
  select value into was from app_config where key = 'sync_watch_alert';
  if array_length(stale, 1) > 0 then
    if was is null and hr between 7 and 21 then
      perform kk_notify(array['staff', 'store:진천센터'], '구글시트 동기화 멈춤', '마지막 수신: ' || array_to_string(stale, ' · ') || ' — 낙찰건 · 배차가 앱에 안 들어옵니다. 본사에 알려 주세요', '');
      insert into app_config(key, value) values ('sync_watch_alert', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI')) on conflict (key) do update set value = excluded.value;
      return 'alert';
    end if;
    return 'stale';
  elsif was is not null then
    if was <> 'silent' then perform kk_notify(array['staff', 'store:진천센터'], '구글시트 동기화 복구', '시트 → 앱 동기화가 다시 들어오고 있습니다', ''); end if;
    delete from app_config where key = 'sync_watch_alert';
    return 'recovered';
  end if;
  return 'ok';
end $$;
revoke all on function kk_sync_watch() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'kk-sync-watch';
    perform cron.schedule('kk-sync-watch', '*/15 * * * *', 'select public.kk_sync_watch()');
  end if;
end $$;
-- 처음 적용 때는 이미 알고 있는 멈춤(11/19 복구 중)이라 알림 없이 지나가게
insert into app_config(key, value) values ('sync_watch_alert', 'silent') on conflict (key) do nothing;
select 'b67ok' as r;

-- =====================================================================
-- b68 — 진천센터 담당자 여러 명이 한 계정으로: 기기마다 담당자 이름(박혜미 · 김혜연 · 새로 추가)
--   · 입고 사진 보고: 사람마다 '내가 안 본 것'(views: 이름 → 본 사진 수) · [확인]은 한 번, 누가 했는지 seen_by 에 이름까지
--   · 확인한 뒤 매장이 사진을 더 올리면 seen_n(확인 때 사진 수) < n_photos 로 다시 '사진 추가됨'
-- =====================================================================
alter table rcv_reports add column if not exists views jsonb not null default '{}';
alter table rcv_reports add column if not exists seen_n integer;
update rcv_reports set seen_n = n_photos where seen_at is not null and seen_n is null;

create or replace function center_people(p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform center_check(p_name, p_pin);
  return coalesce((select value::jsonb from app_config where key = 'center_people:' || p_name), '[]');
end $$;
create or replace function center_person_add(p_name text, p_pin text, p_person text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare L jsonb; n text := left(regexp_replace(trim(coalesce(p_person, '')), '\s+', ' ', 'g'), 12);
begin
  perform center_check(p_name, p_pin);
  if length(n) < 2 then raise exception '이름을 2글자 이상 넣어 주세요'; end if;
  L := coalesce((select value::jsonb from app_config where key = 'center_people:' || p_name), '[]');
  if not L ? n then
    if jsonb_array_length(L) >= 20 then raise exception '담당자는 20명까지입니다'; end if;
    L := L || to_jsonb(n);
    insert into app_config(key, value) values ('center_people:' || p_name, L::text) on conflict (key) do update set value = excluded.value;
  end if;
  return L;
end $$;
-- 사진을 열어 본 사람 기록(그 사람의 '내가 안 본 것'에서 빠짐)
create or replace function rcv_viewed(p_kind text, p_name text, p_pin text, p_id bigint, p_person text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare n text := left(trim(coalesce(p_person, '')), 12);
begin
  if p_kind = 'store' then return; end if;
  perform rcv_actor(p_kind, p_name, p_pin);
  if n = '' then return; end if;
  update rcv_reports set views = views || jsonb_build_object(n, n_photos)
   where id = p_id and deleted_at is null and (p_kind = 'staff' or center = p_name) and coalesce((views ->> n)::int, -1) <> n_photos;
end $$;
-- [확인] — 누가 했는지 이름까지(매장 화면엔 '센터 확인'만)
create or replace function rcv_seen_by(p_kind text, p_name text, p_pin text, p_id bigint, p_on boolean, p_person text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare a text; n text := left(trim(coalesce(p_person, '')), 12);
begin
  if p_kind = 'store' then raise exception '권한이 없습니다'; end if;
  a := rcv_actor(p_kind, p_name, p_pin);
  update rcv_reports set seen_at = case when p_on then now() end, seen_by = case when p_on then a || case when n <> '' then ' · ' || n else '' end end,
         seen_n = case when p_on then n_photos end,
         views = case when p_on and n <> '' then views || jsonb_build_object(n, n_photos) else views end
   where id = p_id and deleted_at is null and (p_kind = 'staff' or center = p_name);
end $$;
revoke all on function center_people(text,text), center_person_add(text,text,text), rcv_viewed(text,text,text,bigint,text), rcv_seen_by(text,text,text,bigint,boolean,text) from public;
grant execute on function center_people(text,text), center_person_add(text,text,text), rcv_viewed(text,text,text,bigint,text), rcv_seen_by(text,text,text,bigint,boolean,text) to anon, authenticated;
insert into app_config(key, value) values ('center_people:진천센터', '["박혜미","김혜연"]') on conflict (key) do nothing;
select 'b68ok' as r;

-- =====================================================================
-- b69 — 매장 관리(매장 계정 만들기 · PIN · 앱 열기/닫기 · 사용 중지 · 삭제 · 신선 · 연락처 고치기)는 진천센터(허브)만
--   콜드체인센터 등 다른 센터는 목록 · 연락처 보기만(배차 요청 때 매장 이름 · 연락처가 필요). 바꿀 일은 진천센터에 요청
-- =====================================================================
create or replace function store_mgr_actor(p_kind text, p_name text, p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_kind = 'center' then
    perform center_check(p_name, p_pin);
    if p_name <> kk_hub() then raise exception '매장 관리는 %에서만 할 수 있습니다 — 매장 추가 · 변경은 %에 요청해 주세요', kk_hub(), kk_hub(); end if;
    return 'center:' || p_name;
  elsif is_staff() then return coalesce(auth.jwt() ->> 'email', 'staff');
  else raise exception '권한이 없습니다'; end if;
end $$;
-- 목록은 모든 센터가 봄(보기만)
create or replace function store_mgr_list(p_kind text, p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_kind = 'center' then perform center_check(p_name, p_pin); else perform store_mgr_actor(p_kind, p_name, p_pin); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('name', name, 'active', active, 'app_open', app_open, 'fresh', fresh, 'created_by', created_by, 'updated_at', updated_at,
                                                       'contact_name', contact_name, 'contact_phone', contact_phone, 'contact_note', contact_note) order by name)
                     from stores where kind = 'store' and deleted_at is null), '[]');
end $$;
select 'b69ok' as r;

-- b70: 개선 요청 #11 · #12 · #13 반영 내용(fix_note) 기록 — 앱 코드만 바뀜(이천센터 도착지 · PLT 사진 여러 장 2단계 읽기)

-- =====================================================================
-- b78 — 앱(PIN 화면 = anon) 서버 시간 제한 3초 → 8초(본사 로그인과 같게). 2026-11-23 월요일 아침 진천센터 시간 초과 4번
alter role anon set statement_timeout = '8s';
notify pgrst, 'reload config';

-- ============================================================
-- b80 (2026-11-23): 시트 NO. 칸이 비어 r줄번호로 들어간 배차에 나중에 NO.를 넣으면 같은 배차를 이어받음(중복 생성 방지) · 라이브 적용함
-- ============================================================
create or replace function sheet_upsert(p_source text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare x jsonb; r dispatches; vid uuid; ins int := 0; upd int := 0; skip int := 0; st text; seen bigint[] := '{}'; dup int := 0;
begin
  perform set_config('kk.actor', 'sheet:' || p_source, true);
  perform set_config('kk.no_notify', '1', true);
  for x in select * from jsonb_array_elements(p_rows) loop
    select id into vid from vendors where name = x->>'vendor';
    select * into r from dispatches where sheet_key = x->>'key';
    if r.id is null then
      select * into r from dispatches d where d.sheet_key is null and d.status <> 'canceled' and d.type = coalesce(x->>'type','coupang')
         and (case when d.type = 'delivery' then d.run_date between (x->>'run_date')::date - 14 and (x->>'run_date')::date + 14 else d.run_date = (x->>'run_date')::date end)   -- b66: 고객배송은 희망일 ↔ 배송일이 달라도(±14일)
         and (d.from_place = x->>'from_place' or (d.type = 'delivery' and regexp_replace(d.from_place, '점$', '') = regexp_replace(x->>'from_place', '점$', '')))
         and (d.to_place = x->>'to_place' or d.type = 'delivery')
         and (d.type <> 'delivery' or exists (select 1 from dispatch_delivery dd where dd.dispatch_id = d.id and length(regexp_replace(coalesce(dd.customer_phone,''), '\D', '', 'g')) >= 9
              and regexp_replace(dd.customer_phone, '\D', '', 'g') = regexp_replace(coalesce(x->'delivery'->>'customer_phone',''), '\D', '', 'g')))   -- b66: 010-1234-5678 = 01012345678
       order by abs(d.run_date - (x->>'run_date')::date), d.id limit 1;
    end if;
    if r.id is null and position('#' in split_part(x->>'key', ':', 3)) = 0 then   -- b25-a: 겹친 NO.(73#2)로 들어갔던 줄의 NO.를 시트에서 고친 경우 → 그 배차를 이어받음
      select * into r from dispatches d where d.sheet_key like regexp_replace(x->>'key', ':[^:]*$', ':') || '%#%' and d.origin = 'sheet'
         and d.run_date = (x->>'run_date')::date and d.from_place = x->>'from_place' and d.to_place = coalesce(nullif(x->>'to_place',''), d.to_place)
         and not exists (select 1 from jsonb_array_elements(p_rows) y where y->>'key' = d.sheet_key)
       order by d.id limit 1;
    end if;
    if r.id is null and split_part(x->>'key', ':', 3) !~ '^r[0-9]+$' then   -- b80: NO. 칸이 비어 'r줄번호'로 들어갔던 줄에 나중에 NO.를 넣은 경우 → 그 배차를 이어받음(중복 생성 방지)
      select * into r from dispatches d where split_part(d.sheet_key, ':', 1) = split_part(x->>'key', ':', 1) and split_part(d.sheet_key, ':', 2) = split_part(x->>'key', ':', 2) and split_part(d.sheet_key, ':', 3) ~ '^r[0-9]+$' and d.origin = 'sheet' and d.deleted_at is null
         and d.type = coalesce(x->>'type','coupang') and d.run_date = (x->>'run_date')::date and d.from_place = x->>'from_place' and d.to_place = coalesce(nullif(x->>'to_place',''), d.to_place)
         and d.plt_qty is not distinct from nullif(x->>'plt_qty','')::numeric
         and not exists (select 1 from jsonb_array_elements(p_rows) y where y->>'key' = d.sheet_key)
       order by d.id limit 1;
    end if;
    if r.id is not null and r.id = any(seen) then dup := dup + 1; continue; end if;   -- b63: 시트에 같은 배차가 두 줄이면 첫 줄만(번갈아 덮어써 '기사 바뀜'이 쌓이던 것)
    if r.id is not null and r.status in ('checked','confirmed') then skip := skip + 1; continue; end if;
    if r.id is not null and r.origin <> 'sheet' then   -- 앱에서 넣은 값 ↔ 시트 값 비교(병행 대조표)
      insert into sync_diffs(dispatch_id, sheet_key, field, app_value, sheet_value)
      select r.id, x->>'key', f.k, f.a, f.b from (values
        ('driver_name', r.driver_name, nullif(x->>'driver_name','')), ('vehicle_no', r.vehicle_no, nullif(x->>'vehicle_no','')),
        ('base_fare', r.base_fare::text, nullif(x->>'base_fare','')), ('extra_fare', nullif(r.extra_fare,0)::text, nullif(nullif(x->>'extra_fare',''),'0')),
        ('plt_qty', trim(trailing '.' from trim(trailing '0' from r.plt_qty::text)), nullif(x->>'plt_qty',''))) f(k, a, b)
      where f.a is not null and f.b is not null and replace(f.a, ' ', '') <> replace(f.b, ' ', '') and not (f.k in ('base_fare','extra_fare','plt_qty') and f.a::numeric = f.b::numeric)
      on conflict do nothing;
    end if;
    st := coalesce(nullif(x->>'status',''), 'requested');
    if r.id is null then
      insert into dispatches(type, status, vendor_id, origin, run_date, time_slot, from_place, to_place, plt_qty, temp, cargo_note, group_no, sheet_key,
                             driver_name, vehicle_no, vehicle_ton, vehicle_body, base_fare, extra_fare, extra_reason, return_date, return_from, return_driver, return_fare, updated_by)
      values (coalesce(x->>'type','coupang'), st, vid, 'sheet', (x->>'run_date')::date, x->>'time_slot', x->>'from_place', coalesce(nullif(x->>'to_place',''),'고객'),
              nullif(x->>'plt_qty','')::numeric, coalesce(nullif(x->>'temp',''),'상온'), x->>'note', x->>'group_no', x->>'key',
              nullif(x->>'driver_name',''), nullif(x->>'vehicle_no',''), nullif(x->>'vehicle_ton','')::numeric, nullif(x->>'vehicle_body',''),
              nullif(x->>'base_fare','')::int, coalesce(nullif(x->>'extra_fare','')::int,0), nullif(x->>'extra_reason',''),
              nullif(x->>'return_date','')::date, nullif(x->>'return_from',''), nullif(x->>'return_driver',''), nullif(x->>'return_fare','')::int, 'sheet:' || p_source)
      returning * into r; ins := ins + 1;
    else
      update dispatches set sheet_key = x->>'key', vendor_id = coalesce(vid, vendor_id), run_date = (x->>'run_date')::date, time_slot = coalesce(nullif(x->>'time_slot',''), time_slot),
        from_place = x->>'from_place', to_place = coalesce(nullif(x->>'to_place',''), to_place), plt_qty = coalesce(nullif(x->>'plt_qty','')::numeric, plt_qty),
        temp = coalesce(nullif(x->>'temp',''), temp), cargo_note = coalesce(nullif(x->>'note',''), cargo_note), group_no = coalesce(nullif(x->>'group_no',''), group_no),
        driver_name = coalesce(nullif(x->>'driver_name',''), driver_name), vehicle_no = coalesce(nullif(x->>'vehicle_no',''), vehicle_no),
        vehicle_ton = coalesce(nullif(x->>'vehicle_ton','')::numeric, vehicle_ton), vehicle_body = coalesce(nullif(x->>'vehicle_body',''), vehicle_body),
        base_fare = coalesce(nullif(x->>'base_fare','')::int, base_fare), extra_fare = coalesce(nullif(x->>'extra_fare','')::int, extra_fare), extra_reason = coalesce(nullif(x->>'extra_reason',''), extra_reason),
        return_date = coalesce(nullif(x->>'return_date','')::date, return_date), return_from = coalesce(nullif(x->>'return_from',''), return_from),
        return_driver = coalesce(nullif(x->>'return_driver',''), return_driver), return_fare = coalesce(nullif(x->>'return_fare','')::int, return_fare),
        status = case when st = 'canceled' then 'canceled' when array_position(array['requested','assigned','done'], st) > array_position(array['requested','assigned','done'], status) then st else status end,
        updated_by = 'sheet:' || p_source
      where id = r.id
        and row(run_date, from_place, to_place, plt_qty, driver_name, vehicle_no, base_fare, extra_fare, return_fare, status, sheet_key)
            is distinct from row((x->>'run_date')::date, x->>'from_place', coalesce(nullif(x->>'to_place',''), to_place), coalesce(nullif(x->>'plt_qty','')::numeric, plt_qty),
                                 coalesce(nullif(x->>'driver_name',''), driver_name), coalesce(nullif(x->>'vehicle_no',''), vehicle_no), coalesce(nullif(x->>'base_fare','')::int, base_fare),
                                 coalesce(nullif(x->>'extra_fare','')::int, extra_fare), coalesce(nullif(x->>'return_fare','')::int, return_fare), status, x->>'key');
      if found then upd := upd + 1; end if;
    end if;
    if x ? 'delivery' then
      insert into dispatch_delivery(dispatch_id, order_date, store, customer_name, customer_phone, address, product, qty, terms, done_note)
      values (r.id, nullif(x->'delivery'->>'order_date','')::date, x->>'from_place', x->'delivery'->>'customer_name', x->'delivery'->>'customer_phone', x->'delivery'->>'address',
              x->'delivery'->>'product', x->'delivery'->>'qty', case when x->'delivery'->>'terms' in ('무료','유료','무료(추가요금)') then x->'delivery'->>'terms' end, x->'delivery'->>'done_note')
      on conflict (dispatch_id) do update set customer_name = excluded.customer_name, customer_phone = excluded.customer_phone, address = excluded.address,
        product = excluded.product, qty = excluded.qty, terms = coalesce(excluded.terms, dispatch_delivery.terms), done_note = excluded.done_note
      where (dispatch_delivery.customer_name, dispatch_delivery.customer_phone, dispatch_delivery.address, dispatch_delivery.product, dispatch_delivery.qty, dispatch_delivery.done_note)
            is distinct from (excluded.customer_name, excluded.customer_phone, excluded.address, excluded.product, excluded.qty, excluded.done_note);
    end if;
  if r.id is not null then seen := seen || r.id; end if;
  end loop;
  insert into app_config(key, value) values ('sheet_sync:' || p_source, to_char(clock_timestamp() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') || format(' · 새 %s · 바뀜 %s · 확정이라 건너뜀 %s', ins, upd, skip) || case when dup > 0 then format(' · 시트 중복 줄 %s', dup) else '' end)
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('inserted', ins, 'updated', upd, 'skipped', skip);
end $$;

-- ============================================================
-- b84 (2026-11-23) · 라이브 적용함
-- ============================================================
-- b84: center_cost 가 setof 로 1,765줄을 돌려줘 PostgREST 최대 1,000줄에서 잘림 → 최근 건이 빠져 '물류비 이상 없음'으로 보이던 문제. 한 덩어리(jsonb 배열)로 · 빈 칸 빼서 가볍게
drop function if exists center_cost(text, text);
create function center_cost(p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); pl text[] := center_places(s);
begin
  return coalesce((select jsonb_agg(jsonb_strip_nulls(to_jsonb(d) - 'memo' - 'pin_hash') order by d.run_date, d.id)
    from dispatches d where d.deleted_at is null and d.run_date >= current_date - 120
     and center_cost_ok(s, pl, d)), '[]');
end $$;
revoke all on function center_cost(text,text) from public;
grant execute on function center_cost(text,text) to anon, authenticated;

-- ============================================================
-- b85 (2026-11-23): 한 휴대폰에서 여러 매장 · 센터 알림 — push_subs 를 (기기, 받는 곳)마다 한 줄로 · 라이브 적용함
-- ============================================================
alter table public.push_subs drop constraint if exists push_subs_endpoint_key;
alter table public.push_subs add constraint push_subs_endpoint_who_key unique (endpoint, who);
create or replace function push_subscribe(p_kind text, p_name text, p_pin text, p_sub jsonb, p_ua text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare who text;
begin
  if p_kind = 'vendor' then perform vendor_check(p_name, p_pin); who := 'vendor:' || p_name;
  elsif p_kind = 'store' then perform store_check(p_name, p_pin); who := 'store:' || p_name;
  elsif p_kind = 'center' then perform center_check(p_name, p_pin); who := 'store:' || p_name;
  elsif p_kind = 'checker' then perform checker_check(p_name, p_pin); who := 'checker:' || p_name;
  elsif p_kind = 'staff' and is_staff() then who := auth.jwt() ->> 'email';
  else raise exception '권한이 없습니다'; end if;
  insert into push_subs(who, endpoint, sub, ua) values (who, p_sub ->> 'endpoint', p_sub, p_ua)
  on conflict (endpoint, who) do update set sub = excluded.sub, ua = excluded.ua, created_at = now();
end $$;

-- ============================================================
-- b86 (2026-11-23): 센터 → 매장 공지 · 개선 요청 사진 · 라이브 적용함
-- ============================================================
-- b86: 센터 → 매장 공지(매장 첫 화면 맨 위에 기간 동안 노출 · 매장이 [확인]) — store_msgs 에 kind 'notice'
alter table store_msgs add column if not exists pin_until date;
alter table store_msgs add column if not exists ack_at timestamptz;
alter table store_msgs add column if not exists grp uuid;
create index if not exists store_msgs_grp on store_msgs(grp) where grp is not null;
create or replace function center_notice_add(p_name text, p_pin text, p_stores text[], p_title text, p_body text, p_until date) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); st text; n int := 0; g uuid := gen_random_uuid(); t text;
begin
  if coalesce(trim(p_body), '') = '' then raise exception '공지 내용을 적어 주세요'; end if;
  if coalesce(array_length(p_stores, 1), 0) = 0 or array_length(p_stores, 1) > 300 then raise exception '받을 매장을 골라 주세요'; end if;
  if p_until is null or p_until < current_date or p_until > current_date + 120 then raise exception '노출 기간을 확인해 주세요(오늘 ~ 120일)'; end if;
  t := left(coalesce(nullif(trim(p_title), ''), s || ' 공지'), 200);
  foreach st in array p_stores loop
    continue when not exists (select 1 from stores where name = st and deleted_at is null);
    insert into store_msgs(store, in_date, kind, title, body, sent_by, pin_until, grp) values (st, current_date, 'notice', t, left(p_body, 3000), 'center:' || s, p_until, g);
    begin perform kk_notify(array['store:' || st], left('공지 · ' || t, 60), left(p_body, 120), '?s='); exception when others then null; end;
    n := n + 1;
  end loop;
  return n;
end $$;
create or replace function center_notice_list(p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin);
begin
  return coalesce((select jsonb_agg(x order by x->>'at' desc) from (
    select jsonb_build_object('grp', grp, 'at', min(at), 'title', min(title), 'body', min(body), 'pin_until', min(pin_until), 'by', min(sent_by),
      'n', count(*), 'acked', count(*) filter (where ack_at is not null),
      'stores', jsonb_agg(jsonb_build_object('store', store, 'ack_at', ack_at, 'read_at', read_at) order by store)) x
    from store_msgs where kind = 'notice' and grp is not null and at >= now() - interval '90 days'
      and (sent_by = 'center:' || s or s = coalesce((select value from app_config where key = 'hub_center'), '진천센터'))
    group by grp) q), '[]');
end $$;
create or replace function center_notice_end(p_name text, p_pin text, p_grp uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin);
begin
  update store_msgs set pin_until = current_date - 1 where grp = p_grp and kind = 'notice'
    and (sent_by = 'center:' || s or s = coalesce((select value from app_config where key = 'hub_center'), '진천센터'));
end $$;
create or replace function store_notice_ack(p_name text, p_pin text, p_id bigint) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform store_check(p_name, p_pin);
  update store_msgs set ack_at = coalesce(ack_at, now()), read_at = coalesce(read_at, now()) where id = p_id and store = p_name and kind = 'notice';
end $$;
revoke all on function center_notice_add(text,text,text[],text,text,date), center_notice_list(text,text), center_notice_end(text,text,uuid), store_notice_ack(text,text,bigint) from public;
grant execute on function center_notice_add(text,text,text[],text,text,date), center_notice_list(text,text), center_notice_end(text,text,uuid), store_notice_ack(text,text,bigint) to anon, authenticated;
create or replace function store_msgs_mine(p_kind text, p_name text, p_pin text) returns setof store_msgs
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_kind = 'center' then perform center_check(p_name, p_pin); else perform store_check(p_name, p_pin); end if;
  return query select * from store_msgs where store = p_name and (at >= now() - interval '30 days' or (kind = 'notice' and pin_until >= current_date)) order by at desc limit 120;
end $$;

-- b86-2: 개선 요청에 사진 · 캡처(최대 5장) — fb_photos 따로(목록은 가볍게, feedback.n_photos 만)
alter table feedback add column if not exists n_photos int not null default 0;
create table if not exists fb_photos (id bigserial primary key, fb_id bigint not null references feedback(id) on delete cascade, data text not null, created_at timestamptz not null default now());
alter table fb_photos enable row level security;
create index if not exists fb_photos_fb on fb_photos(fb_id);
create or replace function feedback_photo_add(p_kind text, p_name text, p_pin text, p_id bigint, p_data text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare w text := fb_who(p_kind, p_name, p_pin); n int;
begin
  if not exists (select 1 from feedback where id = p_id and who = w) then raise exception '내 요청이 아닙니다'; end if;
  if p_data is null or p_data !~ '^data:image/(jpeg|png|webp);base64,' or length(p_data) > 900000 then raise exception '사진을 확인해 주세요(너무 큼)'; end if;
  select count(*) into n from fb_photos where fb_id = p_id; if n >= 5 then raise exception '사진은 5장까지입니다'; end if;
  insert into fb_photos(fb_id, data) values (p_id, p_data);
  update feedback set n_photos = n + 1 where id = p_id;
  return n + 1;
end $$;
create or replace function feedback_photos(p_kind text, p_name text, p_pin text, p_id bigint) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w text;
begin
  if not (p_kind = 'staff' and is_staff()) then
    w := fb_who(p_kind, p_name, p_pin);
    if not exists (select 1 from feedback where id = p_id and who = w) then raise exception '볼 수 없는 요청입니다'; end if;
  end if;
  return coalesce((select jsonb_agg(data order by id) from fb_photos where fb_id = p_id), '[]');
end $$;
revoke all on function feedback_photo_add(text,text,text,bigint,text), feedback_photos(text,text,text,bigint) from public;
grant execute on function feedback_photo_add(text,text,text,bigint,text), feedback_photos(text,text,text,bigint) to anon, authenticated;

-- b86-fix (2026-11-23 11:45): b85 push_subscribe 의 변수 who 가 열 이름 who 와 겹쳐 'column reference "who" is ambiguous' → 변수 w · on conflict on constraint · 라이브 적용함
create or replace function push_subscribe(p_kind text, p_name text, p_pin text, p_sub jsonb, p_ua text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare w text;
begin
  if p_kind = 'vendor' then perform vendor_check(p_name, p_pin); w := 'vendor:' || p_name;
  elsif p_kind = 'store' then perform store_check(p_name, p_pin); w := 'store:' || p_name;
  elsif p_kind = 'center' then perform center_check(p_name, p_pin); w := 'store:' || p_name;
  elsif p_kind = 'checker' then perform checker_check(p_name, p_pin); w := 'checker:' || p_name;
  elsif p_kind = 'staff' and is_staff() then w := auth.jwt() ->> 'email';
  else raise exception '권한이 없습니다'; end if;
  insert into push_subs(who, endpoint, sub, ua) values (w, p_sub ->> 'endpoint', p_sub, p_ua)
  on conflict on constraint push_subs_endpoint_who_key do update set sub = excluded.sub, ua = excluded.ua, created_at = now();
end $$;

-- ============================================================
-- b90 (2026-11-23) · 라이브 적용함 — 같은 센터가 같은 제목으로 다시 올리면(고쳐 올림) 그 매장의 이전 공지는 내림
create or replace function center_notice_add(p_name text, p_pin text, p_stores text[], p_title text, p_body text, p_until date) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare s text := center_check(p_name, p_pin); st text; n int := 0; g uuid := gen_random_uuid(); t text;
begin
  if coalesce(trim(p_body), '') = '' then raise exception '공지 내용을 적어 주세요'; end if;
  if coalesce(array_length(p_stores, 1), 0) = 0 or array_length(p_stores, 1) > 300 then raise exception '받을 매장을 골라 주세요'; end if;
  if p_until is null or p_until < current_date or p_until > current_date + 120 then raise exception '노출 기간을 확인해 주세요(오늘 ~ 120일)'; end if;
  t := left(coalesce(nullif(trim(p_title), ''), s || ' 공지'), 200);
  foreach st in array p_stores loop
    continue when not exists (select 1 from stores where name = st and deleted_at is null);
    update store_msgs set pin_until = current_date - 1 where store = st and kind = 'notice' and sent_by = 'center:' || s and title = t and pin_until >= current_date;
    insert into store_msgs(store, in_date, kind, title, body, sent_by, pin_until, grp) values (st, current_date, 'notice', t, left(p_body, 3000), 'center:' || s, p_until, g);
    begin perform kk_notify(array['store:' || st], left('공지 · ' || t, 60), left(p_body, 120), '?s='); exception when others then null; end;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ============================================================
-- b91 (2026-11-23) · 라이브 적용함
-- ============================================================
-- b91: 하차지 지정표 — 본사가 자기 엑셀에서 '낙찰 PLT 번호 · 출고센터 · 상차지 · PLT 수량 · 하차지'만 골라 올림(매입금액 등 다른 칸은 브라우저에서 버려 서버로 안 감)
create table if not exists unload_lots (
  id bigint generated always as identity primary key, lot_no text, fc text, load_from text, plt numeric, dest text, note text, ord int,
  updated_by text, updated_at timestamptz not null default now());
alter table unload_lots enable row level security;
create table if not exists unload_lots_hist (id bigint generated always as identity primary key, at timestamptz not null default now(), by text, data jsonb not null);
alter table unload_lots_hist enable row level security;
drop policy if exists staff_all on unload_lots;
create policy staff_all on unload_lots for select to authenticated using (is_staff());
drop policy if exists staff_all on unload_lots_hist;
create policy staff_all on unload_lots_hist for select to authenticated using (is_staff());
create or replace function unload_list(p_kind text, p_name text, p_pin text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if p_kind = 'center' then perform center_check(p_name, p_pin);
  elsif not is_staff() then raise exception '권한이 없습니다'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('lot_no', lot_no, 'fc', fc, 'load_from', load_from, 'plt', plt, 'dest', dest, 'note', note, 'updated_at', updated_at) order by ord, id) from unload_lots), '[]');
end $$;
create or replace function unload_save(p_kind text, p_name text, p_pin text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare by_ text; n int; c text;
begin
  if p_kind = 'center' then c := center_check(p_name, p_pin); if c <> kk_hub() then raise exception '하차지 지정표는 본사 · 진천센터만 올릴 수 있습니다'; end if; by_ := 'center:' || c;
  elsif is_staff() then by_ := coalesce(auth.jwt() ->> 'email', 'staff');
  else raise exception '권한이 없습니다'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception '올릴 줄이 없습니다'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception '한 번에 5,000줄까지 올릴 수 있습니다'; end if;
  insert into unload_lots_hist(by, data) select by_, coalesce(jsonb_agg(to_jsonb(u)), '[]') from unload_lots u;
  delete from unload_lots where true;
  insert into unload_lots(lot_no, fc, load_from, plt, dest, note, ord, updated_by, updated_at)
    select left(nullif(trim(r.v ->> 'lot_no'), ''), 80), left(nullif(trim(r.v ->> 'fc'), ''), 80), left(nullif(trim(r.v ->> 'load_from'), ''), 120),
           case when (r.v ->> 'plt') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then (r.v ->> 'plt')::numeric end,
           left(nullif(trim(r.v ->> 'dest'), ''), 120), left(nullif(trim(r.v ->> 'note'), ''), 300), r.i::int, by_, now()
    from jsonb_array_elements(p_rows) with ordinality r(v, i)
    where coalesce(trim(r.v ->> 'lot_no'), '') <> '' or coalesce(trim(r.v ->> 'dest'), '') <> '';
  get diagnostics n = row_count;
  for c in select name from stores where kind = 'center' and deleted_at is null loop
    begin perform kk_notify(array['store:' || c], '하차지 지정표 업데이트', n || '줄 — 센터 화면 [하차지]에서 보고 엑셀로 받기', '?g='); exception when others then null; end;
  end loop;
  return n;
end $$;
revoke all on function unload_list(text,text,text), unload_save(text,text,text,jsonb) from public;
grant execute on function unload_list(text,text,text), unload_save(text,text,text,jsonb) to anon, authenticated;

-- ============================================================
-- b92 (2026-11-23) · 라이브 적용함 — 하차지 지정표: 진천센터만 보기 · 본사 PC 엑셀에서 자동 동기화(unload_replace 는 대시보드 SQL 전용)
-- ============================================================
alter table unload_lots add column if not exists bid_date date;
alter table unload_lots add column if not exists cate text;
alter table unload_lots alter column plt type text using plt::text;
create or replace function unload_list(p_kind text, p_name text, p_pin text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c text;
begin
  if p_kind <> 'center' then raise exception '하차지 지정표는 진천센터만 볼 수 있습니다'; end if;
  c := center_check(p_name, p_pin); if c <> kk_hub() then raise exception '하차지 지정표는 진천센터만 볼 수 있습니다'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('bid_date', bid_date, 'lot_no', lot_no, 'cate', cate, 'fc', fc, 'plt', plt, 'dest', dest, 'note', note, 'updated_at', updated_at) order by bid_date desc nulls last, ord, id) from unload_lots), '[]');
end $$;
create or replace function unload_replace(p_rows jsonb, p_src text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows'; end if;
  insert into unload_lots_hist(by, data) select p_src, coalesce(jsonb_agg(to_jsonb(u)), '[]') from unload_lots u;
  delete from unload_lots where true;
  insert into unload_lots(bid_date, lot_no, cate, fc, plt, dest, note, ord, updated_by, updated_at)
    select case when (r.v ->> 'bid_date') ~ '^\d{4}-\d{2}-\d{2}$' then (r.v ->> 'bid_date')::date end, left(nullif(trim(r.v ->> 'lot_no'), ''), 80), left(nullif(trim(r.v ->> 'cate'), ''), 60),
           left(nullif(trim(r.v ->> 'fc'), ''), 80), left(nullif(trim(r.v ->> 'plt'), ''), 20), left(nullif(trim(r.v ->> 'dest'), ''), 120), left(nullif(trim(r.v ->> 'note'), ''), 300), r.i::int, p_src, now()
    from jsonb_array_elements(p_rows) with ordinality r(v, i) where coalesce(trim(r.v ->> 'lot_no'), '') <> '' or coalesce(trim(r.v ->> 'dest'), '') <> '';
  get diagnostics n = row_count;
  insert into app_config(key, value) values ('unload_sync', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') || ' · ' || n || '줄 · ' || p_src) on conflict (key) do update set value = excluded.value;
  return n;
end $$;
revoke all on function unload_replace(jsonb, text) from public, anon, authenticated;
revoke all on function unload_save(text,text,text,jsonb) from anon, authenticated;

-- ============================================================
-- b93 (2026-11-23) · 라이브 적용함
-- ============================================================
-- b93: 하차지 변경 이력 — 같은 줄(낙찰일자 · 낙찰 PLT 번호 · 출고센터 · 분류 · 같은 줄 순번)의 하차지가 바뀌면 비고에 '하차지 변경 이전→새것 (MM/DD HH:MI)' · 이후 동기화에도 계속 남김
create or replace function unload_replace(p_rows jsonb, p_src text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int; ts text := to_char(now() at time zone 'Asia/Seoul', 'MM/DD HH24:MI');
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows'; end if;
  insert into unload_lots_hist(by, data) select p_src, coalesce(jsonb_agg(to_jsonb(u)), '[]') from unload_lots u;
  drop table if exists _ul_old;
  create temp table _ul_old on commit drop as
    select bid_date, coalesce(lot_no, '') lot_no, coalesce(fc, '') fc, coalesce(cate, '') cate, dest, note,
           row_number() over (partition by bid_date, coalesce(lot_no, ''), coalesce(fc, ''), coalesce(cate, '') order by ord, id) rn
    from unload_lots;
  delete from unload_lots where true;
  insert into unload_lots(bid_date, lot_no, cate, fc, plt, dest, note, ord, updated_by, updated_at)
  select x.bid_date, nullif(x.lot_no, ''), nullif(x.cate, ''), nullif(x.fc, ''), x.plt, x.dest,
         nullif(concat_ws(' · ', x.note,
           case when o.rn is not null and o.dest is distinct from x.dest
                  then '하차지 변경 ' || coalesce(o.dest, '(없음)') || '→' || coalesce(x.dest, '(없음)') || ' (' || ts || ')' || coalesce(' · ' || substring(o.note from '하차지 변경.*$'), '')
                when o.rn is not null then substring(o.note from '하차지 변경.*$') end), ''),
         x.i, p_src, now()
  from (select y.*, row_number() over (partition by y.bid_date, y.lot_no, y.fc, y.cate order by y.i) rn
        from (select case when (r.v ->> 'bid_date') ~ '^\d{4}-\d{2}-\d{2}$' then (r.v ->> 'bid_date')::date end bid_date,
                     left(coalesce(trim(r.v ->> 'lot_no'), ''), 80) lot_no, left(coalesce(trim(r.v ->> 'cate'), ''), 60) cate, left(coalesce(trim(r.v ->> 'fc'), ''), 80) fc,
                     left(nullif(trim(r.v ->> 'plt'), ''), 20) plt, left(nullif(trim(r.v ->> 'dest'), ''), 120) dest, left(nullif(trim(r.v ->> 'note'), ''), 200) note, r.i::int i
              from jsonb_array_elements(p_rows) with ordinality r(v, i)
              where coalesce(trim(r.v ->> 'lot_no'), '') <> '' or coalesce(trim(r.v ->> 'dest'), '') <> '') y) x
  left join _ul_old o on o.bid_date is not distinct from x.bid_date and o.lot_no = x.lot_no and o.fc = x.fc and o.cate = x.cate and o.rn = x.rn;
  get diagnostics n = row_count;
  insert into app_config(key, value) values ('unload_sync', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') || ' · ' || n || '줄 · ' || p_src) on conflict (key) do update set value = excluded.value;
  return n;
end $$;
revoke all on function unload_replace(jsonb, text) from public, anon, authenticated;

-- ============================================================
-- b94 (2026-11-23) · 라이브 적용함
-- ============================================================
-- b94 속도: to_jsonb(r) - 'photos' 는 사진(base64)을 통째로 꺼낸 뒤 버림 → 칸을 골라 만들기(입고 사진 목록 432ms → 2ms) · 배차 목록 인덱스
create or replace function rcv_list(p_kind text, p_name text, p_pin text, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform rcv_actor(p_kind, p_name, p_pin);
  if p_to - p_from > 400 then raise exception '기간이 너무 깁니다'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'store', r.store, 'center', r.center, 'rcv_date', r.rcv_date, 'cate', r.cate, 'plt_qty', r.plt_qty, 'memo', r.memo,
      'plt_nos', r.plt_nos, 'n_photos', r.n_photos, 'created_by', r.created_by, 'created_at', r.created_at, 'seen_at', r.seen_at, 'seen_by', r.seen_by,
      'deleted_at', r.deleted_at, 'deleted_by', r.deleted_by, 'views', r.views, 'seen_n', r.seen_n) order by r.created_at desc) from rcv_reports r
    where r.deleted_at is null and r.rcv_date between p_from and p_to
      and (p_kind = 'staff' or (p_kind = 'store' and r.store = p_name) or (p_kind = 'center' and r.center = p_name))), '[]');
end $$;
create or replace function plt_out_list(p_kind text, p_name text, p_pin text, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a text := plt_actor(p_kind, p_name, p_pin);
begin
  if p_to - p_from > 400 then raise exception '기간이 너무 깁니다'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'center', o.center, 'out_date', o.out_date, 'store', o.store, 'seq', o.seq, 'plt_no', o.plt_no, 'cate', o.cate, 'remark', o.remark,
      'how', o.how, 'created_by', o.created_by, 'created_at', o.created_at, 'updated_by', o.updated_by, 'updated_at', o.updated_at, 'deleted_at', o.deleted_at, 'deleted_by', o.deleted_by,
      'slip_at', o.slip_at, 'slip_by', o.slip_by, 'has_photo', o.photo is not null) order by o.out_date desc, o.store, o.seq, o.id)
    from plt_out o where o.deleted_at is null and o.out_date between p_from and p_to and (p_kind <> 'center' or o.center = p_name)), '[]');
end $$;
create index if not exists rcv_reports_date on rcv_reports(rcv_date) where deleted_at is null;
create index if not exists plt_out_date on plt_out(out_date) where deleted_at is null;
create index if not exists dispatches_to_created on dispatches(to_place, created_at);
create index if not exists dispatches_from_created on dispatches(from_place, created_at);
create index if not exists dispatches_run_date on dispatches(run_date);
-- ===================================================================
--  build 96 — 직출 알림 중복 정리 · 매장 자동 알림 끔
--   · 시트에서 줄을 지우거나 NO.가 바뀌면 옛 NO. 줄이 DB에 남아 같은 출고가 2번 보이던 문제
--     → 시트를 보낼 때마다, 보낸 기간(오늘-3일 ~ +21일) 안에서 시트에 없는 NO.는 숨김(gone_at). 다시 나타나면 자동 복구
--   · 새 줄 들어올 때 매장에 자동으로 가던 휴대폰 알림 끔 → 센터 · 본사가 [매장 앱으로 전달]로 직접 보냄
-- ===================================================================
alter table direct_ship add column if not exists gone_at timestamptz;

create or replace function direct_push(p_token text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare x jsonb; ins int := 0; upd int := 0; gone int := 0; k text; ds text; prev direct_ship;
  d0 date := (now() at time zone 'Asia/Seoul')::date;
begin
  if p_token is null or p_token <> (select value from app_config where key = 'sheet_token') then raise exception 'token'; end if;
  for x in select * from jsonb_array_elements(p_rows) loop
    k := x->>'key'; ds := direct_store(x->>'dest');
    select * into prev from direct_ship where key = k;
    insert into direct_ship(key, bid_date, no, group_no, bid_no, part, fc, dest, dest_store, plt, cate, direct, in_date, slot, note, updated_at)
    values (k, nullif(x->>'bid_date','')::date, nullif(x->>'no','')::int, x->>'group_no', x->>'bid_no', x->>'part', x->>'fc', x->>'dest', ds, x->>'plt', x->>'cate',
            coalesce((x->>'direct')::boolean, false), nullif(x->>'in_date','')::date, x->>'slot', x->>'note', now())
    on conflict (key) do update set bid_date = excluded.bid_date, no = excluded.no, group_no = excluded.group_no, bid_no = excluded.bid_no, part = excluded.part, fc = excluded.fc,
      dest = excluded.dest, dest_store = excluded.dest_store, plt = excluded.plt, cate = excluded.cate, direct = excluded.direct, in_date = excluded.in_date, slot = excluded.slot, note = excluded.note,
      gone_at = null, updated_at = now()
    where direct_ship.gone_at is not null
       or (direct_ship.fc, direct_ship.dest, direct_ship.plt, direct_ship.cate, direct_ship.direct, direct_ship.in_date, direct_ship.slot, direct_ship.bid_no, direct_ship.group_no)
          is distinct from (excluded.fc, excluded.dest, excluded.plt, excluded.cate, excluded.direct, excluded.in_date, excluded.slot, excluded.bid_no, excluded.group_no);
    if found then if prev.key is null then ins := ins + 1; else upd := upd + 1; end if; end if;
  end loop;
  -- 시트에서 사라진 NO. 숨김(보낸 줄이 20줄 이상일 때만 — 일부만 온 경우 잘못 숨기지 않게)
  if jsonb_array_length(p_rows) >= 20 then
    update direct_ship d set gone_at = now()
    where d.gone_at is null and d.in_date between d0 - 3 and d0 + 21
      and split_part(d.key, ':', 1) = to_char(d0, 'YYYY')
      and not exists (select 1 from jsonb_array_elements(p_rows) r where r->>'key' = d.key);
    get diagnostics gone = row_count;
  end if;
  insert into app_config(key, value) values ('sheet_sync:낙찰건로케이션', to_char(clock_timestamp() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') || format(' · 새 %s · 바뀜 %s · 시트에서 빠짐 %s', ins, upd, gone))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('inserted', ins, 'updated', upd, 'gone', gone);
end $$;
revoke all on function direct_push(text, jsonb) from public;
grant execute on function direct_push(text, jsonb) to anon;

create or replace function direct_list(p_kind text, p_name text, p_pin text, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_kind = 'center' then perform center_check(p_name, p_pin); elsif not is_staff() then raise exception '권한이 없습니다'; end if;
  if p_to - p_from > 62 then raise exception '기간은 두 달까지'; end if;
  return jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(d) - 'gone_at' order by d.in_date, d.dest_store, d.slot, d.no) from direct_ship d where d.in_date between p_from and p_to and d.gone_at is null), '[]'),
    'sent', coalesce((select jsonb_agg(jsonb_build_object('store', m.store, 'in_date', m.in_date, 'at', m.at, 'by', m.sent_by, 'read_at', m.read_at) order by m.at) from store_msgs m where m.kind = 'direct' and m.in_date between p_from and p_to), '[]'));
end $$;
-- ===================================================================
--  build 97 — 하차지 지정표를 구글시트 「낙찰건 로케이션」에서 (시트 고치면 바로)
--   · Apps Script 직출보내기가 p_wide=true 로 최근 45일(낙찰일 기준) 줄까지 보냄 → direct_push 가 하차지표도 다시 만듦
--   · 낙찰NO. · FC · 도착지(=하차지) · PLT수량 · CATE · 낙찰일만 (금액 없음)
--   · 하차지 바뀌면 비고에 '하차지 변경 이전→새것 (시각)' (unload_replace 그대로)
--   · 이후 PC 엑셀(pc:) 동기화는 무시(두 곳이 서로 덮어쓰지 않게) — app_config unload_source = 'sheet'
-- ===================================================================
create or replace function unload_from_sheet() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare j jsonb; n int;
begin
  if exists (select 1 from unload_lots where coalesce(updated_by, '') not like 'sheet:%') then   -- 처음 바꿀 때: PC 엑셀 표는 보관하고 비움(가짜 '하차지 변경' 안 생기게)
    insert into unload_lots_hist(by, data) select 'switch→sheet', coalesce(jsonb_agg(to_jsonb(u)), '[]') from unload_lots u;
    delete from unload_lots where true;
  end if;
  select jsonb_agg(jsonb_build_object('bid_date', coalesce(bid_date, in_date), 'lot_no', coalesce(nullif(bid_no, ''), group_no), 'cate', cate, 'fc', fc, 'plt', plt, 'dest', dest, 'note', '')
                   order by coalesce(bid_date, in_date) desc, no) into j
  from direct_ship where gone_at is null and coalesce(bid_date, in_date) >= (now() at time zone 'Asia/Seoul')::date - 45;
  n := unload_replace(coalesce(j, '[]'), 'sheet:낙찰건 로케이션');
  delete from unload_lots_hist where id not in (select id from unload_lots_hist order by id desc limit 100);
  insert into app_config(key, value) values ('unload_source', 'sheet') on conflict (key) do update set value = excluded.value;
  return n;
end $$;
revoke all on function unload_from_sheet() from public, anon, authenticated;

drop function if exists direct_push(text, jsonb);
create or replace function direct_push(p_token text, p_rows jsonb, p_wide boolean default false) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare x jsonb; ins int := 0; upd int := 0; gone int := 0; k text; ds text; prev direct_ship; un int := null;
  d0 date := (now() at time zone 'Asia/Seoul')::date;
begin
  if p_token is null or p_token <> (select value from app_config where key = 'sheet_token') then raise exception 'token'; end if;
  for x in select * from jsonb_array_elements(p_rows) loop
    k := x->>'key'; ds := direct_store(x->>'dest');
    select * into prev from direct_ship where key = k;
    insert into direct_ship(key, bid_date, no, group_no, bid_no, part, fc, dest, dest_store, plt, cate, direct, in_date, slot, note, updated_at)
    values (k, nullif(x->>'bid_date','')::date, nullif(x->>'no','')::int, x->>'group_no', x->>'bid_no', x->>'part', x->>'fc', x->>'dest', ds, x->>'plt', x->>'cate',
            coalesce((x->>'direct')::boolean, false), nullif(x->>'in_date','')::date, x->>'slot', x->>'note', now())
    on conflict (key) do update set bid_date = excluded.bid_date, no = excluded.no, group_no = excluded.group_no, bid_no = excluded.bid_no, part = excluded.part, fc = excluded.fc,
      dest = excluded.dest, dest_store = excluded.dest_store, plt = excluded.plt, cate = excluded.cate, direct = excluded.direct, in_date = excluded.in_date, slot = excluded.slot, note = excluded.note,
      gone_at = null, updated_at = now()
    where direct_ship.gone_at is not null
       or (direct_ship.fc, direct_ship.dest, direct_ship.plt, direct_ship.cate, direct_ship.direct, direct_ship.in_date, direct_ship.slot, direct_ship.bid_no, direct_ship.group_no, direct_ship.bid_date)
          is distinct from (excluded.fc, excluded.dest, excluded.plt, excluded.cate, excluded.direct, excluded.in_date, excluded.slot, excluded.bid_no, excluded.group_no, excluded.bid_date);
    if found then if prev.key is null then ins := ins + 1; else upd := upd + 1; end if; end if;
  end loop;
  -- 시트에서 사라진 NO. 숨김(20줄 이상 왔을 때만). p_wide = 최근 45일 낙찰 줄까지 다 보낸 경우 → 그 범위도
  if jsonb_array_length(p_rows) >= 20 then
    update direct_ship d set gone_at = now()
    where d.gone_at is null and split_part(d.key, ':', 1) = to_char(d0, 'YYYY')
      and (d.in_date between d0 - 3 and d0 + 21 or (p_wide and coalesce(d.bid_date, d.in_date) >= d0 - 45))
      and not exists (select 1 from jsonb_array_elements(p_rows) r where r->>'key' = d.key);
    get diagnostics gone = row_count;
  end if;
  if p_wide and (ins + upd + gone > 0 or coalesce((select value from app_config where key = 'unload_source'), '') <> 'sheet') then
    un := unload_from_sheet();
  end if;
  insert into app_config(key, value) values ('sheet_sync:낙찰건로케이션', to_char(clock_timestamp() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') || format(' · 새 %s · 바뀜 %s · 시트에서 빠짐 %s%s', ins, upd, gone, case when un is not null then ' · 하차지표 ' || un || '줄' else '' end))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('inserted', ins, 'updated', upd, 'gone', gone, 'unload', un);
end $$;
revoke all on function direct_push(text, jsonb, boolean) from public;
grant execute on function direct_push(text, jsonb, boolean) to anon;

-- PC 엑셀 동기화(pc:)는 구글시트로 바뀐 뒤엔 무시
create or replace function unload_replace(p_rows jsonb, p_src text) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare n int; ts text := to_char(now() at time zone 'Asia/Seoul', 'MM/DD HH24:MI');
begin
  if p_src like 'pc:%' and coalesce((select value from app_config where key = 'unload_source'), '') = 'sheet' then return -1; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows'; end if;
  insert into unload_lots_hist(by, data) select p_src, coalesce(jsonb_agg(to_jsonb(u)), '[]') from unload_lots u;
  drop table if exists _ul_old;
  create temp table _ul_old on commit drop as
    select bid_date, coalesce(lot_no, '') lot_no, coalesce(fc, '') fc, coalesce(cate, '') cate, dest, note,
           row_number() over (partition by bid_date, coalesce(lot_no, ''), coalesce(fc, ''), coalesce(cate, '') order by ord, id) rn
    from unload_lots;
  delete from unload_lots where true;
  insert into unload_lots(bid_date, lot_no, cate, fc, plt, dest, note, ord, updated_by, updated_at)
  select x.bid_date, nullif(x.lot_no, ''), nullif(x.cate, ''), nullif(x.fc, ''), x.plt, x.dest,
         nullif(concat_ws(' · ', x.note,
           case when o.rn is not null and o.dest is distinct from x.dest
                  then '하차지 변경 ' || coalesce(o.dest, '(없음)') || '→' || coalesce(x.dest, '(없음)') || ' (' || ts || ')' || coalesce(' · ' || substring(o.note from '하차지 변경.*$'), '')
                when o.rn is not null then substring(o.note from '하차지 변경.*$') end), ''),
         x.i, p_src, now()
  from (select y.*, row_number() over (partition by y.bid_date, y.lot_no, y.fc, y.cate order by y.i) rn
        from (select case when (r.v ->> 'bid_date') ~ '^\d{4}-\d{2}-\d{2}$' then (r.v ->> 'bid_date')::date end bid_date,
                     left(coalesce(trim(r.v ->> 'lot_no'), ''), 80) lot_no, left(coalesce(trim(r.v ->> 'cate'), ''), 60) cate, left(coalesce(trim(r.v ->> 'fc'), ''), 80) fc,
                     left(nullif(trim(r.v ->> 'plt'), ''), 20) plt, left(nullif(trim(r.v ->> 'dest'), ''), 120) dest, left(nullif(trim(r.v ->> 'note'), ''), 200) note, r.i::int i
              from jsonb_array_elements(p_rows) with ordinality r(v, i)
              where coalesce(trim(r.v ->> 'lot_no'), '') <> '' or coalesce(trim(r.v ->> 'dest'), '') <> '') y) x
  left join _ul_old o on o.bid_date is not distinct from x.bid_date and o.lot_no = x.lot_no and o.fc = x.fc and o.cate = x.cate and o.rn = x.rn;
  get diagnostics n = row_count;
  insert into app_config(key, value) values ('unload_sync', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') || ' · ' || n || '줄 · ' || p_src) on conflict (key) do update set value = excluded.value;
  return n;
end $$;
-- ===================================================================
--  build 100 — 사진 모아보기 속도: 원본(장당 ~100KB) 대신 작은 미리보기(장당 ~6KB)만 먼저
--   · rcv_reports.thumbs = { md5(원본) : 미리보기 }  — 처음 본 사람의 앱이 만들어 올려 두면 다음부터 바로
--   · rcv_gallery_lite: 사진 칸(번호 · 해시 · 미리보기)만 → 큰 사진은 누를 때 rcv_photo_one
-- ===================================================================
alter table rcv_reports add column if not exists thumbs jsonb not null default '{}'::jsonb;

create or replace function rcv_gallery_lite(p_kind text, p_name text, p_pin text, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform rcv_actor(p_kind, p_name, p_pin);
  if p_to - p_from > 62 then raise exception '기간이 너무 깁니다'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'store', r.store, 'center', r.center, 'rcv_date', r.rcv_date, 'cate', r.cate, 'plt_qty', r.plt_qty,
            'memo', r.memo, 'created_at', r.created_at,
            'ph', (select jsonb_agg(jsonb_build_object('i', e.i - 1, 'h', md5(e.v), 't', r.thumbs ->> md5(e.v)) order by e.i) from jsonb_array_elements_text(r.photos) with ordinality e(v, i)))
          order by r.rcv_date desc, r.created_at desc)
    from rcv_reports r where r.deleted_at is null and r.n_photos > 0 and r.rcv_date between p_from and p_to
      and (p_kind = 'staff' or (p_kind = 'store' and r.store = p_name) or (p_kind = 'center' and r.center = p_name))), '[]');
end $$;

create or replace function rcv_photo_one(p_kind text, p_name text, p_pin text, p_id bigint, p_h text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform rcv_actor(p_kind, p_name, p_pin);
  return (select e.v from rcv_reports r, jsonb_array_elements_text(r.photos) e(v)
          where r.id = p_id and r.deleted_at is null and md5(e.v) = p_h
            and (p_kind = 'staff' or (p_kind = 'store' and r.store = p_name) or (p_kind = 'center' and r.center = p_name)) limit 1);
end $$;

create or replace function rcv_thumb_set(p_kind text, p_name text, p_pin text, p_id bigint, p_h text, p_thumb text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform rcv_actor(p_kind, p_name, p_pin);
  if p_thumb !~ '^data:image/(jpeg|webp|png);base64,' or length(p_thumb) > 40000 then raise exception '미리보기 형식'; end if;
  update rcv_reports r set thumbs = r.thumbs || jsonb_build_object(p_h, p_thumb)
   where r.id = p_id and r.deleted_at is null and not (r.thumbs ? p_h)
     and exists (select 1 from jsonb_array_elements_text(r.photos) e(v) where md5(e.v) = p_h)
     and (p_kind = 'staff' or (p_kind = 'store' and r.store = p_name) or (p_kind = 'center' and r.center = p_name));
  return found;
end $$;
grant execute on function rcv_gallery_lite(text,text,text,date,date), rcv_photo_one(text,text,text,bigint,text), rcv_thumb_set(text,text,text,bigint,text,text) to anon, authenticated;
-- ===================================================================
--  build 101 — 저장 공간 관리
--   · 입고사진 원본은 7일 보관 → 지나면 작은 미리보기만 남김(미리보기가 있는 사진만 — 없으면 만들어질 때까지 원본 유지)
--   · 미리보기: 올릴 때 매장 앱이 바로 만들어 올림(rcv_thumb_set_i) + 센터 · 매장 앱이 빠진 것 채움
--   · 일일 대장 백업(ledger_backups)은 최근 30일치만
--   · DB 용량 50% 이상이면 본사(staff)에 하루 한 번 알림 · 본사 설정 화면에 사용량 표시(storage_status)
-- ===================================================================
alter table rcv_reports add column if not exists orig_trimmed_at timestamptz;
insert into app_config(key, value) values ('db_limit_mb', '500') on conflict (key) do nothing;

create or replace function rcv_thumb_set_i(p_kind text, p_name text, p_pin text, p_id bigint, p_items jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare r rcv_reports; x jsonb; v text; n int := 0; add jsonb := '{}'::jsonb;
begin
  perform rcv_actor(p_kind, p_name, p_pin);
  select * into r from rcv_reports where id = p_id and deleted_at is null
    and (p_kind = 'staff' or (p_kind = 'store' and store = p_name) or (p_kind = 'center' and center = p_name));
  if r.id is null then return 0; end if;
  for x in select * from jsonb_array_elements(p_items) loop
    v := r.photos ->> (x->>'i')::int;
    if v is null or length(v) <> (x->>'len')::int then continue; end if;
    if (x->>'t') !~ '^data:image/(jpeg|webp|png);base64,' or length(x->>'t') > 40000 then continue; end if;
    if not (r.thumbs ? md5(v)) then add := add || jsonb_build_object(md5(v), x->>'t'); n := n + 1; end if;
  end loop;
  if n > 0 then update rcv_reports set thumbs = thumbs || add where id = p_id; end if;
  return n;
end $$;
grant execute on function rcv_thumb_set_i(text,text,text,bigint,jsonb) to anon, authenticated;

create or replace function kk_storage_care() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r record; np jsonb; keep int; trimmed int := 0; lb int := 0; sz bigint; lim bigint; pct int; last timestamptz;
begin
  -- 1) 7일 지난 입고사진: 미리보기가 있는 원본 → 미리보기로 바꿈
  for r in select id, photos, thumbs from rcv_reports where orig_trimmed_at is null and created_at < now() - interval '7 days' and jsonb_array_length(coalesce(photos, '[]')) > 0 loop
    select jsonb_agg(coalesce(r.thumbs ->> md5(e.v), e.v) order by e.i), count(*) filter (where not (r.thumbs ? md5(e.v)))
      into np, keep from jsonb_array_elements_text(r.photos) with ordinality e(v, i);
    if np is null then continue; end if;
    update rcv_reports set photos = np,
           thumbs = thumbs || coalesce((select jsonb_object_agg(md5(t.v), t.v) from jsonb_array_elements_text(np) t(v)), '{}')
     where id = r.id and photos is distinct from np;
    if found then trimmed := trimmed + 1; end if;
    if keep = 0 then update rcv_reports set orig_trimmed_at = now() where id = r.id; end if;
  end loop;
  -- 2) 대장 백업은 30일치만
  delete from ledger_backups where day < (now() at time zone 'Asia/Seoul')::date - 30; get diagnostics lb = row_count;
  -- 3) 용량 확인 → 50% 이상이면 본사 알림(하루 한 번)
  sz := pg_database_size(current_database()); lim := coalesce((select value from app_config where key = 'db_limit_mb')::bigint, 500) * 1024 * 1024;
  pct := round(sz * 100.0 / lim);
  insert into app_config(key, value) values ('storage_pct', pct::text) on conflict (key) do update set value = excluded.value;
  last := (select value from app_config where key = 'storage_alert_at')::timestamptz;
  if pct >= 50 and (last is null or last < now() - interval '1 day') then
    perform kk_notify(array['staff'], '⚠ 저장 공간 ' || pct || '% 사용', '서버 저장 공간이 ' || pg_size_pretty(sz) || ' / ' || pg_size_pretty(lim) || ' — 설정 › 저장 공간에서 확인', '#setup');
    insert into app_config(key, value) values ('storage_alert_at', now()::text) on conflict (key) do update set value = excluded.value;
  end if;
  return jsonb_build_object('trimmed', trimmed, 'backups_deleted', lb, 'pct', pct, 'size', pg_size_pretty(sz));
end $$;
revoke all on function kk_storage_care() from public, anon, authenticated;

create or replace function storage_status() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare sz bigint := pg_database_size(current_database()); lim bigint := coalesce((select value from app_config where key = 'db_limit_mb')::bigint, 500) * 1024 * 1024;
begin
  if not is_staff() then raise exception '권한이 없습니다'; end if;
  return jsonb_build_object('size', sz, 'limit', lim, 'pct', round(sz * 100.0 / lim),
    'photos', (select pg_total_relation_size('rcv_reports')), 'backups', (select pg_total_relation_size('ledger_backups')), 'audit', (select pg_total_relation_size('audit_log')),
    'orig_days', 7, 'waiting', (select count(*) from rcv_reports where orig_trimmed_at is null and created_at < now() - interval '7 days' and n_photos > 0 and deleted_at is null));
end $$;
grant execute on function storage_status() to authenticated;

select cron.unschedule('kk-storage') where exists (select 1 from cron.job where jobname = 'kk-storage');
select cron.schedule('kk-storage', '17 * * * *', 'select public.kk_storage_care()');

-- ===================================================================
--  2026-11-24 — 하차지 = PC 엑셀 전용 / 구글시트 「낙찰건 로케이션」 = 직출 알림 전용 (사용자 설계)
--   · build 97의 '시트 → 하차지표' 연결을 끊음: unload_from_sheet()는 아무것도 안 하고 null
--     (direct_push는 그대로 직출만 처리, 하차지표 · unload_source를 건드리지 않음)
--   · unload_source = 'pc' → PC 엑셀(pc:) 동기화가 다시 반영됨(매시간 예약 작업)
-- ===================================================================
create or replace function unload_from_sheet() returns int
language plpgsql security definer set search_path = public, extensions as $$
begin
  return null;  -- 시트는 하차지표를 건드리지 않음(직출 알림만)
end $$;
revoke all on function unload_from_sheet() from public, anon, authenticated;
update app_config set value = 'pc' where key = 'unload_source';

-- ===================================================================
--  2026-11-25 — 하차지 지정표: PC 낙찰 엑셀을 Windows 예약 작업(10분마다)이 직접 서버로 올림
--   · PC: 바탕화면\필요자료\_하차지동기화\kk_unload_push.ps1 (처음한번_설치.bat로 설치)
--   · 토큰 짝짓기: PC가 unload_pair(새 토큰) → 본사가 SQL에서 select unload_pair_approve(); → unload_push(토큰, 줄)
-- ===================================================================
create or replace function unload_pair(p_token text) returns text
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_token is null or length(p_token) < 32 then raise exception 'token'; end if;
  insert into app_config(key, value) values ('unload_token_pending', p_token || '|' || now()::text) on conflict (key) do update set value = excluded.value;
  return '승인 대기';
end $$;
revoke all on function unload_pair(text) from public; grant execute on function unload_pair(text) to anon;

create or replace function unload_pair_approve() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v text := (select value from app_config where key = 'unload_token_pending');
begin
  if v is null or split_part(v, '|', 2)::timestamptz < now() - interval '1 day' then raise exception '승인할 연결 요청이 없습니다'; end if;
  insert into app_config(key, value) values ('unload_token', split_part(v, '|', 1)) on conflict (key) do update set value = excluded.value;
  delete from app_config where key = 'unload_token_pending';
  return '연결됨';
end $$;
revoke all on function unload_pair_approve() from public, anon, authenticated;

create or replace function unload_push(p_token text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if p_token is null or p_token <> coalesce((select value from app_config where key = 'unload_token'), '-') then raise exception 'token'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 10 then raise exception '줄이 너무 적습니다(엑셀을 못 읽은 듯) — 올리지 않음'; end if;
  n := unload_replace(p_rows, 'pc:2026_쿠팡 낙찰금액.xlsx');
  insert into app_config(key, value) values ('unload_push_at', now()::text) on conflict (key) do update set value = excluded.value;
  return n;
end $$;
revoke all on function unload_push(text, jsonb) from public; grant execute on function unload_push(text, jsonb) to anon;

-- ===================================================================
--  build 109 — 🧾 파레트 회수 전표(개선 요청 #23): 매장이 입고사진과 따로 올리고 센터가 따로 보고 [확인]
--   · rcv_reports.kind = 'rcv'(입고사진) | 'pallet'(파레트 회수 전표) — 같은 저장 · 미리보기 · 7일 원본 보관 규칙
-- ===================================================================
alter table rcv_reports add column if not exists kind text not null default 'rcv';

create or replace function rcv_add(p_store text, p_pin text, p jsonb) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare a text := rcv_actor('store', p_store, p_pin); ph jsonb := coalesce(p -> 'photos', '[]'); c text := coalesce(nullif(trim(p ->> 'center'), ''), '진천센터'); nid bigint; x jsonb;
  k text := case when p ->> 'kind' = 'pallet' then 'pallet' else 'rcv' end;
begin
  if jsonb_typeof(ph) <> 'array' or jsonb_array_length(ph) = 0 then raise exception '사진을 한 장 이상 넣어 주세요'; end if;
  if jsonb_array_length(ph) > 40 then raise exception '사진은 한 번에 40장까지 보낼 수 있습니다'; end if;
  for x in select * from jsonb_array_elements(ph) loop if length(x #>> '{}') > 400000 then raise exception '사진이 너무 큽니다'; end if; end loop;
  insert into rcv_reports(store, center, rcv_date, cate, plt_qty, memo, plt_nos, photos, n_photos, created_by, kind)
  values (p_store, c, coalesce((p ->> 'rcv_date')::date, current_date), left(p ->> 'cate', 30), nullif(p ->> 'plt_qty', '')::int, left(p ->> 'memo', 300),
          coalesce((select array_agg(left(v, 60)) from jsonb_array_elements_text(coalesce(p -> 'plt_nos', '[]')) v), '{}'), ph, jsonb_array_length(ph), a, k)
  returning id into nid;
  update rcv_reports set photos = '[]' where photos <> '[]' and created_at < now() - interval '60 days';
  begin
    if k = 'pallet' then
      perform kk_notify(array['store:' || c, 'staff'], '파레트 회수 전표 · ' || p_store, '전표 사진 ' || coalesce(nullif(p ->> 'n_total', ''), jsonb_array_length(ph)::text) || '장' || coalesce(' · ' || nullif(left(p ->> 'memo', 40), ''), ''), '?g=');
    else
      perform kk_notify(array['store:' || c, 'staff'], '입고 사진 · ' || p_store, coalesce(p ->> 'cate', '') || ' ' || coalesce(p ->> 'plt_qty', '?') || 'PLT · 사진 ' || coalesce(nullif(p ->> 'n_total', ''), jsonb_array_length(ph)::text) || '장' || coalesce(' · ' || nullif(left(p ->> 'memo', 40), ''), ''), '?g=');
    end if;
  exception when others then null; end;
  return nid;
end $$;

create or replace function rcv_list(p_kind text, p_name text, p_pin text, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform rcv_actor(p_kind, p_name, p_pin);
  if p_to - p_from > 400 then raise exception '기간이 너무 깁니다'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'store', r.store, 'center', r.center, 'rcv_date', r.rcv_date, 'cate', r.cate, 'plt_qty', r.plt_qty, 'memo', r.memo,
      'plt_nos', r.plt_nos, 'n_photos', r.n_photos, 'created_by', r.created_by, 'created_at', r.created_at, 'seen_at', r.seen_at, 'seen_by', r.seen_by,
      'deleted_at', r.deleted_at, 'deleted_by', r.deleted_by, 'views', r.views, 'seen_n', r.seen_n, 'kind', r.kind) order by r.created_at desc) from rcv_reports r
    where r.deleted_at is null and r.rcv_date between p_from and p_to
      and (p_kind = 'staff' or (p_kind = 'store' and r.store = p_name) or (p_kind = 'center' and r.center = p_name))), '[]');
end $$;

create or replace function rcv_gallery_lite(p_kind text, p_name text, p_pin text, p_from date, p_to date) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform rcv_actor(p_kind, p_name, p_pin);
  if p_to - p_from > 62 then raise exception '기간이 너무 깁니다'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'store', r.store, 'center', r.center, 'rcv_date', r.rcv_date, 'cate', r.cate, 'plt_qty', r.plt_qty,
            'memo', r.memo, 'created_at', r.created_at, 'kind', r.kind,
            'ph', (select jsonb_agg(jsonb_build_object('i', e.i - 1, 'h', md5(e.v), 't', r.thumbs ->> md5(e.v)) order by e.i) from jsonb_array_elements_text(r.photos) with ordinality e(v, i)))
          order by r.rcv_date desc, r.created_at desc)
    from rcv_reports r where r.deleted_at is null and r.n_photos > 0 and r.rcv_date between p_from and p_to
      and (p_kind = 'staff' or (p_kind = 'store' and r.store = p_name) or (p_kind = 'center' and r.center = p_name))), '[]');
end $$;


-- ===================================================================
-- b117 — 기능 사용 감시(와치독): 화면마다 보인 버튼(seen) · 누른 버튼(used)을 하루 단위로 모음 → 본사 '접속 현황'에서 30일 미사용 기능 확인
-- ===================================================================
create table if not exists feature_usage (
  day   date not null,
  who   text not null,
  k     text not null,
  label text,
  seen  int  not null default 0,
  used  int  not null default 0,
  last_used timestamptz,
  primary key (day, who, k)
);
alter table feature_usage enable row level security;
drop policy if exists feature_usage_staff on feature_usage;
create policy feature_usage_staff on feature_usage for select to authenticated using (is_staff());
create or replace function usage_push(p_kind text, p_name text, p_pin text, p_items jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare w text; it jsonb; d date := (now() at time zone 'Asia/Seoul')::date; n int := 0;
begin
  if p_kind = 'vendor' then perform vendor_check(p_name, p_pin); w := 'vendor:' || p_name;
  elsif p_kind = 'store' then perform store_check(p_name, p_pin); w := 'store:' || p_name;
  elsif p_kind = 'center' then perform center_check(p_name, p_pin); w := 'center:' || p_name;
  elsif p_kind = 'checker' then perform checker_check(p_name, p_pin); w := 'checker:' || p_name;
  elsif p_kind = 'staff' and is_staff() then w := 'staff';
  else raise exception '권한이 없습니다'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    n := n + 1; exit when n > 300;
    continue when coalesce(it ->> 'k', '') = '';
    insert into feature_usage(day, who, k, label, seen, used, last_used)
    values (d, w, left(it ->> 'k', 80), left(it ->> 'l', 60), least(coalesce((it ->> 's')::int, 0), 1000), least(coalesce((it ->> 'u')::int, 0), 1000),
            case when coalesce((it ->> 'u')::int, 0) > 0 then now() end)
    on conflict (day, who, k) do update set label = coalesce(nullif(excluded.label, ''), feature_usage.label),
      seen = feature_usage.seen + excluded.seen, used = feature_usage.used + excluded.used,
      last_used = coalesce(excluded.last_used, feature_usage.last_used);
  end loop;
  if random() < 0.01 then delete from feature_usage where day < d - 400; end if;
end $$;
revoke all on function usage_push(text,text,text,jsonb) from public;
grant execute on function usage_push(text,text,text,jsonb) to anon, authenticated;
select 'b117ok-' || count(*) as r from pg_proc where proname = 'usage_push';
