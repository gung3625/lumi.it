'use strict';
// 디자인 컷 렌더러 — 상품 사진 + 카피 + 그래픽을 "한 장"으로 합성한 상세페이지 이미지(PNG) 생성.
// 기존 buildHtml(HTML 템플릿: 사진 따로/글 따로) 대체. 헤드리스 브라우저 없이 sharp + text-to-svg(번들 폰트→벡터 패스).
//  - 이식성: sharp·text-to-svg는 기존 의존성. 폰트는 repo 번들 .otf를 직접 읽어 벡터화(시스템 폰트/fontconfig 불필요) → GCP에서 추가 설치 0.
//  - 합성 중심: 사용/실물 컷은 풀블리드 사진 + 그래디언트 스크림 + 오버레이 카피 = 사진과 글이 하나의 구성.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const TextToSVG = require('text-to-svg');

// ── 디자인 토큰 ──────────────────────────────────────────────
const C = {
  ink: '#332e26',      // 따뜻한 다크 브라운(에디토리얼)
  cream: '#f1ebdf',    // 웜 크림
  white: '#ffffff',
  accent: '#c98a4e',   // 카라멜(상품색 미추출 시 기본)
  body: '#6b6254',     // 본문(연 브라운)
  mutedOnDark: '#d8d0c4',
  lineCream: '#e4dccd',
  lineDark: 'rgba(255,255,255,0.14)',
};
const W = 1080;        // 상세 이미지 표준 폭
const PAD = 96;        // 좌우 여백
const CONTENT = W - PAD * 2;
let T;                 // 현재 테마(브랜드 색 톤온톤). renderDetailCuts 시작 시 설정.

// ── 폰트 로딩 (가중치 4단) ───────────────────────────────────
// 기본 경로 = repo 번들(_shared/fonts). 미존재 시 opts.fontDir로 주입(프리뷰).
function loadFonts(fontDir) {
  const dir = fontDir || path.join(__dirname, 'fonts');
  const pick = (names) => {
    for (const n of names) { const p = path.join(dir, n); if (fs.existsSync(p)) return TextToSVG.loadSync(p); }
    throw new Error('폰트 없음: ' + names.join('/') + ' (dir=' + dir + ')');
  };
  const opt = (names) => { for (const n of names) { const p = path.join(dir, n); if (fs.existsSync(p)) return TextToSVG.loadSync(p); } return null; };
  return {
    black: pick(['NotoSansKR-Black.otf', 'notokr-black.otf']),
    bold: pick(['NotoSansKR-Bold.otf', 'notokr.ttf', 'notokr-bold.otf']),
    medium: pick(['NotoSansKR-Medium.otf', 'notokr-med.otf']),
    regular: pick(['NotoSansKR-Regular.otf', 'notokr-reg.otf']),
    serif: opt(['Gloock-Regular.ttf']),            // 영문 디스플레이 세리프(감성 헤드라인)
    serifItalic: opt(['CrimsonPro-Italic.ttf']),   // 영문 이탤릭(스크립트풍 보조)
  };
}

