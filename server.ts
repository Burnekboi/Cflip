/**
 * CryptoFlip TMA backend.
 *
 * Runs two ways from this one file:
 *  - a long-lived Node server (`npm run server`) on Render or locally
 *  - a Vercel Function: Vercel auto-detects a root `server.ts` that default
 *    exports an Express app, so the same routes are served at /api/* there
 *    (express.static() is ignored; the Vite build in public/ is served by the CDN)
 *
 * Responsibilities:
 *  - serve the built Mini App from public/
 *  - verify Telegram WebApp initData on every API call
 *  - create/update the Telegram user and wallet in Supabase
 *  - return the user's own invite link and invite-reward status
 *  - attribute a verified invite when the Mini App reports a start param
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN         bot token from BotFather
 *   TELEGRAM_BOT_USERNAME      bot username without the @
 *   SUPABASE_URL               https://<ref>.supabase.co
 *   SUPABASE_ANON_KEY          project anon key
 *   SUPABASE_SERVICE_ROLE_KEY  project service role key (required, RLS bypass)
 *   APP_URL                    public URL of this deployment
 *   PORT                       port for a standalone run (not used on Vercel)
 */

import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { validateSupabaseConfig, type SupabaseConfig } from './supabase/index.js';
import { verifyTelegramInitData } from './lib/telegram-auth.js';
import {
  upsertTelegramUser,
  findOrCreateWallet,
  getOrCreateInviteToken,
  countInviteClaimsForUser,
} from './lib/supabase-server.js';
import {
  attributeInviteVisit,
  MAX_INVITE_REWARDS,
} from './lib/invite-service.js';
import { buildInviteLink, TELEGRAM_BOT_USERNAME } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The Vite build writes here. Vercel serves this directory from its CDN and
// ignores express.static(), so it only matters for a standalone run.
const staticDir = path.resolve(__dirname, 'public');
const indexHtmlPath = path.join(staticDir, 'index.html');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();

let supabaseConfig: SupabaseConfig | null = null;
let configError: string | null = null;

try {
  supabaseConfig = validateSupabaseConfig();
} catch (error) {
  configError = error instanceof Error ? error.message : String(error);
}

if (!botToken) {
  console.warn('[server] TELEGRAM_BOT_TOKEN is not set; /api/me will return 503.');
}
if (configError) {
  console.warn(`[server] Supabase not configured: ${configError}`);
}
if (!fs.existsSync(indexHtmlPath)) {
  console.warn(`[server] ${indexHtmlPath} not found; run "npm run build" to serve the app.`);
}
let supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (!supabaseConfig) {
    throw new Error(configError || 'Supabase is not configured');
  }
  if (!supabase) {
    supabase = createClient(supabaseConfig.url, supabaseConfig.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabase;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

/** Pull and verify initData, or null when the request is not authenticated. */
function readVerifiedUser(req: express.Request) {
  const header = req.header('x-telegram-init-data');
  if (!header || !botToken) return null;
  try {
    return verifyTelegramInitData(header, botToken);
  } catch (error) {
    console.warn('[auth] initData rejected:', error instanceof Error ? error.message : error);
    return null;
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasBotToken: Boolean(botToken),
    hasSupabase: Boolean(supabaseConfig),
    hasBuild: fs.existsSync(indexHtmlPath),
  });
});

/**
 * Current user + invite state.
 *
 * Pass the Telegram start param as ?start=invite_<token> on the first open; the
 * invite is attributed once and re-sending it is harmless.
 */
app.get('/api/me', async (req, res) => {
  const user = readVerifiedUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing initData' });
  }

  let client: SupabaseClient;
  try {
    client = getSupabase();
  } catch (error) {
    return res.status(503).json({ ok: false, error: 'Database is not configured' });
  }

  const profile = {
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    languageCode: user.languageCode,
    photoUrl: user.photoUrl,
  };

  try {
    const startParam = typeof req.query.start === 'string' ? req.query.start : null;

    // Attribute before reading state so a first-time invitee sees fresh counts.
    let inviteResult: Awaited<ReturnType<typeof attributeInviteVisit>> | null = null;
    if (startParam) {
      inviteResult = await attributeInviteVisit(client, {
        invitedTelegramId: user.telegramId,
        startParam,
        invitedProfile: profile,
      });
    }

    const row = await upsertTelegramUser(client, user.telegramId, profile);
    const wallet = await findOrCreateWallet(client, row.id);
    const inviteToken = await getOrCreateInviteToken(client, row.id);
    const claimed = await countInviteClaimsForUser(client, row.id);

    return res.json({
      ok: true,
      user: {
        telegramId: user.telegramId,
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
      },
      wallet: { chips: wallet.chips },
      invite: {
        token: inviteToken,
        link: buildInviteLink(inviteToken),
        claimed,
        remaining: Math.max(0, MAX_INVITE_REWARDS - claimed),
      },
      attributed: inviteResult,
    });
  } catch (error) {
    console.error('[api/me] failed:', error);
    return res.status(500).json({ ok: false, error: 'Request failed' });
  }
});

// ---------------------------------------------------------------------------
// Static Mini App + SPA fallback (never shadows /api routes)
// ---------------------------------------------------------------------------

app.use(
  express.static(staticDir, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (!fs.existsSync(indexHtmlPath)) {
    return res
      .status(503)
      .type('text/plain')
      .send('Mini App build not found. Run "npm run build".');
  }
  res.setHeader('Cache-Control', 'no-cache');
  return res.sendFile(indexHtmlPath);
});

app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// On Vercel the platform invokes the exported app and owns the socket, so only
// bind a port for a standalone run.
const isServerless = Boolean(process.env.VERCEL);

export default app;

if (!isServerless) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';

  app.listen(PORT, HOST, () => {
    console.log(`[server] listening on http://${HOST}:${PORT}`);
    console.log(`[server] bot username: ${TELEGRAM_BOT_USERNAME || '(not set)'}`);
    console.log(
      `[server] supabase: ${supabaseConfig ? supabaseConfig.url : '(not configured)'}`
    );
  });
}
