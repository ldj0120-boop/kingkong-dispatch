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
     where (d.status <> 'canceled' or d.updated_at >= now() - interval '3 days')
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
             'driver_name', d.driver_name, 'driver_phone', d.driver_phone, 'vehicle_no', d.vehicle_no,
             'vendor', (select name from vendors v where v.id = d.vendor_id),
             'receipts', (select count(*) from attachments a where a.dispatch_id = d.id),
             'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'reason', e.reason, 'note', e.note) order by e.at), '[]') from dispatch_events e where e.dispatch_id = d.id),
             'delivery', (select to_jsonb(x) - 'dispatch_id' from dispatch_delivery x where x.dispatch_id = d.id))
      from dispatches d
     where d.type = 'delivery' and d.from_place = s and d.created_at >= now() - interval '90 days'
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
   where id = p_id and type = 'delivery' and from_place = s and status = 'requested';
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
     where d.run_date >= current_date - 45 and d.status in ('assigned','done','checked','confirmed')
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
