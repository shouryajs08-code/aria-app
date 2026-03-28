// ═══════════════════════════════════════════════════════════
//  ARIA LIVE DATA SERVER
//  Finnhub WebSocket → in-memory prices → ARIA dashboard
//  Optional POST /webhook | /update for bias / legacy payloads
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const WebSocket = require('ws');

const app = express();

app.use(express.json());
app.use(cors());

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const FINNHUB_TOKEN =
  process.env.FINNHUB_API_KEY || 'd715svpr01ql6rg1g4egd715svpr01ql6rg1g4f0';
const FINNHUB_WS_URL = `wss://ws.finnhub.io?token=${FINNHUB_TOKEN}`;

const razorpay =
  RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET,
      })
    : null;

// ── FINNHUB → PAIR (store keys) ─────────────────────────────
const FINNHUB_SYMBOL_TO_PAIR = {
  'OANDA:EUR_USD': 'EURUSD',
  'OANDA:AUD_USD': 'AUDUSD',
};

// ── IN-MEMORY PRICE STORE (Finnhub WS) ─────────────────────
const prices = {
  EURUSD: null, // { price, timestamp } — timestamp ms
  AUDUSD: null,
};

// ── IN-MEMORY STORE (latest + history, /latest & legacy) ───
const store = {
  EURUSD: { latest: null, history: [] },
  AUDUSD: { latest: null, history: [] },
  GBPUSD: { latest: null, history: [] },
  XAUUSD: { latest: null, history: [] },
};

function istTimeString() {
  return (
    new Date(Date.now() + 5.5 * 3600000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19) + ' IST'
  );
}

function applyFinnhubTrade(pairKey, price, timestampMs) {
  prices[pairKey] = { price, timestamp: timestampMs };
  const prev = store[pairKey].latest || {};
  const enriched = {
    ...prev,
    pair: pairKey,
    price,
    timestamp: timestampMs,
    server_time: new Date().toISOString(),
    ist_time: istTimeString(),
    source: 'finnhub-ws',
  };
  store[pairKey].latest = enriched;
  store[pairKey].history.unshift(enriched);
  if (store[pairKey].history.length > 100) {
    store[pairKey].history = store[pairKey].history.slice(0, 100);
  }
}

// ── FINNHUB WEBSOCKET (reconnect + heartbeat) ──────────────
let finnhubPingTimer = null;
let finnhubReconnectTimer = null;
let finnhubWsConnected = false;

function clearFinnhubPing() {
  if (finnhubPingTimer) {
    clearInterval(finnhubPingTimer);
    finnhubPingTimer = null;
  }
}

function startFinnhubWebSocket() {
  if (finnhubReconnectTimer) {
    clearTimeout(finnhubReconnectTimer);
    finnhubReconnectTimer = null;
  }

  clearFinnhubPing();
  finnhubWsConnected = false;

  const ws = new WebSocket(FINNHUB_WS_URL);

  ws.on('open', () => {
    finnhubWsConnected = true;
    console.log('✅ Finnhub WebSocket connected');
    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'OANDA:EUR_USD' }));
    ws.send(JSON.stringify({ type: 'subscribe', symbol: 'OANDA:AUD_USD' }));

    finnhubPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type !== 'trade' || !Array.isArray(msg.data)) return;

    for (const row of msg.data) {
      const sym = row.s;
      const pairKey = FINNHUB_SYMBOL_TO_PAIR[sym];
      if (!pairKey || row.p == null) continue;

      const t = row.t;
      const timestampMs =
        typeof t === 'number' ? t : Date.now();

      applyFinnhubTrade(pairKey, row.p, timestampMs);
    }
  });

  ws.on('close', (code, reason) => {
    finnhubWsConnected = false;
    clearFinnhubPing();
    try {
      ws.removeAllListeners();
    } catch (_) {}
    console.warn(
      `Finnhub WebSocket closed (${code}) ${reason || ''} — reconnect in 5s`
    );
    finnhubReconnectTimer = setTimeout(() => {
      finnhubReconnectTimer = null;
      startFinnhubWebSocket();
    }, 5000);
  });

  ws.on('error', (err) => {
    console.error('Finnhub WebSocket error:', err && err.message ? err.message : err);
  });
}

