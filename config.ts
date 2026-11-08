/**
 * Shared configuration surface for CryptoFlip TMA.
 *
 * This is the single place where frontend and backend agree on:
 *  - the minimal env contract (APP_URL and SUPABASE credentials)
 *  - the verified invite scheme (per-user invite token + deep link shape)
 *
 * Frontend:
 *   - reads this at runtime during app bootstrap
 *   - uses SUPABASE_* only for the future Supabase client bootstrap
 *   - uses TELEGRAM_BOT_USERNAME + INVITE_TOKEN for the user's own invite link
 *
 * Backend (server.js):
 *   - reads the same env contract
 *   - verifies Telegram initData
 *   - creates users / wallets / invite tokens in Supabase
 *   - attributes invite joins via Telegram bot /start?start=invite_<token>
 *
 * This file intentionally does not import or bundle anything. It is a plain
 * module consumed by both the browser bootstrap and the server.
 */

/** Telegram bot username, e.g. "cryptoflipbot". Used for the Mini App / share links. */
export const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'cryptoflipbot';

/**
 * Minimal backend URL used by the Mini App for bootstrap and future shortcuts.
 * In production this should be the deployed Render URL.
 */
export const APP_URL =
  (process.env.APP_URL || '').replace(/\/+$/, '') ||
  (typeof window !== 'undefined' && window.Telegram?.WebApp?.initParams?.url
    ? window.Telegram.WebApp.initParams.url
    : '');

/**
 * Invite token prefix used in Telegram bot start links.
 * Shape: https://t.me/:botUsername?start=invite_<token>
 */
export const INVITE_START_PREFIX = 'invite_';

/**
 * Invite reward constants (verified, server-side attribution path).
 * These mirror the client-side constants so both sides stay consistent.
 */
export const INVITE_REWARD_CHIPS = 1000;
export const MAX_INVITE_REWARDS = 3;

/**
 * Build a Telegram Mini App invite link for a given invite token.
 *
 * This produces the actual link the inviter shares with friends. When a friend
 * opens that link, Telegram opens the bot with the corresponding start parameter,
 * and the backend can attribute the join to the inviter.
 */
export function buildInviteLink(inviteToken) {
  if (!inviteToken) return '';
  const encoded = encodeURIComponent(`${INVITE_START_PREFIX}${inviteToken}`);
  return `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${encoded}`;
}

/**
 * Extract an invite token from a Telegram bot start parameter, if any.
 * Returns null for non-invite parameters or malformed values.
 */
export function parseInviteTokenFromStartParam(startParam) {
  if (!startParam || typeof startParam !== 'string') return null;
  const trimmed = startParam.trim();
  if (!trimmed.startsWith(INVITE_START_PREFIX)) return null;
  const token = trimmed.slice(INVITE_START_PREFIX.length);
  if (!token) return null;
  return token;
}
