/**
 * Supabase configuration for the CryptoFlip backend.
 *
 * Single source of truth for which Supabase env vars the server needs and how
 * they are validated. Keeping it here means the server can fail with a clear
 * message instead of a confusing runtime error deep inside a request handler.
 */

export type SupabaseConfig = {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
};

/**
 * Read and validate the Supabase env contract.
 *
 * The service role key is required, not optional: every table has RLS enabled
 * with no policies, so the anon key intentionally cannot read or write. The
 * backend is the only writer.
 */
export function validateSupabaseConfig(): SupabaseConfig {
  const url = (process.env.SUPABASE_URL || '').trim();
  const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  const missing: string[] = [];
  if (!url) missing.push('SUPABASE_URL');
  if (!anonKey) missing.push('SUPABASE_ANON_KEY');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length > 0) {
    throw new Error(`Missing Supabase env vars: ${missing.join(', ')}`);
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('SUPABASE_URL must start with https://');
  }

  return { url, anonKey, serviceRoleKey };
}

export function isSupabaseConfigured(): boolean {
  try {
    validateSupabaseConfig();
    return true;
  } catch {
    return false;
  }
}
