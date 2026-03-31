# lumi — Claude Code 끝판왕 프롬프트

## ⚡ 핵심 규칙 (절대 어기지 말 것)
1. 파일 수정 전 반드시 원본 읽기
2. str_replace/edit_block으로 최소 범위만 수정 (전체 재작성 금지)
3. 김현님 승인 없이 실제 파일 수정 금지
4. 추측·거짓말 금지 — 팩트만 보고
5. 작업 완료 후 반드시 배포

---

## 🏪 서비스 개요

**lumi** (lumi.it.kr)
- 한국 소상공인 대상 인스타그램 SNS 자동화 서비스
- 사진 1장 업로드 → AI가 캡션·해시태그·날씨·트렌드·예약게시 전부 자동
- 가격: 월 ₩49,000 (스탠다드 플랜)
- 대표: 김현 (gung3625@gmail.com, 010-6424-6284)
- 사무소: 서울 용산구 이태원동

**핵심 타겟**
- 40~50대 소상공인 (카페, 뷰티샵, 식당)
- 인스타 올리고 싶은데 글 쓰기 힘든 사람
- 대행사 비용(월 50만원) 부담스러운 자영업자

**현재 상태 (2026-03-31)**
- 메타 비즈니스 앱 심사 중 (약 2주, 수정 불가)
- 솔라피 알림톡 템플릿 재검수 중
- 테스터 20명 모집 준비 중
- beta.html 신규 생성 완료 (lumi.it.kr/beta)
- 관리자 페이지: lumi.it.kr/admin-beta (토큰: LUMI_SECRET)

---

## 🛠 기술 스택

| 분류 | 기술 |
|------|------|
| 호스팅 | Netlify (Site ID: 28d60e0e-6aa4-4b45-b117-0bcc3c4268fc) |
| Functions | Netlify Functions (Node.js, esbuild 번들링) |
| 저장소 | Netlify Blobs (siteID + token 명시 필요) |
| 자동화 | Make.com |
| AI | OpenAI GPT-4o mini |
| 결제 | PortOne v2 (KG이니시스) |
| 알림톡 | Solapi KakaoTalk |
| SNS API | Meta Instagram Graph API |
| GitHub | gung3625/lumi.it |
| 언어 | 한국어 전용 |

---

## 🔑 환경변수 목록

```
NETLIFY_TOKEN          # Netlify API 토큰
NETLIFY_SITE_ID        # 28d60e0e-6aa4-4b45-b117-0bcc3c4268fc
LUMI_SECRET            # lumi2026secret (관리자 인증)
RESEND_API_KEY         # 이메일 발송
NAVER_CLIENT_ID        # 네이버 트렌드 API
NAVER_CLIENT_SECRET
MAKE_WEBHOOK_URL       # Make.com 웹훅
PORTONE_STORE_ID       # PortOne 결제
PORTONE_CHANNEL_KEY
PORTONE_API_SECRET
META_APP_SECRET        # 메타 Instagram API
META_APP_ID            # 1233639725586126
META_WEBHOOK_VERIFY_TOKEN
SOLAPI_API_KEY         # 솔라피 알림톡
SOLAPI_API_SECRET
SOLAPI_CHANNEL_ID      # lumi_it
OPENAI_API_KEY         # GPT-4o mini
```

**Blobs 사용 시 반드시 명시:**
```js
const store = getStore({
  name: 'store-name',
  consistency: 'strong',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_TOKEN,
});
```

---

## 📁 파일 구조

```
lumi.it/
├── index.html          # 메인 소개페이지 (4056줄)
├── beta.html           # 테스터 모집 페이지 (481줄)
├── admin-beta.html     # 베타 신청자 관리 페이지
├── subscribe.html      # 구독 페이지
├── link.html           # lumi 링크 페이지
├── support.html        # 고객센터
├── terms.html          # 이용약관
├── privacy.html        # 개인정보처리방침
├── netlify.toml        # Netlify 설정
├── package.json
└── netlify/functions/  # 35개 Netlify Functions
    ├── beta-apply.js   # 베타 신청 저장
    ├── beta-admin.js   # 베타 신청자 조회 (인증 필요)
    ├── scheduler.js    # 게시물 스케줄링
    ├── register.js     # 회원가입
    ├── login.js        # 로그인
    ├── payment-prepare.js  # 결제 준비
    ├── payment-confirm.js  # 결제 확인
    └── ...
```

---

## 🎨 디자인 시스템 (index.html CSS 변수)

```css
--pink: #FF6B9D          /* 메인 브랜드 컬러 */
--pink-light: #FF8FB5
--pink-soft: #FFD6E7
--pink-pale: #FFF0F6
--pink-ultra: #FFF7FB
--g900: #191F28          /* 텍스트 */
--g700: #333D4B
--g500: #6B7684
--g400: #8B95A1
--g200: #E8ECF0          /* 테두리 */
--g100: #F2F4F6
--g50:  #F9FAFB
--white: #FFFFFF
--r-xl: 32px             /* 카드 border-radius */
--r-lg: 24px
--r-full: 999px          /* 버튼 */
--sh-pink: 0 8px 24px rgba(255,107,157,.28)
```

