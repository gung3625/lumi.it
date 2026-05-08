# Lumi — Meta App Review 제출 패키지

> 최종 업데이트: 2026-05-08
> 앱 ID: 1233639725586126
> 대상 플랫폼: Instagram Graph API (Business)
> 서비스 URL: https://lumi.it.kr
> 카테고리: Business
>
> **이 문서 한 장으로 Meta App Review 제출 끝까지 갈 수 있다.**
> **사용자가 직접 해야 할 외부 작업은 §10 "사용자 액션 체크리스트"에 모두 정리됨 (예상 1시간).**

---

## 1. App Settings 체크리스트

| 항목 | 값 | 상태 |
|------|-----|------|
| App Domains | `lumi.it.kr` | 설정 필요 |
| Privacy Policy URL | `https://lumi.it.kr/privacy` | 페이지 존재 확인됨 |
| Terms of Service URL | `https://lumi.it.kr/terms` | 페이지 존재 확인됨 |
| Data Deletion URL | `https://lumi.it.kr/privacy#data-deletion` | 앵커 존재 확인됨 (`id="data-deletion"`) |
| App Category | Business | 설정 필요 |
| App Icon 1024×1024 PNG | — | **미보유 — 제작 필요** |
| App Icon 192×192 | — | **미보유 — 제작 필요** |
| App Icon 512×512 | — | **미보유 — 제작 필요** |
| Business Verification | 사업자등록번호 404-09-66416 | **미제출 — 아래 안내 참조** |

### Business Verification 제출 항목

- 사업자등록번호: 404-09-66416
- 통신판매업 신고번호: 제2024-서울용산-1166호
- 대표자: 김현
- 주소: 서울 용산구 회나무로 32-7
- 연락처: 010-6424-6284
- 이메일: gung3625@gmail.com
- 제출 서류:
  - 사업자등록증 사본 (PDF 또는 JPG, 1MB 이상 8MB 이하 권장)
  - 통신판매업 신고증 사본 (PDF 또는 JPG)
  - 대표자 본인 확인 서류 (운전면허증 또는 주민등록증 — Meta가 필요 시 추가 요청)

> Meta Business Verification은 business.facebook.com → Business Settings → Security Center → Business Verification 경로에서 신청. Developer Console에서도 동일 흐름 진입 가능.
> 영문 회사명·주소가 필요할 수 있음 (사업자등록증의 영문 정보 또는 별도 영문 표기). 사전에 준비.

---

## 2. Permissions Use Case Description (영어)

> Meta 심사 폼에 직접 붙여넣을 영문 원고. 각 권한별 독립 섹션.

### `instagram_business_basic`

```
Lumi enables small business owners in Korea to automate their Instagram
posting workflow. We need basic account access to identify the connected
Instagram Business account, fetch the username, profile picture, and
account ID, and verify the account is properly linked to a Facebook Page.
This is the minimal scope required for the seller to confirm the right
Instagram account is connected before any content is published. Without
this permission we cannot display account details on the settings screen
or validate the OAuth link was successful.
```

### `instagram_business_content_publish`

```
Sellers upload product photos inside Lumi; our AI generates Korean
captions and hashtags, and the seller then either publishes immediately
or schedules the post via a calendar UI. The content_publish scope is
the core capability of Lumi — without it no content can be posted on the
seller's behalf. All publishing is explicitly initiated by the seller
(manual click or a scheduled job they pre-configured). We first upload
the image as a media container, then call the publish endpoint, and store
the returned post ID for insight tracking. No content is posted without
an authenticated seller session.
```

### `instagram_business_manage_insights`

```
After a post is published via Lumi, the seller's dashboard displays
post-level performance metrics: impressions, reach, likes, and saves.
This read-only scope lets us fetch insights for posts that the seller
authorised us to publish. We do not collect insights for posts created
outside of Lumi. Insights are shown exclusively to the account owner on
their private dashboard and are never shared with third parties.
```

