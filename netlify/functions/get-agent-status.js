const fs = require('fs');
const path = require('path');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // 인증
  const auth = (event.headers.authorization || '').replace('Bearer ', '');
  if (auth !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
  }

  try {
    const projectDir = '/Users/kimhyun/.claude/projects/-Users-kimhyun-lumi-it';
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ agents: [], sessions: [] }) };
    }

    // 최근 3개 세션 분석
    const agents = [];
    const recentSessions = files.slice(0, 3);

    for (const file of recentSessions) {
      const filePath = path.join(projectDir, file.name);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      let lastActivity = null;
      let lastTool = null;
      let lastText = null;
      let status = 'idle';
      let model = null;
      let sessionId = file.name.replace('.jsonl', '');

      // 마지막 50줄만 분석 (성능)
      const recentLines = lines.slice(-50);

      for (const line of recentLines) {
        try {
          const entry = JSON.parse(line);

          if (entry.type === 'assistant' && entry.message) {
            model = entry.message.model || model;
            lastActivity = entry.timestamp;

            if (entry.message.content) {
              for (const block of entry.message.content) {
                if (block.type === 'tool_use') {
                  lastTool = block.name;
                  status = 'working';
                  if (block.name === 'Write' || block.name === 'Edit') status = 'writing';
                  else if (block.name === 'Read' || block.name === 'Grep') status = 'reading';
                  else if (block.name === 'Bash') status = 'running';
                  else if (block.name === 'WebSearch') status = 'searching';
                } else if (block.type === 'text' && block.text) {
                  lastText = block.text.substring(0, 100);
                }
              }
            }

            if (entry.message.stop_reason === 'end_turn') {
              status = 'done';
            }
          }

          if (entry.type === 'user' && entry.message) {
            status = 'working';
          }
        } catch (e) { /* skip malformed lines */ }
      }

      // 5분 이상 비활성이면 idle
      if (lastActivity) {
        const elapsed = Date.now() - new Date(lastActivity).getTime();
        if (elapsed > 5 * 60 * 1000) status = 'idle';
      }

      // 에이전트 타입 추론 (slug 또는 model 기반)
      let agentType = 'implementer';
      if (lastTool === 'WebSearch' || (lastText && /마케팅|SEO|카피|홍보|CRO/.test(lastText))) {
        agentType = 'marketer';
      } else if (lastTool === 'Bash' && lastText && /curl|검증|QA|테스트/.test(lastText)) {
        agentType = 'qa-tester';
      }

      agents.push({
        sessionId,
        agentType,
        status,
        lastTool,
        lastText,
        lastActivity,
        model,
        elapsed: lastActivity ? Math.floor((Date.now() - new Date(lastActivity).getTime()) / 1000) : null,
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        agents,
        serverTime: new Date().toISOString(),
        totalSessions: files.length,
      }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ agents: [], error: 'transcript 읽기 실패' }),
    };
  }
};
