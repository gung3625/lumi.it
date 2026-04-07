Read these files first: design-md/apple/DESIGN.md, design-md/stripe/DESIGN.md, design-md/vercel/DESIGN.md, docs/service.md

Then redesign the lumi website with these rules:

DESIGN SYSTEM:
- Apple style: dark(#000000) and light(#f5f5f7) alternating sections
- Accent color: #C8507A (elegant rose pink)
- Font: Pretendard (already loaded). No emoji. Lucide icons only.
- CTA buttons: border-radius 980px pill shape
- Navigation: backdrop-filter blur(20px) saturate(180%) glass effect

TASK 1 - index.html:
Full screen dark hero (#000), large headline Pretendard weight 900 clamp(3rem,8vw,5.5rem), alternating dark/light sections, glass nav, pill CTAs. Do NOT touch any existing JS logic (demo caption, beta count fetch, etc). Use str_replace only.

TASK 2 - beta.html:
Dark hero, rose pink accent. Keep all existing form JS intact. str_replace only.

TASK 3 - subscribe.html:
Apple style pricing cards (wide spacing, minimal borders). Do NOT touch payment JS. str_replace only.

ABSOLUTE RULES:
- str_replace ONLY. No full file rewrites ever.
- Never touch JS / API / Blobs code.
- No emoji anywhere.
- After each file: git add -A && git commit -m "design: [filename] redesign"
- After all tasks done: git push origin main

Start now.
