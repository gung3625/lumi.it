# Phase 2: 영상(릴스) 자동 게시 기능 실행 계획

> 생성일: 2026-04-19
> 상태: 승인 대기

## Context

현재 lumi.it은 이미지 전용 Instagram 자동 게시 서비스. 영상(Reels) 지원을 추가한다.

### 현재 아키텍처 요약
- **프론트**: index.html 내 모바일(L2297+ `mOpenCaptionFlow`) + 데스크톱(L4006+ React UMD `BentoUploadCard`)
- **업로드**: `reserve.js` — busboy로 multipart 파싱, `lumi-images` 버킷에 업로드, reservations 테이블 insert
- **캡션 생성**: `process-and-post-background.js` — GPT-4o 이미지 분석 + GPT-5.4 캡션 생성
- **IG 게시**: `select-and-post-background.js` — `createMediaContainer()` (IMAGE/CAROUSEL) + `publishMedia()`
- **재생성**: `regenerate-caption.js` — 기존 image_analysis 재활용, GPT-5.4로 캡션 재생성
- **파일 accept**: 모바일 `accept="image/*"`, 데스크톱 `accept:'image/*'`
- **Netlify Functions 제한**: 동기 10초, Background 15분

### 핵심 설계 결정
- 영상은 **클라이언트에서 Supabase Storage 직접 업로드** (Netlify 10초 제한 우회)
- 프레임 추출도 **클라이언트** (canvas + video element, 서버 의존성 없음)
- reserve.js는 영상 파일 자체를 받지 않음 — video_url + frame base64만 수신
- IG Graph API `media_type=REELS` + `video_url` 파라미터 사용
- Phase 2b(자막 burn-in)는 Modal 서버리스 의존 — 별도 커밋 세트로 분리

---

## Phase 2a: 영상 자동 게시 (Commit 1~7)

---

### Commit 1: `feat: Supabase Storage lumi-videos 버킷 + reservations 스키마 확장`

**변경 파일:**
- (없음 — Supabase Console 수동 작업)

**구체적 변경 내용:**
- Supabase Dashboard에서 `lumi-videos` 버킷 생성 (public, 100MB file size limit)
- RLS 정책: `INSERT` — `auth.uid() = (storage.foldername(name))[1]::uuid` (사용자 본인 폴더만 업로드)
- RLS 정책: `SELECT` — public read (IG Graph API가 fetch 해야 하므로)
- `reservations` 테이블에 컬럼 추가:
  - `media_type TEXT DEFAULT 'IMAGE'` — 'IMAGE' | 'REELS'
  - `video_url TEXT` — Supabase Storage public URL
  - `video_key TEXT` — Storage 경로 (삭제/롤백용)
  - `frame_urls JSONB DEFAULT '[]'::jsonb` — 프레임 5장 public URL (선택적 저장)
  - `subtitle_data JSONB` — Phase 2b용 자막 데이터 (nullable, 지금은 미사용)

**수동 작업:**
1. Supabase Console > Storage > New bucket: `lumi-videos`, public, 100MB limit
2. `lumi-videos` 버킷 RLS 정책 설정 (INSERT: 본인 폴더, SELECT: public)
3. SQL Editor에서 ALTER TABLE:
```sql
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'IMAGE',
  ADD COLUMN IF NOT EXISTS video_url TEXT,
  ADD COLUMN IF NOT EXISTS video_key TEXT,
  ADD COLUMN IF NOT EXISTS frame_urls JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_data JSONB;
```

**검증:**
- Supabase Dashboard에서 `lumi-videos` 버킷 존재 + RLS 정책 확인
- `SELECT column_name FROM information_schema.columns WHERE table_name = 'reservations' AND column_name IN ('media_type','video_url','video_key','frame_urls','subtitle_data');` — 5행 반환

**의존성:** 없음 (첫 커밋)

---

### Commit 2: `feat: 클라이언트 영상 유효성 검사 + 프레임 추출 유틸`

**변경 파일:**
- `index.html` (유틸 함수 추가, 기존 코드 수정 없음)

