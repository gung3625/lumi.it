# Make.com 제거 → 순수 코드 전환 브리핑

## 작업 목표
Make.com 없이 Netlify Background Function 1개로 전체 인스타그램 자동화를 처리한다.
추가로 고객이 캡션을 선택하고 재생성할 수 있는 기능을 구현한다.

---

## 현재 Make.com 시나리오 전체 흐름 (완전 분석 완료)

### 데이터 흐름
```
scheduler.js (cron 5분마다)
→ Netlify Blobs에서 예약 항목 조회 (prefix: 'reserve:')
→ 예약 시간 도달한 항목 발견
→ MAKE_WEBHOOK_URL로 multipart/form-data 전송
```

### scheduler.js가 Make.com에 보내는 데이터 (전체)
```
textFields:
  photoCount, userMessage, bizCategory, captionTone, tagStyle
  scheduledAt, submittedAt
  weatherStatus, weatherTemperature, weatherState, weatherGuide, weatherMood, weatherLocation
  trends (쉼표 구분 문자열)
  storeName, storeDescription, storeInstagram, storeRegion, storeCategory
  storeSido, storeSigungu, ownerName, ownerEmail
  toneLikes, toneDislikes (말투 학습 데이터 ||| 구분)
  hasFestival, nearbyFestivals
  igUserId (인스타그램 비즈니스 계정 ID)
  igAccessToken (인스타그램 액세스 토큰)
  storyEnabled (스토리 게시 ON/OFF)

files:
  item.photos 배열 → base64 → binary 변환
  fieldName: 'files', fileName, mimeType, buffer
```

### Make.com 내부 처리 순서 (모듈별 역할)

**[1] gateway:CustomWebHook**
- scheduler.js로부터 multipart/form-data 수신
- 모든 textFields와 files 배열을 변수로 파싱

**[130] util:SetVariable2 → toneGuide**
- toneLikes가 있으면 "✅ 좋아했던 스타일:\n- item1\n- item2" 형식으로 가공
- toneDislikes가 있으면 "❌ 싫어했던 스타일:\n- item1\n- item2" 형식으로 가공
- 이 변수가 GPT 캡션 프롬프트에 말투 학습 데이터로 주입됨

**[2] builtin:BasicFeeder**
- 수신한 files.files 배열을 순회 (사진 여러 장 처리)
- 각 사진을 하나씩 다음 단계로 전달

**[3] cloudinary:UploadResource**
- 각 사진을 Cloudinary에 업로드
- 반환값: public_id

**[16] cloudinary:TransformResource**
- 변환: c_fill,w_1080,h_1350,q_auto (인스타그램 최적 비율)
- 반환값: 변환된 이미지 URL

**[59] util:SetVariable2 → "Cloudinary url"**
- execution 스코프로 Cloudinary URL 저장

**[6] http:MakeRequest → Instagram 미디어 컨테이너 생성**
- URL: https://graph.facebook.com/v25.0/{igUserId}/media/
- Method: POST
- Params: image_url={cloudinaryUrl}, is_carousel_item=true, access_token={igAccessToken}
- 반환값: { data: { id: "미디어컨테이너ID" } }

**[36] util:TextAggregator**
- BasicFeeder 루프의 모든 미디어 컨테이너 ID를 줄바꿈으로 합산
- 결과: "id1\nid2\nid3"

**[63] util:SetVariable2 → "Text aggregator id"**
- execution 스코프로 미디어 ID 문자열 저장

**[60] util:GetVariable2 → "Cloudinary url"**
- 저장된 Cloudinary URL 불러오기

**[45] openai-gpt-3:CreateCompletion → 이미지 분석 (GPT-4o)**
- 모델: gpt-4o, max_tokens: 2048, temperature: 1
- 각 사진 URL을 입력으로 받아 감성 분석
- 분석 항목: 첫인상/피사체/감성과분위기/색감과빛/인스타강점/캡션방향제안
- 출력: [분석 요약] + [캡션 핵심 키워드] + [캡션 첫 문장 후보]
- imageDetail: "high"

**[61] util:TextAggregator**
- 모든 사진 분석 결과를 합산

**[113] util:SetVariable2 → "Captions"**
- roundtrip 스코프로 분석 결과 저장

