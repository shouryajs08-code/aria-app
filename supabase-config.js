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