**구체적 변경 내용:**

1. **`validateVideoFile(file)`** 함수 추가:
   - 허용 MIME: `video/mp4`, `video/quicktime`
   - 크기 제한: 100MB
   - duration 체크: `<video>` element로 loadedmetadata → 3~90초
   - 비율 체크: videoWidth/videoHeight → 9:16이 아니면 경고 toast (블로킹 아님)
   - 반환: `{ valid: boolean, duration: number, width: number, height: number, warning?: string }`

2. **`extractVideoFrames(file, count=7)`** 함수 추가:
   - `<video>` + `<canvas>` 사용
   - 타임스탬프(7장): `[0, min(3, duration*0.15), duration*0.25, duration*0.5, duration*0.75, max(0, duration-3), duration-0.1]`
     - Opus Clip 인사이트 반영: **0~3초 훅 구간** + **마지막 3초 엔딩** 강화
     - 1.5~3초 컷 전환 대응을 위해 5장 → 7장 상향
   - 각 프레임: canvas.toDataURL('image/jpeg', 0.85) → base64 문자열
   - 반환: `Promise<string[]>` (base64 배열, `data:image/jpeg;base64,...` 접두사 포함)

3. **`uploadVideoToSupabase(file, userId, reserveKey)`** 함수 추가:
   - `window.lumiSupa.storage.from('lumi-videos').upload(path, file, { contentType: file.type, upsert: false })`
   - 경로: `{userId}/{reserveKey}/{timestamp}-{nonce}.mp4`
   - nonce: `crypto.getRandomValues(new Uint8Array(8))` → hex
   - 반환: `{ publicUrl: string, storagePath: string }`

**검증:**
- 브라우저 콘솔에서 `validateVideoFile(videoFileObj)` 호출 → valid/duration/width/height 반환
- `extractVideoFrames(videoFileObj)` → 5개 base64 문자열 배열
- `uploadVideoToSupabase(videoFileObj, 'test-uid', 'test-key')` → publicUrl 반환 + Supabase Storage에 파일 존재

**의존성:** Commit 1 (lumi-videos 버킷)

---

### Commit 3: `feat: 모바일 + 데스크톱 파일 선택 UI에 영상 지원 추가`

**변경 파일:**
- `index.html`

**구체적 변경 내용:**

1. **파일 input accept 변경** (3곳):
   - 모바일: `accept="image/*"` → `accept="image/*,video/mp4,video/quicktime"`
   - 데스크톱 BentoUploadCard (L4579, L4750): 동일 변경

2. **`mOpenCaptionFlow(ev)` 수정** (모바일):
   - 파일 목록에서 영상 파일 감지: `files.find(f => f.type.startsWith('video/'))`
   - 영상이 있으면:
     - 영상은 1개만 허용 (2개 이상이면 toast + return)
     - 이미지와 영상 혼합 불가 (toast + return)
     - `validateVideoFile()` 호출 → 실패 시 toast + return
     - `flow.isVideo = true; flow.videoFile = files[0];`
   - 영상이 없으면 기존 이미지 로직 유지 (`flow.isVideo = false`)

3. **데스크톱 `realFiles` 상태 처리** (BentoUploadCard):
   - 파일 선택 onChange에서 동일한 영상 감지 로직
   - `isVideo` 상태 추가: `var [isVideo, setIsVideo] = React.useState(false)`
   - 영상 선택 시: 미리보기를 `<video>` 태그로 표시 (기존 `<img>` 대신)
   - "사진 추가" 버튼 숨김 (영상은 1개만)

4. **UI 텍스트 분기:**
   - CTA 제목: "사진 올리기" → 조건부 "사진/영상 올리기"
   - 모바일 `m-primary-cta-title`: "사진 한 장이면 캡션 1분" → "사진·영상 한 개면 캡션 1분"
   - 모바일 `m-primary-cta-sub`: "사진 한 장이면 캡션·해시태그 완성" → "사진·영상 한 개면 캡션·해시태그 완성"

