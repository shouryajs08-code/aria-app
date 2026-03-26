/**
 * ARIA proxy — Cloudflare Worker
 * POST /api/aria → Anthropic Messages API (Claude Sonnet)
 *
 * Secret: wrangler secret put ANTHROPIC_API_KEY
 *
 * Optional: SUPABASE_URL + SUPABASE_ANON_KEY (Worker vars) to verify JWT.
 */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body, status = 200) {
  const headers = new Headers(corsHeaders());
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

async function handleVerifyPayment(request, env) {
  try {
    const body = await request.json();
    const { user_id } = body || {};
    if (!user_id) return jsonResponse({ success: false, error: 'user_id is required' }, 400);

    const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
    const supabaseUrl = env.SUPABASE_URL;
    if (!serviceRole || !supabaseUrl) {
      return jsonResponse({ success: false, error: 'Server misconfiguration' }, 500);
    }

    // MVP: signature verification intentionally skipped.
    const patchRes = await fetch(
      `${String(supabaseUrl).replace(/\/$/, '')}/rest/v1/users?id=eq.${encodeURIComponent(user_id)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: serviceRole,
          Authorization: `Bearer ${serviceRole}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ plan: 'pro' }),
      }
    );

    if (!patchRes.ok) return jsonResponse({ success: false, error: 'Plan update failed' }, 500);
    return jsonResponse({ success: true }, 200);
  } catch (e) {
    return jsonResponse(
      { success: false, error: e instanceof Error ? e.message : 'Verification failed' },
      500
    );
  }
}

async function verifySupabaseUser(env, jwt) {
  const url = env.SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY;
  if (!url || !anon) return true;

  const res = await fetch(`${String(url).replace(/\/$/, '')}/auth/v1/user`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      apikey: anon,
    },
  });

  if (!res.ok) {
    console.error('Supabase JWT verification failed:', res.status);
    return false;
  }
  return true;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders();
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (path === '/api/verify-payment') {
      if (request.method !== 'POST') {
        return jsonResponse(
          { error: { message: 'Method not allowed', allowed: ['POST', 'OPTIONS'] } },
          405
        );
      }
      return handleVerifyPayment(request, env);
    }

    if (path !== '/api/aria') {
      return jsonResponse({ error: { message: 'Not found' } }, 404);
    }

    // Browser GET → helpful JSON (not "Not found")
    if (request.method === 'GET') {
      return jsonResponse(
        {
          ok: true,
          service: 'aria-proxy',
          path: '/api/aria',
          message: 'Use POST with JSON body: { "system": string, "messages": array }',
          methods: ['POST', 'OPTIONS'],
        },
        200
      );
    }

    if (request.method !== 'POST') {
      return jsonResponse(
        { error: { message: 'Method not allowed', allowed: ['GET', 'POST', 'OPTIONS'] } },
        405
      );
    }

    const authHeader = request.headers.get('Authorization') || '';
    const bearerMatch = /^Bearer\s+(\S+)/i.exec(authHeader);
    if (!bearerMatch || !bearerMatch[1]) {
      console.error('Missing or invalid Authorization header');
      return jsonResponse({ error: { message: 'Unauthorized' } }, 401);
    }
    const jwt = bearerMatch[1];

    const okUser = await verifySupabaseUser(env, jwt);
    if (!okUser) {
      return jsonResponse({ error: { message: 'Invalid or expired session' } }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      console.error('Invalid JSON body:', e);
      return jsonResponse({ error: { message: 'Invalid JSON body' } }, 400);
    }

    const { system, messages } = body;
    if (!Array.isArray(messages)) {
      return jsonResponse({ error: { message: 'messages must be an array' } }, 400);
    }

    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY is not set');
      return jsonResponse({ error: { message: 'Server misconfiguration' } }, 500);
    }

    const anthropicPayload = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: system ?? '',
      messages,
    };

    try {
      const ar = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(anthropicPayload),
      });

      const raw = await ar.text();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {
          error: {
            type: 'parse_error',
            message: raw.slice(0, 500) || `Upstream HTTP ${ar.status}`,
          },
        };
      }

      const headers = new Headers(corsHeaders());
      headers.set('Content-Type', 'application/json; charset=utf-8');

      if (!ar.ok) {
        console.error('Anthropic API error:', ar.status, raw.slice(0, 800));
        const errBody =
          parsed && parsed.error
            ? parsed
            : { error: { message: 'Anthropic request failed', status: ar.status, detail: parsed } };
        return new Response(JSON.stringify(errBody), { status: 502, headers });
      }

      return new Response(JSON.stringify(parsed), { status: 200, headers });
    } catch (e) {
      console.error('Anthropic fetch failed:', e);
      return jsonResponse(
        { error: { message: e instanceof Error ? e.message : 'Upstream request failed' } },
        502
      );
    }
  },
};