### `instagram_business_manage_comments`

```
For posts published via Lumi, sellers can read incoming comments and
send replies directly from the Lumi dashboard, enabling them to manage
customer interactions in one place without switching apps. All reply
actions are explicitly initiated by the seller. We do not auto-reply or
moderate comments autonomously. This scope is only exercised on posts
that were created through Lumi's publish flow.
```

### `pages_show_list`

```
When a seller connects their Facebook account during onboarding, Lumi
needs to enumerate their Facebook Pages to identify which Page is linked
to their Instagram Business account. This is required by the Instagram
Graph API — an Instagram Business Account must be connected to a Facebook
Page, and we surface the list so the seller can select the correct Page
during the one-time setup flow.
```

### `pages_read_engagement`

```
Lumi reads basic engagement metadata (Page name, category, verification
status) from the linked Facebook Page to display it on the settings screen
and confirm the Page–Instagram link is intact. No Page posts are created
or modified by Lumi.
```

---

## 3. 시연 영상 시나리오 (Demo Video)

> 총 권장 길이: 5–7분. MP4, 100 MB 이하.
> 화면 하단에 현재 사용 중인 권한 이름을 자막으로 표시할 것.

### 0:00–0:30 — 온보딩 · OAuth 연결
- `https://lumi.it.kr/signup` 진입 화면 표시
- 카카오 로그인 → 매장 정보 입력 단계
- "Instagram 비즈니스 계정 연결" 버튼 클릭
- Meta OAuth 팝업 → 권한 동의 화면 (권한 목록 모두 보이도록 스크롤)
- 콜백 처리 → `/.netlify/functions/ig-oauth` 리다이렉트
- `settings.html` → Instagram 카드 "연결됨" 상태 표시
- **자막**: `pages_show_list`, `instagram_business_basic`

### 0:30–2:00 — 사진 업로드 + AI 캡션 생성
- `/dashboard` 또는 `/register-product` 진입
- 상품 사진 1장 드래그 앤 드롭
- AI 캡션 자동 생성 (타이핑 효과 표시)
- 해시태그 자동 추가 확인
- "캡션 재생성" 클릭 → 다른 톤 결과 표시
- **자막**: 이 단계는 API 권한 미사용 (내부 AI 처리)

### 2:00–3:30 — 즉시 게시
- "지금 게시" 선택 후 클릭
- 게시 중 로딩 표시 → 백엔드 `process-and-post-background` 호출
- Instagram Graph API 미디어 컨테이너 생성 → publish 단계
- 게시 성공 토스트 표시
- (split screen) 실제 Instagram 앱에서 게시물 확인
- **자막**: `instagram_business_content_publish`

### 3:30–4:30 — 게시 후 인사이트
- 대시보드 인사이트 카드 또는 `/dashboard` 포스트 상세 화면
- 해당 게시물의 impressions, reach, likes, saves 수치 표시
- (가능하면) API 호출 네트워크 탭 캡처로 Graph API 인사이트 응답 확인
- **자막**: `instagram_business_manage_insights`

### 4:30–5:30 — 댓글 관리
- 게시물 댓글 리스트 화면 표시
- 댓글 1건 선택 → 답글 작성 → 전송
- (split screen) 실제 Instagram 앱에서 답글 반영 확인
- **자막**: `instagram_business_manage_comments`

### 5:30–6:30 — 데이터 삭제
- `settings.html` → 계정 섹션 → "회원 탈퇴" 버튼 클릭 (또는)
- `https://lumi.it.kr/privacy#data-deletion` 페이지 표시
- Instagram 연결만 해제: `settings.html` → Instagram → "연결 해제" 버튼 (`disconnect-ig` 함수 호출)
- 연결 해제 후 settings 카드 상태 변경 확인
- **자막**: 데이터 삭제 정책 URL 표시

---

## 4. Test User Credentials (심사관용)