**[114] util:GetVariable2 → "Captions"**
- 저장된 분석 결과 불러오기

**[132] util:GetVariable2 → "toneGuide"**
- 저장된 말투 학습 데이터 불러오기

**[46] openai-gpt-3:createModelResponse → 캡션 최종 작성 (gpt-5.4)**
- 모델: gpt-5.4 (중요: gpt-5.4 사용)
- store: true, createConversation: true
- 입력: 아래 GPT 프롬프트 참조
- 출력: 완성된 캡션 + 해시태그

**[64] util:GetVariable2 → "Text aggregator id"**
- 미디어 컨테이너 ID 목록 불러오기

**[89] builtin:BasicRouter → 단일/다중 이미지 분기**
- 조건: photoCount > 1 → 캐러셀 루트
- 조건: photoCount == 1 → 단일 루트

---캐러셀 루트 (photos > 1)---

**[31] http:MakeRequest → 캐러셀 미디어 컨테이너 생성**
- URL: https://graph.facebook.com/v25.0/{igUserId}/media/
- Method: POST
- Params: media_type=CAROUSEL, children={id1,id2,...}, caption={caption}, access_token={token}
- 반환값: { data: { id: "캐러셀컨테이너ID" } }

**[47] util:FunctionSleep**
- 5초 대기 (Meta 서버 처리 시간)

**[37] http:MakeRequest → 캐러셀 게시 (publish)**
- URL: https://graph.facebook.com/v25.0/{igUserId}/media_publish
- Method: POST
- Params: creation_id={캐러셀컨테이너ID}, access_token={token}

**[157] builtin:BasicRouter → 스토리 분기**
- 조건 A: storyEnabled == false → [126] save-caption만 호출
- 조건 B: storyEnabled == true → [163] 스토리 업로드

**[126] http:MakeRequest → save-caption 저장**
- URL: https://lumi.it.kr/.netlify/functions/save-caption
- Body: email={ownerEmail}, caption={caption}, secret=lumi2026secret

**[163] util:GetVariable2 → Cloudinary url (스토리용)**

**[161] http:MakeRequest → 스토리 미디어 컨테이너 생성**
- URL: https://graph.facebook.com/v25.0/{igUserId}/media
- Params: image_url={cloudinaryUrl}, media_type=STORIES, access_token={token}

**[162] http:MakeRequest → 스토리 게시**
- URL: https://graph.facebook.com/v25.0/{igUserId}/media_publish
- Params: creation_id={스토리컨테이너ID}, access_token={token}

---단일 이미지 루트 (photos == 1)---

**[84] instagram-business:CreatePostPhoto → 단일 이미지 게시**
- accountId: igUserId
- caption: {gpt결과}
- image_url: {cloudinaryUrl}
- (내부적으로 Meta Graph API 호출)

**[151] builtin:BasicRouter → 스토리 분기**
- 조건 A: storyEnabled == true → [155] 스토리 업로드
- 조건 B: storyEnabled == false → [134] save-caption만 호출

**[155] http:MakeRequest → 스토리 미디어 컨테이너 생성**
- URL: https://graph.facebook.com/v25.0/{igUserId}/media
- Params: image_url={cloudinaryUrl}, media_type=STORIES, access_token={token}

**[156] http:MakeRequest → 스토리 게시**
- URL: https://graph.facebook.com/v25.0/{igUserId}/media_publish
- Params: creation_id={스토리컨테이너ID}, access_token={token}

**[134] http:MakeRequest → save-caption 저장**
- URL: https://lumi.it.kr/.netlify/functions/save-caption
- Body: email={ownerEmail}, caption={caption}, secret=lumi2026secret

---

## GPT 프롬프트 (그대로 사용)

### 프롬프트 1: 이미지 분석 (GPT-4o)

