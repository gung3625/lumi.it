# 서비스 현황 + 파일 구조

## 현재 상태 (2026-04-01)
- 메타 비즈니스 앱 심사 중 (약 2주, 수정 불가)
- 솔라피 알림톡 템플릿 재검수 중
- 테스터 모집: 0명 (아직 1명도 없음)
- beta.html 완료 (lumi.it.kr/beta)
- admin-beta.html 완료 (lumi.it.kr/admin-beta, 토큰: lumi2026secret)
- Remote Control 활성화됨 (모바일 작업 가능)

## 파일 구조
```
lumi.it/
├── CLAUDE.md          # 핵심 지시서
├── docs/              # 상세 참조 문서
│   ├── stack.md       # 기술 스택 + 환경변수
│   ├── design.md      # 디자인 시스템 + 스킬
│   └── service.md     # 서비스 현황 + 파일 구조 (이 파일)
├── index.html         # 메인 랜딩페이지 (547줄)
├── beta.html          # 테스터 모집 (530줄)
├── dashboard.html     # 인증 + 대시보드 (3085줄)
├── admin-beta.html    # 신청자 관리
├── subscribe.html     # 구독
├── prototype.html     # 프로토타입 (참고용)
├── netlify.toml       # /api/*, /dashboard, /p/:id 라우팅
└── netlify/functions/ # 39개 Functions
    ├── beta-apply.js  # 베타 신청 + 웰컴 알림톡
    ├── beta-admin.js  # 신청자 조회 (인증 필요)
    └── scheduler.js   # 게시물 스케줄링
```

## 완료된 작업 목록 (에이전트 필수 참조)

### 버그 수정
- [x] Solapi HMAC Date 불일치 수정
- [x] 대기 명단(waitlist) 실제 Blobs 저장 추가
- [x] beta.html 신청자 수 하드코딩(7) 제거 → 실시간 API 연동
- [x] PortOne SDK index.html에서 제거 (dashboard.html에서만 사용)
- [x] lumi-intro-view-port 래퍼 추가
- [x] nav 로그인/회원가입/대시보드 버튼 복원
- [x] "모든 기능 보기" reveal Observer 재등록
- [x] dashboard.html portal-sheet CSS 누락 복구
- [x] dashboard.html 미로그인 시 로그인 포탈 자동 표시
- [x] 가로 스크롤 방지 (html overflow-x:hidden) 전 페이지

### 디자인 개편
- [x] 메인페이지 대개편 (4068줄→547줄, 5개 섹션)
- [x] 핑크 리파인 (#FF6B9D→#E8628A)
- [x] Pretendard 폰트 적용 (전 페이지)
- [x] Lucide 아이콘 적용 (이모지 제거)
- [x] 스크롤 애니메이션 (IntersectionObserver)
- [x] 실사 이미지 폰 목업
- [x] beta.html 디자인 톤 통일 (Pretendard+Lucide+nav/footer)
- [x] nav-logo 높이 48px 통일 (3개 페이지)
- [x] dashboard.html topbar-logo 48px 통일

### 전환율 개선
- [x] 메시지 통일 ("7일 무료"→"베타 무료")
- [x] CTA → beta.html 유도
- [x] index.html 상단 베타 모집 배너 + 실시간 카운트
- [x] beta.html 신청 완료 후 카카오톡 공유 버튼
- [x] nav "회원가입"→"무료 테스터 신청" + /beta 유도
- [x] 모바일 목업 순서 수정 (텍스트 먼저)
- [x] 모바일 sticky CTA (index.html + beta.html)
- [x] sticky CTA footer 겹침 해결
- [x] beta.html 폼 슬롯 하드코딩 제거 → 동적

### 구조 개선
- [x] 대시보드 dashboard.html 분리 (index.html에서 인증+대시보드 코드 이동)
- [x] netlify.toml /dashboard 라우팅 추가
- [x] dashboard.html 랜딩 전용 CSS 제거

### 기타
- [x] user-scalable=no 제거 (접근성)
- [x] 오타 수정 ("스스로"→"알아서")
- [x] AI→lumi 용어 통일 (전 페이지)
- [x] beta.html input font-size 16px (iOS 줌 방지)
- [x] beta.html 푸터 연도 2025→2026
- [x] Before/After 모바일 반응형 세로 배치
- [x] 비교표 "해외 서비스"→"SNS 대행사"

## 제약 조건 (에이전트 필수 인지)
- 메타 심사 완료 전: 인스타 자동 게시·인사이트 API 사용 불가
- 솔라피 재검수 중: 알림톡 발송 불확실
- 캡션 생성: 사진 업로드 후 Make.com→GPT 처리 (미리보기 불가)
- 테스터 0명: 실사용 데이터·후기 없음