> Meta 심사관은 자체 테스트 IG 계정을 사용한다. Lumi 서비스 계정 1개만 제공하면 된다.

| 항목 | 값 | 비고 |
|------|-----|------|
| Lumi 테스트 계정 이메일 | **직접 입력 필요** | 카카오 로그인 계정 또는 별도 이메일 테스트 계정 |
| Lumi 테스트 계정 비밀번호 | **직접 입력 필요** | — |
| 테스트 IG 계정 | Meta 자체 테스트 계정 사용 | Lumi 측 제공 불필요 |

### 테스트 계정 준비 절차

1. `https://lumi.it.kr/signup` 에서 이메일/비밀번호 기반 계정 신규 생성 (카카오 미사용)
2. 매장 정보 입력 완료 (상태: 온보딩 완료)
3. Instagram 연결 **미완료 상태로 제출** (심사관이 자체 IG 계정으로 직접 연결 테스트)
4. 계정 정보를 심사 폼 "Test User" 섹션에 입력

---

## 5. 스크린샷 체크리스트

첨부 스크린샷은 심사 폼 각 권한 섹션의 "Screenshots" 탭에 업로드.

- [ ] `/signup` 진입 화면 (서비스 설명 + 로그인 버튼)
- [ ] Meta OAuth 동의 화면 (권한 목록 전체가 보이도록 스크롤)
- [ ] `settings.html` → Instagram 카드 "연결됨" 상태 (`instagram_business_basic`)
- [ ] `/dashboard` 또는 `/register-product` 사진 업로드 + 캡션 생성 화면
- [ ] 즉시 게시 후 성공 토스트 + 실제 IG 게시물 split 화면 (`instagram_business_content_publish`)
- [ ] 인사이트 수치 (impressions, reach, likes) 표시 화면 (`instagram_business_manage_insights`)
- [ ] 댓글 리스트 + 답글 작성 UI (`instagram_business_manage_comments`)
- [ ] `https://lumi.it.kr/privacy#data-deletion` 섹션 (data deletion URL 작동 증명)
- [ ] `settings.html` → Instagram "연결 해제" 버튼 (토큰 revoke 증명)

---

## 6. 심사 거절 대응 가이드

| 거절 사유 | 대응 |
|-----------|------|
| "Use case is unclear" | 한국 소상공인 인스타 자동화 플랫폼임을 명시. 페르소나: 1인 카페·음식점 사장이 스마트폰으로 상품 사진 찍어 바로 게시. |
| "Demo video not showing all permissions" | 영상 각 구간 자막에 권한 이름 표시. 위 시나리오 5개 구간 모두 녹화 필수. |
| "Privacy policy missing data deletion" | `https://lumi.it.kr/privacy#data-deletion` URL 직접 링크. 앵커 작동 확인됨. |
| "Business verification needed" | 사업자등록번호 404-09-66416 + 사업자등록증 + 통신판매업 신고증 사진 첨부. |
| "Test credentials not working" | 이메일 로그인 계정으로 재시도. 카카오 로그인은 한국 전화번호 인증이 필요할 수 있어 심사관 접근 불가. |
| "App not accessible" | Netlify 배포 상태 확인. `https://lumi.it.kr` HTTPS 접근 가능 여부 사전 확인. |

---

## 7. 제출 전 사전 검증 체크리스트

> 제출 당일 모두 직접 확인 후 체크. 담당: 김현

### 페이지 렌더링
- [ ] `https://lumi.it.kr/privacy` 정상 렌더 (HTTP 200)
- [ ] `https://lumi.it.kr/privacy#data-deletion` 앵커 스크롤 이동 (`id="data-deletion"` 존재 확인됨)
- [ ] `https://lumi.it.kr/terms` 정상 렌더 (HTTP 200)

