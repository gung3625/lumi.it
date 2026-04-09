# lumi SEO & 콘텐츠 전략 종합 보고서

> 작성일: 2026-04-09  
> 대상: https://lumi.it.kr  
> 분석 도구: product-marketing-context, seo-audit, ai-seo, site-architecture, schema-markup, content-strategy, social-content, competitor-alternatives

---

## 목차

1. [제품 마케팅 컨텍스트](#1-제품-마케팅-컨텍스트)
2. [SEO 기술 진단](#2-seo-기술-진단)
3. [AI 검색 최적화 (AEO)](#3-ai-검색-최적화-aeo)
4. [사이트 구조 & URL 개선](#4-사이트-구조--url-개선)
5. [구조화 데이터 (Schema Markup)](#5-구조화-데이터-schema-markup)
6. [콘텐츠 전략](#6-콘텐츠-전략)
7. [소셜 콘텐츠 플랜](#7-소셜-콘텐츠-플랜)
8. [경쟁사 비교 페이지 제안](#8-경쟁사-비교-페이지-제안)
9. [실행 로드맵](#9-실행-로드맵)

---

## 1. 제품 마케팅 컨텍스트

### 핵심 요약
- **제품**: lumi — AI 인스타그램 자동 포스팅 SaaS
- **타겟**: 한국 소상공인 (카페, 음식점, 뷰티샵, 꽃집 등)
- **핵심 가치**: "사진 한 장 올리면 AI가 캡션 쓰고 인스타에 올려줌"
- **가격**: ₩19,000~39,000/월 (대행사 대비 1/10 가격)
- **단계**: 프리런칭 베타 (테스터 0명, 선착순 20명 모집)

### SEO/콘텐츠에 반영할 포지셔닝
| 비교 대상 | lumi 포지셔닝 | SEO 키워드 기회 |
|-----------|---------------|----------------|
| SNS 대행사 | 월 2만원대 vs 50~100만원 | "인스타 대행사 비용", "인스타 마케팅 저렴하게" |
| ChatGPT 복붙 | 사진만 올리면 자동 게시 | "인스타 캡션 자동", "AI 캡션 생성기" |
| Buffer/Later | 한국어 특화, 업종별 캡션 | "인스타 예약 게시 한국어", "소상공인 인스타 관리" |

---

## 2. SEO 기술 진단

### 2.1 크롤링 & 인덱싱

| 항목 | 상태 | 비고 |
|------|------|------|
| robots.txt | 정상 | /api/, /dashboard, /admin* 차단 |
| sitemap.xml | 부분 | lastmod 날짜 누락 |
| canonical 태그 | 부분 | index.html만 설정, beta.html 누락 |
| noindex 처리 | 정상 | dashboard.html에 noindex 적용 |

### 2.2 페이지별 SEO 진단

#### index.html (홈)
| 항목 | 현재 | 이슈 | 권장 |
|------|------|------|------|
| title | `lumi — 홍보, 이제 사진 한 장으로 끝내요` (34자) | 적정 | 유지 |
| meta description | 22자 | **너무 짧음** | 150자로 확장 |
| H1 | 1개 | 정상 | 유지 |
| H2 | 7개 | 정상 | 유지 |
| Schema | SoftwareApplication | 단일 플랜만 표기 | 3개 플랜 배열로 확장 |
| canonical | 설정됨 | 정상 | 유지 |

**권장 meta description:**
```
사진 한 장만 올리면 AI가 캡션·해시태그를 써주고 인스타에 바로 올려드려요. 매일 37분 걸리던 인스타 관리를 1분으로. 카페·음식점·뷰티샵 사장님을 위한 인스타 자동 포스팅, 지금 무료 테스터 모집 중.
```

#### beta.html (베타 신청)
| 항목 | 현재 | 이슈 | 권장 |
|------|------|------|------|
| title | `lumi 베타 테스터 모집 — 선착순 20명 무료` | 적정 | 유지 |
| meta description | 38자 | **짧음** | 150자로 확장 |
| canonical | **없음** | 중복 색인 위험 | 추가 필요 |
| Schema | **없음** | - | Event 또는 WebPage 추가 |
| og:url | `/beta` | 실제 파일명과 불일치 | netlify.toml redirect 확인 |

**권장 meta description:**
```
lumi 베타 테스터를 모집합니다. 선착순 20명, 정식 출시 전까지 모든 기능 무료. 사진만 올리면 AI가 캡션 써주고 인스타에 올려주는 서비스를 먼저 체험하세요. 카페·음식점·뷰티샵 사장님 환영.
```

#### subscribe.html (구독/요금)
- sitemap.xml에 포함되어 있으나 별도 SEO 진단 필요
- 가격 비교 키워드 타겟 가능: "인스타 자동화 가격", "인스타 마케팅 비용"

### 2.3 기술 성능 이슈

| 이슈 | 영향 | 해결 방법 |
|------|------|----------|
| Pretendard CDN render-blocking | LCP 지연 | `<link rel="preload">` 추가 |
| Iconify CDN 비동기 미적용 | FCP 지연 | `async` 속성 추가 |
| 인라인 CSS 대량 | 캐싱 불가 | 중요 CSS만 인라인, 나머지 외부 파일 |
| og:image 정사각형 2048px | SNS 공유 미리보기 깨짐 | 1200x630 전용 이미지 제작 |

### 2.4 긴급 수정 사항 (즉시 조치)

1. **beta.html canonical 태그 추가**: `<link rel="canonical" href="https://lumi.it.kr/beta">`
2. **meta description 확장**: index.html 22자 → 150자, beta.html 38자 → 150자
3. **og:image 교체**: 1200x630 소셜 카드 이미지 제작
4. **sitemap.xml lastmod 추가**: 크롤링 우선순위 개선

---

## 3. AI 검색 최적화 (AEO)

### 3.1 현재 상태

| AI SEO 요소 | 상태 | 비고 |
|-------------|------|------|
| llms.txt | **없음** | AI 크롤러 가이드 부재 |
| pricing.md | **없음** | AI가 가격 정보 추출 불가 |
| FAQ 구조 | HTML만 | FAQPage Schema 미적용 |
| 콘텐츠 추출성 | 보통 | H2 구조는 좋으나 정의형 콘텐츠 부족 |

### 3.2 AI가 인용하는 콘텐츠 특성 (Princeton GEO 연구 기반)

AI 검색엔진이 답변에 인용할 때 선호하는 콘텐츠:
- **명확한 정의와 비교** → "lumi는 ~이다" 형태의 문장
- **구체적 수치** → "월 19,000원", "37분 → 1분"
- **구조화된 리스트** → 기능 목록, 가격 비교표
- **권위 있는 출처** → 사용자 후기, 사례 연구

### 3.3 실행 방안

#### llms.txt 생성 (최우선)
```
# lumi (루미)

> AI 인스타그램 자동 포스팅 서비스. 사진 한 장 올리면 AI가 캡션·해시태그 써주고 인스타에 올려줌.

## 서비스 요약
- 대상: 한국 소상공인 (카페, 음식점, 뷰티샵, 꽃집 등)
- 핵심 기능: AI 캡션 생성, 해시태그 자동 추천, 예약 게시, 말투 학습
- 가격: 월 19,000원~39,000원 (SNS 대행사 대비 1/10)
- URL: https://lumi.it.kr

## 가격
- 베이직: ₩19,000/월 — 캡션 주 3개, 해시태그, 바로 게시
- 스탠다드: ₩29,000/월 — 무제한 캡션, 예약 게시, 말투 학습
- 프로: ₩39,000/월 — 캘린더, 트렌드 분석, 최적 시간 게시

## 경쟁 우위
- vs SNS 대행사: 월 2~4만원 vs 50~100만원
- vs ChatGPT 복붙: 사진만 올리면 자동 게시, 복붙 필요 없음
- vs Buffer/Later: 한국어 특화, 업종별 캡션, 한국 트렌드 반영

## 지원 업종
카페, 음식점, 뷰티샵, 꽃집, 베이커리, 헬스장, 패션, 인테리어, 반려동물
```

#### pricing.md 생성
AI가 가격 정보를 쉽게 추출하도록 마크다운 형태의 가격 페이지 제공

#### FAQ Schema 적용
index.html의 "자주 묻는 질문" 섹션에 FAQPage JSON-LD 추가 → AI 답변에 직접 인용될 가능성 증가

#### 콘텐츠 인용성 강화
- 각 페이지에 "lumi는 ~입니다" 형태의 정의 문장 1개씩 배치
- 비교표에 구체적 수치 포함 (시간 절약, 비용 절감)
- "인스타 자동 포스팅이란?" 같은 정의형 콘텐츠 블록 추가

---

## 4. 사이트 구조 & URL 개선

### 4.1 현재 사이트맵 (ASCII Tree)

```
lumi.it.kr/
├── / (홈 — 랜딩)
├── /beta (테스터 모집)
├── /subscribe (구독/요금)
├── /dashboard (대시보드, noindex)
├── /admin-beta (관리자, noindex)
├── /calendar (캘린더, noindex)
├── /support (고객지원)
├── /terms (이용약관)
├── /privacy (개인정보)
└── /office (에이전트 오피스, 관리자)
```

### 4.2 문제점

1. **콘텐츠 페이지 부재**: 블로그, 가이드, 사례 페이지가 없음 → 검색 유입 경로 극히 제한
2. **가격 페이지 독립성 부족**: subscribe.html이 가격 + 결제를 모두 담당 → SEO용 가격 비교 페이지 별도 필요
3. **3-click rule 위반 없음**: 페이지 수가 적어 구조적 문제는 없으나 성장 여력 부족
4. **URL 일관성**: .html 확장자가 혼재 (netlify.toml redirect로 일부 처리)

### 4.3 권장 사이트 구조 (Phase 1: 베타~정식 출시)

```
lumi.it.kr/
├── / (홈)
├── /beta (테스터 모집)
├── /pricing (가격 비교 — subscribe.html과 별도 or 통합)
├── /features (기능 소개)
├── /blog/ (콘텐츠 허브)
│   ├── /blog/instagram-caption-tips (캡션 작성 팁)
│   ├── /blog/hashtag-strategy (해시태그 전략)
│   ├── /blog/cafe-instagram-marketing (카페 인스타 마케팅)
│   └── ...
├── /guides/ (업종별 가이드)
│   ├── /guides/cafe (카페 인스타 가이드)
│   ├── /guides/restaurant (음식점 가이드)
│   └── /guides/beauty (뷰티샵 가이드)
├── /vs/ (경쟁사 비교)
│   ├── /vs/agency (대행사 vs lumi)
│   ├── /vs/chatgpt (ChatGPT vs lumi)
│   └── /vs/buffer (Buffer vs lumi)
├── /alternatives/ (대안 페이지)
│   ├── /alternatives/instagram-agency (인스타 대행사 대안)
│   └── /alternatives/later (Later 대안)
├── /support
├── /terms
├── /privacy
├── /dashboard (noindex)
├── /admin-beta (noindex)
├── /calendar (noindex)
└── /office (noindex)
```

### 4.4 URL 설계 원칙

- 한국어 슬러그 대신 영문 사용 (크롤링 안정성)
- 확장자 없는 clean URL (netlify.toml에서 redirect)
- 계층 최대 2단계: `/blog/post-slug`
- 카테고리 허브 페이지 필수: `/blog/`, `/guides/`, `/vs/`

### 4.5 내부 링크 전략

```
홈(/) ──→ /beta (CTA)
     ──→ /pricing (요금)
     ──→ /blog/ (콘텐츠)
     ──→ /features (기능)

/blog/* ──→ /beta (CTA)
        ──→ 관련 블로그 글 (상호 링크)
        ──→ /guides/* (업종 가이드)

/vs/* ──→ /pricing (가격 비교)
      ──→ /beta (CTA)

/guides/* ──→ /beta (CTA)
          ──→ /blog/* (관련 글)
```

---

## 5. 구조화 데이터 (Schema Markup)

### 5.1 현재 상태

| Schema 타입 | 페이지 | 상태 |
|-------------|--------|------|
| SoftwareApplication | index.html | 있음 (단일 플랜만) |
| Organization | - | **없음** |
| FAQPage | - | **없음** |
| BreadcrumbList | - | **없음** |
| WebSite | - | **없음** |
| Event (베타 모집) | - | **없음** |

### 5.2 추가 권장 Schema

#### Organization (index.html)
```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "lumi",
  "url": "https://lumi.it.kr",
  "logo": "https://lumi.it.kr/assets/logo.png",
  "description": "AI 인스타그램 자동 포스팅 서비스",
  "contactPoint": {
    "@type": "ContactPoint",
    "contactType": "customer support",
    "url": "https://lumi.it.kr/support"
  },
  "sameAs": []
}
```

#### SoftwareApplication 개선 (index.html)
```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "lumi",
  "applicationCategory": "BusinessApplication",
  "operatingSystem": "Web",
  "description": "사진 한 장만 올리면 AI가 캡션·해시태그를 써주고 인스타에 바로 올려주는 자동 포스팅 서비스",
  "offers": [
    {
      "@type": "Offer",
      "name": "베이직",
      "price": "19000",
      "priceCurrency": "KRW",
      "description": "캡션 주 3개, 해시태그, 바로 게시"
    },
    {
      "@type": "Offer",
      "name": "스탠다드",
      "price": "29000",
      "priceCurrency": "KRW",
      "description": "무제한 캡션, 예약 게시, 말투 학습"
    },
    {
      "@type": "Offer",
      "name": "프로",
      "price": "39000",
      "priceCurrency": "KRW",
      "description": "캘린더, 트렌드, 최적 시간 게시"
    }
  ]
}
```

#### FAQPage (index.html — 자주 묻는 질문 섹션)
```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "lumi가 뭔가요?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "사진 한 장만 올리면 AI가 캡션·해시태그를 써주고 인스타에 바로 올려주는 자동 포스팅 서비스예요."
      }
    },
    {
      "@type": "Question",
      "name": "비용이 얼마인가요?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "베이직 월 19,000원, 스탠다드 월 29,000원, 프로 월 39,000원이에요. SNS 대행사(50~100만원)의 1/10 가격이에요."
      }
    }
  ]
}
```

#### WebSite + SearchAction (index.html)
```json
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "lumi",
  "url": "https://lumi.it.kr"
}
```

#### BreadcrumbList (전체 하위 페이지)
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "홈", "item": "https://lumi.it.kr" },
    { "@type": "ListItem", "position": 2, "name": "베타 신청", "item": "https://lumi.it.kr/beta" }
  ]
}
```

### 5.3 검증 도구
- Google Rich Results Test: https://search.google.com/test/rich-results
- Schema.org Validator: https://validator.schema.org

---

## 6. 콘텐츠 전략

### 6.1 콘텐츠 필러 (Content Pillars)

| 필러 | 비중 | 목적 | 예시 토픽 |
|------|------|------|----------|
| 인스타 운영 노하우 | 35% | SEO 유입 | 캡션 작성법, 해시태그 전략, 릴스 활용 |
| 업종별 가이드 | 25% | 타겟 특화 | 카페 인스타 마케팅, 뷰티샵 인스타 팁 |
| 자동화/효율 | 20% | 제품 연결 | AI 마케팅 도구, 인스타 시간 절약 |
| 트렌드/인사이트 | 15% | 권위 구축 | 2026 인스타 알고리즘, 소상공인 마케팅 트렌드 |
| 사례/후기 | 5% | 신뢰 구축 | 사용자 인터뷰 (베타 후기 수집 후) |

### 6.2 키워드 맵 (구매 여정별)

#### 인지 단계 (Awareness)
| 키워드 | 월 검색량 (추정) | 난이도 | 콘텐츠 형태 |
|--------|-----------------|--------|------------|
| 인스타 캡션 쓰는법 | 높음 | 중 | 블로그 가이드 |
| 인스타 해시태그 추천 | 높음 | 중 | 블로그 + 무료 도구 |
| 소상공인 인스타 마케팅 | 중 | 중 | 종합 가이드 |
| 카페 인스타 운영 | 중 | 낮음 | 업종 가이드 |
| 인스타 게시물 올리는 시간 | 중 | 낮음 | 데이터 기반 글 |

#### 고려 단계 (Consideration)
| 키워드 | 월 검색량 (추정) | 난이도 | 콘텐츠 형태 |
|--------|-----------------|--------|------------|
| 인스타 자동 게시 | 중 | 중 | 비교 가이드 |
| AI 캡션 생성기 | 낮음 | 낮음 | 제품 페이지 |
| 인스타 대행사 비용 | 중 | 중 | vs 페이지 |
| 인스타 예약 게시 도구 | 중 | 중 | 비교 리뷰 |
| 인스타 마케팅 자동화 | 낮음 | 낮음 | 기능 페이지 |

#### 결정 단계 (Decision)
| 키워드 | 월 검색량 (추정) | 난이도 | 콘텐츠 형태 |
|--------|-----------------|--------|------------|
| lumi 인스타 | 극낮음 | 극낮음 | 홈페이지 |
| 인스타 자동화 가격 | 낮음 | 낮음 | 가격 페이지 |
| Buffer 한국어 대안 | 낮음 | 낮음 | alternatives 페이지 |
| Later 대안 한국 | 낮음 | 낮음 | alternatives 페이지 |

### 6.3 콘텐츠 우선순위 (Effort vs Impact)

**Phase 1: 즉시 (베타 기간)**
1. 업종별 인스타 가이드 3개 (카페, 음식점, 뷰티샵) → SEO + 타겟 유입
2. "인스타 캡션 쓰는법" 종합 가이드 → 검색량 높은 키워드 확보
3. 경쟁사 비교 페이지 2개 (대행사 vs lumi, ChatGPT vs lumi) → 결정 단계 전환

**Phase 2: 정식 출시 후**
4. 해시태그 전략 가이드 → 검색 유입
5. "인스타 예약 게시 도구 비교" → 비교 검색 유입
6. 베타 사용자 사례 → 신뢰 구축

**Phase 3: 성장기**
7. 업종별 가이드 확장 (꽃집, 베이커리, 헬스장)
8. 데이터 기반 인사이트 글 (최적 게시 시간 분석 등)
9. 무료 도구: "인스타 해시태그 생성기" → 리드 확보

### 6.4 콘텐츠 제작 템플릿

#### 블로그 글 구조
```
1. 훅 (pain point 공감) — 50~100자
2. 핵심 답변 (AI 인용 가능한 정의형) — 200자
3. 상세 가이드 (H2 3~5개) — 본문
4. 실전 예시 (업종별) — 구체적 사례
5. CTA ("지금 lumi 무료로 써보기") — /beta 유도
```

#### 업종별 가이드 구조
```
1. [업종] 인스타 왜 중요한가
2. [업종] 인스타 콘텐츠 아이디어 10가지
3. 캡션 작성 팁 + 예시 3개
4. 해시태그 전략
5. 게시 빈도 & 최적 시간
6. lumi로 자동화하기 (제품 연결)
```

---

## 7. 소셜 콘텐츠 플랜

### 7.1 채널 전략

| 채널 | 목적 | 빈도 | 콘텐츠 유형 |
|------|------|------|------------|
| 인스타그램 (@lumi.it.kr) | 제품 시연 + 타겟 도달 | 주 3~4회 | 릴스, 카루셀, 스토리 |
| 블로그 (lumi.it.kr/blog) | SEO + 권위 구축 | 주 1~2회 | 가이드, 팁 |
| 카카오 채널 | 기존 고객 리텐션 | 주 1회 | 팁, 업데이트 |

### 7.2 인스타그램 콘텐츠 필러 배분

| 필러 | 비중 | 콘텐츠 유형 | 예시 |
|------|------|------------|------|
| 교육/팁 | 40% | 카루셀, 릴스 | "카페 사장님이 쓰면 좋은 캡션 5가지" |
| 제품 시연 | 25% | 릴스, 스토리 | "사진 1장 올려서 캡션 받는 과정" (화면 녹화) |
| 공감/유머 | 20% | 밈, 릴스 | "인스타 올려야 하는데 캡션 못 쓰겠을 때" |
| 후기/사례 | 10% | 카루셀, 스토리 | 베타 사용자 인터뷰 (데이터 축적 후) |
| 공지/프로모션 | 5% | 피드, 스토리 | 베타 모집 마감 임박, 신기능 출시 |

### 7.3 월간 콘텐츠 캘린더 (예시: 2026년 5월)

| 주차 | 월 | 수 | 금 |
|------|-----|-----|-----|
| 1주 | [릴스] 사진 1장 → 캡션 자동 생성 과정 | [카루셀] 카페 인스타 캡션 5가지 예시 | [릴스] "대행사 100만원 vs lumi 2만원" |
| 2주 | [카루셀] 업종별 해시태그 추천 | [릴스] "캡션 쓰느라 30분 날리는 사장님" (공감) | [카루셀] 인스타 최적 게시 시간 |
| 3주 | [릴스] lumi 신기능 소개 | [카루셀] 음식점 인스타 운영 팁 | [릴스] Before/After (직접 쓴 글 vs lumi) |
| 4주 | [카루셀] 인스타 알고리즘 팁 | [릴스] 베타 사용자 후기 | [카루셀] 이번 달 인스타 트렌드 |

### 7.4 훅 공식 (소상공인 타겟)

1. **Pain → Solution**: "매일 인스타 캡션 쓰느라 30분 날리고 계세요? 사진만 올리면 끝나는 방법이 있어요."
2. **놀라운 수치**: "사장님들이 인스타에 매주 4시간을 쓴다는 거 아세요?"
3. **Before/After**: "이게 제가 쓴 캡션이고요... 이게 AI가 쓴 캡션이에요."
4. **비용 비교**: "대행사 월 100만원 vs 이거 월 2만원. 차이가 뭔지 보여드릴게요."
5. **업종 특화**: "카페 사장님이라면 이 해시태그 꼭 써야 해요."

### 7.5 콘텐츠 재활용 시스템

```
블로그 글 1개
├── 인스타 카루셀 1개 (핵심 포인트 5~7장)
├── 인스타 릴스 1개 (60초 요약)
├── 카카오 메시지 1개 (핵심 팁 + 블로그 링크)
└── 인스타 스토리 3개 (퀴즈/투표 형태)
```

---

## 8. 경쟁사 비교 페이지 제안

### 8.1 제안 페이지 목록

#### vs 페이지 (결정 단계 전환용)
| URL | 타이틀 | 타겟 키워드 |
|-----|--------|------------|
| /vs/agency | lumi vs SNS 대행사 — 월 2만원 vs 100만원 | 인스타 대행사 비용, 인스타 마케팅 대행 |
| /vs/chatgpt | lumi vs ChatGPT — 복붙 없이 바로 게시 | AI 캡션 생성, ChatGPT 인스타 캡션 |
| /vs/buffer | lumi vs Buffer — 한국 소상공인 특화 | Buffer 한국어, 인스타 예약 게시 |
| /vs/later | lumi vs Later — 캡션까지 자동 | Later 대안, Later 한국어 |

#### alternatives 페이지 (검색 유입용)
| URL | 타이틀 | 타겟 키워드 |
|-----|--------|------------|
| /alternatives/instagram-agency | 인스타 대행사 대안 — 월 2만원대 자동화 | 인스타 대행사 대안, 저렴한 인스타 마케팅 |
| /alternatives/later | Later 대안 — 한국 소상공인을 위한 | Later alternatives 한국 |
| /alternatives/buffer | Buffer 대안 — 한국어 캡션 자동 생성 | Buffer 대안 한국 |

### 8.2 비교 페이지 구조 템플릿

```
1. 한 줄 요약 (누가 이 글을 읽어야 하는지)
2. 비교 요약표 (5~7개 기준)
   - 가격, 한국어 지원, 캡션 자동 생성, 예약 게시, 업종 특화, 사용 난이도
3. 상세 비교 (기준별 H2)
4. "이런 분에게 추천" (양쪽 모두)
5. CTA ("lumi 무료로 써보기")
```

### 8.3 비교표 예시: lumi vs SNS 대행사

| 기준 | lumi | SNS 대행사 |
|------|------|-----------|
| 월 비용 | ₩19,000~39,000 | ₩500,000~1,000,000 |
| 캡션 작성 | AI 자동 (사진 분석) | 담당자 수동 |
| 게시 속도 | 즉시~예약 | 보통 1~3일 |
| 업종 이해도 | AI 학습 (말투 반영) | 담당자 역량 의존 |
| 컨트롤 | 사장님이 직접 확인/수정 | 대행사 주도 |
| 최소 계약 | 없음 (월 구독) | 보통 3~6개월 |
| 적합 대상 | 월 50만원 미만 마케팅 예산 | 월 100만원+ 예산 |

### 8.4 경쟁사별 핵심 차별점

| 경쟁사 | lumi의 차별점 |
|--------|--------------|
| 리플 (re:ple) | 리플은 DM/댓글 자동화, lumi는 콘텐츠(캡션+게시) 자동화 → 보완 관계 |
| 소셜비즈 | 소셜비즈는 DM 자동화 특화, lumi는 콘텐츠 생성~게시 전체 자동화 |
| Later | Later는 예약 게시만, lumi는 캡션 생성까지 → 한국어 특화 |
| Buffer | Buffer는 멀티 플랫폼, lumi는 인스타 특화 + 한국 소상공인 타겟 |
| Mirra | Mirra는 SNS 분석 중심, lumi는 콘텐츠 생성+게시 자동화 |

---

## 9. 실행 로드맵

### Phase 1: 즉시 (1~2주)
| 작업 | 영향도 | 난이도 | 담당 |
|------|--------|--------|------|
| meta description 확장 (index.html, beta.html) | 높음 | 쉬움 | implementer |
| beta.html canonical 태그 추가 | 높음 | 쉬움 | implementer |
| og:image 1200x630 제작 & 교체 | 높음 | 중 | implementer |
| sitemap.xml lastmod 추가 | 중 | 쉬움 | implementer |
| llms.txt 생성 | 중 | 쉬움 | implementer |
| FAQPage Schema 추가 (index.html) | 중 | 쉬움 | implementer |
| Organization Schema 추가 | 중 | 쉬움 | implementer |
| SoftwareApplication offers 3개 플랜으로 확장 | 중 | 쉬움 | implementer |

### Phase 2: 베타 기간 (2~4주)
| 작업 | 영향도 | 난이도 | 담당 |
|------|--------|--------|------|
| /blog/ 허브 페이지 구축 | 높음 | 중 | implementer |
| "인스타 캡션 쓰는법" 가이드 작성 | 높음 | 중 | marketer |
| 카페 인스타 가이드 작성 | 높음 | 중 | marketer |
| /vs/agency 비교 페이지 | 중 | 중 | marketer + implementer |
| /vs/chatgpt 비교 페이지 | 중 | 중 | marketer + implementer |
| pricing.md 생성 | 낮음 | 쉬움 | implementer |
| 인스타그램 계정 개설 & 콘텐츠 시작 | 높음 | 중 | marketer |

### Phase 3: 정식 출시 후 (1~3개월)
| 작업 | 영향도 | 난이도 | 담당 |
|------|--------|--------|------|
| 업종별 가이드 확장 (음식점, 뷰티샵) | 높음 | 중 | marketer |
| 베타 사용자 사례/후기 콘텐츠 | 높음 | 중 | marketer |
| /alternatives/ 페이지 3개 | 중 | 중 | marketer + implementer |
| 해시태그 무료 생성 도구 | 높음 | 높음 | implementer |
| BreadcrumbList Schema 전체 적용 | 낮음 | 쉬움 | implementer |
| Pretendard 폰트 preload 최적화 | 낮음 | 쉬움 | implementer |

### 예상 효과 (6개월)
- **검색 유입**: 현재 거의 0 → 블로그 콘텐츠 + 비교 페이지로 월 500~1,000 방문 예상
- **AI 검색 노출**: llms.txt + FAQ Schema + 정의형 콘텐츠로 "인스타 자동 포스팅" 관련 AI 답변에 인용 가능성 확보
- **전환율**: meta description 개선 + og:image 교체로 CTR 2~5% 개선
- **브랜드 인지도**: 인스타 콘텐츠 + 블로그로 소상공인 커뮤니티 내 인지도 구축

---

> 이 보고서는 2026-04-09 기준이며, 각 작업의 상세 구현은 담당 에이전트(implementer/marketer)에게 위임하여 진행합니다.
