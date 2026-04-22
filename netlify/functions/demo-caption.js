const { getAdminClient } = require('./_shared/supabase-admin');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// demo-caption 1일 제한 횟수
const DEMO_DAILY_LIMIT = 3;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { image, bizCategory, recaptchaToken } = JSON.parse(event.body || '{}');

    console.log('[demo-caption] bizCategory:', bizCategory, '| image length:', image ? image.length : 0);

    if (!image || !bizCategory) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '사진과 업종을 입력해주세요.' }) };
    }

    // ── reCAPTCHA v3 검증 (fail-closed) ──
    // RECAPTCHA_SECRET_KEY가 설정돼 있으면 토큰 필수 + API 호출 실패 시 차단.
    // Google reCAPTCHA 다운 시 일시 중단이 DoS보다 안전.
    if (process.env.RECAPTCHA_SECRET_KEY) {
      if (!recaptchaToken) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: '보안 검증 토큰이 필요해요. 페이지를 새로고침 후 다시 시도해주세요.' }) };
      }
      let rcData;
      try {
        const rcRes = await fetch(`https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${encodeURIComponent(recaptchaToken)}`, {
          method: 'POST',
        });
        if (!rcRes.ok) throw new Error(`reCAPTCHA API ${rcRes.status}`);
        rcData = await rcRes.json();
      } catch (e) {
        console.error('[demo-caption] reCAPTCHA API 호출 실패:', e.message);
        return { statusCode: 403, headers, body: JSON.stringify({ error: '보안 검증을 완료할 수 없어요. 잠시 후 다시 시도해주세요.' }) };
      }
      if (!rcData.success || (rcData.score != null && rcData.score < 0.3)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: '보안 검증에 실패했어요. 다시 시도해주세요.' }) };
      }
    }

    // ── IP 기반 하루 N회 제한 (rate_limits 테이블, service_role) ──
    const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown').split(',')[0].trim();
    const admin = getAdminClient();

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const rateKind = `demo-caption:${today}`;

    let currentCount = 0;
    try {
      const { data: rateRow } = await admin
        .from('rate_limits')
        .select('count, first_at')
        .eq('kind', rateKind)
        .eq('ip', ip)
        .maybeSingle();

      if (rateRow) {
        currentCount = rateRow.count || 0;
      }
    } catch (e) {
      console.warn('[demo-caption] rate_limits 조회 실패:', e.message);
    }

    if (currentCount >= DEMO_DAILY_LIMIT) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: '체험 횟수(3회)를 모두 사용했어요. 더 다양한 캡션을 원하시면 무료로 가입해보세요!' }) };
    }

    // ── 날짜/시즌 ──
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const dayOfWeek = ['일', '월', '화', '수', '목', '금', '토'][now.getDay()];
    const seasonMap = { 1:'겨울',2:'겨울',3:'봄',4:'봄',5:'봄',6:'여름',7:'여름',8:'여름',9:'가을',10:'가을',11:'가을',12:'겨울' };
    const season = seasonMap[month];

    // ── 서울 날씨 가져오기 ──
    let weatherBlock = '날씨 정보 없음 — 날씨 언급하지 마세요.';
    try {
      const wRes = await fetch('https://lumi.it.kr/.netlify/functions/get-weather?sido=11&sigungu=11680');
      if (wRes.ok) {
        const w = await wRes.json();
        if (w.status) {
          weatherBlock = `날씨 (서울 기준): ${w.status}${w.temperature ? ' / ' + w.temperature + '°C' : ''}${w.mood ? '\n분위기: ' + w.mood : ''}${w.guide ? '\n가이드: ' + w.guide : ''}
숫자 직접 쓰지 말 것. "오늘처럼 선선한 날엔" ✅`;
        }
      }
    } catch (e) { console.log('[demo-caption] 날씨 fetch 실패:', e.message); }

    // ── 트렌드 가져오기 ──
    let trendBlock = '트렌드 정보 없음.';
    try {
      const tRes = await fetch(`https://lumi.it.kr/.netlify/functions/get-trends?category=${encodeURIComponent(bizCategory)}&scope=domestic`);
      if (tRes.ok) {
        const tData = await tRes.json();
        if (tData.keywords && tData.keywords.length > 0) {
          const trendTags = tData.keywords.map(k => k.keyword.startsWith('#') ? k.keyword : '#' + k.keyword);
          trendBlock = `트렌드 태그: ${trendTags.join(', ')}${tData.insight ? '\n인사이트: ' + tData.insight : ''}
사진 내용과 관련 있는 트렌드만 해시태그에 2~3개 포함. 무관한 트렌드 태그 사용 금지.`;
        }
      }
    } catch (e) { console.log('[demo-caption] 트렌드 fetch 실패:', e.message); }

    // ══════════════════════════════════════
    // STEP 1: GPT-4o 이미지 분석
    // ══════════════════════════════════════
    const analysisPrompt = `당신은 소상공인 인스타그램 마케팅 전문 이미지 분석가입니다.
분석 결과는 캡션 카피라이터에게 전달됩니다.

업종: ${bizCategory}

## 업종별 분석 포인트
- 카페/베이커리: 음료 색감, 토핑, 크림 질감, 잔/컵 디자인, 디저트 단면
- 음식점: 메뉴 구성, 플레이팅, 김/연기(온도감), 소스/토핑 디테일
- 뷰티/네일/헤어: 시술 결과물, 컬러 톤, 디자인 패턴, 질감(광택/매트)
- 꽃집: 꽃 품종, 색 조합, 포장 스타일, 리본/소품
- 패션: 코디 구성, 컬러 매칭, 핏/실루엣, 소재감
- 피트니스: 운동 동작, 기구, 공간 분위기, 에너지
- 펫: 동물 표정/포즈, 용품, 간식, 인터랙션
- 인테리어: 공간 스타일, 컬러 팔레트, 조명, 소품 배치
- 스튜디오: 조명 셋업, 포즈, 배경, 보정 스타일

## 분석 원칙 (절대 준수)
- **사진에 실제로 보이는 것만 분석하세요.** 사진에 없는 것을 추측/지어내기 금지.
- 사진이 업종과 무관해 보이면 솔직히 밝히고 보이는 것을 있는 그대로 분석하세요.
- 사물 나열 금지. "딸기가 있고, 잔이 있다" → 실패. "선명한 딸기 빛이 우유 위에 스며드는 순간" → 성공.
- 메뉴판, 간판, 가격표, 로고 등 텍스트가 보이면 반드시 읽어서 포함.
- **사진에 없는 음식, 음료, 제품을 절대 언급 금지.**
- 인스타그램 피드에서 스크롤을 멈추게 만드는 요소가 무엇인지 찾으세요.

## 출력

**[첫인상]** 이 사진을 처음 본 0.3초의 느낌. 한 문장. 이것이 캡션 첫 문장의 씨앗.

**[핵심 분석]** 3~5문장:
- 피사체: 무엇이 찍혀 있는지 (메뉴명, 제품명 구체적으로)
- 감성: "예쁜" 말고 "비 오는 오후 창가에 혼자 앉은 느낌" 수준의 구체적 감성
- 시각: 주된 색조, 빛의 질감(자연광/인공), 구도의 특징
- 공간: 분위기, 인테리어, 눈에 띄는 소품

**[캡션 키워드]** 사진의 시각적 특징에서 나온 한국어 키워드 5개. (날씨/계절 제외)

**[첫 문장 후보]** 캡션 첫 문장 3개 (질문형 / 감성형 / 직관형). 각각 완전히 다른 접근.`;

    const analysisRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 1024,
        temperature: 0.6,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: analysisPrompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}`, detail: 'high' } },
          ],
        }],
      }),
    });

    const analysisData = await analysisRes.json();
    if (analysisData.error) throw new Error(`이미지 분석 오류: ${analysisData.error.message}`);
    const imageAnalysis = analysisData.choices?.[0]?.message?.content?.trim();
    if (!imageAnalysis) throw new Error('이미지 분석 실패');

    console.log('[demo-caption] 이미지 분석 완료:', imageAnalysis.substring(0, 200));

    // ══════════════════════════════════════
    // STEP 2: gpt-5.4 캡션 생성
    // ══════════════════════════════════════
    const captionPrompt = `당신은 한국 소상공인의 인스타그램 캡션을 대신 써주는 전문 카피라이터입니다.
