<!-- Parent: ../../AGENTS.md -->
<!-- Generated: 2026-04-16 -->

# Netlify Functions (Backend API)

## Purpose
Serverless backend for lumi.it.kr -- an Instagram marketing SaaS for Korean small businesses. All functions run on Netlify Functions, use Netlify Blobs for persistence, and expose REST endpoints via `/api/*` redirects in `netlify.toml`. The service handles user auth, AI caption generation (OpenAI), Instagram Graph API posting, scheduled publishing, payment (PortOne/Toss), trend data collection, and KakaoTalk/email notifications.

## Key Files by Category

### Auth
| File | Endpoint | Description |
|------|----------|-------------|
| `register.js` | POST `/api/register` | User registration with pbkdf2 password hashing |
| `login.js` | POST `/api/login` | User login with password verification, returns Bearer token |
| `find-id.js` | POST `/api/find-id` | Find user ID (email) by phone, rate-limited (5/10min per IP) |
| `reset-password.js` | POST `/api/reset-password` | Password reset with crypto hash |
| `send-otp.js` | POST `/api/send-otp` | Send OTP code via Resend email |
| `verify-otp.js` | POST `/api/verify-otp` | Verify OTP code, rate-limited (10/10min per IP) |

### Caption/Post
| File | Endpoint | Description |
|------|----------|-------------|
| `demo-caption.js` | POST `/api/demo-caption` | Generate demo caption (no auth, public landing page) |
| `welcome-caption.js` | POST `/api/welcome-caption` | Generate welcome caption for new users |
| `regenerate-caption.js` | POST `/api/regenerate-caption` | Regenerate caption with OpenAI, respects plan limits |
| `edit-caption.js` | POST `/api/edit-caption` | Edit existing caption text |
| `save-caption.js` | POST `/api/save-caption` | Save caption to Blobs |
| `select-caption.js` | POST `/api/select-caption` | Select a caption variant for posting |
| `get-caption-history.js` | POST `/api/get-caption-history` | Retrieve user's caption history |
| `count-post.js` | POST `/api/count-post` | Count user's posts (plan usage tracking) |
| `tone-feedback.js` | POST `/api/tone-feedback` | Save tone like/dislike feedback for AI learning |
| `feedback.js` | POST `/api/feedback` | General user feedback submission |

### Instagram
| File | Endpoint | Description |
|------|----------|-------------|
| `ig-oauth.js` | GET `/api/ig-oauth` | Instagram OAuth callback (code exchange for access token) |
| `save-ig-token.js` | POST `/api/save-ig-token` | Save IG access token to Blobs (LUMI_SECRET auth) |
| `disconnect-ig.js` | POST `/api/disconnect-ig` | Disconnect Instagram account |
| `meta-webhook.js` | POST `/api/meta-webhook` | Meta webhook receiver (comment auto-reply, DM) |
| `save-auto-reply.js` | POST `/api/save-auto-reply` | Save auto-reply settings for IG comments/DMs |
| `process-and-post-background.js` | Background | Process image + generate caption + post to Instagram |
| `select-and-post-background.js` | Background | Select caption variant and post to Instagram |
| `serve-image.js` | GET `/api/serve-image?key=` | Serve temporary image from Blobs (no auth, key prefix check) |

### Scheduling
| File | Endpoint | Description |
|------|----------|-------------|
| `reserve.js` | POST `/api/reserve` | Create a scheduled post reservation (multipart with image) |
| `save-reservation.js` | POST `/api/save-reservation` | Save reservation details to Blobs |
| `get-reservation.js` | GET `/api/get-reservation` | Get user's pending reservations |
| `cancel-reservation.js` | POST `/api/cancel-reservation` | Cancel a scheduled reservation |
| `scheduler.js` | Scheduled | Cron: process due reservations and trigger posting |
| `send-daily-schedule.js` | Scheduled | Cron: send daily schedule KakaoTalk notification |
| `relay-list.js` | GET `/api/relay-list` | List user's relay (queue) items |

