/**
 * Telegram Mini App initData verification.
 *
 * Stateless auth model: the Mini App sends `Telegram.WebApp.initData` with each
 * request, the backend verifies the signature with the bot token, and the
 * verified Telegram user id becomes the identity. No sessions, no cookies.
 *
 * Algorithm (https://core.telegram.org/bots/webapps#validating-received-data):
 *   dataCheckString = sorted "key=value" pairs of all fields except `hash`,
 *                     joined by newlines
 *   secretKey       = HMAC_SHA256("WebAppData", botToken)
 *   computedHash    = HMAC_SHA256(secretKey, dataCheckString) as hex
 *   valid           = computedHash === hash
 */

import crypto from 'node:crypto';

export type VerifiedTelegramUser = {
  telegramId: number;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  photoUrl?: string;
  isPremium: boolean;
  authDate: number;
};

export type VerifyOptions = {
  /** Reject initData older than this many seconds. Telegram recommends 24h. */
  maxAgeSeconds?: number;
};

const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  options: VerifyOptions = {}
): VerifiedTelegramUser {
  if (!initData) throw new Error('Missing initData');
  if (!botToken) throw new Error('Missing bot token');

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) throw new Error('Missing initData hash');

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (!timingSafeEqualHex(computedHash, receivedHash)) {
    throw new Error('Invalid initData signature');
  }

  const authDate = Number.parseInt(params.get('auth_date') || '', 10);
  if (!Number.isFinite(authDate)) throw new Error('Missing auth_date');

  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > maxAge) {
    throw new Error('initData expired');
  }

  const userJson = params.get('user');
  if (!userJson) throw new Error('Missing user in initData');

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(userJson) as Record<string, unknown>;
  } catch {
    throw new Error('Malformed user in initData');
  }

  const telegramId = Number(raw.id);
  if (!Number.isFinite(telegramId)) throw new Error('Missing user id');

  return {
    telegramId,
    firstName: typeof raw.first_name === 'string' ? raw.first_name : '',
    lastName: typeof raw.last_name === 'string' ? raw.last_name : undefined,
    username: typeof raw.username === 'string' ? raw.username : undefined,
    languageCode: typeof raw.language_code === 'string' ? raw.language_code : undefined,
    photoUrl: typeof raw.photo_url === 'string' ? raw.photo_url : undefined,
    isPremium: raw.is_premium === true,
    authDate,
  };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