**검증:**
- 모바일: 파일 선택 시 영상 파일이 목록에 나타남
- 영상 2개 선택 → 에러 toast
- 이미지 + 영상 혼합 → 에러 toast
- 100MB 초과 / 2초 미만 / 91초 이상 영상 → 각각 에러 toast
- 정상 영상 1개 → flow.isVideo=true, 미리보기 표시

**의존성:** Commit 2 (유틸 함수)

---

### Commit 4: `feat: 모바일 + 데스크톱 영상 업로드 플로우 (프레임 추출 + Supabase 직접 업로드)`

**변경 파일:**
- `index.html`

**구체적 변경 내용:**

1. **모바일 `submitReservation()` 수정:**
   - `flow.isVideo === true` 분기 추가:
     - 상태 텍스트: "영상을 업로드하고 있어요..."
     - `extractVideoFrames(flow.videoFile)` → 5개 base64
     - `uploadVideoToSupabase(flow.videoFile, user.id, reserveKey)` → publicUrl, storagePath
     - FormData 구성 변경:
       - `photos` 필드 대신 → `frameImages` (프레임 5장을 Blob으로 변환 후 append)
       - `fd.append('mediaType', 'REELS')`
       - `fd.append('videoUrl', publicUrl)`
       - `fd.append('videoKey', storagePath)`
     - 나머지(userMessage, captionTone, bizCategory 등)는 동일

2. **데스크톱 `buildPostFormData()` 수정:**
   - `isVideo === true` 분기:
     - 동일하게 프레임 추출 + Supabase 직접 업로드
     - FormData에 frameImages + mediaType + videoUrl + videoKey append
   - `isVideo === false`: 기존 이미지 로직 유지

3. **업로드 진행률 표시:**
   - Supabase Storage upload는 진행률 콜백 미지원 → 단순 스피너/텍스트
   - "영상 업로드 중... (최대 1분)" 표시

**검증:**
- 영상 선택 → 프레임 5장 추출 확인 (콘솔 로그)
- Supabase Storage `lumi-videos` 버킷에 영상 파일 업로드됨
- `/api/reserve` 호출 시 FormData에 mediaType=REELS, videoUrl, videoKey 포함
- 기존 이미지 업로드는 깨지지 않음 (회귀 테스트)

**의존성:** Commit 2, 3

---

### Commit 5: `feat: reserve.js 영상 예약 처리 (mediaType=REELS, 프레임 수신)`

**변경 파일:**
- `netlify/functions/reserve.js`

**구체적 변경 내용:**

1. **ALLOWED_MIME 확장:**
   - `const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];` 유지 (프레임 이미지용)

2. **필드 파싱 추가:**
   - `fields.mediaType` → 'IMAGE' (기본) | 'REELS'
   - `fields.videoUrl` → Supabase Storage public URL (REELS일 때만)
   - `fields.videoKey` → Storage 경로 (REELS일 때만)

3. **REELS 분기 로직:**
   - `mediaType === 'REELS'` 일 때:
     - `videoUrl` 필수 검증 (없으면 400)
     - 프레임 이미지(photos 배열)는 기존 lumi-images 버킷에 업로드 (GPT 분석용)
     - `image_urls`에는 프레임 이미지 URL 저장 (GPT 분석 호환)
     - `video_url`, `video_key` 추가 저장
   - `mediaType !== 'REELS'` 일 때: 기존 이미지 로직 100% 유지

4. **reservationRow 확장:**
   ```js
   const reservationRow = {
     // ... 기존 필드 모두 유지 ...
     media_type: fields.mediaType || 'IMAGE',
     video_url: fields.videoUrl || null,
     video_key: fields.videoKey || null,
   };
   ```

5. **process-and-post-background 트리거**: 기존과 동일 (reservationKey만 전달)

**검증:**
- curl로 REELS 예약 생성:
  ```bash
  # 프레임 이미지 + mediaType=REELS + videoUrl 전송
  curl -X POST https://lumi.it.kr/api/reserve \
    -H "Authorization: Bearer $TOKEN" \
    -F "photos=@frame1.jpg" -F "photos=@frame2.jpg" \
    -F "mediaType=REELS" -F "videoUrl=https://xxx.supabase.co/storage/v1/object/public/lumi-videos/..." \
    -F "videoKey=user-id/reserve:xxx/video.mp4" \
    -F "bizCategory=cafe"
  ```
