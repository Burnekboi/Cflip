# Deploy CryptoFlip to Vercel

The Mini App is a static single-page app (`index.html`) built by Vite into `public/`.
An optional Express function (`server.ts`) powers the Telegram-verified invite API at
`/api/me`. The game itself is fully client-side and works even if the API is not
configured.

## How the build works

| Step | Command / path |
| --- | --- |
| Install | `npm install` |
| Build | `npm run build` → writes `public/index.html` |
| Static output | `public/` (served by the Vercel CDN) |
| API function | `server.ts` (auto-detected by the Express preset) |
| Local dev | `npm run dev` (Vite on port 3000) |

`public/` is generated and git-ignored — never commit it.

## Option 1 — Deploy from GitHub (recommended)

1. Push this repo to GitHub (`origin` is already set to
   `https://github.com/Burnekboi/Cflip.git`).
2. Open <https://vercel.com/new> and import the repository.
3. Vercel auto-detects **Express** and reads `vercel.json`. Leave the defaults:
   - Framework Preset: **Express**
   - Build Command: `npm run build`
   - Install Command: `npm install`
   - Root Directory: `.`
4. Add the environment variables below (Project → Settings → Environment Variables).
   They are only required for the invite backend; the game loads without them.
5. Click **Deploy**.

After the first deployment, set `APP_URL` to the assigned domain (for example
`https://cflip.vercel.app`) and redeploy so invite links use the public URL.

### Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | for API | BotFather token, verifies `initData` |
| `TELEGRAM_BOT_USERNAME` | for invites | Bot username without `@` |
| `TELEGRAM_MINIAPP_NAME` | optional | Short name from BotFather `/newapp` |
| `SUPABASE_URL` | for API | Supabase project URL |
| `SUPABASE_ANON_KEY` | for API | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | for API | Server-only key (RLS bypass) |
| `APP_URL` | recommended | Public deployment URL, no trailing slash |

Copy `.env.example` for the full descriptions. Never commit `.env`.

## Option 2 — Deploy with the CLI

```bash
npx vercel login          # one-time browser login
npx vercel                # preview deployment
npx vercel --prod         # production deployment
```

Set the same environment variables in the Vercel project settings (or with
`npx vercel env add <NAME>`).

## Connect the Mini App to Telegram

1. In **@BotFather**: `/newapp` (or `/setmenudomain`) and enter the Vercel URL.
2. Open the bot in Telegram and launch the Mini App.
3. Confirm:
   - `GET /api/health` returns `{ "ok": true }`.
   - The invite modal shows a `https://t.me/...` link when the backend is configured.
   - Chips and RocketCrash share the same wallet (localStorage key `cf_tma_chips`).

## Troubleshooting

- **Blank page / 404** — check that `npm run build` produced `public/index.html` and
  that the Express preset is selected (Vercel serves `public/` statically).
- **`/api/me` returns 503** — Supabase env vars are missing; the game still works.
- **Invite link is empty** — set `TELEGRAM_BOT_USERNAME` and `APP_URL`, then redeploy.
- **Telegram shows "invalid domain"** — the Mini App URL must be HTTPS and registered
  with BotFather.
