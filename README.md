# 킹콩 물류 배차·정산 (프로토타입)

쿠팡 출고요청 · 센터/본사 요청 · 고객 배송 3가지 배차를 **한 통합 대장**에 모으고,
외주 업체(태성로지스틱스, 더한물류 …)는 **링크 + PIN** 으로 휴대폰에서 기사 · 차량 · 청구금액을 입력하는 웹앱입니다.

```
kk-dispatch/
├─ index.html          화면(스타일 포함)
├─ app.js              동작 전부(관리자 화면 + 업체 모바일 화면)
├─ config.js           Supabase 연결값 — 비워 두면 데모 모드
└─ supabase/schema.sql DB 테이블 · 보안 · 업체용 함수
```

## 1. 지금 바로 써 보기 (데모 모드, 5분)

1. 이 폴더를 새 GitHub 저장소(예: `kingkong-dispatch`)에 올립니다. GitHub Desktop: File › Add local repository → Publish.
2. 저장소 Settings › Pages › Branch `main` / `(root)` → Save.
3. 1~2분 뒤 `https://<계정>.github.io/kingkong-dispatch/` 가 열립니다.
   - 관리자 화면: 그 주소 그대로
   - 업체 화면: `…/kingkong-dispatch/?v=태성로지스틱스` (PIN 2580) · `?v=더한물류` (PIN 1357)
4. 데모 모드는 **이 브라우저에만** 저장됩니다. 다른 사람과 공유하려면 2단계로.

## 2. 실제 운영 (Supabase 연결, 30분)

1. https://supabase.com 에서 새 프로젝트(Region: Seoul). 무료 요금제로 충분합니다(500MB DB).
2. SQL Editor › New query 에 `supabase/schema.sql` 전체를 붙여넣고 **Run**.
3. 같은 SQL Editor 에서 업체 · 관리자를 등록합니다(PIN 은 업체에 따로 알려 주세요).
   ```sql
   insert into vendors(name, pin_hash, types) values ('태성로지스틱스', crypt('여기PIN', gen_salt('bf')), '{coupang,center}');
   insert into vendors(name, pin_hash, types) values ('더한물류',       crypt('여기PIN', gen_salt('bf')), '{center,delivery}');
   insert into staff(email, name) values ('ldj0120@kinggo.ai', '이동주');
   ```
4. Authentication › URL Configuration › Site URL 에 GitHub Pages 주소를 넣습니다(로그인 메일 링크가 돌아올 곳).
5. Project Settings › API 에서 `Project URL` 과 `anon public` 키를 `config.js` 에 붙여넣고 커밋 · 푸시.
6. 관리자는 이메일을 넣으면 오는 로그인 링크로 들어가고, 업체에는 `?v=업체이름` 링크 + PIN 을 보냅니다.

### 지점 · 운임표 초기 데이터
설정 화면에서 하나씩 넣거나, SQL 로 한 번에 넣습니다.
```sql
insert into places(name, kind, aliases) values
 ('시흥3','쿠팡FC','{}'), ('여주2','쿠팡FC','{}'), ('진천센터','센터','{}'),
 ('시그니처용인점','매장','{용인점}'), ('인천 11번가','외부업체','{}');
insert into rate_cards(vendor_id, type, to_place, base_fare)
 select id, 'coupang', '광주센터', 200000 from vendors where name = '태성로지스틱스';
```

### 기존 구글시트 · 엑셀 옮기기
각 시트를 CSV 로 내려받아 Supabase › Table Editor › `dispatches` › Insert › Import CSV.
열 이름을 아래처럼 맞추면 됩니다.

| 원본 열 | dispatches 열 |
| --- | --- |
| 운행일자 · 날짜 · 배송일자 | run_date |
| 상차지 / 출고매장 | from_place |
| 하차지 (고객배송은 `고객`) | to_place |
| PLT수량 · 파레트수량 | plt_qty (숫자만, '냉장'은 temp 로) |
| 기사이름 · 기사성함 | driver_name |
| 차량번호 | vehicle_no |
| 차량톤수 ('3.5톤초장축냉동탑') | vehicle_ton = 3.5, vehicle_body = 초장축냉동탑 |
| 기본운임 · 추가운임 · 추가운임내용 | base_fare · extra_fare · extra_reason |
| 청구금액(유형 2) | base_fare (추가운임 0) |
| 회차일자 · 상차지 · 기사이름 · 회차금액 | return_date · return_from · return_driver · return_fare |
| 고객배송의 주문일자 · 주문자 · 연락처 · 주소 · 제품 · 수량 · 배송조건 · 비고 | dispatch_delivery 표 |

`type` 은 `coupang` / `center` / `delivery`, 지난 자료는 `status` 를 `confirmed` 로 넣습니다.

## 3. 보안 구조
- 테이블은 RLS 로 잠겨 있어 **로그인한 킹콩 관리자(staff 표에 있는 이메일)만** 직접 읽고 씁니다.
- 업체는 테이블에 직접 닿지 않고, PIN 을 확인하는 함수 4개(`vendor_list` · `vendor_save` · `vendor_add` · `vendor_refs`)로만 자기 업체 건을 봅니다.
- PIN 은 bcrypt 로 저장. 바꾸려면 `update vendors set pin_hash = crypt('새PIN', gen_salt('bf')) where name = '…';`
- 정산 확정(`confirmed`)된 건은 업체가 고칠 수 없고, 모든 수정은 `audit_log` 에 남습니다.
- 고객 개인정보는 `dispatch_delivery` 에 따로 있고 고객배송을 맡은 업체에만 보입니다.

## 4. 운영 체크리스트
- 매일: 대시보드 `배차 대기` · `금액 미입력` 0건 확인
- 반월 · 월말: 정산 탭 → 업체별 `운임표 초과` · `업체 직접 등록` 확인 → 정산 확정 → 운행내역서 CSV 를 업체와 대조
- 백업: Supabase 무료 요금제는 자동 백업이 없으니 월 1회 Table Editor › Export CSV (또는 Pro 요금제 일일 백업)

## 5. 알려진 한계 (프로토타입)
- 업체 추가 · PIN 변경은 아직 SQL 로만 합니다.
- 지점 별칭은 저장만 되고, 입력 시 자동 치환은 다음 단계입니다.
- 카카오 알림톡 · 문자 알림, 거래명세서 PDF 는 포함하지 않았습니다.
