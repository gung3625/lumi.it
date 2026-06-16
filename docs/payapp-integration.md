# PayApp 정기결제 연동 스펙 (lumi)

> 1차 source: https://docs.payapp.kr/dev_center01.html — 2026-06-16 정독 확정.
> 목적: 월 19,900원 Pro 단일 구독을 PayApp **정기결제(자동청구)** 로 처리.
> 백엔드 = Netlify Functions(Node.js), DB = Supabase.

## 환경변수 (Netlify, 모든 컨텍스트 — 값은 절대 코드/로그/커밋에 노출 금지)
| 이름 | 용도 | 요청 param |
|---|---|---|
| `PAYAPP_USERID` | 판매자 로그인 ID | `userid` (모든 요청) |
| `PAYAPP_LINKKEY` | 연동 KEY | `linkkey` (모든 요청) |
| `PAYAPP_LINKVAL` | 연동 VALUE | 요청에 안 보냄 — **콜백 위변조 검증 전용**. 로그 금지 |

## 공통 규약
- Endpoint: `https://api.payapp.kr/oapi/apiLoad.html`
- 방식: HTTPS **POST**, `application/x-www-form-urlencoded`, UTF-8
- **응답은 JSON 아님 → 쿼리스트링.** `new URLSearchParams(text)` 로 파싱.
- 성공/실패 판별: `state=1` 성공 / `state=0` 실패(`errno`, `errorMessage` 확인).

## 연동 방식 (JS vs REST — 우리는 REST)
PayApp 정기결제는 **JS API**(프론트 자바스크립트 래퍼 `PayApp.rebill()` 로 결제창 호출)와 **REST API** 두 가지.
우리는 **REST** 채택 — 백엔드(Netlify Functions)라 `linkkey` 등 시크릿을 서버에 두고 `rebillRegist`→`payurl` 리다이렉트. JS 방식 미사용.
- '정기결제 요청 연동 구성' 탭 = JS/REST 택1 안내. **별도 사전신청 절차는 문서에 없음**(콘솔 확인 대상).
- '정기결제 승인' 탭 = **`rebillStart`**(일시정지 `rebillStop` 해제). 등록 후 별도 필수 단계 아님.

## 1. 구독 시작 — `rebillRegist`  → 함수 `payapp-subscribe` (Bearer 인증, 셀러)
요청 param: `cmd=rebillRegist`, `userid`, `linkkey`, `goodname=루미 Pro 월 구독`, `goodprice=19900`,
`recvphone`(셀러 전화), `rebillCycleType=Month`, `rebillCycleMonth=1`(생략 금지), `rebillExpire=2099-12-31`,
`feedbackurl=https://lumi.it.kr/api/payapp-webhook`(결제완료 Noti), `failurl=https://lumi.it.kr/api/payapp-webhook`(정기결제 실패 Noti, 2회차+),
`returnurl=https://lumi.it.kr/dashboard`, `openpaytype=card`, `var1=<seller uuid>`, `checkretry=y`
응답: `state`, `rebill_no`(구독 식별자 — **DB 저장 필수**), `payurl`(셀러 리다이렉트 URL)

흐름:
1. 서버가 `rebillRegist` 호출 → `rebill_no` + `payurl` 수신, seller에 `pending` + rebill_no 저장
2. 프론트가 `payurl` 로 리다이렉트 → PayApp 결제창에서 카드 입력 + 최초 1회 승인 (**카드번호는 우리가 안 받음**)
3. 승인 완료 → PayApp이 `feedbackurl` 로 콜백(`pay_state=4`) → 구독 active
4. 이후 매월 `rebillCycleMonth` 일에 자동청구 → 매번 콜백

## 2. 콜백 — `feedbackurl`(성공)·`failurl`(실패)  → 함수 `payapp-webhook` (POST, **공개**, 인증 없음)
둘 다 같은 엔드포인트로 받고 `pay_state` 로 분기. PayApp이 보내는 주요 필드: `userid` `linkkey` `linkval`
`price` `pay_state` `pay_type` `mul_no`(**멱등키 — 매 청구마다 새 값**) `rebill_no`(**구독 식별자 — 불변**) `var1` `var2` `pay_date`

