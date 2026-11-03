# 킹콩 물류 배차·정산 (프로토타입)

쿠팡 출고요청 · 센터/본사 요청 · 고객 배송 3가지 배차를 **한 통합 대장**에 모으는 웹앱입니다.
**카톡 · 엑셀로 일하던 방식은 그대로** 두고, 그 글을 붙여넣으면 칸이 채워집니다. 저장하면 열려 있는 모든 화면이 바로 바뀝니다.

| 누가 | 주소 | 하는 일 |
| --- | --- | --- |
| 킹콩 관리자(PC) | 그대로 | 카톡 요청 글 · 쿠팡 출고요청서 표 · 카톡 '대화 내보내기' 파일 붙여넣기 → 요청 등록 + 업체 글(배차 · 취소 · 회차 · 변경) 반영, 대시보드 · 대장 · 정산 |
| 외주 업체(휴대폰) | `?v=업체이름` + PIN | 단톡방에 보낸 글 그대로 붙여넣기(또는 직접 입력) · 기사 취소/회차/변경 버튼 · '카톡 보내기'로 같은 양식 문구 공유 |
| 매장(휴대폰) | `?s=매장이름` + 매장 PIN | 배송요청서 항목 입력 + 영수증 사진 첨부 → 배차 · 배송일 · 기사 바로 확인. 종이 요청서 · 확인서는 매장 보관 |

### 배차 이력(타임라인)
건마다 `요청 → 배차 → 배차 취소/회차/변경 → 재배차 → 운행 완료` 가 누가 · 언제 · 어떤 기사 · 무슨 사유로 남습니다.
카톡의 "취소입니다 재배차 하겠습니다", "상차지연으로 회차 입니다" 를 붙여넣거나 버튼으로 남기면 됩니다.
회차금액을 적으면 정산에 들어갑니다(요청이 끝내 취소돼도 회차비는 정산).

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
   - 매장 화면: `…/kingkong-dispatch/?s=이천점` (PIN 1111) · `?s=시그니처인천점` (2222)
   - 데모에서도 같은 브라우저의 탭끼리는 실시간으로 맞춰집니다(업체 탭에서 저장 → 관리자 탭이 바뀜)
4. 데모 모드는 **이 브라우저에만** 저장됩니다. 다른 사람과 공유하려면 2단계로.

## 2. 실제 운영 (Supabase 연결, 30분)

1. https://supabase.com 에서 새 프로젝트(Region: Seoul). 무료 요금제로 충분합니다(500MB DB).
2. SQL Editor › New query 에 `supabase/schema.sql` 전체를 붙여넣고 **Run**.
3. 같은 SQL Editor 에서 업체 · 관리자를 등록합니다(PIN 은 업체에 따로 알려 주세요).
   ```sql
   insert into vendors(name, pin_hash, types) values ('태성로지스틱스', crypt('여기PIN', gen_salt('bf')), '{coupang,center}');
   insert into vendors(name, pin_hash, types) values ('더한물류',       crypt('여기PIN', gen_salt('bf')), '{center,delivery}');
   insert into staff(email, name) values ('ldj0120@kinggo.ai', '이동주');
   insert into stores(name, pin_hash) values ('이천점', crypt('매장PIN', gen_salt('bf'))), ('시그니처인천점', crypt('매장PIN', gen_salt('bf')));
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

## 5. 카톡과 함께 쓰는 법
- 카톡 단톡방 메시지를 자동으로 읽어 오는 공식 기능은 없어(카카오 미제공 · 비공식 봇은 계정 정지 위험) **복사 → 붙여넣기 한 번**이 남습니다.
- 반대로 앱 → 카톡은 '카톡 보내기/카톡 문구' 버튼(휴대폰은 공유창, PC는 복사)으로 지금 쓰는 양식 그대로 보냅니다.
- 알아듣는 글: `진천센터~이천점 18plt` · `기흥센터- 이천점2plt 경유 원주점2plt` · 출고요청서 표 줄 · `[차주정보]/[차량정보]` 양식 · `상차지 : / 기사명 : / 차종 :` 양식 · `그룹넘버` · `취소입니다 재배차` · `…으로 회차 입니다` · `하차지 …로 변경`.
- 쿠팡 건은 **그룹넘버**로 요청과 업체 글을 자동 연결하고, 없으면 상·하차지 + 날짜로 찾습니다. 화면에서 고칠 수 있습니다.

## 6. 알려진 한계 (프로토타입)
- 영수증 사진은 DB에 줄여서(약 150KB) 저장합니다. 월 수천 장이 되면 Supabase Storage 로 옮기세요. 데모는 브라우저 공간 때문에 최근 12장만 둡니다.
- 붙여넣기로 들어온 '배차' 시각은 반영한 시각, '취소 · 회차' 시각은 카톡 메시지 시각으로 남습니다.
- 업체 추가 · PIN 변경은 아직 SQL 로만 합니다.
- 지점 별칭은 저장만 되고, 입력 시 자동 치환은 다음 단계입니다.
- 카카오 알림톡 · 문자 알림, 거래명세서 PDF 는 포함하지 않았습니다.
