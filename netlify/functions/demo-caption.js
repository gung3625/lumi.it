const { getAdminClient } = require('./_shared/supabase-admin');
const { checkAndIncrementQuota, QuotaExceededError } = require('./_shared/openai-quota');

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

    // ── 서비스 전체 일일 OpenAI 예산 체크 (demo는 sellerId 없음 → null)
    // gpt-4o(₩50) + gpt-5.4(₩100) = ₩150 추정
    try {
      await checkAndIncrementQuota(null, 'gpt-4o', 150);
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        return { statusCode: 429, headers, body: JSON.stringify({ error: '서비스 체험 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.' }) };
      }
      throw e;
    }

    // ══════════════════════════════════════
    // STEP 1: GPT-4o 이미지 분석 (Emotion-first, JSON 출력)
    // ══════════════════════════════════════

    // 업종별 분석 힌트 (해당 업종만 노출 — prompt bloat 방지)
    const CATEGORY_HINTS = {
      'cafe': '잔·컵 디자인, 크림·거품의 층, 토핑의 손길, 빛이 음료를 통과하는 방식',
      'food': '플레이팅의 여백, 김·연기·기름의 윤기, 재료 단면, 식기의 질감',
      'beauty': '피부결, 컬러 톤의 미묘한 전환, 광택/매트, 시술 직후의 살아있는 느낌',
      'nail': '손의 결, 네일 아트의 미세한 패턴, 손톱 끝의 마감, 컬러 깊이',
      'hair': '머릿결의 흐름, 컬의 탄력, 컬러 레이어드, 빛이 머리에 떨어지는 각도',
      'flower': '꽃잎의 생기, 색 대비, 포장지 질감, 잎과 꽃의 리듬',
      'fashion': '핏/실루엣, 소재 주름, 컬러 매칭, 착용자의 자세',
      'fitness': '움직임의 순간, 근육의 텐션, 공간의 에너지, 땀/햇빛',
      'pet': '동물의 눈빛·표정, 털·수염의 디테일, 순간 포즈, 인간과의 거리감',
    };
    const hint = CATEGORY_HINTS[bizCategory] || '사진의 주인공과 주변의 관계, 빛이 만드는 분위기';

    const analysisPrompt = `당신은 한국 소상공인 인스타그램 캡션 카피라이터의 파트너 이미지 분석가입니다.
결과는 JSON으로만 출력하세요. 다른 설명 없이.

## 업종: ${bizCategory}
## 이 업종에서 주목할 점: ${hint}

## 분석 원칙 (절대)
1. 사진에 **실제 보이는 것만** — 추측·지어내기 금지
2. **Feature가 아니라 Emotion** — "녹색과 크림의 대비" ❌ / "오후 3시에 쉬고 싶을 때 딱 생각나는 색" ✅
3. 메뉴판·간판·가격표 텍스트가 보이면 그대로 읽기
4. 사진이 업종과 무관하면 솔직히 표시 (category_match: false)

## 출력 (JSON만, 마크다운 코드펜스 없이)

{
  "first_impression": "0.3초의 인상 한 문장 (감정 우선, 서술형)",
  "subject": "피사체 핵심 (메뉴/제품명 구체)",
  "mood": "구체적 감성 ('예쁜' 금지, 상황·시간·인물까지 연결)",
  "visual_hook": "스크롤을 멈추게 할 시각적 한 포인트",
  "keywords": ["한국어 명사 5개, 날씨·계절 제외"],
  "first_sentence_candidates": {
    "question": "질문형 첫 문장 후보",
    "emotional": "감성형 첫 문장 후보 (명사 문장 가능)",
    "direct": "직관형 첫 문장 후보 (짧고 단호)",
    "observational": "관찰형 첫 문장 후보 ('~더라고요')",
    "conversational": "대화형 첫 문장 후보 ('~잖아요')"
  },
  "category_match": true
}`;

    const analysisRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 700,
        temperature: 0.4, // 분석은 일관성 우선
        response_format: { type: 'json_object' },
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
    const rawAnalysis = analysisData.choices?.[0]?.message?.content?.trim();
    if (!rawAnalysis) throw new Error('이미지 분석 실패');

    let analysis;
    try {
      analysis = JSON.parse(rawAnalysis);
    } catch (e) {
      // JSON 파싱 실패 시 원본 문자열 그대로 사용 (fallback)
      analysis = { _raw: rawAnalysis };
    }

    console.log('[demo-caption] 분석 완료:', (analysis.first_impression || rawAnalysis).substring(0, 150));

    // ══════════════════════════════════════
    // STEP 2: gpt-5.4 캡션 생성 (Emotion-first, 랜덤 앵글, 범위 제약)
    // ══════════════════════════════════════

    // 랜덤 샘플링 — 매 호출마다 다른 캡션이 나오는 핵심
    const angles = ['question','emotional','direct','observational','conversational'];
    const chosenAngle = angles[Math.floor(Math.random() * angles.length)];
    const angleMap = {
      question: '질문형 — 독자가 답하고 싶어지는 질문 1개',
      emotional: '감성형 — 명사 문장 or 짧은 장면 묘사, 여백 있게',
      direct: '직관형 — 짧고 단호, 수식어 최소',
      observational: '관찰형 — "~더라고요", "~네요" 어미로 일상적 관찰',
      conversational: '대화형 — "~잖아요", "~지 않아요?" 상대를 끌어들임',
    };
    const angleHint = angleMap[chosenAngle];
    const pickedFirst = (analysis.first_sentence_candidates && analysis.first_sentence_candidates[chosenAngle]) || '';

    // CTA 포함 여부 70:30 — 때로는 pure moment로 끝나는 게 더 강함
    const includeCta = Math.random() < 0.7;
    const ctaIntents = {
      'cafe': '장소/방문 호기심 — 구체 문구는 직접 만들 것',
      'food': '메뉴/맛 호기심 — 구체 문구는 직접 만들 것',
      'beauty': '예약·DM 문의 유도 — 부드럽게',
      'nail': '예약·DM 문의 유도 — 부드럽게',
      'hair': '예약·DM 문의 유도 — 부드럽게',
      'flower': '선물 대상 상상하게 하기',
      'fashion': '저장해두고 싶게 하기',
      'fitness': '동료 태그 유도 — "같이 할 사람?" 같은 상투어는 피할 것',
      'pet': '공감·경험 공유 유도',
    };
    const ctaHint = ctaIntents[bizCategory] || '저장/공유/댓글/방문 중 자연스러운 것';

    const analysisForPrompt = analysis._raw
      ? analysis._raw
      : JSON.stringify(analysis, null, 2);

    const captionPrompt = `당신은 한국 소상공인 대신 인스타 캡션을 써주는 전문 카피라이터입니다.
목표: "사장님이 직접 쓴 거지?" 느끼게 하기. AI 티가 나면 실패.

## 입력

### 이미지 분석 (JSON)
${analysisForPrompt}

### 매장·시점
업종: ${bizCategory}
오늘: ${month}월 ${day}일(${dayOfWeek}), ${season}

### 날씨
${weatherBlock}

### 트렌드
${trendBlock}

## 이번 캡션 지시 (매번 달라짐)
- 첫 문장 앵글: **${chosenAngle}** → ${angleHint}
- 참고 초안(베끼지 말고 변형): "${pickedFirst}"
- CTA 포함: ${includeCta ? `예 — ${ctaHint}` : '아니오 — pure moment로 마무리, 행동 유도 없이 여운만'}

## 실패 예시 (이런 문장은 절대 금지)
❌ "안녕하세요 사장입니다 🌸 오늘 특별한 신메뉴를 소개합니다"
❌ "여러분 저희 가게에 오시면 후회 없으실 거예요 💖"
❌ "맛있는 커피와 신선한 디저트가 기다리고 있어요"
❌ "많은 관심과 사랑 부탁드립니다 😊"
❌ "놀러 오세요 🙌 기다리고 있을게요"
❌ "녹색의 진한 대비와 부드러운 크림이 어우러진..." (feature 나열)

## 성공 예시 (이런 온도)
✅ "비 오는 날엔 이게 더 맛있어요. 왜인진 모르겠는데"
✅ "3시쯤 오세요. 빵 나와요."
✅ "이거 만들 때마다 한 번씩 실수함. 근데 오늘은 됐다."
✅ "오후 3시, 창가 자리 비어있으면 좋은 날"

## 형식 (범위 — 엄격한 고정 X)
- 본문 **3~7줄 이내** (사진의 강도에 맞춰 자연스럽게)
- 이모지 **0~4개** (강제 X, 있으면 감정·대상 뒤에 자연 배치)
- 해시태그 **5~8개** — 대형 2 / 중형 2 / 소형 1~2 / 트렌드(사진 관련만) 1~2
- 매장명·자기 소개·고객 호칭("여러분")·"~드립니다"체 금지
- 분석의 subject·keywords에서 실제 보이는 것만 활용
- 날씨는 자연스럽게 한 문장에 녹일 것 (기온 숫자 직접 쓰지 말 것)
- 트렌드는 **본문에 직접 언급 금지**, 해시태그로만

## 법적·윤리 금지
- 과대광고("최고","1위","가성비 최강"), 효능 단정
- "무첨가","100% 천연" 등 미인증 표시
- 경쟁사·타 브랜드·연예인 언급, 저작권 가사·대사 인용
- 시간 단정("이번 주까지만"), 고객 반응 날조

## 출력
캡션 1개만. 본문 + 줄바꿈 + 해시태그 블록. 그 외 텍스트·따옴표·제목 없이.`;

    const captionRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        input: captionPrompt,
        temperature: 0.78, // 변주↑ (AI slop 완화)
      }),
    });

    const captionData = await captionRes.json();
    if (captionData.error) throw new Error(`캡션 생성 오류: ${captionData.error.message || JSON.stringify(captionData.error)}`);
    const caption = captionData.output?.[0]?.content?.[0]?.text || captionData.output_text || '';
    if (!caption) throw new Error('캡션 생성 실패');

    // ── Post-gen 검증 (비용 추가 없이 품질 로그) ──
    try {
      const body = caption.trim();
      const hashtagCount = (body.match(/#[^\s#]+/g) || []).length;
      const banned = /(안녕하세요|많은\s*관심|놀러\s*오세요|최고|업계\s*1위|100%\s*천연|무첨가|정성스럽|드립니다)/;
      const bannedHit = banned.test(body);
      console.log(`[demo-caption] quality: len=${body.length} hashtags=${hashtagCount} bannedHit=${bannedHit} angle=${chosenAngle} cta=${includeCta}`);
    } catch(_){}

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