이미지 분석 결과를 바탕으로 매력적인 캡션 1개를 만들어주세요.

## 입력 정보

### 이미지 분석
${imageAnalysis}

### 매장 정보
업종: ${bizCategory}
오늘: ${month}월 ${day}일 (${dayOfWeek}요일), ${season}

### 날씨
${weatherBlock}

### 트렌드
${trendBlock}

## 말투: 편하게 말하듯이, ~요 체, 이모지 적절히 사용

## 절대 금지
- "안녕하세요", "감사합니다" 같은 뻔한 인사/마무리
- "맛있는", "신선한", "정성스러운" 같은 과장 형용사
- AI가 쓴 것처럼 매끄러운 문장
- 제목, 따옴표, 부연 설명
- 경쟁사/타 브랜드 이름 언급 금지
- "업계 1위", "최고", "가성비 최강" 같은 과대광고
- 의학적/건강 효능 단정 금지
- 종교/정치/사회적 논란 이슈 언급 금지
- "무첨가", "100% 천연", "유기농" 등 법적 위험 표현 금지
- 고객 비하, 강요, 불안 조성 표현 금지
- 성적/선정적 표현, 외모 평가 금지
- 욕설, 비속어, 은어 금지
- 저작권 있는 노래 가사/영화 대사 인용 금지
- 연예인/유명인 이름 동의 없이 사용 금지
- 사진에 없는 메뉴를 트렌드라고 넣지 말 것
- 이미지 분석에 나온 피사체만 캡션에 활용. 분석에 없는 것을 지어내지 말 것
- "이번 주까지만", "곧 품절" 같은 시간/시기 단정 금지
- "손님들이 다 좋아하세요" 같은 고객 반응 날조 금지
- 트렌드를 직접 설명하지 말 것 → 분위기/감성으로만 녹일 것

