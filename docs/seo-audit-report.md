# SEO 진단 리포트 — lumi (lumi.it.kr)

**진단일**: 2026-04-09
**대상 페이지**: index.html, beta.html
**진단 범위**: Technical SEO + On-Page SEO

---

## Executive Summary

전체 SEO 건강도: **65/100**

### Top 5 우선 수정 사항
1. index.html 메타 디스크립션 키워드 부족 + 너무 짧음
2. beta.html canonical 태그 누락
3. 이미지 alt 속성 대부분 비어 있음 (빈 alt="")
4. FAQPage 구조화 데이터(Schema) 미적용 (index.html, beta.html 모두)
5. sitemap.xml에 `<lastmod>` 날짜 누락

### Quick Wins (즉시 적용 가능)
- beta.html에 canonical 태그 추가
- 이미지 alt 텍스트 채우기
- 메타 디스크립션 개선
- FAQPage JSON-LD 추가

---

## 1. Technical SEO

### 1.1 Crawlability

| 항목 | 상태 | 비고 |
|------|------|------|
| robots.txt | ✅ 양호 | `/api/`, `/dashboard`, `/admin*` 차단. 적절함 |
| sitemap.xml | ⚠️ 부분 양호 | 존재하나 `<lastmod>` 날짜 없음 |
| sitemap 참조 | ✅ 양호 | robots.txt에서 sitemap 경로 명시 |
| URL 구조 | ✅ 양호 | 깔끔한 경로 (`/beta`, `/subscribe` 등) |

**Issue: sitemap.xml에 `<lastmod>` 없음**
- **Impact**: Medium
- **Evidence**: sitemap.xml의 모든 `<url>`에 `<lastmod>` 태그 없음
- **Fix**: 각 URL에 마지막 수정일 추가. 구글이 크롤링 우선순위를 판단하는 데 사용
- **예시**: `<lastmod>2026-04-09</lastmod>`

### 1.2 Indexation

| 항목 | 상태 | 비고 |
|------|------|------|
| index.html canonical | ✅ 양호 | `<link rel="canonical" href="https://lumi.it.kr">` |
| beta.html canonical | ❌ 누락 | canonical 태그 없음 |
| noindex 오남용 | ✅ 양호 | 불필요한 noindex 없음 |
| HTTPS | ✅ 양호 | Netlify 기본 HTTPS |

**Issue: beta.html canonical 태그 누락**
- **Impact**: High
- **Evidence**: beta.html `<head>` 내 canonical 태그 없음
- **Fix**: `<link rel="canonical" href="https://lumi.it.kr/beta">` 추가
- **Priority**: 1 (즉시)

### 1.3 Site Speed 관련

| 항목 | 상태 | 비고 |
|------|------|------|
| 외부 이미지 | ⚠️ 주의 | Unsplash 이미지 width/height 미지정 → CLS 유발 가능 |
| 폰트 로딩 | ✅ 양호 | `preconnect` + CDN |
| JS 로딩 | ⚠️ 주의 | Iconify, Lucide 외부 스크립트 동기 로딩 |

**Issue: 외부 이미지에 width/height 속성 없음**
- **Impact**: Medium (CLS 점수 악화)
- **Evidence**: index.html의 Unsplash `<img>` 태그에 width/height 미지정
- **Fix**: `<img>` 태그에 `width`, `height` 속성 추가 또는 CSS `aspect-ratio` 지정

**Issue: 아이콘 라이브러리 동기 로딩**
- **Impact**: Low-Medium
- **Evidence**: `<script src="https://code.iconify.design/...">` (index.html), `<script src="https://unpkg.com/lucide@latest">` (beta.html) — render-blocking
- **Fix**: `defer` 또는 `async` 속성 추가

### 1.4 Mobile

| 항목 | 상태 | 비고 |
|------|------|------|
| viewport 메타 | ✅ 양호 | `viewport-fit=cover` 포함 |
| 반응형 디자인 | ✅ 양호 | `clamp()`, `auto-fit` 그리드 사용 |
| 모바일 CTA | ✅ 양호 | sticky CTA 하단 고정 |

### 1.5 Security & HTTPS

| 항목 | 상태 |
|------|------|
| HTTPS | ✅ Netlify 자동 |
| Mixed content | ✅ 없음 (외부 리소스 모두 HTTPS) |

---

## 2. On-Page SEO

### 2.1 Title Tags

| 페이지 | 현재 Title | 길이 | 평가 |
|--------|-----------|------|------|
| index.html | `lumi — 홍보, 이제 사진 한 장으로 끝내요` | 22자 | ⚠️ 타겟 키워드 부족 |
| beta.html | `lumi 베타 테스터 모집 — 선착순 20명 무료` | 22자 | ✅ 양호 |

**Issue: index.html 타이틀에 핵심 키워드 없음**
- **Impact**: High
- **Evidence**: "인스타그램", "자동 포스팅", "캡션 자동" 등 검색 키워드가 타이틀에 없음
- **Fix 제안**: `인스타 자동 포스팅 — 사진 한 장이면 캡션부터 게시까지 | lumi`
- **Priority**: 1

