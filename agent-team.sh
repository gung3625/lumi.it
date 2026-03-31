#!/bin/zsh
# lumi 에이전트 팀 실행 스크립트
# 사용법: ./agent-team.sh "작업 내용"

TASK=${1:-"lumi 소개페이지 개선 아이디어를 제안해줘"}

echo "🚀 lumi 에이전트 팀 시작"
echo "작업: $TASK"
echo "================================"

# Claude Code 에이전트 팀 실행
# --dangerously-skip-permissions: 자동화를 위해 필요
claude --dangerously-skip-permissions -p "
당신은 lumi AI 운영팀의 팀 리드입니다.
CLAUDE.md의 에이전트 팀 파이프라인을 따라 작업을 진행하세요.

작업 요청: $TASK

진행 순서:
1. 아이디어 에이전트 역할로 아이디어 제안
2. 검토 에이전트 역할로 검토 후 보고
3. 김현님께 1차 승인 요청 (작업 중단 후 대기)

시작하세요.
"
