#!/bin/bash
# deploy-office.sh — Pixel Agents 빌드 결과를 office/에 복사하되 layout 파일 보호
# Usage: cd /Users/kimhyun/lumi.it && bash office/deploy-office.sh

set -e

OFFICE_DIR="/Users/kimhyun/lumi.it/office"
DIST_DIR="/Users/kimhyun/pixel-agents/dist/webview"
LAYOUT_FILE="$OFFICE_DIR/assets/default-layout-1.json"
BACKUP_FILE="/tmp/lumi-layout-backup.json"

# 1) layout 백업
if [ -f "$LAYOUT_FILE" ]; then
  cp "$LAYOUT_FILE" "$BACKUP_FILE"
  echo "✓ Layout 백업 완료"
else
  echo "⚠ Layout 파일 없음 — 백업 건너뜀"
fi

# 2) 빌드 결과물 복사 (index.html + assets/)
cp "$DIST_DIR/index.html" "$OFFICE_DIR/index.html.dist"
cp -r "$DIST_DIR/assets/"* "$OFFICE_DIR/assets/"
echo "✓ 빌드 결과물 복사 완료"

# 3) layout 복원
if [ -f "$BACKUP_FILE" ]; then
  cp "$BACKUP_FILE" "$LAYOUT_FILE"
  rm "$BACKUP_FILE"
  echo "✓ Layout 복원 완료"
fi

echo "✓ deploy-office.sh 완료"