### 2.2 Meta Description

| 페이지 | 현재 Description | 길이 | 평가 |
|--------|-----------------|------|------|
| index.html | `사진 한 장만 올리면, 나머지는 lumi가 다 해요.` | 24자 | ❌ 너무 짧음 |
| beta.html | `lumi 베타 테스터를 모집해요. 선착순 20명, 정식 출시 전까지 전부 무료.` | 38자 | ⚠️ 약간 짧음 |

**Issue: index.html 메타 디스크립션 너무 짧고 키워드 없음**
- **Impact**: High
- **Evidence**: 24자. 권장 70~80자(한글 기준). "인스타그램", "소상공인", "자동 게시" 등 키워드 없음
- **Fix 제안**: `소상공인 인스타그램 자동 포스팅 서비스. 사진 한 장만 올리면 AI가 캡션·해시태그를 쓰고 인스타에 바로 올려드려요. 월 1.9만원부터. 지금 무료 테스터 모집 중.`
- **Priority**: 1

**Issue: beta.html 메타 디스크립션 개선 필요**
- **Impact**: Medium
- **Fix 제안**: `인스타 자동 포스팅 서비스 lumi 베타 테스터 모집. 선착순 20명 한정, 정식 출시 전까지 모든 기능 무료. 카드 등록 없이 바로 시작하세요.`

### 2.3 Heading Structure

**index.html**
| 태그 | 내용 | 평가 |
|------|------|------|
| H1 | `우리 매장을 아는 lumi가 대신 써드려요.` | ⚠️ 검색 키워드 없음 |
| H2 | `사진 한 장이면 이 모든 게 자동이에요` | ✅ |
| H2 | `우리 매장 상황을 읽고 알아서 써드려요` | ✅ |
| H2 | `사진 한 장 올려보세요, lumi가 바로 캡션을 써드릴게요` | ✅ |
| H2 | `사장님이 쓴 글 vs lumi가 쓴 글` | ✅ |
| H2 | `우리 매장에 맞는 플랜을 선택하세요` | ✅ |
| H2 | `사장님, 오늘부터 인스타 걱정 끝내세요.` | ✅ |
| H2 | `자주 묻는 질문` | ✅ |
| H3 | 기능명들 (글 고민 0분, 도달률 높이는 태그 등) | ✅ |

- H1 1개: ✅
- 계층 구조: ✅ (H1 → H2 → H3 순서 준수)

**Issue: H1에 타겟 키워드 없음**
- **Impact**: Medium
- **Evidence**: H1이 감성 카피 위주. "인스타그램", "자동 포스팅" 등 검색어 미포함
- **Fix**: H1에 핵심 키워드 자연스럽게 포함. 예: `인스타 자동 포스팅,<br>사진 한 장이면 끝.`

**beta.html**
| 태그 | 내용 | 평가 |
|------|------|------|
| H1 | `우리 매장을 아는 lumi, 먼저 써보세요.` | ⚠️ 키워드 부족 |
| H2 x5 | 섹션별 제목 | ✅ |

- H1 1개: ✅
- 계층 구조: ✅

### 2.4 Image Optimization

**Issue: 대부분 이미지의 alt 속성이 비어 있음**
- **Impact**: High
- **Evidence**: index.html의 Unsplash 이미지 15개 이상이 `alt=""`. 검색엔진이 이미지 내용을 파악할 수 없음
- **Fix**: 각 이미지에 설명적 alt 텍스트 작성
  - `alt=""` → `alt="카페 라떼 아트 클로즈업"`
  - `alt=""` → `alt="성수동 카페 내부 전경"`
- **Priority**: 2

**Issue: 이미지 포맷 최적화 없음**
- **Impact**: Low
- **Evidence**: 외부 Unsplash 이미지라 직접 제어 어려움. 자체 이미지(`/assets/logo.png`)는 WebP 미사용
- **Fix**: 자체 이미지를 WebP로 변환하거나 `<picture>` 태그 사용

### 2.5 Structured Data (Schema Markup)

| 페이지 | Schema | 평가 |
|--------|--------|------|
| index.html | ✅ SoftwareApplication | 있으나 개선 필요 |
| beta.html | ❌ 없음 | 추가 필요 |

**Issue: FAQPage Schema 미적용**
- **Impact**: High (FAQ 리치 스니펫 기회 손실)
- **Evidence**: index.html, beta.html 모두 FAQ 섹션이 있지만 FAQPage JSON-LD 없음
- **Fix**: 각 페이지의 FAQ 섹션에 FAQPage 스키마 추가
```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "베타 기간이 끝나면 바로 유료인가요?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "아니요. 베타 기간 종료 최소 2주 전에..."
      }
    }
  ]
}
```
- **Priority**: 1

**Issue: SoftwareApplication Schema 개선 필요**
- **Impact**: Medium
- **Evidence**: 현재 `offers`에 단일 가격만 표시. `aggregateRating`, `screenshot`, `author` 등 누락
- **Fix**: `offers`를 `AggregateOffer`로 변경 (lowPrice: 19000, highPrice: 39000), `author` (Organization) 추가

