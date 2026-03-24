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

/** Tables touched by manual payment proof flow (DB + Storage). */
export const PAYMENT_FLOW_TABLES = {
  auth: 'auth.getUser() (not a table)',
  users: 'public.users — SELECT only (FK target for payments.user_id)',
  storage: 'storage.objects — INSERT (bucket payment-proofs)',
  payments: 'public.payments — INSERT (single row)',
};

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
 * Manual payment proof: exactly one INSERT into `payments`.
 * - No client INSERT into `users` (avoids users RLS / duplicate email issues).
 * - Requires `public.users` row (use handle_new_user trigger + backfill in supabase-schema.sql).
 * - File goes to Storage bucket `payment-proofs` (separate RLS on storage.objects).
 */
export async function submitManualPaymentProofFlow(file) {
  if (typeof window !== 'undefined') {
    window.__ARIA_LAST_PAYMENT_FLOW_ERROR = null;
  }

  if (!file || !(file instanceof File)) {
    return { ok: false, message: 'Please choose a file to upload.', failedStep: 'validate_file' };
  }

  // ── Step 1: Auth (not subject to your public table RLS) ──────────────────
  const { data: authData, error: authErr } = await supabase.auth.getUser();
  if (authErr) {
    logPaymentFlowFailure('1_auth_getUser', authErr, { table: PAYMENT_FLOW_TABLES.auth });
    return {
      ok: false,
      message: authErr.message || 'Sign-in check failed.',
      failedStep: '1_auth_getUser',
    };
  }
  if (!authData?.user) {
    const err = { message: 'No authenticated user.' };
    logPaymentFlowFailure('1_auth_getUser', err, { table: PAYMENT_FLOW_TABLES.auth });
    return { ok: false, message: 'Please sign in to submit payment proof.', failedStep: '1_auth_getUser' };
  }

  const user = authData.user;

  // ── Step 2: public.users — SELECT only (payments FK requires this row) ───
  const { data: userRow, error: userSelectErr } = await supabase
    .from('users')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();

  if (userSelectErr) {
    logPaymentFlowFailure('2_users_select', userSelectErr, {
      table: 'public.users',
      operation: 'select',
      reason:
        'RLS on users blocked SELECT of your own row, or network/schema error. Expected policy: users_select_own (id = auth.uid()).',
    });
    return {
      ok: false,
      message: userSelectErr.message || 'Could not verify your account.',
      failedStep: '2_users_select',
    };
  }

  if (!userRow) {
    const err = {
      message:
        'No row in public.users for this account. Run the auth trigger + backfill SQL in supabase-schema.sql, then try again.',
    };
    logPaymentFlowFailure('2_users_select', err, {
      table: 'public.users',
      operation: 'select',
      reason:
        'payments.user_id references public.users(id). Without a users row, INSERT into payments would fail (FK), not RLS.',
    });
    return {
      ok: false,
      message:
        'Your account is not fully set up in the database yet. Please contact support or try again after the admin runs the user backfill SQL.',
      failedStep: '2_users_missing',
    };
  }

  const rawExt = (file.name.split('.').pop() || 'bin').slice(0, 12);
  const safeExt = /^[a-z0-9]+$/i.test(rawExt) ? rawExt.toLowerCase() : 'bin';
  const objectPath = `${user.id}/${crypto.randomUUID()}.${safeExt}`;

  // ── Step 3: Storage upload (RLS on storage.objects, not payments) ────────
  const { error: upErr } = await supabase.storage.from('payment-proofs').upload(objectPath, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || 'application/octet-stream',
  });

  if (upErr) {
    logPaymentFlowFailure('3_storage_upload', upErr, {
      table: 'storage.objects',
      bucket: 'payment-proofs',
      path: objectPath,
      operation: 'insert',
      reason:
        'Typical cause: RLS policy on storage.objects (e.g. first path segment must equal auth.uid()). Message often contains "row-level security".',
    });
    return {
      ok: false,
      message: upErr.message || 'File upload failed. Check Storage policies for bucket payment-proofs.',
      failedStep: '3_storage_upload',
    };
  }

  // ── Step 4: Single INSERT into payments ──────────────────────────────────
  const { data: inserted, error: insErr } = await supabase
    .from('payments')
    .insert({
      user_id: user.id,
      email: user.email || null,
      status: 'pending',
      proof_path: objectPath,
    })
    .select('id')
    .single();

  if (insErr) {
    logPaymentFlowFailure('4_payments_insert', insErr, {
      table: 'public.payments',
      operation: 'insert',
      reason:
        'If RLS is enabled: need policy payments_insert_own with check (user_id = auth.uid()). If RLS disabled, this may be FK, unique, or check constraint.',
    });
    const { error: removeErr } = await supabase.storage.from('payment-proofs').remove([objectPath]);
    if (removeErr) {
      console.warn('[ARIA payment flow] Orphan file left in storage (remove failed):', {
        path: objectPath,
        error: removeErr.message,
      });
    }
    return {
      ok: false,
      message: insErr.message || 'Could not save payment record.',
      failedStep: '4_payments_insert',
    };
  }

  console.info('[ARIA payment flow] OK: storage upload + payments insert', {
    paymentId: inserted?.id,
    proof_path: objectPath,
  });

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
