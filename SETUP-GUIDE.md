# ARIA Live Data Setup Guide
## From zero to real-time SMC analysis in ~30 minutes

---

## WHAT YOU'LL HAVE AFTER THIS:
Type "EURUSD" in ARIA → get real M5 chart analysis with actual price,
EMA, RSI, Order Blocks, FVGs, BOS, CHoCH, Premium/Discount — automatically.

---

## STEP 1 — Deploy the Server on Railway (10 minutes)

1. Go to https://railway.app
2. Click "Start a New Project"
3. Sign up with GitHub (free)
4. Click "Deploy from GitHub repo" OR "Empty project"
5. Choose "Empty project" → Add a service → "GitHub Repo"

   ── OR easier: use Railway CLI ──
   
   a. Upload the `aria-server` folder to a new GitHub repo
      (github.com → New repo → upload files → commit)
   b. Connect that repo to Railway
   c. Railway auto-detects Node.js and deploys

6. Once deployed, Railway gives you a URL like:
   https://aria-server-production-xxxx.up.railway.app
   
7. Test it: open that URL in browser
   You should see the ARIA server status page (black screen with gold text)

SAVE THIS URL — you need it in Step 3.

---

## STEP 2 — Add Pine Script to TradingView (10 minutes)

### 2a. Add the indicator
1. Open TradingView → open EURUSD M5 chart
2. Click "Pine Script Editor" at bottom
3. Delete all existing code
4. Paste the ENTIRE contents of `aria-smc-feed.pine`
5. Click "Save" → name it "ARIA SMC Feed"
6. Click "Add to chart"
   You'll see EMA20 (yellow), EMA50 (orange), EMA200 (red) on your chart

### 2b. Create EURUSD Alert
1. Right-click on chart → "Add Alert" (or press Alt+A)
2. Condition: "ARIA SMC Feed" → "ARIA SMC Feed" (the alertcondition)
3. Trigger: "Once Per Bar Close" ← IMPORTANT
4. Expiry: Open-ended (or max available)
5. Notifications: ✅ Webhook URL
6. Webhook URL: https://YOUR-RAILWAY-URL.up.railway.app/webhook
7. Message box: DELETE everything, paste ONLY this:
   {{strategy.order.alert_message}}
   
   Actually for alertcondition, TradingView uses the message you set in Pine.
   Leave the message box AS IS (it will auto-fill from the script).
   
8. Alert name: "ARIA EURUSD Feed"
9. Click "Create" ✅

### 2c. Create AUDUSD Alert
1. Open AUDUSD M5 chart (new tab or change chart)
2. Add the SAME indicator (ARIA SMC Feed) to this chart
3. Create alert with same settings
4. Webhook URL: same Railway URL
5. Alert name: "ARIA AUDUSD Feed"
6. Click "Create" ✅

### Verify alerts are firing:
- Wait for next M5 candle close (max 5 minutes)
- Open your Railway server URL
- You should see EURUSD and AUDUSD with prices ✓

---

## STEP 3 — Connect Server to ARIA Dashboard (2 minutes)

1. Open ARIA-v5-live.html in your browser
2. Click the ⚙️ Settings gear (top right)
3. Find "Live Data Server URL" field
4. Paste your Railway URL:
   https://aria-server-production-xxxx.up.railway.app
5. Click "Test" button
6. You should see: "Connected ✓ — EURUSD: ✓ 1.1571 | AUDUSD: ✓ 0.7021"
7. Click "Save Prop Data" to save all settings

---

## STEP 4 — Test It

1. Look at the price strip below the prop bar
   EURUSD ● 1.15711    AUDUSD ● 0.70216
   The ● dot glows GREEN = live data ✓

2. Type "EURUSD" in the chat box → Send

3. ARIA should respond with something like:
   "EURUSD M5 — Price: 1.15711. EMA20 at 1.15780, price is BELOW — bearish.
    RSI 42.3, approaching oversold. Last 3 candles: Bearish, Bearish, Doji.
    BOS: Bearish confirmed. Nearest OB: 1.15800–1.15850.
    FVG: Bearish gap 1.15710–1.15760 unfilled. Currently in DISCOUNT zone.
    Bias: SELL. Entry on retest of 1.15780 EMA20. SL: 1.15880 (10 pips).
    TP: 1.15580 (20 pips). Your 0.25 lot = -$25 risk / +$50 reward."

That's REAL analysis from REAL chart data. 🎯

---

## TROUBLESHOOTING

Problem: Railway URL returns error
Solution: Check railway.app dashboard → your service → "Deploy Logs"
          Make sure package.json and server.js are in the ROOT of the repo

Problem: Price strip shows "connecting…" after 5 minutes
Solution: TradingView alert might not be firing
          Check: TradingView → Alerts panel (clock icon) → your alert should show "Active"
          Check: Railway logs → should show "📥 Webhook received" lines

Problem: ARIA response doesn't include chart data
Solution: The server URL might not be saved
          Open ⚙️ Settings → re-paste URL → click Test → save

Problem: "No data yet" error from server
Solution: Wait for next M5 candle close on TradingView
          Alerts only fire on bar CLOSE, not open

---

## WHAT THE ● DOTS MEAN

🟢 Green = Data received < 10 minutes ago (fresh M5 data)
🟡 Yellow = Data received > 10 min but < 1 hour (slightly stale)
⚫ Dark = No data received yet (server not connected or alert not firing)

---

## KEEPING IT FREE

Railway free tier gives you:
- $5 credit/month
- At ~$0.000463/hour for tiny Node.js server
- That's ~450 hours/month = basically unlimited for this use case

You will NOT be charged unless your server does heavy work.

---

## FILES IN THIS PACKAGE

aria-smc-feed.pine     → Paste into TradingView Pine Script Editor
aria-server/server.js  → Deploy to Railway
aria-server/package.json → (included with server)
ARIA-v5-live.html      → Your updated dashboard (open in browser)
SETUP-GUIDE.md         → This file

---

Questions? The setup takes 30 min once.
After that, ARIA runs itself. Every M5 candle = automatic update.
