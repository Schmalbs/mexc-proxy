// ─────────────────────────────────────────────────────────────
// MEXC TREND TRADER — SERVER
// Combines: CORS proxy + password auth + 24/7 bot engine
// API keys live ONLY here as Railway env vars — never in the browser
//
// Railway env vars required:
//   APP_PASSWORD     — password to enter the app
//   MEXC_API_KEY     — your MEXC futures API key
//   MEXC_API_SECRET  — your MEXC futures API secret
// ─────────────────────────────────────────────────────────────
const http   = require('http');
const https  = require('https');
const SERVER_BUILD = '2026-06-14.76';
const fs = require('fs');

// ── PERSISTENCE ── Railway mounts a volume at RAILWAY_VOLUME_MOUNT_PATH.
// We write all critical state there so it survives restarts/redeploys. Falls
// back to a local dir when the volume isn't present (e.g. local testing).
const STATE_DIR  = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
const STATE_FILE = STATE_DIR + '/trader-state.json';
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch(e){}

let _saveTimer = null;
function saveState(){
  // debounced: coalesce rapid changes into one write
  if(_saveTimer) return;
  _saveTimer = setTimeout(()=>{
    _saveTimer = null;
    try{
      const state = {
        v: 1, savedAt: Date.now(),
        bots, botIdCounter,
        patternBot: aiBots && aiBots.pattern ? {
          enabled: aiBots.pattern.enabled, paper: aiBots.pattern.paper,
          allocation: aiBots.pattern.allocation, startEquity: aiBots.pattern.startEquity,
          decisionTf: aiBots.pattern.decisionTf, symbol: aiBots.pattern.symbol,
          lineSource: aiBots.pattern.lineSource,
          position: aiBots.pattern.position, realizedPnl: aiBots.pattern.realizedPnl,
          tradeHistory: aiBots.pattern.tradeHistory, decisions: aiBots.pattern.decisions,
          lastDecisionCandle: aiBots.pattern.lastDecisionCandle,
        } : null,
        patternJournal,
        researchLibrary, libraryEnabled,
        savedChartLines,
        sentimentCache,
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    }catch(e){ console.log('[STATE] save failed:', e.message); }
  }, 1500);
}
function loadState(){
  try{
    if(!fs.existsSync(STATE_FILE)) return null;
    const st = JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    console.log(`[STATE] restored from ${STATE_FILE} (saved ${new Date(st.savedAt).toISOString()})`);
    return st;
  }catch(e){ console.log('[STATE] load failed:', e.message); return null; }
}
const crypto = require('crypto');
const { URL } = require('url');

const PORT          = process.env.PORT || 8080;
const APP_PASSWORD  = process.env.APP_PASSWORD  || '';
const MEXC_KEY      = process.env.MEXC_API_KEY    || '';
const MEXC_SECRET   = process.env.MEXC_API_SECRET || '';
const FUTURES_BASE  = 'https://contract.mexc.com';
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT       = process.env.TELEGRAM_CHAT_ID   || '';

// ── Telegram alerts ──
function sendTelegram(msg){
  if(!TG_TOKEN || !TG_CHAT) return;
  const data = JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TG_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  }, res => { res.on('data',()=>{}); });
  req.on('error', ()=>{});
  req.write(data);
  req.end();
}

// ── Contract discovery: real contract sizes for every MEXC futures symbol ──
let CONTRACTS = {}; // {symbol: {contractSize, maxLeverage, displayName}}
async function refreshContracts(){
  try{
    const d = await mexcPublic('/api/v1/contract/detail');
    if(d && d.success && Array.isArray(d.data)){
      const map = {};
      for(const c of d.data){
        map[c.symbol] = {
          contractSize: parseFloat(c.contractSize)||0.0001,
          maxLeverage: c.maxLeverage||100,
          displayName: c.displayNameEn||c.symbol,
        };
      }
      CONTRACTS = map;
      blog(`📚 Contract list refreshed: ${Object.keys(map).length} symbols (incl. stocks/indices/metals)`,'ok');
    }
  }catch(e){ blog('contract refresh failed: '+e.message,'warn'); }
}
function contractSize(symbol){
  return (CONTRACTS[symbol] && CONTRACTS[symbol].contractSize) || 0.0001;
}
// Delay first refresh until the module is fully initialized (blog/botLogs exist)
setTimeout(refreshContracts, 2500);
setInterval(refreshContracts, 6*3600*1000);

// ── Saved chart lines (synced across devices; cleared on restart) ──
let savedChartLines = {}; // { symbol: {lines:[...]} }

// ── Pattern-bot trading journal & standing instructions ──
// In-memory (cleared on restart) but mirrored to the AI page's localStorage,
// which re-seeds the server on reconnect. Entries: {id, t, kind, text}.
//   kind: 'instruction' = standing rule the bot always follows
//         'note'        = an observation/lesson to weigh
//         'chat'        = conversation turn (not fed into trade decisions)
let patternJournal = [];
function journalForPrompt(){
  const instr = patternJournal.filter(e=>e.kind==='instruction');
  const notes = patternJournal.filter(e=>e.kind==='note');
  let out = '';
  if(instr.length) out += `STANDING INSTRUCTIONS FROM THE TRADER (always follow these):\n${instr.map(e=>`• ${e.text}`).join('\n')}\n\n`;
  if(notes.length) out += `TRADER'S JOURNAL — observations & lessons to weigh before entering (most recent last):\n${notes.slice(-20).map(e=>`• ${e.text}`).join('\n')}`;
  return out.trim();
}

// ── RESEARCH LIBRARY ──
// Curated companion conversations (your trade reasoning + the companion's
// feedback). The pattern bot reads these to understand HOW YOU THINK, leaning
// toward your style — but it can override if it strongly disagrees on risk.
// Master switch (libraryEnabled) lets you turn this off from the AI page.
let researchLibrary = [];        // [{id, t, plan, feedback, symbol, outcome, outcomePct}]
let LIBRARY_FEED_N = 15;          // how many entries feed the bot's prompt
let libraryEnabled = true;
function rankLibrary(){
  // Outcome-weighted selection of the most useful entries:
  //  • WINNERS (reasoning that preceded a profitable trade) rank highest, best P&L first
  //  • UNRATED entries (no trade outcome yet) come next, most recent first
  //  • LOSERS rank lowest and age out (kept only if room remains)
  // This keeps the reasoning that actually worked and lets failed reasoning fade.
  const wins   = researchLibrary.filter(e=>e.outcome==='win').sort((a,b)=>(b.outcomePct||0)-(a.outcomePct||0));
  const unrated= researchLibrary.filter(e=>!e.outcome).sort((a,b)=>b.t-a.t);
  const losses = researchLibrary.filter(e=>e.outcome==='loss').sort((a,b)=>b.t-a.t);
  return [...wins, ...unrated, ...losses];
}
function libraryForPrompt(){
  if(!libraryEnabled || !researchLibrary.length) return '';
  const recent = rankLibrary().slice(0, LIBRARY_FEED_N);
  return `THE TRADER'S RESEARCH LIBRARY — their own trade reasoning, companion feedback, and strategy chats from past setups. Use this to understand HOW THIS TRADER THINKS and lean toward their documented style and preferences. Treat it as a STRONG STEER, not an absolute command: if a setup strongly violates sound risk management, you may override it, but say so explicitly and explain why. Entries tagged [bot chat] are past conversations with you — weigh the TRADER's words in them, not your own replies.\n` +
    recent.map(e=>{
      const tag = e.outcome ? ` [${e.outcome.toUpperCase()} ${e.outcomePct>=0?'+':''}${e.outcomePct}%]` : '';
      const isChat = (e.plan||'').startsWith('[bot chat]');
      if(isChat) return `— [${new Date(e.t).toISOString().slice(0,10)}]${tag} CHAT — trader said: ${e.plan.replace('[bot chat]','').trim()}`;
      return `— [${new Date(e.t).toISOString().slice(0,10)}]${tag} PLAN: ${e.plan}${e.feedback?`\n   COMPANION NOTED: ${e.feedback.slice(0,300)}`:''}`;
    }).join('\n');
}

// ── Public data cache (3s TTL) ──
const proxyCache = new Map();
const mexcPublicCache = new Map();

// ── Session tokens (in-memory) ──
const tokens = new Set();
function newToken(){ const t = crypto.randomBytes(24).toString('hex'); tokens.add(t); return t; }
function checkAuth(req){ return tokens.has(req.headers['x-auth']||''); }

// ── MEXC signed request helper ──
function mexcRequest(method, path, bodyObj){
  return new Promise((resolve, reject)=>{
    const ts   = Date.now();
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    // MEXC futures signature: HMAC-SHA256(apiKey + timestamp + body?) — param string for GET
    const sigPayload = MEXC_KEY + ts + (method==='POST' ? body : '');
    const signature  = crypto.createHmac('sha256', MEXC_SECRET).update(sigPayload).digest('hex');
    const u = new URL(FUTURES_BASE + path);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'ApiKey': MEXC_KEY,
        'Request-Time': String(ts),
        'Signature': signature,
        'Content-Type': 'application/json',
      }
    };
    const req = https.request(opts, res=>{
      let data=''; res.on('data',d=>data+=d);
      res.on('end',()=>{ try{ resolve(JSON.parse(data)); }catch(e){ resolve({success:false,raw:data}); } });
    });
    req.on('error', reject);
    if(body) req.write(body);
    req.end();
  });
}