// ── 텍스트 줄바꿈 (벡터 폭 측정 기반) ────────────────────────
// 공백 단위 그리디 줄바꿈, 한 토큰이 maxWidth 초과 시 글자 단위 분해(긴 한글런 대응).
function wrapText(t2s, text, fontSize, maxWidth, letterSpacing = 0) {
  const opt = { fontSize, letterSpacing };
  const measure = (s) => (s ? t2s.getMetrics(s, opt).width : 0);
  const lines = [];
  for (const para of String(text == null ? '' : text).split('\n')) {
    if (!para) { lines.push(''); continue; }
    const tokens = para.split(/(\s+)/); // 공백 보존
    let cur = '';
    const pushChars = (token) => {
      let chunk = '';
      for (const ch of token) {
        if (measure(chunk + ch) > maxWidth && chunk) { lines.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      cur = chunk;
    };
    for (const tk of tokens) {
      if (/^\s+$/.test(tk)) { if (measure(cur + ' ') <= maxWidth) cur += ' '; continue; }
      if (measure(cur + tk) <= maxWidth) { cur += tk; continue; }
      if (cur.trim()) { lines.push(cur.trimEnd()); cur = ''; }
      if (measure(tk) > maxWidth) pushChars(tk); else cur = tk;
    }
    if (cur.trim() || cur === '') lines.push(cur.trimEnd());
  }
  return lines.filter((l, i, a) => !(l === '' && (i === 0 || i === a.length - 1)));
}

// 여러 줄 텍스트를 SVG path 문자열 + 점유 높이로 반환.
function textBlock(t2s, text, { x, y, fontSize, lineHeight, fill, maxWidth, letterSpacing = 0, anchor = 'left top', align = 'left' }) {
  const lines = wrapText(t2s, text, fontSize, maxWidth, letterSpacing);
  const lh = Math.round(fontSize * lineHeight);
  let svg = '';
  lines.forEach((ln, i) => {
    let lx = x;
    if (align !== 'left' && ln) {
      const w = t2s.getMetrics(ln, { fontSize, letterSpacing }).width;
      lx = align === 'center' ? x + (maxWidth - w) / 2 : x + (maxWidth - w);
    }
    if (ln) svg += tp(t2s, ln, { x: lx, y: y + i * lh, fontSize, letterSpacing, anchor, fill });
  });
  return { svg, height: lines.length * lh, lines: lines.length };
}

// ── 사진 처리 ────────────────────────────────────────────────
// 버퍼/URL → WxH cover 크롭 PNG 버퍼. 실패 시 우아한 플레이스홀더.
async function coverPhoto(src, w, h) {
  try {
    let buf = src;
    if (typeof src === 'string') {
      const r = await fetch(src);
      if (!r.ok) throw new Error('img ' + r.status);
      buf = Buffer.from(await r.arrayBuffer());
    }
    return await sharp(buf).resize(w, h, { fit: 'cover', position: 'attention' }).toBuffer();
  } catch (_) {
    // 플레이스홀더(크림 그라데이션) — 디자인 검토용.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#e7e0d5"/><stop offset="1" stop-color="#d9cfbf"/></linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/></svg>`;
    return await sharp(Buffer.from(svg)).png().toBuffer();
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// text-to-svg getPath는 색을 options.attributes.fill 로만 반영(options.fill 무시) → fill을 attributes로 변환.
function tp(font, text, o = {}) {
  const { fill, attributes, ...rest } = o;
  return font.getPath(text, { ...rest, attributes: { fill: fill || C.ink, ...(attributes || {}) } });
}
const EB_SIZE = 20, EB_LS = 0.18; // 아이브로: letterSpacing은 em 단위(0.18 = 적당한 트래킹)
const eyebrowSvg = (F, t, x, y, color = C.accent) =>
  (t ? tp(F.bold, String(t).toUpperCase(), { x, y, fontSize: EB_SIZE, letterSpacing: EB_LS, anchor: "left top", fill: color }) : "");
const ruleSvg = (x, y, color = C.accent, w = 56, h = 4) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`;
const roundRect = (x, y, w, h, r, fill, stroke) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1"` : ''}/>`;

// 흔한 한글/영문 색상명 → hex (색 스와치 컷용). 매칭 안 되면 제외.
const COLOR_HEX = {
  '블랙': '#1d1d1f', '검정': '#1d1d1f', '먹': '#2b2b2b', '차콜': '#3a3a3c',
  '화이트': '#f6f4f0', '흰': '#f6f4f0', '아이보리': '#efe9dc', '크림': '#ece3d4',
  '베이지': '#d9c7a8', '샌드': '#cdb892', '카멜': '#b3895a', '브라운': '#6b4a2f', '초콜릿': '#4a3526',
  '그레이': '#9a958d', '회색': '#9a958d', '실버': '#c6c6c6',
  '네이비': '#2a3550', '블루': '#3f5b86', '스카이': '#92b4cf', '민트': '#a8cfbf', '그린': '#5c7a55', '카키': '#6f6a4b', '올리브': '#6f6a4b',
  '핑크': '#e3a7ad', '로즈': '#c97d83', '레드': '#a8403f', '버건디': '#6e2f33', '코랄': '#e08a72',
  '옐로': '#e6c259', '머스타드': '#caa13f', '오렌지': '#d4863f', '퍼플': '#7d6a93', '라벤더': '#b3a5c4',
};
function extractColors(options) {
  const seen = new Map();
  for (const o of options || []) {
    const s = String(o == null ? '' : (o.name || o.value || o)).trim();
    for (const k of Object.keys(COLOR_HEX)) {
      if (s.includes(k) && !seen.has(COLOR_HEX[k])) seen.set(COLOR_HEX[k], { name: s.length <= 6 ? s : k, hex: COLOR_HEX[k] });
    }
  }
  return [...seen.values()].slice(0, 8);
}

// ── 색 혼합 / 테마 틴트 ──────────────────────────────────────
function hex2rgb(h) { const m = h.replace('#', ''); return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)]; }
function rgb2hex(r) { return '#' + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
function mix(a, b, t) { const x = hex2rgb(a), y = hex2rgb(b); return rgb2hex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t)); }
const lighten = (h, t) => mix(h, '#ffffff', t);
function rgb2hsl(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h, s, l = (mx + mn) / 2; if (mx === mn) { h = s = 0; } else { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); switch (mx) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; default: h = (r - g) / d + 4; } h /= 6; } return [h, s, l]; }
function hsl2rgb(h, s, l) { let r, g, b; if (s === 0) { r = g = b = l; } else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; const hue = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }; r = hue(h + 1 / 3); g = hue(h); b = hue(h - 1 / 3); } return [r * 255, g * 255, b * 255]; }

// 상품 사진에서 대표색 추출(배경 흰/검/무채색 제외, 채도 높은 색 우선) → 보기 좋은 악센트로 정규화.
async function dominantAccent(buf) {
  try {
    const { data, info } = await sharp(buf).resize(120, 120, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels, buckets = new Map();
    for (let i = 0; i < data.length; i += ch) {
      const [h, s, l] = rgb2hsl(data[i], data[i + 1], data[i + 2]);
      if (l > 0.9 || l < 0.1 || s < 0.12) continue; // 배경/무채색 제외
      const key = Math.round(h * 24) + '_' + Math.round(s * 4) + '_' + Math.round(l * 4);
      const w = s * s * (1 - Math.abs(l - 0.5));
      const c = buckets.get(key) || { n: 0, w: 0, r: 0, g: 0, b: 0 };
      c.n++; c.w += w; c.r += data[i]; c.g += data[i + 1]; c.b += data[i + 2]; buckets.set(key, c);
    }
    let best = null; for (const v of buckets.values()) if (!best || v.w > best.w) best = v;
    if (!best) return null;
    let [h, s, l] = rgb2hsl(best.r / best.n, best.g / best.n, best.b / best.n);
    s = Math.max(0.4, Math.min(0.7, s)); l = Math.max(0.42, Math.min(0.58, l)); // 예쁜 악센트로 정규화
    return rgb2hex(hsl2rgb(h, s, l));
  } catch (_) { return null; }
}

// 상품색 기반 테마(레퍼런스: 상품 색에 맞춘 톤온톤). 기본=카라멜.
function makeTheme(accent) {
  const a = accent || C.accent;
  return {
    accent: a,
    tint: mix(a, C.cream, 0.8),        // 상품색 살짝 섞은 크림(섹션 배경)
    tintSoft: mix(a, '#ffffff', 0.9),  // 더 옅은 틴트(배지 배경)
    tintMid: mix(a, '#ffffff', 0.68),
    deep: mix(a, C.ink, 0.45),         // 상품색 띤 다크 섹션
    line: mix(a, C.cream, 0.6),
  };
}

// ── 아이콘(24x24 stroke) — 원형 배지용 ───────────────────────
const ICONS = {
  thermo: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v6"/>',
  feather: '<path d="M19 5a6 6 0 0 0-8.5 0L4 11.5V20h8.5L19 13.5A6 6 0 0 0 19 5z"/><path d="M5 19L12 12"/>',
  droplet: '<path d="M12 3s6 6.4 6 10a6 6 0 1 1-12 0c0-3.6 6-10 6-10z"/>',
  palette: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  leaf: '<path d="M4 20C4 11 11 4 20 4c0 9-7 16-16 16z"/><path d="M5 19c4-6 8-9 13-11"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2.2"/>',
  sparkle: '<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
};
function iconFor(text) {
  const s = String(text || '');
  if (/온도|보온|보냉|단열|따뜻|차갑/.test(s)) return 'thermo';
  if (/가벼|무게|그립|한 손|휴대/.test(s)) return 'feather';
  if (/세척|얼음|물|위생|입구|세정/.test(s)) return 'droplet';
  if (/색|컬러|데일리/.test(s)) return 'palette';
  if (/인증|안전|KC|안심/.test(s)) return 'shield';
  if (/친환경|자연|성분|식물/.test(s)) return 'leaf';
  if (/시간|오래|유지|지속/.test(s)) return 'clock';
  return 'sparkle';
}
// 원형 배지 + 아이콘. cx,cy 중심, r 반지름.
function iconBadge(name, cx, cy, r, color, bg) {
  const s = (r * 2) / 24 * 0.92, ox = cx - r * 0.92, oy = cy - r * 0.92;
  const inner = (ICONS[name] || ICONS.sparkle).replace(/currentColor/g, color);
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${bg}"/>`
    + `<g transform="translate(${ox},${oy}) scale(${s})" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
}

// SVG 오버레이(투명)를 베이스(색/사진) 위에 합성 → 컷 PNG 버퍼.
async function compose(width, height, baseBuf, overlaySvg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${overlaySvg}</svg>`;
  const layers = [{ input: Buffer.from(svg), top: 0, left: 0 }];
  if (baseBuf) return sharp(baseBuf).composite(layers).png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background: C.white } }).composite(layers).png().toBuffer();
}

