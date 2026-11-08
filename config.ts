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

/**
 * Short name of the Mini App as registered with BotFather (/newapp), e.g.
 * "flip". Used to build direct-launch invite links.
 */
export const TELEGRAM_MINIAPP_NAME = (process.env.TELEGRAM_MINIAPP_NAME || '')
  .trim()
  .replace(/^\//, '');

/** Prefix for Telegram bot start parameters that carry an invite. */
export const INVITE_START_PREFIX = 'invite_';

/** Public URL of this deployment, without a trailing slash. */
export const APP_URL = (process.env.APP_URL || '').trim().replace(/\/+$/, '');

/**
 * Build the shareable invite link for a token.
 *
 * With a Mini App registered, the link launches the app directly and Telegram
 * delivers the token to the app as `start_param`:
 *   https://t.me/<bot>/<app>?startapp=invite_<token>
 *
 * Without one, fall back to a bot start link (requires the bot to handle
 * /start and open the Mini App):
 *   https://t.me/<bot>?start=invite_<token>
 *
 * Returns '' when the bot username is not configured.
 */
export function buildInviteLink(inviteToken: string): string {
  if (!inviteToken || !TELEGRAM_BOT_USERNAME) return '';
  const param = `${INVITE_START_PREFIX}${encodeURIComponent(inviteToken)}`;
  if (TELEGRAM_MINIAPP_NAME) {
    return `https://t.me/${TELEGRAM_BOT_USERNAME}/${TELEGRAM_MINIAPP_NAME}?startapp=${param}`;
  }
  return `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${param}`;
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