- reservations 테이블에 `media_type='REELS'`, `video_url` 값 확인
- 기존 이미지 업로드도 정상 동작 (media_type='IMAGE')

**의존성:** Commit 1 (스키마), Commit 4 (클라이언트 호출)

---

### Commit 6: `feat: process-and-post-background 영상 프레임 분석 지원`

**변경 파일:**
- `netlify/functions/process-and-post-background.js`

**구체적 변경 내용:**

1. **`analyzeImages()` 프롬프트 분기:**
   - `reservation.media_type === 'REELS'` 일 때 프롬프트 변경:
     ```
     당신은 소상공인 인스타그램 릴스(짧은 영상) 마케팅 전문 분석가입니다.
     아래는 영상에서 추출한 7개 프레임입니다.
     프레임 순서: [0s(시작) / 3s(훅 종료) / 1/4 / 중간 / 3/4 / 끝-3s(엔딩 전) / 끝]
     
     ## 분석 원칙 (Opus Clip 릴스 성공 공식)
     - 첫 3초(프레임 1~2)가 이탈 여부를 결정 — 훅 강도를 특히 주목
     - 1.5~3초마다 컷 전환이 있으면 시청 지속률↑ — 장면 다양성 평가
     - 마지막 3초는 CTA 또는 여운 — 엔딩 프레임의 마무리 완성도 평가
     
     ## 출력 형식
     **[영상 개요]** 이 릴스가 보여주는 것을 한 문장으로.
     **[훅 강도]** 첫 3초(프레임 1~2)가 시선을 잡는지 / 1~5점.
     **[장면 흐름]** 7프레임의 시간 순서에 따른 서사 흐름 3~5문장.
     **[핵심 장면]** 가장 임팩트 있는 프레임과 그 이유.
     **[엔딩 완성도]** 마지막 3초가 마무리·CTA로 완결되는지 / 1~5점.
     **[감성/분위기]** 영상 전체의 톤.
     **[캡션 키워드]** 영상 기반 한국어 키워드 5개.
     **[영상 품질]** 분석 가능 여부.
     ```
   - `media_type !== 'REELS'` 일 때: 기존 이미지 분석 프롬프트 100% 유지

2. **`generateCaptions()` 분기:**
   - `media_type === 'REELS'` 일 때 캡션 프롬프트에 추가:
     - "이 캡션은 인스타그램 릴스(짧은 영상)에 붙습니다."
     - "영상의 움직임, 변화, 과정을 문장에 녹이세요."
     - carouselGuide 제거 (릴스는 단일 미디어)
   - `media_type !== 'REELS'` 일 때: 기존 100% 유지

3. **photoCount → mediaCount 호환:**
   - REELS일 때 `captionInput.photoCount = 1` (단일 미디어)
   - `captionInput.mediaType = reservation.media_type`

**검증:**
- REELS 예약 생성 후 process-and-post-background 트리거
- Netlify Functions 로그에서 "영상 개요" 포함된 분석 결과 확인
- reservations 테이블에 `generated_captions`, `image_analysis` 업데이트 확인
- 기존 이미지 예약도 정상 캡션 생성 (회귀)

**의존성:** Commit 5

---

### Commit 7: `feat: select-and-post-background IG Reels 게시 (컨테이너 생성 + 폴링 + 퍼블리시)`

**변경 파일:**
- `netlify/functions/select-and-post-background.js`

**구체적 변경 내용:**

