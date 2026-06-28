# 루미(lumi) 인수인계 — 2026-06-28

> 새 로컬/세션이 이어받기 위한 문서. `~/.claude` 자동 메모리는 머신 간 동기화 안 되므로 이 파일이 단일 소스.
> 새 세션 첫 메시지에 이 내용을 붙여넣거나, repo에서 `git pull` 후 이 파일을 읽게 할 것.

## 0. 환경 / 접근

> ⚠️ **2026-06-21 검증 정정**: lumi **전체가 Netlify→GCP self-host로 이전됨**(라이브 `lumi.it.kr` 응답 헤더 `via: Caddy` 확인, Netlify 아님). 아래 + **문서 곳곳의 'Netlify env / git push 빌드 / Netlify CDN' 표현은 전부 GCP 기준으로 읽을 것** — env=`ecosystem.config.js` apps[0].env(Netlify env 아님), 라이브 배포=rsync + `pm2 reload lumi`(git push 아님).

- **repo**: `~/lumi.it` · **라이브**: lumi.it.kr (**GCP 서빙**) · **진단**: `/api/cron-health`
- **스택**: **GCP VM `34.158.206.244` self-host** — `server.js`(Express)가 `netlify/functions/*.js`를 `/api/<name>` 자동 마운트(PORT 8080), **PM2**(앱 `lumi`, online), **Caddy**(HTTPS, `lumi.it.kr`·`www`→`localhost:8080`) + Supabase(ap-northeast-2 서울). (`NETLIFY_*` env는 일부 잔존하나 **라이브 서빙 경로 아님**.)
- **배포**: ⚠️ **`git push` ≠ 라이브 배포**. git push는 GitHub 버전관리/백업만 — **라이브 반영은 `rsync` + `pm2 reload lumi`**(소싱 §1의 rsync 절차 참조). `netlify.toml`(라우팅)은 잔존하나 Netlify 빌드는 라이브와 무관.
- **인증**: `~/.ssh/lumi_gcp`(GCP, user=lumi, HOME=/home/lumi) + GitHub PAT 키체인(push).
- **브라우저 정정**: 메모리 `user_browser.md`에 "Chrome"으로 적혀 있는데 **사장님은 크롬 안 씀**(직접 정정함). 메모리가 틀림 — pull-to-refresh/overscroll 가정 시 주의.
- **현재 상태(2026-06-21 검증)**: `main`, 최신 커밋 `07a9220`(이전 문서의 `c4b2373`는 2026-06-08 시점 박제였음). **작업중 미커밋**: `server.js`·`_shared/blobs-shim.js`(신규) + 함수 8개(comments·insight-*·keyword-detail·reply-comment·naver-ad-keyword-tool·seller-cache) = **GCP 이전 잔여**(Netlify Blobs→shim 대체). 루트 ops SQL `performance-rls.sql`(선택, 비긴급).

## 1. lumi 현재 배포 상태 (전부 main 머지 완료)

### ⭐⭐⭐ 2026-06-28 세션 — gpt-image-2 한글 직접렌더 전환 + 기존 상세 구조 재현 + 품질개선 [★최신/현재 작업]

> **★방향 대전환 (6-24 "글자=텍스트 레이어" 폐기)**: gpt-image-2가 한글 글씨까지 이미지에 **직접 렌더**(실측: 스펙 10행 정확). 하이브리드(화보 텍스트0+SVG 합성)·editor.html(fabric) 폐기. 트레이드오프: 글자가 이미지에 박혀 **고객 무료 텍스트 편집 불가**(재생성=유료만). 사장님 수용(품질>무료편집).

