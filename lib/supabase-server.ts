/**
 * Supabase server-side data access for the CryptoFlip backend.
 *
 * This module wraps the Supabase JS client from the server's perspective. It
 * exposes only the operations the verified-invite backend needs today:
 *
 *  - upsertTelegramUser
 *  - findOrCreateWallet
 *  - getOrCreateInviteToken
 *  - creditInvite
 *
 * The actual Supabase client is created by the server entrypoint because the
 * Supabase JS library import shape depends on the runtime. This module receives
 * the client as an argument and stays environment-agnostic.
 *
 * Schema notes
 * ------------
 * See supabase/schema.sql for the table definitions these functions rely on.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type ServerSupabase = {
  client: SupabaseClient;
  config: {
    url: string;
    anonKey: string;
    serviceRoleKey?: string;
  };
};

/**
 * Upsert the Telegram user profile from verified initData.
 * Returns the created/updated user row.
 */
export async function upsertTelegramUser(
  db: ServerSupabase,
  telegramId: number,
  profile: {
    username?: string;
    firstName?: string;
    lastName?: string;
    languageCode?: string;
    photoUrl?: string;
  }
) {
  const { data, error } = await db.client
    .from('users')
    .upsert(
      {
        telegram_id: telegramId,
        username: profile.username ?? null,
        first_name: profile.firstName ?? null,
        last_name: profile.lastName ?? null,
        language_code: profile.languageCode ?? null,
        avatar_url: profile.photoUrl ?? null,
      },
      { onConflict: 'telegram_id', returning: 'representation' }
    )
    .select()
    .single();

  if (error) {
    throw new Error(`Supabase upsert user failed: ${error.message}`);
  }

  return data as {
    id: string;
    telegram_id: number;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    created_at: string;
  };
}

/**
 * Find or create the wallet for a user.
 * Returns the wallet row.
 */
export async function findOrCreateWallet(
  db: ServerSupabase,
  userId: string
) {
  const { data, error } = await db.client
    .from('wallets')
    .select()
    .eq('user_id', userId)
    .maybeSingle();

  if (!error && data) {
    return data as { id: string; user_id: string; chips: number };
  }

  const inserted = await db.client
    .from('wallets')
    .insert({ user_id: userId })
    .select()
    .single();

  if (inserted.error) {
    throw new Error(`Supabase create wallet failed: ${inserted.error.message}`);
  }

  return inserted.data as { id: string; user_id: string; chips: number };
}

/**
 * Get or create the invite token for a user.
 * Returns only the token value so the frontend can build the invite link.
 */
export async function getOrCreateInviteToken(db: ServerSupabase, userId: string) {
  const { data, error } = await db.client
    .from('invite_tokens')
    .select('token')
    .eq('user_id', userId)
    .maybeSingle();

  if (!error && data?.token) {
    return data.token;
  }

  const token = generateInviteToken();

  const inserted = await db.client
    .from('invite_tokens')
    .insert({ user_id: userId, token })
    .select('token')
    .single();

  if (inserted.error) {
    throw new Error(`Supabase create invite token failed: ${inserted.error.message}`);
  }

  return inserted.data.token;
}

/**
 * Credit an inviter for a verified invite join.
 *
 * This is the atomic reward path for verified invites. It is driven server-side
 * because the backend is the only place that knows whether the invited user is
 * new and whether the inviter has remaining rewards.
 *
 * Returns the credit record and the new wallet chip count.
 */
export async function creditInvite(
  db: ServerSupabase,
  inviterUserId: string,
  invitedUserId: string,
  token: string,
  chipsAwarded: number
) {
  const { error } = await db.client
    .from('invite_claims')
    .insert({
      inviter_user_id: inviterUserId,
      invited_user_id: invitedUserId,
      token,
      chips_awarded: chipsAwarded,
    })
    .select()
    .single();

  if (error) {
    const match =
      error.message?.includes('duplicate') ||
      error.code === '23505'
        ? 'Invite reward already credited for this pair'
        : error.message;
    throw new Error(`Supabase create invite claim failed: ${match}`);
  }

  // Add chips to the inviter's wallet.
  const { error: updateError } = await db.client
    .from('wallets')
    .update({
      chips: db.client.sql`chips + ${chipsAwarded}`,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', inviterUserId)
    .select('chips')
    .single();

  if (updateError) {
    throw new Error(`Supabase credit invite chips failed: ${updateError.message}`);
  }

  return {
    inviterUserId,
    invitedUserId,
    token,
    chipsAwarded,
  };
}

/**
 * Generate a deterministic-looking, URL-safe invite token.
 *
 * For now this is a random token. If you later want a friendlier "username"
 * style link, this is the one place to change.
 */
export function generateInviteToken(): string {
  const chars =
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abdehkmnprtw';
  const length = 8;
  let token = '';
  const randomValues = new Uint8Array(length);

  // Try the Web Crypto API first. On Node that is available since recent
  // versions; if it is missing we fall back to Math.random here because the
  // backend is the only place that creates tokens.
  try {
    globalThis.crypto.getRandomValues(randomValues);
  } catch {
    for (let i = 0; i < length; i++) {
      randomValues[i] = Math.floor(Math.random() * 256);
    }
  }

  for (let i = 0; i < length; i++) {
    token += chars[randomValues[i] % chars.length];
  }

  return token;
}

/**
 * Count how many invite rewards an inviter has already credited.
 */
export async function countInviteClaimsForUser(
  db: ServerSupabase,
  userId: string
): Promise<number> {
  const { count, error } = await db.client
    .from('invite_claims')
    .select('*', { count: 'exact', head: true })
    .eq('inviter_user_id', userId);

  if (error) {
    throw new Error(`Supabase count invite claims failed: ${error.message}`);
  }

  return (count as number) || 0;
}
