/**
 * Supabase schema for the CryptoFlip Telegram Mini App backend.
 *
 * Run this once in the Supabase SQL editor (or via the CLI) on a fresh project.
 * It is written to be idempotent so it can be re-run safely.
 *
 * Identity model
 * --------------
 * Users are identified by Telegram, not by a separate login. Telegram initData
 * is verified server-side, and the verified Telegram user id becomes the
 * canonical identity key.
 *
 * Security model
 * --------------
 * Row Level Security is enabled on every table and no policies are granted, so
 * the public anon key can read nothing. Only the backend, which connects with
 * the service role key, can read or write. All game and invite state therefore
 * flows through the API instead of the browser.
 *
 * Invite model
 * ------------
 * Each user gets one invite token, baked into their share link:
 *
 *   https://t.me/<bot>?start=invite_<token>
 *
 * When a new user arrives through that link the backend credits the inviter,
 * capped at MAX_INVITE_REWARDS per inviter, recorded in invite_claims.
 */

-- ---------------------------------------------------------------------------
-- 1. Telegram users
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_telegram_id_idx ON public.users(telegram_id);

-- ---------------------------------------------------------------------------
-- 2. Wallets
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE UNIQUE,
  chips BIGINT NOT NULL DEFAULT 0 CHECK (chips >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. Invite tokens (one per user)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.invite_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE UNIQUE,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 4. Invite reward ledger (audit + double-credit protection)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.invite_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  invited_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  chips_awarded BIGINT NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (inviter_user_id, invited_user_id),
  CHECK (inviter_user_id <> invited_user_id)
);

CREATE INDEX IF NOT EXISTS invite_claims_inviter_idx
  ON public.invite_claims(inviter_user_id);

-- ---------------------------------------------------------------------------
-- 5. Account event log (audit / debugging)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.account_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_events_user_id_idx
  ON public.account_events(user_id);

-- ---------------------------------------------------------------------------
-- 6. Verified invite credit (atomic: ledger row + wallet top-up)
-- ---------------------------------------------------------------------------
--
-- Called by the backend with the service role key. Returns the chip balance
-- after crediting and raises a clear error when the reward is not allowed.

CREATE OR REPLACE FUNCTION public.credit_invite(
  p_inviter_user_id UUID,
  p_invited_user_id UUID,
  p_token TEXT,
  p_chips BIGINT,
  p_max_rewards INT DEFAULT 3
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_claimed INT;
  v_chips BIGINT;
BEGIN
  IF p_inviter_user_id = p_invited_user_id THEN
    RAISE EXCEPTION 'self_invite' USING ERRCODE = '22023';
  END IF;

  IF p_chips <= 0 THEN
    RAISE EXCEPTION 'invalid_chip_amount' USING ERRCODE = '22023';
  END IF;

  -- Serialise concurrent claims for the same inviter.
  PERFORM pg_advisory_xact_lock(hashtext(p_inviter_user_id::text));

  SELECT count(*) INTO v_claimed
  FROM public.invite_claims
  WHERE inviter_user_id = p_inviter_user_id;

  IF v_claimed >= p_max_rewards THEN
    RAISE EXCEPTION 'invite_reward_exhausted' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.invite_claims (
    inviter_user_id, invited_user_id, token, chips_awarded
  )
  VALUES (
    p_inviter_user_id, p_invited_user_id, p_token, p_chips
  );

  INSERT INTO public.wallets (user_id, chips)
  VALUES (p_inviter_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE public.wallets
  SET chips = chips + p_chips,
      updated_at = now()
  WHERE user_id = p_inviter_user_id
  RETURNING chips INTO v_chips;

  RETURN jsonb_build_object(
    'chips_awarded', p_chips,
    'wallet_chips', v_chips,
    'total_claims', v_claimed + 1
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Lock everything down
-- ---------------------------------------------------------------------------
--
-- RLS on with no policies means the anon/public key cannot touch these tables.
-- The backend bypasses RLS by connecting with the service role key.

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.users FROM anon, authenticated;
REVOKE ALL ON public.wallets FROM anon, authenticated;
REVOKE ALL ON public.invite_tokens FROM anon, authenticated;
REVOKE ALL ON public.invite_claims FROM anon, authenticated;
REVOKE ALL ON public.account_events FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.credit_invite(UUID, UUID, TEXT, BIGINT, INT)
  TO service_role;