```
당신은 소상공인 인스타그램 마케팅 전문 이미지 분석가입니다.
당신의 분석 결과는 캡션 카피라이터에게 전달되어 최고 품질의 캡션을 만드는 데 쓰입니다.
분석이 정확하고 풍부할수록 캡션 품질이 올라갑니다.

중요: 계절, 날씨, 트렌드 정보는 별도로 제공됩니다.
[이미지 URL]
이 이미지에서 보이는 것만 분석하세요.

---

## 분석 철학

사물을 나열하지 마세요.
"딸기가 있고, 우유가 있고, 잔이 있다" → 실패
"선명한 딸기 빛이 흰 우유 위에 스며드는 순간을 포착했다" → 성공

보는 사람의 감정을 먼저 읽으세요.
이 사진을 인스타그램에서 스크롤하다 마주쳤을 때
손가락이 멈추게 만드는 요소가 무엇인지 찾으세요.

---

## 분석 항목

**[1. 첫인상]**
이 사진을 처음 봤을 때 0.3초 안에 드는 느낌을 한 문장으로 쓰세요.
이것이 캡션 첫 문장의 씨앗이 됩니다.

**[2. 피사체 분석]**
무엇이 찍혀 있는지 구체적으로 파악하세요.
- 음식/음료: 어떤 메뉴로 보이는지, 색감, 재료의 신선함, 플레이팅의 감각
- 공간: 어떤 분위기의 공간인지, 조명의 질감, 인테리어 스타일, 눈에 띄는 소품
- 제품: 어떤 종류인지, 색상과 질감, 디자인이 주는 인상
- 사람이 있다면: 어떤 감정인지, 무엇을 하고 있는지

**[3. 감성과 분위기]**
이 사진이 불러일으키는 감정을 구체적으로 표현하세요.
단순한 형용사(예쁜, 맛있어 보이는)가 아니라
"첫 데이트 전날 밤 같은 설렘" 처럼 구체적인 감성 언어를 쓰세요.

**[4. 색감과 빛]**
- 주된 색조: 어떤 색이 화면을 지배하는지
- 조명의 질감: 자연광인지 인공조명인지, 부드러운지 선명한지
- 밝기와 채도

**[5. 인스타그램 강점]**
시선을 가장 강하게 끌어당길 요소 한 가지를 꼽으세요.

**[6. 캡션 방향 제안]**
어떤 이야기로 풀어야 할지 방향을 제시하세요.

---

## 출력 형식

**[분석 요약]**
3~5문장의 브리핑. 사물 나열이 아닌 감성과 스토리 중심.

**[캡션 핵심 키워드]**
사진의 시각적 특징에서 나온 키워드 5개. 날씨/계절 제외.

**[캡션 첫 문장 후보]**
스크롤을 멈추게 만드는 첫 문장 2개.
```

### 프롬프트 2: 캡션 작성 (gpt-5.4 사용)

입력 변수 주입 방식:
- {imageAnalysis} = 이미지 분석 결과 (모든 사진 취합)
- {userMessage} = 대표님 코멘트
- {weatherStatus} = 날씨 상태
- {weatherTemperature} = 기온
- {airQuality} = 초미세먼지
- {trends} = 트렌드 태그 목록
- {hasFestival} = 주변 행사 여부
- {nearbyFestivals} = 행사 정보
- {photoCount} = 사진 수
- {storeName} = 매장명
- {storeCategory} = 업종
- {storeRegion} = 지역
- {storeSido} = 시/도
- {storeSigungu} = 시/군/구
- {storeDescription} = 매장 소개
- {captionTone} = 요청 스타일
- {toneGuide} = 말투 학습 데이터 (좋아요/싫어요)