// ── 컷 빌더 ──────────────────────────────────────────────────

// HERO: 에디토리얼 — 크림 그래디언트 배경 + 아치 제품사진 + 세리프 영문 무드 + 한글 헤드라인.
async function cutHero(F, { photo, eyebrow, headline, sub, moodEN }) {
  // 상단 영역: 아치 제품사진
  const archW = 620, archH = 720, archTop = 96, archLeft = (W - archW) / 2;
  let y = archTop + archH + 64;
  let o = '';
  // 세리프 영문 무드 워드(있으면)
  if (F.serif && moodEN) {
    const mw = F.serif.getMetrics(moodEN, { fontSize: 72 }).width;
    o += tp(F.serif, moodEN, { x: (W - mw) / 2, y, fontSize: 72, anchor: 'left top', fill: C.ink }); y += 84;
  }
  // 세리프 이탤릭 보조(eyebrow)
  if (F.serifItalic && eyebrow) {
    const ew = F.serifItalic.getMetrics(eyebrow, { fontSize: 30 }).width;
    o += tp(F.serifItalic, eyebrow, { x: (W - ew) / 2, y, fontSize: 30, anchor: 'left top', fill: T.accent }); y += 30;
  }
  o += `<rect x="${(W - 44) / 2}" y="${y + 6}" width="44" height="3" fill="${T.accent}"/>`; y += 42;
  const hl = textBlock(F.black, headline, { x: PAD, y, fontSize: 56, lineHeight: 1.26, fill: C.ink, maxWidth: CONTENT, align: 'center' });
  o += hl.svg; y += hl.height + (sub ? 22 : 0);
  if (sub) { const sb = textBlock(F.medium, sub, { x: PAD, y, fontSize: 28, lineHeight: 1.6, fill: C.body, maxWidth: CONTENT - 80, align: 'center' }); o += sb.svg; y += sb.height; }
  const H = y + 92;
  const arch = await archImage(await coverPhoto(photo, archW, archH), archW, archH);
  const base = await sharp(await gradBg(T.tintSoft, T.tint, H)).composite([{ input: arch, top: archTop, left: Math.round(archLeft) }]).png().toBuffer();
  return { name: 'hero', png: await compose(W, H, base, o), height: H };
}

