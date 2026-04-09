# Bento Redesign Step 8: 최종 테스트 + QA + 보고서

## 선행 조건
- Step 1~7 모두 완료

## 이번 단계 범위
전체 벤토 그리드 index.html의 최종 품질 검증. 
버그 수정, 크로스 브라우저 확인, 성능 점검, 보고서 작성.

---

## 1. 기능 테스트 체크리스트

### A. 핵심 기능 (반드시 통과)
```
[ ] 페이지 정상 로드 (콘솔 에러 0개)
[ ] 14개 카드 전부 렌더링됨
[ ] gridstack 드래그 동작 (데스크톱)
[ ] Toggle Lockdown 버튼: 드래그 on/off 전환
[ ] Nav 필터 탭: All/기능/요금/체험/시작하기 전환
[ ] 필터 후 카드 숨김 + gridstack compact 정상
[ ] 다크모드 ↔ 라이트모드 전환 (FAB)
[ ] 다크모드 FOUC 없음 (새로고침 시)
[ ] 모든 카드 텍스트 다크/라이트 양쪽 가독성
```

### B. 데모 캡션 (Card 02)
```
[ ] 업종 선택 select 동작
[ ] 사진 클릭 업로드 동작
[ ] 사진 드래그 앤 드롭 동작
[ ] 미리보기 이미지 표시
[ ] 생성 버튼 활성화 (업종 + 사진 선택 후)
[ ] API 호출 → 로딩 표시 → 결과 표시
[ ] 복사 버튼 동작
[ ] 무료 체험 횟수 제한 (localStorage)
[ ] reCAPTCHA 동작
```

### C. 가격표 (Card 10)
```
[ ] 3단 플랜 정확한 가격: 베이직 ₩19,000 / 스탠다드 ₩29,000 / 프로 ₩39,000
[ ] "가장 인기" 배지 스탠다드에 표시
[ ] 각 플랜 기능 목록 정확
[ ] CTA 버튼 → /beta 또는 /subscribe 이동
[ ] 다크/라이트 양쪽 정상 표시
```

### D. FAQ (Card 11)
```
[ ] 8개 질문 전부 표시
[ ] 클릭 시 아코디언 펼침/접힘
[ ] + 아이콘 → × 회전
[ ] 답변 텍스트 정확 (index-old.html과 동일)
```

### E. 비교표 (Card 09)
```
[ ] ChatGPT vs lumi 4행 비교 데이터 정확
[ ] 체크마크 캐스케이드 애니메이션 (뷰포트 진입 시)
[ ] lumi 열 핑크 강조
```

### F. 후기 (Card 08)
```
[ ] 4명 후기 표시 (김민정/박서준/이지현/최지우)
[ ] 별점 표시
[ ] 캐러셀 또는 스택 레이아웃 정상
```

### G. 애니메이션 (12개)
```
[ ] A1: 카드 드래그 재배열 (0.5s 전환)
[ ] A2: 카드 호버 섀도
[ ] A3: grab/grabbing 커서
[ ] A4: 필터 탭 reflow
[ ] A5: Nav pill 호버 opacity
[ ] A6: 버튼 hover ring
[ ] A7: 그리드 높이 전환
[ ] A8: 카드 내부 전환
[ ] B1: 타이핑 커서 (데모 캡션)
[ ] B2: 트렌드 키워드 롤링
[ ] B3: 체크마크 캐스케이드
[ ] B4: 캡션 샘플 가로 스크롤 + 호버 멈춤
```

### H. 법적 필수
```
[ ] Footer 카드(14)에 사업자 정보 전부:
    - 상호명: 루미 (lumi)
    - 대표자: 김현
    - 사업자 등록번호: 404-09-66416
    - 업태: 정보통신업
    - 주소: 서울특별시 용산구 회나무로 32-7 (이태원동)
    - 통신판매업 신고번호: 제2024-서울용산-1166호
    - 이메일: gung3625@gmail.com
[ ] 이용약관 링크 (/terms) 동작
[ ] 개인정보 처리방침 링크 (/privacy) 동작
[ ] 고객센터 링크 (/support) 동작
[ ] copyright: © 2026 lumi (루미) · 대표 김현
```

---

## 2. 반응형 테스트