```
당신은 한국 소상공인의 인스타그램 캡션을 대신 써주는 전문 카피라이터입니다.
대표님이 사진 한 장을 올리는 순간, 그 하루의 이야기를 가장 잘 아는 사람처럼 써야 합니다.

캡션을 읽은 팔로워가 "이 사람 글 진짜 잘 쓴다" 고 느껴야 합니다.
캡션을 받은 대표님이 "이게 내가 하고 싶었던 말이야" 라고 느껴야 합니다.

---

## 절대 금지 (하나라도 어기면 실패)

- "안녕하세요", "오늘도 찾아주셔서 감사합니다" 같은 뻔한 인사
- "맛있는", "신선한", "정성스러운" 같은 과장 형용사 남발
- AI가 쓴 것처럼 매끄럽고 완벽한 문장 구조
- 제품/메뉴 이름만 나열하는 방식
- "많은 관심 부탁드립니다", "놀러 오세요" 같은 전형적인 마무리
- 설명, 제목, 따옴표, 부연 없이 캡션만 바로 출력
- 기온 숫자를 직접 언급하는 것
- 미세먼지 수치나 등급을 직접 언급하는 것

---

## 이것이 좋은 캡션입니다

✅ 읽는 사람이 그 순간을 상상할 수 있는 글
✅ 대표님이 직접 쓴 것처럼 자연스러운 말투
✅ 첫 문장이 스크롤을 멈추게 만드는 힘이 있음
✅ 한 문장이 다음 문장을 읽고 싶게 만드는 흐름
✅ 이모지가 글의 감정을 정확히 보완하는 위치에 있음
✅ 해시태그가 광고가 아닌 탐색 도구처럼 느껴짐

---

## 입력 정보 처리 우선순위

### ① 이미지 분석 결과
이미지 분석: {imageAnalysis}
사진에서 실제로 보이는 것만 반영. 지어내지 말 것.

### ② 대표님 코멘트
코멘트: {userMessage}
있으면 캡션의 중심축. 감정/의도/뉘앙스 그대로 살리기.

### ③ 날씨
날씨: {weatherStatus} / 기온: {weatherTemperature}°C
숫자 직접 쓰지 말 것. "오늘처럼 선선한 날엔" ✅

### ④ 미세먼지
초미세먼지: {airQuality}
수치/등급 직접 언급 금지. 실내 포근함 또는 개방감으로 은유.

### ⑤ 트렌드
트렌드 태그: {trends}
본문에 억지로 넣지 말 것. 1~2개만 문장에 녹이고 나머지는 해시태그.

### ⑥ 주변 행사
근처 행사 여부: {hasFestival}
행사 정보: {nearbyFestivals}
hasFestival=true일 때만. "이 동네가 요즘 유독 활기차요" ✅

### ⑦ 사진 수
사진 수: {photoCount}
2장 이상: 캐러셀 의식하기. 직접 언급은 금지.

---

## 매장과 대표님 정보

매장명: {storeName}
업종: {storeCategory}
지역: {storeRegion}
시도: {storeSido}
시군구: {storeSigungu}
매장 소개: {storeDescription}

---

## 글 말투 스타일

요청 스타일: {captionTone}
스타일이 없으면 → 친근하고 따뜻하게

친근하게: 동네 단골손님한테 말하는 것처럼. ~했어요, ~더라고요
감성적으로: 짧은 문장. 여백. 행간. 여운.
재미있게: 공감 터지는 유머. 반전.
시크하게: 말 수 적고 여백 많다. 설명 안 한다.
신뢰감 있게: 정중하지만 딱딱하지 않게.

---

## 말투 학습 데이터

{toneGuide}

✅ 좋아요 캡션은 그 감성과 톤을 계승하세요.
❌ 싫어요 캡션은 그 방식을 철저히 피하세요.

---

## 캡션 3개 버전 출력 (중요: 반드시 3개)

아래 형식으로 정확히 3개 캡션을 출력하세요:

---CAPTION_1---
[캡션 본문 + 해시태그]
---END_1---

---CAPTION_2---
[캡션 본문 + 해시태그]
---END_2---

---CAPTION_3---
[캡션 본문 + 해시태그]
---END_3---

각 캡션은 톤이 다르게 (감성적/친근한/시크한 순서로).
```

---

## 현재 Blobs 데이터 구조

```
reservations Blobs:
  key: 'reserve:{timestamp}'
  value: {
    photos: [{ fileName, mimeType, base64 }],
    userMessage: string,
    bizCategory: 'cafe' | 'food' | 'beauty' | 'other',
    captionTone: string,
    tagStyle: string,
    scheduledAt: ISO8601,
    submittedAt: ISO8601,
    weather: { status, temperature, state, guide, mood, locationName },
    trends: string[],
    storeProfile: { name, description, instagram, region, category, ownerName, ownerEmail, sido, sigungu },
    storyEnabled: boolean,
    nearbyEvent: boolean,
    nearbyFestivals: string,
    toneLikes: '캡션1|||캡션2|||캡션3',
    toneDislikes: '캡션1|||캡션2',
    igUserId: string,
    igAccessToken: string,
    isSent: boolean,
    sentAt: ISO8601
  }

users Blobs:
  key: 'caption-history:{email}'
  value: [{ id, caption, createdAt, feedback }]  // 최대 20개

  key: 'ig:{igUserId}'
  value: { igUserId, accessToken, pageAccessToken, email, connectedAt }
```

