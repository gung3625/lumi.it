Fully redesign index.html, beta.html, subscribe.html with Apple-style design.

You MAY rewrite the entire HTML/CSS structure of each file.
You MUST preserve ALL existing JavaScript functions and API calls exactly as-is.
Copy every script tag and its contents verbatim into the new file.

DESIGN SYSTEM:
- Dark #000000 and light #f5f5f7 alternating sections (Apple style)
- Accent: #C8507A rose pink
- Font: Pretendard. No emoji. Lucide icons only.
- Nav: sticky glass rgba(0,0,0,0.8) backdrop-filter blur(20px) saturate(180%)
- CTA buttons: border-radius 980px pill
- Headlines: Pretendard weight 900, clamp(3rem,8vw,5.5rem)
- Generous whitespace, minimal borders, Apple cinematic rhythm

CRITICAL: Every single <script> block must be copied 100% unchanged into the new file. Do not remove or modify any JS logic, fetch calls, or event listeners.

After each file: git add -A && git commit -m "design: [filename] full Apple redesign"
After all 3 files: git push origin main

Start with index.html now.
