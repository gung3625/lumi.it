<!-- Generated: 2026-04-16 -->

# lumi.it

## Purpose
lumi.it.kr is an AI-powered Instagram caption automation service for Korean small business owners. It generates captions, hashtags, and handles scheduled posting. The frontend is being migrated from a multi-page vanilla HTML site to a single bento-grid dashboard built with React via CDN (createElement, no JSX). Netlify Functions serve as the shared backend.

## Key Files
| File | Description |
|------|-------------|
| bento-preview.html | New main dashboard (React via CDN, bento grid layout) — primary work target |
| CLAUDE.md | Project instructions and absolute rules for Claude Code |
| netlify.toml | Netlify config, build settings, and /api/* redirect rules |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| netlify/functions/ | Backend API — Netlify Functions with Blobs storage (see netlify/functions/AGENTS.md) |
| assets/ | Images, fonts, and static files |
| docs/ | Documentation (will be cleaned up during migration) |
| .claude/rules/ | Always-loaded rules for Claude Code |
| .claude/skills/ | Domain knowledge referenced by agents and commands |
| .claude/agents/ | Specialized sub-agents with scoped roles and tools |

## For AI Agents

### Working In This Directory
- **bento-preview.html is the primary work target.** All new feature work and UI changes go here.
- Old site files (index.html, beta.html, dashboard.html, etc.) are being replaced and will be deleted when migration completes. Do not invest effort in them.
- netlify/functions/ is the shared backend and persists across the migration.
- Always read a file before editing it. Use the Edit tool with minimal, surgical changes — never do a full rewrite.
- Mobile-first: always verify the mobile (1-column) layout after any changes.
- Deploy command:
  ```bash
  cd /Users/kimhyun/lumi.it && git add -A && git commit -m "msg" && git push origin main && npx -y netlify-cli deploy --prod --site 28d60e0e-6aa4-4b45-b117-0bcc3c4268fc --dir .
  ```

### Common Patterns
- **React via CDN**: Components use `React.createElement()` — no JSX, no build step.
- **Styling**: Inline styles or `<style>` blocks within the HTML file. Apple-style design system (see .claude/rules/frontend.md).
- **Brand color**: `--pink: #C8507A`. Font: Pretendard. Icons: Lucide Icons (no emoji).
- **Dark/Light mode**: Toggle via `localStorage` key `lumi_dark_mode`. Dark cards use `#272729`, alternating dark sections use `#000` / `#111`.
- **API calls**: Frontend fetches `/api/*` endpoints, which Netlify redirects to `/.netlify/functions/*`.
- **Netlify Blobs**: All Blob stores require explicit `siteID` and `token` from environment variables.
