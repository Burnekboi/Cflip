/**
 * Verified invite attribution.
 *
 * Turns a Telegram start parameter ("invite_<token>") into an inviter credit.
 * The backend is the only place this runs, because only the backend can trust
 * who the invited user is (verified initData) and enforce the reward cap.
 *
 * Rules:
 *  - the invited user must not be the inviter
 *  - each inviter earns at most MAX_INVITE_REWARDS credits
 *  - an inviter is credited at most once per invited user
 *  - the reward is INVITE_REWARD_CHIPS per credited invite
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  creditInvite,
  findInviterByToken,
  findOrCreateWallet,
  upsertTelegramUser,
  countInviteClaimsForUser,
  type TelegramProfile,
} from './supabase-server.js';
import { parseInviteTokenFromStartParam } from '../config.js';

export const INVITE_REWARD_CHIPS = 1000;
export const MAX_INVITE_REWARDS = 3;

export type InviteAttributionOutcome =
  | { credited: true; chipsAwarded: number; remaining: number }
  | {
      credited: false;
      reason:
        | 'no_start_param'
        | 'self_invite'
        | 'inviter_not_found'
        | 'already_credited'
        | 'reward_exhausted'
        | 'failed';
    };

export type InviteAttributionInput = {
  /** Verified Telegram id of the user who opened the link. */
  invitedTelegramId: number;
  /** Telegram start parameter, e.g. "invite_ABC23XYZ". */
  startParam: string | null | undefined;
  /** Profile of the invited user, from verified initData. */
  invitedProfile: TelegramProfile;
};

export async function attributeInviteVisit(
  client: SupabaseClient,
  input: InviteAttributionInput
): Promise<InviteAttributionOutcome> {
  const token = parseInviteTokenFromStartParam(input.startParam ?? null);
  if (!token) return { credited: false, reason: 'no_start_param' };

  try {
    const inviterUserId = await findInviterByToken(client, token);
    if (!inviterUserId) return { credited: false, reason: 'inviter_not_found' };

    const invited = await upsertTelegramUser(
      client,
      input.invitedTelegramId,
      input.invitedProfile
    );

    if (invited.id === inviterUserId) {
      return { credited: false, reason: 'self_invite' };
    }

    // Wallet exists for the invited user so their balance is ready.
    await findOrCreateWallet(client, invited.id);

    const alreadyClaimed = await countInviteClaimsForUser(client, inviterUserId);
    if (alreadyClaimed >= MAX_INVITE_REWARDS) {
      return { credited: false, reason: 'reward_exhausted' };
    }

    const result = await creditInvite(
      client,
      inviterUserId,
      invited.id,
      token,
      INVITE_REWARD_CHIPS,
      MAX_INVITE_REWARDS
    );

    return {
      credited: true,
      chipsAwarded: result.chipsAwarded,
      remaining: Math.max(0, MAX_INVITE_REWARDS - result.totalClaims),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Postgres raises these codes for expected, non-exceptional outcomes.
    if (message.includes('invite_reward_exhausted')) {
      return { credited: false, reason: 'reward_exhausted' };
    }
    if (message.includes('self_invite')) {
      return { credited: false, reason: 'self_invite' };
    }
    if (message.includes('duplicate key value')) {
      return { credited: false, reason: 'already_credited' };
    }

    console.error('[invite] attribution failed:', error);
    return { credited: false, reason: 'failed' };
  }
}
