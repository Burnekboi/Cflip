/**
 * Telegram Mini App initData verification helpers.
 *
 * Stateless auth model:
 *  - The Mini App sends Telegram initData in a header or body to the backend.
 *  - The backend verifies it against Telegram's digest, using the bot token.
 *  - If valid, the backend treats the verified Telegram user id as the user
 *    identity and records/loads the profile from Supabase.
 *
 * This module does not depend on Supabase. It is a pure verification layer so
 * the auth contract can be reused by the webhook, the Mini App API routes, and
 * future bot handlers.
 */

export type TelegramInitData = {
  auth_date: string;
  hash: string;
  [key: string]: string | undefined;
};

export type VerifiedTelegramUser = {
  telegramId: number;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  photoUrl?: string;
  authDate: number;
  initDataRaw?: string;
};

/**
 * Verify Telegram WebApp initData and return a verified user payload.
 *
 * Telegram's WebApp initData is signed with the bot token. Verification is done
 * by recomputing the SHA256 digest of the initData params (excluding the hash
 * key) and comparing it to the `hash` value with the bot token as the secret.
 *
 * References:
 *  - https://core.telegram.org/bots/webapps#validating-received-data
 */
export async function verifyTelegramInitData(
  initData: string | TelegramInitData,
  botToken: string
): Promise<VerifiedTelegramUser> {
  const raw =
    typeof initData === 'string'
      ? initData
      : Object.entries(initData)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n');

  const params = parseQueryString(raw);
  const hash = params.get('hash');
  if (!hash) {
    throw new Error('Missing initData hash');
  }

  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}={value}`)
    .join('\n');

  const cryptoApi = createCryptoApi();
  const secretHash = await cryptoApi.sha256(`WebAppData${botToken}`);
  const computedHash = await cryptoApi.hmacSha256(secretHash, checkString);

  if (computedHash !== hash) {
    throw new Error('Invalid initData hash');
  }

  const authDate = parseInt(params.get('auth_date') || '', 10);
  if (Number.isNaN(authDate)) {
    throw new Error('Missing auth_date');
  }

  const userRaw = params.get('user');
  if (!userRaw) {
    throw new Error('Missing user object');
  }

  const user = parseQueryString(userRaw);
  const telegramId = parseInt(user.get('id') || '', 10);
  if (Number.isNaN(telegramId)) {
    throw new Error('Missing user.id');
  }

  return {
    telegramId,
    firstName: user.get('first_name') || '',
    lastName: user.get('last_name') || undefined,
    username: user.get('username') || undefined,
    languageCode: user.get('language_code') || undefined,
    photoUrl: user.get('photo_url') || undefined,
    authDate,
    initDataRaw: typeof initData === 'string' ? initData : undefined,
  };
}

function parseQueryString(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

type CryptoApi = {
  sha256(message: string): Promise<string>;
  hmacSha256(secret: string, message: string): Promise<string>;
};

function createCryptoApi(): CryptoApi {
  // Prefer Web Crypto when available (browser + recent Node).
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    return {
      sha256: async (message: string) => {
        const encoder = new TextEncoder();
        const data = encoder.encode(message);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        return arrayBufferToHex(hashBuffer);
      },
      hmacSha256: async (secret: string, message: string) => {
        const keyMaterial = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );
        const signature = await crypto.subtle.sign(
          'HMAC',
          keyMaterial,
          new TextEncoder().encode(message)
        );
        return arrayBufferToHex(signature);
      },
    };
  }

  // Fallback for environments without Web Crypto: use Node's crypto module.
  // This import is conditional so the browser bundle can omit it.
  try {
    const nodeCrypto = require('node:crypto');
    return {
      sha256: (message: string) => {
        return nodeCrypto.createHash('sha256').update(message, 'utf8').digest('hex');
      },
      hmacSha256: (secret: string, message: string) => {
        return nodeCrypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
      },
    };
  } catch {
    throw new Error('No SHA-256 implementation available');
  }
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