### OAuth 흐름
- [ ] `/.netlify/functions/ig-oauth?action=start` (또는 settings.html 연결 버튼) → Meta OAuth 시작
- [ ] OAuth 콜백 `/.netlify/functions/ig-oauth` → 코드 수신 → 토큰 교환 → Supabase Vault 저장 → `settings.html` 리다이렉트
- [ ] settings.html Instagram 카드 "연결됨" 표시

### 게시 흐름
- [ ] `/api/process-and-post` 또는 background 함수 정상 동작 — 실제 IG 게시 성공 (post_id 반환)
- [ ] 예약 게시 (`scheduled-promo-publisher`) 정상 동작

### 인사이트 · 댓글
- [ ] 인사이트 fetch 함수 정상 응답 (impressions, reach 값 반환)
- [ ] 댓글 fetch 정상 응답
- [ ] 댓글 답글 전송 성공 → IG 반영 확인

### 데이터 삭제
- [ ] `settings.html` → "회원 탈퇴" → `account-delete` 함수 → Supabase row 삭제 + 토큰 revoke 확인
- [ ] `disconnect-ig` 함수 → IG 토큰 Vault 삭제 + ig_accounts row 연결 해제 확인

---

## 8. 제출 절차 요약

1. `https://developers.facebook.com` → My Apps → Lumi 앱 선택 (App ID: 1233639725586126)
2. 좌측 메뉴: App Review → Permissions and Features
3. 각 권한별 "Request" 클릭 후 순서대로 진행:
   - `instagram_business_basic`
   - `instagram_business_content_publish`
   - `instagram_business_manage_insights`
   - `instagram_business_manage_comments`
   - `pages_show_list`
   - `pages_read_engagement`
4. 각 권한마다:
   - "How are you using this permission?" → 위 섹션 2의 영문 텍스트 붙여넣기
   - "Upload a screencast or demo video" → 위 시나리오 기준 MP4 업로드 (100 MB 이하)
   - "Screenshots" → 위 섹션 5 스크린샷 첨부
5. "Test User Credentials" 섹션 입력 (섹션 4 참조)
6. Business Verification 완료 확인 (미완료 시 심사 불가)
7. Submit for Review
8. 심사 기간: 평균 5–10 영업일

---

## 9. 코드 구현 참조 (Internal)

> 심사 제출과 무관. 개발 참조용.

| 권한 | 구현 함수 | 경로 |
|------|-----------|------|
| OAuth 시작/콜백 | `ig-oauth.js` | `/.netlify/functions/ig-oauth` |
| 게시 | `process-and-post-background.js` | background function |
| 예약 게시 | `scheduled-promo-publisher.js` | `/api/scheduled-promo-publisher` |
| 인사이트 | (구현 확인 필요) | — |
| 댓글 | (구현 확인 필요) | — |
| IG 연결 해제 | `disconnect-ig.js` | `/.netlify/functions/disconnect-ig` |
| 회원 탈퇴 | `account-delete.js` | `/.netlify/functions/account-delete` |

> `ig-oauth.js` 코드의 SCOPES 값은 신규 명칭으로 업데이트 완료.
> Meta App Review 신청 권한과 실제 요청 스코프가 일치해야 통과 가능.
> 현재 SCOPES (검증됨, `netlify/functions/ig-oauth.js:14-22`):
>
> ```js
> const SCOPES = [
>   'instagram_business_basic',
>   'instagram_business_content_publish',
>   'instagram_business_manage_comments',
>   'instagram_business_manage_insights',
>   'pages_show_list',
>   'pages_read_engagement',
>   'pages_manage_metadata',
> ].join(',');
> ```
>
> 위 7개 스코프 모두 Meta 폼에서 "Request" 처리 필수.
> `pages_manage_metadata`는 webhook subscription에 사용 (현재 코드 `meta-webhook.js` 활성).

---

## 10. 사용자 액션 체크리스트 (제출 직전, 본인이 직접 처리)

