/**
 * Supabase schema for the CryptoFlip Telegram Mini App backend.
 *
 * Identity model
 * --------------
 * Users are identified by Telegram, not by a separate login.
 * Telegram initData is verified server-side, and the verified Telegram user id
 * becomes the canonical identity key. That keeps the app stateless from the
 * client perspective while still giving us a server-side identity in Supabase.
 *
 * Wallet model
 * ------------
 * Each Telegram user gets one wallet row. Chips are server-side truth; the
 * client keeps its own UI copy in localStorage, but the authoritative balance
 * comes from the backend once the verified backend is live.
 *
 * Invite model
 * ------------
 * Each user has one invite token. The token is baked into their invite link:
 *
 *   https://t.me/:botUsername?start=invite_<token>
 *
 * When a new user first arrives through that start link, the backend credits the
 * inviter and records the claim. Credits are capped at MAX_INVITE_REWARDS per
 * inviter and are auditable in `invite_claims`.
 *
 * Why a separate invite_claims table
 * -----------------------------------
 * It prevents double-crediting, makes the reward path reviewable, and keeps the
 * invite reward history independent of wallets / stats. This matters once invites
 * are "verified" rather than merely client-side claims.
 */

-- ---------------------------------------------------------------------------
-- 1. Telegram users
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  avatar_url TEXT,
  deep_link_claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_telegram_id_idx ON users(telegram_id);

-- ---------------------------------------------------------------------------
-- 2. Wallets
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  chips BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. Invite tokens
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invite_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS invite_tokens_user_id_unique ON invite_tokens(user_id);

-- ---------------------------------------------------------------------------
-- 4. Invite reward ledger (audit + cap enforcement)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invite_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  chips_awarded BIGINT NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(inviter_user_id, invited_user_id)
);

CREATE INDEX IF NOT EXISTS invite_claims_inviter_idx ON invite_claims(inviter_user_id);

-- ---------------------------------------------------------------------------
-- 5. Account event log (useful for debugging, audit, and future leaderboards)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_events_user_id_idx ON account_events(user_id);
CREATE INDEX IF NOT EXISTS account_events_created_at_idx ON account_events(created_at);