// 타이포 컷(단색 배경) — 중앙정렬 헤드라인 + 항목 리스트(헤어라인 구분)
async function cutList(F, { theme, eyebrow, headline, items, numbered }) {
  const dark = theme === 'dark';
  const bg = dark ? T.deep : (theme === 'cream' ? T.tint : C.white);
  const fg = dark ? C.white : C.ink;
  const sub = dark ? lighten(T.accent, 0.5) : C.body;
  const line = dark ? C.lineDark : mix(T.accent, '#ffffff', 0.78);
  let y = 104;
  let o = '';
  if (eyebrow) { o += centerEyebrow(F, eyebrow, y, dark ? lighten(T.accent, 0.35) : T.accent); y += 30; }
  o += `<rect x="${(W - 44) / 2}" y="${y}" width="44" height="3" fill="${dark ? lighten(T.accent, 0.35) : T.accent}"/>`; y += 34;
  const hb = textBlock(F.black, headline, { x: PAD, y, fontSize: 46, lineHeight: 1.3, fill: fg, maxWidth: CONTENT, align: 'center' });
  o += hb.svg; y += hb.height + 54;

  const innerX = numbered ? PAD : PAD + 20;
  const innerW = numbered ? CONTENT : CONTENT - 40;
  items.forEach((it, i) => {
    if (i) { o += `<rect x="${PAD}" y="${y}" width="${CONTENT}" height="1" fill="${line}"/>`; y += 40; }
    else y += 4;
    if (numbered) {
      const num = String(i + 1).padStart(2, '0');
      o += tp(F.black, num, { x: PAD, y, fontSize: 30, anchor: 'left top', fill: T.accent });
      const tb = textBlock(F.medium, it, { x: PAD + 78, y: y - 2, fontSize: 31, lineHeight: 1.5, fill: fg, maxWidth: CONTENT - 78 });
      o += tb.svg; y += Math.max(tb.height, 38) + 36;
    } else {
      const tb = textBlock(F.medium, it, { x: innerX, y, fontSize: 31, lineHeight: 1.55, fill: sub, maxWidth: innerW, align: 'center' });
      o += tb.svg; y += tb.height + 36;
    }
  });
  const H = y + 80;
  const baseBuf = dark ? await gradBg(mix(T.deep, '#000000', 0.04), T.deep, H)
    : (theme === 'cream' ? await gradBg(T.tintSoft, T.tint, H) : await solid(C.white, H));
  return { name: numbered ? 'benefits' : 'list', png: await compose(W, H, baseBuf, o), height: H };
}

