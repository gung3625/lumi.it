# Lumi — Meta App Review 제출 패키지

> 최종 업데이트: 2026-05-06
> 앱 ID: 1233639725586126
> 대상 플랫폼: Instagram Graph API (Business)
> 서비스 URL: https://lumi.it.kr

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
- 대표자: 김현
- 주소: 서울 용산구 회나무로 32-7
- 연락처: 010-6424-6284
- 이메일: gung3625@gmail.com
- 제출 서류: 사업자등록증 + 통신판매업 신고증 사진 (PDF 또는 JPG)

> Meta Business Verification은 developers.facebook.com → My Apps → 앱 선택 → Settings → Business Verification 경로에서 신청.

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

> 현재 `ig-oauth.js` 코드의 SCOPES 값은 구버전 명칭(`instagram_basic`, `instagram_content_publish` 등) 사용 중.
> Meta App Review 신청 권한과 실제 요청 스코프가 일치해야 통과 가능.
> 신청 전 SCOPES를 아래와 같이 맞출 것:
>
> ```js
> const SCOPES = [
>   'instagram_business_basic',
>   'instagram_business_content_publish',
>   'instagram_business_manage_insights',
>   'instagram_business_manage_comments',
>   'pages_show_list',
>   'pages_read_engagement',
>   'pages_manage_metadata',
> ].join(',');
> ```
