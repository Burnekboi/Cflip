/**
 * CryptoFlip TMA backend entrypoint (Render-hosted).
 *
 * This server is the verified backend for the Telegram Mini App. It:
 *  - serves the built Mini App static files
 *  - verifies Telegram WebApp initData
 *  - creates/updates Telegram users in Supabase on first sighting
 *  - exposes the inviter's own invite link and bootstrap data
 *  - is ready for a future Telegram bot webhook that will handle the
 *    ?start=invite_<token> attribution flow
 *
 * Environment
 * -----------
 * TELEGRAM_BOT_TOKEN        - BotFather bot token
 * TELEGRAM_BOT_USERNAME     - Bot username, e.g. "cryptoflipbot"
 * SUPABASE_URL              - Supabase project URL
 * SUPABASE_ANON_KEY         - Supabase anon key (server uses Supabase client)
 * SUPABASE_SERVICE_ROLE_KEY - Optional service role key for server-side writes
 * APP_URL                   - Public URL of this deployment
 *
 * If you want the server to also verify initData signatures with the classic
 * Telegram API secret, keep TELEGRAM_BOT_TOKEN set. The current implementation
 * uses the WebApp initData verification path described at:
 *   https://core.telegram.org/bots/webapps#validating-received-data
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

import { validateSupabaseConfig, type SupabaseConfig } from './supabase/index.js';
import { verifyTelegramInitData } from './lib/telegram-auth.js';
import {
  upsertTelegramUser,
  findOrCreateWallet,
  getOrCreateInviteToken,
  countInviteClaimsForUser,
} from './lib/supabase-server.js';
import { buildInviteLink, TELEGRAM_BOT_USERNAME } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ---------------------------------------------------------------------------
// Startup config validation
// ---------------------------------------------------------------------------

const requiredEnvVars: string[] = [];

if (!process.env.TELEGRAM_BOT_TOKEN) {
  requiredEnvVars.push('TELEGRAM_BOT_TOKEN');
}

let supabaseConfig: SupabaseConfig;
try {
  supabaseConfig = validateSupabaseConfig();
} catch (error) {
  requiredEnvVars.push(String(error));
  supabaseConfig = { url: '', anonKey: '' };
}

if (requiredEnvVars.length > 0) {
  console.warn(
    '[server] Missing required env vars. The server will start, but Telegram auth and invite flows will fail until they are set:\n' +
      requiredEnvVars.map((v) => `  - ${v}`).join('\n')
  );
}

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    // Lazy import to keep startup resilient if the package is missing.
    const { createClient } = await import('@supabase/supabase-js');
    supabaseClient = createClient(supabaseConfig.url, supabaseConfig.anonKey, {
      auth: { persistSession: false },
      // Use the service role key only if present so server-side operations can
      // bypass RLS during development/testing. In production you may prefer a
      // tighter setup with RLS enabled and service role only for specific ops.
      serviceRoleKey: supabaseConfig.serviceRoleKey,
    });
  }
  return supabaseClient;
}

// ---------------------------------------------------------------------------
// Static serving
// ---------------------------------------------------------------------------

const distDir = path.resolve(__dirname, 'dist');
const indexHtmlPath = path.resolve(distDir, 'index.html');

function ensureStaticServing() {
  if (!fs.existsSync(distDir)) {
    throw new Error(
      `Cannot start server: dist/ folder not found at ${distDir}. Run "npm run build" first.`
    );
  }
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(
      `Cannot start server: dist/index.html not found at ${indexHtmlPath}. Run "npm run build" first.`
    );
  }
}

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  if (req.path.includes('.') && req.path !== '/') {
    const file = path.resolve(distDir, req.path);
    if (fs.existsSync(file)) {
      return res.sendFile(file);
    }
  }
  try {
    res.sendFile(indexHtmlPath);
  } catch {
    next();
  }
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    env: {
      hasBotToken: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      hasSupabase: Boolean(supabaseConfig.url && supabaseConfig.anonKey),
      hasDist: fs.existsSync(distDir),
    },
  });
});

// ---------------------------------------------------------------------------
// Telegram auth + invite bootstrap
// ---------------------------------------------------------------------------

app.get('/api/me', async (req, res) => {
  const initData = req.headers['x-telegram-init-data'];
  const initDataRaw =
    typeof initData === 'string'
      ? initData
      : Array.isArray(initData)
        ? initData.join('')
        : '';

  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';

  if (!initDataRaw || !botToken) {
    return res.status(400).json({
      ok: false,
      error: 'Missing initData or bot token',
    });
  }

  let verifiedUser;
  try {
    verifiedUser = await verifyTelegramInitData(initDataRaw, botToken);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Telegram initData verification failed';
    return res.status(401).json({ ok: false, error: message });
  }

  const db = getSupabaseClient();

  let user;
  try {
    user = await upsertTelegramUser(db, verifiedUser.telegramId, {
      username: verifiedUser.username,
      firstName: verifiedUser.firstName,
      lastName: verifiedUser.lastName,
      languageCode: verifiedUser.languageCode,
      photoUrl: verifiedUser.photoUrl,
    });
  } catch (error) {
    console.error('[api/me] supabase upsert user failed:', error);
    return res.status(500).json({ ok: false, error: 'Failed to create user profile' });
  }

  let inviteToken: string | null = null;
  try {
    inviteToken = await getOrCreateInviteToken(db, user.id);
  } catch (error) {
    console.error('[api/me] supabase invite token failed:', error);
    return res.status(500).json({ ok: false, error: 'Failed to load invite link' });
  }

  let claimedCount = 0;
  try {
    claimedCount = await countInviteClaimsForUser(db, user.id);
  } catch (error) {
    console.error('[api/me] supabase count claims failed:', error);
  }

  const inviteLink =
    inviteToken ? buildInviteLink(inviteToken) : undefined;

  return res.json({
    ok: true,
    user: {
      telegramId: verifiedUser.telegramId,
      username: verifiedUser.username,
      firstName: verifiedUser.firstName,
      lastName: verifiedUser.lastName,
    },
    invite: {
      token: inviteToken,
      link: inviteLink,
      claimed: claimedCount,
      remaining: Math.max(0, 3 - claimedCount),
    },
  });
});

// ---------------------------------------------------------------------------
// Serve the server bundle info if you later add a build step
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`[server] CryptoFlip backend listening on http://${HOST}:${PORT}`);
  console.log(`[server] APP_URL=${process.env.APP_URL || '(not set)'}`);
  console.log(`[server] TELEGRAM_BOT_USERNAME=${TELEGRAM_BOT_USERNAME}`);
  console.log(`[server] SUPABASE_URL=${supabaseConfig.url ? supabaseConfig.url.replace(/:\/\/[^@]+@/, '://***@') : '(not set)'}`);
});

export {};