---

## 🚀 배포 명령어

```bash
cd /Users/kimhyun/lumi.it
git add -A && git commit -m "커밋 메시지" && git push origin main && npx -y netlify-cli deploy --prod --site 28d60e0e-6aa4-4b45-b117-0bcc3c4268fc
```

---

## 🤖 에이전트 팀 파이프라인 (병렬 구조)

**1단계: 병렬 분석 (Task 툴로 동시 실행)**
```
Task 1 [아이디어 에이전트] ┐
Task 2 [검토 에이전트]    ├→ 동시 실행 → 결과 취합
Task 3 [트렌드 에이전트]  ┘
```

**2단계: 김현님 1차 승인**

**3단계: 시범 에이전트** → 프로토타입 제작 (파일 수정 금지)

**4단계: 김현님 최종 승인**

**5단계: 구현 에이전트** → 실제 파일 반영 + 배포

---

**⚡ 자동 병렬 실행 규칙 (명시 없어도 항상 적용)**

분석·개선·검토 요청이 오면 반드시 Task 툴로 3개 병렬 실행한다. 절대 단일 에이전트로 처리하지 않는다.

```
Use the Task tool to ALWAYS spawn exactly 3 parallel subagents:
Task 1 (아이디어): 개선 아이디어 제안
Task 2 (검토): UX/전환율 문제점 분석
Task 3 (트렌드): 최신 SaaS 디자인 트렌드 적용 방향

병렬로 실행하고 결과를 취합해서 김현님께 보고한다.
```

**아이디어 에이전트 출력 형식:**
```
[아이디어 #N]
제목: ...
근거: ...
구현 방식: ...
예상 효과: ...
난이도: 낮음/중간/높음
```

**검토 에이전트 출력 형식:**
```
[검토 결과 #N]
판단: 타당 / 보류 / 불필요
이유: ...
우선순위: 높음 / 중간 / 낮음
보고: 진행 권장 / 보류 권장
```

---

## ⚠️ 자주 하는 실수 (하지 말 것)

1. **Blobs에 siteID/token 빠뜨리기** → 502 에러 남
2. **netlify.toml에 /api/* 리다이렉트 없이 Function 만들기** → 404 남
3. **submitForm() JS만 바꾸고 실제 API 안 연결하기** → 데이터 저장 안 됨
4. **파일 전체 재작성** → 기존 기능 날아감. str_replace만 쓸 것
5. **가상 후기에 "스탠다드 플랜 사용 중" 표기** → 베타 단계와 모순

---

---

## 🎨 프론트엔드 디자인 원칙 (frontend-design 스킬)

lumi 페이지 디자인·개편 작업 시 반드시 따른다.

**코딩 전 반드시 결정할 것:**
- 톤: 극단적으로 선택 (미니멀, 맥시멀, 레트로, 럭셔리, 플레이풀 등)
- 차별화: 한 가지 기억에 남는 포인트가 뭔가?
- lumi 브랜드: 핑크(#FF6B9D) + 따뜻함 + 소상공인 친근함 유지

**절대 금지:**
- Inter, Roboto, Arial 같은 흔한 폰트
- 보라색 그라디언트 on 흰 배경
- AI가 만든 것 같은 뻔한 레이아웃
- 맥락 없는 쿠키커터 디자인

**해야 할 것:**
- CSS 변수로 일관된 테마
- 스크롤 트리거 애니메이션
- 비대칭·그리드 브레이킹 레이아웃
- 폰트는 디스플레이 + 바디 페어링
- 호버 상태가 놀라워야 함

---

## 📚 Anthropic 제품 참고 문서

Claude API 또는 Claude Code 관련 작업 시:
- Claude API 문서: https://docs.claude.com/en/api/overview
- Claude Code 문서: https://docs.claude.com/en/docs/claude-code/overview
- Claude Code npm: https://www.npmjs.com/package/@anthropic-ai/claude-code

---

## 🖥 UI 프로토타입 제작 (web-artifacts-builder 스킬)

복잡한 React+Tailwind 기반 UI 프로토타입 제작 시 적용한다.

**프로세스:**
1. `scripts/init-artifact.sh <project-name>` 실행
2. React 18 + TypeScript + Tailwind + shadcn/ui로 개발
3. `scripts/bundle-artifact.sh` 로 단일 HTML 번들링
4. 번들 결과물을 김현님께 공유

**디자인 주의:**
- 중앙 정렬 남용 금지, 보라색 그라디언트 금지, Inter 폰트 금지
- lumi 브랜드 컬러(#FF6B9D) 반드시 유지

---

- [ ] index.html How 섹션 인터랙티브 UI 교체
- [ ] index.html + beta.html 디자인 전면 개편
- [ ] 포트원 KG이니시스 가맹점 신청
- [ ] 솔라피 알림톡 4개 추가 템플릿 등록
- [ ] 스레드 자동화 (메타 심사 완료 후)
- [ ] 테스터 20명 모집
