/**
 * Supabase data access for the CryptoFlip backend.
 *
 * Every function takes a connected client that uses the service role key, since
 * all tables have RLS enabled with no policies (the browser cannot touch them).
 *
 * Operations:
 *  - upsertTelegramUser
 *  - findOrCreateWallet
 *  - getOrCreateInviteToken
 *  - creditInvite (via the atomic credit_invite RPC)
 *  - countInviteClaimsForUser
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type TelegramProfile = {
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  photoUrl?: string;
};

export type UserRow = {
  id: string;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
};

export type WalletRow = {
  id: string;
  user_id: string;
  chips: number;
};

/** Create or refresh the Telegram user, returning the canonical row. */
export async function upsertTelegramUser(
  client: SupabaseClient,
  telegramId: number,
  profile: TelegramProfile
): Promise<UserRow> {
  const { data, error } = await client
    .from('users')
    .upsert(
      {
        telegram_id: telegramId,
        username: profile.username ?? null,
        first_name: profile.firstName ?? null,
        last_name: profile.lastName ?? null,
        language_code: profile.languageCode ?? null,
        avatar_url: profile.photoUrl ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'telegram_id' }
    )
    .select('id, telegram_id, username, first_name')
    .single();

  if (error) throw new Error(`upsert user failed: ${error.message}`);
  return data as UserRow;
}

/** Find the wallet for a user, creating it with 0 chips if absent. */
export async function findOrCreateWallet(
  client: SupabaseClient,
  userId: string
): Promise<WalletRow> {
  const existing = await client
    .from('wallets')
    .select('id, user_id, chips')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing.error) throw new Error(`read wallet failed: ${existing.error.message}`);
  if (existing.data) return existing.data as WalletRow;

  const inserted = await client
    .from('wallets')
    .insert({ user_id: userId })
    .select('id, user_id, chips')
    .single();

  if (inserted.error) throw new Error(`create wallet failed: ${inserted.error.message}`);
  return inserted.data as WalletRow;
}

/** Get the user's invite token, creating one on first use. */
export async function getOrCreateInviteToken(
  client: SupabaseClient,
  userId: string
): Promise<string> {
  const existing = await client
    .from('invite_tokens')
    .select('token')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing.error) throw new Error(`read invite token failed: ${existing.error.message}`);
  if (existing.data?.token) return existing.data.token as string;

  // Retry a few times in the unlikely event of a token collision.
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = generateInviteToken();
    const inserted = await client
      .from('invite_tokens')
      .insert({ user_id: userId, token })
      .select('token')
      .single();

    if (!inserted.error) return inserted.data.token as string;

    // 23505 = unique violation; retry with a new token.
    if (inserted.error.code !== '23505') {
      throw new Error(`create invite token failed: ${inserted.error.message}`);
    }

    // The user_id unique index may have been filled by a concurrent request.
    const raced = await client
      .from('invite_tokens')
      .select('token')
      .eq('user_id', userId)
      .maybeSingle();
    if (raced.data?.token) return raced.data.token as string;
  }

  throw new Error('create invite token failed: token collisions exhausted');
}

export type CreditInviteResult = {
  chipsAwarded: number;
  walletChips: number;
  totalClaims: number;
};

/**
 * Credit an inviter for a verified invite.
 *
 * Delegates to the `credit_invite` Postgres function so the ledger insert, the
 * cap check, and the wallet top-up happen in one transaction. Throws with the
 * Postgres error message for expected failures (`invite_reward_exhausted`,
 * `self_invite`).
 */
export async function creditInvite(
  client: SupabaseClient,
  inviterUserId: string,
  invitedUserId: string,
  token: string,
  chipsAwarded: number,
  maxRewards: number
): Promise<CreditInviteResult> {
  const { data, error } = await client.rpc('credit_invite', {
    p_inviter_user_id: inviterUserId,
    p_invited_user_id: invitedUserId,
    p_token: token,
    p_chips: chipsAwarded,
    p_max_rewards: maxRewards,
  });

  if (error) throw new Error(`credit invite failed: ${error.message}`);

  const result = (data || {}) as Record<string, unknown>;
  return {
    chipsAwarded: Number(result.chips_awarded ?? chipsAwarded),
    walletChips: Number(result.wallet_chips ?? 0),
    totalClaims: Number(result.total_claims ?? 0),
  };
}

/** How many invite rewards an inviter has already been credited. */
export async function countInviteClaimsForUser(
  client: SupabaseClient,
  userId: string
): Promise<number> {
  const { count, error } = await client
    .from('invite_claims')
    .select('id', { count: 'exact', head: true })
    .eq('inviter_user_id', userId);

  if (error) throw new Error(`count invite claims failed: ${error.message}`);
  return count ?? 0;
}

/** Find the inviter user id behind an invite token. */
export async function findInviterByToken(
  client: SupabaseClient,
  token: string
): Promise<string | null> {
  const { data, error } = await client
    .from('invite_tokens')
    .select('user_id')
    .eq('token', token)
    .maybeSingle();

  if (error) throw new Error(`lookup invite token failed: ${error.message}`);
  return (data?.user_id as string) ?? null;
}

/** Unambiguous, URL-safe invite token (no 0/O/1/I/l to avoid typos). */
export function generateInviteToken(length = 8): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let token = '';
  for (let i = 0; i < length; i++) {
    token += alphabet[bytes[i] % alphabet.length];
  }
  return token;
}
