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

/** Ensures a row exists in public.users (required for payments FK). */
async function ensurePublicUserRow(user) {
  if (!user?.id) return { error: new Error('Missing user') };
  const { data: row } = await supabase
    .from('users')
    .select('id')
    .eq('id', user.id)
    .maybeSingle();
  if (row) return { error: null };
  const { error } = await supabase.from('users').insert({
    id: user.id,
    email: user.email || null,
    plan: 'free',
  });
  return { error };
}

/**
 * Upload proof file to Storage and insert a pending payments row.
 * Requires: payments table, payment-proofs bucket, and RLS (see supabase-schema.sql).
 */
export async function submitManualPaymentProofFlow(file) {
  if (!file || !(file instanceof File)) {
    return { ok: false, message: 'Please choose a file to upload.' };
  }

  const { data: authData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !authData?.user) {
    return { ok: false, message: 'Please sign in to submit payment proof.' };
  }

  const user = authData.user;
  const { error: ensureErr } = await ensurePublicUserRow(user);
  if (ensureErr) {
    return {
      ok: false,
      message: ensureErr.message || 'Could not prepare your account. Try again.',
    };
  }

  const rawExt = (file.name.split('.').pop() || 'bin').slice(0, 12);
  const safeExt = /^[a-z0-9]+$/i.test(rawExt) ? rawExt.toLowerCase() : 'bin';
  const objectPath = `${user.id}/${crypto.randomUUID()}.${safeExt}`;

  const { error: upErr } = await supabase.storage
    .from('payment-proofs')
    .upload(objectPath, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || 'application/octet-stream',
    });

  if (upErr) {
    return {
      ok: false,
      message: upErr.message || 'Upload failed. Try again or use a smaller file.',
    };
  }

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
    return {
      ok: false,
      message: insErr.message || 'Could not save payment record.',
    };
  }

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

