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
  name        text not null unique,              -- 태성로지스틱스, 더한물류 …
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
                check (status in ('requested','assigned','done','confirmed','canceled')),
  vendor_id     uuid references vendors(id),
  origin        text not null default 'kingkong' check (origin in ('kingkong','vendor')), -- 업체가 직접 올린 건 = vendor
  -- 킹콩이 요청할 때 채우는 칸
  run_date      date not null,                   -- 운행(상차) 예정일
  time_slot     text,                            -- 오전 · 오후 · 야간
  from_place    text not null,
  to_place      text not null,
  plt_qty       numeric,                         -- 파레트 수량(대형파렛 · 개수 단위는 cargo_note)
  temp          text not null default '상온' check (temp in ('상온','냉장','냉동')),
  cargo_note    text,                            -- 품목 · 특이사항
  ref_code      text,                            -- 쿠팡 입차CODE · Group Number 등
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
  done_note      text                            -- '6/24 완료 / 중문 탈거 후 안착'
);

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

create table if not exists audit_log (
  id          bigint generated always as identity primary key,
  dispatch_id bigint references dispatches(id) on delete cascade,
  actor       text not null,                     -- 이메일 또는 'vendor:태성로지스틱스'
  action      text not null,                     -- insert · update · status
  diff        jsonb,
  at          timestamptz not null default now()
);

-- ---------- 운임표 자동 매칭 · 수정 기록 ----------
create or replace function dispatches_before_write() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
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

-- ---------- 보안(RLS) ----------
alter table vendors           enable row level security;
alter table places            enable row level security;
alter table rate_cards        enable row level security;
alter table staff             enable row level security;
alter table dispatches        enable row level security;
alter table dispatch_delivery enable row level security;
alter table settlements       enable row level security;
alter table audit_log         enable row level security;

create or replace function is_staff() returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from staff where email = auth.jwt() ->> 'email');
$$;

do $$ declare t text; begin
  foreach t in array array['vendors','places','rate_cards','staff','dispatches','dispatch_delivery','settlements','audit_log'] loop
    execute format('drop policy if exists staff_all on %I', t);
    execute format('create policy staff_all on %I for all to authenticated using (is_staff()) with check (is_staff())', t);
  end loop;
end $$;

-- ---------- 업체용 함수(링크 + PIN). anon 은 이 함수들만 부를 수 있다 ----------
create or replace function vendor_check(p_vendor text, p_pin text) returns uuid
language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid;
begin
  select id into v from vendors
   where name = p_vendor and active and pin_hash = crypt(p_pin, pin_hash);
  if v is null then raise exception 'PIN이 맞지 않습니다'; end if;
  return v;
end $$;

-- 업체 화면 목록: 자기 업체 건 + 아직 업체가 정해지지 않은 요청(맡을 유형만), 최근 45일
create or replace function vendor_list(p_vendor text, p_pin text)
returns setof jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin); vt text[];
begin
  select types into vt from vendors where id = v;
  return query
    select to_jsonb(d) - 'memo' || jsonb_build_object(
             'delivery', (select jsonb_build_object('store', x.store, 'customer_name', x.customer_name,
                            'customer_phone', x.customer_phone, 'address', x.address, 'product', x.product,
                            'qty', x.qty, 'terms', x.terms, 'done_note', x.done_note)
                          from dispatch_delivery x where x.dispatch_id = d.id))
      from dispatches d
     where d.status <> 'canceled'
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
    return_date  = nullif(p->>'return_date','')::date,
    return_from  = p->>'return_from',
    return_driver= p->>'return_driver',
    return_fare  = nullif(p->>'return_fare','')::int,
    status       = case when coalesce(p->>'status','') in ('assigned','done') then p->>'status' else 'assigned' end,
    updated_by   = 'vendor:' || p_vendor
  where id = p_id returning * into r;
  if r.type = 'delivery' and p ? 'done_note' then
    update dispatch_delivery set done_note = p->>'done_note' where dispatch_id = p_id;
  end if;
  insert into audit_log(dispatch_id, actor, action, diff) values (p_id, 'vendor:' || p_vendor, 'update', p);
  return to_jsonb(r);
end $$;

-- 업체가 요청 없이 직접 운행한 건 올리기(유형 2에서 흔함) → origin='vendor', 킹콩이 확인
create or replace function vendor_add(p_vendor text, p_pin text, p jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin); r dispatches;
begin
  insert into dispatches(type, status, vendor_id, origin, run_date, from_place, to_place, plt_qty, temp, cargo_note,
                         driver_name, driver_phone, vehicle_no, vehicle_ton, vehicle_body, base_fare, extra_fare, extra_reason, updated_by)
  values (coalesce(p->>'type','center'), 'done', v, 'vendor', (p->>'run_date')::date, p->>'from_place', p->>'to_place',
          nullif(p->>'plt_qty','')::numeric, coalesce(p->>'temp','상온'), p->>'cargo_note',
          p->>'driver_name', p->>'driver_phone', p->>'vehicle_no', nullif(p->>'vehicle_ton','')::numeric, p->>'vehicle_body',
          nullif(p->>'base_fare','')::int, coalesce(nullif(p->>'extra_fare','')::int,0), p->>'extra_reason', 'vendor:' || p_vendor)
  returning * into r;
  insert into audit_log(dispatch_id, actor, action, diff) values (r.id, 'vendor:' || p_vendor, 'insert', p);
  return to_jsonb(r);
end $$;

-- 업체 화면의 자동완성(지점 · 운임표)
create or replace function vendor_refs(p_vendor text, p_pin text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid := vendor_check(p_vendor, p_pin);
begin
  return jsonb_build_object(
    'places', (select coalesce(jsonb_agg(name order by name), '[]') from places where active),
    'rates',  (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from rate_cards r where r.vendor_id = v or r.vendor_id is null));
end $$;

revoke all on function vendor_check(text,text) from public;
grant execute on function vendor_list(text,text), vendor_save(text,text,bigint,jsonb),
                         vendor_add(text,text,jsonb), vendor_refs(text,text) to anon, authenticated;

-- 업체 등록(관리자가 SQL Editor 에서 실행): PIN 은 업체에 따로 전달
-- insert into vendors(name, pin_hash, types) values ('태성로지스틱스', crypt('2580', gen_salt('bf')), '{coupang,center}');
-- insert into vendors(name, pin_hash, types) values ('더한물류',       crypt('1357', gen_salt('bf')), '{center,delivery}');
-- insert into staff(email, name) values ('ldj0120@kinggo.ai', '이동주');

-- ---------- 대시보드용 집계 뷰 ----------
create or replace view v_monthly_cost as
select settle_month, type, vendor_id, count(*) as runs,
       sum(billed_amount) as billed, sum(coalesce(return_fare,0)) as return_fare,
       sum(case when rate_fare is not null then billed_amount - rate_fare end) as over_rate
  from dispatches where status <> 'canceled'
 group by 1,2,3;
