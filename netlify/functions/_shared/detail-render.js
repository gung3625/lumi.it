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
  ink: '#16140f',      // 따뜻한 먹색
  cream: '#f3efe8',    // 크림
  white: '#ffffff',
  accent: '#c98a4e',   // 카라멜
  body: '#5f574e',     // 본문 먹색(연)
  mutedOnDark: '#cfc7bb',
  lineCream: '#e3ddd2',
  lineDark: 'rgba(255,255,255,0.14)',
};
const W = 1080;        // 상세 이미지 표준 폭
const PAD = 96;        // 좌우 여백
const CONTENT = W - PAD * 2;

// ── 폰트 로딩 (가중치 4단) ───────────────────────────────────
// 기본 경로 = repo 번들(_shared/fonts). 미존재 시 opts.fontDir로 주입(프리뷰).
function loadFonts(fontDir) {
  const dir = fontDir || path.join(__dirname, 'fonts');
  const pick = (names) => {
    for (const n of names) { const p = path.join(dir, n); if (fs.existsSync(p)) return TextToSVG.loadSync(p); }
    throw new Error('폰트 없음: ' + names.join('/') + ' (dir=' + dir + ')');
  };
  return {
    black: pick(['NotoSansKR-Black.otf', 'notokr-black.otf']),
    bold: pick(['NotoSansKR-Bold.otf', 'notokr.ttf', 'notokr-bold.otf']),
    medium: pick(['NotoSansKR-Medium.otf', 'notokr-med.otf']),
    regular: pick(['NotoSansKR-Regular.otf', 'notokr-reg.otf']),
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
    if (ln) svg += t2s.getPath(ln, { x: lx, y: y + i * lh, fontSize, letterSpacing, anchor, fill });
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
const EB_SIZE = 20, EB_LS = 0.18; // 아이브로: letterSpacing은 em 단위(0.18 = 적당한 트래킹)
const eyebrowSvg = (F, t, x, y, color = C.accent) =>
  (t ? F.bold.getPath(String(t).toUpperCase(), { x, y, fontSize: EB_SIZE, letterSpacing: EB_LS, anchor: 'left top', fill: color }) : '');
const ruleSvg = (x, y, color = C.accent, w = 56, h = 4) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`;

// SVG 오버레이(투명)를 베이스(색/사진) 위에 합성 → 컷 PNG 버퍼.
async function compose(width, height, baseBuf, overlaySvg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${overlaySvg}</svg>`;
  const layers = [{ input: Buffer.from(svg), top: 0, left: 0 }];
  if (baseBuf) return sharp(baseBuf).composite(layers).png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background: C.white } }).composite(layers).png().toBuffer();
}

// ── 컷 빌더 ──────────────────────────────────────────────────

// HERO: 풀블리드 사진 + 하단 다크 스크림 + 오버레이(아이브로/헤드라인/서브)
async function cutHero(F, { photo, eyebrow, headline, sub }) {
  const H = 1180;
  const base = await coverPhoto(photo, W, H);
  const hl = textBlock(F.black, headline, { x: PAD, y: 0, fontSize: 76, lineHeight: 1.18, fill: C.white, maxWidth: CONTENT });
  const subH = sub ? textBlock(F.medium, sub, { x: PAD, y: 0, fontSize: 30, lineHeight: 1.55, fill: C.mutedOnDark, maxWidth: CONTENT - 40 }) : { svg: '', height: 0 };
  const blockH = 56 + hl.height + (sub ? 26 + subH.height : 0);
  const top = H - 90 - blockH;
  let o = `<defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#16140f" stop-opacity="0"/>
      <stop offset="0.55" stop-color="#16140f" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#16140f" stop-opacity="0.86"/></linearGradient></defs>
    <rect x="0" y="${Math.round(H * 0.4)}" width="${W}" height="${Math.round(H * 0.6)}" fill="url(#scrim)"/>`;
  o += eyebrowSvg(F, eyebrow, PAD, top);
  o += ruleSvg(PAD, top + 30, C.accent, 44, 3);
  o += shift(hl.svg, 0, top + 56);
  if (sub) o += shift(subH.svg, 0, top + 56 + hl.height + 26);
  return { name: 'hero', png: await compose(W, H, base, o), height: H };
}

// 타이포 컷(단색 배경) — 중앙정렬 헤드라인 + 항목 리스트(헤어라인 구분)
async function cutList(F, { theme, eyebrow, headline, items, numbered }) {
  const dark = theme === 'dark';
  const bg = dark ? C.ink : (theme === 'cream' ? C.cream : C.white);
  const fg = dark ? C.white : C.ink;
  const sub = dark ? C.mutedOnDark : C.body;
  const line = dark ? C.lineDark : C.lineCream;
  const eb = eyebrow ? 1 : 0;
  let y = 104;
  let o = '';
  if (eyebrow) { o += centerEyebrow(F, eyebrow, y, dark ? C.accent : C.accent); y += 30; }
  o += `<rect x="${(W - 44) / 2}" y="${y}" width="44" height="3" fill="${C.accent}"/>`; y += 34;
  const hb = textBlock(F.black, headline, { x: PAD, y, fontSize: 46, lineHeight: 1.3, fill: fg, maxWidth: CONTENT, align: 'center' });
  o += hb.svg; y += hb.height + 54;

  const innerX = numbered ? PAD : PAD + 20;
  const innerW = numbered ? CONTENT : CONTENT - 40;
  items.forEach((it, i) => {
    if (i) { o += `<rect x="${PAD}" y="${y}" width="${CONTENT}" height="1" fill="${line}"/>`; y += 40; }
    else y += 4;
    if (numbered) {
      const num = String(i + 1).padStart(2, '0');
      o += F.black.getPath(num, { x: PAD, y, fontSize: 30, anchor: 'left top', fill: C.accent });
      const tb = textBlock(F.medium, it, { x: PAD + 78, y: y - 2, fontSize: 31, lineHeight: 1.5, fill: fg, maxWidth: CONTENT - 78 });
      o += tb.svg; y += Math.max(tb.height, 38) + 36;
    } else {
      const tb = textBlock(F.medium, it, { x: innerX, y, fontSize: 31, lineHeight: 1.55, fill: sub, maxWidth: innerW, align: 'center' });
      o += tb.svg; y += tb.height + 36;
    }
  });
  const H = y + 80;
  return { name: numbered ? 'benefits' : 'list', png: await compose(W, H, await solid(bg, H), o), height: H };
}