### User/Plan
| File | Endpoint | Description |
|------|----------|-------------|
| `check-plan.js` | POST `/api/check-plan` | Check user's current plan and usage limits |
| `check-expiry.js` | Scheduled | Cron: send plan expiry reminders (D-7, D-3, D-0, D+1) via Resend |
| `cancel-subscription.js` | POST `/api/cancel-subscription` | Cancel paid subscription |
| `unsubscribe-retention.js` | GET `/api/unsubscribe-retention` | Retention page for unsubscribe flow (returns HTML) |
| `update-profile.js` | POST `/api/update-profile` | Update user profile (business type, etc.) |
| `payment-prepare.js` | POST `/api/payment-prepare` | Prepare payment order (PortOne v2 + Toss) |
| `payment-confirm.js` | POST `/api/payment-confirm` | Verify and confirm payment server-side |

### Link Page
| File | Endpoint | Description |
|------|----------|-------------|
| `get-link-page.js` | GET `/api/get-link-page?id=` | Public: get link-in-bio page data by IG handle |
| `update-link-page.js` | POST `/api/update-link-page` | Save/update link-in-bio page (auth required) |

### Calendar
| File | Endpoint | Description |
|------|----------|-------------|
| `generate-calendar.js` | POST `/api/generate-calendar` | AI-generate monthly content calendar (OpenAI + trends) |
| `get-calendar.js` | GET `/api/get-calendar` | Retrieve saved calendar data |

### Trends/Data
| File | Endpoint | Description |
|------|----------|-------------|
| `get-trends.js` | POST `/api/get-trends` | Get trending hashtags by business category |
| `update-trends.js` | POST `/api/update-trends` | Update trend data in Blobs (180-day cleanup) |
| `scheduled-trends.js` | Scheduled | Cron: fetch Naver trends + update Blobs |
| `get-best-time.js` | GET `/api/get-best-time` | Get optimal posting times by business type |
| `get-weather-kma.js` | GET `/api/get-weather-kma` | Get KMA weather data (lat/lon to grid conversion) |
| `get-air-quality.js` | GET `/api/get-air-quality` | Get air quality data by region (AirKorea API) |
| `get-festival.js` | GET `/api/get-festival` | Get nearby festivals/events data |

### Notifications
| File | Endpoint | Description |
|------|----------|-------------|
| `send-kakao.js` | POST `/api/send-kakao` | Send KakaoTalk notification via Solapi |
| `send-notifications.js` | POST `/api/send-notifications` | Multi-channel notifications (Solapi + Resend) |

### Beta
| File | Endpoint | Description |
|------|----------|-------------|
| `beta-apply.js` | POST `/api/beta-apply` | Beta tester application (saves to Blobs + admin alert) |
| `beta-admin.js` | GET `/api/beta-admin` | Admin panel: list/manage beta applicants (LUMI_SECRET auth) |

## For AI Agents

### Working In This Directory
- All functions use Netlify Blobs with explicit `siteID` + `token` (see `../../.claude/rules/netlify-functions.md`)
- Bearer token auth pattern: `Authorization` header, compare with user token from Blobs or `LUMI_SECRET`
- CORS headers required on every response (`Access-Control-Allow-Origin`)
- `try/catch` + proper `statusCode` in every handler
- Never log personal info (name, phone, email) or tokens (see `../../.claude/rules/security.md`)
- API routes via `/api/*` redirect in `netlify.toml`
- Background functions (filename ending in `-background.js`) run up to 15 minutes, no HTTP response
- Scheduled functions use `exports.handler` with `schedule` config in `netlify.toml`
- Always handle `OPTIONS` preflight requests first

### Common Patterns
```js
// Blob store initialization
const store = getStore({
  name: 'store-name',
  consistency: 'strong',
  siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
  token: process.env.NETLIFY_TOKEN,
});

// CORS headers
const CORS = {
  'Access-Control-Allow-Origin': 'https://lumi.it.kr',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// Bearer auth extraction
const authHeader = event.headers['authorization'] || '';
const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

// Rate limiting (IP-based, stored in Blobs 'rate-limit' store)
const ip = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown';

// Admin auth (LUMI_SECRET)
if (token !== process.env.LUMI_SECRET) {
  return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 실패' }) };
}
```
