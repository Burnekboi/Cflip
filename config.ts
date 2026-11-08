/**
 * Shared server configuration for CryptoFlip.
 *
 * Single source of truth for the invite link scheme, used by the backend and
 * mirrored by the Mini App (which just consumes the link the API returns).
 */

/** Bot username without the leading @, e.g. "cryptoflipbot". */
export const TELEGRAM_BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '')
  .trim()
  .replace(/^@/, '');

/** Prefix for Telegram bot start parameters that carry an invite. */
export const INVITE_START_PREFIX = 'invite_';

/** Public URL of this deployment, without a trailing slash. */
export const APP_URL = (process.env.APP_URL || '').trim().replace(/\/+$/, '');

/**
 * Build the shareable invite link for a token:
 *   https://t.me/<bot>?start=invite_<token>
 * Returns '' when the bot username is not configured.
 */
export function buildInviteLink(inviteToken: string): string {
  if (!inviteToken || !TELEGRAM_BOT_USERNAME) return '';
  return `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${INVITE_START_PREFIX}${encodeURIComponent(
    inviteToken
  )}`;
}

/** Extract the invite token from a Telegram start parameter, or null. */
export function parseInviteTokenFromStartParam(
  startParam: string | null | undefined
): string | null {
  if (!startParam) return null;
  const trimmed = startParam.trim();
  if (!trimmed.startsWith(INVITE_START_PREFIX)) return null;
  const token = trimmed.slice(INVITE_START_PREFIX.length);
  return token.length > 0 ? token : null;
}