---

## 이미지 처리 방식 (Cloudinary 대체)

Cloudinary 제거. 이미지를 직접 처리:

1. base64 → Buffer 변환
2. sharp 라이브러리로 1080x1350 리사이징 (JPEG 변환)
3. 리사이징된 이미지를 Netlify Blobs에 임시 저장
4. 공개 URL 생성: https://{siteId}.netlify.app/.netlify/blobs/{key}
5. Instagram API에 URL 전달
6. 게시 완료 후 Blobs에서 임시 이미지 삭제

---

## 구현할 파일 목록

### 1. netlify/functions/process-and-post.js (Background Function)
- scheduler.js에서 Make.com 웹훅 대신 이 함수 직접 호출
- 이미지 리사이징 → 캡션 3개 생성 → Blobs에 저장 → 알림톡 발송 (미리보기)
- 고객이 선택 안 하면 30분 후 1번 캡션 자동 선택해서 Instagram 게시

### 2. netlify/functions/select-caption.js (신규)
- 고객이 캡션 선택 시 호출
- reservationKey, captionIndex (0,1,2) 입력
- 선택된 캡션으로 즉시 Instagram 게시 실행

### 3. netlify/functions/regenerate-caption.js (신규)
- 캡션 재생성 요청
- 월 3회 제한 (Blobs에 횟수 저장: 'caption-regen:{email}:{YYYY-MM}')
- 3회 초과 시 에러 반환
- 새 캡션 3개 생성해서 반환

### 4. scheduler.js 수정
- MAKE_WEBHOOK_URL 대신 process-and-post Function 직접 호출
- 또는 scheduler.js에 전체 로직 통합

---

## 알림톡 템플릿 (신규 추가 필요)

현재 send-kakao.js에 있는 TEMPLATES에 추가:

```js
captionReady: {
  // 캡션 생성 완료 + 미리보기 링크
  // 변수: #{storeName}, #{previewUrl}, #{autoPostTime}
},
postComplete: {
  // 인스타그램 게시 완료
  // 변수: #{storeName}, #{postUrl}
},
postFailed: {
  // 게시 실패
  // 변수: #{storeName}, #{errorReason}
}
```

---

## 기존 코드에서 재사용할 패턴

### Blobs 접근 패턴 (반드시 이 패턴 사용)
```js
const store = getStore({
  name: 'store-name',
  consistency: 'strong',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_TOKEN,
});
```

### Instagram API 호출 패턴
```js
// 미디어 컨테이너 생성
const createRes = await fetch(
  `https://graph.facebook.com/v25.0/${igUserId}/media`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      image_url: publicImageUrl,
      is_carousel_item: 'true',
      access_token: igAccessToken,
    })
  }
);

// 게시 (publish)
const publishRes = await fetch(
  `https://graph.facebook.com/v25.0/${igUserId}/media_publish`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      creation_id: mediaContainerId,
      access_token: igAccessToken,
    })
  }
);
```

### Background Function 설정
```js
// 파일 맨 아래에 추가
exports.config = { type: 'background' };
```

---

## 중요 주의사항

1. **gpt-5.4 모델 사용** — 캡션 작성에는 반드시 gpt-5.4 사용 (현재 Make.com 설정)
2. **캡션 3개 생성** — 고객 선택 기능을 위해 단일 캡션이 아닌 3개 버전 생성
3. **캐러셀 Sleep 10초** — Meta 서버 처리 시간 여유를 위해 5초 → 10초로 증가
4. **토큰 만료 처리** — Instagram 토큰 만료 시 에러 메시지를 명확히 하고 알림톡 발송
5. **이미지 임시 저장 URL** — Netlify Blobs public URL이 Instagram API에서 접근 가능한지 확인 필요
6. **Background Function 제한** — 최대 15분 실행 가능. 충분함
7. **sharp 라이브러리** — package.json에 추가 필요: `"sharp": "^0.33.0"`
8. **재생성 횟수 저장 키** — 'caption-regen:{email}:{YYYY-MM}' 형식으로 월별 리셋