> 이 섹션이 끝나면 바로 Submit 가능. 예상 소요 1시간.
> 코드 측은 모두 준비 완료. 외부 자산·콘솔 작업만 남음.

### A. 자산 제작 (예상 30분)

- [ ] **사업자등록증 사진/스캔** (PDF 또는 JPG 8MB 이하)
  - 보유 중이면 휴대폰으로 평평한 곳에 두고 정면 촬영. 글자 선명하게.
  - 파일명 예: `lumi-biz-license.jpg`
- [ ] **통신판매업 신고증 사진/스캔** (PDF 또는 JPG)
  - 파일명 예: `lumi-ecommerce-cert.jpg`
- [ ] **앱 아이콘 PNG 1024×1024** (필수)
  - 디자인 컨셉(권장): `--pink: #C8507A` 그라디언트 배경 + 흰색 "L" 또는 "lumi" 워드마크.
  - 텍스트가 1024px 기준으로 잘리지 않게 안전 영역 80px 이상 확보.
  - 알파(투명) 사용 금지. 단색 또는 그라디언트 fill 필수 (App Store 규격 준수).
  - 도구: Figma 무료 버전 / Photoshop / Canva 어느 것이든 OK. 5–15분.
- [ ] **앱 아이콘 PNG 512×512, 192×192** (1024 만들면 export로 5초)
- [ ] **데모 영상 MP4** (필수, 100MB 이하, 5–7분)
  - §3 시나리오 그대로 화면 녹화 (QuickTime / OBS / 갤럭시 화면 녹화).
  - 자막은 영상 편집 도구(CapCut 무료 / iMovie)로 권한명 삽입.
  - 짧은 1–2분 압축 버전이 필요한 경우 §11 "데모 영상 짧은 버전 자막 가이드" 참조.

### B. 테스트 계정 준비 (예상 5분)

- [ ] `https://lumi.it.kr/signup` 에서 **이메일 로그인 신규 계정 1개 생성**
  - 카카오 로그인 X (한국 전화번호 인증 필요 — 심사관 접근 불가)
  - 이메일은 `lumi-review@<본인 도메인>` 또는 별도 무료 Gmail 계정 권장
- [ ] 매장 정보 입력 완료 (상태: 온보딩 완료)
- [ ] **Instagram 연결은 미완료 상태로 둠** (심사관이 자체 IG로 직접 OAuth 테스트)
- [ ] 계정 정보를 §4 표의 빈칸에 직접 입력 후 저장 (또는 메모에 따로 저장)

### C. Meta Developer Console 작업 (예상 15분)

- [ ] developers.facebook.com → My Apps → Lumi 앱 (App ID `1233639725586126`) 진입
- [ ] **Settings → Basic**:
  - App Domains: `lumi.it.kr` 추가
  - Privacy Policy URL: `https://lumi.it.kr/privacy`
  - Terms of Service URL: `https://lumi.it.kr/terms`
  - User Data Deletion: `https://lumi.it.kr/privacy#data-deletion` 입력 (URL Callback 옵션 선택)
  - Category: `Business`
  - App Icon: 위 1024×1024 PNG 업로드
- [ ] **App Roles → Instagram Testers**: 본인 IG 비즈니스 계정 추가 → IG 앱 알림에서 "수락" → OAuth로 본인 publish 사전 검증 (제출 전 1회 실 게시 확인)
- [ ] **App Review → Permissions and Features**: 7개 권한 모두 Request (§8 참조)
- [ ] **Business Verification**: business.facebook.com → Business Settings → Security Center → Business Verification → 위 A의 사업자등록증 + 통신판매업 신고증 업로드

### D. 제출 (예상 10분)

- [ ] §7 사전 검증 체크리스트 모두 OK 확인
- [ ] §5 스크린샷 9종 준비 (영상에 다 나오면 영상으로 대체 가능)
- [ ] §2 영문 use case 텍스트 권한별로 복붙
- [ ] §3 데모 영상 업로드 (각 권한 섹션마다 동일 영상 업로드 가능)
- [ ] Submit for Review