// ── HELPER: Clean pair name ─────────────────────────────────
function cleanPair(raw) {
  if (!raw) return null;
  const clean = raw.toUpperCase().replace(/^[A-Z]+:/, '');
  return store[clean] ? clean : null;
}

// ══════════════════════════════════════════════════════════
//  POST /webhook  ←  Legacy TradingView / custom (bias, etc.)
// ══════════════════════════════════════════════════════════
function handleLegacyPriceUpdate(req, res) {
  try {
    const data = req.body;
    console.log('📥 Legacy POST received:', JSON.stringify(data).slice(0, 120));

    const pair = cleanPair(data.pair);
    if (!pair) {
      console.warn('⚠️  Unknown pair:', data.pair);
      return res.status(400).json({ error: 'Unknown pair' });
    }

    const enriched = {
      ...data,
      pair,
      server_time: new Date().toISOString(),
      ist_time: istTimeString(),
    };

    store[pair].latest = enriched;
    store[pair].history.unshift(enriched);
    if (store[pair].history.length > 100) {
      store[pair].history = store[pair].history.slice(0, 100);
    }

    if (data.price != null && (pair === 'EURUSD' || pair === 'AUDUSD')) {
      const ts =
        typeof data.timestamp === 'number'
          ? data.timestamp
          : Date.now();
      prices[pair] = { price: data.price, timestamp: ts };
    }

    console.log(`✅ ${pair} updated — Price: ${data.price} | Bias: ${data.bias}`);
    res.json({ ok: true, pair, price: data.price, bias: data.bias });
  } catch (err) {
    console.error('❌ Legacy update error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

app.post('/webhook', handleLegacyPriceUpdate);

// ══════════════════════════════════════════════════════════
//  POST /update  ←  Same as /webhook (backward compatibility)
// ══════════════════════════════════════════════════════════
app.post('/update', handleLegacyPriceUpdate);

// ══════════════════════════════════════════════════════════
//  GET /latest/:pair
// ══════════════════════════════════════════════════════════
app.get('/latest/:pair', (req, res) => {
  const pair = cleanPair(req.params.pair);
  if (!pair) return res.status(404).json({ error: 'Unknown pair' });

  const data = store[pair].latest;
  if (!data) {
    return res.status(404).json({
      error: 'No data yet',
      message: `No live data for ${pair} yet. Finnhub WebSocket may still be connecting.`,
    });
  }

  res.json(data);
});

// ══════════════════════════════════════════════════════════
//  GET /latest  ←  All pairs that have data
// ══════════════════════════════════════════════════════════
app.get('/latest', (req, res) => {
  const result = {};
  for (const [pair, val] of Object.entries(store)) {
    if (val.latest) result[pair] = val.latest;
  }
  res.json(result);
});

// ══════════════════════════════════════════════════════════
//  POST /create-order
// ══════════════════════════════════════════════════════════
app.post('/create-order', async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(500).json({ error: 'Razorpay is not configured' });
    }
    const amount = Number(req.body?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amount),
      currency: 'INR',
    });
    res.json(order);
  } catch (_err) {
    res.status(500).json({ error: 'Order creation failed' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /verify-payment
// ══════════════════════════════════════════════════════════
app.post('/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      user_id,
    } = req.body || {};

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature || !user_id) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    if (!RAZORPAY_KEY_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ success: false, error: 'Server env is not configured' });
    }

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }

    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?id=eq.${encodeURIComponent(user_id)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          plan: 'pro',
          payment_id: razorpay_payment_id,
          upgraded_at: new Date().toISOString(),
        }),
      }
    );

    if (!patchRes.ok) {
      return res.status(500).json({ success: false, error: 'Plan update failed' });
    }

    return res.json({ success: true });
  } catch (_err) {
    return res.status(500).json({ error: 'Verification failed' });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /history/:pair
// ══════════════════════════════════════════════════════════
app.get('/history/:pair', (req, res) => {
  const pair = cleanPair(req.params.pair);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  if (!pair) return res.status(404).json({ error: 'Unknown pair' });
  res.json(store[pair].history.slice(0, limit));
});

// ══════════════════════════════════════════════════════════
//  GET /status
// ══════════════════════════════════════════════════════════
app.get('/status', (req, res) => {
  const status = {};
  for (const [pair, val] of Object.entries(store)) {
    status[pair] = {
      hasData: !!val.latest,
      lastUpdate: val.latest?.ist_time || 'No data',
      price: val.latest?.price ?? null,
      bias: val.latest?.bias ?? null,
      candles: val.history.length,
      finnhubPrice: prices[pair] || null,
    };
  }
  res.json({
    server: 'ARIA Live Data Server',
    version: '2.0',
    finnhubWs: finnhubWsConnected ? 'connected' : 'disconnected',
    prices,
    status,
    uptime: Math.round(process.uptime()) + 's',
  });
});

// ══════════════════════════════════════════════════════════
//  GET /
// ══════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  const lines = Object.entries(store).map(([pair, val]) => {
    const d = val.latest;
    const src = d?.source === 'finnhub-ws' ? 'Finnhub WS' : d ? 'Legacy POST' : '—';
    return d
      ? `<tr><td>${pair}</td><td>${d.price}</td><td>${d.bias ?? '—'}</td><td>${src}</td><td>${d.ist_time}</td><td>${val.history.length}</td></tr>`
      : `<tr><td>${pair}</td><td colspan="5" style="color:#666">Waiting for data…</td></tr>`;
  });

  res.send(`<!DOCTYPE html>
<html>
<head>
<title>ARIA Data Server</title>
<meta http-equiv="refresh" content="10">
<style>
  body { font-family: -apple-system, sans-serif; background: #0D0D0D; color: #fff; padding: 40px; }
  h1 { color: #00D4FF; } h2 { color: #888; font-size: 14px; font-weight: normal; }
  table { border-collapse: collapse; width: 100%; margin-top: 20px; }
  th { text-align: left; padding: 10px 16px; background: #141414; color: #888; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
  td { padding: 12px 16px; border-bottom: 1px solid #2A2A2A; font-family: "SF Mono", monospace; font-size: 13px; }
  .ok { color: #00C896; } .warn { color: #FFB300; } .bad { color: #FF4757; }
  .uptime { color: #888; font-size: 12px; margin-top: 10px; }
</style>
</head>
<body>
<h1>⚡ ARIA Live Data Server</h1>
<h2>Prices: Finnhub WebSocket (OANDA EUR/USD &amp; AUD/USD) · Auto-refresh 10s</h2>
<p class="uptime">WS: <span class="${finnhubWsConnected ? 'ok' : 'warn'}">${finnhubWsConnected ? 'connected' : 'disconnected / reconnecting'}</span></p>
<table>
  <thead><tr><th>Pair</th><th>Price</th><th>Bias</th><th>Source</th><th>Last Update (IST)</th><th>History</th></tr></thead>
  <tbody>${lines.join('')}</tbody>
</table>
<p class="uptime">Uptime: ${Math.round(process.uptime())}s · GET /latest · POST /webhook · POST /update</p>
</body>
</html>`);
});

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  startFinnhubWebSocket();
  console.log(`
╔══════════════════════════════════════════╗
║     ARIA Live Data Server — Running      ║
║     Port: ${PORT}                           ║
║                                          ║
║  Prices: Finnhub WebSocket               ║
║  GET  /latest       ← All pairs          ║
║  GET  /latest/EURUSD                     ║
║  POST /webhook      ← Legacy             ║
║  POST /update       ← Legacy alias       ║
║  GET  /status       ← Health + prices    ║
╚══════════════════════════════════════════╝
  `);
});