검증/처리 순서:
1. `userid==env && linkkey==env && linkval==env` (timing-safe 비교, 해시 없음) → 아니면 `200 'FAIL'`
2. seller 식별(`var1` 우선, 없으면 `rebill_no`). 매칭 실패 → 감사기록 후 `200 'SUCCESS'`
3. **pay_state=4 (성공)**: `price==19900` 검증(아니면 `200 'FAIL'`) → 구독 `active` (활성화 먼저, 감사기록 best-effort)
4. **pay_state=99 (정기결제 실패, 2회차+)**: 현재 `active` 면 `past_due` 로 (cancelled/stopped 보존)
5. 그 외 pay_state: 단순 `200 'SUCCESS'` ack
6. 멱등: `mul_no` PK 감사 insert(23505=중복콜백 무시). 응답 **`HTTP 200` + body `SUCCESS`**(아니면 재통보)

`pay_state`: 1=요청 **4=완료(최초등록+자동청구)** 8/32=요청취소 9/64=승인취소 10=대기 70/71=부분취소 **99=정기결제 실패**
`pay_type`: 1=카드 6=계좌 7=가상계좌 15=카카오 16=네이버 17=빌키 23=애플 25=토스

## 3. 해지 / 중지 / 재개 / 단건취소
| 기능 | cmd | 필수 param | 함수 |
|---|---|---|---|
| 해지(복구불가) | `rebillCancel` | userid, linkkey, rebill_no | `payapp-cancel` |
| 일시정지 | `rebillStop` | userid, linkkey, rebill_no | `payapp-resume`(stop) |
| 재개 | `rebillStart` | userid, linkkey, rebill_no | `payapp-resume`(start) |
| 단건취소(정산전) | `paycancel` | userid, linkkey, mul_no, cancelmemo | (옵션) |

> 일시중단은 반드시 `rebillStop`↔`rebillStart`. `rebillCancel` 은 복구 불가라 혼용 금지.

## DB 마이그레이션 (✅ 적용완료 — `payapp_subscription_columns_and_events`)
```
-- sellers 구독 컬럼 (subscription_status 엔 CHECK 미설정 — 활성화 UPDATE silent-fail 방지)
ALTER TABLE sellers ADD COLUMN subscription_status text NOT NULL DEFAULT 'none';  -- none|pending|active|past_due|stopped|cancelled
ALTER TABLE sellers ADD COLUMN payapp_rebill_no text;       -- 구독 식별자(rebill_no)
ALTER TABLE sellers ADD COLUMN payapp_last_mul_no text;     -- 마지막 처리 청구(mul_no)
ALTER TABLE sellers ADD COLUMN subscription_started_at timestamptz;
ALTER TABLE sellers ADD COLUMN subscription_cancelled_at timestamptz;
ALTER TABLE sellers ADD COLUMN next_billing_date date;
-- 콜백 멱등/감사: mul_no PK (중복 콜백 = PK 충돌). raw 는 linkval·linkkey·userid 제외 저장.
CREATE TABLE payapp_events (
  mul_no text PRIMARY KEY,
  rebill_no text,
  seller_id uuid,
  pay_state int,
  pay_type int,
  price int,
  var1 text,
  raw jsonb,
  created_at timestamptz DEFAULT now()
);  -- deny-all RLS (service role 전용)
```

## 구현 주의 / 함정
- 응답 JSON 아님 → `URLSearchParams`.
- `rebillCycleMonth` 명시 필수(생략 시 기본 결제일 미정의).
- `linkval` 절대 로그 금지(직접 비교 방식이라 노출=위변조 가능).
- 콜백 멱등 필수(최대 10회 재시도). `mul_no` PK 로 보장.
- `paycancel`/`rebillCancel` 등은 `linkkey` 만, `linkval` 불필요.

## 라이브 전 PayApp 계정 확인 필요 (문서에 명시 없어 콘솔/고객센터 확인)
- [ ] **테스트/샌드박스 모드** 유무 (없으면 첫 테스트가 실카드 실청구).
- [ ] **정기결제 기능 별도 신청** 여부.

> 자동청구 실패는 문서 확인됨: `failurl` 로 `pay_state=99` Noti(1회차 승인 실패는 통지 안 함) → webhook 이 `past_due` 처리.

## 법무 (전자상거래법 — 자동 정기결제)
- pricing: "가입 후 1:1 안내" → **구독 버튼 + 자동결제 고지**.
- terms/privacy: 자동 정기결제·갱신 고지, **해지 수단 명시**, 카드정보는 PayApp이 처리(우리 미저장) 표기.