## 이런 캡션을 쓰세요
- 이미지 분석의 [첫인상]을 캡션 첫 문장의 감성 씨앗으로 활용
- [첫 문장 후보]를 참고하되 그대로 베끼지 말 것
- 첫 문장에서 스크롤이 멈춤
- 대표님이 직접 쓴 것 같은 자연스러움
- 이모지는 캡션의 감정을 보완하는 위치에 자연스럽게. 요즘 인스타그램 트렌드에 맞게.
- 날씨를 자연스럽게 한 문장에 녹일 것 (기온 숫자 직접 쓰지 말 것)
- 마지막 문장은 자연스러운 행동 유도:
  · 카페/음식: "여기 어디야?" 댓글 유도
  · 뷰티: "예약/DM 문의" 유도
  · 꽃집: "누구에게 주고 싶은지" 댓글 유도
  · 패션: "저장해두세요" 유도
  · 피트니스: "같이 할 사람?" 태그 유도
  · 펫: "우리 아이도 이래요" 공감 유도
  · 기타: 저장/공유/댓글/방문 중 자연스러운 것

## 해시태그
해시태그 구성: 대형 + 중형 + 소형 + 트렌드(사진 관련만)
개수와 스타일은 요즘 인스타그램 트렌드에 맞게 자연스럽게.
사진과 무관한 해시태그 금지. 현재 시즌과 맞지 않는 해시태그 금지.
캡션 본문 마지막에 줄바꿈 후 한 블록.

## 출력
캡션 1개 (본문 + 해시태그). 캡션만 출력하세요. 다른 텍스트 없이.`;

    const captionRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: 'gpt-5.4', input: captionPrompt }),
    });

    const captionData = await captionRes.json();
    if (captionData.error) throw new Error(`캡션 생성 오류: ${captionData.error.message || JSON.stringify(captionData.error)}`);
    const caption = captionData.output?.[0]?.content?.[0]?.text || captionData.output_text || '';
    if (!caption) throw new Error('캡션 생성 실패');

    // ── rate limit 카운트 증가 (upsert) ──
    try {
      const nowIso = new Date().toISOString();
      await admin.from('rate_limits').upsert(
        {
          kind: rateKind,
          ip,
          count: currentCount + 1,
          first_at: currentCount === 0 ? nowIso : undefined,
          last_at: nowIso,
        },
        { onConflict: 'kind,ip', ignoreDuplicates: false }
      );
    } catch (e) {
      console.warn('[demo-caption] rate_limits upsert 실패:', e.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        caption: caption.trim(),
        disclaimer: '체험용 캡션은 서울 기준 날씨로 작성됩니다. 가입하시면 매장 지역 날씨·말투 학습·캡션 3개 선택이 가능해요.',
      }),
    };
  } catch (err) {
    console.error('demo-caption error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '캡션 생성 중 오류가 발생했어요. 다시 시도해주세요.' }) };
  }
};