---

## 11. 데모 영상 짧은 버전 자막 가이드 (1–2분, 선택)

> Meta는 5–7분 본편 외에 마케팅용 짧은 버전을 별도 요구하지 않음.
> 단, 페이스북·인스타그램 광고 또는 외부 PR 용도로 사용할 경우 아래 가이드 참고.

| 시간 | 화면 | 자막 |
|------|------|------|
| 0:00–0:05 | Lumi 로고 페이드인 (`--pink: #C8507A`) | "사장님 대신 SNS 하는 직원 — Lumi" |
| 0:05–0:15 | 카카오 로그인 → 매장 정보 입력 한 컷 | "1분 가입" |
| 0:15–0:30 | settings → "Instagram 연결" → Meta OAuth 동의 화면 | "인스타 비즈니스 계정 연결" |
| 0:30–0:45 | register-product 사진 1장 드래그 앤 드롭 | "사진 1장만 올리면" |
| 0:45–1:00 | AI 캡션 typewriter 효과 + 해시태그 자동 추가 | "AI가 캡션을 써요" |
| 1:00–1:20 | "지금 게시" → 인스타 앱에서 게시물 확인 (split) | "바로 인스타에 게시" |
| 1:20–1:30 | 매장 사장님이 매장 일하는 컷 + Lumi 로고 | "오늘부터 SNS는 Lumi가" |

---

## 12. 데이터 처리·보관 정책 (Meta 제출 폼 영문 응답)

> Meta 폼 "How will user data be stored and protected?" 섹션 답변 원고. 영문 그대로 붙여넣기 권장.

```
Lumi stores Instagram user data exclusively in our managed Postgres
database (Supabase, AWS Seoul region). Long-lived access tokens are
stored encrypted in pgsodium Vault — only the secret_id (UUID reference)
is kept in our application table (`ig_accounts`); plaintext tokens never
leave the database boundary. Vault decryption requires the
service_role key, which is held only by our Netlify Functions runtime
(never exposed to the browser).

Data we store per Instagram user:
- Instagram User ID (numeric)
- Username (display only)
- Linked Facebook Page ID
- Encrypted long-lived access token (60-day TTL, auto-refreshed)
- Posted media IDs (post-publish references)
- Insights cache (impressions, reach — 7-day TTL)

Retention: data is retained while the user keeps their Lumi account
active. When the user disconnects Instagram from Settings, the entire
ig_accounts row is deleted within 5 seconds (function:
disconnect-ig.js). When the user requests account deletion from
Settings, a 30-day grace period begins; all data — including all
Instagram tokens and cached insights — is permanently erased on day 30
via a scheduled background function (process-account-deletion-background).

Transport security: all API calls between Lumi and the Instagram Graph
API use HTTPS (TLS 1.2+). Lumi domain enforces HSTS.

We do not sell or share Instagram user data with any third party. The
only third party that touches Instagram data is OpenAI (caption
generation), and only the user-uploaded photo is sent — no Instagram
account metadata is forwarded.
```

---

## 13. 앱 아이콘 디자인 가이드 (1024×1024 PNG)

> 사용자가 30분 안에 직접 만들 수 있는 가이드. 외주 불필요.

### 사양

| 사이즈 | 용도 | 필수/권장 |
|--------|------|----------|
| 1024×1024 PNG | Meta App Settings → App Icon, App Store, Google Play | 필수 |
| 512×512 PNG | Meta Business Page · 외부 임베드 | 권장 |
| 192×192 PNG | favicon, PWA manifest | 권장 |

### 디자인 컨셉 (브랜드 일관성)