// Public (unsigned) GET to MEXC — cached 3s so multiple bots share one call
function mexcPublic(path){
  const cached = mexcPublicCache.get(path);
  if(cached && Date.now() - cached.t < 3000) return Promise.resolve(cached.v);
  return new Promise((resolve, reject)=>{
    https.get(FUTURES_BASE + path, res=>{
      let data=''; res.on('data',d=>data+=d);
      res.on('end',()=>{
        try{
          const v = JSON.parse(data);
          if(v && v.success){
            mexcPublicCache.set(path, { t: Date.now(), v });
            if(mexcPublicCache.size > 100){
              mexcPublicCache.delete(mexcPublicCache.keys().next().value);
            }
          }
          resolve(v);
        }catch(e){ resolve(null); }
      });
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────
// BOT ENGINE — runs 24/7 server-side
// ─────────────────────────────────────────────────────────────
let bots         = [];   // [{id, config, activeTrade, lastCandleTime, lastTpCandle, lastSlCandle, syncCounter}]
let botIdCounter = 0;
let botLogs      = [];    // recent log lines for client display

function blog(msg, type=''){
  const line = { t: new Date().toISOString(), msg, type };
  botLogs.push(line);
  if(botLogs.length > 500) botLogs.shift();
  console.log(`[BOT] ${msg}`);
}

// Expand a rule that names multiple timeframes (tfs:[...]) into one rule per
// timeframe, so the proven single-tf enforcement handles each independently.
// A single-tf rule passes through unchanged.
function expandExitRules(rules){
  const out = [];
  for(const r of (rules||[])){
    if(Array.isArray(r.tfs) && r.tfs.length){
      for(const tf of r.tfs){
        out.push(Object.assign({}, r, { tf, tfs: undefined, _group: r.label || ('multi-'+r.operator+'-'+(r.level||r.lineId)) }));
      }
    } else {
      out.push(r);
    }
  }
  return out;
}

function priceOnLine(line, t){
  if(line.isHoriz) return line.horizPrice;
  const slope = (line.p2.price - line.p1.price) / (line.p2.time - line.p1.time);
  return line.p1.price + slope * (t - line.p1.time);
}

async function getLastClosedCandle(symbol, interval){
  const d = await mexcPublic(`/api/v1/contract/kline/${symbol}?interval=${interval}&limit=5`);
  if(!d || !d.success || !d.data || !d.data.time || d.data.time.length < 2) return null;
  const i = d.data.time.length - 2;
  const prevClose = i>=1 ? parseFloat(d.data.close[i-1]) : null;
  // prior two candles (for rejection wicks / morning-evening star detection)
  const at = j => (j>=0 && j<d.data.time.length) ? {
    o:parseFloat(d.data.open[j]), h:parseFloat(d.data.high[j]),
    l:parseFloat(d.data.low[j]), c:parseFloat(d.data.close[j])
  } : null;
  return { time: parseInt(d.data.time[i]), close: parseFloat(d.data.close[i]),
           open: parseFloat(d.data.open[i]),
           high: parseFloat(d.data.high[i]), low: parseFloat(d.data.low[i]), prevClose,
           c1: at(i-1), c2: at(i-2) }; // c1 = prior candle, c2 = two back
}

async function getTicker(symbol){
  const d = await mexcPublic(`/api/v1/contract/ticker?symbol=${symbol}`);
  if(!d || !d.success) return null;
  const t = Array.isArray(d.data) ? d.data[0] : d.data;
  return t ? parseFloat(t.lastPrice) : null;
}

// Place a stop-market order directly on MEXC (survives server restarts)
// MEXC futures stop order: /api/v1/private/planorder/place
// side: 1=open long, 2=close short, 3=open short, 4=close long
// executeCycle: 1=always, triggerType: 1=mark price
async function placeStopOrder(symbol, side, vol, triggerPrice, leverage){
  // MEXC planorder/place — parameters verified against CCXT's working implementation.
  // The 3002 error was caused by the MISSING triggerType field (not orderType).
  //   triggerType: 1 = last price, 2 = fair price, 3 = index price
  //   trend (CORRECTED 2026-06-14 after a live long-stop fired INSTANTLY):
  //     trend 1 = trigger when price falls to/BELOW triggerPrice
  //     trend 2 = trigger when price rises to/ABOVE triggerPrice
  //   Evidence: a long's stop at 63200 with trend:2 filled immediately at 64473
  //   (price was already above 63200 → "rises to/above" was already true). So a
  //   PROTECTIVE STOP must use:
  //     long position  (close side 4): fires when price FALLS  → trend 1
  //     short position (close side 2): fires when price RISES   → trend 2
  const isLongStop = (side === 4); // closing a long
  const payload = {
    symbol,
    side,                       // 4 = close long, 2 = close short
    vol,
    leverage: leverage||1,
    openType: 1,                // isolated
    triggerPrice,
    triggerType: 1,             // last price
    executeCycle: 2,            // until cancelled
    orderType: 1,
    trend: isLongStop ? 1 : 2,  // CORRECTED: long stop fires on FALL (1), short stop on RISE (2)
    price: triggerPrice,
  };
  // Safety guard: a protective stop must be on the correct side of the trigger
  // direction. If something tries to place a long-stop whose trigger sits ABOVE
  // current handling, MEXC could fire it instantly — we at least log loudly.
  blog(`→ STOP ORDER (${isLongStop?'LONG stop, fires on FALL':'SHORT stop, fires on RISE'}) trigger $${triggerPrice}`, 'info');
  blog(`→ STOP ORDER ${JSON.stringify(payload)}`, 'info');
  const res = await mexcRequest('POST', '/api/v1/private/planorder/place', payload);
  blog(`← STOP ORDER RESPONSE ${JSON.stringify(res).slice(0,200)}`, res.success?'info':'err');
  return res;
}

// Cancel a stop order by ID
async function cancelStopOrder(symbol, orderId){
  if(!orderId) return;
  const res = await mexcRequest('POST', '/api/v1/private/planorder/cancel', {
    symbol, orderId: String(orderId)
  });
  blog(`Cancel stop order ${orderId}: ${res.success?'✓':'✗ '+JSON.stringify(res).slice(0,100)}`, res.success?'info':'warn');
  return res;
}

async function placeOrder(symbol, side, vol, leverage, openType, price, type){
  // side: 1=open long, 3=open short, 4=close long, 2=close short
  // type: 5=market, 1=limit
  const payload = { symbol, price: price||0, vol, side, type: type||5, openType: openType||1, leverage: leverage||1 };
  blog(`→ ORDER ${JSON.stringify(payload)}`, 'info');
  const res = await mexcRequest('POST', '/api/v1/private/order/submit', payload);
  blog(`← ORDER RESPONSE ${JSON.stringify(res).slice(0,300)}`, res.success?'info':'err');
  return res;
}

async function botTick(){
  // Iterate over a copy so disarms during the loop are safe
  for(const bot of [...bots]){
    await runBot(bot).catch(e => blog(`Bot #${bot.id} tick error: ${e.message}`,'err'));
  }
}

// ── AI-JUDGED SWING (opt-in alternative to mechanical detection) ──
// Asks Claude whether the just-closed candle is a genuine swing entry at the
// line. Uses Sonnet (cheap) since this runs per candle on armed swing bots.
async function aiSwingJudge(symbol, tf, side, lp, candle){
  if(!ANTHROPIC_KEY) return null;
  const k = await mexcPublic(`/api/v1/contract/kline/${symbol}?interval=${tf}&limit=30`);
  if(!k || !k.success) return null;
  const closes=k.data.close.map(Number), highs=k.data.high.map(Number), lows=k.data.low.map(Number), opens=k.data.open.map(Number);
  // Drop the still-forming candle (MEXC returns it as the last element) so the
  // newest candle the AI sees is the genuinely CLOSED one — matches live behaviour.
  const n = closes.length - 1; // exclusive end = exclude forming candle
  const startI = Math.max(0, n - 20);
  const recent = [];
  for(let i=startI; i<n; i++) recent.push(`O${opens[i]} H${highs[i]} L${lows[i]} C${closes[i]}`);
  const recentStr = recent.join('\n');
  const longRules = `For a LONG (support holding / bullish reversal) at the line, look for ANY of these — judged across the LAST FEW candles, not just one:
- A wick at/below the line (within ~0.15%) that CLOSES back above it (support held / bullish SFP / liquidity sweep)
- A bullish REJECTION candle at the line: long lower wick, closes in the upper part of its range
- A MORNING STAR at the line: a down candle, then a small-bodied candle near the line, then a strong up candle closing back into the first candle's body (3-candle pattern)
- A bullish ENGULFING at the line: a down candle fully engulfed by the next up candle
- Optional confirmation: a following candle that holds above the line adds conviction`;
  const shortRules = `For a SHORT (resistance holding / bearish reversal) at the line, look for ANY of these — judged across the LAST FEW candles, not just one:
- A wick at/above the line (within ~0.15%) that CLOSES back below it (resistance held / bearish SFP / liquidity sweep)
- A bearish REJECTION candle at the line: long upper wick, closes in the lower part of its range
- An EVENING STAR at the line: an up candle, then a small-bodied candle near the line, then a strong down candle closing back into the first candle's body (3-candle pattern)
- A bearish ENGULFING at the line: an up candle fully engulfed by the next down candle
- Optional confirmation: a following candle that holds below the line adds conviction`;
  const prompt = `You are judging whether to take a swing ${side==='BUY'?'LONG':'SHORT'} at the level $${lp.toFixed(2)} on ${symbol} (${tf}).

${side==='BUY'?longRules:shortRules}

IMPORTANT: A valid reversal often takes MORE THAN ONE candle to confirm — a sweep candle then a reclaim, or the three candles of a star. You are given the recent candles so you can judge the pattern as it develops, not just the single most-recent close. Be conservative: a mere touch with no rejection, price slicing cleanly through the level, or an ambiguous candle is NOT an entry — answer false and wait. Only enter on a genuine, recognisable rejection/reversal at THIS level.

Last 20 ${tf} candles (oldest first, newest last):
${recentStr}

The newest candle above is the just-closed one. Level: $${lp.toFixed(2)}.
Respond ONLY JSON: {"enter":true|false,"pattern":"name the pattern or 'none'","reason":"under 15 words"}`;
  try{
    const raw = await callClaude(prompt, DECISION_MODEL); // Opus — swing bots fire rarely, so the per-call cost is negligible
    const d = JSON.parse(raw.replace(/```json|```/g,'').trim());
    return { enter: !!d.enter, reason: (d.pattern && d.pattern!=='none' ? d.pattern+': ' : '') + (d.reason||'') };
  }catch(e){ return null; }
}

// ── MECHANICAL SWING DETECTION (for trigger-bot swing mode) ──
// Given the just-closed candle and a line price, decide if it's a valid swing
// LONG (support held / bullish SFP / bullish rejection wick / morning star) or
// SHORT (resistance held / bearish SFP / bearish rejection wick / evening star).
// All deterministic — no AI. tol = proximity fraction (e.g. 0.0015 for 0.15%).
function detectSwingSignal(candle, lp, wantSide, tol){
  const { open:o, high:h, low:l, close:c, c1, c2 } = candle;
  const near = (price) => Math.abs(price - lp) <= lp * tol;
  const range = (h - l) || 1;
  const body = Math.abs(c - o);
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;
  const reasons = [];

  if(wantSide === 'BUY'){
    // 1. Support held / bullish SFP: low tested the line (touch, pierce, or within tol) and close is back above
    if((l <= lp || near(l)) && c > lp) reasons.push('support held / bullish SFP (low tested line, closed above)');
    // 2. Bullish rejection candle near the line: long lower wick, closes in upper third
    if(near(l) || near(Math.min(o,c))){
      if(lowerWick >= range*0.5 && c >= h - range*0.34) reasons.push('bullish rejection wick at line');
    }
    // 3. Morning star at the line (c2 bearish, c1 small body, current bullish closing into c2 body), low near line
    if(c1 && c2){
      const b2 = Math.abs(c2.c-c2.o), b1 = Math.abs(c1.c-c1.o), avg = (body+b1+b2)/3 || 1;
      if(c2.c < c2.o && b1 < avg*0.6 && c > o && c > (c2.o+c2.c)/2 && b2 > avg*0.6 && (near(l)||near(c1.l)))
        reasons.push('morning star at line');
    }
    return reasons.length ? reasons[0] : null;
  } else { // SELL
    if((h >= lp || near(h)) && c < lp) reasons.push('resistance held / bearish SFP (high tested line, closed below)');
    if(near(h) || near(Math.max(o,c))){
      if(upperWick >= range*0.5 && c <= l + range*0.34) reasons.push('bearish rejection wick at line');
    }
    if(c1 && c2){
      const b2 = Math.abs(c2.c-c2.o), b1 = Math.abs(c1.c-c1.o), avg = (body+b1+b2)/3 || 1;
      if(c2.c > c2.o && b1 < avg*0.6 && c < o && c < (c2.o+c2.c)/2 && b2 > avg*0.6 && (near(h)||near(c1.h)))
        reasons.push('evening star at line');
    }
    return reasons.length ? reasons[0] : null;
  }
}

async function runBot(bot){
  const cfg = bot.config;
  bot.syncCounter = (bot.syncCounter||0) + 1;

  // ── POSITION SYNC CHECK every ~32s ──
  if(bot.activeTrade && bot.syncCounter % 4 === 0){
    const d = await mexcRequest('GET','/api/v1/private/position/open_positions');
    if(d.success){
      const stillOpen = (d.data||[]).some(p =>
        p.symbol === cfg.symbol && parseFloat(p.holdVol) > 0 &&
        ((bot.activeTrade.side==='BUY'  && p.positionType===1) ||
         (bot.activeTrade.side==='SELL' && p.positionType===2)));
      if(!stillOpen){
        // Work out WHY it closed: our own stop-loss, or something external.
        const t = bot.activeTrade;
        let reason = 'closed externally (manual/liquidation/TP)';
        let exitPrice = null, pnl = null;
        try{
          // Pull recent closed orders for this symbol and inspect them
          const hist = await mexcRequest('GET', `/api/v1/private/order/list/history_orders?symbol=${cfg.symbol}&page_num=1&page_size=20`);
          if(hist.success && Array.isArray(hist.data)){
            // Did our stop-loss order fill?
            const slFill = t.mexcSlOrderId
              ? hist.data.find(o => String(o.orderId)===String(t.mexcSlOrderId) && (o.state===3 || o.dealVol>0))
              : null;
            // Most recent close-side fill (side 4 closes long, side 2 closes short)
            const closeSide = t.side==='BUY' ? 4 : 2;
            const lastClose = hist.data.find(o => o.side===closeSide && o.dealVol>0);
            if(slFill){
              reason = 'STOP-LOSS filled on MEXC';
              exitPrice = parseFloat(slFill.dealAvgPrice || slFill.price || t.slPrice);
            } else if(lastClose){
              exitPrice = parseFloat(lastClose.dealAvgPrice || lastClose.price);
              // classify by where it filled relative to entry
              const dir = t.side==='BUY' ? 1 : -1;
              reason = ((exitPrice - t.entryPrice)*dir >= 0) ? 'closed in profit (TP or manual)' : 'closed in loss (manual/liquidation)';
            }
          }
        }catch(e){}
        if(exitPrice!=null){
          const dir = t.side==='BUY' ? 1 : -1;
          pnl = (exitPrice - t.entryPrice) * t.qty * contractSize(cfg.symbol) * dir;
        }
        const pnlStr = pnl!=null ? ` | ${pnl>=0?'+':''}$${pnl.toFixed(2)}` : '';
        const exitStr = exitPrice!=null ? ` @ $${exitPrice}` : '';
        blog(`${pnl!=null&&pnl<0?'🔻':'💰'} Bot #${bot.id} ${t.side} closed — ${reason}${exitStr}${pnlStr}`, pnl!=null&&pnl<0?'err':'ok');
        sendTelegram(`${pnl!=null&&pnl<0?'🔻':'💰'} <b>Bot #${bot.id} ${t.side} closed</b>\n${reason}${exitStr}${pnlStr}`);
        bot.activeTrade = null;
        retireBot(bot, reason);
        saveState();
        return;
      }
    }
  }

  // ── Manage open trade exits ──
  if(bot.activeTrade){
    const t = bot.activeTrade;
    const price = t.tp.mode==='price' || t.sl.mode==='price'
      ? await getTicker(cfg.symbol) : null;

    // ── CUSTOM EXIT RULES (plain-English rules, deterministically enforced) ──
    // Two kinds, both close-only and fully deterministic (no AI in this loop):
    //   kind 'simple'        : {tf, operator:'below'|'above', level|lineId} → close when a candle closes past the level
    //   kind 'failed_retest' : {tf, operator:'below'|'above', level|lineId, retestPct}
    //        Stage 1: a candle closes PAST the level (below for 'below').
    //        Stage 2: a LATER candle wicks back to the level (high reaches it,
    //                 or comes within retestPct%) but CLOSES back past it again → close.
    if(Array.isArray(t.customExits) && t.customExits.length){
      t._customExitCandle = t._customExitCandle || {};
      t._retestStage = t._retestStage || {};   // per-rule: has the initial break happened?
      for(let ri=0; ri<t.customExits.length; ri++){
        const rule = t.customExits[ri];
        const c = await getLastClosedCandle(cfg.symbol, rule.tf);
        if(!c) continue;
        const ruleKey = (rule.kind||'simple') + ':' + ri + ':' + rule.tf + ':' + (rule.lineId!=null?('L'+rule.lineId):rule.level);
        // evaluate each rule at most once per new candle on its timeframe
        if(t._customExitCandle[ruleKey] === c.time) continue;
        t._customExitCandle[ruleKey] = c.time;
        // resolve the level (price, or line value at this candle's time)
        let lvl = rule.level;
        if(rule.lineId != null){
          const ln = (cfg.lines||[]).find(L=>String(L.id)===String(rule.lineId));
          if(ln) lvl = priceOnLine(ln, c.time);
        }
        if(lvl == null) continue;
        const below = rule.operator==='below';
        const closedPast = below ? c.close < lvl : c.close > lvl;

        if((rule.kind||'simple') === 'simple'){
          if(closedPast){
            blog(`📜 Bot #${bot.id} CUSTOM EXIT: ${rule.tf} close ${rule.operator} ${lvl.toFixed(2)} (${c.close}) — closing`, 'warn');
            sendTelegram(`📜 <b>Bot #${bot.id} custom exit</b>\n"${rule.label||(rule.tf+' close '+rule.operator+' '+lvl.toFixed(2))}"\nClosed at $${c.close}.`);
            return exitTrade(bot, 'custom rule', c.close, t.activeTpCount||0);
          }
          // ONE-SHOT: if this rule only watches the NEXT candle, and that candle
          // just closed without triggering, retire the rule (it won't fire later).
          if(rule.onceOnly){
            t.customExits.splice(ri, 1);
            blog(`📜 Bot #${bot.id} one-shot exit rule expired — the next ${rule.tf} candle closed at ${c.close} without breaching ${lvl.toFixed(2)}. Rule removed.`, 'info');
            sendTelegram(`📜 <b>Bot #${bot.id} one-shot rule expired</b>\nThe next ${rule.tf} candle didn't close ${rule.operator} ${lvl.toFixed(2)} — rule removed, trade continues.`);
            saveState();
            ri--; // array shifted; adjust index
          }
          continue;
        }

        if(rule.kind === 'failed_retest'){
          const pct = (rule.retestPct != null ? rule.retestPct : 0.1) / 100;
          // Stage 1 — wait for the initial break (a close past the level)
          if(!t._retestStage[ruleKey]){
            if(closedPast){
              t._retestStage[ruleKey] = true;
              blog(`📜 Bot #${bot.id} failed-retest rule: break confirmed (${rule.tf} closed ${rule.operator} ${lvl.toFixed(2)} @ ${c.close}). Now watching for a failed retest.`, 'info');
            }
            continue;
          }
          // Stage 2 — break already happened; look for the rejection candle:
          // its high reached the line (or came within pct), but it closed back past.
          const reachedLine = below
            ? (c.high >= lvl || c.high >= lvl * (1 - pct))   // wicked up to/through, or within pct below
            : (c.low  <= lvl || c.low  <= lvl * (1 + pct));
          if(reachedLine && closedPast){
            blog(`📜 Bot #${bot.id} CUSTOM EXIT: failed retest of ${lvl.toFixed(2)} — ${rule.tf} high ${c.high} reached line then closed ${rule.operator} at ${c.close}. Closing.`, 'warn');
            sendTelegram(`📜 <b>Bot #${bot.id} failed-retest exit</b>\n"${rule.label||('failed retest of '+lvl.toFixed(2))}"\n${rule.tf} candle wicked to the line and closed ${rule.operator} ($${c.close}). Closing position.`);
            return exitTrade(bot, 'failed retest', c.close, t.activeTpCount||0);
          }
          continue;
        }
      }
    }

    // ── STOP LOSS ──
    if(price != null && t.sl.mode==='price'){
      const slHit = t.side==='BUY' ? price <= t.slPrice : price >= t.slPrice;
      if(slHit) return exitTrade(bot, 'SL', price, t.activeTpCount||0);
    }
    if(t.sl.mode==='candle'){
      const c = await getLastClosedCandle(cfg.symbol, t.sl.tf);
      if(c && c.time !== bot.lastSlCandle){
        bot.lastSlCandle = c.time;
        const slHit = t.side==='BUY' ? c.close <= t.slPrice : c.close >= t.slPrice;
        if(slHit) return exitTrade(bot, 'SL (candle)', c.close, t.activeTpCount||0);
      }
    }

    // ── MULTI-TP LEVELS ──
    const tpLevels = t.tpLevels || [{pct: t.tpPct||2, size:100}];
    const checkPrice = t.tp.mode==='price' ? price : null;
    const checkCandle = t.tp.mode==='candle'
      ? await getLastClosedCandle(cfg.symbol, t.tp.tf) : null;

    let tpFired = false;
    for(let i = (t.activeTpCount||0); i < tpLevels.length; i++){
      const lvl = tpLevels[i];
      const tpPrice = lvl.type==='price'
        ? lvl.price
        : (t.side==='BUY'
          ? t.entryPrice * (1 + lvl.pct/100)
          : t.entryPrice * (1 - lvl.pct/100));

      let hit = false;
      if(t.tp.mode==='price' && checkPrice != null)
        hit = t.side==='BUY' ? checkPrice >= tpPrice : checkPrice <= tpPrice;
      if(t.tp.mode==='candle' && checkCandle && checkCandle.time !== bot.lastTpCandle){
        hit = t.side==='BUY' ? checkCandle.close >= tpPrice : checkCandle.close <= tpPrice;
        if(hit) bot.lastTpCandle = checkCandle.time;
      }

      if(hit){
        const exitVol = Math.max(1, Math.round(t.qty * lvl.size/100));
        const isLast  = (i === tpLevels.length - 1);
        blog(`🎯 Bot #${bot.id} TP${i+1} hit @ ${checkPrice||checkCandle?.close} | closing ${lvl.size}% (${exitVol} contracts)`, 'ok');
        const lvlLabel = lvl.type==='price' ? `$${lvl.price}` : `+${lvl.pct}%`;
        sendTelegram(`🎯 <b>Bot #${bot.id} TP${i+1} hit!</b> ${cfg.symbol}\nLevel: ${lvlLabel} | Closing ${lvl.size}% of position\nPrice: $${checkPrice||checkCandle?.close}`);

        const closeSide = t.side==='BUY' ? 4 : 2;
        const r = await placeOrder(cfg.symbol, closeSide, exitVol, t.leverage, 1, 0, 5);
        if(r.success){
          t.qty -= exitVol;
          t.activeTpCount = i + 1;
          if(isLast || t.qty <= 0){
            // All TPs done — trade fully closed
            bot.activeTrade = null;
            blog(`✅ Bot #${bot.id} all TPs complete — trade closed`, 'ok');
            retireBot(bot, 'all take-profits completed');
          } else {
            // Move SL to break-even if checkbox was set
            if(t.breakEvenOnHit && t.slPrice !== t.entryPrice){
              t.slPrice = t.entryPrice;
              blog(`🔒 Bot #${bot.id} SL moved to break-even @ $${t.entryPrice}`, 'ok');
              // Cancel old SL order on MEXC and place new one at break-even
              if(t.mexcSlOrderId){
                await cancelStopOrder(cfg.symbol, t.mexcSlOrderId).catch(()=>{});
                const closeSide = t.side==='BUY' ? 4 : 2;
                const beRes = await placeStopOrder(cfg.symbol, closeSide, t.qty, t.entryPrice, t.leverage).catch(()=>({}));
                t.mexcSlOrderId = beRes.success ? beRes.data : null;
                blog(`Break-even SL on MEXC: ${beRes.success?'✓ ID:'+beRes.data:'✗ server-managed fallback'}`, beRes.success?'ok':'warn');
              }
              sendTelegram(`🔒 <b>Bot #${bot.id} SL → break-even</b> @ $${t.entryPrice}${t.mexcSlOrderId?' (updated on exchange ✓)':' (server-managed)'}`);
            }
            blog(`Bot #${bot.id} remaining qty: ${t.qty} — next TP: TP${i+2} at +${tpLevels[i+1]?.pct||'?'}%`, 'info');
          }
          tpFired = true;
          break; // only fire one TP level per tick
        } else {
          blog(`Bot #${bot.id} TP${i+1} order error: ${JSON.stringify(r).slice(0,150)}`, 'err');
        }
      }
    }
    if(tpFired) return;
    return; // trade open — don't look for new entries
  }

  // Manual-trade bots only manage exits — no entry triggers
  if(cfg.manualOnly) {
    // trade closed and nothing to watch → remove this bot
    bots = bots.filter(b => b.id !== bot.id);
    return;
  }

  // ── Look for entry trigger ──
  if(bot.fired) return; // one-shot: this bot already opened its trade
  const candle = await getLastClosedCandle(cfg.symbol, cfg.trigTf);
  if(!candle || candle.time === bot.lastCandleTime) return;
  bot.lastCandleTime = candle.time;

  const dir  = cfg.dir;
  const isSwing = dir === 'swingLong' || dir === 'swingShort';
  const side = (dir==='above' || dir==='swingLong') ? 'BUY' : 'SELL';
  let triggered = false, triggerLabel = '';
  const swingTol = (cfg.swingTolPct != null ? cfg.swingTolPct : 0.15) / 100;

  // PENETRATION BUFFER: the close must clear the level by this fraction, so a
  // fractional poke through a line (esp. a rising trend line price is riding
  // along) doesn't count as a real break. Default 0.1%; set cfg.breakBufferPct
  // to 0 to restore exact-touch behaviour.
  const bufPct = (cfg.breakBufferPct != null ? cfg.breakBufferPct : 0.1) / 100;
  const above = (close, level) => close > level * (1 + bufPct);
  const below = (close, level) => close < level * (1 - bufPct);

  if(cfg.triggerSource === 'price'){
    const tp = parseFloat(cfg.manualPrice);
    if(isSwing){
      if(cfg.swingMode === 'ai'){
        const verdict = await aiSwingJudge(cfg.symbol, cfg.trigTf, side, tp, candle).catch(()=>null);
        triggered = !!(verdict && verdict.enter);
        triggerLabel = `price ${tp} — AI swing${triggered?': '+(verdict.reason||''):''}`;
      } else {
        const sig = detectSwingSignal(candle, tp, side, swingTol);
        triggered = !!sig;
        triggerLabel = `price ${tp} — ${sig||'no swing signal'}`;
      }
    } else {
      triggered = (dir==='above' && above(candle.close, tp)) || (dir==='below' && below(candle.close, tp));
      triggerLabel = `manual price ${tp}`;
    }
  } else {
    // 'all' is no longer offered in the UI. A legacy bot still carrying 'all'
    // is neutralised here: we require a single explicit line. This prevents the
    // old "fires below the highest line" trap on any bot armed before this fix.
    if(cfg.selectedLineId==='all'){
      retireBot(bot, `legacy "all lines" bot retired — re-arm on a single specific line`);
      return;
    }
    const lines = cfg.lines.filter(l => String(l.id)===String(cfg.selectedLineId));

    // A trend line is only valid WITHIN its drawn segment. Beyond the last
    // drawn point, the projection would cut through unrelated S/R — so the
    // line expires there. Horizontal lines never expire.
    const validLines = lines.filter(l =>
      l.isHoriz || candle.time <= Math.max(l.p1.time, l.p2.time));

    if(lines.length && !validLines.length){
      const ex = lines[0];
      retireBot(bot, `trend line #${ex.id} segment ended (drawn until ${new Date(Math.max(ex.p1.time,ex.p2.time)*1000).toISOString().slice(0,16)}Z) — extend the line and re-arm if the level still holds`);
      return;
    }

    for(const line of validLines){
      const lp = priceOnLine(line, candle.time);

      // ── SWING MODE (mechanical): support/resistance hold, SFP, rejection wick, star ──
      if(isSwing){
        if(cfg.swingMode === 'ai'){
          // AI-judged swing: ask Claude whether this is a valid swing entry at the line
          const verdict = await aiSwingJudge(cfg.symbol, cfg.trigTf, side, lp, candle).catch(()=>null);
          if(verdict && verdict.enter){ triggered = true; triggerLabel = `line #${line.id} @ ${lp.toFixed(2)} — AI swing: ${verdict.reason||''}`; break; }
          continue;
        }
        const sig = detectSwingSignal(candle, lp, side, swingTol);
        if(sig){ triggered = true; triggerLabel = `line #${line.id} @ ${lp.toFixed(2)} — ${sig}`; break; }
        continue;
      }

      const closedThroughNow = (dir==='above' && above(candle.close, lp)) || (dir==='below' && below(candle.close, lp));
      if(!closedThroughNow) continue;
      // Require a genuine CROSSING: the prior candle must have closed on the
      // OTHER side of the line. Without this, a bot watching a line that price
      // is already past fires immediately (the bug that shorted above your lines).
      if(candle.prevClose != null){
        const wasOnOtherSide = (dir==='above') ? (candle.prevClose <= lp) : (candle.prevClose >= lp);
        if(!wasOnOtherSide){
          // already past this line before — not a fresh break, skip it
          continue;
        }
      }
      triggered = true; triggerLabel = `line #${line.id} @ ${lp.toFixed(4)} (crossed from ${dir==='above'?'below':'above'})`;
      break;
    }
  }

  // ── BREAK + RETEST CONFIRMATION (optional) ──
  if(cfg.retestConfirm && !isSwing){
    const TOL = 0.001; // 0.1% touch tolerance toward the line

    if(bot.phase === 'retest'){
      // We are past the break — judge this candle against the broken line
      const line = cfg.triggerSource==='price'
        ? {id:'price', isHoriz:true, horizPrice: parseFloat(cfg.manualPrice)}
        : (cfg.lines||[]).find(l => l.id === bot.retestLineId);
      if(!line){ retireBot(bot, 'retest line vanished from snapshot'); return; }
      if(!line.isHoriz && candle.time > Math.max(line.p1.time, line.p2.time)){
        retireBot(bot, `trend line #${line.id} segment ended while awaiting retest`);
        return;
      }
      const lp = priceOnLine(line, candle.time);

      if(dir==='above'){ // broke resistance — needs retest as SUPPORT
        if(candle.close < lp){
          bot.phase = null; bot.retestLineId = null;
          blog(`↩️ Bot #${bot.id} breakout FAILED (closed back below line @ ${lp.toFixed(2)}) — watching for the next break`,'warn');
          sendTelegram(`↩️ <b>Bot #${bot.id} breakout failed</b> — candle closed back below the line. No trade. Watching for the next break.`);
          return;
        }
        if(candle.low <= lp*(1+TOL) && candle.close > lp){
          blog(`✅ Bot #${bot.id} RETEST HELD — wick touched ${lp.toFixed(2)}, closed above @ ${candle.close}`,'ok');
          // fall through to entry below
        } else return; // still waiting for the touch
      } else { // broke support — needs retest as RESISTANCE
        if(candle.close > lp){
          bot.phase = null; bot.retestLineId = null;
          blog(`↩️ Bot #${bot.id} breakdown FAILED (closed back above line @ ${lp.toFixed(2)}) — watching for the next break`,'warn');
          sendTelegram(`↩️ <b>Bot #${bot.id} breakdown failed</b> — candle closed back above the line. No trade. Watching for the next break.`);
          return;
        }
        if(candle.high >= lp*(1-TOL) && candle.close < lp){
          blog(`✅ Bot #${bot.id} RETEST HELD — wick touched ${lp.toFixed(2)}, closed below @ ${candle.close}`,'ok');
        } else return;
      }
      triggerLabel = `break+retest of ${triggerLabel||('line #'+bot.retestLineId)}`;
      // confirmed → continue into the entry code below

    } else {
      // No break seen yet — a trigger here is the BREAK, not the entry
      if(!triggered) return;
      const m = triggerLabel.match(/line #(\d+)/);
      bot.retestLineId = cfg.triggerSource==='price' ? 'price'
        : (m ? parseInt(m[1]) : (cfg.lines&&cfg.lines[0]&&cfg.lines[0].id));
      bot.phase = 'retest';
      blog(`🔔 Bot #${bot.id} BREAK detected ${dir} ${triggerLabel} @ ${candle.close} — awaiting retest before entry`,'ok');
      sendTelegram(`🔔 <b>Bot #${bot.id} break detected</b>\n${cfg.symbol} closed ${dir} ${triggerLabel}\n⏳ Waiting for a retest that holds before entering.`);
      return;
    }
  } else {
    if(!triggered) return;
  }

  blog(`🔔 Bot #${bot.id} trigger! Candle closed ${dir} ${triggerLabel} @ ${candle.close}`, 'ok');
  sendTelegram(`🔔 <b>Bot #${bot.id} trigger fired!</b>\n${cfg.symbol} candle closed ${dir} ${triggerLabel}\nClose: $${candle.close}`);

  const entry = candle.close;
  const tpPrice = cfg.tp.type==='price' ? parseFloat(cfg.tp.value)
    : (side==='BUY' ? entry*(1+cfg.tp.value/100) : entry*(1-cfg.tp.value/100));
  // SL price: exact price | % price move | % of margin (converted via leverage)
  let slMovePct = cfg.sl.value;
  if(cfg.sl.type==='margin'){
    slMovePct = cfg.sl.value / (cfg.leverage||1); // 50% margin at 10x = 5% price move
  }
  const slPrice = cfg.sl.type==='price' ? parseFloat(cfg.sl.value)
    : (side==='BUY' ? entry*(1-slMovePct/100) : entry*(1+slMovePct/100));

  if(cfg.leverage > 1){
    await mexcRequest('POST','/api/v1/private/position/change_leverage',{
      symbol: cfg.symbol, leverage: cfg.leverage, openType: cfg.marginType==='isolated'?1:2
    }).catch(()=>{});
  }
  // USDT sizing: convert to integer contracts at the ACTUAL entry price
  let orderQty = cfg.qty;
  if(cfg.qtyUsdt && entry > 0){
    // $X at N× means: $X of YOUR margin, position notional = $X × N (like MEXC's UI)
    orderQty = Math.max(1, Math.round((cfg.qtyUsdt * (cfg.leverage||1)) / entry / contractSize(cfg.symbol)));
  }
  const futSide = side==='BUY' ? 1 : 3;
  const res = await placeOrder(cfg.symbol, futSide, orderQty, cfg.leverage, cfg.marginType==='isolated'?1:2, 0, 5);
  if(res.success){
    bot.failCount = 0;
    bot.fired = true; // one-shot: never trigger a second entry
    blog(`✅ Bot #${bot.id} order placed! ID: ${res.data}`, 'ok');

    // Place a REAL stop-loss order on MEXC (survives server restarts)
    let mexcSlOrderId = null;
    try{
      const closeSide = side==='BUY' ? 4 : 2;
      const slRes = await placeStopOrder(cfg.symbol, closeSide, orderQty, slPrice, cfg.leverage);
      if(slRes.success){
        mexcSlOrderId = slRes.data;
        blog(`✅ Real SL order placed on MEXC @ $${slPrice} (ID: ${mexcSlOrderId})`, 'ok');
      } else {
        blog(`⚠️ Real SL order failed — server-managed SL fallback: ${JSON.stringify(slRes).slice(0,150)}`, 'warn');
      }
    }catch(e){ blog(`SL order error: ${e.message}`, 'warn'); }

    sendTelegram(`✅ <b>Bot #${bot.id}: ${side} order placed</b>\n${cfg.symbol} @ $${entry}\nQty: ${orderQty} | ${cfg.leverage}×\nTP: $${tpPrice.toFixed(4)} | SL: $${slPrice.toFixed(4)}${mexcSlOrderId?' (real SL on exchange ✓)':' (server-managed SL fallback)'}`);
    bot.activeTrade = {
      side, entryPrice: entry,
      tpPrice,
      slPrice,
      qty: orderQty,
      leverage: cfg.leverage,
      tpPct: cfg.tp.value,
      tpLevels: cfg.tp.levels || [{pct: cfg.tp.value||2, size:100}],
      breakEvenOnHit: !!cfg.tp.breakEvenOnHit,
      activeTpCount: 0,
      tp: { mode: cfg.tp.mode, tf: cfg.tp.tf },
      sl: { mode: cfg.sl.mode, tf: cfg.sl.tf },
      customExits: expandExitRules(Array.isArray(cfg.customExits) ? cfg.customExits : []).slice(0,8),
      mexcSlOrderId,
      openedAt: Date.now(),
    };
    bot.lastTpCandle = null; bot.lastSlCandle = null;
    saveState();
  } else {
    bot.failCount = (bot.failCount||0) + 1;
    blog(`Bot #${bot.id} order error (${bot.failCount}/3): ${JSON.stringify(res)}`, 'err');
    if(bot.failCount >= 3){
      bots = bots.filter(b => b.id !== bot.id);
      blog(`Bot #${bot.id} AUTO-DISARMED after 3 consecutive order failures`, 'err');
      sendTelegram(`🛑 <b>Bot #${bot.id} auto-disarmed</b> — 3 consecutive order failures.\nLast error: ${JSON.stringify(res).slice(0,150)}\nCheck qty/settings and re-arm.`);
    } else {
      sendTelegram(`❌ <b>Bot #${bot.id} order failed</b> (${bot.failCount}/3 before auto-disarm)\n${JSON.stringify(res).slice(0,150)}`);
    }
  }
}

function retireBot(bot, why){
  bots = bots.filter(b => b.id !== bot.id);
  blog(`🏁 Bot #${bot.id} RETIRED — ${why}. One-shot: it will not re-enter. Re-arm to watch again.`,'warn');
  saveState();
  sendTelegram(`🏁 <b>Bot #${bot.id} retired</b> — ${why}.\nIt will NOT open another trade. Re-arm from the app if you want it watching again.`);
}

async function exitTrade(bot, reason, price, completedTps){
  const tpNote = completedTps > 0 ? ` (${completedTps} TP${completedTps>1?'s':''} already taken)` : '';
  // Cancel the standing SL order on MEXC before closing (avoids double-close)
  if(bot.activeTrade && bot.activeTrade.mexcSlOrderId){
    await cancelStopOrder(bot.config.symbol, bot.activeTrade.mexcSlOrderId).catch(()=>{});
  }
  if(!bot.activeTrade) return;
  const t = bot.activeTrade;
  const dir = t.side==='BUY'?1:-1;
  const pct = ((price - t.entryPrice)/t.entryPrice*100*dir*(t.leverage||1)).toFixed(2);
  blog(`🏁 Bot #${bot.id} ${reason} hit @ ${price} | P&L: ${pct>=0?'+':''}${pct}%`, pct>=0?'ok':'err');
  const emoji = pct>=0 ? '💰' : '🔻';
  sendTelegram(`${emoji} <b>Bot #${bot.id} ${reason} — trade closed</b>\nExit: $${price}\nP&L: ${pct>=0?'+':''}${pct}%${tpNote}`);
  const closeSide = t.side==='BUY' ? 4 : 2;
  const res = await placeOrder(bot.config.symbol, closeSide, t.qty, t.leverage, 1, 0, 5);
  if(res.success) blog(`✅ Exit order placed. ID: ${res.data}`, 'ok');
  else blog(`Exit order error: ${JSON.stringify(res)}`, 'err');
  // ── Tag the linked research-library entry with the real outcome ──
  if(bot.config && bot.config.linkLibraryEntryId){
    const entry = researchLibrary.find(e=>e.id===bot.config.linkLibraryEntryId);
    if(entry){
      entry.outcomePct = parseFloat(pct);
      entry.outcomeAt = Date.now();
      entry.outcome = pct>=0 ? 'win' : 'loss';
      blog(`📚 Library entry tagged with outcome: ${pct>=0?'+':''}${pct}% (${entry.outcome})`, 'info');
    }
  }
  bot.activeTrade = null;
  retireBot(bot, `trade closed by ${reason}`);
}

setInterval(botTick, 8000); // bot heartbeat every 8s

// ─────────────────────────────────────────────────────────────
// AI TRADER — Claude makes every trading decision via the API
// ─────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const DECISION_MODEL = 'claude-opus-4-8'; // trade decisions use Opus 4.8; everything else stays on Sonnet 4.6
const YOUTUBE_KEY   = process.env.YOUTUBE_API_KEY || '';

// Analyst YouTube channel handles → fetch their latest video via the Data API.
const ANALYST_CHANNELS = [
  { name:'Benjamin Cowen', handle:'@benjaminjcowen' },
  { name:'MMCrypto',       handle:'@MMCryptoTube' },
  { name:'Gareth Soloway', handle:'@GarethSolowayProTrader' },
  { name:'Jason Pizzino',  handle:'@JasonPizzinoOfficial' },
];
// Kyle Stagoll (aka Trader Daxx) features mostly as a guest on other channels,
// so the latest-video API won't capture him — he's covered via web search.

// Fetch the latest video (title, description snippet, publish time) for each
// analyst channel via the official YouTube Data API. Public data only.
async function fetchLatestVideos(){
  if(!YOUTUBE_KEY) return [];
  const out = [];
  for(const a of ANALYST_CHANNELS){
    try{
      // resolve handle → channel id → uploads playlist → latest item
      const ch = await httpsGetJson(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(a.handle)}&key=${YOUTUBE_KEY}`);
      const uploads = ch && ch.items && ch.items[0] && ch.items[0].contentDetails.relatedPlaylists.uploads;
      if(!uploads){ out.push({name:a.name, found:false}); continue; }
      const pl = await httpsGetJson(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=1&playlistId=${uploads}&key=${YOUTUBE_KEY}`);
      const item = pl && pl.items && pl.items[0] && pl.items[0].snippet;
      if(!item){ out.push({name:a.name, found:false}); continue; }
      const published = new Date(item.publishedAt);
      const hoursAgo = (Date.now() - published.getTime()) / 3600000;
      out.push({
        name: a.name, found: true,
        title: item.title,
        desc: (item.description||'').slice(0, 400),
        publishedAt: item.publishedAt,
        hoursAgo: Math.round(hoursAgo),
        fresh24h: hoursAgo <= 24,
        videoId: item.resourceId && item.resourceId.videoId,
      });
    }catch(e){ out.push({name:a.name, found:false, error:e.message}); }
  }
  return out;
}

// Tiny JSON GET helper
function httpsGetJson(url){
  return new Promise((resolve,reject)=>{
    const req = https.get(url, res=>{
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{ resolve(JSON.parse(d)); }catch(e){ reject(e); } });
    });
    req.on('error',reject);
    req.setTimeout(8000, ()=>{ req.destroy(); reject(new Error('youtube timeout')); });
  });
}



function callClaude(prompt, model){
  return new Promise((resolve, reject)=>{
    const body = JSON.stringify({
      model: model || 'claude-sonnet-4-6', // default Sonnet; trade DECISION passes Opus
      max_tokens: 1024,
      messages: [{ role:'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res=>{
      let data=''; res.on('data',d=>data+=d);
      res.on('end',()=>{
        try{
          const j = JSON.parse(data);
          const text = (j.content||[]).map(b=>b.text||'').join('');
          resolve(text);
        }catch(e){ reject(new Error('Claude API parse error: '+data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// Claude with the web_search tool enabled — for live sentiment gathering.
// Returns the full concatenated text of the response (Claude searches, reads, summarizes).
function callClaudeWithSearch(prompt, maxTokens){
  return new Promise((resolve, reject)=>{
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens||1500,
      messages: [{ role:'user', content: prompt }],
      tools: [{ type:'web_search_20250305', name:'web_search', max_uses: 6 }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    }, res=>{
      let data=''; res.on('data',d=>data+=d);
      res.on('end',()=>{
        try{
          const j = JSON.parse(data);
          if(j.error) return reject(new Error(j.error.message||'API error'));
          const text = (j.content||[]).map(b=> b.type==='text' ? b.text : '').join('');
          if(!text) return reject(new Error('empty response from model'));
          resolve(text);
        }catch(e){ reject(new Error('parse error: '+data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(90000, ()=>{ req.destroy(); reject(new Error('model call timed out (90s)')); });
    req.write(body); req.end();
  });
}

// Cache the last sentiment read so repeated opens don't re-spend until refreshed
let sentimentCache = { text:null, at:0 };



// ═════════════════════════════════════════════════════════════
// AI BOTS v2 — Pattern Trader + Davidd Systematic
// ═════════════════════════════════════════════════════════════

// ── Indicator library ──
function calcEma(values, period){
  const k = 2/(period+1); const out=[]; let prev=values[0];
  for(let i=0;i<values.length;i++){ prev = i===0?values[0]:values[i]*k+prev*(1-k); out.push(prev); }
  return out;
}
function calcSma(values, period){
  const out=[]; let sum=0;
  for(let i=0;i<values.length;i++){ sum+=values[i]; if(i>=period) sum-=values[i-period]; out.push(i>=period-1?sum/period:null); }
  return out;
}
function calcRsi(closes, period=14){
  const out=[null]; let gain=0, loss=0;
  for(let i=1;i<closes.length;i++){
    const ch = closes[i]-closes[i-1];
    const g = Math.max(ch,0), l = Math.max(-ch,0);
    if(i<=period){ gain+=g; loss+=l; out.push(null); if(i===period){ gain/=period; loss/=period; out[i]=100-100/(1+(loss===0?100:gain/loss)); } }
    else { gain=(gain*(period-1)+g)/period; loss=(loss*(period-1)+l)/period; out.push(100-100/(1+(loss===0?100:gain/loss))); }
  }
  return out;
}
function calcAtr(highs, lows, closes, period=14){
  const trs=[highs[0]-lows[0]];
  for(let i=1;i<highs.length;i++)
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  return calcEma(trs, period);
}
function calcAdx(highs, lows, closes, period=14){
  const pdm=[0], ndm=[0], trs=[highs[0]-lows[0]];
  for(let i=1;i<highs.length;i++){
    const up=highs[i]-highs[i-1], dn=lows[i-1]-lows[i];
    pdm.push(up>dn && up>0 ? up : 0);
    ndm.push(dn>up && dn>0 ? dn : 0);
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  const atrS=calcEma(trs,period), pdiS=calcEma(pdm,period), ndiS=calcEma(ndm,period);
  const dx=[];
  for(let i=0;i<atrS.length;i++){
    const pdi=100*pdiS[i]/(atrS[i]||1), ndi=100*ndiS[i]/(atrS[i]||1);
    dx.push(100*Math.abs(pdi-ndi)/((pdi+ndi)||1));
  }
  return { adx: calcEma(dx,period), pdi: atrS.map((a,i)=>100*pdiS[i]/(a||1)), ndi: atrS.map((a,i)=>100*ndiS[i]/(a||1)) };
}
function findPivots(highs, lows, span=3){
  // swing highs/lows: bar higher/lower than `span` bars each side
  const ph=[], pl=[];
  for(let i=span;i<highs.length-span;i++){
    let isH=true, isL=true;
    for(let j=1;j<=span;j++){
      if(highs[i]<=highs[i-j]||highs[i]<=highs[i+j]) isH=false;
      if(lows[i]>=lows[i-j]||lows[i]>=lows[i+j]) isL=false;
    }
    if(isH) ph.push({i, price:highs[i]});
    if(isL) pl.push({i, price:lows[i]});
  }
  return {pivotHighs:ph, pivotLows:pl};
}

// Scan a higher timeframe (daily/weekly) for a swing failure against its OWN
// swing points. Uses the live forming candle's high/low (current price as close
// proxy) so a developing sweep is caught intraday, not only after the HTF close.
// Detect classic candlestick REVERSAL patterns on the last CLOSED candle of a
// timeframe: bullish/bearish engulfing, morning star, evening star. Returns the
// patterns found with a direction. Used as confluence, never as a sole trigger.
async function detectReversalCandles(symbol, interval, label){
  const k = await mexcPublic(`/api/v1/contract/kline/${symbol}?interval=${interval}&limit=6`);
  if(!k || !k.success || !k.data.time || k.data.time.length < 4) return [];
  const o=k.data.open.map(Number), h=k.data.high.map(Number),
        l=k.data.low.map(Number), c=k.data.close.map(Number);
  const n = o.length;
  const i = n - 2;            // last CLOSED candle (n-1 is still forming)
  const p = i - 1, pp = i - 2;
  if(p < 1) return [];
  const out = [];
  const body = x => Math.abs(c[x]-o[x]);
  const isBull = x => c[x] > o[x];
  const isBear = x => c[x] < o[x];
  const avgBody = (body(i)+body(p)+body(pp))/3 || 1;

  // ENGULFING (current body fully engulfs prior body, opposite colour)
  if(isBull(i) && isBear(p) && c[i] >= o[p] && o[i] <= c[p] && body(i) > body(p))
    out.push({tf:label, pattern:'bullish engulfing', dir:'bullish'});
  if(isBear(i) && isBull(p) && o[i] >= c[p] && c[i] <= o[p] && body(i) > body(p))
    out.push({tf:label, pattern:'bearish engulfing', dir:'bearish'});

  // MORNING STAR (down candle → small-body star → strong up candle closing into 1st body)
  if(isBear(pp) && body(p) < avgBody*0.6 && isBull(i) &&
     c[i] > (o[pp]+c[pp])/2 && body(pp) > avgBody*0.6)
    out.push({tf:label, pattern:'morning star', dir:'bullish'});
  // EVENING STAR (mirror — bearish reversal at tops)
  if(isBull(pp) && body(p) < avgBody*0.6 && isBear(i) &&
     c[i] < (o[pp]+c[pp])/2 && body(pp) > avgBody*0.6)
    out.push({tf:label, pattern:'evening star', dir:'bearish'});

  return out;
}

async function detectHtfSFP(symbol, interval, label, livePrice){
  const k = await mexcPublic(`/api/v1/contract/kline/${symbol}?interval=${interval}&limit=60`);
  if(!k || !k.success || !k.data.time || k.data.time.length < 8) return [];
  const highs=k.data.high.map(Number), lows=k.data.low.map(Number),
        closes=k.data.close.map(Number), times=k.data.time.map(Number);
  const last = highs.length - 1;                 // the live, forming HTF candle
  const {pivotHighs, pivotLows} = findPivots(highs, lows, 2);
  const out = []; const TOL = 0.0005;
  const close = livePrice || closes[last];
  for(const sw of pivotHighs){
    if(sw.i >= last) continue;
    if(highs[last] > sw.price*(1+TOL) && close < sw.price){
      out.push({ tf:label, type:'bearish', level:sw.price, wick:highs[last], close,
                 penetrationPct:+((highs[last]-sw.price)/sw.price*100).toFixed(2) });
    }
  }
  for(const sw of pivotLows){
    if(sw.i >= last) continue;
    if(lows[last] < sw.price*(1-TOL) && close > sw.price){
      out.push({ tf:label, type:'bullish', level:sw.price, wick:lows[last], close,
                 penetrationPct:+((sw.price-lows[last])/sw.price*100).toFixed(2) });
    }
  }
  return out.sort((a,b)=>b.penetrationPct-a.penetrationPct).slice(0,3);
}

// Swing Failure Pattern detector. An SFP is a candle that WICKS beyond a prior
// swing point but CLOSES back inside — a failed breakout / liquidity sweep.
//   bearish SFP: high pierces a prior swing HIGH, close falls back below it → short bias
//   bullish SFP: low pierces a prior swing LOW, close climbs back above it → long bias
// We only look at the most-recently-closed candle (index last) against swings
// that formed BEFORE it, within a lookback window.
function detectSFP(highs, lows, closes, opens, times, pivotHighs, pivotLows){
  const last = closes.length - 1;
  if(last < 5) return [];
  const out = [];
  const TOL = 0.0005; // ignore microscopic pierces (<0.05%)
  const recentWindow = 60; // only consider swing points within ~60 bars

  // Bearish: did this candle's HIGH pierce a prior swing high but CLOSE below it?
  for(const sw of pivotHighs){
    if(sw.i >= last) continue;                  // swing must precede this candle
    if(last - sw.i > recentWindow) continue;    // not too old
    const pierced = highs[last] > sw.price * (1 + TOL);
    const closedBack = closes[last] < sw.price;
    const wasBelow = closes[last-1] <= sw.price; // approached from below
    if(pierced && closedBack && wasBelow){
      out.push({ type:'bearish', level: sw.price, swingTime: times[sw.i],
                 wick: highs[last], close: closes[last],
                 penetrationPct: +((highs[last]-sw.price)/sw.price*100).toFixed(2) });
    }
  }
  // Bullish: did this candle's LOW pierce a prior swing low but CLOSE above it?
  for(const sw of pivotLows){
    if(sw.i >= last) continue;
    if(last - sw.i > recentWindow) continue;
    const pierced = lows[last] < sw.price * (1 - TOL);
    const closedBack = closes[last] > sw.price;
    const wasAbove = closes[last-1] >= sw.price;
    if(pierced && closedBack && wasAbove){
      out.push({ type:'bullish', level: sw.price, swingTime: times[sw.i],
                 wick: lows[last], close: closes[last],
                 penetrationPct: +((sw.price-lows[last])/sw.price*100).toFixed(2) });
    }
  }
  // strongest (deepest sweep that still closed back) first
  return out.sort((a,b)=>b.penetrationPct-a.penetrationPct).slice(0,4);
}

// ── Pattern-bot state ──
function newAiBot(name){
  return {
    name, enabled:false, paper:true, allocation:100, startEquity:100,
    decisionTf:'Min60', symbol:'BTC_USDT',
    maxLeverage:10, maxRiskPct:5, killSwitchPct:50,
    position:null, realizedPnl:0, decisions:[], tradeHistory:[],
    lastDecisionCandle:null, aiLines:[], lineSource:'both', swingMode:false,
  };
}
let aiBots = { pattern: newAiBot('pattern') };

function aiBotLog(bot, msg, type=''){ blog(`[AI:${bot.name}] ${msg}`, type); }

function aiEquity(bot){ return bot.allocation + bot.realizedPnl; }

async function aiBotOpen(bot, side, entry, lev, tpPrice, slPrice, reasoning){
  const equity = aiEquity(bot);
  const riskUsd = equity * bot.maxRiskPct/100;
  const slDist = Math.abs(entry - slPrice);
  if(slDist<=0) return aiBotLog(bot,'Invalid SL distance — skip','warn');
  const cSize = contractSize(bot.symbol);
  let qty = Math.max(1, Math.floor(riskUsd/(slDist*cSize)));
  const maxQty = Math.floor((equity*lev)/(entry*cSize));
  qty = Math.min(qty, Math.max(1,maxQty));

  if(!bot.paper){
    if(lev>1) await mexcRequest('POST','/api/v1/private/position/change_leverage',{symbol:bot.symbol,leverage:lev,openType:1}).catch(()=>{});
    const r = await placeOrder(bot.symbol, side==='BUY'?1:3, qty, lev, 1, 0, 5);
    if(!r.success) return aiBotLog(bot,`Order failed: ${JSON.stringify(r).slice(0,120)}`,'err');
  }
  bot.position = { side, entryPrice:entry, qty, leverage:lev, tpPrice, slPrice, openedAt:Date.now() };
  saveState();
  const mode = bot.paper?'📝 PAPER':'💸 LIVE';
  aiBotLog(bot, `${mode} ${side} @ $${entry} | ${qty}c ${lev}× | TP $${tpPrice.toFixed(0)} SL $${slPrice.toFixed(0)}`, 'ok');
  sendTelegram(`🤖 <b>[${bot.name.toUpperCase()}] ${mode} ${side}</b> ${bot.symbol}\nEntry $${entry} | ${lev}× | ${qty}c\nTP $${tpPrice.toFixed(0)} | SL $${slPrice.toFixed(0)}\n<i>${(reasoning||'').slice(0,300)}</i>`);
}

async function aiBotClose(bot, reason, price){
  const pos = bot.position; if(!pos) return;
  if(price==null) price = await getTicker(bot.symbol) || pos.entryPrice;
  if(!bot.paper){
    const r = await placeOrder(bot.symbol, pos.side==='BUY'?4:2, pos.qty, pos.leverage, 1, 0, 5);
    if(!r.success) return aiBotLog(bot,`Close failed: ${JSON.stringify(r).slice(0,120)}`,'err');
  }
  const dir = pos.side==='BUY'?1:-1;
  const pnl = (price-pos.entryPrice)*pos.qty*contractSize(bot.symbol)*dir;
  bot.realizedPnl += pnl;
  // Risk/reward metrics: planned R:R from entry/SL/TP, and realized R (actual move ÷ planned risk)
  const riskDist = pos.slPrice ? Math.abs(pos.entryPrice - pos.slPrice) : null;
  const rewardDist = pos.tpPrice ? Math.abs(pos.tpPrice - pos.entryPrice) : null;
  const plannedRR = (riskDist && rewardDist) ? +(rewardDist/riskDist).toFixed(2) : null;
  const realizedR = riskDist ? +(((price-pos.entryPrice)*dir)/riskDist).toFixed(2) : null;
  bot.tradeHistory.push({
    side:pos.side, entry:pos.entryPrice, exit:price, pnl, reason, t:Date.now(),
    sl:pos.slPrice||null, tp:pos.tpPrice||null, qty:pos.qty, leverage:pos.leverage,
    openedAt: pos.openedAt||null, plannedRR, realizedR, paper: bot.paper,
  });
  if(bot.tradeHistory.length>200) bot.tradeHistory.shift();
  const emoji = pnl>=0?'💰':'🔻';
  aiBotLog(bot, `${emoji} ${reason}: ${pos.side} closed @ $${price} | ${pnl>=0?'+':''}$${pnl.toFixed(2)} | total ${bot.realizedPnl>=0?'+':''}$${bot.realizedPnl.toFixed(2)}`, pnl>=0?'ok':'err');
  sendTelegram(`${emoji} <b>[${bot.name.toUpperCase()}] closed ${pos.side}</b> (${reason})\nExit $${price} | P&L ${pnl>=0?'+':''}$${pnl.toFixed(2)}\nBot total: ${bot.realizedPnl>=0?'+':''}$${bot.realizedPnl.toFixed(2)} ${bot.paper?'(paper)':''}`);
  bot.position = null;
  saveState();
}

async function aiBotManageExits(bot){
  if(!bot.position) return false;
  const p = await getTicker(bot.symbol);
  if(p==null) return false;
  const pos = bot.position;
  const tpHit = pos.side==='BUY' ? p>=pos.tpPrice : p<=pos.tpPrice;
  const slHit = pos.side==='BUY' ? p<=pos.slPrice : p>=pos.slPrice;
  if(tpHit){ await aiBotClose(bot,'TP',p); return true; }
  if(slHit){ await aiBotClose(bot,'SL',p); return true; }
  // Davidd-style: break-even at +1R
  const r1 = Math.abs(pos.entryPrice - pos.slPrice);
  if(pos.slPrice !== pos.entryPrice){
    const inProfit1R = pos.side==='BUY' ? p>=pos.entryPrice+r1 : p<=pos.entryPrice-r1;
    if(inProfit1R){
      pos.slPrice = pos.entryPrice;
      aiBotLog(bot,`🔒 SL → break-even @ $${pos.entryPrice}`,'ok');
    }
  }
  return false;
}

function aiBotKillCheck(bot){
  if(aiEquity(bot) <= bot.startEquity*(1-bot.killSwitchPct/100)){
    bot.enabled=false;
    aiBotLog(bot,`💀 KILL SWITCH — equity $${aiEquity(bot).toFixed(2)}`,'err');
    sendTelegram(`💀 <b>[${bot.name.toUpperCase()}] kill switch</b> — stopped at $${aiEquity(bot).toFixed(2)}`);
    if(bot.position) aiBotClose(bot,'KILL SWITCH');
    return true;
  }
  return false;
}

// ── DAVIDD BOT: EMA cross + ADX regime + RSI confirm + ATR risk ──
async function patternTick(){
  const bot = aiBots.pattern;
  // SAFETY: if a position is open, keep managing its TP/SL even when the bot is
  // stopped — a held trade must never go unmanaged just because entries are off.
  if(!bot.enabled){
    if(bot.position){ try{ await aiBotManageExits(bot); }catch(e){} }
    return;
  }
  if(!ANTHROPIC_KEY) return;
  try{
    if(aiBotKillCheck(bot)) return;
    if(await aiBotManageExits(bot)) return; // TP/SL hit during the candle → exit handled

    const candle = await getLastClosedCandle(bot.symbol, bot.decisionTf);
    if(!candle || candle.time===bot.lastDecisionCandle) return;
    bot.lastDecisionCandle = candle.time;

    // HOLDING A POSITION? On each new candle, let Claude REVIEW it — hold, adjust
    // the stop/target, or close. SL & TP always remain set (adjust, never remove).
    if(bot.position){ try{ await reviewOpenPosition(bot); }catch(e){ aiBotLog(bot,`review error: ${e.message}`,'err'); } return; }

    const k = await mexcPublic(`/api/v1/contract/kline/${bot.symbol}?interval=${bot.decisionTf}&limit=150`);
    if(!k || !k.success) return;
    const closes=k.data.close.map(Number), highs=k.data.high.map(Number), lows=k.data.low.map(Number), times=k.data.time.map(Number), opens=k.data.open.map(Number);
    const {pivotHighs, pivotLows} = findPivots(highs, lows, 3);
    const sfps = detectSFP(highs, lows, closes, opens, times, pivotHighs, pivotLows);
    const price = closes[closes.length-1];
    // HIGHER-TIMEFRAME sweeps (daily + weekly) — highest conviction, never miss these
    const dailySfp  = await detectHtfSFP(bot.symbol, 'Day1',  'DAILY',  price);
    const weeklySfp = await detectHtfSFP(bot.symbol, 'Week1', 'WEEKLY', price);
    const htfSfps = [...weeklySfp, ...dailySfp]; // weekly first = most significant
    // Candlestick reversal confluence across timeframes (1h/4h/daily/weekly)
    const revTFs = [['Min60','1h'],['Hour4','4h'],['Day1','DAILY'],['Week1','WEEKLY']];
    let reversals = [];
    for(const [iv,lbl] of revTFs){
      const r = await detectReversalCandles(bot.symbol, iv, lbl);
      reversals = reversals.concat(r);
    }
    // Telegram alert for NEW higher-timeframe sweeps (once each), even before
    // Claude decides — you never want to miss a daily/weekly SFP forming.
    bot.seenHtfSfp = bot.seenHtfSfp || {};
    for(const s of htfSfps){
      const key = `${s.tf}:${s.type}:${Math.round(s.level)}`;
      if(!bot.seenHtfSfp[key]){
        bot.seenHtfSfp[key] = Date.now();
        aiBotLog(bot, `🚨 ${s.tf} ${s.type} SFP — swept $${s.level.toFixed(0)}, back to $${s.close.toFixed(0)} (${s.penetrationPct}%)`, 'ok');
        sendTelegram(`🚨 <b>${s.tf} SWING FAILURE (${s.type})</b> on ${bot.symbol}\nSwept the ${s.tf.toLowerCase()} swing ${s.type==='bearish'?'high':'low'} at $${s.level.toFixed(0)} → back to $${s.close.toFixed(0)} (${s.penetrationPct}% sweep).\nHigh-conviction reversal zone — pattern bot is evaluating.`);
      }
    }
    // forget sweeps older than 7 days so the same level can re-alert later
    for(const k in bot.seenHtfSfp){ if(Date.now()-bot.seenHtfSfp[k] > 7*864e5) delete bot.seenHtfSfp[k]; }
    // Alert on new DAILY/WEEKLY reversal candles (intraday ones are too frequent to ping)
    bot.seenRev = bot.seenRev || {};
    for(const r of reversals){
      if(r.tf!=='DAILY' && r.tf!=='WEEKLY') continue;
      const key = `${r.tf}:${r.pattern}:${bot.lastDecisionCandle}`;
      if(!bot.seenRev[key]){
        bot.seenRev[key] = Date.now();
        sendTelegram(`🕯️ <b>${r.tf} ${r.pattern}</b> on ${bot.symbol} (${r.dir} reversal). Confluence signal — pattern bot is weighing it.`);
      }
    }
    for(const k in bot.seenRev){ if(Date.now()-bot.seenRev[k] > 14*864e5) delete bot.seenRev[k]; }

    // Daily + weekly S/R
    const kd = await mexcPublic(`/api/v1/contract/kline/${bot.symbol}?interval=Day1&limit=8`);
    const dHigh = kd&&kd.success ? Math.max(...kd.data.high.slice(-2,-1).map(Number)) : null;
    const dLow  = kd&&kd.success ? Math.min(...kd.data.low.slice(-2,-1).map(Number)) : null;
    const wHigh = kd&&kd.success ? Math.max(...kd.data.high.slice(0,7).map(Number)) : null;
    const wLow  = kd&&kd.success ? Math.min(...kd.data.low.slice(0,7).map(Number)) : null;

    // ── USER'S DRAWN LINES — AUTHORITATIVE S/R, ranked by colour/timeframe strength ──
    // Colour encodes the timeframe the line was drawn on = its strength.
    // Weekly(purple) strongest → Daily(green) → 4h(blue) → 1h(yellow) → ≤15m(white) weakest.
    // These SUPERSEDE the bot's own pivot-derived S/R per the trader's rule.
    const lineStrength = (l) => {
      const byTf = { '1w':5, '1d':4, '4h':3, '1h':2, '15m':1, '5m':1, '1m':1 };
      if(l.tf && byTf[l.tf]) return byTf[l.tf];
      // fall back to colour if tf missing (older lines)
      const c = (l.color||'').toLowerCase();
      if(c.includes('a855f7')||c==='purple') return 5;
      if(c.includes('00c896')||c==='green')  return 4;
      if(c.includes('3d7fff')||c==='blue')   return 3;
      if(c.includes('f5d020')||c.includes('f5a623')||c==='yellow') return 2;
      return 1; // white / unknown
    };
    const strengthLabel = ['', 'weak (≤15m)', '1h', '4h (strong)', 'daily (very strong)', 'weekly (strongest)'];
    const tfLabel = { '1w':'weekly','1d':'daily','4h':'4h','1h':'1h','15m':'15m','5m':'5m','1m':'1m' };
    let userLines = [];
    let userLineLevels = []; // {price, strength, desc}
    const haveUserLines = savedChartLines[bot.symbol] && savedChartLines[bot.symbol].lines && savedChartLines[bot.symbol].lines.length;
    // useAiLines: true when lineSource allows the AI to fill obvious gaps ('both'); false = user lines only
    bot.useAiLines = (bot.lineSource === 'both' || bot.lineSource === 'ai');
    if(haveUserLines){
      for(const l of savedChartLines[bot.symbol].lines){
        const st = lineStrength(l);
        const tfL = l.tf ? tfLabel[l.tf]||l.tf : 'unknown-tf';
        if(l.isHoriz){
          userLines.push(`YOUR ${tfL} line @ $${l.horizPrice.toFixed(0)} — strength: ${strengthLabel[st]}`);
          userLineLevels.push({price:l.horizPrice, strength:st, desc:`your ${tfL} level`});
        } else {
          const nowP = priceOnLine(l, Math.floor(Date.now()/1000));
          userLines.push(`YOUR ${tfL} trendline (now ≈ $${(nowP||l.p2.price).toFixed(0)}) — strength: ${strengthLabel[st]}`);
          if(nowP) userLineLevels.push({price:nowP, strength:st, desc:`your ${tfL} trendline`});
        }
      }
      // strongest first
      userLineLevels.sort((a,b)=>b.strength-a.strength);
    }
    // Build the authoritative-lines prompt block (kept as a var to avoid nested-quote issues)
    let userLineBlock;
    if(haveUserLines){
      const gapRule = bot.useAiLines
        ? 'You MAY add your OWN S/R line ONLY where there is an OBVIOUS gap — a clear price-reacting level the trader has NO line near. Be conservative: only add one if price is clearly reacting at a level far from any of the trader lines. Return such lines in "aiLines" (shown dotted on their chart). Do NOT duplicate or slightly shift the trader existing lines.'
        : 'Rely SOLELY on the trader lines above for S/R. Do NOT invent your own S/R levels. Leave "aiLines" empty.';
      userLineBlock = "🟦 THE TRADER'S OWN DRAWN LINES — YOUR AUTHORITATIVE SUPPORT/RESISTANCE. Hard rule: when judging support and resistance you MUST use these lines. They SUPERSEDE your own pivot/swing analysis. Their colour encodes strength by the timeframe drawn on — weekly strongest, then daily, 4h, 1h, ≤15m weakest:\n"
        + userLines.join('\n') + '\n' + gapRule;
    } else {
      userLineBlock = 'No trader-drawn lines available — use your own pivot/swing S/R analysis.';
    }
    const pivotStr = `Swing highs: ${pivotHighs.slice(-8).map(p=>`[${new Date(times[p.i]*1000).toISOString().slice(5,16)} $${p.price.toFixed(0)}]`).join(' ')}
Swing lows: ${pivotLows.slice(-8).map(p=>`[${new Date(times[p.i]*1000).toISOString().slice(5,16)} $${p.price.toFixed(0)}]`).join(' ')}`;

    // ── PROXIMITY TO STRONG S/R ──  Is price sitting AT a significant level
    // right now? Reversal signals are far stronger when they happen here.
    const NEAR = 0.004; // within 0.4% counts as "at" the level
    const keyLevels = [];
    if(wHigh) keyLevels.push({name:'weekly high', price:wHigh, weight:'major'});
    if(wLow)  keyLevels.push({name:'weekly low',  price:wLow,  weight:'major'});
    if(dHigh) keyLevels.push({name:'prev daily high', price:dHigh, weight:'strong'});
    if(dLow)  keyLevels.push({name:'prev daily low',  price:dLow,  weight:'strong'});
    // recent swing points (clustered swings = stronger horizontal S/R)
    for(const p of pivotHighs.slice(-6)) keyLevels.push({name:'swing high', price:p.price, weight:'moderate'});
    for(const p of pivotLows.slice(-6))  keyLevels.push({name:'swing low',  price:p.price, weight:'moderate'});
    // (User lines are now handled authoritatively above as userLineLevels.)
    const atLevels = keyLevels.filter(L => Math.abs(price-L.price)/price <= NEAR)
      .sort((a,b)=>Math.abs(price-a.price)-Math.abs(price-b.price));
    const srStr = atLevels.length
      ? atLevels.map(L=>`${L.name} $${L.price.toFixed(0)} (${L.weight}, ${((price-L.price)/L.price*100).toFixed(2)}% away)`).join('; ')
      : null;

    const candleStr = times.slice(-60).map((t,j)=>{
      const idx = times.length-60+j;
      return `${new Date(t*1000).toISOString().slice(5,16)} O${k.data.open[idx]} H${highs[idx]} L${lows[idx]} C${closes[idx]}`;
    }).join('\n');

    const prompt = `You are primarily a BREAKOUT TRADER on ${bot.symbol} ${bot.decisionTf}. Your core edge is trading breakouts: price breaking out of consolidation, wedges, flags, channels, and decisively breaking through daily/weekly support/resistance. That is your identity — when in doubt, you trade WITH breakout momentum, not against it.

CRITICAL — ROOM TO RUN / RISK-REWARD AT ENTRY: Before any entry, check how much room there is to the next strong level in your trade's direction. Do NOT open a long when price is already close beneath strong resistance, or a short close above strong support — even if the move is WITH the trend. That kind of entry is a low-reward scalp into a wall: the target is cramped and the risk/reward is poor, even when it happens to hit TP. As a breakout trader you want to enter where there is meaningful room to run — ideally just AFTER price breaks through a level (with a retest), not as it approaches one from below/above. If price is approaching a level and hasn't broken it, prefer to WAIT for the break rather than squeeze a small long/short into the remaining distance. Require a take-profit that is at least ~2x your stop distance; if the nearest strong level caps the upside below that, skip the trade.

${bot.swingMode
  ? `SWING MODE IS ON: In addition to breakouts, you may actively SWING TRADE from key levels — go LONG from at/near strong SUPPORT, or SHORT from at/near strong RESISTANCE — but ONLY after a confirmed reversal at that level (e.g. an SFP sweep of the level AND a reversal candle like engulfing/morning-star/evening-star, with the level holding on the close). The level you enter near must be a strong one (daily/weekly S/R, or the trader's own drawn line), and there must be room to run to the next opposite level (aim for >=2x risk). No confirmation = no counter-level trade; wait. You are still a breakout trader at heart — swing entries are a genuine second mode here, not a licence to fade every level.`
  : `SWING MODE IS OFF: You are breakout-only. Do NOT take longs into support or shorts into resistance as a primary play. Only trade breakouts (and the rare exceptional reversal noted above). When price sits near a level without breaking it, WAIT.`}

You also recognise these patterns: ascending/descending wedges, bull/bear flags, head & shoulders, inverse H&S, channels, swing failure patterns (SFP), and breaks of daily/weekly support/resistance. Be selective — most candles deserve "hold".

An SFP (swing failure pattern) is when price wicks BEYOND a prior swing high/low but CLOSES back inside it — a failed breakout that sweeps liquidity and often reverses. A bearish SFP (wick above a swing high, close below) favours shorts; a bullish SFP (wick below a swing low, close above) favours longs. SFPs are higher-conviction when the wick is a clean sweep and the close is decisively back inside.

CURRENT PRICE: $${price}
EQUITY: $${aiEquity(bot).toFixed(2)} ${bot.paper?'(PAPER MODE)':''}
POSITION: ${bot.position?`${bot.position.side} @ $${bot.position.entryPrice}`:'none'}

${journalForPrompt() ? journalForPrompt()+'\n\nBefore deciding, explicitly check the setup against your standing instructions and journal. If a standing instruction says not to trade here, HOLD. Reference the relevant journal lessons in your reasoning.\n' : ''}${libraryForPrompt() ? '\n'+libraryForPrompt()+'\n' : ''}
${reversals.length ? `🕯️ CANDLESTICK REVERSAL SIGNALS (confluence — weigh more when they align with an SFP sweep or a key level; higher timeframe = stronger):\n${reversals.map(r=>`${r.tf} ${r.pattern} (${r.dir})`).join('\n')}\nThese are supporting evidence for a reversal, NOT standalone triggers. A daily or weekly engulfing/star stacked with a swept level is high conviction; a lone 1h engulfing is weak.` : ''}

${htfSfps.length ? `🚨🚨 HIGH-TIMEFRAME SWING FAILURE — THE MOST IMPORTANT SIGNAL ON THIS CHART, DO NOT IGNORE:\n${htfSfps.map(s=>`${s.tf} ${s.type.toUpperCase()} SFP — price swept the ${s.tf.toLowerCase()} swing ${s.type==='bearish'?'high':'low'} at $${s.level.toFixed(0)} (reached $${s.wick.toFixed(0)}, ${s.penetrationPct}% beyond) and is back ${s.type==='bearish'?'below':'above'} it at $${s.close.toFixed(0)}.`).join('\n')}\nA daily/weekly SFP is a far higher-conviction reversal signal than any intraday pattern. Give it strong weight. Still apply risk management and confirm the close holds.` : ''}

PIVOTS (detected swings):
${pivotStr}

${sfps.length ? `⚡ SWING FAILURE PATTERNS detected on the just-closed candle:\n${sfps.map(s=>`${s.type.toUpperCase()} SFP — swept the $${s.level.toFixed(0)} swing ${s.type==='bearish'?'high':'low'} (wick to $${s.wick.toFixed(0)}, ${s.penetrationPct}% beyond) then closed back at $${s.close.toFixed(0)}`).join('\n')}\nConsider whether any is a high-quality, tradeable SFP — but a detected sweep is NOT an automatic trade; weigh context, trend, and risk/reward.` : 'No swing failure pattern on the just-closed candle.'}

${srStr ? `📍 PRICE IS AT STRONG SUPPORT/RESISTANCE RIGHT NOW: ${srStr}\nReversal signals (SFP, engulfing, star) are MUCH higher conviction when they occur AT these levels. A reversal candle + swept level + S/R confluence is a prime setup. A reversal in the middle of nowhere (not near any level) is weak — prefer to wait.` : 'Price is not currently at a major S/R level — reversal signals here carry less weight; be more cautious.'}

KEY LEVELS: prev daily H $${dHigh?.toFixed(0)} L $${dLow?.toFixed(0)} | weekly H $${wHigh?.toFixed(0)} L $${wLow?.toFixed(0)}

${userLineBlock}

LAST 60 CANDLES:
${candleStr}

${bot.lineSource==='user'?'Only trade setups that interact with the TRADER\'S OWN LINES.':''}

Respond ONLY JSON:
{"action":"long"|"short"|"close"|"hold","pattern":"name or none","leverage":1-${bot.maxLeverage},"tpPrice":number,"slPrice":number,"reasoning":"2 sentences max","lines":[{"label":"e.g. flag upper","p1":{"time":unix_seconds,"price":n},"p2":{"time":unix_seconds,"price":n}}],"aiLines":[{"label":"gap S/R","price":n}]}
"lines" = the pattern lines you see (max 4), so the trader can view them on their chart.

MANDATORY: if action is long or short, you MUST provide both slPrice and tpPrice. slPrice goes on the losing side of entry (below for long, above for short); tpPrice on the winning side. A trade with no stop or no target is forbidden — if you can't define a sensible stop and target with at least ~2x reward:risk, choose "hold" instead.`;

    const raw = await callClaude(prompt, DECISION_MODEL);
    let d;
    try{ d = JSON.parse(raw.replace(/```json|```/g,'').trim()); }
    catch(e){ return aiBotLog(bot,`bad decision JSON: ${raw.slice(0,100)}`,'err'); }

    bot.decisions.push({t:Date.now(), candle:price, action:d.action, pattern:d.pattern, reasoning:d.reasoning});
    if(bot.decisions.length>50) bot.decisions.shift();
    if(d.lines && d.lines.length) bot.aiLines = d.lines.slice(0,4);
    // Gap-fill S/R lines the AI added (only when useAiLines is on) — shown dotted on the AI page
    bot.aiSrLines = (bot.useAiLines && Array.isArray(d.aiLines)) ? d.aiLines.slice(0,6).filter(l=>l && typeof l.price==='number') : [];
    aiBotLog(bot, `${d.action.toUpperCase()} ${d.pattern&&d.pattern!=='none'?'['+d.pattern+'] ':''}— ${d.reasoning}`,'info');

    if(d.action==='close' && bot.position) return aiBotClose(bot,'AI decision');
    if((d.action==='long'||d.action==='short') && !bot.position){
      const side = d.action==='long'?'BUY':'SELL';
      const tp = parseFloat(d.tpPrice), sl = parseFloat(d.slPrice);
      // HARD RULE: never open without a valid SL and TP on the correct side of entry.
      const slOk = isFinite(sl) && sl>0 && (side==='BUY' ? sl < price : sl > price);
      const tpOk = isFinite(tp) && tp>0 && (side==='BUY' ? tp > price : tp < price);
      if(!slOk || !tpOk){
        aiBotLog(bot, `⛔ ${side} REJECTED — entry must have valid SL & TP. Got SL=${d.slPrice} TP=${d.tpPrice} @ entry $${price}. No trade.`, 'err');
        return; // refuse the trade entirely; equity/table only ever see protected, closed trades
      }
      const lev = Math.min(bot.maxLeverage, Math.max(1, parseInt(d.leverage)||3));
      await aiBotOpen(bot, side, price, lev, tp, sl, `[${d.pattern}] ${d.reasoning}`);
    }
  }catch(e){ aiBotLog(bot,`tick error: ${e.message}`,'err'); }
}

// Review an open position at a candle close: Claude may HOLD, ADJUST sl/tp
// (e.g. trail the stop, extend the target), or CLOSE. SL and TP stay mandatory.
async function reviewOpenPosition(bot){
  const pos = bot.position; if(!pos) return;
  const price = await getTicker(bot.symbol); if(price==null) return;
  const dir = pos.side==='BUY'?1:-1;
  const unrealR = pos.slPrice ? (((price-pos.entryPrice)*dir)/Math.abs(pos.entryPrice-pos.slPrice)).toFixed(2) : '?';
  const prompt = `You hold an open ${pos.side} on ${bot.symbol} (${bot.decisionTf}). Review it at this candle close.
Entry $${pos.entryPrice} | current $${price} | SL $${pos.slPrice} | TP $${pos.tpPrice} | unrealized ${unrealR}R.
${journalForPrompt()||''}
Decide: keep holding, adjust the stop/target (e.g. trail stop to lock profit, or extend target if momentum is strong), or close now if the thesis is broken.
A stop-loss and take-profit MUST always remain set — you may move them but never remove them. Only move a stop in the trade's favour (never widen risk).
Respond ONLY JSON: {"action":"hold"|"adjust"|"close","slPrice":number,"tpPrice":number,"reasoning":"1 sentence"}`;
  let raw, d;
  try{ raw = await callClaude(prompt, DECISION_MODEL); d = JSON.parse(raw.replace(/```json|```/g,'').trim()); }
  catch(e){ return; } // on any failure, leave the position exactly as-is (still protected)

  if(d.action==='close'){ aiBotLog(bot,`review→close: ${d.reasoning}`,'info'); return aiBotClose(bot,'AI review close'); }
  if(d.action==='adjust'){
    const nsl = parseFloat(d.slPrice), ntp = parseFloat(d.tpPrice);
    // Validate: both still present & on the correct side; stop may only move favourably.
    const slSideOk = isFinite(nsl) && (pos.side==='BUY' ? nsl < price : nsl > price);
    const tpSideOk = isFinite(ntp) && (pos.side==='BUY' ? ntp > price : ntp < price);
    const stopFavourable = isFinite(nsl) && (pos.side==='BUY' ? nsl >= pos.slPrice : nsl <= pos.slPrice);
    if(slSideOk && stopFavourable) pos.slPrice = nsl;
    if(tpSideOk) pos.tpPrice = ntp;
    aiBotLog(bot,`review→adjust: SL $${pos.slPrice.toFixed(0)} TP $${pos.tpPrice.toFixed(0)} — ${d.reasoning}`,'ok');
    saveState();
  } else {
    aiBotLog(bot,`review→hold: ${d.reasoning||''}`,'info');
  }
}

setInterval(patternTick, 13000);

// ─────────────────────────────────────────────────────────────
// HTTP SERVER
// ─────────────────────────────────────────────────────────────
function json(res, code, obj){
  res.writeHead(code, {
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req){
  return new Promise(resolve=>{
    let b=''; req.on('data',d=>b+=d);
    req.on('end',()=>{ try{ resolve(JSON.parse(b||'{}')); }catch(e){ resolve({}); } });
  });
}

http.createServer(async (req, res)=>{
  // CORS preflight
  if(req.method==='OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Headers':'*',
      'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    });
    return res.end();
  }

  const url = req.url;

  // ── PROXY: /https://contract.mexc.com/... (public data passthrough) ──
  // 3-second cache — dedupes bursts so MEXC's per-IP rate limit isn't exhausted
  if(url.startsWith('/https://') || url.startsWith('/http://')){
    const target = url.slice(1);

    const cached = proxyCache.get(target);
    if(cached && Date.now() - cached.t < 3000){
      res.writeHead(200, {
        'Content-Type':'application/json',
        'Access-Control-Allow-Origin':'*',
        'Access-Control-Allow-Headers':'*',
        'X-Cache':'HIT',
      });
      return res.end(cached.data);
    }

    try{
      const tu = new URL(target);
      https.get({ hostname: tu.hostname, path: tu.pathname + tu.search }, pres=>{
        let data=''; pres.on('data',d=>data+=d);
        pres.on('end',()=>{
          if(pres.statusCode === 200){
            proxyCache.set(target, { t: Date.now(), data });
            if(proxyCache.size > 200){ // keep cache bounded
              const oldest = proxyCache.keys().next().value;
              proxyCache.delete(oldest);
            }
          } else if(cached){
            // Upstream error (e.g. rate limit) — serve stale cache instead
            res.writeHead(200, {
              'Content-Type':'application/json',
              'Access-Control-Allow-Origin':'*',
              'Access-Control-Allow-Headers':'*',
              'X-Cache':'STALE',
            });
            return res.end(cached.data);
          }
          res.writeHead(pres.statusCode, {
            'Content-Type':'application/json',
            'Access-Control-Allow-Origin':'*',
            'Access-Control-Allow-Headers':'*',
          });
          res.end(data);
        });
      }).on('error', e=> json(res,502,{error:e.message}));
    }catch(e){ json(res,400,{error:'bad url'}); }
    return;
  }

  // ── AUTH ──
  if(url==='/auth' && req.method==='POST'){
    const body = await readBody(req);
    if(APP_PASSWORD && body.password === APP_PASSWORD){
      return json(res,200,{token:newToken()});
    }
    return json(res,401,{error:'wrong password'});
  }

  // All routes below require auth
  if(!checkAuth(req)) return json(res,401,{error:'unauthorized'});

  // ── ACCOUNT ──
  if(url==='/account/balance'){
    const d = await mexcRequest('GET','/api/v1/private/account/assets');
    if(!d.success) return json(res,500,d);
    const usdt = (d.data||[]).find(a=>a.currency==='USDT') || {};
    return json(res,200,{
      total: (parseFloat(usdt.availableBalance||0)+parseFloat(usdt.frozenBalance||0)),
      free: parseFloat(usdt.availableBalance||0),
      frozen: parseFloat(usdt.frozenBalance||0),
    });
  }

  if(url==='/account/positions'){
    const d = await mexcRequest('GET','/api/v1/private/position/open_positions');
    if(!d.success) return json(res,500,d);
    return json(res,200,{positions:(d.data||[]).filter(p=>parseFloat(p.holdVol)>0)});
  }

  // ── BOT ──
  if(url==='/bot/arm' && req.method==='POST'){
    // (sizing preview added in arm handler below)
    const config = await readBody(req);
    config.qty = Math.max(1, Math.round(parseFloat(config.qty)||1));
    config.leverage = Math.max(1, Math.min(125, parseInt(config.leverage)||1));
    // Ensure tpLevels exists (older clients won't send it)
    if(!config.tp) config.tp = {};
    if(!config.tp.levels || !config.tp.levels.length)
      config.tp.levels = [{pct: config.tp.value||2, size:100}];
    const bot = { id: ++botIdCounter, config, activeTrade: null, lastCandleTime: null, lastTpCandle: null, lastSlCandle: null, syncCounter: 0 };
    bots.push(bot);
    const srcLabel = config.triggerSource==='price' ? `price ${config.manualPrice}` : `line ${config.selectedLineId}`;
    blog(`Bot #${bot.id} ARMED — ${config.symbol} | close ${config.dir} ${srcLabel} [${config.trigTf}] | ${bots.length} bot(s) running`, 'ok');
    if(config.qtyUsdt){
      const refPx = await getTicker(config.symbol).catch(()=>null);
      const est = refPx ? Math.round((config.qtyUsdt*(config.leverage||1))/refPx/contractSize(config.symbol)) : null;
      blog(`Bot #${bot.id} sizing: $${config.qtyUsdt} margin × ${config.leverage}× = $${(config.qtyUsdt*(config.leverage||1)).toFixed(0)} position${est?` ≈ ${est} contracts at current price (final count converts at trigger)`:''}`,'info');
    }
    blog(`Bot #${bot.id} full config: ${JSON.stringify(config)}`, 'info');
    sendTelegram(`🤖 <b>Bot #${bot.id} ARMED</b>\n${config.symbol} — candle close ${config.dir} ${srcLabel} [${config.trigTf}]\nTotal bots: ${bots.length}`);
    saveState();
    return json(res,200,{armed:true, id: bot.id, totalBots: bots.length});
  }

  if(url==='/bot/update' && req.method==='POST'){
    const b = await readBody(req);
    const bot = bots.find(x=>x.id===b.id);
    if(!bot) return json(res,404,{error:'bot not found (server may have restarted)'});
    if(bot.activeTrade) return json(res,409,{error:'Bot is IN A TRADE — manage the position from Open Trades instead'});
    const config = b.cfg || {};
    if(!config.tp) config.tp = {mode:'price', type:'pct', value:2, tf:'Min15'};
    if(!config.tp.levels || !config.tp.levels.length)
      config.tp.levels = [{pct: config.tp.value||2, size:100}];
    bot.config = config;
    bot.lastCandleTime = null; // evaluate fresh on next close
    bot.failCount = 0;
    bot.phase = null; bot.retestLineId = null; // edited config restarts the cycle
    blog(`✏️ Bot #${bot.id} UPDATED — ${config.dir} ${config.triggerSource==='price'?'price $'+config.manualPrice:'line '+config.selectedLineId} [${config.trigTf}]`,'ok');
    blog(`Bot #${bot.id} new config: ${JSON.stringify(config)}`,'info');
    sendTelegram(`✏️ <b>Bot #${bot.id} updated</b>\n${config.symbol} ${config.dir} [${config.trigTf}]`);
    saveState();
    return json(res,200,{updated:true, id:bot.id});
  }

  if(url==='/bot/disarm' && req.method==='POST'){
    const b = await readBody(req);
    if(b.id != null){
      const bot = bots.find(x => x.id === parseInt(b.id));
      if(!bot) return json(res,404,{error:'bot not found'});
      bots = bots.filter(x => x.id !== bot.id);
      blog(`Bot #${bot.id} DISARMED${bot.activeTrade?' (its open trade is no longer managed!)':''} — ${bots.length} bot(s) remaining`,'warn');
      sendTelegram(`🛑 <b>Bot #${bot.id} disarmed</b> — ${bots.length} remaining`);
      saveState();
      return json(res,200,{armed: bots.length>0, removed: bot.id, totalBots: bots.length});
    }
    // No id = disarm all — full clean sweep so nothing stale lingers
    const n = bots.length;
    bots = [];
    botIdCounter = 0;            // reset numbering — truly fresh
    blog(`All ${n} TRIGGER bot(s) DISARMED — clean slate (pattern bot unaffected)`,'warn');
    sendTelegram(`🛑 <b>All trigger bots disarmed</b> — ${n} cleared. Pattern bot is separate and still running.`);
    saveState();
    return json(res,200,{armed:false, totalBots: 0});
  }

  // ── CUSTOM EXIT RULE PARSER (AI translates English → structured rule) ──
  if(url==='/bot/parse-exit' && req.method==='POST'){
    if(!ANTHROPIC_KEY) return json(res,400,{error:'needs ANTHROPIC_API_KEY'});
    const b = await readBody(req);
    const text = (b.text||'').slice(0,300);
    const lines = b.lines || []; // [{id, isHoriz, horizPrice, p1, p2}]
    if(!text) return json(res,400,{error:'empty'});
    const lineList = lines.length
      ? 'Available drawn lines (use lineId if the user refers to a line): ' + lines.map(l=>`#${l.id}${l.isHoriz?` (horizontal @ ${l.horizPrice})`:' (trend line)'}`).join(', ')
      : 'No drawn lines available.';
    const prompt = `Translate this trader's plain-English EXIT instruction into a strict JSON rule. Exit rules close an open trade. There are TWO kinds:

1. SIMPLE — close when a candle closes past a level. kind:"simple".
2. FAILED RETEST — the trader wants: price first breaks past a level (a candle closes past it), THEN later a candle wicks back to the level (its high reaches the line, or comes within a small % ) but CLOSES back past it again — a failed retest / rejection. kind:"failed_retest". Use this when the trader mentions retesting, re-testing, rejection, "comes back to the line", "fails to reclaim", or a two-step break-then-reject sequence.

Trader said: "${text}"
${lineList}

Respond ONLY with JSON, no markdown. For a SIMPLE rule:
{"ok":true,"kind":"simple","tf":"..." OR "tfs":["...","..."],"operator":"below|above","level":<number|null>,"lineId":<number|null>,"onceOnly":<true|false>,"label":"..."}
Set "onceOnly":true ONLY when the trader specifies a SINGLE upcoming candle — phrases like "the next candle", "the next 1h candle", "if the next candle closes...". This means: check only the very next candle on that timeframe; if it does not trigger, the rule is cancelled. For any ongoing condition ("if a 4h closes below", "whenever", "as soon as"), set "onceOnly":false.

MULTIPLE TIMEFRAMES: if the trader lists several timeframes (e.g. "1h, 4h, daily and weekly" or "on any of 1h/4h/1D/1W"), return a "tfs" ARRAY of the exact tf strings instead of a single "tf". Example: "tfs":["Min60","Hour4","Day1","Week1"]. The rule then fires if a candle on ANY of those timeframes closes past the level. Weekly = Week1. When only one timeframe is named, use "tf" as normal (no tfs array).
For a FAILED RETEST rule:
{"ok":true,"kind":"failed_retest","tf":"..." OR "tfs":["...","..."],"operator":"below|above","level":<number|null>,"lineId":<number|null>,"retestPct":<number, default 0.1>,"label":"..."}

Rules:
- tf exact strings: 4h=Hour4, 1h=Min60, 15m=Min15, 5m=Min5, 30m=Min30, daily=Day1.
- A price → "level" (lineId null). A drawn line → "lineId" (level null).
- operator "below" = the break/close is below the level; "above" = above.
- retestPct: how close the wick must come to the line to count as a retest (percent). Default 0.1 if unspecified.

STRICT — DO NOT GUESS. Every rule MUST have: a timeframe, an operator (above/below), and a target (a specific price OR a specific drawn line that exists in the list above). If ANY of these is missing or ambiguous, DO NOT fill it in with an assumption. Instead respond:
{"ok":false,"needsClarification":true,"reason":"<one short sentence naming exactly what to add>"}
Examples of when to refuse with needsClarification:
- No timeframe given → reason: "Which timeframe? e.g. 4h, 1h, 15m."
- Refers to "the line" but multiple lines exist or none match → reason: "Which line? Available: #1, #3. Name the number."
- Refers to a line number that isn't in the available list → reason: "Line #5 isn't on your chart. Available: #1, #3."
- No price and no line → reason: "What level — a price (e.g. 63000) or which drawn line?"
- Direction unclear (doesn't say above/below or break up/down) → reason: "Close on a break above or below the level?"

Only if the instruction is genuinely not an exit rule at all (gibberish, unrelated), respond {"ok":false,"reason":"Couldn't understand that as an exit rule — try rephrasing."}

- label: short clear summary. If onceOnly, say so, e.g. "NEXT 1h candle close below $63,000 (one-shot)". Otherwise "4h close below $63,000" or "4h failed retest of line 3".`;
    try{
      const raw = await callClaude(prompt);
      const parsed = JSON.parse(raw.replace(/```json|```/g,'').trim());
      return json(res,200, parsed);
    }catch(e){
      return json(res,500,{ok:false, reason:'parse failed: '+e.message});
    }
  }

  // ── Attach/replace custom exit rules on a LIVE trade ──
  if(url==='/bot/set-exits' && req.method==='POST'){
    const b = await readBody(req);
    const bot = bots.find(x=>x.id===b.botId);
    if(!bot || !bot.activeTrade) return json(res,400,{error:'no active trade for that bot'});
    const t = bot.activeTrade;
    const incoming = expandExitRules(Array.isArray(b.rules) ? b.rules : []);
    // append mode (default) adds to existing rules; replace clears first
    if(b.replace) { t.customExits = []; t._retestStage = {}; t._customExitCandle = {}; }
    t.customExits = t.customExits || [];
    t._retestStage = t._retestStage || {};
    for(const rule of incoming){
      if(t.customExits.length >= 5) break;
      t.customExits.push(rule);
      const ri = t.customExits.length - 1;
      const ruleKey = (rule.kind||'simple') + ':' + ri + ':' + rule.tf + ':' + (rule.lineId!=null?('L'+rule.lineId):rule.level);
      // For a failed-retest rule attached mid-trade: if the trader said the break
      // is already confirmed (price already past the line), pre-seed stage 2.
      if(rule.kind==='failed_retest' && rule.breakAlreadyConfirmed){
        t._retestStage[ruleKey] = true;
        blog(`📜 Bot #${bot.id} failed-retest rule attached with break PRE-CONFIRMED — watching for rejection now.`,'info');
      }
    }
    blog(`📜 Bot #${bot.id} custom exit rules updated (${t.customExits.length} total)`,'ok');
    saveState();
    return json(res,200,{ok:true, customExits:t.customExits});
  }

  // ── TICKER — cached 1.5s, shared across all browser tabs + bots ──
  if(url.startsWith('/ticker')){
    const symbol = new URL('http://x'+url).searchParams.get('symbol') || 'BTC_USDT';
    const cacheKey = 'ticker:'+symbol;
    const cached = mexcPublicCache.get(cacheKey);
    if(cached && Date.now()-cached.t < 1500){
      res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','X-Cache':'HIT'});
      return res.end(JSON.stringify(cached.v));
    }
    try{
      const d = await mexcPublic(`/api/v1/contract/ticker?symbol=${symbol}`);
      if(d && d.success){
        mexcPublicCache.set(cacheKey, {t:Date.now(), v:d});
      }
      res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify(d));
    }catch(e){ json(res,502,{error:e.message}); }
    return;
  }

  // ── ADOPT an existing MEXC position into bot management ──
  if(url==='/trade/adopt' && req.method==='POST'){
    const b = await readBody(req);
    const qty = Math.max(1, Math.round(parseFloat(b.qty)||1));
    const entry = parseFloat(b.entryPrice);
    if(!entry || !b.side) return json(res,400,{error:'entryPrice and side required'});

    // Guard: refuse double-adoption of the same position (symbol + side)
    const existing = bots.find(x => x.activeTrade &&
      x.config.symbol === (b.symbol||'BTC_USDT') &&
      x.activeTrade.side === b.side);
    if(existing){
      return json(res,409,{error:`Already managed by Bot #${existing.id}. Disarm it first to re-adopt with new settings.`});
    }

    const side = b.side; // 'BUY' | 'SELL'
    const lev  = Math.max(1, parseInt(b.leverage)||1);

    // SL price: from explicit price, % entry, or % margin
    let slPrice = parseFloat(b.slPrice)||0;
    if(!slPrice && b.slValue){
      let movePct = parseFloat(b.slValue)||1;
      if(b.slType==='margin') movePct = movePct / lev;
      slPrice = side==='BUY' ? entry*(1-movePct/100) : entry*(1+movePct/100);
    }

    const tpLevels = (b.tpLevels && b.tpLevels.length) ? b.tpLevels : [{pct:2, size:100}];
    const tpPrice = tpLevels[0].type==='price' ? tpLevels[0].price
      : (side==='BUY' ? entry*(1+(tpLevels[0].pct||2)/100) : entry*(1-(tpLevels[0].pct||2)/100));

    // Optionally place a real SL on MEXC
    let mexcSlOrderId = null;
    if(b.placeRealSl && slPrice > 0){
      try{
        const closeSide = side==='BUY' ? 4 : 2;
        const slRes = await placeStopOrder(b.symbol, closeSide, qty, slPrice, lev);
        if(slRes.success) mexcSlOrderId = slRes.data;
      }catch(e){}
    }

    const bot = {
      id: ++botIdCounter,
      config: { symbol: b.symbol||'BTC_USDT', manualOnly: true, leverage: lev, marginType:'isolated', qty,
                tp:{mode:b.tpMode||'price', type:'pct', value:tpLevels[0].pct||2, tf:b.tpTf||'Min15', levels:tpLevels, breakEvenOnHit:!!b.breakEvenOnHit},
                sl:{mode:b.slMode||'price', type:'pct', value:b.slValue||1, tf:b.slTf||'Min15'} },
      activeTrade: {
        side, entryPrice: entry, tpPrice, slPrice, qty, leverage: lev,
        tpPct: tpLevels[0].pct||2, tpLevels, breakEvenOnHit: !!b.breakEvenOnHit, activeTpCount: 0,
        tp:{mode:b.tpMode||'price', tf:b.tpTf||'Min15'},
        sl:{mode:b.slMode||'price', tf:b.slTf||'Min15'},
        mexcSlOrderId,
        openedAt: Date.now(),
      },
      lastCandleTime:null, lastTpCandle:null, lastSlCandle:null, syncCounter:0,
    };
    bots.push(bot);
    blog(`🤝 Bot #${bot.id} ADOPTED existing ${side} position @ $${entry} (${qty} contracts, ${lev}×) | TP levels: ${JSON.stringify(tpLevels)} | SL: $${slPrice.toFixed(2)}${mexcSlOrderId?' (real SL ✓)':''}`,'ok');
    sendTelegram(`🤝 <b>Bot #${bot.id} adopted position</b>\n${b.symbol} ${side} @ $${entry}\nQty: ${qty} | ${lev}×\nSL: $${slPrice.toFixed(2)}${mexcSlOrderId?' (on exchange ✓)':''}\nTP levels: ${tpLevels.length}`);
    saveState();
    return json(res,200,{adopted:true, botId: bot.id});
  }

  // ── CHART LINE SYNC across devices ──
  if(url==='/lines/save' && req.method==='POST'){
    const b = await readBody(req);
    if(b.symbol) savedChartLines[b.symbol] = b.data || {lines:[]};
    saveState();
    return json(res,200,{saved:true});
  }
  if(url.startsWith('/lines/load')){
    const symbol = new URL('http://x'+url).searchParams.get('symbol') || 'BTC_USDT';
    return json(res,200, savedChartLines[symbol] || null);
  }

  // ── PATTERN BOT endpoints ──
  if(url==='/ai2/pattern/start' && req.method==='POST'){
    const bot = aiBots.pattern;
    const b = await readBody(req);
    if(!ANTHROPIC_KEY) return json(res,400,{error:'Pattern bot needs ANTHROPIC_API_KEY in Railway'});
    bot.enabled = true;
    bot.paper = b.paper !== false; // default paper
    bot.allocation = parseFloat(b.allocation)||100;
    bot.startEquity = aiEquity(bot);
    bot.decisionTf = b.decisionTf || 'Min60';
    bot.symbol = b.symbol || 'BTC_USDT';
    if(b.lineSource) bot.lineSource = b.lineSource;
    if(b.swingMode != null) bot.swingMode = !!b.swingMode;
    if(b.riskPct != null) bot.maxRiskPct = Math.min(20, Math.max(0.5, parseFloat(b.riskPct)||5));
    // Mark the most-recent CLOSED candle as already-seen, so the bot waits for
    // the NEXT candle to close before deciding — rather than acting immediately
    // on the candle in progress at the moment you press start.
    try{
      const c = await getLastClosedCandle(bot.symbol, bot.decisionTf);
      bot.lastDecisionCandle = c ? c.time : null;
      if(c) blog(`Pattern bot will wait for the next ${bot.decisionTf} close (last closed candle @ ${new Date(c.time*1000).toISOString().slice(11,16)}Z seen)`,'info');
    }catch(e){ bot.lastDecisionCandle = null; }
    blog(`🧠 PATTERN bot STARTED — $${bot.allocation} ${bot.paper?'PAPER':'LIVE'} [${bot.decisionTf}] lines:${bot.lineSource}`,'ok');
    sendTelegram(`🧠 <b>Pattern bot started</b>\n$${bot.allocation} ${bot.paper?'📝 paper':'💸 LIVE'} | ${bot.decisionTf}`);
    return json(res,200,{started:true});
  }
  if(url==='/ai2/pattern/stop' && req.method==='POST'){
    aiBots.pattern.enabled = false;
    blog(`🧠 PATTERN bot stopped`,'warn');
    saveState();
    return json(res,200,{stopped:true});
  }
  if(url==='/ai2/pattern/setmode' && req.method==='POST'){
    const b = await readBody(req);
    if(b.swingMode != null){ aiBots.pattern.swingMode = !!b.swingMode;
      blog(`🧠 Pattern bot swing mode ${aiBots.pattern.swingMode?'ON — will swing from S/R after reversals':'OFF — breakout only'}`,'ok'); saveState(); }
    if(b.lineSource){ aiBots.pattern.lineSource = b.lineSource; saveState(); }
    if(b.useAiLines != null){
      // useAiLines on → 'both' (your lines authoritative + AI fills obvious gaps); off → 'user' (only your lines)
      aiBots.pattern.lineSource = b.useAiLines ? 'both' : 'user';
      blog(`📐 Pattern bot lines: ${b.useAiLines?'YOUR lines + AI may fill obvious gaps (dotted)':'YOUR lines ONLY'}`,'ok');
      saveState();
    }
    return json(res,200,{swingMode:aiBots.pattern.swingMode, lineSource:aiBots.pattern.lineSource});
  }
  if(url==='/ai2/pattern/close' && req.method==='POST'){
    const bot = aiBots.pattern;
    if(!bot.position) return json(res,400,{error:'no open position'});
    await aiBotClose(bot, 'manual close from app');
    saveState();
    return json(res,200,{closed:true});
  }
  // ── SENTIMENT ──
  if(url==='/sentiment/get'){
    // return cached read without spending anything
    return json(res,200,{ text: sentimentCache.text, at: sentimentCache.at });
  }
  if(url==='/sentiment/refresh' && req.method==='POST'){
    if(!ANTHROPIC_KEY) return json(res,400,{error:'needs ANTHROPIC_API_KEY'});
    // Pull each analyst's LATEST video — but never let it break sentiment.
    let vids = [];
    try{ vids = await fetchLatestVideos(); }
    catch(e){ blog(`Sentiment: YouTube fetch failed (continuing without it): ${e.message}`,'warn'); }
    let vidContext = '';
    if(vids.length){
      vidContext = '\n\nLATEST YOUTUBE VIDEOS (from the official YouTube Data API — use these as the most current, datable signal of each analyst\'s stance; the title and description tell you their newest framing):\n'
        + vids.map(v=> v.found
            ? `- ${v.name}: "${v.title}" (posted ${v.hoursAgo}h ago${v.fresh24h?' — FRESH, within 24h':''}). Description: ${v.desc}`
            : `- ${v.name}: no latest video retrieved`).join('\n')
        + '\n\nPRIORITISE content from the last 24 hours. If an analyst\'s newest video is within 24h, weight it heavily and note it as a fresh read. If their most recent datable view is older, say how old it is rather than presenting it as current.';
    }
    const prompt = `Search the web for the most recent Bitcoin/crypto outlook from each of these analysts INDIVIDUALLY, searching each by name separately so you get a distinct read on each one:
- Benjamin Cowen (Into The Cryptoverse)
- MMCrypto
- Gareth Soloway
- Jason Pizzino
- Kyle Stagoll (also known as "Trader Daxx", founder of Market Mastery — search both names; he often appears as a guest on other channels and posts on X/Substack, so look there too)
Also check Google Trends interest for "Bitcoin" as a gauge of general retail attention.

Give a SEPARATE read for each person. Output PLAIN TEXT ONLY — no markdown, no asterisks, no bold, no dashes as separators, no headings. Each section MUST start on its own new line with the marker in square brackets, exactly like the template. Do NOT echo the placeholder hints (do not write "1-2 sentences" or "<leaning>" literally) — replace them with the actual content.

Template (replace the angle-bracket parts with real content, keep the [MARKERS] literally):
[OVERALL] LEANING then a short sentence on the spread of views
[COWEN] LEANING then 1-2 sentences, paraphrased
[MMCRYPTO] LEANING then 1-2 sentences
[SOLOWAY] LEANING then 1-2 sentences
[PIZZINO] LEANING then 1-2 sentences
[STAGOLL] LEANING then 1-2 sentences (Kyle Stagoll / Trader Daxx)
[COMMUNITY] one line on Google Trends / general attention
[CONTRARIAN] one sentence flagging if views are lopsided

Where LEANING is one of: BULLISH, BEARISH, NEUTRAL, MIXED, UNCERTAIN, or NO RECENT READ.
Put a blank line between each section. Start each line with its [MARKER] and nothing before it.
Paraphrase in your own words, never quote them directly. If you can't find recent info on someone, write "[NAME] NO RECENT READ —" then say so briefly. Keep each section to 1-2 sentences — be concise.

For each analyst, ALSO note in their line how fresh the read is (e.g. "fresh 24h video" or "last datable view 5 days ago").` + vidContext;
    try{
      const text = await callClaudeWithSearch(prompt, 1800);
      sentimentCache = { text, at: Date.now() };
      saveState();
      return json(res,200,{ text, at: sentimentCache.at });
    }catch(e){
      return json(res,500,{error:'sentiment failed: '+e.message});
    }
  }

  // ── JOURNAL CRUD (mirrored to client localStorage) ──
  if(url==='/ai2/pattern/journal' && req.method==='GET' || url==='/ai2/pattern/journal/list'){
    return json(res,200,{journal: patternJournal});
  }
  if(url==='/ai2/pattern/journal/add' && req.method==='POST'){
    const b = await readBody(req);
    const entry = { id: Date.now()+''+Math.floor(Math.random()*1000),
                    t: Date.now(), kind: b.kind||'note', text: (b.text||'').slice(0,500) };
    if(!entry.text) return json(res,400,{error:'empty'});
    patternJournal.push(entry);
    if(patternJournal.length > 200) patternJournal.shift();
    blog(`📓 Journal +${entry.kind}: ${entry.text.slice(0,80)}`,'info');
    saveState();
    return json(res,200,{added:entry, journal:patternJournal});
  }
  if(url==='/ai2/pattern/journal/delete' && req.method==='POST'){
    const b = await readBody(req);
    patternJournal = patternJournal.filter(e=>e.id!==b.id);
    saveState();
    return json(res,200,{journal:patternJournal});
  }
  if(url==='/ai2/pattern/journal/seed' && req.method==='POST'){
    // client re-seeds server memory after a restart from its localStorage mirror
    const b = await readBody(req);
    if(Array.isArray(b.journal) && !patternJournal.length){
      patternJournal = b.journal.slice(0,200);
      blog(`📓 Journal re-seeded from client: ${patternJournal.length} entries`,'ok');
    }
    return json(res,200,{journal:patternJournal});
  }

  // ── CHAT with the pattern bot ──
  // ── TRADE COMPANION: honest feedback on a planned trade ──
  if(url==='/companion/feedback' && req.method==='POST'){
    if(!ANTHROPIC_KEY) return json(res,400,{error:'needs ANTHROPIC_API_KEY'});
    const b = await readBody(req);
    const plan = (b.plan||'').slice(0,1500);
    const history = Array.isArray(b.history) ? b.history.slice(-10) : [];
    if(!plan) return json(res,400,{error:'empty plan'});
    let px = null; try{ px = await getTicker('BTC_USDT'); }catch(e){}
    const convo = history.map(m=>`${m.role==='user'?'TRADER':'COMPANION'}: ${m.text}`).join('\n');
    const prompt = `You are an experienced, HONEST trading companion for a futures trader. They will describe a trade they are planning. Your job is to be a genuine sparring partner — NOT a cheerleader.

Rules for your feedback:
- Be direct and honest. If the plan looks weak, say so plainly and explain why.
- Name the specific risks: poor risk/reward, trading into a level, no clear invalidation, chasing, position too large, emotional tells in their wording.
- Ask sharp questions: where's the stop, where's invalidation, what's the reward-to-risk, what would make you wrong?
- Acknowledge what's GOOD about the plan too, when it's genuinely good — but never invent praise.
- Do NOT just agree to be nice. A companion that validates everything is useless and harmful.
- Keep it concise and conversational (a few sentences to a short paragraph). You're talking with them, not writing an essay.
${px?`Current BTC price ≈ $${px}.`:''}
${convo?`\nConversation so far:\n${convo}\n`:''}
TRADER'S PLAN / MESSAGE: ${plan}

Give your honest companion response:`;
    try{
      const text = await callClaude(prompt);
      return json(res,200,{ feedback: text });
    }catch(e){ return json(res,500,{error:e.message}); }
  }

  // ── RESEARCH LIBRARY endpoints ──
  if(url==='/library/add' && req.method==='POST'){
    const b = await readBody(req);
    const entry = { id: Date.now()+''+Math.floor(Math.random()*1000), t: Date.now(),
      plan: (b.plan||'').slice(0,1500), feedback: (b.feedback||'').slice(0,2000), symbol: b.symbol||'BTC_USDT' };
    researchLibrary.push(entry);
    if(researchLibrary.length>100) researchLibrary.shift();
    saveState();
    return json(res,200,{ok:true, entry, count:researchLibrary.length});
  }
  if(url==='/backtest/context'){
    // Returns the journal + library prompt blocks EXACTLY as the live decision
    // prompt builds them, so the backtest script matches the live bot byte-for-byte.
    return json(res,200,{
      journalBlock: journalForPrompt(),
      libraryBlock: libraryForPrompt(),
      libraryEnabled,
    });
  }
  if(url.startsWith('/library/list')){
    return json(res,200,{ entries: researchLibrary.slice(-50), enabled: libraryEnabled, count: researchLibrary.length });
  }
  if(url==='/library/delete' && req.method==='POST'){
    const b = await readBody(req);
    researchLibrary = researchLibrary.filter(e=>e.id!==b.id);
    saveState();
    return json(res,200,{ok:true, count:researchLibrary.length});
  }
  if(url==='/library/toggle' && req.method==='POST'){
    const b = await readBody(req);
    libraryEnabled = !!b.enabled;
    blog(`📚 Research library ${libraryEnabled?'ENABLED':'DISABLED'} for the pattern bot`,'ok');
    saveState();
    return json(res,200,{ok:true, enabled:libraryEnabled});
  }

  if(url==='/ai2/pattern/chat' && req.method==='POST'){
    if(!ANTHROPIC_KEY) return json(res,400,{error:'needs ANTHROPIC_API_KEY'});
    const b = await readBody(req);
    const userMsg = (b.message||'').slice(0,1000);
    if(!userMsg) return json(res,400,{error:'empty message'});
    const bot = aiBots.pattern;

    // Context: live market snapshot + recent decisions + the journal
    let mkt = '';
    try{
      const price = await getTicker(bot.symbol);
      mkt = `Current ${bot.symbol} price: $${price}. Bot is ${bot.enabled?'RUNNING':'stopped'}, ${bot.paper?'paper':'LIVE'}, equity $${aiEquity(bot).toFixed(2)}, position: ${bot.position?bot.position.side+' @ $'+bot.position.entryPrice:'none'}.`;
    }catch(e){}
    const recent = bot.decisions.slice(-6).map(d=>`${new Date(d.t).toLocaleString()}: ${d.action}${d.pattern&&d.pattern!=='none'?' ['+d.pattern+']':''} — ${d.reasoning}`).join('\n') || 'No decisions yet.';
    const history = (b.history||[]).slice(-8).map(m=>`${m.role==='user'?'TRADER':'BOT'}: ${m.text}`).join('\n');

    const prompt = `You are the trader's chart-pattern swing-trading bot for ${bot.symbol}. You are having a conversation with the trader. Be concise, direct, and willing to PUSH BACK — if they suggest something you think is risky or contradicts good risk management, say so plainly. You're a thoughtful trading partner, not a yes-man.

${mkt}

YOUR RECENT DECISIONS:
${recent}

${journalForPrompt()||'No journal entries yet.'}

CONVERSATION SO FAR:
${history}

TRADER: ${userMsg}

Reply conversationally (2-5 sentences). If the trader is giving you a standing rule to follow or an observation worth remembering, end your reply with a line exactly like:
[JOURNAL:instruction] the rule in your words
or
[JOURNAL:note] the observation in your words
Only add that tag if it's genuinely a durable instruction/lesson — not for ordinary chat.`;

    let reply='';
    try{ reply = await callClaude(prompt); }
    catch(e){ return json(res,500,{error:'chat failed: '+e.message}); }

    // Auto-capture a journal entry if the bot proposed one
    let captured = null;
    const m = reply.match(/\[JOURNAL:(instruction|note)\]\s*(.+)$/m);
    if(m){
      captured = { id: Date.now()+''+Math.floor(Math.random()*1000), t: Date.now(), kind: m[1], text: m[2].trim().slice(0,500) };
      patternJournal.push(captured);
      reply = reply.replace(/\[JOURNAL:(instruction|note)\]\s*.+$/m,'').trim();
    }
    return json(res,200,{reply, captured, journal:patternJournal});
  }

  if(url==='/ai2/pattern/status'){
    const bot = aiBots.pattern;
    let curPrice = null;
    if(bot.position){ try{ curPrice = await getTicker(bot.symbol); }catch(e){} }
    return json(res,200,{
      enabled: bot.enabled, paper: bot.paper, hasApiKey: !!ANTHROPIC_KEY,
      allocation: bot.allocation, realizedPnl: bot.realizedPnl,
      currentPrice: curPrice, contractSize: contractSize(bot.symbol), symbol: bot.symbol,
      position: bot.position, decisions: bot.decisions.slice(-12),
      tradeHistory: bot.tradeHistory.slice(-200), decisionTf: bot.decisionTf,
      equityCurve: (()=>{ let eq=bot.allocation||100; const out=[{t:null, eq}];
        for(const tr of bot.tradeHistory){ eq+=tr.pnl; out.push({t:tr.t, eq:+eq.toFixed(2)}); } return out; })(),
      startAllocation: bot.allocation||100,
      lineSource: bot.lineSource, aiLines: bot.aiLines, swingMode: !!bot.swingMode, riskPct: bot.maxRiskPct,
      aiSrLines: bot.aiSrLines||[], useAiLines: (bot.lineSource==='both'||bot.lineSource==='ai'),
      userLines: (savedChartLines[bot.symbol] && savedChartLines[bot.symbol].lines) || [],
    });
  }

  if(url==='/logs'){
    res.writeHead(200, {
      'Content-Type':'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Headers':'*',
    });
    return res.end(botLogs.map(l=>`[${l.t}] [${l.type||'info'}] ${l.msg}`).join('\n') || '(empty)');
  }

  if(url==='/bot/status'){
    return json(res,200,{
      armed: bots.length > 0,
      bots: bots.map(b => ({
        id: b.id,
        symbol: b.config.symbol,
        dir: b.config.dir,
        trigTf: b.config.trigTf,
        triggerSource: b.config.triggerSource,
        manualPrice: b.config.manualPrice,
        selectedLineId: b.config.selectedLineId,
        // actual trigger level from the bot's SNAPSHOT (immune to chart edits)
        phase: b.phase||null,
        triggerLevel: (()=>{
          try{
            if(b.config.triggerSource==='price') return parseFloat(b.config.manualPrice)||null;
            const ln = (b.config.lines||[]).find(l=>String(l.id)===String(b.config.selectedLineId));
            if(!ln) return null;
            return ln.isHoriz ? ln.horizPrice : null; // trend lines: level varies by candle
          }catch(e){ return null; }
        })(),
        manualOnly: !!b.config.manualOnly,
        leverage: b.config.leverage,
        qty: b.config.qty,
        activeTrade: b.activeTrade,
        config: b.config, // full config for the edit feature
      })),
      logs: botLogs.slice(-20),
    });
  }

  // ── MANUAL TRADES (server-managed) ──
  if(url==='/trade/open' && req.method==='POST'){
    const b = await readBody(req);
    b.qty = Math.max(1, Math.round(parseFloat(b.qty)||1));
    if(b.leverage > 1){
      await mexcRequest('POST','/api/v1/private/position/change_leverage',{
        symbol: b.symbol, leverage: b.leverage, openType: b.marginType==='isolated'?1:2
      }).catch(()=>{});
    }
    const futSide = b.side==='BUY' ? 1 : 3;
    const r = await placeOrder(b.symbol, futSide, b.qty, b.leverage, b.marginType==='isolated'?1:2, b.limitPrice||0, b.orderType==='LIMIT'?1:5);
    if(r.success){
      const bot = {
        id: ++botIdCounter,
        config: { symbol: b.symbol, manualOnly: true, leverage: b.leverage, marginType: b.marginType, qty: b.qty,
                  tp:{mode:b.tpMode,type:'pct',value:0,tf:b.tpTf}, sl:{mode:b.slMode,type:'pct',value:0,tf:b.slTf} },
        activeTrade: {
          side: b.side, entryPrice: b.entryPrice, tpPrice: b.tpPrice, slPrice: b.slPrice,
          qty: b.qty, leverage: b.leverage,
          tp: { mode: b.tpMode, tf: b.tpTf }, sl: { mode: b.slMode, tf: b.slTf },
          openedAt: Date.now(),
        },
        lastCandleTime: null, lastTpCandle: null, lastSlCandle: null, syncCounter: 0,
      };
      bots.push(bot);
      blog(`Manual ${b.side} opened @ ${b.entryPrice} (managed as Bot #${bot.id})`, 'ok');
      return json(res,200,{success:true, orderId:r.data, botId: bot.id});
    }
    return json(res,500,r);
  }

  if(url==='/trade/close' && req.method==='POST'){
    const b = await readBody(req);
    // Find the bot: by id if given, else first bot with an open trade
    const bot = b.botId != null
      ? bots.find(x => x.id === parseInt(b.botId))
      : bots.find(x => x.activeTrade);
    if(!bot || !bot.activeTrade) return json(res,400,{error:'no active trade'});

    const fraction = Math.min(1, Math.max(0, parseFloat(b.fraction)||1));
    const symbol = bot.config.symbol || b.symbol || 'BTC_USDT';
    const price = await getTicker(symbol);

    if(fraction >= 0.999){
      await exitTrade(bot, 'MANUAL', price || bot.activeTrade.entryPrice);
      return json(res,200,{closed:true, fraction:1, botId: bot.id});
    }

    const closeVol = Math.max(1, Math.floor(bot.activeTrade.qty * fraction));
    const closeSide = bot.activeTrade.side==='BUY' ? 4 : 2;
    const r = await placeOrder(symbol, closeSide, closeVol, bot.activeTrade.leverage, 1, 0, 5);
    if(r.success){
      bot.activeTrade.qty -= closeVol;
      blog(`Bot #${bot.id} partial close ${Math.round(fraction*100)}% (${closeVol} contracts) @ ${price}`, 'ok');
      let remaining = bot.activeTrade.qty;
      if(remaining <= 0){
        bot.activeTrade = null; remaining = 0;
        if(bot.config.manualOnly) bots = bots.filter(x => x.id !== bot.id);
      }
      return json(res,200,{closed:true, fraction, remaining, botId: bot.id});
    }
    return json(res,500,r);
  }

  // Close a raw MEXC position (not app-managed)
  if(url==='/position/close' && req.method==='POST'){
    const b = await readBody(req);
    // positionType: 1=long → close side 4; 2=short → close side 2
    const closeSide = b.positionType === 1 ? 4 : 2;
    const vol = Math.max(1, Math.floor(parseFloat(b.vol)||0));
    if(!vol || !b.symbol) return json(res,400,{error:'symbol and vol required'});
    const r = await placeOrder(b.symbol, closeSide, vol, b.leverage||1, 1, 0, 5);
    if(r.success){
      blog(`Closed ${vol} contracts of ${b.symbol} (MEXC position)`, 'ok');
      return json(res,200,{closed:true, vol});
    }
    return json(res,500,r);
  }

  json(res,404,{error:'not found'});

}).listen(PORT, ()=> {
  // ── RESTORE persisted state (survives restarts via Railway volume) ──
  const st = loadState();
  if(st){
    try{
      if(Array.isArray(st.bots)) bots = st.bots;
      if(st.botIdCounter) botIdCounter = st.botIdCounter;
      if(st.patternJournal) patternJournal = st.patternJournal;
      if(st.researchLibrary) researchLibrary = st.researchLibrary;
      if(st.libraryEnabled != null) libraryEnabled = st.libraryEnabled;
      if(st.savedChartLines) savedChartLines = st.savedChartLines;
      if(st.sentimentCache) sentimentCache = st.sentimentCache;
      if(st.patternBot && aiBots.pattern) Object.assign(aiBots.pattern, st.patternBot);
      const openTrades = bots.filter(b=>b.activeTrade).length + (aiBots.pattern&&aiBots.pattern.position?1:0);
      blog(`🔄 SERVER STARTED — build ${SERVER_BUILD} — RESTORED ${bots.length} bot(s), ${openTrades} open trade(s), ${patternJournal.length} journal entries from volume`, 'ok');
      sendTelegram(`🔄 <b>Server restarted — state RESTORED</b>\n${bots.length} bot(s), ${openTrades} open trade(s) recovered from disk. No re-arm needed.`);
    }catch(e){
      blog(`🔄 SERVER STARTED — build ${SERVER_BUILD} — restore error: ${e.message}`, 'err');
    }
  } else {
    blog(`🔄 SERVER STARTED — build ${SERVER_BUILD} (no saved state — fresh start)`, 'warn');
  }
  console.log(`MEXC Trend Trader server on :${PORT}`);
  console.log(APP_PASSWORD ? '🔒 Password auth enabled' : '⚠️  Set APP_PASSWORD env var!');
  console.log(MEXC_KEY ? '🔑 MEXC keys loaded' : '⚠️  Set MEXC_API_KEY / MEXC_API_SECRET env vars!');
  console.log(TG_TOKEN && TG_CHAT ? '📨 Telegram alerts enabled' : 'ℹ️  Telegram off — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to enable');
  console.log(ANTHROPIC_KEY ? '🧠 AI Trader available' : 'ℹ️  AI Trader off — set ANTHROPIC_API_KEY to enable');
});