// 사용/실물 컷: 풀블리드 사진 + 하단 카피(번호+헤드라인+본문). 사진과 글이 한 컷.
async function cutSection(F, { photo, index, headline, body }) {
  const photoH = 940;
  const photo1 = await coverPhoto(photo, W, photoH);
  // 카피 영역(크림)
  let cy = 76;
  let o = '';
  const num = String(index).padStart(2, '0');
  o += F.black.getPath(num, { x: PAD, y: cy, fontSize: 30, anchor: 'left top', fill: C.accent }); cy += 50;
  const hb = textBlock(F.black, headline, { x: PAD, y: cy, fontSize: 44, lineHeight: 1.3, fill: C.ink, maxWidth: CONTENT });
  o += hb.svg; cy += hb.height + 28;
  const bb = textBlock(F.regular, body, { x: PAD, y: cy, fontSize: 30, lineHeight: 1.72, fill: C.body, maxWidth: CONTENT });
  o += bb.svg; cy += bb.height + 80;
  const copyH = cy;
  const H = photoH + copyH;
  const overlay = shift(o, 0, photoH);
  const base = await sharp(await solid(C.cream, H))
    .composite([{ input: photo1, top: 0, left: 0 }]).png().toBuffer();
  return { name: 'section', png: await compose(W, H, base, overlay), height: H };
}

// 제품정보 표
async function cutSpec(F, rows) {
  let y = 104;
  let o = centerEyebrow(F, 'Product Info', y, C.accent); y += 30;
  o += `<rect x="${(W - 44) / 2}" y="${y}" width="44" height="3" fill="${C.accent}"/>`; y += 34;
  const hb = textBlock(F.black, '제품 정보', { x: PAD, y, fontSize: 44, lineHeight: 1.3, fill: C.ink, maxWidth: CONTENT, align: 'center' });
  o += hb.svg; y += hb.height + 44;
  rows.forEach((r) => {
    o += `<rect x="${PAD}" y="${y}" width="${CONTENT}" height="1" fill="${C.lineCream}"/>`; y += 30;
    o += F.medium.getPath(String(r[0]), { x: PAD, y, fontSize: 28, anchor: 'left top', fill: C.body });
    const vw = F.bold.getMetrics(String(r[1]), { fontSize: 28 }).width;
    o += F.bold.getPath(String(r[1]), { x: W - PAD - vw, y, fontSize: 28, anchor: 'left top', fill: C.ink });
    y += 50;
  });
  o += `<rect x="${PAD}" y="${y}" width="${CONTENT}" height="1" fill="${C.lineCream}"/>`;
  const H = y + 90;
  return { name: 'spec', png: await compose(W, H, await solid(C.white, H), o), height: H };
}

// FAQ
async function cutFaq(F, faq) {
  let y = 104;
  let o = centerEyebrow(F, 'FAQ', y, C.accent); y += 30;
  o += `<rect x="${(W - 44) / 2}" y="${y}" width="44" height="3" fill="${C.accent}"/>`; y += 34;
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
  return { name: 'faq', png: await compose(W, H, await solid(C.cream, H), o), height: H };
}

// CTA(다크 + 악센트)
async function cutCta(F, closing) {
  const H = 460;
  let o = `<rect x="${(W - 56) / 2}" y="150" width="56" height="4" fill="${C.accent}"/>`;
  const cb = textBlock(F.bold, closing, { x: PAD, y: 200, fontSize: 38, lineHeight: 1.5, fill: C.white, maxWidth: CONTENT, align: 'center' });
  o += cb.svg;
  return { name: 'cta', png: await compose(W, H, await solid(C.ink, H), o), height: H };
}

// ── 유틸 ─────────────────────────────────────────────────────
function shift(svgPaths, dx, dy) { return `<g transform="translate(${dx},${dy})">${svgPaths}</g>`; }
function centerEyebrow(F, t, y, color) {
  const w = F.bold.getMetrics(String(t).toUpperCase(), { fontSize: EB_SIZE, letterSpacing: EB_LS }).width;
  return F.bold.getPath(String(t).toUpperCase(), { x: (W - w) / 2, y, fontSize: EB_SIZE, letterSpacing: EB_LS, anchor: 'left top', fill: color });
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
  const cuts = [];

  cuts.push(await cutHero(F, { photo: px(0), eyebrow: 'Lumi Select', headline: c.heroHeadline || product.title, sub: c.heroSub }));
  if (Array.isArray(c.concerns) && c.concerns.length)
    cuts.push(await cutList(F, { theme: 'cream', eyebrow: 'Your Concern', headline: '혹시, 이런 고민\n있으셨나요?', items: c.concerns }));
  if (Array.isArray(c.benefits) && c.benefits.length)
    cuts.push(await cutList(F, { theme: 'white', eyebrow: 'Why It Matters', headline: '이런 점이 다릅니다', items: c.benefits, numbered: true }));
  (Array.isArray(c.sections) ? c.sections : []).forEach(() => {});
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
