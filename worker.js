/**
 * ARIA proxy — Cloudflare Worker
 * Forwards authenticated requests to Anthropic Messages API.
 *
 * Secrets:  wrangler secret put ANTHROPIC_API_KEY
 * Optional: set SUPABASE_URL + SUPABASE_ANON_KEY (Worker vars, same as frontend)
 *           to validate the Bearer JWT via GET /auth/v1/user. If omitted, any
 *           non-empty Bearer token is accepted (not recommended for production).
 */

function corsHeaders(env) {
  const origin = env.ALLOWED_ORIGIN || 'https://aria-trader.netlify.app';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(env, body, status) {
  const headers = new Headers(corsHeaders(env));
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers });
}

async function verifySupabaseUser(env, jwt) {
  const url = env.SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY;
  if (!url || !anon) return true;

  const res = await fetch(`${url.replace(/\/$/, '')}/auth/v1/user`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      apikey: anon,
    },
  });

  if (!res.ok) {
    console.error('Supabase JWT verification failed:', res.status, await res.text().catch(() => ''));
    return false;
  }
  return true;
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: cors });
    }

    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/api/aria') {
      return jsonResponse(env, { error: { message: 'Not found' } }, 404);
    }

    const authHeader = request.headers.get('Authorization') || '';
    const bearerMatch = /^Bearer\s+(\S+)/i.exec(authHeader);
    if (!bearerMatch || !bearerMatch[1]) {
      console.error('Missing or invalid Authorization header');
      return jsonResponse(env, { error: { message: 'Unauthorized' } }, 401);
    }
    const jwt = bearerMatch[1];

    const okUser = await verifySupabaseUser(env, jwt);
    if (!okUser) {
      return jsonResponse(env, { error: { message: 'Invalid or expired session' } }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      console.error('Invalid JSON body:', e);
      return jsonResponse(env, { error: { message: 'Invalid JSON body' } }, 400);
    }

    const { system, messages } = body;
    if (!Array.isArray(messages)) {
      return jsonResponse(env, { error: { message: 'messages must be an array' } }, 400);
    }

    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY is not set');
      return jsonResponse(env, { error: { message: 'Server misconfiguration' } }, 500);
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

      const outHeaders = new Headers(cors);
      const ct = ar.headers.get('Content-Type');
      if (ct) outHeaders.set('Content-Type', ct);
      else outHeaders.set('Content-Type', 'application/json');

      const text = await ar.text();

      if (!ar.ok) {
        console.error('Anthropic API error:', ar.status, text.slice(0, 800));
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { error: { message: text.slice(0, 300) || `HTTP ${ar.status}` } };
        }
        return new Response(JSON.stringify(parsed.error ? parsed : { error: { message: 'Anthropic error', detail: parsed } }), {
          status: 502,
          headers: outHeaders,
        });
      }

      return new Response(text, { status: ar.status, headers: outHeaders });
    } catch (e) {
      console.error('Anthropic fetch failed:', e);
      return jsonResponse(
        env,
        { error: { message: e instanceof Error ? e.message : 'Upstream request failed' } },
        502
      );
    }
  },
};
