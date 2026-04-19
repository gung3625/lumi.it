"""
Modal app: FFmpeg 기반 SRT 자막 burn-in.

엔드포인트: POST /burn
Input JSON:
  {
    "videoUrl":   string (Supabase 퍼블릭 MP4 URL),
    "srt":        string (SRT 본문. "1\n00:00:00,000 --> 00:00:02,500\n..." 형식),
    "fontSize":   int  (optional, default 48),
    "position":   "bottom"|"top"|"middle" (optional, default "bottom")
  }

Response JSON:
  {
    "videoBase64": string (burn-in 결과 MP4의 base64),
    "durationSec": float,
    "sizeBytes":   int
  }

배포:
  modal deploy modal/burn_subtitles.py

로컬 테스트:
  modal run modal/burn_subtitles.py::test_burn

- 메모리 2GB / CPU 2 / timeout 300s
- 한글 폰트: fonts-noto-cjk (Noto Sans CJK KR)
- FFmpeg 프리셋: libx264 CRF 20 / preset fast / 오디오 copy (예산 ~건당 21원)
- 실패 시 FastAPI가 500 + { "error": ... } 반환, 호출자(Netlify 래퍼)가 fallback 처리.
"""

import base64
import os
import subprocess
import tempfile
import urllib.request

import modal

APP_NAME = "lumi-burn-subtitles"

# Debian slim + ffmpeg + Noto CJK(한글) 폰트 + FastAPI 의존성
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "fonts-noto-cjk", "fontconfig")
    .pip_install("fastapi==0.115.0", "pydantic==2.9.2")
    .run_commands("fc-cache -f")
)

app = modal.App(APP_NAME, image=image)


# ─────────── 정렬(Alignment) 매핑 ───────────
# ffmpeg subtitles 필터의 libass Alignment 값 (numpad 기준):
#   bottom-center = 2, middle-center = 10, top-center = 8
_ALIGN_MAP = {
    "bottom": 2,
    "middle": 10,
    "top": 8,
}


def _burn_subtitles_sync(
    video_url: str,
    srt_text: str,
    font_size: int = 48,
    position: str = "bottom",
) -> dict:
    """실제 FFmpeg burn-in 로직. 임시 디렉터리에서 동작."""
    if not video_url or not isinstance(video_url, str):
        raise ValueError("videoUrl이 비어있습니다.")
    if not srt_text or not isinstance(srt_text, str):
        raise ValueError("srt가 비어있습니다.")

    alignment = _ALIGN_MAP.get((position or "bottom").lower(), 2)
    font_size = int(font_size or 48)
    # 폰트 크기 안전 범위 (너무 작거나 너무 크면 가독성 저하)
    font_size = max(18, min(font_size, 120))

    with tempfile.TemporaryDirectory() as tmpdir:
        in_path = os.path.join(tmpdir, "input.mp4")
        srt_path = os.path.join(tmpdir, "subs.srt")
        out_path = os.path.join(tmpdir, "output.mp4")

        # 1) 비디오 다운로드
        try:
            req = urllib.request.Request(
                video_url,
                headers={"User-Agent": "lumi-burn-subtitles/1.0"},
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                with open(in_path, "wb") as f:
                    while True:
                        chunk = resp.read(1024 * 256)
                        if not chunk:
                            break
                        f.write(chunk)
        except Exception as e:
            raise RuntimeError(f"비디오 다운로드 실패: {e}")

        # 2) SRT 파일 저장 (UTF-8, BOM 없이)
        with open(srt_path, "w", encoding="utf-8") as f:
            f.write(srt_text)

        # 3) FFmpeg 명령 구성
        force_style = (
            f"FontName=Noto Sans CJK KR,"
            f"FontSize={font_size},"
            f"PrimaryColour=&HFFFFFF&,"
            f"OutlineColour=&H000000&,"
            f"BorderStyle=1,"
            f"Outline=2,"
            f"Shadow=0,"
            f"Alignment={alignment},"
            f"MarginV=60"
        )
        # subtitles 필터 내부에서 ':' 이스케이프 필요 — srt_path 절대경로이므로 escape 처리
        srt_escaped = srt_path.replace(":", "\\:").replace("'", "\\'")
        vf = f"subtitles='{srt_escaped}':force_style='{force_style}'"

        cmd = [
            "ffmpeg",
            "-y",
            "-i", in_path,
            "-vf", vf,
            "-c:v", "libx264",
            "-crf", "20",
            "-preset", "fast",
            "-c:a", "copy",
            "-movflags", "+faststart",
            out_path,
        ]

        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=280,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError("FFmpeg 실행 타임아웃 (280s)")

        if proc.returncode != 0:
            # stderr 마지막 400자만 — 민감정보 없음
            tail = (proc.stderr or "")[-400:]
            raise RuntimeError(f"FFmpeg 실패 rc={proc.returncode}: {tail}")

        # 4) 길이 측정 (ffprobe)
        duration_sec = 0.0
        try:
            probe = subprocess.run(
                [
                    "ffprobe", "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    out_path,
                ],
                capture_output=True, text=True, timeout=30,
            )
            if probe.returncode == 0:
                duration_sec = float((probe.stdout or "0").strip() or 0)
        except Exception:
            duration_sec = 0.0

        # 5) 결과 base64 인코딩
        with open(out_path, "rb") as f:
            data = f.read()
        size_bytes = len(data)
        b64 = base64.b64encode(data).decode("ascii")

        return {
            "videoBase64": b64,
            "durationSec": duration_sec,
            "sizeBytes": size_bytes,
        }


# ─────────── FastAPI 엔드포인트 (Modal web endpoint) ───────────
@app.function(
    cpu=2.0,
    memory=2048,
    timeout=300,
)
@modal.fastapi_endpoint(method="POST")
def burn(payload: dict) -> dict:
    """
    POST endpoint. payload 예:
      { "videoUrl": "...", "srt": "1\\n00:00:00,000 --> ...", "fontSize": 48, "position": "bottom" }
    """
    try:
        video_url = payload.get("videoUrl") or payload.get("video_url")
        srt_text = payload.get("srt") or payload.get("srtText")
        font_size = payload.get("fontSize") or payload.get("font_size") or 48
        position = payload.get("position") or "bottom"
        result = _burn_subtitles_sync(video_url, srt_text, font_size, position)
        return {"ok": True, **result}
    except Exception as e:
        # 스택 트레이스 숨김, 메시지만
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=str(e))


# ─────────── 로컬 테스트 ───────────
@app.function(cpu=2.0, memory=2048, timeout=300)
def test_burn() -> dict:
    """
    modal run modal/burn_subtitles.py::test_burn

    BigBuckBunny 샘플로 간단히 burn-in 결과를 생성해 크기/길이만 찍어본다.
    """
    sample_url = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"
    sample_srt = (
        "1\n"
        "00:00:00,500 --> 00:00:02,500\n"
        "안녕하세요 루미입니다\n\n"
        "2\n"
        "00:00:03,000 --> 00:00:05,000\n"
        "자막 burn-in 테스트\n\n"
        "3\n"
        "00:00:05,500 --> 00:00:08,000\n"
        "FFmpeg + Noto CJK KR\n"
    )
    result = _burn_subtitles_sync(sample_url, sample_srt, 48, "bottom")
    # 테스트에서는 base64를 제외하고 요약만 반환
    return {
        "ok": True,
        "durationSec": result["durationSec"],
        "sizeBytes": result["sizeBytes"],
        "base64Len": len(result["videoBase64"]),
    }