1. **`postToInstagram()` 함수 REELS 분기 추가:**
   ```js
   // REELS 게시
   if (mediaType === 'REELS') {
     const params = new URLSearchParams({
       media_type: 'REELS',
       video_url: videoUrl,     // Supabase Storage public URL
       caption: caption,
       access_token: igAccessToken,
     });
     const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
       body: params,
     });
     const d = await res.json();
     if (d.error) throw new Error(d.error.message);
     // REELS는 처리 시간이 길어 폴링 횟수 확대
     const ready = await waitForContainer(d.id, igAccessToken, 30); // 최대 30초
     if (!ready) throw new Error('Reels 컨테이너 처리 시간 초과');
     const pData = await publishMedia(igUserId, igAccessToken, d.id);
     if (pData.error) throw new Error(pData.error.message);
     postId = pData.id;
   }
   ```

2. **`waitForContainer()` maxRetries 파라미터화:**
   - 기존: `maxRetries = 6` 고정
   - 변경: 이미지는 6, REELS는 30 (영상 인코딩 시간)

3. **함수 시그니처 변경:**
   ```js
   async function postToInstagram({ igUserId, igAccessToken, igUserAccessToken, storyEnabled, mediaType, videoUrl }, caption, imageUrls)
   ```

4. **호출부 수정:**
   ```js
   const postId = await postToInstagram(
     {
       igUserId, igAccessToken, igUserAccessToken,
       storyEnabled: reservation.story_enabled,
       mediaType: reservation.media_type || 'IMAGE',
       videoUrl: reservation.video_url,
     },
     selectedCaption,
     imageUrls
   );
   ```

5. **REELS 스토리 처리:**
   - REELS는 스토리 자동 게시 스킵 (IG API에서 영상 스토리는 별도 flow 필요 — 추후 지원)

**검증:**
- 영상 예약 → 캡션 생성 → 캡션 선택 → IG에 Reels로 게시됨
- Instagram 앱에서 Reels 탭에 영상 노출 확인
- 기존 이미지 게시도 정상 동작 (회귀)
- 90초 영상으로 테스트 → 컨테이너 폴링 30회 내 FINISHED

**의존성:** Commit 5, 6

---

## Phase 2b: 자동 자막 Burn-in (Commit 8~11)

---

### Commit 8: `feat: GPT-4o 영상 자막 데이터 동시 생성`

**변경 파일:**
- `netlify/functions/process-and-post-background.js`

**구체적 변경 내용:**

1. **`generateCaptions()` 프롬프트에 자막 생성 블록 추가 (REELS 전용):**
   ```
   ## 릴스 자막 (REELS 전용) — Opus Clip 3-구간 공식
   영상에 박을 짧은 훅 자막을 3-구간에 맞춰 정확히 3개 생성하세요.
   
   [구간 1] 0~3초 (필수 훅)
     - 질문형 / 숫자형 / 충격형 중 하나
     - 예: "이거 3초만 보세요", "매출 3배 늘린 방법", "99%가 놓치는 포인트"
   [구간 2] 중반 (핵심 메시지)
     - 영상이 전달하는 핵심 가치/포인트 1개
   [구간 3] 마지막 3초 (CTA·여운)
     - 행동 유도 또는 감성 여운
     - 예: "지금 저장해두세요", "내일도 오세요"
   
   ---SUBTITLES---
   [
     { "text": "훅 자막", "start": 0.0, "end": 2.5, "zone": "hook" },
     { "text": "핵심 자막", "start": <영상길이*0.4>, "end": <영상길이*0.6>, "zone": "message" },
     { "text": "CTA 자막", "start": <영상길이-2.5>, "end": <영상길이-0.2>, "zone": "cta" }
   ]
   ---END_SUBTITLES---
   
   규칙:
   - 각 자막 최대 15자 (한글 기준)
   - 첫 자막 start ≤ 0.3초 (초반 훅 손실 방지)
   - 자막 간 간격 최소 0.5초
   - 텍스트는 캡션과 다른 내용 (시각적 임팩트 우선)
   - 영상 길이가 10초 미만이면 2개, 30초 이상이면 3개 고정
   ```

2. **`parseSubtitles(text)` 파서 함수 추가:**
   ```js
   function parseSubtitles(text) {
     const match = text.match(/---SUBTITLES---([\s\S]*?)---END_SUBTITLES---/);
     if (!match) return null;
     try { return JSON.parse(match[1].trim()); }
     catch { return null; }
   }
   ```