- 배경: `--pink: #C8507A` 단색 fill 또는 `#C8507A` → `#E0789A` 위→아래 그라디언트
- 전경: 흰색 `lumi` 워드마크 (Pretendard ExtraBold) **또는** 흰색 굵은 "L" 단일 글자
- 안전 영역: 1024 기준 상하좌우 80px (Apple App Store 모서리 라운드 컷 대비)
- 알파(투명) 사용 금지 — 모서리까지 색이 채워져 있어야 함

### 권장 도구·작업 흐름

1. Figma (무료 가입) → 1024×1024 frame
2. 배경 fill `#C8507A`
3. 텍스트 도구 → "L" 또는 "lumi", color `#FFFFFF`, font `Pretendard ExtraBold`, size ~600
4. 가운데 정렬
5. Export → PNG `1x` (1024), `0.5x` (512), `0.1875x` (192) 동시 export

### 빠른 대안

- Canva 검색 "logo 1024" 템플릿 → 글자만 `lumi`, 색만 `#C8507A`로 변경 → Export.
- ChatGPT image 모델로 `"Pink #C8507A square app icon, white bold lowercase 'lumi' wordmark, centered, no transparency, 1024x1024"` 프롬프트.

---

## 14. Tester 등록 가이드 (제출 전 본인 IG로 사전 검증)

> Advanced Access 미통과 상태에서도 Instagram Tester 등록된 계정은 OAuth + publish 가능.
> 제출 전 본인 IG 비즈니스 계정으로 1회 실 게시 검증 필수 — 심사 거절 위험 최소화.

### 단계

1. developers.facebook.com → My Apps → Lumi 앱 선택
2. 좌측 메뉴 **Roles → Roles** 또는 **App Roles → Instagram Testers**
3. **Add Instagram Testers** → 본인 IG 비즈니스 계정 username 입력
4. 본인 IG 앱(모바일) → Settings → Apps and Websites → Tester Invites → "Accept" 탭
5. 수락 후 1–2분 대기 (Meta 측 반영)
6. `https://lumi.it.kr/settings` → "Instagram 연결하기" → OAuth 진행
7. `/register-product` → 사진 1장 → 캡션 생성 → "지금 게시"
8. 본인 IG 피드에 실제 게시물 표시 확인 → 제출 가능 상태

### 실패 시

- "App not active" 오류 → Meta Developer Console → App Settings → 우상단 토글 **In Development → Live** 전환 (Privacy Policy URL 필수 입력 후 활성화 가능)
- OAuth 단계에서 "Invalid Scope" → §9 SCOPES 코드와 Meta Console의 Add Products → Facebook Login 설정 일치 확인

---

## 15. Privacy Policy · Terms 점검 결과

> 2026-05-08 자동 점검. 모두 OK.

| 요구사항 | 위치 | 상태 |
|----------|------|------|
| 어떤 SNS 데이터 수집하는지 명시 | `privacy.html` §02 (수집 항목) + §05 (제3자 제공) | OK — Instagram User ID, username, page_id, access_token 명시 |
| 보안 조치 명시 | `privacy.html` §09 안전성 확보 조치 | OK — pgsodium Vault, HTTPS, 권한 최소화 |
| 데이터 삭제 절차 | `privacy.html#data-deletion` | OK — 30일 유예, 즉시 삭제, 이메일 요청, IG 분리 삭제 4가지 경로 |
| Contact 이메일 | `privacy.html` 푸터 + §07 | OK — gung3625@gmail.com |
| 회원 탈퇴 30일 유예 정책 | `privacy.html` §07 + `terms.html` §14 | OK — 양쪽 모두 명시 |
| 사업자등록번호 | 모든 페이지 푸터 | OK — 404-09-66416 통일 |
| 통신판매업 신고번호 | privacy/terms/index 푸터 | OK — 제2024-서울용산-1166호 |

> 점검 명령:
> ```bash
> grep -n "data-deletion\|404-09-66416\|제2024-서울용산-1166호\|개인정보보호책임자" privacy.html terms.html index.html
> ```
