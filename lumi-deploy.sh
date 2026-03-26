#!/bin/bash
# lumi 자동 배포 스크립트
# 사용법: ./lumi-deploy.sh "커밋 메시지"

cd /Users/kimhyun/lumi.it

MSG=${1:-"Update files"}

git add -A
git commit -m "$MSG"
git push origin main

echo "✅ 배포 완료: $MSG"
