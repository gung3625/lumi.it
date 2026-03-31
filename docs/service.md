# 서비스 현황 + 파일 구조

## 현재 상태 (2026-03-31)
- 메타 비즈니스 앱 심사 중 (약 2주, 수정 불가)
- 솔라피 알림톡 템플릿 재검수 중
- beta.html 완료 (lumi.it.kr/beta)
- admin-beta.html 완료 (lumi.it.kr/admin-beta, 토큰: lumi2026secret)
- Remote Control 활성화됨 (모바일 작업 가능)

## 파일 구조
```
lumi.it/
├── CLAUDE.md          # 핵심 지시서 (200줄 이하 유지)
├── docs/              # 상세 참조 문서
│   ├── stack.md       # 기술 스택 + 환경변수
│   ├── design.md      # 디자인 시스템 + 스킬
│   └── service.md     # 서비스 현황 + 파일 구조
├── index.html         # 메인 소개페이지 (4056줄)
├── beta.html          # 테스터 모집 (481줄)
├── admin-beta.html    # 신청자 관리
├── subscribe.html     # 구독
├── netlify.toml       # /api/* 리다이렉트 포함
└── netlify/functions/ # 35개 Functions
    ├── beta-apply.js  # 베타 신청 저장
    ├── beta-admin.js  # 신청자 조회 (인증 필요)
    └── scheduler.js   # 게시물 스케줄링
```
