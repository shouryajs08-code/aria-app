// ═══════════════════════════════════════════════════════════
//  ARIA LIVE DATA SERVER
//  Receives TradingView webhooks → serves to ARIA dashboard
//  Deploy free on Railway.app in 5 minutes
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const app     = express();

app.use(express.json());
app.use(cors()); // Allow ARIA dashboard to fetch from browser

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const razorpay = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
  ? new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET,
    })
  : null;

// ── IN-MEMORY STORE ───────────────────────────────────────
// Stores latest data per pair + last 100 candles history
const store = {
  EURUSD: { latest: null, history: [] },
  AUDUSD: { latest: null, history: [] },
  GBPUSD: { latest: null, history: [] },
  XAUUSD: { latest: null, history: [] },
};

// ── HELPER: Clean pair name ───────────────────────────────
function cleanPair(raw) {
  if (!raw) return null;
  // TradingView sends "OANDA:EURUSD" or just "EURUSD"
  const clean = raw.toUpperCase().replace(/^[A-Z]+:/, '');
  return store[clean] ? clean : null;
}

// ══════════════════════════════════════════════════════════
//  POST /webhook  ←  TradingView sends data here
// ══════════════════════════════════════════════════════════
app.post('/webhook', (req, res) => {
  try {
    const data = req.body;
    console.log('📥 Webhook received:', JSON.stringify(data).slice(0, 120));

    const pair = cleanPair(data.pair);
    if (!pair) {
      console.warn('⚠️  Unknown pair:', data.pair);
      return res.status(400).json({ error: 'Unknown pair' });
    }

    // Add server timestamp
    const enriched = {
      ...data,
      pair,
      server_time: new Date().toISOString(),
      ist_time: new Date(Date.now() + 5.5 * 3600000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19) + ' IST',
    };

    // Store as latest
    store[pair].latest = enriched;

    // Add to history (keep last 100 candles)
    store[pair].history.unshift(enriched);
    if (store[pair].history.length > 100) {
      store[pair].history = store[pair].history.slice(0, 100);
    }

    console.log(`✅ ${pair} updated — Price: ${data.price} | Bias: ${data.bias}`);
    res.json({ ok: true, pair, price: data.price, bias: data.bias });

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /latest/:pair  ←  ARIA fetches this
// ══════════════════════════════════════════════════════════
app.get('/latest/:pair', (req, res) => {
  const pair = cleanPair(req.params.pair);
  if (!pair) return res.status(404).json({ error: 'Unknown pair' });

  const data = store[pair].latest;
  if (!data) {
    return res.status(404).json({
      error: 'No data yet',
      message: `No webhook received for ${pair} yet. Check TradingView alert is running.`
    });
  }

  res.json(data);
});

// ══════════════════════════════════════════════════════════
//  GET /latest  ←  ARIA fetches ALL pairs at once
// ══════════════════════════════════════════════════════════
app.get('/latest', (req, res) => {
  const result = {};
  for (const [pair, val] of Object.entries(store)) {
    if (val.latest) result[pair] = val.latest;
  }
  res.json(result);
});

// ══════════════════════════════════════════════════════════
//  POST /create-order  ←  Create Razorpay order (server-side)
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
      amount: Math.round(amount), // paise
      currency: 'INR',
    });
    res.json(order);
  } catch (_err) {
    res.status(500).json({ error: 'Order creation failed' });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /verify-payment  ←  Verify signature + upgrade plan
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
//  GET /history/:pair  ←  Last N candles
// ══════════════════════════════════════════════════════════
app.get('/history/:pair', (req, res) => {
  const pair  = cleanPair(req.params.pair);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  if (!pair) return res.status(404).json({ error: 'Unknown pair' });
  res.json(store[pair].history.slice(0, limit));
});

// ══════════════════════════════════════════════════════════
//  GET /status  ←  Health check / dashboard
// ══════════════════════════════════════════════════════════
app.get('/status', (req, res) => {
  const status = {};
  for (const [pair, val] of Object.entries(store)) {
    status[pair] = {
      hasData:    !!val.latest,
      lastUpdate: val.latest?.ist_time || 'No data',
      price:      val.latest?.price    || null,
      bias:       val.latest?.bias     || null,
      candles:    val.history.length,
    };
  }
  res.json({
    server:  'ARIA Live Data Server',
    version: '1.0',
    status,
    uptime:  Math.round(process.uptime()) + 's',
  });
});

// ══════════════════════════════════════════════════════════
//  GET /  ←  Simple status page
// ══════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  const lines = Object.entries(store).map(([pair, val]) => {
    const d = val.latest;
    return d
      ? `<tr><td>${pair}</td><td>${d.price}</td><td>${d.bias}</td><td>${d.ist_time}</td><td>${val.history.length}</td></tr>`
      : `<tr><td>${pair}</td><td colspan="4" style="color:#666">Waiting for TradingView alert...</td></tr>`;
  });

  res.send(`<!DOCTYPE html>
<html>
<head>
<title>ARIA Data Server</title>
<meta http-equiv="refresh" content="10">
<style>
  body { font-family: -apple-system, sans-serif; background: #0D0D0D; color: #fff; padding: 40px; }
  h1 { color: #C9A84C; } h2 { color: #888; font-size: 14px; font-weight: normal; }
  table { border-collapse: collapse; width: 100%; margin-top: 20px; }
  th { text-align: left; padding: 10px 16px; background: #141414; color: #888; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
  td { padding: 12px 16px; border-bottom: 1px solid #2A2A2A; font-family: "SF Mono", monospace; font-size: 13px; }
  .ok { color: #00C896; } .warn { color: #FFB300; } .bad { color: #FF4757; }
  .uptime { color: #888; font-size: 12px; margin-top: 10px; }
</style>
</head>
<body>
<h1>⚡ ARIA Live Data Server</h1>
<h2>Auto-refreshes every 10 seconds</h2>
<table>
  <thead><tr><th>Pair</th><th>Price</th><th>Bias</th><th>Last Update (IST)</th><th>Candles</th></tr></thead>
  <tbody>${lines.join('')}</tbody>
</table>
<p class="uptime">Server uptime: ${Math.round(process.uptime())}s | Endpoint: POST /webhook | GET /latest/:pair</p>
</body>
</html>`);
});

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║     ARIA Live Data Server — Running      ║
║     Port: ${PORT}                           ║
║                                          ║
║  Endpoints:                              ║
║  POST /webhook      ← TradingView        ║
║  GET  /latest       ← All pairs          ║
║  GET  /latest/EURUSD ← Single pair       ║
║  GET  /status       ← Health check       ║
╚══════════════════════════════════════════╝
  `);
});