### 디바이스별 확인
```
[ ] Desktop 1920px: 4열, 모든 카드 정상
[ ] Desktop 1200px: 4열 경계, 카드 겹침 없음
[ ] Tablet 768px: 2열 전환, 카드 순서 정상
[ ] Mobile 480px: 1열 전환, 세로 스택
[ ] Mobile 375px (iPhone SE): 모든 카드 가로 꽉 참, 텍스트 잘림 없음
[ ] Mobile 360px (Galaxy): 동일
```

### 모바일 특수 확인
```
[ ] 드래그 비활성화 (터치 스크롤과 충돌 없음)
[ ] Sticky CTA 하단 표시
[ ] 잠금 버튼 숨김
[ ] Pricing 3단 → 1열 변환
[ ] Features 4열 → 2열 변환
[ ] Nav 필터 탭 가로 스크롤
[ ] safe-area-inset 대응 (노치폰)
```

---

## 3. 크로스 브라우저

```
[ ] Chrome (최신)
[ ] Safari (Mac)
[ ] Safari (iOS)
[ ] Samsung Internet (Android)
[ ] Firefox (참고)
```

핵심: 한국 소상공인 대부분 iPhone Safari 또는 Android Chrome/Samsung Internet 사용.

---

## 4. 성능 점검

```
[ ] Lighthouse 점수 측정 (목표: Performance ≥80, Accessibility ≥90)
[ ] gridstack.js CDN 로드 시간 확인
[ ] 이미지 lazy loading (Unsplash 이미지에 loading="lazy")
[ ] CSS/JS defer/async 적절히 설정
[ ] First Contentful Paint ≤ 2초 목표
[ ] CLS (Cumulative Layout Shift) ≤ 0.1 목표
```

---

## 5. SEO 확인

```
[ ] title 태그 존재 + 정확
[ ] meta description 존재 + 60~160자
[ ] OG tags 전부 (title, description, image, url)
[ ] Twitter cards 전부
[ ] canonical URL
[ ] JSON-LD: SoftwareApplication 스키마
[ ] JSON-LD: Organization 스키마
[ ] JSON-LD: FAQPage 스키마 (8개 Q&A)
[ ] robots.txt 확인 (/.netlify/, /dashboard 차단)
[ ] sitemap 존재 여부 (선택)
```

---

## 6. index-old.html과의 차이 비교

기존 vs 신규 기능 매핑이 빠짐없이 되었는지 최종 확인:
```
[ ] Hero → Card 01 (타이틀, 폰 목업, CTA)
[ ] Demo → Card 02 (전체 JS 기능)
[ ] Metrics → Card 03 (4개 수치)
[ ] HOW 4-step → Card 06 (간결 버전)
[ ] Features → Card 07 (핵심 4개)
[ ] Proof (Before/After) → Card 04
[ ] Proof (후기) → Card 08
[ ] Compare → Card 09
[ ] Pricing → Card 10
[ ] CTA → Card 12
[ ] FAQ → Card 11
[ ] Footer → Card 14
[ ] (신규) Trend → Card 05
[ ] (신규) Caption samples → Card 13
```

---

## 7. 보고서 작성

작업 완료 후 반드시 보고서 작성:

파일: `docs/agent-reports/20260410-bento-redesign.md`

내용 포함:
- 변경사항 전체 목록
- 미반영 항목 (사유)
- 실패 항목 (원인)
- 각 Step(1~8) 완료 상태
- 스크린샷 또는 확인 결과
- 다음 작업 추천

형식: docs/agent-reports/README.md 따를 것.

---

## 8. Git 커밋 + 푸시

모든 테스트 통과 후:
```bash
cd /Users/kimhyun/lumi.it  # 또는 /home/user/lumi.it
git add index.html docs/agent-reports/20260410-bento-redesign.md
git commit -m "feat: index.html 벤토 그리드 리디자인 — nevflynn.com 스타일 14카드"
git push origin main
```

주의: index-old.html은 이미 커밋됨. 삭제하지 않는다 (롤백용).

---

## 롤백 방법 (문제 발생 시)
```bash
cp index-old.html index.html
git add index.html
git commit -m "revert: 벤토 리디자인 롤백"
git push origin main
```
