/**
 * Supabase bootstrap for the CryptoFlip backend.
 *
 * Right now this module exposes one thing: a validated Supabase configuration
 * shape. The server uses this to confirm the environment is coherent before it
 * starts serving requests.
 *
 * The actual Supabase client creation is left to the Node entrypoint for now,
 * because the JS client is loaded differently in the backend than in the browser.
 * When we add Supabase on the frontend, we will add a separate browser bootstrap
 * here rather than mixing environments.
 */

export type SupabaseConfig = {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
};

export function validateSupabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || typeof url !== 'string') {
    throw new Error('SUPABASE_URL is required');
  }
  if (!anonKey || typeof anonKey !== 'string') {
    throw new Error('SUPABASE_ANON_KEY is required');
  }

  return {
    url: url.trim(),
    anonKey: anonKey.trim(),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
      ? process.env.SUPABASE_SERVICE_ROLE_KEY.trim()
      : undefined,
  };
}

export function isSupabaseConfigured() {
  try {
    validateSupabaseConfig();
    return true;
  } catch {
    return false;
  }
}