3. **예약 업데이트에 subtitle_data 추가:**
   ```js
   subtitle_data: subtitles || null,  // REELS일 때만
   ```

**검증:**
- REELS 예약 → 캡션 생성 시 subtitle_data 컬럼에 JSON 배열 저장됨
- 각 항목에 text, start, end 키 존재
- 이미지 예약 시 subtitle_data는 null (회귀)

**의존성:** Commit 6

---

### Commit 9: `feat: Modal 서버리스 FFmpeg 자막 burn-in 엔드포인트`

**변경 파일:**
- `netlify/functions/burn-subtitles.js` (신규)

**구체적 변경 내용:**

1. **Netlify Function `burn-subtitles`:**
   - 인증: `LUMI_SECRET` Bearer 검증 (내부 호출 전용)
   - 입력: `{ videoUrl, subtitles: [{text, start, end}], reserveKey }`
   - Modal API 호출:
     ```js
     const res = await fetch(process.env.MODAL_BURN_SUBTITLE_URL, {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         'Authorization': `Bearer ${process.env.MODAL_API_TOKEN}`,
       },
       body: JSON.stringify({
         video_url: videoUrl,
         subtitles: subtitles,
         font: 'Pretendard-Bold',
         font_size: 48,
         font_color: 'white',
         outline_color: 'black',
         outline_width: 2,
         position: 'center',  // 화면 중앙
       }),
     });
     ```
   - Modal 응답: `{ output_url: "https://..." }` (처리 완료된 영상 URL)
   - 결과 영상을 Supabase Storage `lumi-videos` 에 재업로드:
     - 경로: `{userId}/{reserveKey}/burned-{timestamp}.mp4`
   - reservations 업데이트: `video_url` = 자막 입힌 영상 URL
   - 반환: `{ success: true, burnedVideoUrl }`

2. **netlify.toml**: `/api/*` 리다이렉트가 이미 존재하므로 추가 불필요

**수동 작업:**
1. Modal 가입 + 프로젝트 생성
2. Modal에 FFmpeg drawtext 필터 함수 배포 (별도 Python 스크립트 — 아래 참고)
3. Netlify 환경변수 추가:
   - `MODAL_BURN_SUBTITLE_URL` — Modal 엔드포인트 URL
   - `MODAL_API_TOKEN` — Modal API 인증 토큰

**Modal 함수 참고 (Python, 별도 배포):**
```python
# modal_burn_subtitle.py (Modal에 배포)
import modal, subprocess, tempfile, os, urllib.request

app = modal.App("lumi-subtitle-burner")
image = modal.Image.debian_slim().apt_install("ffmpeg").pip_install("requests")

@app.function(image=image, timeout=300)
@modal.web_endpoint(method="POST")
def burn(data: dict):
    video_url = data["video_url"]
    subtitles = data["subtitles"]
    # ... ffmpeg drawtext filter 실행 ...
    # 결과 URL 반환
```

**검증:**
- curl로 burn-subtitles 호출 → Modal 처리 → 자막 입힌 영상 URL 반환
- 반환된 URL로 영상 재생 → 자막 표시 확인

**의존성:** Commit 1 (lumi-videos 버킷), Commit 8 (subtitle_data)

---

### Commit 10: `feat: process-and-post-background에 자막 burn-in 파이프라인 통합`

**변경 파일:**
- `netlify/functions/process-and-post-background.js`

**구체적 변경 내용:**