**핵심 (전부 라이브, 최신 커밋 `e1a3068`):**
- **기존 상세 구조 분석→재현(A+B)**: `analyzeReferenceStyle`이 structure(섹션순서 hero/full/grid2/grid3/text/spec, 최대20) 추출 → `refBlockPlan`이 그 순서대로 재현(섹션 손실 0). image모드 기본화(레퍼런스 없으면 자기 descImages를 레퍼런스로). structure<3이면 카테고리 표준 fallback.
- **비용 실측**: 분석 184원(gpt-5.5 vision) + 이미지 58원/블록(gpt-image-2 medium, output 1372토큰) + 카피 ~35원(추정). quality high=불필요(medium=high 한글 완전동일, output토큰 4배=227원). 5블록~510원 / 14블록~1030원.
- **무료 품질개선 7개**: ①프롬프트튜닝(THE TEXT READS 래퍼+제품보존+폰트 Pretendard, `44a6639`) ②정보누락0(칸제한 제거+페이지네이션 — 넘치는 스펙/기능 다음블록으로, `cc781d0`) ③미사용카피 블록화(혜택/비교/FAQ, `faabb24`) ④카테고리 fallback(`detectCategory` 5종 키워드매칭→`CATEGORY_TEMPLATES` 화장품/건기식/가전/패션/식품, `c47d0fd`) ⑤input_fidelity(gpt-image-2 자동 high라 불필요) ⑥가드레일(softenClaims에 완치/부작용없음/질병치료 차단)+4요소락(`2dc8893`) ⑦hero 톤앵커(첫블록을 refImage로 후속 블록에 첨부, `fd569ef`).
- **식품/건기식 법정 검수경고**(`e1a3068`): `detectCategory`→food/supplement면 결과화면 주황배너+reviewPoints 맨앞("법정 표시 AI 렌더 오타 검수"). ★생성은 하되 검수강제(AI생성 자체가 불법 아님 — 렌더 오타 위험이지, 사장님 정정). 근본(법정고지만 HTML텍스트화)은 추후.
- **3개 소스 상세추출 강화**(도매꾹 //URL+webp · 도매토피아 · 일반 body img). 분석 상세 4→12장 확대.

**경쟁사 리서치(메모리가 정본)**: `project_competitor_pricing`(AI상세=건당정액 알잘 2,500원/가비아 구독+토큰, 길이직접과금 없음 → 루미 권장 건당 1,900~2,900원 정액) · `project_competitor_block_logic`(국내주류 ②카테고리인식+③AI자동, 루미=④레퍼런스 구조복제 국내유일) · `project_detail_maker_quality_research`(카테고리 섹션템플릿+적용 로드맵, GitHub스킬 rampstack/nexscope).

**⚠️ 미해결/다음**:
- ✅ **6-28 후반 완료**: ④레퍼런스·구조 분리(레퍼런스=디자인만/구조=내 제품, 레퍼런스 줘도 섹션순서는 내 상세 기준 — generate-detail.js refImgs면 selfImgs 구조로 교체, `9d340b3`) · create.html UX(미리보기 max-height 180+생성시 입력 #inputArea 숨김+새로만들기, `580efb3`) · 동시 생성(생성을 작업큐 localStorage 'lumi_pending' 등록→studio가 폴링해 진행중 구름카드, `bebaa21`).
- ✅ **부수 완료**: 브랜치 claude/handover-review-112s8m의 폴링제한제거·로딩문구·정보블록만생성을 main에 cherry-pick 합치기 · 사장님 admin 무제한(ecosystem.config.js `LUMI_ADMIN_USER_IDS`=사장님 seller_id 30a95ce4-…) · 생성중 로더를 루미 로고 구름(`assets/cloud-alpha.png` mask+브랜드그라데이션 둥둥, `8df10e4`).
- 🔴 **전체 e2e 실측** — 위 개선들이 실제 충실도를 올렸는지 baseline 미검증(코드/단위테스트만). 사장님이 admin이라 무제한 생성 가능 → 실제 생성으로 검증 필요.
- 🟡 **과금 시스템** — 크레딧 블록 비례 차감 + 결제/충전 + 플랜(현재 무료 2회만, 유료 미구현). 마진모델=기본 500원+블록당 100원(마진 ~46%).
- 🟡 자연어 편집("이렇게 고쳐줘") · 분석결과(facts+structure) DB저장(사진만 와도 활용).

### ⭐⭐⭐ 2026-06-24 세션 — 상세페이지 메이커: 블록 에디터 전환 [⚠️구방향 — 6-28 gpt-image-2 직접렌더로 폐기, 아래는 역사 보존]

> **제품 컨셉 확정 (사장님)**: 두 버전으로 어필. ①**쉬운 버전** = 참고할 상세페이지를 붙여넣으면 AI가 참고해 생성 + **글씨만 수정**(대부분 셀러용). ②**어려운 버전** = 미리캔버스·제디터처럼 **캔바식 풀 편집**(폰트·색·위치·도형 자유). 둘 다 같은 AI 생성 결과의 두 출구.

> **편집/퀄리티 딜레마 최종 해법(반드시 읽을 것)**: 글자를 사진에 구우면(통이미지) 화려하나 편집 불가, HTML로 빼면 편집되나 밋밋 — **둘 다 동시는 물리적으로 불가**. → **화보 = 글자없는 통이미지(화려)**, **글자 = 텍스트 레이어(사진 위 오버레이, 수정 가능)**. 화려함은 **레퍼런스 참고**로 보강(그대로 복제 X = 법적 안전: 아이디어·스타일·레이아웃은 저작권 보호 대상 아님, 실제 사진·문구 복제만 침해 → "참고 후 재생성"으로 가드 + 약관 고지). ★내 CSS 디자인 감각 약함 재입증(화려 시안 3번 거부) → 0에서 창작 포기, **레퍼런스 기반**으로 전환.

**이번 세션 구현 (브랜치 `claude/handover-review-112s8m`, PR #254 draft — 아직 main 미머지, 라이브 미배포)**:
- `netlify/functions/_shared/detail-page.js`: 블록 모델/렌더러 추가 — `scenePlan`(글자없는 화보 컷, 레퍼런스 무드 주입), `copyToBlocks`(카피+화보→편집블록), `renderBlocks`/`renderBlock`(블록→HTML, 편집텍스트에 `data-b`/`data-f`/`data-i` 마킹), `specRowsData`, **`analyzeReferenceStyle`**(레퍼런스 캡처→색·무드·레이아웃만 비전 추출, 콘텐츠 복제 X). 기존 `cutPlan`/`assembleCutPage`(통이미지 글자박힘)는 호출처 사라졌으나 롤백/비교용 보존(무해).
- `netlify/functions/generate-detail.js`: 글자없는 화보(scenePlan)+편집블록(copyToBlocks)+레퍼런스 팔레트(`paletteFromHex`)로 전환. 결과에 `blocks`/`palette`/`styleHint` 반환. `referenceImageBase64` 받아 스타일 주입.
- **`editor.html` 신규 (어려운 버전 = 캔바식)**: fabric.js 5.3. 글자 자유편집(폰트·색·크기·위치 드래그·정렬·투명도·그림자·외곽선), 도형(사각형·원·선), 실행취소/다시(Ctrl+Z/Y), 키보드(Delete·화살표·Ctrl+C/V/D), 레이어 순서, 캔버스 확장, JSON 저장/PNG 내보내기. `loadBlocks`로 AI 결과(blocks)를 **사진 위 글자 오버레이**로 펼침(sessionStorage `lumi_editor_blocks` 수신).
- `detail-maker.html`: 결과에 **글씨만 수정(쉬운)**/**정밀 편집(어려운)** 분기 + **디자인 레퍼런스 입력**(referenceImageBase64). 작동 안 하던 designMode '직접 수정' 버튼·미사용 컷저장 핸들러 제거.
- (앞선 6-24 작업) 결과 영구저장(`r/{jobId}.html`), IP rate 5회/일, 도매토피아 파서, 2단계 분석 흐름(`runAnalysis`/step='analyze'), 캡처 업로드.

**⚠️ 미검증/다음 (이 작업환경은 AI키·브라우저 없어 실측 불가 → 사장님 배포 후 확인 필수)**:
- 🔴 **배포 + 첫 실측**: rsync(`detail-page.js`→`netlify/functions/_shared/`, `generate-detail.js`→`netlify/functions/`, `editor.html`·`detail-maker.html`→루트) + `pm2 reload lumi`. gpt-image-2 화보 화려함·레퍼런스 모방·editor 동작 실측. (코드는 node 구문/로직 검증만 통과, AI 호출·브라우저 동작 미실측.)
- 🔴 **블록 자동배치(위치·여백·오버레이 좌표) 첫 테스트서 조정 필요 예상** — editor `loadBlocks`의 텍스트 높이 추정이 대략적이라 겹침/공백 가능(에디터서 수동조정 전제이긴 함).
- 🟡 **쉬운 버전 "붙여넣기" 강화**(URL/이미지 Ctrl+V — 사장님 "붙여넣으면" 컨셉, 현재는 파일 업로드만). 🟡 어려운 버전 기능 보강(텍스트 배경 하이라이트·자간/행간·정렬 스냅 가이드·그라디언트), 모바일 터치·줌.
- 화려함은 **레퍼런스 품질이 좌우** — 사장님 레퍼런스 1장이 디자인 기준(미리캔버스 `/template/detail_page`·핀터레스트서 캡처, 봇차단이라 내가 직접 수집 불가). 데모는 회색 placeholder로만 검증(`scratchpad/demo-editor.html`).

### ⭐⭐ 2026-06-23 세션 — 상세페이지 메이커 (기반 구축) [소싱→상세제작 SaaS 피벗]

> 도매꾹/쇼핑몰 상품 → **AI 디자인 컷 상세페이지 자동 생성**. 라이브: lumi.it.kr/detail-maker.html + 크롬 확장. 셀러의 평범한 상품사진을 너츠굿/PagePilot급 고퀄 상세페이지로 업그레이드.

**흐름**: 입력(도매꾹 링크 or 사진) → 베이스 화보(gpt-image-2) → 카피 → **화려한 디자인 컷**(한글 그래픽 합성) + 설명 텍스트 교대 → 풀 상세페이지.

**핵심 파일**:
- `netlify/functions/generate-detail.js`: 생성 API. **비동기(job+폴링)** — POST{url|title+imageBase64}→jobId(202)→백그라운드 생성→GET?jobId 폴링(생성 2~3분이라 동기 응답은 프록시/브라우저 타임아웃). 모듈스코프 `jobs{}`(30분 TTL). runGeneration: getItemView→베이스화보→카피→디자인컷(3개씩 배치)→조립.
- `_shared/detail-page.js`: 엔진. **generateAiPhoto**(gpt-image-2 edits, 제품유지+배경교체+한글, 3회 재시도). **photoPrompt**(단일제품/배경완전교체/텍스트제거). **cutPlan**(카피·옵션 기반 컷별 연출: 히어로 3/4틸트·손모델·디테일 클로즈업·혜택 탑다운·색상라인업·비교·CTA). **assembleCutPage**(컷+설명 교대, accent 팔레트). **accentPalette**(화보에서 유채색 hue 추출→{accent,soft,ink}, sharp; 무채색이면 기본 틸 graceful). buildHtml=레거시 폴백.
- `detail-maker.html`: 랜딩+도구. 비포애프터(_src→_gpt2_low)/3단계/입력도구(폴링)/예시(_example.png)/CTA + **결과 컷 PNG 다운로드**.
- `chrome-extension/`(MV3): content.js(상품페이지 자동 플로팅 버튼)+popup.js+background.js. **비동기 폴링**(lumi-start→jobId, lumi-poll→GET). 차단사이트(쿠팡/스마트스토어)는 content가 DOM(og/JSON-LD) 추출→차단 우회. ⚠️ 로컬 로드만(웹스토어 미등록).

**확정**: ①이미지=**gpt-image-2 edits, quality medium**(실측 72원/장; low 19/high 258, high는 차이 작아 비추). ②상품당 **~400~540원**(베이스+5~7컷+카피). 드랩아트(800)/제디터(1300)보다 쌈. ③HTML 도형은 화려함 천장 — **gpt-image-2가 한글 안깨짐+그래픽 합성**이 돌파구. ④Higgsfield/Gemini 이미지는 무료티어 막힘→OpenAI(gpt-image-2)만. ⑤컷마다 다른 앵글/연출(손모델·색상·클로즈업). ⑥이 세션 OpenAI 테스트비용 누적 ~2천원대.

**남은 것**: 🔴 사장님 도구/확장 실작동 테스트(브라우저). 크롬 웹스토어 등록(공개=추가버튼). 회원/결제(수익화). 타사이트 확대(스마트스토어/알리—확장으로 차단우회). 색상옵션별 실제화보(도매꾹 8색→각색 컷).

### ⭐⭐ 2026-06-18~20 세션 — 소싱(매입 차익) 시스템 [⏸️ 2026-06-23 자동실행 중단(사장님 지시까지) · 별도 서브시스템, GCP 배포]

> ⏸️ **소싱봇 중단**: `launchctl unload -w ~/Library/LaunchAgents/com.lumi.sourcing-daily.plist`로 매일8시 자동실행 끔(2026-06-23). 다시 켜기: `launchctl load -w ~/Library/LaunchAgents/com.lumi.sourcing-daily.plist`. (사장님이 상세페이지 메이커로 피벗 — "내가 말할 때까지 중단".)

> 사장님(gung3625@gmail.com) **메인 사업**. 캡션/인스타 제품과 별개. 이 기기 메모리 `~/.claude/.../memory/project_sourcing_system.md`에 더 상세(머신 동기화 안 됨 → 이 문단이 정본).

**개요**: 도매꾹 매입 → 쿠팡 **로켓그로스** 재판매 차익 자동화. 흐름: 조사(쿠팡 수요+도매꾹 매입가)→높은확률 추천 메일(매일 8시)→[사장님 승인]→매입(setOrder)→상세페이지 자동생성→쿠팡 로켓그로스 등록.

**⚠️⚠️ 배포가 다름 (Netlify push 아님 — GCP self-host)**:
- 소싱은 **GCP VM `34.158.206.244`**: `server.js`(Express가 `netlify/functions/*.js`를 `/api/<name>` 자동마운트) + PM2(앱명 `lumi`) + Caddy(HTTPS). (쿠팡 WING IP 화이트리스트 + 도매꾹 세션파일 때문에 GCP 고정.)
- **배포=rsync**: `rsync -e "ssh -i ~/.ssh/lumi_gcp" <파일> lumi@34.158.206.244:/home/lumi/lumi/<경로>` 후 `ssh -i ~/.ssh/lumi_gcp lumi@34.158.206.244 'pm2 reload lumi'`. SSH키=`~/.ssh/lumi_gcp`(user=lumi, HOME=/home/lumi). **env는 `~/lumi/ecosystem.config.js` apps[0].env**(PM2). git push는 버전관리만.
- 서버 함수 테스트: `cd ~/lumi && node -e "const e=require('./ecosystem.config.js');Object.assign(process.env,e.apps[0].env);..."`.

**핵심 파일**:
- `scripts/coupang-scan.js`(Mac 로컬, gitignored, launchd `com.lumi.sourcing-daily` 매일8시): osascript로 진짜 크롬 제어→쿠팡 인기/리뷰 스크래핑(Akamai가 API·헤드리스 다 차단→이 방법뿐). GCP로 POST.
- `admin-sourcing-report.js`: 소싱 두뇌. computePricing(무광고 adRate 0)·turnoverVerdict(수요×추세×진입장벽 게이트)·LLM 랭킹/카피. **provider:'gemini'(무료)**. Resend 메일.
- `_shared/domeggook-api.js`: 도매꾹 OpenAPI. getItemView(스펙·옵션·**resale.allowed 재판매여부**·**descImages 상세컷이미지** 추출)·setOrderDome(매입,dryRun기본)·cancelOrderDome(취소)·getDefaultDeliinfo(집)/getGemiDeliinfo(개미창고).
- `_shared/coupang-rocket-api.js`: 로켓그로스 등록(seller-products+rocketGrowthItemData)·predictCategory·출고/반품지.
- `_shared/coupang-wing-api.js`: 쿠팡 WING HMAC.
- `_shared/detail-page.js`: 상세페이지 카피/구조 엔진. webseller 구매심리 구조 + **aisyncclub/detail_page_codex_skill(MIT) 표준**(copy-compliance 위험표현필터·photo-analysis·cut-structure) 이식. **비전(Gemini)이 도매꾹 상세 이미지서 실제 기능 추출**(제목제약+판매자정보필터). 카피=**GPT-4o**. buildHtml 에디토리얼 재설계 커밋됨(`a9834d1`).
- `admin-source-to-listing.js`: 오케스트레이터(상품번호1개→매입+상세+등록, dryRun). `admin-detail-page.js`: 상세 단독.

> **⭐⭐ 상세페이지 방향 전환 (6/20, 사장님 확정 "네 이 방식으로 전체")**: HTML 템플릿(buildHtml)은 '사진 따로 / 글 따로'라 아무리 타이포·여백 다듬어도 퀄리티 천장(사장님 2번 "안좋다") → **디자인 이미지 컷 방식**으로 전환. 각 컷 = 사진+카피+그래픽이 **한 장에 합성**된 이미지(드랩아트/webseller 방식). **수동 데모만 존재**(텀블러 1건): `/tmp/full_detail.html` 7컷(히어로·혜택01~03·8색스와치·라이프스타일·THE DIFFERENCE·제품정보·CTA) → **로컬 Chrome headless 렌더**(`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=1080,6700 --virtual-time-budget=9000 --screenshot=out.png file:///tmp/full_detail.html` + Pretendard CDN link + **각 컷 height 고정**(가변컷에 px 명시→여백0)) → 1080×6700 PNG → rsync로 lumi.it.kr/_full_detail.png 호스팅. 디자인 토큰: 잉크 `#16140f` / 크림 `#f3efe8` / 흰 / 악센트 카라멜 `#c98a4e`, 다크↔크림↔흰 교대. **아직 코드화 안 됨** — buildHtml(HTML)→디자인컷 렌더러(PNG) 교체가 다음 작업.

**인증/시크릿(GCP env + 서버 600파일)**: env=DOMEGGOOK_API_KEY(dd20…)·DOMEGGOOK_USER_ID=gung3625·COUPANG_ACCESS/SECRET/VENDOR_ID(A00968893)·OPENAI_API_KEY·GEMINI_API_KEY(무료)·NAVER_*·LUMI_SECRET. 파일=`~/.dgk_pw`(도매꾹비번,사장님직접)·`~/.dgk_session`·`~/.dgk_deliinfo`(집)·`~/.dgk_deliinfo_gemi`(개미창고). 도매꾹 Private API 권한 승인(로그인·주문조회·setOrder·setOrdDeny). 쿠팡 로켓그로스 API동의 완료. ★**출고지/반품지는 코드 하드코딩 아님**(검증 2026-06-21) — `getOutboundShippingPlaces()`/`getReturnCenters()`가 쿠팡 API서 조회 후 **첫번째 자동선택**(`places[0].code`). 사장님 메모 등록값(출고지 21219014/반품지 1001965390)이 목록 첫번째와 다르면 오선택 → **첫 실주문 전 places[0] 확인 필수**.

**확정 결정**: ①매입처=도매꾹 단독(Phase1)/Phase2=AliExpress DS API/Temu·차이나꾹 제외. ②물류=**개미창고 3PL**(매입→개미창고 직배송→바코드·검수·쿠팡납품, 이천센터 배송지). ③**무광고 전략**(광고비=적자 주범, adRate0, 진입장벽 낮은 organic 판매가능 상품만). ④"높은확률만, 작게 사서 데이터로 키운다". ⑤LLM 소싱=무료Gemini/상세=GPT-4o. 영상 제외. ⑥**이미지=Higgsfield marketing_studio_image로 직접 화보 생성**(도매꾹 평범사진→손모델+소품+사용장면 연출, MCP `mcp__f3d214c3-…`). ★텀블러는 '배경만 교체'라 약했음 → **연출 프롬프트에 손모델·소품·사용장면을 넣어야 드랩아트급 화보**(원본 octet-stream은 media_import_url 거부→lumi.it.kr에 .png 재호스팅 후 임포트, model='marketing_studio_image' 2크레딧/장, role:"image"). 드랩아트(draph.art, 장당 800원)/PicCopilot은 백업.

**남은 것**: ✅예치금 10만원 충전됨 → 실매입 테스트(저가상품 매입→즉시취소→환불) 미실행. **setOrder item포맷(옵션 optCode) 연동매뉴얼 검증 필요**(첫 실주문 전). resale.allowed 게이트 오케스트레이터에 미연결. 상품별 바코드/무게치수(로켓그로스 필수)=실물 실측 or 도매꾹값(자주 쓰레기). 🔴**Higgsfield 크레딧 블로커**: 무료 잔액 1크레딧(화보 1장=2크레딧)→지금 생성 불가. 본격화=**Higgsfield Plus 사장님 직접 결제**(~$34/월≈1000크레딧, 장당~90원). 결제하면 상세페이지 ≈**상품당 400원**(AI사진2장~350+카피GPT~37+컷합성 코드무료+비전Gemini무료, 드랩아트 800원의 절반). 🔴**디자인 컷 코드화 미완**(buildHtml→PNG 디자인컷 렌더러 교체, 현재 텀블러 수동데모 1건뿐). `domeggookSearch`는 **itemNo 미반환**(name+price만 줌)→검색결과로 getItemView 불가, 특정상품 화보는 도매꾹 URL/번호 직접 필요(영문브랜드는 한글검색 0건). ⚠️교훈: 도매꾹 상세이미지엔 셀러 다른모델·연락처 섞임(필터필수). "창작" 단정 전 제목/스펙/옵션/이미지 다 확인할 것(사장님 4번 지적).

### ⭐ 2026-06-17 세션 (PayApp 결제 백엔드 + 앱 셸 통일 + 정리)

**A. PayApp 정기결제 백엔드 — 구현·배포 완료** (`abb297e`·`9fccf2a`):
- env 등록: `PAYAPP_USERID`(=`gung3625`)·`PAYAPP_LINKKEY`·`PAYAPP_LINKVAL` — secrets.env(루트, gitignore `*.env`)에 넣고 `netlify env:import` 후 파일 삭제(시크릿 코드/로그/repo 무노출). 🔴 **LINKKEY/LINKVAL은 채팅에 평문 노출됨 → 결제 정식 오픈 전 PayApp 콘솔서 재발급 필수.**
- DB 마이그레이션 적용(`payapp_subscription_columns_and_events`): `sellers` 구독컬럼 6개(`subscription_status` none|pending|active|past_due|stopped|cancelled · `payapp_rebill_no` · `payapp_last_mul_no` · `subscription_started_at` · `subscription_cancelled_at` · `next_billing_date`) + `payapp_events`(mul_no PK 멱등, deny-all RLS). ★status에 CHECK 미설정(인수 'DB 체크제약 함정' 교훈).
- 함수: `payapp-subscribe`(rebillRegist→`payurl` 리다이렉트) / `payapp-webhook`(feedbackurl·failurl 공용, `userid+linkkey+linkval` timing-safe 검증 + mul_no 멱등 + `pay_state`=4→active / =99→past_due) / `payapp-cancel`(rebillCancel) / `get-subscription`(상태조회) + `_shared/payapp.js`. netlify.toml `/api/payapp-*`·`/api/get-subscription`·`/subscribe` 라우트.
- 스펙: [docs/payapp-integration.md](docs/payapp-integration.md) — 1차 source 정독본. 방식=**REST**(JS 래퍼 아님), 응답=쿼리스트링(JSON 아님), 결제수단 `card`.
- 독립 보안리뷰+수정: 금액검증 fail-closed(price=0/누락 거부), **멱등 활성화-우선**(insert먼저면 UPDATE 실패 시 재시도가 멱등게이트에 막혀 활성화 영구누락), raw 감사(linkval/linkkey/userid 제외), pending 저장 실패 시 결제 진행 차단.
- 프론트: **`/subscribe`** (인증 구독페이지 — Pro카드 + 상태별 액션[미구독/구독중/진행중/실패] + 자동결제 고지). lumi 정체성 유지. 미리보기 QA 완료.
- ⚠️ **미완**: ① 실 결제 E2E 미검증 — PayApp 콘솔 **정기결제 기능 ON + 테스트모드 유무** 확인 후 가능(둘 다 문서 미기재, 안 켜졌으면 rebillRegist state=0) ② **진입 링크 없음**(직접 `/subscribe`만 — 대시보드/설정 "구독" 버튼 미추가) ③ **법무 카피**(pricing "1:1 안내"→자동결제 고지, terms 정기결제·해지 조항) 미반영.

**B. 앱 셸 통일 + 정리**:
- `css/app-shell.css` 신설 — settings/trends/history에 대시보드 동일 **데스크톱 좌측 사이드바**(≥960px만, 모바일 무영향). 사장님 "설정 누르면 옛 화면" 해소 (`d386028`). ⚠️ 사이드바 매장명은 서브페이지선 "내 매장" 기본값(대시보드만 실명 — 추후 각 페이지 JS에서 채우면 됨).
- 앱 6페이지(settings/trends/history/insights/comments/register-product) **footer 제거**(`8ce394b`) — 대시보드 일관. 법적링크는 사이드바 하단, 사업자정보는 공개페이지(beta/index/pricing)에 유지. (`.app-footer` CSS는 legal.css/beta.css에 잔존 — beta가 씀, 무해.)
- 설정 **캡션 말투 섹션 제거**(HTML+JS, `31f24ef`). `auth.js` CORS `NODE_ENV` 폴백 제거(보안 M3 — 프로덕션 localhost 노출 차단, `31d8605`). **SW v59→v60**(`8cf4fac` — 위 변경들 옛 캐시 무효화).

**C. 경쟁/시장 조사 (코드 변경 X — 결정 대기)**:
- **autoke.ai/ko 전수 분석** → lumi 가져올 것(우선순위): ①문제 프레임 3종("도구는 5개 성과는 0" 등) ②정량 숫자 대비(대행사 월 수백 vs 19,900 — **정직하게**, 보장수치 금지) ③FAQ 보강(편집/연동필수/해지) ④CTA "언제든 해지" ⑤펀치 클로징("비결은 루미가, 장사는 사장님이"). **안 가져올 것**: 가짜 사회적증명(50개 브랜드 — lumi 0고객+가짜후기 금지), 미니멀 흑백(핑크/시그니처 유지), 크레딧 다단계 요금(단일플랜 결정). → **구현은 사장님 픽 대기.**
- **탭나우=TapNow(tapnow.ai)** 조사: AI 비주얼·영상 광고 생성 "크리에이티브 캔버스"(글로벌, 중국계 추정). lumi 직접경쟁 아님(레이어 다름 — 비주얼생성 vs 사진기반 캡션). 단 **영상합성 Phase2(Veo/Sora)와 겹침** → build-vs-buy 참고감.

### ⭐ 2026-06-16 세션 (대시보드 데스크톱 재설계 + PayApp 결제 검토)

**A. 대시보드 재설계 — autoke(autoke.ai/ko/calendar) 벤치마킹**:
- 커밋 `be96420`(캘린더 중심 재설계) + `7a14aa2`(데스크톱 사이드바·위젯·실측비율·푸터제거) — **둘 다 push·배포 완료**(6/17 확인).
- 구조: **모바일** = 하단 탭바 + 세로 피드 / **데스크톱** = 좌측 사이드바(홈·트렌드·히스토리·설정) + 캘린더 2단(좌 캘린더 | 우 선택일 패널).
- ★autoke는 **레이아웃(구조)만 참고**, 색·질감은 **lumi 정체성 유지**(시그니처 그라데이션·종이질감·warm-glow·핑크). ← 이거 한 번 놓쳐서 사장님 강하게 지적함. 미니멀 흑백으로 가지 말 것.
- autoke 실측 반영: 캘린더 셀 88×112px·날짜 좌상단, 사이드바 ~240px, 메인 max 1280 중앙(사이드바 flex), '새 게시물' 버튼 작게.
- 우측 정보 위젯(이번 주 반응·새 댓글 + '전체→' 링크) = 데스크톱 여백 활용(사장님 아이디어). 모바일은 칩. 위젯이 사이드바와 중복돼 사이드바에서 인사이트·댓글 뺌. 캘린더 날짜 점 = 예약●/게시✓/실패!.
- 배포는 완료(라이브=재설계판). ⚠️ 단 **실 셀러 계정 e2e**(실 예약으로 캘린더 점·날짜 탭·`register-product?date=` 처리)는 여전히 미검증 — mock 으로만 봄(긴급 아님, 실셀러 쓰면 자연 검증).

**B. PayApp 결제 연동 검토 (Stripe 폐기 → PayApp)**:
- ★Stripe = **한국 사업자 미지원**(원화·가맹점 계정 불가) → lumi(404-09-66416) 사용 불가. 폐기.
- **PayApp**(docs.payapp.kr) 선택 — 한국 PG, **정기결제 지원**(`rebillRegist`/`Cancel`/`Stop`/`Start`). REST `api.payapp.kr/oapi/apiLoad.html` + `feedbackurl` 콜백(HTTP200+'SUCCESS', 멱등은 mul_no/var1·var2). 결제수단 card·kakaopay·naverpay 등.
- 설계: 함수 3개(`payapp-subscribe`=rebillRegist / `payapp-feedback`=콜백·linkval검증 / `payapp-cancel`) + `sellers` 구독 컬럼(status·rebill_no·next_billing_date) + 프론트 구독 버튼. 정책 "카드 등록 X" → 정기결제로 변경 필요.
- 인증 env: `PAYAPP_USERID`·`PAYAPP_LINKKEY`·`PAYAPP_LINKVAL`.
- **✅ 백엔드 구현·배포 완료** — 상세는 위 **2026-06-17 세션 A항목**(함수·DB·env·보안리뷰·`/subscribe`). 남은 건 콘솔 확인·재발급·진입링크·법무.

### 2026-06-11~12 세션 (정식출시·포지셔닝·분석강화·3D리빌드)

> 커밋 범위 `9751108`~`0720d53`. 메모리 `lumi-handover.md`(이 기기 전용)에 더 상세. 핵심만:

**A. 정식 출시 전환** (`4e5820f`·`294d8be`) ★사장님 "돈 받을거야":
- 무료·베타 카피 전 페이지 제거, Free(₩0) 폐지 → **Pro 단일 월 19,900원**(이미 게시돼 있던 가격 — 발명 X). "30일 전 공지 후 동의 결제" 약속 문구 삭제.
- **결제 = 사장님 직접 청구**(PG 미연동). pricing "가입 후 1:1 안내", refund 유료 규정 본문 승격, terms 14조 재작성.
- **신규 가입 알림 메일 신설**(signup-complete → lumi@): 매장명·업종·전화·선호연락·seller_id + 다음 할 일. 직접청구의 필수 고리(가입만 하고 연동요청 안 하면 사장님이 몰랐음). RESEND_API_KEY 실재.

**B. 주기능 재정의 + 포지셔닝** (`56fa5ab`) ★사장님 선언:
- 주기능 = "잘나가는 계정 파악 → 나도 그렇게" = **[분석→실행] 루프**(분석=미끼, 자동화=엔진, 루프=월 19,900원의 이유).
- 헤드라인 "매일 30분→30초"(자동화 프레임) → **"잘되는 가게는 / 운이 아니에요."**(사장님 1안). 30초는 실행 엔진 카피로 강등.
- "옆 가게" → **"잘되는 가게"** 전 파일 27곳(수평·염탐 뉘앙스 → 상향 벤치마킹). bench 쇼케이스 히어로 직후 승격.
- ★**카피 스탠스 갱신**: 포부·욕망 과장 허용(나이키 Just Do It 영역), **구체적 수치 보장만 금지**(표시광고법+환불분쟁). **가짜 후기=날조라 금지선 밖**(공정위 제재 사례) — 대신 '사용 예시'·창업자 메시지로 social proof.

**C. 분석 강화 — 사진 직접 읽기** (`1f54751`~`8773a98`) ★사장님 "분석이 약하다/최대한 자세하게":
- 기존=숫자 요약뿐. → 인기+최신 **사진 최대 30장 전수**를 Gemini 비전이 직접 봄(sharp 768px 리사이즈, ₩0, ~90초).
- 출력: secret(비결 한 줄)·content_mix(뭘 찍나 %)·photo_style(빛·구도)·caption_style·posting_pattern·hashtag_strategy·top_why(터진 이유 3). aiInterpret 입력에 반영 → 제안 구체화.
- 실증: 어니언="협업·이벤트로 팬덤", 런던베이글="비주얼·신메뉴로 식욕" — 가게마다 다른 비결. 인사이트 탭 '콘텐츠 비결' 블록(믹스 막대는 CSP 회피 CSSOM).

**D. 고객 데이터 가드** (`03da8ee`·`cc33b92`) ★사장님 "고객 데이터만 보호":
- 무료 Gemini 티어는 입력을 Google 학습에 씀 → `_shared/llm-call.js` `pickGeminiKey`: 기본 sensitive(고객 사진/캡션)는 무료 Gemini **차단**(`GEMINI_PAID_API_KEY` 있을 때만 허용). 공개 게시물·트렌드만 `sensitive:false`로 무료 허용.
- privacy: 회원 사진/캡션=유료 OpenAI(학습off)만, 무료 Gemini=공개데이터·일반어. 처리위탁·국외이전 표 Google LLC 추가, 7절 AI학습 고지 정확화.

**E. OpenAI 의존 전수 Gemini 폴백** (`df735af`) ★사장님 "조용히 죽은 거 전부 찾아":
- 키워드해석 같은 패턴(OpenAI billing 죽음 → silent 실패)이 코어 전반. `llmChat(payload, opts)` — OpenAI 먼저, 실패 시 동일 프롬프트 Gemini. OpenAI 응답 모양 반환해 호출부 무수정 한 줄 교체. 9곳 적용(캡션·비전·검수·Threads·SRT·톤요약·재생성·벤치마크·웹훅). **단 D의 가드로 고객데이터는 무료 Gemini 안 감 = OpenAI 죽으면 캡션 graceful 실패**.
- ★**DB 체크 제약 함정**: reservations post_mode(best-time/draft)·caption_status(generating/error/draft) v0 제약이 거부 = 초안·베스트시간이 **DB단에서 전멸**이었음(코드론 안 잡힘, INSERT 실측서 발견). 마이그레이션 `reservations_check_constraints_match_app`. 코어 파이프라인 첫 실작동 실측 24초.

**F. 첫인상 개편 + 트렌드 부활** (`bbaa52c`·`329d460`·`215b777`·`813d864`):
- 트렌드 키워드 해석 Gemini 무료 부활 + 카테고리 Gemini 의미감사(food 오염 근절).
- 인덱스 다이어트(기능 섹션 중복 삭제·flow 다크→라이트·헤드라인 keep-all), 대시보드 게이트→'첫 3분' 체크리스트, 홈 '잘되는 가게' 카드.
- ★**SW network-first**(`813d864`): sw.js css/js cache-first가 배포직후 '새HTML+옛CSS' 첫화면 깨짐(생텍스트·거대SVG 2회)의 **진범**. netlify 헤더로 못 뚫음 → network-first(v59). **교훈: 마크업+CSS 동시변경 후 깨짐 = SW 캐시 1순위 의심.**

**G. 3D 리빌드 프로토타입** (`1f7308b`~`0720d53`) ★사장님 "사이트 통째로 바꿀 예정":
- **`/preview-3d`** (noindex 내부용, **당시** 라이브 미연결 — 현재 정식 index로 승격됨). 느와르 교훈대로 라이브 안 건드리고 별도 주소에 먼저 → 승인 후 교체. three.js(jsdelivr CDN, CSP script-src 기허용), 캔버스 텍스처만(라이트 무대·모바일 경량). 파일: `preview-3d.html`·`css/pages/landing3d.css`·`js/pages/landing3d.js`(디버그 훅 `window.__l3dSetProgress(0~1)`).
- 씬=주기능 물성화: 선언("운이 아니에요")→스캔→비결칩 추출→내 카드로 이식→완성(✓게시·반짝이). + **본편 2~5장**(분석리포트·30초 실행데모·방법비교·요금·FAQ·CTA·푸터) 일반 스크롤로 이어붙임(`getPastStory`로 캔버스 부드럽게 퇴장·렌더 스킵).
- 4장: ChatGPT 단독비교(약함, 루미를 캡션기로 축소) → **직접/대행사/AI캡션 3방법 vs 루미**. 폴백 수정(WebGL불가·reduced-motion 시 본편 안 가리게 — 정식 히어로화). Higgsfield MCP로 소금빵 사진 생성(무료 크레딧 10→8).
- **✅ index 교체 완료** (`d240854` #246, 6/15 — 후속 polish #247~`cb60c36` #251): 3D 리빌드를 정식 `index.html`로 승격. "내부용" 라벨·noindex 해제, 진짜 헤더(시작하기·로그인)·OG/검색태그 적용, 기존 클래식은 `index-classic.html`로 백업. 후속 = 데모 캡션 강화·인스타 액션바·후기(사용 예시) 무한 캐러셀 전국 50개·내 가게 카드 태그 정합.

### 2026-06-09~10 세션
- **카피 원칙 확정 — 의인화 금지** (`cc62fb0`): 사장님 피드백("루미네 사람들 4명 = AI 티") → 4인 캐릭터(사진가·작가·편집장·감독 루미) 전면 제거, "루미" 단일 목소리. 11개 파일 30여 곳, 잔존 0 검증. **향후 카피 가이드: 의인화 금지, 동작을 담백하게, "루미 팀"(실제 사람)만 허용.**
- **몰입 레이어 R1** (`4fa3897`): 사장님 지시 "몰입형 UI/UX+마이크로 인터랙션 전체" — 풀 리디자인 아닌 레이어 추가. @view-transition MPA 전환 + .rv 스크롤 리빌(자체 애니 보유 요소 자동 제외) + index 카운트업 + hero 오로라 + tick-pop. js/immersive.js 신규(19/19 페이지), reduced-motion/미지원 완전 무동작, CSP 준수. 프리뷰 탭 hidden=rAF/IO 정지라 실모션은 실기기 확인 필요.
- **scheduler 26일 잠수 발견·수습** (`ad92098`): 05-15 커밋 3be1470 이 for→map 변환하며 `continue` 3개를 남겨 `SyntaxError: Illegal continue` → 모듈 로드 실패 → **매분 예약픽업 크론 26일 사망**. continue→return 수정 + 게이트 추가(`e5c1fc0`). 교훈: **배포 성공 ≠ 함수 로드 성공** — `node --check` 전수 + 스텁 로드테스트 필수.
- **전수 버그감사** (134 에이전트 워크플로): 확정 8건 수정(`9322af4`, `9c71849`) — regenerate-caption 잘못된 OpenAI responses API→chat/completions, tiktok-disconnect 없는 user_id 컬럼, pending-caption-rating 없는 profiles 테이블, select-caption stale scheduled_at 반환, followers-snapshot noToken 카운터, history.js null 가드, process-account-deletion listUsers 200명 페이징→sellers.id 직접 deleteUser, cleanup-stale event ReferenceError(시간당 크론 사망). 오탐 5건 검증 후 기각.
- **워치독 감시망 전수 확장** (`84ce073`): scheduler 26일 잠수를 워치독이 못 잡은 원인 = WATCH_TARGETS 가 트렌드 3종뿐. **스케줄 함수 13개 전체에 cron-guard heartbeat** (9개 신규 runGuarded 래핑, 게이트는 가드 밖 = 외부 poke 의 heartbeat 위장 차단), WATCH_TARGETS 3→12(주기별 임계치), cron-health 4→13, heartbeat 9행 사전 시딩(false alert 방지). process-account-deletion 에 게이트 신규 추가(유일하게 없었음). **라이브 검증: scheduler heartbeat success=true 프로덕션 확인**. 이제 어떤 cron 이 죽어도 워치독이 임계치 내 메일 알림.
- **토스 UX라이팅 적용** (`8c81157`, `415a5cd`): index/pricing 기능카드 제목 기능명→유저결과("내 매장 말투 그대로" 등), '실시간 트렌드' 허위표현 4곳→'매일 갱신'.
- **data-deletion-callback 멱등성 검증완료**(수정 불필요): Meta 재시도 → not_found 200 + 추적 row, 오류/중복삭제 없음. 비즈니스 심사 안전.
- **법적 페이지 정합성 감사** (`6f90aa6`): privacy/terms 를 실코드와 전수 대조 — 쓰레드 연동정보 명시, 틱톡 연동정보 신설(제공 시 조건부 — TikTok 심사가 방침 내 기재 요구), 제3자/국외이전에 TikTok·Resend 추가, 트렌드 출처 네이버로 정정, 댓글 '도입예정'→라이브 정정. refund 는 현실 일치(무변경). + 🔴 **로그아웃이 lumi_refresh 안 지우던 버그**(공용기기 재로그인 가능) 5개 페이지 수정. GA dns-prefetch 18파일 제거(추적코드 없는데 힌트만 잔존).
- **프런트 크리티컬 패스 점검** (`e7f81a6`): 🔴 CSP(unsafe-inline 제거)가 **innerHTML 주입 style 속성을 전부 무시** — history 예약카드 썸네일이 통째로 빈칸이던 버그(예약 0건이라 미발견) 포함 6파일 수리(data-thumb+CSSOM / u-text-muted 클래스). 🔴 초안 제출 후 past 탭 리다이렉트 → 초안은 upcoming 분류라 빈 화면부터 보이던 UX 버그(immediate 만 past). 가입 마법사·dashboard 게이트·reserve 무게이트(신규도 초안 가능)·무한루프 없음 검증 완료.
- ig-hashtag 스케줄 이중선언(toml 17:00 vs in-code 18:00 UTC) → **17:00 통일** (`2e17bd7`).
- 라이브 검증 10/10 통과 (법적 문구·JS 픽스·GA 제거 전부 프로덕션 확인).
- 미수정 플래그(저영향): signup.js 가 raw fetch 라 만료토큰 시 refresh 재시도 없음(재로그인 유도로 충분), register-product pollUntilDone 죽은 코드(~90줄, 리다이렉트 방식 전환으로 미사용), dashboard if(false) 진행카드 블록(의도적 비활성).
- **설정·베타 인입 점검** (`3784f68`): 🔴 **'내 데이터 다운로드' 버튼 부재** — 방침 §8 약속 + 백엔드(export-my-data) 실존인데 UI 진입점이 없었음(PIPA §35 이동권 행사 수단 부재) → 설정 계정 섹션에 신설(fetch+Blob, Bearer 필수라 a href 불가). 🔴 **카카오 로그인 실패 무안내** — 콜백이 /signup?kakao_error 로 보내는데 처리 0곳 + 토큰 없으면 즉시 홈 튕김 → 안내 후 홈 복귀로 수정. client_errors 30일 정리(cleanup-stale 5번째 청소) + 방침 §3 동기화. comments/insights/trends JS·베타 깔때기·error-log = 무결 확인. 모바일 375px 공개 페이지 전부 가로 오버플로 0. beta_signups 는 죽은 테이블(쓰는 곳 0 — 옛 대기열 설계 잔재, deny-all 이라 무해).

### 2026-06-07~08 대규모 세션 (git log 가 정확한 소스)
- **초안 모드**(`post_mode='draft'`): Meta 승인 없이 사진→캡션 생성 후 게시 안 함(유일한 런칭 경로). register "초안만" 버튼·`?draft=1`, history 캡션 복사 버튼, dashboard IG모달 진입로. 흐름: reserve(scheduled_at=null)→process-and-post(status='draft', TikTok·즉시IG 둘다 스킵)→scheduler 무시→list-reservations(필터없음)→history. ⚠️ **끝-끝(실 업로드) 미검증 — 사진 1장 테스트 필요**.
- **트렌드 = 완전 정상화 + OpenAI 0원**: ①GPT 전부 제거(`TRENDS_USE_OPENAI=false`, 네이버 직접) ②데이터랩 keywordGroups 5개 제한 버그 수정(cafe/food/hair 0건 원인) ③큐레이션 데이터랩 시드 우선(merge `[datalab,adKws]` — 검색광고 의미드리프트 차단) ④시드 접미사 정리. **8개 카테고리 깨끗·업종적합 검증완료**(수동 크론 3회, collected_date 2026-06-08). 05-27부터 11일 멈춤 해소. ⚠️ get-trends.js 읽기필터(BLACKLIST 오마카세·마라탕·크로플 등 일반메뉴명 + `X맛집` 패턴)가 특정 트렌드만 노출 → 시드에 일반명사 넣어도 페이지엔 안 뜸.
- **캡션 버그 수정**(`acfc812`): 트렌드/해시태그 사진매칭 visualText 가 imageAnalysis(JSON 문자열)에 `.subjects` 객체접근→undefined로 죽어있던 것 복구(visionToContext 파싱).
- **보안 최상화**: 어드바이저 WARN 35건 해소(anon/auth SECURITY DEFINER 함수 16 REVOKE+service_role 재GRANT, 공개버킷 listing 6 DROP, 함수 search_path 13 `public,pg_temp` 고정) + **엔드포인트 78개 전수 감사**(네이티브 cron 백그라운드 5개 외부 HTTP 트리거 차단 `c4b2373`, `_shared/auth.js allowScheduledOrSecret`). RLS-no-policy 7테이블=백엔드전용 deny-all로 안전. tiktok-oauth-callback=중화확인. 남은 건 Leaked password protection 토글(Pro 전용, 무료면 스킵 OK).
- **품질**: 텍스트 그라데이션 헤드라인 가독성 전면수정(`--gradient-signature-text`, index/beta/pricing 12곳), 멀티마켓 잔재 제거.
- **OpenAI 쿼터 게이트 점검**: 셀러별 무제한, 서비스 ₩100k/일(사용량 0) → 초안 캡션 안 막힘. **키 충전만 하면 작동**.

### (이전) 2026-06-04 작업
- **트렌드 네이버 단일화** (`9e44ca3`): 쇼핑인사이트 메인 + 데이터랩 보조. 블로그/유튜브/IG/뉴스 소스 전부 제거.
  - `SOURCE_WEIGHTS = { shopping: 4, datalab: 2 }`
  - `classifySignalTier` 2축(monthlySearchTotal≥5000 = volume, velocityPct≥30 = velocity): 둘 다=strong, 하나=medium, 없음=weak.
  - 파일: `netlify/functions/scheduled-trends-v2-background.js`, `_shared/naver-shopping-insight.js`(8업종→네이버 쇼핑 대분류 매핑).
- **요금제**: `pricing.html` + `css/pages/pricing.css` 신설 (Free ₩0 / Pro ₩19,900), `netlify.toml`에 `/pricing` 라우트, index에 price-section.
- **햅틱**: `js/haptic.js` — 토스 절제 원칙대로 confirm/CTA 셀렉터만(`.cta`, `.cta-primary`, `a.beta__kakao-cta`, `.oauth-button`, `[data-ig-connect]`, `[data-next]` 등). reduce/iOS 가드.
- **토스급 마이크로 인터랙션 풀세트** (`23a7800`): toss.tech 실측 기반(bezier+spring, "한 타겟 한 모션", 절제, 완료·축하에 집중).
- **시그니처 확산 전 페이지** (`351f787`): 4색 그라데이션(--signature-1~4: #FF6B8B 핑크 / #DDA0DD 라일락 / #EDD080 노랑 / #DABA65 골드), wavy underline, warm-glow. linktree `.lt-avatar` ring을 box-shadow+토큰으로 수정.
- **seller_links 테이블 복구 완료**: 이전 대청소 때 실수로 drop됐던 걸 마이그레이션 `restore_seller_links_table`로 복구(8컬럼+인덱스+RLS). 프로필 링크 "주소 못 가져옴" 버그의 진짜 원인이었음(캐싱 아님). get-my-linktree.js는 ensureSlugForSeller 사용. 사장님 slug = `lumi-3mhru5`.

## 2. lumi 미해결 / 진행중 ⚠️ (가장 중요)

- **✅ OpenAI 키 — 2026-06-21 검증: 살아있음** (GCP `ecosystem.config.js` env, `/v1/models` 200). ⚠️ **이전 기록 stale·해소됨**: 6/12 'Netlify OPENAI_API_KEY `invalid_api_key` 키자체무효 → 새키 발급필수'였으나 사장님이 GCP env에 **유효키 투입 완료**. → **HANDOVER 1순위였던 OpenAI 블로커는 풀림.** 남은 건 **앱 초안 캡션 E2E 1회**(seller JWT→reserve→process-and-post)로 GPT-4o completion/billing 실작동 확인(models 200은 '키 유효'까지만 보증, 실 completion·잔액은 미확인). Gemini 키도 200 ✅(소싱 분석·비전 정상). 소싱 상세페이지 카피(GPT-4o)도 이 키로 작동.
- **✅ 코어 파이프라인 서버 실작동 검증됨**(6/12, E 항목): reservations 직접 insert → process-and-post → 24초 분석→캡션→draft. **남은 건 앱 브라우저 업로드 1회**(register-product 화면→결과, OpenAI 키 들어온 뒤).
- **✅ trends cron 해결**(6/08~12): 네이버 직접+Gemini 의미감사. 8개 카테고리 청정 적재. food 오염 근절.
- **✅ 3D 인덱스 교체 완료**(6/15, `d240854`~`cb60c36` #246~#251): 3D 리빌드를 정식 index로 승격, 기존은 `index-classic.html` 백업. (상세 G 항목)
- **🔶 PayApp 결제 — 백엔드 완성·배포(6/17 A항목). 라이브 전 남은 것**: ① 🔴 PayApp 콘솔서 **정기결제 기능 ON + 테스트모드 유무** 확인(문서 미기재) ② 🔴 노출된 **LINKKEY/LINKVAL 재발급**(채팅 평문 노출) ③ **진입 링크**(대시보드/설정 "구독" 버튼 — 지금 `/subscribe` 직접만) ④ **법무 카피**(pricing 자동결제 고지·terms 정기결제/해지 조항) ⑤ **실 결제 1건 E2E**. `PAYAPP_USERID`=gung3625, LINKKEY/LINKVAL 등록됨.
- **가상 리뷰 — 미결(사장님 보류)**: 가짜 후기는 표시광고법 리스크라 권하지 않음. '사용 예시'·창업자 메시지 대안 제시, 사장님 선택 대기.
- **앱인토스 출시 [보류]**: 외부 OAuth(카카오/메타) 금지가 걸림돌. 보류.
- **앱인토스 출시 [보류]**: 외부 OAuth(카카오/메타) 금지가 걸림돌. 워크어라운드 아이디어 = 웹에서 인스타 1회 연동 → 미니앱은 Supabase Vault에 저장된 토큰 사용(기술적으로 유효). 사장님이 "잠시 보류"함.

## 3. 사업자 / 비즈니스 인증 (마지막 작업 — 중단됨)

- **사업자 정보**: 상호 루미(lumi) · 대표 김현 · 사업자등록번호 **404-09-66416** · 통신판매업 **제2024-서울용산-1166호** · 주소 서울특별시 용산구 회나무로 32-7 04345 · 문의 lumi@lumi.it.kr · 010-6424-6284
- **★ 마지막 막힌 지점**: "통신판매업 신고증에 전화번호가 안 나온다." 어떤 인증(메타 비즈니스 인증 등)이 **사업자등록번호 + 전화번호가 한 문서에 같이 나오는** 증빙을 요구하는데, 통신판매업 신고증엔 전화번호가 없음. → 전화번호+BRN이 함께 표시되는 대체 문서(예: 사업자등록증명원, 부가세 관련 서류 등) 찾는 게 다음 작업.

## 4. 별도 프로젝트: AI 콘텐츠 수익화 (★ lumi와 무관)

- 유튜브 쇼츠 자동화 검토함. 무료 스택 가능: **edge-tts**(무료 한국어 신경망 TTS, 키 불필요) + ffmpeg + Whisper(자막) + Pexels(스톡) + ShortGPT/SaarD00 레포.
- **솔직한 결론**: 공짜 자동화 페이스리스 쇼츠 광고수익으로 월 1000만원 = 비현실(RPM 30~80원/1000뷰 → 월 1.25~2억 조회 필요). 게다가 YouTube가 2025.7 "inauthentic content" 정책으로 양산 AI demonetize 중(2026.1에 16채널 정지).
- **피벗 권고**: "AI 콘텐츠로 월 1000만원"은 B2C 광고수익이 아니라 **B2B/결과 판매**에서 나옴.
  - Tier A(현실적): ① AI 콘텐츠 대행(고객 10명×100만원) ② lumi SaaS 유료 500명(₩19,900×500≈1000만, 구독=복리) ③ 디지털 상품
  - 사장님 강점: 소상공인 이해 + lumi 엔진 보유 → 대행으로 현금 + lumi로 복리 조합 추천.
- **★ 사용자 미선택 상태**: ①대행 ②lumi 500명 ③다른 디지털상품 중 고르기로 했으나 통신판매업 질문으로 넘어가며 중단. 새 세션에서 선택 이어받으면 됨.

## 5. 작업 원칙 (반드시 준수 — 사장님이 반복 강조함)

1. **정식 운영 단계로**: "베타라 X 생략" 정당화 금지. 인증·quota·rate limit·에러 핸들링 기본 포함.
2. **추측 금지**: 검증 가능한 사실(가격·정책·사양·API 동작)은 1차 source 확인 후 답. 추정이면 명시. ← 사장님이 가장 강하게 요구한 원칙.
3. **재확인 금지**: 명확한 작업 동사 있으면 재질문 없이 즉시 시작.
4. **마이크로 인터랙션 필수**: 모든 UI 작업에 hover/focus/상태변경/stagger/유도 + reduced-motion 존중.
5. **UI 새 요소는 공간 확보**: absolute로 콘텐츠 위에 띄우지 말고 padding/flex로 분리(사진·글씨 겹침 차단).
6. **삭제 confirm 강도 조절**: 회원탈퇴급만 텍스트 입력 검증, soft delete는 단순 confirm.
7. **진행 상황 능동 모니터링**: 묻기 전에 먼저 진단·근본 원인. 같은 증상 2번이면 환경 fix.

## 6. 새 세션에서 할 것 (우선순위)

0. **🟢 (메인 사업) 상세페이지 메이커** (§1 **2026-06-28**이 최신 정본). ⚠️아래 "블록 에디터/글자=텍스트 레이어" 방향은 **6-28 폐기**(gpt-image-2 한글 직접렌더로 전환·editor.html deprecated). 최신 미해결=전체 e2e 실측·create.html UX·과금. 역사 보존: ~~블록 에디터 전환~~ (§1 ⭐⭐⭐ 참조). 두 버전: 쉬운(레퍼런스 붙여넣기→참고 생성+글씨만 수정) / 어려운(캔바식 `editor.html` 풀 편집). 화보=글자없는 통이미지(화려), 글자=텍스트 레이어(사진 위 오버레이·수정가능). **남은 것(순서)**: 🔴 브랜치 `claude/handover-review-112s8m`(PR #254) **배포+첫 실측**(rsync+`pm2 reload`, AI키 필요 — 이 작업환경선 미실측) → 블록 자동배치 조정 → 🟡 쉬운버전 "붙여넣기"(URL/Ctrl+V) 강화 → 🟡 어려운버전 기능 보강(텍스트배경·자간·스냅·그라디언트) → 레퍼런스 1장으로 화려함 기준 확정. ★gpt-image-2 화보는 글자 없이 깨끗하게 뽑는 방향(글자는 레이어).
1. **🟡 OpenAI 캡션 E2E 검증** — 키는 ✅살아있음(2026-06-21 GCP env `/v1/models` 200, §2 정정 참조). 남은 건 앱에서 **초안 사진 1장 업로드→캡션 결과** 1회로 GPT-4o 실작동 확인뿐. (등록방식은 Netlify env 아닌 `ecosystem.config.js` apps[0].env + `pm2 reload`.)
2. **PayApp 결제 마무리** — 사장님: PayApp 콘솔 정기결제 ON+테스트모드 확인 + 노출키 재발급. 제가: 실 결제 1건 E2E + **진입 링크(구독 버튼)** + **법무 카피**. (§2 PayApp 항목)
3. **autoke서 가져올 카피** — 문제프레임·숫자대비·FAQ보강·CTA"언제든해지"·펀치 클로징 (§1 2026-06-17 C항목). index/pricing 작업이라 리스크 낮음. 사장님 "ㄱㄱ" 하면 우선순위대로.
4. (OpenAI 키 후) **앱에서 초안 사진 1장** — 브라우저 업로드 경로 최종 확인.
5. **유통/첫 고객** — 제품 리스크는 거의 소진. 남은 승부=①첫 30명에게 닿는 발 ②한 달 뒤에도 쓰게 만드는 캡션 품질.
6. (사장님 선택 대기) 통신판매업 전화번호 증빙(BRN+전화번호 함께 나오는 문서), 가상리뷰 방식, performance-rls.sql.

## 벤치마크 v1.1 — 경쟁 계정 분석 (2026-06-11)
- **인사이트 4번째 탭** "벤치마크": 궁금한 가게 인스타 등록(최대 3개) → 분석 → 나 vs 상대 비교표 + AI 해석(차이·성공 공식·이번 주 제안) + 초안 CTA.
- 파이프라인: Apify 수집(공개 데이터만: apify/instagram-profile-scraper + apify/instagram-scraper, **필드명 2026-06-11 실측 고정**) → `_shared/benchmark-stats.js` 통계(코드) → gpt-4o-mini 해석(openai-quota 통과 시, 실패해도 통계만으로 done).
- 함수 3개: `benchmark-accounts`(POST 추가/DELETE 삭제), `benchmark-scrape-background`(워커 — /api/benchmark-scrape 리다이렉트, 202 즉시 응답 후 작업, 클라이언트는 get-benchmark 폴링), `get-benchmark`(계정+최신 리포트).
- 테이블: `benchmark_accounts`/`benchmark_posts`/`benchmark_reports` — deny-all RLS(service role 전용).
- 가드: 셀러당 계정 3개, 같은 계정 재분석 쿨다운 6시간, 일일 분석 10회, 비공개 계정 거부.
- **ENV 필요: `APIFY_TOKEN`** (Apify Console → Settings → API & Integrations). 미설정 시 get-benchmark가 enabled=false → UI "준비 중" 안내, 워커는 안전 종료.
- 원가: 분석 1회 ≈ $0.08 (Apify) + AI ~5원. Apify 무료 플랜 $5/월 = 약 60회.
- 한계(고지문 UI 반영): 공개 데이터 추정 — 광고 집행·도달 미포함. 내 계정 비교는 IG 연동 시에만.