**Issue: beta.html에 Schema 없음**
- **Impact**: Medium
- **Fix**: WebPage 또는 Event(베타 모집) 스키마 추가

### 2.6 Internal Linking

| 항목 | 상태 | 비고 |
|------|------|------|
| 홈 → 베타 | ✅ | CTA 버튼 다수 |
| 베타 → 홈 | ✅ | 로고 + nav |
| 상호 링크 | ✅ 양호 | nav, footer에서 주요 페이지 연결 |
| footer 링크 | ✅ | 이용약관, 개인정보, 고객센터 |

### 2.7 Open Graph & Social

| 항목 | index.html | beta.html |
|------|-----------|-----------|
| og:title | ✅ | ✅ |
| og:description | ✅ | ✅ |
| og:image | ✅ | ✅ |
| og:url | ✅ | ✅ |
| og:type | ✅ | ✅ |
| twitter:card | ✅ | ✅ |

Social 메타 태그: 양호

---

## 3. Content Quality

### 3.1 E-E-A-T Signals

| 항목 | 상태 | 비고 |
|------|------|------|
| 사업자 정보 | ✅ | footer에 상호, 사업자번호, 주소 등 명시 |
| 대표자 정보 | ✅ | 김현, 이메일 공개 |
| 통신판매업 신고 | ✅ | 신고번호 표시 |
| 개인정보 처리방침 | ✅ | /privacy 링크 |
| 이용약관 | ✅ | /terms 링크 |
| 고객센터 | ✅ | /support 링크 |
| HTTPS | ✅ | |

### 3.2 Content Depth

- index.html: 충분한 콘텐츠 깊이 (기능 소개 12개, 사용법 4단계, 가격표, FAQ 5개, 비교 섹션)
- beta.html: 적절한 깊이 (혜택, 기능, 비교, FAQ, 신청 폼)

### 3.3 Keyword Targeting 분석

**타겟 키워드 (추정)**:
- "인스타 자동 포스팅" / "인스타그램 자동 게시"
- "인스타 캡션 자동"
- "소상공인 인스타그램"
- "인스타 마케팅 자동화"
- "AI 캡션 생성"

**Issue: 핵심 키워드 노출 부족**
- **Impact**: High
- **Evidence**: title, H1, meta description 어디에도 "인스타그램" 또는 "자동 포스팅"이 명시적으로 없음. 본문에는 자연스럽게 포함되어 있으나 SEO 핵심 위치(title, H1, description)에서 누락
- **Fix**: title, H1, meta description에 핵심 키워드 1~2개 자연스럽게 배치

---

## 4. Prioritized Action Plan

### Priority 1 — Critical (즉시 수정)
| # | 항목 | 페이지 | 난이도 |
|---|------|--------|--------|
| 1 | meta description 개선 (키워드 + 길이) | index.html | 쉬움 |
| 2 | canonical 태그 추가 | beta.html | 쉬움 |
| 3 | FAQPage Schema 추가 | index.html, beta.html | 쉬움 |
| 4 | title 태그에 키워드 포함 | index.html | 쉬움 |

### Priority 2 — High Impact
| # | 항목 | 페이지 | 난이도 |
|---|------|--------|--------|
| 5 | 이미지 alt 텍스트 채우기 | index.html | 중간 |
| 6 | H1에 타겟 키워드 포함 | index.html, beta.html | 쉬움 |
| 7 | SoftwareApplication Schema 보강 | index.html | 중간 |
| 8 | beta.html에 WebPage Schema 추가 | beta.html | 쉬움 |

### Priority 3 — Quick Wins
| # | 항목 | 페이지 | 난이도 |
|---|------|--------|--------|
| 9 | sitemap.xml에 lastmod 추가 | sitemap.xml | 쉬움 |
| 10 | 외부 스크립트에 defer 추가 | 둘 다 | 쉬움 |
| 11 | beta.html meta description 개선 | beta.html | 쉬움 |

### Priority 4 — Long-term
| # | 항목 | 비고 |
|---|------|------|
| 12 | 블로그/콘텐츠 허브 구축 | "소상공인 인스타 마케팅 팁" 등 교육 콘텐츠 |
| 13 | 경쟁사 비교 페이지 (vs 대행사, vs Buffer) | programmatic-seo 활용 |
| 14 | 업종별 랜딩 페이지 (카페용, 뷰티샵용 등) | 롱테일 키워드 공략 |
| 15 | Google Search Console 등록 + 데이터 기반 최적화 | 필수 |
| 16 | 자체 이미지 WebP 변환 | 성능 개선 |

---

## 참고: 현재 잘 되어 있는 것

- `lang="ko"` 설정
- Open Graph + Twitter Card 완비
- SoftwareApplication Schema 기본 적용 (index.html)
- robots.txt 적절한 차단 규칙
- sitemap.xml 존재 및 robots.txt 참조
- 사업자 정보 투명 공개 (E-E-A-T Trust)
- 모바일 반응형 잘 구현
- HTTPS 전체 적용
- 내부 링크 구조 양호
- 콘텐츠 깊이 충분