1. **REELS + subtitle_data 존재 시 burn-in 호출 삽입:**
   - 캡션 생성 완료 후, 예약 상태 업데이트 전에:
   ```js
   // 자막 burn-in (REELS + 자막 데이터 있을 때만)
   if (reservation.media_type === 'REELS' && subtitles && subtitles.length > 0) {
     try {
       console.log('[process-and-post] 자막 burn-in 시작');
       const burnRes = await fetch(`${siteUrl}/.netlify/functions/burn-subtitles`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LUMI_SECRET}` },
         body: JSON.stringify({
           videoUrl: reservation.video_url,
           subtitles,
           reserveKey: reservationKey,
           userId: reservation.user_id,
         }),
       });
       const burnData = await burnRes.json();
       if (burnData.success && burnData.burnedVideoUrl) {
         // video_url을 자막 입힌 영상으로 교체
         await supabase.from('reservations').update({
           video_url: burnData.burnedVideoUrl,
         }).eq('reserve_key', reservationKey);
         console.log('[process-and-post] 자막 burn-in 완료');
       }
     } catch (burnErr) {
       console.error('[process-and-post] 자막 burn-in 실패 (원본으로 진행):', burnErr.message);
       // 실패해도 원본 영상으로 계속 진행
     }
   }
   ```

2. **처리 시간 고려:**
   - burn-in은 30초~2분 소요 예상
   - Background Function 15분 제한 내 충분

**검증:**
- REELS 예약 생성 → 캡션 + 자막 생성 → burn-in 호출 → video_url 교체 확인
- burn-in 실패 시에도 캡션은 정상 생성되고 원본 영상으로 게시 가능
- 이미지 예약은 burn-in 로직 스킵 (회귀)

**의존성:** Commit 8, 9

---

### Commit 11: `feat: 자막 편집 UI (모바일 + 데스크톱 캡션 확인 단계)`

**변경 파일:**
- `index.html`

**구체적 변경 내용:**

1. **캡션 확인 화면에 자막 섹션 추가 (REELS일 때만):**
   - 캡션 텍스트 아래에 "릴스 자막" 섹션 표시
   - 각 자막: 텍스트 (편집 가능 input) + 시작/종료 시간 표시
   - "자막 없이 게시" 토글 (기본 ON = 자막 포함)

2. **자막 편집 반영:**
   - 사용자가 자막 텍스트를 수정하면 로컬 상태에 반영
   - "게시하기" 클릭 시 수정된 자막을 select-caption API에 전달
   - select-caption → select-and-post-background로 subtitle_data 전달

3. **모바일 flow의 캡션 확인 단계(step 2)에도 동일 적용**

**검증:**
- REELS 예약 → 캡션 확인 화면에서 자막 2~3개 표시
- 자막 텍스트 편집 가능
- "자막 없이 게시" 토글 OFF → 원본 영상으로 게시
- 이미지 예약에서는 자막 섹션 미표시

**의존성:** Commit 8, 10

---

## 요약

| # | Phase | 커밋 제목 | 주요 파일 | 수동 작업 |
|---|-------|----------|----------|----------|
| 1 | 2a | Supabase Storage + 스키마 | (Console) | 버킷 생성, ALTER TABLE |
| 2 | 2a | 클라이언트 유틸 (검증+프레임+업로드) | index.html | 없음 |
| 3 | 2a | 파일 선택 UI 영상 지원 | index.html | 없음 |
| 4 | 2a | 영상 업로드 플로우 | index.html | 없음 |
| 5 | 2a | reserve.js 영상 예약 | reserve.js | 없음 |
| 6 | 2a | 프레임 분석 프롬프트 | process-and-post-background.js | 없음 |
| 7 | 2a | IG Reels 게시 | select-and-post-background.js | 없음 |
| 8 | 2b | GPT 자막 동시 생성 | process-and-post-background.js | 없음 |
| 9 | 2b | Modal FFmpeg burn-in | burn-subtitles.js (신규) | Modal 가입+배포, env var |
| 10 | 2b | burn-in 파이프라인 통합 | process-and-post-background.js | 없음 |
| 11 | 2b | 자막 편집 UI | index.html | 없음 |

### Phase 2a 배포 가능 지점
Commit 7 완료 시 Phase 2a 독립 배포 가능. 이 시점에서:
- 사용자가 영상 1개를 선택하면 프레임 5장 추출 + 영상 직접 업로드
- GPT-4o가 프레임 분석 → 캡션 생성
- IG에 Reels로 자동 게시

### Phase 2b 배포 가능 지점
Commit 11 완료 시 Phase 2b 독립 배포 가능. Modal 서버리스 의존성 필요.

### 미해결 사항 → open-questions.md 참조
