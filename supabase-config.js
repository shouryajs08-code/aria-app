import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Supabase project config
const SUPABASE_URL = 'https://dontnxkzdwkcphhtswrj.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRvbnRueGt6ZHdrY3BoaHRzd3JqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxOTIxNjgsImV4cCI6MjA4OTc2ODE2OH0.S-50ciF-8tnmON8NLE0VlJPL4sbjewhpbQFxfs02xDU';

// Create a Supabase client for browser usage.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

function logPaymentFlowFailure(step, err, extra = {}) {
  const normalized =
    err && typeof err === 'object'
      ? {
          message: err.message ?? String(err),
          code: err.code ?? null,
          details: err.details ?? null,
          hint: err.hint ?? null,
        }
      : { message: String(err) };
  const payload = { step, source: 'supabase', ...normalized, ...extra };
  console.warn('[ARIA payment flow] FAILED:', payload);
  if (typeof window !== 'undefined') {
    window.__ARIA_LAST_PAYMENT_FLOW_ERROR = payload;
  }
  return payload;
}

// Starts Google OAuth sign-in (redirect flow managed by Supabase).
export async function googleOAuthLogin() {
  const redirectTo = window.location.origin + window.location.pathname;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo },
  });
  if (error) throw error;
  return data;
}

// Signs out the current user.
export async function logout() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// Fetches the currently authenticated user (if any).
export async function getCurrentUser() {
  return await supabase.auth.getUser();
}

// Reads the user's plan from the `users` table.
// Returns: 'free' (default) or the stored plan.
export async function getUserPlan(userId) {
  if (!userId) return 'free';
  const { data, error } = await supabase
    .from('users')
    .select('plan')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.warn('Failed to load user plan:', error);
    return 'free';
  }

  const plan = data?.plan;
  if (!plan) return 'free';
  return String(plan).toLowerCase() === 'pro' ? 'pro' : 'free';
}

/**
 * Upload proof to Storage, then one INSERT into `payments`.
 * Works with the anon key only (no login): payments RLS off, storage anon INSERT policy.
 * Optional `opts.email`; if someone is logged in, user_id / email are filled when missing.
 */
export async function submitManualPaymentProofFlow(file, opts = {}) {
  if (typeof window !== 'undefined') {
    window.__ARIA_LAST_PAYMENT_FLOW_ERROR = null;
  }

  if (!file || !(file instanceof File)) {
    return { ok: false, message: 'Please choose a file to upload.', failedStep: 'validate_file' };
  }

  let email = opts.email != null ? String(opts.email).trim() || null : null;
  let userId = null;

  const { data: authData, error: authErr } = await supabase.auth.getUser();
  if (!authErr && authData?.user) {
    userId = authData.user.id;
    if (!email) email = authData.user.email || null;
  }

  const rawExt = (file.name.split('.').pop() || 'bin').slice(0, 12);
  const safeExt = /^[a-z0-9]+$/i.test(rawExt) ? rawExt.toLowerCase() : 'bin';
  const objectPath = `anon/${crypto.randomUUID()}.${safeExt}`;

  const { error: upErr } = await supabase.storage.from('payment-proofs').upload(objectPath, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || 'application/octet-stream',
  });

  if (upErr) {
    logPaymentFlowFailure('storage_upload', upErr, {
      bucket: 'payment-proofs',
      path: objectPath,
      reason:
        'Add policy payment_proofs_anon_insert for role anon (see supabase-schema.sql), or bucket missing.',
    });
    return {
      ok: false,
      message: upErr.message || 'File upload failed.',
      failedStep: 'storage_upload',
    };
  }

  const { data: inserted, error: insErr } = await supabase
    .from('payments')
    .insert({
      user_id: userId,
      email,
      status: 'pending',
      proof_path: objectPath,
    })
    .select('id')
    .single();

  if (insErr) {
    logPaymentFlowFailure('payments_insert', insErr, {
      reason:
        'Run: alter table public.payments disable row level security; and nullable user_id (see schema migration).',
    });
    const { error: removeErr } = await supabase.storage.from('payment-proofs').remove([objectPath]);
    if (removeErr) {
      console.warn('[ARIA payment flow] Could not remove orphan file:', objectPath, removeErr.message);
    }
    return {
      ok: false,
      message: insErr.message || 'Could not save payment record.',
      failedStep: 'payments_insert',
    };
  }

  console.info('[ARIA payment flow] OK', { paymentId: inserted?.id, proof_path: objectPath });
  return { ok: true, paymentId: inserted?.id };
}

/**
 * Set a user's plan to Pro (for admins after verifying manual payment).
 * Requires your user row to have is_admin = true (set in Supabase SQL Editor).
 * Or run the same update in SQL Editor with service role.
 */
export async function approveUser(userId) {
  if (!userId) {
    return { data: null, error: { message: 'userId is required' } };
  }
  const { data, error } = await supabase
    .from('users')
    .update({ plan: 'pro' })
    .eq('id', userId)
    .select('id, plan, email')
    .maybeSingle();
  return { data, error };
}