// 사용/실물 컷: 풀블리드 사진 + 하단 스크림 + 오버레이 카피(번호+헤드라인+본문) = 사진과 글이 한 장.
async function cutSection(F, { photo, index, headline, body }) {
  const H = 1240;
  const base = await coverPhoto(photo, W, H);
  const num = String(index).padStart(2, '0');
  const hb = textBlock(F.black, headline, { x: PAD, y: 0, fontSize: 50, lineHeight: 1.24, fill: C.white, maxWidth: CONTENT });
  const bb = body ? textBlock(F.regular, body, { x: PAD, y: 0, fontSize: 29, lineHeight: 1.7, fill: C.mutedOnDark, maxWidth: CONTENT - 30 }) : { svg: '', height: 0 };
  const blockH = 64 + hb.height + (body ? 26 + bb.height : 0);
  const top = H - 96 - blockH;
  let o = `<defs><linearGradient id="scrim${index}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#16140f" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#16140f" stop-opacity="0.4"/>
      <stop offset="1" stop-color="#16140f" stop-opacity="0.88"/></linearGradient></defs>
    <rect x="0" y="${Math.round(H * 0.34)}" width="${W}" height="${Math.round(H * 0.66)}" fill="url(#scrim${index})"/>`;
  o += tp(F.black, num, { x: PAD, y: top, fontSize: 30, anchor: 'left top', fill: T.accent });
  o += ruleSvg(PAD + 56, top + 18, T.accent, 36, 2);
  o += shift(hb.svg, 0, top + 64);
  if (body) o += shift(bb.svg, 0, top + 64 + hb.height + 26);
  return { name: 'section', png: await compose(W, H, base, o), height: H };
}

// 혜택 — 아이콘 배지 + 둥근 컬러 카드. 단조 리스트 대신 디자인 컷.
async function cutBenefits(F, items) {
  let y = 108;
  let o = centerEyebrow(F, 'Why It Matters', y, T.accent); y += 30;
  o += `<rect x="${(W - 44) / 2}" y="${y}" width="44" height="3" fill="${T.accent}"/>`; y += 36;
  const hb = textBlock(F.black, '이런 점이 다릅니다', { x: PAD, y, fontSize: 46, lineHeight: 1.3, fill: C.ink, maxWidth: CONTENT, align: 'center' });
  o += hb.svg; y += hb.height + 52;
  const cardPad = 40, br = 38, textX = PAD + cardPad + br * 2 + 28, textW = CONTENT - cardPad - (br * 2 + 28) - cardPad;
  items.forEach((it, i) => {
    const tb = textBlock(F.medium, it, { x: 0, y: 0, fontSize: 30, lineHeight: 1.45, fill: C.ink, maxWidth: textW });
    const cardH = Math.max(tb.height + cardPad * 2, 132);
    o += roundRect(PAD, y, CONTENT, cardH, 22, T.tint);
    o += iconBadge(iconFor(it), PAD + cardPad + br, y + cardH / 2, br, T.accent, '#ffffff');
    o += shift(tb.svg, textX, y + (cardH - tb.height) / 2);
    y += cardH + 20;
  });
  return { name: 'benefits', png: await compose(W, y + 76, await solid(C.white, y + 76), o), height: y + 76 };
}

// 둥근 모서리 이미지 버퍼.
async function roundImage(buf, w, h, r) {
  const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}"/></svg>`);
  return sharp(buf).resize(w, h, { fit: 'cover', position: 'attention' }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}
