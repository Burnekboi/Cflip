/**
 * Verified invite flow service for the CryptoFlip backend.
 *
 * This is the business logic layer for the invite referral reward.
 * It sits between Telegram-linked auth and Supabase so the API routes stay thin
 * and the reward rules live in one place.
 *
 * Responsibilities
 * ----------------
 *  - Turn the invite token from a Telegram bot start link into an inviter
 *    identity and credit that inviter when a new user arrives through the link.
 *  - Enforce the invite reward cap server-side; the client may show UI, but the
 *    real credit decision is made here.
 *  - Protect against double-crediting by recording each invite pair in
 *    `invite_claims`.
 *
 * Assumptions
 * -----------
 *  - The Mini App invite link uses the Telegram bot start parameter shape:
 *      https://t.me/:botUsername?start=invite_<token>
 *  - The inviter is identified by their Supabase user id; the invited user is
 *    also identified by Telegram and has a Supabase user row (created or found
 *    on first load).
 */

import type { ServerSupabase } from './supabase-server.js';
import {
  getOrCreateInviteToken,
  findOrCreateWallet,
  creditInvite,
  countInviteClaimsForUser,
} from './supabase-server.js';
import { parseInviteTokenFromStartParam } from '../config.js';

export type InviteCreditResult =
  | { credited: true; inviterUserId: string; chipsAwarded: number }
  | { credited: false; reason: 'already_credited' | 'inviter_not_found' | 'inviter_reward_exhausted' | 'invalid_token' };

export type InviteAttributionInput = {
  /** Verified Telegram user id of the person opening the link. */
  invitedTelegramId: number;
  /** Telegram start parameter value, e.g. "invite_ABC123". */
  startParam: string | null;
  /** Optional profile fields for the invited user. */
  invitedProfile?: {
    username?: string;
    firstName?: string;
    lastName?: string;
    languageCode?: string;
    photoUrl?: string;
  };
};

const INVITE_REWARD_CHIPS = 1000;
const MAX_INVITE_REWARDS = 3;

export async function attributeInviteVisit(
  db: ServerSupabase,
  input: InviteAttributionInput
): Promise<InviteCreditResult> {
  const token = parseInviteTokenFromStartParam(input.startParam);
  if (!token) {
    return { credited: false, reason: 'invalid_token' };
  }

  // Find the inviter by invite token.
  const inviter = await findInviterByToken(db, token);
  if (!inviter) {
    return { credited: false, reason: 'inviter_not_found' };
  }

  // Ensure the invited user exists.
  const invited = await upsertTelegramUser(db, input.invitedTelegramId, input.invitedProfile ?? {});
  await findOrCreateWallet(db, invited.id);

  const claims = await countInviteClaimsForUser(db, inviter.id);
  if (claims >= MAX_INVITE_REWARDS) {
    return { credited: false, reason: 'inviter_reward_exhausted' };
  }

  const { error } = await db.client
    .from('invite_claims')
    .select('id')
    .eq('inviter_user_id', inviter.id)
    .eq('invited_user_id', invited.id)
    .maybeSingle();

  if (!error && error === null && (error as unknown as { id?: string } | null)?.id) {
    return { credited: false, reason: 'already_credited' };
  }

  const credit = await creditInvite(db, inviter.id, invited.id, token, INVITE_REWARD_CHIPS);

  return {
    credited: true,
    inviterUserId: inviter.id,
    chipsAwarded: credit.chipsAwarded,
  };
}

async function findInviterByToken(db: ServerSupabase, token: string) {
  const { data, error } = await db.client
    .from('invite_tokens')
    .select('user_id')
    .eq('token', token)
    .maybeSingle();

  if (error || !data) return null;
  return data.user_id as string;
}

async function upsertTelegramUser(
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

  return data as { id: string };
}
