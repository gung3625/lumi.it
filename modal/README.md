# Modal — Lumi 자막 burn-in (Phase 2b)

릴스 영상에 SRT 자막을 FFmpeg으로 burn-in(하드코딩)하는 서버리스 GPU 엔드포인트.

- 엔드포인트 파일: `burn_subtitles.py`
- Modal 앱 이름: `lumi-burn-subtitles`
- Function: `burn` (POST)
- 예산 목표: 건당 약 21원 (CRF 20 / preset fast / 오디오 copy)

## 1. 최초 1회 설치

```bash
pip install modal
modal token new   # 브라우저로 이동 → Modal 계정 로그인 → 토큰 자동 저장 (~/.modal.toml)
```

이미 다른 Modal 프로젝트에서 로그인되어 있다면 `modal token new` 는 생략 가능.

## 2. 배포

프로젝트 루트(`/Users/kimhyun/lumi.it`)에서:

```bash
modal deploy modal/burn_subtitles.py
```

배포가 끝나면 터미널에 `burn` 함수의 **Public URL**이 찍힌다.
예:

```
✓ Created web function burn => https://<workspace>--lumi-burn-subtitles-burn.modal.run
```

이 URL을 복사해서 **Netlify 환경변수** `MODAL_BURN_SUBTITLES_URL` 에 그대로 붙여넣는다.

## 3. Netlify 환경변수 설정

Netlify 웹 대시보드 → Site configuration → Environment variables → Add:

| Key                          | Value                                                     |
| ---------------------------- | --------------------------------------------------------- |
| `MODAL_BURN_SUBTITLES_URL`   | 2번 단계에서 복사한 `https://...modal.run` URL (그대로)   |

기존 환경변수(`LUMI_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`)는 재사용하므로 추가 설정 불필요.

## 4. 로컬 테스트

Modal 원격 컨테이너에서 샘플 영상(BigBuckBunny 10초 / 1MB)으로 burn-in 경로만 실제로 태워본다:

```bash
modal run modal/burn_subtitles.py::test_burn
```

성공 시 다음과 같은 값이 출력됨:

```
{ 'ok': True, 'durationSec': ~10.0, 'sizeBytes': ~900000, 'base64Len': ~1200000 }
```

## 5. 운영 체크리스트

- [ ] `modal deploy` 성공 & 엔드포인트 URL 확보
- [ ] Netlify 환경변수 `MODAL_BURN_SUBTITLES_URL` 저장
- [ ] Netlify 재배포(새 환경변수 반영)
- [ ] `modal app list` 에 `lumi-burn-subtitles` STATUS `deployed` 확인
- [ ] Supabase migration `add_subtitle_columns.sql` 적용 (`subtitle_status`, `subtitle_srt` 컬럼)

## 6. 동작 개요

1. Netlify `process-and-post-background.js` 가 REELS 캡션 확정 직후 GPT-4o-mini로 짧은 한국어 SRT(3~5블록)를 생성.
2. Netlify `/api/burn-subtitles` 래퍼가 `LUMI_SECRET` 인증 후 이 Modal 엔드포인트(`MODAL_BURN_SUBTITLES_URL`)에 `{ videoUrl, srt }` POST.
3. Modal 컨테이너: 비디오 fetch → `/tmp` 임시 저장 → SRT 저장 → `ffmpeg -vf subtitles=...:force_style=...` 로 burn-in → 결과 MP4를 base64로 응답.
4. Netlify 래퍼가 base64 → Buffer 로 변환 후 Supabase Storage `lumi-videos` 버킷에 `{user_id}/{reserveKey}/subtitled-{ts}.mp4` 로 업로드 → public URL을 `reservations.video_url` 에 UPDATE.
5. 실패 시 원본 `video_url` 유지 + `subtitle_status='skipped'`, 후속 IG/Threads 게시는 그대로 진행(best-effort).

## 7. 파라미터

| 필드        | 타입                         | 기본값     | 설명                                      |
| ----------- | ---------------------------- | ---------- | ----------------------------------------- |
| `videoUrl`  | string (HTTPS MP4)           | —          | Supabase `lumi-videos` 퍼블릭 URL         |
| `srt`       | string (SRT format UTF-8)    | —          | `1\n00:00:00,000 --> ...` 형식 본문        |
| `fontSize`  | int (18~120)                 | 48         | 자막 폰트 크기                            |
| `position`  | `bottom`\|`middle`\|`top`    | `bottom`   | 화면 수직 위치                            |

폰트: Noto Sans CJK KR (한글 지원).