// 아치(반원 상단) 프레임 이미지 — 레퍼런스 시그니처.
async function archImage(buf, w, h) {
  const r = w / 2;
  const d = `M0 ${h} L0 ${r} A ${r} ${r} 0 0 1 ${w} ${r} L ${w} ${h} Z`;
  const mask = Buffer.from(`<svg width="${w}" height="${h}"><path d="${d}" fill="#fff"/></svg>`);
  return sharp(buf).resize(w, h, { fit: 'cover', position: 'attention' }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}
// 세로 그래디언트 배경 버퍼(깊이감).
async function gradBg(c1, c2, h) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="${W}" height="${h}" fill="url(#bg)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// 기능 배지 — 원형 아이콘 3종(브랜드 틴트 배경). 한눈에 보는 핵심.
async function cutFeatures(F, items) {
  const top = items.slice(0, 3);
  let y = 100;
  let o = centerEyebrow(F, 'Features', y, T.accent); y += 30;
  o += `<rect x="${(W - 44) / 2}" y="${y}" width="44" height="3" fill="${T.accent}"/>`; y += 36;
  const hb = textBlock(F.black, '한눈에 보는 핵심', { x: PAD, y, fontSize: 42, lineHeight: 1.3, fill: C.ink, maxWidth: CONTENT, align: 'center' });
  o += hb.svg; y += hb.height + 64;
  const colW = CONTENT / top.length, r = 60, labelW = colW - 36;
  const badgeCy = y + r;
  let maxLabelH = 0;
  top.forEach((it, i) => {
    const cx = PAD + colW * i + colW / 2;
    o += iconBadge(iconFor(it), cx, badgeCy, r, T.accent, T.tintSoft);
    const tb = textBlock(F.medium, it, { x: 0, y: 0, fontSize: 24, lineHeight: 1.45, fill: C.ink, maxWidth: labelW, align: 'center' });
    o += shift(tb.svg, cx - labelW / 2, badgeCy + r + 30);
    maxLabelH = Math.max(maxLabelH, tb.height);
  });
  const H = badgeCy + r + 30 + maxLabelH + 80;
  return { name: 'features', png: await compose(W, H, await solid(T.tintSoft, H), o), height: H };
}

// 제품 쇼케이스 — 제품을 둥근 컬러 패널 위에(레퍼런스 누끼-온-컬러 시그니처). photo는 화보 연동 전 시뮬.
async function cutShowcase(F, { photo, headline, sub }) {
  let y = 112;
  let o = centerEyebrow(F, 'Showcase', y, T.accent); y += 30;
  o += `<rect x="${(W - 44) / 2}" y="${y}" width="44" height="3" fill="${T.accent}"/>`; y += 34;
  const hb = textBlock(F.black, headline, { x: PAD, y, fontSize: 42, lineHeight: 1.3, fill: C.ink, maxWidth: CONTENT, align: 'center' });
  o += hb.svg; y += hb.height + (sub ? 18 : 0);
  if (sub) { const sb = textBlock(F.medium, sub, { x: PAD, y, fontSize: 27, lineHeight: 1.5, fill: C.body, maxWidth: CONTENT - 60, align: 'center' }); o += sb.svg; y += sb.height; }
  y += 50;
  const imgW = 640, imgH = 760, imgTop = y, imgLeft = (W - imgW) / 2;
  const H = imgTop + imgH + 92;
  const imgBuf = await archImage(await coverPhoto(photo, imgW, imgH), imgW, imgH);
  const base = await sharp(await gradBg(T.tintSoft, T.tint, H)).composite([{ input: imgBuf, top: Math.round(imgTop), left: Math.round(imgLeft) }]).png().toBuffer();
  return { name: 'showcase', png: await compose(W, H, base, o), height: H };
}

// 색상 스와치 — 컬러 칩 그리드(드랩아트식 디자인 컷). colors: [{name,hex}]
async function cutSwatch(F, colors) {
  let y = 108;
  let o = centerEyebrow(F, 'Color', y, T.accent); y += 30;
  o += `<rect x="${(W - 44) / 2}" y="${y}" width="44" height="3" fill="${T.accent}"/>`; y += 36;
  const title = colors.length + '가지 색으로,\n나만의 데일리';
  const hb = textBlock(F.black, title, { x: PAD, y, fontSize: 44, lineHeight: 1.3, fill: C.ink, maxWidth: CONTENT, align: 'center' });
  o += hb.svg; y += hb.height + 56;
  const per = Math.min(4, colors.length), d = 132, rows = Math.ceil(colors.length / per);
  const gap = per > 1 ? (CONTENT - per * d) / (per - 1) : 0;
  for (let r = 0; r < rows; r++) {
    const rowItems = colors.slice(r * per, r * per + per);
    const rowW = rowItems.length * d + (rowItems.length - 1) * gap;
    const startX = (W - rowW) / 2;
    rowItems.forEach((c, ci) => {
      const cx = startX + ci * (d + gap) + d / 2, cy = y + d / 2;
      const lightBorder = /#(f|e)/i.test(c.hex);
      o += `<circle cx="${cx}" cy="${cy}" r="${d / 2}" fill="${c.hex}"${lightBorder ? ` stroke="${C.lineCream}" stroke-width="1"` : ''}/>`;
      const lw = F.medium.getMetrics(c.name, { fontSize: 24 }).width;
      o += tp(F.medium, c.name, { x: cx - lw / 2, y: y + d + 22, fontSize: 24, anchor: 'left top', fill: C.body });
    });
    y += d + 64;
  }
  return { name: 'swatch', png: await compose(W, y + 40, await gradBg(T.tintSoft, T.tint, y + 40), o), height: y + 40 };
}

// 제품정보 표
async function cutSpec(F, rows) {
  let y = 104;
  let o = centerEyebrow(F, 'Product Info', y, T.accent); y += 30;
  o += `<rect x="${(W - 44) / 2}" y="${y}" width="44" height="3" fill="${T.accent}"/>`; y += 34;
  const hb = textBlock(F.black, '제품 정보', { x: PAD, y, fontSize: 44, lineHeight: 1.3, fill: C.ink, maxWidth: CONTENT, align: 'center' });
  o += hb.svg; y += hb.height + 44;
  rows.forEach((r) => {
    o += `<rect x="${PAD}" y="${y}" width="${CONTENT}" height="1" fill="${C.lineCream}"/>`; y += 30;
    o += tp(F.medium, String(r[0]), { x: PAD, y, fontSize: 28, anchor: 'left top', fill: C.body });
    const vw = F.bold.getMetrics(String(r[1]), { fontSize: 28 }).width;
    o += tp(F.bold, String(r[1]), { x: W - PAD - vw, y, fontSize: 28, anchor: 'left top', fill: C.ink });
    y += 50;
  });
  o += `<rect x="${PAD}" y="${y}" width="${CONTENT}" height="1" fill="${C.lineCream}"/>`;
  const H = y + 90;
  return { name: 'spec', png: await compose(W, H, await solid(C.white, H), o), height: H };
}

// FAQ
async function cutFaq(F, faq) {
  let y = 104;
  let o = centerEyebrow(F, 'FAQ', y, T.accent); y += 30;
  o += `<rect x="${(W - 44) / 2}" y="${y}" width="44" height="3" fill="${T.accent}"/>`; y += 34;
  const hb = textBlock(F.black, '자주 묻는 질문', { x: PAD, y, fontSize: 42, lineHeight: 1.3, fill: C.ink, maxWidth: CONTENT, align: 'center' });
  o += hb.svg; y += hb.height + 48;
  faq.forEach((f, i) => {
    if (i) { o += `<rect x="${PAD}" y="${y}" width="${CONTENT}" height="1" fill="${C.lineCream}"/>`; y += 40; }
    const qb = textBlock(F.bold, 'Q. ' + f.q, { x: PAD, y, fontSize: 30, lineHeight: 1.4, fill: C.ink, maxWidth: CONTENT });
    o += qb.svg; y += qb.height + 16;
    const ab = textBlock(F.regular, f.a, { x: PAD, y, fontSize: 28, lineHeight: 1.7, fill: C.body, maxWidth: CONTENT });
    o += ab.svg; y += ab.height + 36;
  });
  const H = y + 70;
  return { name: 'faq', png: await compose(W, H, await gradBg(T.tintSoft, T.tint, H), o), height: H };
}

// CTA(다크 + 악센트)
async function cutCta(F, closing) {
  const H = 460;
  let o = `<rect x="${(W - 56) / 2}" y="150" width="56" height="4" fill="${T.accent}"/>`;
  const cb = textBlock(F.bold, closing, { x: PAD, y: 200, fontSize: 38, lineHeight: 1.5, fill: C.white, maxWidth: CONTENT, align: 'center' });
  o += cb.svg;
  return { name: 'cta', png: await compose(W, H, await solid(T.deep, H), o), height: H };
}

// ── 유틸 ─────────────────────────────────────────────────────
function shift(svgPaths, dx, dy) { return `<g transform="translate(${dx},${dy})">${svgPaths}</g>`; }
function centerEyebrow(F, t, y, color) {
  if (F.serifItalic) { // 세리프 이탤릭(에디토리얼 무드)
    const w = F.serifItalic.getMetrics(t, { fontSize: 30 }).width;
    return tp(F.serifItalic, t, { x: (W - w) / 2, y: y - 6, fontSize: 30, anchor: 'left top', fill: color });
  }
  const w = F.bold.getMetrics(String(t).toUpperCase(), { fontSize: EB_SIZE, letterSpacing: EB_LS }).width;
  return tp(F.bold, String(t).toUpperCase(), { x: (W - w) / 2, y, fontSize: EB_SIZE, letterSpacing: EB_LS, anchor: 'left top', fill: color });
}
async function solid(color, h) {
  return sharp({ create: { width: W, height: h, channels: 4, background: color } }).png().toBuffer();
}

// ── 메인: 카피 + 상품 → 디자인 컷 배열 + 세로 합본 ───────────
async function renderDetailCuts(product, copy, opts = {}) {
  const F = loadFonts(opts.fontDir);
  const photos = opts.photos || (product.images || []); // 버퍼 or URL 배열
  const px = (i) => photos.length ? photos[i % photos.length] : null;
  const c = copy || {};
  // 상품색 자동 테마: opts.accent 없으면 대표 상품사진에서 추출(복숭아→분홍 등).
  let accent = opts.accent;
  if (!accent && photos.length) { try { accent = await dominantAccent(await coverPhoto(px(0), 240, 240)); } catch (_) {} }
  T = makeTheme(accent);
  const cuts = [];

  cuts.push(await cutHero(F, { photo: px(0), eyebrow: c.heroEyebrow || 'Lumi Select', moodEN: c.moodEN, headline: c.heroHeadline || product.title, sub: c.heroSub }));
  if (Array.isArray(c.concerns) && c.concerns.length)
    cuts.push(await cutList(F, { theme: 'cream', eyebrow: 'Your Concern', headline: '혹시, 이런 고민\n있으셨나요?', items: c.concerns }));
  if (Array.isArray(c.benefits) && c.benefits.length)
    cuts.push(await cutBenefits(F, c.benefits));
  cuts.push(await cutShowcase(F, { photo: px(1), headline: c.showcaseHeadline || '실물로 보는 차이', sub: c.heroSub }));
  const colors = extractColors(product.options);
  if (colors.length >= 3) cuts.push(await cutSwatch(F, colors));
  let si = 2;
  for (const s of (Array.isArray(c.sections) ? c.sections : [])) {
    cuts.push(await cutSection(F, { photo: px(si - 1), index: si, headline: s.headline || '', body: s.body || '' }));
    si++;
  }
  if (c.comparison && Array.isArray(c.comparison.points) && c.comparison.points.length)
    cuts.push(await cutList(F, { theme: 'dark', eyebrow: 'The Difference', headline: c.comparison.headline || '왜 이 제품일까요?', items: c.comparison.points }));
  const specRows = buildSpecRows(product.spec);
  if (specRows.length) cuts.push(await cutSpec(F, specRows));
  if (Array.isArray(c.faq) && c.faq.length) cuts.push(await cutFaq(F, c.faq.slice(0, 4)));
  if (c.closing) cuts.push(await cutCta(F, c.closing));

  const stitched = await stitch(cuts);
  return { cuts, stitched };
}

function buildSpecRows(spec) {
  const rows = [];
  if (!spec) return rows;
  if (spec.size && /[x×*]/i.test(String(spec.size))) rows.push(['크기', String(spec.size).replace(/[xX*]/g, ' × ') + ' cm']);
  if (spec.weight && /^[0-9.]+$/.test(String(spec.weight)) && parseFloat(spec.weight) > 0) rows.push(['무게', String(spec.weight) + ' kg']);
  if (spec.model) rows.push(['모델명', spec.model]);
  if (spec.country) rows.push(['원산지', String(spec.country).replace(/_/g, ' ')]);
  if (spec.manufacturer) rows.push(['제조/수입', spec.manufacturer]);
  if (spec.kc && spec.kc.length) rows.push(['인증', spec.kc.join(', ')]);
  return rows;
}

// 컷들을 세로로 이어붙여 단일 상세 이미지.
async function stitch(cuts) {
  const totalH = cuts.reduce((a, c) => a + c.height, 0);
  const composites = [];
  let top = 0;
  for (const cut of cuts) { composites.push({ input: cut.png, top, left: 0 }); top += cut.height; }
  return sharp({ create: { width: W, height: totalH, channels: 4, background: C.white } })
    .composite(composites).png().toBuffer();
}

module.exports = { renderDetailCuts, loadFonts, W };
