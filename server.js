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

// ── Saved chart lines (synced across devices; cleared on restart) ──
let savedChartLines = {}; // { symbol: {lines:[...]} }

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

function priceOnLine(line, t){
  if(line.isHoriz) return line.horizPrice;
  const slope = (line.p2.price - line.p1.price) / (line.p2.time - line.p1.time);
  return line.p1.price + slope * (t - line.p1.time);
}

async function getLastClosedCandle(symbol, interval){
  const d = await mexcPublic(`/api/v1/contract/kline/${symbol}?interval=${interval}&limit=3`);
  if(!d || !d.success || !d.data || !d.data.time || d.data.time.length < 2) return null;
  const i = d.data.time.length - 2;
  return { time: parseInt(d.data.time[i]), close: parseFloat(d.data.close[i]) };
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
  const payload = {
    symbol,
    side,
    vol,
    leverage: leverage||1,
    openType: 1, // isolated
    triggerPrice,
    executeCycle: 1,
    orderType: 1, // market on trigger
    trend: side===4 ? 2 : 1, // 1=price rises to trigger (for shorts), 2=price falls (for longs closing)
  };
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
        blog(`⚠️ Bot #${bot.id}: position closed externally on MEXC — clearing tracking`,'warn');
        sendTelegram(`⚠️ <b>Bot #${bot.id}: position closed externally</b> on MEXC — tracking cleared. Bot remains armed.`);
        bot.activeTrade = null;
        return;
      }
    }
  }

  // ── Manage open trade exits ──
  if(bot.activeTrade){
    const t = bot.activeTrade;
    const price = t.tp.mode==='price' || t.sl.mode==='price'
      ? await getTicker(cfg.symbol) : null;

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
        sendTelegram(`🎯 <b>Bot #${bot.id} TP${i+1} hit!</b> ${cfg.symbol}\nLevel: +${lvl.pct}% | Closing ${lvl.size}% of position\nPrice: $${checkPrice||checkCandle?.close}`);

        const closeSide = t.side==='BUY' ? 4 : 2;
        const r = await placeOrder(cfg.symbol, closeSide, exitVol, t.leverage, 1, 0, 5);
        if(r.success){
          t.qty -= exitVol;
          t.activeTpCount = i + 1;
          if(isLast || t.qty <= 0){
            // All TPs done — trade fully closed
            bot.activeTrade = null;
            blog(`✅ Bot #${bot.id} all TPs complete — trade closed`, 'ok');
            if(bot.config.manualOnly) bots = bots.filter(b=>b.id!==bot.id);
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
  const candle = await getLastClosedCandle(cfg.symbol, cfg.trigTf);
  if(!candle || candle.time === bot.lastCandleTime) return;
  bot.lastCandleTime = candle.time;

  const dir  = cfg.dir;
  const side = dir==='above' ? 'BUY' : 'SELL';
  let triggered = false, triggerLabel = '';

  if(cfg.triggerSource === 'price'){
    const tp = parseFloat(cfg.manualPrice);
    triggered = (dir==='above' && candle.close > tp) || (dir==='below' && candle.close < tp);
    triggerLabel = `manual price ${tp}`;
  } else {
    const lines = cfg.selectedLineId==='all'
      ? cfg.lines
      : cfg.lines.filter(l => String(l.id)===String(cfg.selectedLineId));
    for(const line of lines){
      const lp = priceOnLine(line, candle.time);
      if((dir==='above' && candle.close > lp) || (dir==='below' && candle.close < lp)){
        triggered = true; triggerLabel = `line #${line.id} @ ${lp.toFixed(4)}`;
        break;
      }
    }
  }

  if(!triggered) return;
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
    orderQty = Math.max(1, Math.round(cfg.qtyUsdt / entry / 0.0001));
  }
  const futSide = side==='BUY' ? 1 : 3;
  const res = await placeOrder(cfg.symbol, futSide, orderQty, cfg.leverage, cfg.marginType==='isolated'?1:2, 0, 5);
  if(res.success){
    bot.failCount = 0;
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
      mexcSlOrderId,
      openedAt: Date.now(),
    };
    bot.lastTpCandle = null; bot.lastSlCandle = null;
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
  bot.activeTrade = null;
  // Manual-only bots are done once their trade closes
  if(bot.config.manualOnly) bots = bots.filter(b => b.id !== bot.id);
}

setInterval(botTick, 8000); // bot heartbeat every 8s

// ─────────────────────────────────────────────────────────────
// AI TRADER — Claude makes every trading decision via the API
// ─────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

let aiTrader = {
  enabled: false,
  symbol: 'BTC_USDT',
  decisionTf: 'Min60',        // decision cadence = 1h candle closes
  allocatedUsd: 100,          // the AI's trading allocation
  startBalance: 100,          // for drawdown kill-switch
  maxLeverage: 10,
  maxRiskPct: 5,              // max % of allocation risked per trade
  killSwitchPct: 50,          // stop everything at -50%
  position: null,             // { side, entryPrice, qty, leverage, tpPrice, slPrice }
  realizedPnl: 0,
  decisions: [],              // log of decisions with reasoning
  lastDecisionCandle: null,
  tradeHistory: [],           // closed trades for context
};

function aiLog(msg, type=''){
  blog(`[AI] ${msg}`, type);
}

function callClaude(prompt){
  return new Promise((resolve, reject)=>{
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
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

async function aiTraderTick(){
  if(!aiTrader.enabled || !ANTHROPIC_KEY) return;
  try{
    // Kill switch check
    const equity = aiTrader.allocatedUsd + aiTrader.realizedPnl + aiUnrealized();
    if(equity <= aiTrader.startBalance * (1 - aiTrader.killSwitchPct/100)){
      aiLog(`💀 KILL SWITCH — equity $${equity.toFixed(2)} hit -${aiTrader.killSwitchPct}% drawdown. AI trading stopped.`,'err');
      sendTelegram(`💀 <b>AI Trader kill switch</b>\nEquity: $${equity.toFixed(2)} — trading stopped.`);
      if(aiTrader.position) await aiClosePosition('KILL SWITCH');
      aiTrader.enabled = false;
      return;
    }

    // Manage open position exits first (price-based TP/SL every tick)
    if(aiTrader.position){
      const p = await getTicker(aiTrader.symbol);
      if(p != null){
        const pos = aiTrader.position;
        const tpHit = pos.side==='BUY' ? p >= pos.tpPrice : p <= pos.tpPrice;
        const slHit = pos.side==='BUY' ? p <= pos.slPrice : p >= pos.slPrice;
        if(tpHit) return aiClosePosition('TP', p);
        if(slHit) return aiClosePosition('SL', p);
      }
    }

    // Decision only on new candle close of decision TF
    const candle = await getLastClosedCandle(aiTrader.symbol, aiTrader.decisionTf);
    if(!candle || candle.time === aiTrader.lastDecisionCandle) return;
    aiTrader.lastDecisionCandle = candle.time;

    // Gather context: last 100 candles
    const k = await mexcPublic(`/api/v1/contract/kline/${aiTrader.symbol}?interval=${aiTrader.decisionTf}&limit=100`);
    if(!k || !k.success) return;
    const candleData = k.data.time.map((t,i)=>
      `${new Date(parseInt(t)*1000).toISOString().slice(0,16)} O:${k.data.open[i]} H:${k.data.high[i]} L:${k.data.low[i]} C:${k.data.close[i]} V:${k.data.vol[i]}`
    ).join('\n');

    const posStr = aiTrader.position
      ? `OPEN POSITION: ${aiTrader.position.side} ${aiTrader.position.qty} contracts @ $${aiTrader.position.entryPrice} | ${aiTrader.position.leverage}x | TP $${aiTrader.position.tpPrice} | SL $${aiTrader.position.slPrice}`
      : 'NO OPEN POSITION';

    const histStr = aiTrader.tradeHistory.slice(-10).map(t=>
      `${t.side} entry:$${t.entry} exit:$${t.exit} pnl:${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)} (${t.reason})`
    ).join('\n') || 'No closed trades yet';

    const prompt = `You are an autonomous crypto futures trader managing a small real-money account. Your decisions are executed immediately on MEXC ${aiTrader.symbol} perpetual futures.

ACCOUNT STATE:
- Allocation: $${aiTrader.allocatedUsd}
- Realized P&L: ${aiTrader.realizedPnl>=0?'+':''}$${aiTrader.realizedPnl.toFixed(2)}
- Current equity: $${equity.toFixed(2)}
- ${posStr}

RECENT CLOSED TRADES:
${histStr}

LAST 100 CANDLES (${aiTrader.decisionTf}):
${candleData}

RULES:
- Max leverage: ${aiTrader.maxLeverage}x
- Max risk per trade: ${aiTrader.maxRiskPct}% of equity (SL distance x size must not exceed this)
- You may: open a long, open a short, close the current position, adjust TP/SL, or do nothing
- Be selective — overtrading loses to fees. No trade is a valid choice.
- Think about trend, momentum, support/resistance, and risk/reward before deciding.

Respond ONLY with JSON, no other text:
{"action":"long"|"short"|"close"|"adjust"|"hold","leverage":1-${aiTrader.maxLeverage},"riskPct":0.5-${aiTrader.maxRiskPct},"tpPrice":number,"slPrice":number,"reasoning":"one concise paragraph"}`;

    aiLog(`Requesting decision from Claude (candle close ${candle.close})...`,'info');
    const raw = await callClaude(prompt);
    let decision;
    try{
      decision = JSON.parse(raw.replace(/```json|```/g,'').trim());
    }catch(e){
      aiLog(`Could not parse decision: ${raw.slice(0,150)}`,'err');
      return;
    }

    aiTrader.decisions.push({ t: Date.now(), candle: candle.close, ...decision });
    if(aiTrader.decisions.length > 50) aiTrader.decisions.shift();
    aiLog(`Decision: ${decision.action.toUpperCase()} — ${decision.reasoning}`, 'info');

    // Execute decision
    if(decision.action === 'hold') return;

    if(decision.action === 'close' && aiTrader.position){
      const p = await getTicker(aiTrader.symbol);
      return aiClosePosition('AI decision', p);
    }

    if((decision.action === 'long' || decision.action === 'short')){
      if(aiTrader.position){
        // Close existing first if direction differs
        const wantSide = decision.action==='long' ? 'BUY':'SELL';
        if(aiTrader.position.side !== wantSide){
          const p = await getTicker(aiTrader.symbol);
          await aiClosePosition('Flip', p);
        } else {
          // Same direction — treat as adjust
          aiTrader.position.tpPrice = decision.tpPrice;
          aiTrader.position.slPrice = decision.slPrice;
          aiLog(`Adjusted TP→$${decision.tpPrice} SL→$${decision.slPrice}`,'info');
          return;
        }
      }
      // Size the position: risk = equity * riskPct; qty from SL distance
      const entry = candle.close;
      const lev = Math.min(aiTrader.maxLeverage, Math.max(1, parseInt(decision.leverage)||1));
      const riskUsd = equity * Math.min(aiTrader.maxRiskPct, decision.riskPct||2)/100;
      const slDist = Math.abs(entry - decision.slPrice);
      if(slDist <= 0){ aiLog('Invalid SL distance — skipping','warn'); return; }
      // contracts: MEXC BTC_USDT contract = 0.0001 BTC
      const contractSize = 0.0001;
      let qty = Math.floor(riskUsd / (slDist * contractSize));
      qty = Math.max(1, qty);
      // Cap position notional at equity * leverage
      const maxQty = Math.floor((equity * lev) / (entry * contractSize));
      qty = Math.min(qty, Math.max(1, maxQty));

      const futSide = decision.action==='long' ? 1 : 3;
      if(lev > 1){
        await mexcRequest('POST','/api/v1/private/position/change_leverage',{
          symbol: aiTrader.symbol, leverage: lev, openType: 1
        }).catch(()=>{});
      }
      const r = await placeOrder(aiTrader.symbol, futSide, qty, lev, 1, 0, 5);
      if(r.success){
        aiTrader.position = {
          side: decision.action==='long'?'BUY':'SELL',
          entryPrice: entry, qty, leverage: lev,
          tpPrice: decision.tpPrice, slPrice: decision.slPrice,
          openedAt: Date.now(),
        };
        aiLog(`✅ ${decision.action.toUpperCase()} opened: ${qty} contracts @ $${entry} | ${lev}x | TP $${decision.tpPrice} SL $${decision.slPrice}`,'ok');
        sendTelegram(`🤖🧠 <b>AI ${decision.action.toUpperCase()}</b> ${aiTrader.symbol}\nEntry $${entry} | ${lev}x | ${qty} contracts\nTP $${decision.tpPrice} | SL $${decision.slPrice}\n\n<i>${decision.reasoning}</i>`);
      } else {
        aiLog(`Order failed: ${JSON.stringify(r).slice(0,150)}`,'err');
      }
    }
  }catch(e){
    aiLog(`AI tick error: ${e.message}`,'err');
  }
}

function aiUnrealized(){
  // best-effort: computed at decision time only (live price not always available sync)
  return 0;
}

async function aiClosePosition(reason, price){
  const pos = aiTrader.position;
  if(!pos) return;
  if(price == null) price = await getTicker(aiTrader.symbol) || pos.entryPrice;
  const closeSide = pos.side==='BUY' ? 4 : 2;
  const r = await placeOrder(aiTrader.symbol, closeSide, pos.qty, pos.leverage, 1, 0, 5);
  if(r.success){
    const dir = pos.side==='BUY'?1:-1;
    const contractSize = 0.0001;
    const pnl = (price - pos.entryPrice) * pos.qty * contractSize * dir;
    aiTrader.realizedPnl += pnl;
    aiTrader.tradeHistory.push({ side: pos.side, entry: pos.entryPrice, exit: price, pnl, reason, t: Date.now() });
    if(aiTrader.tradeHistory.length > 50) aiTrader.tradeHistory.shift();
    const emoji = pnl>=0 ? '💰' : '🔻';
    aiLog(`${emoji} ${reason}: closed ${pos.side} @ $${price} | P&L ${pnl>=0?'+':''}$${pnl.toFixed(2)} | Total: ${aiTrader.realizedPnl>=0?'+':''}$${aiTrader.realizedPnl.toFixed(2)}`, pnl>=0?'ok':'err');
    sendTelegram(`${emoji} <b>AI closed ${pos.side}</b> (${reason})\nExit $${price}\nTrade P&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}\nAI total: ${aiTrader.realizedPnl>=0?'+':''}$${aiTrader.realizedPnl.toFixed(2)}`);
    aiTrader.position = null;
  } else {
    aiLog(`Close failed: ${JSON.stringify(r).slice(0,150)}`,'err');
  }
}

setInterval(aiTraderTick, 10000); // AI heartbeat every 10s

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

// ── Shared AI-bot state ──
function newAiBot(name){
  return {
    name, enabled:false, paper:true, allocation:100, startEquity:100,
    decisionTf:'Min60', symbol:'BTC_USDT',
    maxLeverage:10, maxRiskPct:5, killSwitchPct:50,
    position:null, realizedPnl:0, decisions:[], tradeHistory:[],
    lastDecisionCandle:null, aiLines:[], lineSource:'both', aiSupervisor:true,
    params:{ emaFast:21, emaSlow:55, adxMin:23, rsiLow:25, rsiHigh:75, atrSL:2, atrTP:3.5 },
  };
}
let aiBots = { pattern: newAiBot('pattern'), davidd: newAiBot('davidd') };

function aiBotLog(bot, msg, type=''){ blog(`[AI:${bot.name}] ${msg}`, type); }

function aiEquity(bot){ return bot.allocation + bot.realizedPnl; }

async function aiBotOpen(bot, side, entry, lev, tpPrice, slPrice, reasoning){
  const equity = aiEquity(bot);
  const riskUsd = equity * bot.maxRiskPct/100;
  const slDist = Math.abs(entry - slPrice);
  if(slDist<=0) return aiBotLog(bot,'Invalid SL distance — skip','warn');
  let qty = Math.max(1, Math.floor(riskUsd/(slDist*0.0001)));
  const maxQty = Math.floor((equity*lev)/(entry*0.0001));
  qty = Math.min(qty, Math.max(1,maxQty));

  if(!bot.paper){
    if(lev>1) await mexcRequest('POST','/api/v1/private/position/change_leverage',{symbol:bot.symbol,leverage:lev,openType:1}).catch(()=>{});
    const r = await placeOrder(bot.symbol, side==='BUY'?1:3, qty, lev, 1, 0, 5);
    if(!r.success) return aiBotLog(bot,`Order failed: ${JSON.stringify(r).slice(0,120)}`,'err');
  }
  bot.position = { side, entryPrice:entry, qty, leverage:lev, tpPrice, slPrice, openedAt:Date.now() };
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
  const pnl = (price-pos.entryPrice)*pos.qty*0.0001*dir;
  bot.realizedPnl += pnl;
  bot.tradeHistory.push({side:pos.side, entry:pos.entryPrice, exit:price, pnl, reason, t:Date.now()});
  if(bot.tradeHistory.length>50) bot.tradeHistory.shift();
  const emoji = pnl>=0?'💰':'🔻';
  aiBotLog(bot, `${emoji} ${reason}: ${pos.side} closed @ $${price} | ${pnl>=0?'+':''}$${pnl.toFixed(2)} | total ${bot.realizedPnl>=0?'+':''}$${bot.realizedPnl.toFixed(2)}`, pnl>=0?'ok':'err');
  sendTelegram(`${emoji} <b>[${bot.name.toUpperCase()}] closed ${pos.side}</b> (${reason})\nExit $${price} | P&L ${pnl>=0?'+':''}$${pnl.toFixed(2)}\nBot total: ${bot.realizedPnl>=0?'+':''}$${bot.realizedPnl.toFixed(2)} ${bot.paper?'(paper)':''}`);
  bot.position = null;
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
async function davidTick(){
  const bot = aiBots.davidd;
  if(!bot.enabled) return;
  try{
    if(aiBotKillCheck(bot)) return;
    if(await aiBotManageExits(bot)) return;

    const candle = await getLastClosedCandle(bot.symbol, bot.decisionTf);
    if(!candle || candle.time===bot.lastDecisionCandle) return;
    bot.lastDecisionCandle = candle.time;

    const k = await mexcPublic(`/api/v1/contract/kline/${bot.symbol}?interval=${bot.decisionTf}&limit=200`);
    if(!k || !k.success) return;
    const closes=k.data.close.map(Number), highs=k.data.high.map(Number), lows=k.data.low.map(Number);
    const i = closes.length-1;
    const P = bot.params;
    const emaF=calcEma(closes,P.emaFast), emaS=calcEma(closes,P.emaSlow);
    const {adx}=calcAdx(highs,lows,closes,14);
    const rsi=calcRsi(closes,14);
    const atr=calcAtr(highs,lows,closes,14);
    const price=closes[i];

    const regime = adx[i] > P.adxMin;
    const longTrend  = emaF[i]>emaS[i] && emaF[i-1]<=emaS[i-1];
    const shortTrend = emaF[i]<emaS[i] && emaF[i-1]>=emaS[i-1];
    const longOk  = regime && longTrend  && rsi[i]>50 && rsi[i]<P.rsiHigh;
    const shortOk = regime && shortTrend && rsi[i]<50 && rsi[i]>P.rsiLow;

    bot.decisions.push({t:Date.now(), candle:price,
      action: longOk?'long':shortOk?'short':'hold',
      reasoning:`EMA21 ${emaF[i].toFixed(0)} vs EMA55 ${emaS[i].toFixed(0)} | ADX ${adx[i].toFixed(1)} (regime ${regime?'✓':'✗'}) | RSI ${rsi[i].toFixed(1)} | ATR ${atr[i].toFixed(0)}`});
    if(bot.decisions.length>50) bot.decisions.shift();

    if(!longOk && !shortOk) return;
    if(bot.position) return; // one position at a time

    const side = longOk?'BUY':'SELL';
    const slPrice = side==='BUY' ? price-P.atrSL*atr[i] : price+P.atrSL*atr[i];
    const tpPrice = side==='BUY' ? price+P.atrTP*atr[i] : price-P.atrTP*atr[i];

    // Optional Claude supervisor veto
    let reasoning = bot.decisions[bot.decisions.length-1].reasoning;
    if(bot.aiSupervisor && ANTHROPIC_KEY){
      try{
        const verdict = await callClaude(`You supervise a mechanical trend strategy on ${bot.symbol} 1h. Signal: ${side} at $${price}. Context: ${reasoning}. Last 30 closes: ${closes.slice(-30).map(c=>c.toFixed(0)).join(',')}. Reply ONLY JSON: {"approve":true|false,"reason":"one sentence"}`);
        const v = JSON.parse(verdict.replace(/```json|```/g,'').trim());
        if(!v.approve){ aiBotLog(bot,`🧠 Supervisor VETO: ${v.reason}`,'warn'); return; }
        reasoning += ` | Supervisor: ${v.reason}`;
      }catch(e){}
    }
    await aiBotOpen(bot, side, price, 5, tpPrice, slPrice, reasoning);
  }catch(e){ aiBotLog(bot,`tick error: ${e.message}`,'err'); }
}

// ── PATTERN BOT: pivots + lines → Claude judges patterns ──
async function patternTick(){
  const bot = aiBots.pattern;
  if(!bot.enabled || !ANTHROPIC_KEY) return;
  try{
    if(aiBotKillCheck(bot)) return;
    if(await aiBotManageExits(bot)) return;

    const candle = await getLastClosedCandle(bot.symbol, bot.decisionTf);
    if(!candle || candle.time===bot.lastDecisionCandle) return;
    bot.lastDecisionCandle = candle.time;

    const k = await mexcPublic(`/api/v1/contract/kline/${bot.symbol}?interval=${bot.decisionTf}&limit=150`);
    if(!k || !k.success) return;
    const closes=k.data.close.map(Number), highs=k.data.high.map(Number), lows=k.data.low.map(Number), times=k.data.time.map(Number);
    const {pivotHighs, pivotLows} = findPivots(highs, lows, 3);
    const price = closes[closes.length-1];

    // Daily + weekly S/R
    const kd = await mexcPublic(`/api/v1/contract/kline/${bot.symbol}?interval=Day1&limit=8`);
    const dHigh = kd&&kd.success ? Math.max(...kd.data.high.slice(-2,-1).map(Number)) : null;
    const dLow  = kd&&kd.success ? Math.min(...kd.data.low.slice(-2,-1).map(Number)) : null;
    const wHigh = kd&&kd.success ? Math.max(...kd.data.high.slice(0,7).map(Number)) : null;
    const wLow  = kd&&kd.success ? Math.min(...kd.data.low.slice(0,7).map(Number)) : null;

    // user lines from savedChartLines if requested
    let userLines = [];
    if(bot.lineSource!=='ai' && savedChartLines[bot.symbol] && savedChartLines[bot.symbol].lines){
      userLines = savedChartLines[bot.symbol].lines.map(l=>
        l.isHoriz ? `USER horizontal @ $${l.horizPrice.toFixed(0)}`
                  : `USER trendline (${new Date(l.p1.time*1000).toISOString().slice(5,16)} $${l.p1.price.toFixed(0)}) → (${new Date(l.p2.time*1000).toISOString().slice(5,16)} $${l.p2.price.toFixed(0)})`);
    }
    const pivotStr = `Swing highs: ${pivotHighs.slice(-8).map(p=>`[${new Date(times[p.i]*1000).toISOString().slice(5,16)} $${p.price.toFixed(0)}]`).join(' ')}
Swing lows: ${pivotLows.slice(-8).map(p=>`[${new Date(times[p.i]*1000).toISOString().slice(5,16)} $${p.price.toFixed(0)}]`).join(' ')}`;

    const candleStr = times.slice(-60).map((t,j)=>{
      const idx = times.length-60+j;
      return `${new Date(t*1000).toISOString().slice(5,16)} O${k.data.open[idx]} H${highs[idx]} L${lows[idx]} C${closes[idx]}`;
    }).join('\n');

    const prompt = `You are a chart-pattern swing trader on ${bot.symbol} ${bot.decisionTf}. You trade: ascending/descending wedges, bull/bear flags, head & shoulders, inverse H&S, channels, and breaks of daily/weekly support/resistance. Be selective — most candles deserve "hold".

CURRENT PRICE: $${price}
EQUITY: $${aiEquity(bot).toFixed(2)} ${bot.paper?'(PAPER MODE)':''}
POSITION: ${bot.position?`${bot.position.side} @ $${bot.position.entryPrice}`:'none'}

PIVOTS (detected swings):
${pivotStr}

KEY LEVELS: prev daily H $${dHigh?.toFixed(0)} L $${dLow?.toFixed(0)} | weekly H $${wHigh?.toFixed(0)} L $${wLow?.toFixed(0)}

${userLines.length?`TRADER'S OWN LINES (high priority):\n${userLines.join('\n')}`:''}

LAST 60 CANDLES:
${candleStr}

${bot.lineSource==='user'?'Only trade setups that interact with the TRADER\'S OWN LINES.':''}

Respond ONLY JSON:
{"action":"long"|"short"|"close"|"hold","pattern":"name or none","leverage":1-${bot.maxLeverage},"tpPrice":number,"slPrice":number,"reasoning":"2 sentences max","lines":[{"label":"e.g. flag upper","p1":{"time":unix_seconds,"price":n},"p2":{"time":unix_seconds,"price":n}}]}
"lines" = the pattern lines you see (max 4), so the trader can view them on their chart.`;

    const raw = await callClaude(prompt);
    let d;
    try{ d = JSON.parse(raw.replace(/```json|```/g,'').trim()); }
    catch(e){ return aiBotLog(bot,`bad decision JSON: ${raw.slice(0,100)}`,'err'); }

    bot.decisions.push({t:Date.now(), candle:price, action:d.action, pattern:d.pattern, reasoning:d.reasoning});
    if(bot.decisions.length>50) bot.decisions.shift();
    if(d.lines && d.lines.length) bot.aiLines = d.lines.slice(0,4);
    aiBotLog(bot, `${d.action.toUpperCase()} ${d.pattern&&d.pattern!=='none'?'['+d.pattern+'] ':''}— ${d.reasoning}`,'info');

    if(d.action==='close' && bot.position) return aiBotClose(bot,'AI decision');
    if((d.action==='long'||d.action==='short') && !bot.position){
      const lev = Math.min(bot.maxLeverage, Math.max(1, parseInt(d.leverage)||3));
      await aiBotOpen(bot, d.action==='long'?'BUY':'SELL', price, lev, d.tpPrice, d.slPrice, `[${d.pattern}] ${d.reasoning}`);
    }
  }catch(e){ aiBotLog(bot,`tick error: ${e.message}`,'err'); }
}

setInterval(davidTick, 12000);
setInterval(patternTick, 13000);

// ═══ SELF-OPTIMIZATION: Claude + backtester loop (as in Davidd's video) ═══
async function fetchHistory(symbol, interval, targetBars){
  // page backwards with end= to accumulate up to targetBars candles
  let all = {time:[],open:[],high:[],low:[],close:[]};
  let end = Math.floor(Date.now()/1000);
  for(let page=0; page<4 && all.time.length<targetBars; page++){
    const k = await mexcPublic(`/api/v1/contract/kline/${symbol}?interval=${interval}&limit=2000&end=${end}`);
    if(!k || !k.success || !k.data.time.length) break;
    all = {
      time:[...k.data.time.map(Number), ...all.time],
      open:[...k.data.open.map(Number), ...all.open],
      high:[...k.data.high.map(Number), ...all.high],
      low:[...k.data.low.map(Number), ...all.low],
      close:[...k.data.close.map(Number), ...all.close],
    };
    end = k.data.time[0] - 1;
    await new Promise(r=>setTimeout(r,400)); // be nice to the rate limit
  }
  return all;
}

function backtestDavidd(h, P){
  const closes=h.close, highs=h.high, lows=h.low;
  const emaF=calcEma(closes,P.emaFast), emaS=calcEma(closes,P.emaSlow);
  const {adx}=calcAdx(highs,lows,closes,14);
  const rsi=calcRsi(closes,14);
  const atr=calcAtr(highs,lows,closes,14);
  const FEE=0.0006, SLIP=0.0002; // round-trip taker fees + slippage
  let equity=1, peak=1, maxDd=0, wins=0, losses=0, gross=0, grossLoss=0;
  let pos=null;
  const warm = Math.max(P.emaSlow, 30);

  for(let i=warm;i<closes.length;i++){
    if(pos){
      // intrabar SL/TP check (SL first — conservative)
      const slHit = pos.side===1 ? lows[i]<=pos.sl : highs[i]>=pos.sl;
      const tpHit = pos.side===1 ? highs[i]>=pos.tp : lows[i]<=pos.tp;
      let exitPrice=null, win=null;
      if(slHit){ exitPrice=pos.sl; win=false; }
      else if(tpHit){ exitPrice=pos.tp; win=true; }
      else {
        // break-even at +1R
        const r1=Math.abs(pos.entry-pos.origSl);
        if(pos.sl!==pos.entry){
          if(pos.side===1 && highs[i]>=pos.entry+r1) pos.sl=pos.entry;
          if(pos.side===-1 && lows[i]<=pos.entry-r1) pos.sl=pos.entry;
        }
      }
      if(exitPrice!=null){
        const ret = (exitPrice-pos.entry)/pos.entry*pos.side - FEE - SLIP;
        equity *= (1+ret);
        if(ret>0){ wins++; gross+=ret; } else { losses++; grossLoss+=Math.abs(ret); }
        peak=Math.max(peak,equity); maxDd=Math.max(maxDd,(peak-equity)/peak);
        pos=null;
      }
      continue;
    }
    const regime = adx[i]>P.adxMin;
    const longX  = emaF[i]>emaS[i] && emaF[i-1]<=emaS[i-1];
    const shortX = emaF[i]<emaS[i] && emaF[i-1]>=emaS[i-1];
    if(regime && longX && rsi[i]>50 && rsi[i]<P.rsiHigh){
      pos={side:1, entry:closes[i], sl:closes[i]-P.atrSL*atr[i], origSl:closes[i]-P.atrSL*atr[i], tp:closes[i]+P.atrTP*atr[i]};
    } else if(regime && shortX && rsi[i]<50 && rsi[i]>P.rsiLow){
      pos={side:-1, entry:closes[i], sl:closes[i]+P.atrSL*atr[i], origSl:closes[i]+P.atrSL*atr[i], tp:closes[i]-P.atrTP*atr[i]};
    }
  }
  const trades=wins+losses;
  return {
    trades, winRate: trades?+(100*wins/trades).toFixed(1):0,
    netPct:+((equity-1)*100).toFixed(2),
    maxDdPct:+(maxDd*100).toFixed(2),
    profitFactor: grossLoss>0?+(gross/grossLoss).toFixed(2):(gross>0?99:0),
  };
}

let optimizer = { running:false, iter:0, total:0, results:[], best:null, log:[], symbol:'BTC_USDT', tf:'Min60' };

async function runOptimizer(iterations, symbol, tf){
  optimizer = { running:true, iter:0, total:iterations, results:[], best:null, log:[], symbol, tf };
  blog(`🔁 OPTIMIZER started — ${iterations} iterations on ${symbol} [${tf}]`,'ok');
  sendTelegram(`🔁 <b>Self-optimization started</b>\n${iterations} iterations, ${symbol} ${tf}`);
  try{
    const hist = await fetchHistory(symbol, tf, 6000);
    optimizer.log.push(`History: ${hist.time.length} candles (${new Date(hist.time[0]*1000).toISOString().slice(0,10)} → now)`);

    // Seed with current params
    let current = Object.assign({}, aiBots.davidd.params);
    let seedRes = backtestDavidd(hist, current);
    optimizer.results.push({params:current, ...seedRes, note:'current settings'});
    optimizer.best = optimizer.results[0];

    for(let it=1; it<=iterations && optimizer.running; it++){
      optimizer.iter = it;
      const history = optimizer.results.slice(-12).map(r=>
        `${JSON.stringify(r.params)} → trades:${r.trades} win:${r.winRate}% net:${r.netPct}% dd:${r.maxDdPct}% pf:${r.profitFactor}`).join('\n');

      const prompt = `You are optimizing a trend strategy on ${symbol} ${tf} (EMA cross + ADX regime + RSI band + ATR exits, break-even at 1R, fees included). Search for params that maximize profit factor and net% while keeping max drawdown reasonable (<25%) and trades>=30. Param ranges: emaFast 5-50, emaSlow 20-200 (>emaFast), adxMin 15-40, rsiLow 10-45, rsiHigh 55-90, atrSL 1-4, atrTP 1.5-8.

RESULTS SO FAR:
${history}

BEST: ${JSON.stringify(optimizer.best.params)} → net:${optimizer.best.netPct}% pf:${optimizer.best.profitFactor} dd:${optimizer.best.maxDdPct}%

Propose the next parameter set to test. Learn from what worked. Respond ONLY JSON:
{"params":{"emaFast":n,"emaSlow":n,"adxMin":n,"rsiLow":n,"rsiHigh":n,"atrSL":n,"atrTP":n},"hypothesis":"one sentence"}`;

      let proposal;
      try{
        const raw = await callClaude(prompt);
        proposal = JSON.parse(raw.replace(/```json|```/g,'').trim());
      }catch(e){
        optimizer.log.push(`iter ${it}: Claude error — ${e.message}`);
        continue;
      }
      const P = proposal.params;
      // sanitize
      P.emaFast=Math.max(5,Math.min(50,Math.round(P.emaFast||21)));
      P.emaSlow=Math.max(P.emaFast+5,Math.min(200,Math.round(P.emaSlow||55)));
      P.adxMin=Math.max(15,Math.min(40,+P.adxMin||23));
      P.rsiLow=Math.max(10,Math.min(45,+P.rsiLow||25));
      P.rsiHigh=Math.max(55,Math.min(90,+P.rsiHigh||75));
      P.atrSL=Math.max(1,Math.min(4,+P.atrSL||2));
      P.atrTP=Math.max(1.5,Math.min(8,+P.atrTP||3.5));

      const resu = backtestDavidd(hist, P);
      const entry = {params:P, ...resu, note:proposal.hypothesis};
      optimizer.results.push(entry);
      // best = highest score: pf weighted with net, penalize dd, require trades
      const score = r => (r.trades<30||r.profitFactor<=0) ? -999 : r.profitFactor*2 + r.netPct/50 - r.maxDdPct/25;
      if(score(entry) > score(optimizer.best)) optimizer.best = entry;
      optimizer.log.push(`iter ${it}: net ${resu.netPct}% pf ${resu.profitFactor} dd ${resu.maxDdPct}% (${resu.trades}t) — ${proposal.hypothesis}`);
    }
    blog(`🔁 OPTIMIZER done — best: ${JSON.stringify(optimizer.best.params)} → net ${optimizer.best.netPct}% pf ${optimizer.best.profitFactor}`,'ok');
    sendTelegram(`✅ <b>Optimization complete</b>\nBest: net ${optimizer.best.netPct}% | PF ${optimizer.best.profitFactor} | DD ${optimizer.best.maxDdPct}%\n<code>${JSON.stringify(optimizer.best.params)}</code>\nOpen the AI page to apply.`);
  }catch(e){
    blog(`Optimizer error: ${e.message}`,'err');
    optimizer.log.push('FATAL: '+e.message);
  }
  optimizer.running=false;
}

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
    blog(`Bot #${bot.id} full config: ${JSON.stringify(config)}`, 'info');
    sendTelegram(`🤖 <b>Bot #${bot.id} ARMED</b>\n${config.symbol} — candle close ${config.dir} ${srcLabel} [${config.trigTf}]\nTotal bots: ${bots.length}`);
    return json(res,200,{armed:true, id: bot.id, totalBots: bots.length});
  }

  if(url==='/bot/disarm' && req.method==='POST'){
    const b = await readBody(req);
    if(b.id != null){
      const bot = bots.find(x => x.id === parseInt(b.id));
      if(!bot) return json(res,404,{error:'bot not found'});
      bots = bots.filter(x => x.id !== bot.id);
      blog(`Bot #${bot.id} DISARMED${bot.activeTrade?' (its open trade is no longer managed!)':''} — ${bots.length} bot(s) remaining`,'warn');
      sendTelegram(`🛑 <b>Bot #${bot.id} disarmed</b> — ${bots.length} remaining`);
      return json(res,200,{armed: bots.length>0, removed: bot.id, totalBots: bots.length});
    }
    // No id = disarm all
    const n = bots.length;
    bots = [];
    blog(`All ${n} bot(s) DISARMED`,'warn');
    sendTelegram('🛑 <b>All bots disarmed</b>');
    return json(res,200,{armed:false, totalBots: 0});
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
    return json(res,200,{adopted:true, botId: bot.id});
  }

  // ── CHART LINE SYNC across devices ──
  if(url==='/lines/save' && req.method==='POST'){
    const b = await readBody(req);
    if(b.symbol) savedChartLines[b.symbol] = b.data || {lines:[]};
    return json(res,200,{saved:true});
  }
  if(url.startsWith('/lines/load')){
    const symbol = new URL('http://x'+url).searchParams.get('symbol') || 'BTC_USDT';
    return json(res,200, savedChartLines[symbol] || null);
  }

  // ── AI BOTS v2 endpoints ──
  if(url.match(/^\/ai2\/(pattern|davidd)\/start$/) && req.method==='POST'){
    const name = url.split('/')[2];
    const bot = aiBots[name];
    const b = await readBody(req);
    if(name==='pattern' && !ANTHROPIC_KEY) return json(res,400,{error:'Pattern bot needs ANTHROPIC_API_KEY in Railway'});
    bot.enabled = true;
    bot.paper = b.paper !== false; // default paper
    bot.allocation = parseFloat(b.allocation)||100;
    bot.startEquity = aiEquity(bot);
    bot.decisionTf = b.decisionTf || 'Min60';
    bot.symbol = b.symbol || 'BTC_USDT';
    if(b.lineSource) bot.lineSource = b.lineSource;
    if(b.aiSupervisor != null) bot.aiSupervisor = !!b.aiSupervisor;
    bot.lastDecisionCandle = null;
    blog(`🧠 AI [${name}] STARTED — $${bot.allocation} ${bot.paper?'PAPER':'LIVE'} [${bot.decisionTf}]${name==='pattern'?' lines:'+bot.lineSource:''}${name==='davidd'?' supervisor:'+(bot.aiSupervisor?'on':'off'):''}`,'ok');
    sendTelegram(`🧠 <b>AI ${name} bot started</b>\n$${bot.allocation} ${bot.paper?'📝 paper':'💸 LIVE'} | ${bot.decisionTf}`);
    return json(res,200,{started:true});
  }
  if(url.match(/^\/ai2\/(pattern|davidd)\/stop$/) && req.method==='POST'){
    const bot = aiBots[url.split('/')[2]];
    bot.enabled = false;
    blog(`🧠 AI [${bot.name}] stopped`,'warn');
    return json(res,200,{stopped:true});
  }
  if(url.match(/^\/ai2\/(pattern|davidd)\/status$/)){
    const bot = aiBots[url.split('/')[2]];
    return json(res,200,{
      enabled: bot.enabled, paper: bot.paper, hasApiKey: !!ANTHROPIC_KEY,
      allocation: bot.allocation, realizedPnl: bot.realizedPnl,
      position: bot.position, decisions: bot.decisions.slice(-12),
      tradeHistory: bot.tradeHistory.slice(-10), decisionTf: bot.decisionTf,
      lineSource: bot.lineSource, aiSupervisor: bot.aiSupervisor,
      aiLines: bot.aiLines,
    });
  }

  // ── OPTIMIZER endpoints ──
  if(url==='/ai2/optimize/start' && req.method==='POST'){
    if(!ANTHROPIC_KEY) return json(res,400,{error:'Needs ANTHROPIC_API_KEY'});
    if(optimizer.running) return json(res,409,{error:'Already running'});
    const b = await readBody(req);
    const iters = Math.min(30, Math.max(3, parseInt(b.iterations)||15));
    runOptimizer(iters, b.symbol||'BTC_USDT', b.tf||'Min60'); // fire & forget
    return json(res,200,{started:true, iterations:iters});
  }
  if(url==='/ai2/optimize/stop' && req.method==='POST'){
    optimizer.running=false;
    return json(res,200,{stopped:true});
  }
  if(url==='/ai2/optimize/status'){
    const top = optimizer.results.slice().sort((a,b)=>(b.profitFactor*2+b.netPct/50-b.maxDdPct/25)-(a.profitFactor*2+a.netPct/50-a.maxDdPct/25)).slice(0,3);
    return json(res,200,{
      running: optimizer.running, iter: optimizer.iter, total: optimizer.total,
      best: optimizer.best, top3: top, log: optimizer.log.slice(-15),
      currentParams: aiBots.davidd.params,
    });
  }
  if(url==='/ai2/optimize/apply' && req.method==='POST'){
    if(!optimizer.best) return json(res,400,{error:'no results yet'});
    aiBots.davidd.params = Object.assign({}, optimizer.best.params);
    blog(`✅ Applied optimized params to davidd bot: ${JSON.stringify(aiBots.davidd.params)}`,'ok');
    sendTelegram(`✅ <b>Optimized params applied</b>\n<code>${JSON.stringify(aiBots.davidd.params)}</code>`);
    return json(res,200,{applied:true, params: aiBots.davidd.params});
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
        manualOnly: !!b.config.manualOnly,
        leverage: b.config.leverage,
        qty: b.config.qty,
        activeTrade: b.activeTrade,
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

  // ── AI TRADER ──
  if(url==='/ai/start' && req.method==='POST'){
    if(!ANTHROPIC_KEY) return json(res,400,{error:'Set ANTHROPIC_API_KEY env var in Railway first'});
    const b = await readBody(req);
    aiTrader.enabled = true;
    aiTrader.symbol = b.symbol || 'BTC_USDT';
    aiTrader.allocatedUsd = parseFloat(b.allocation) || 100;
    aiTrader.startBalance = aiTrader.allocatedUsd + aiTrader.realizedPnl;
    aiTrader.decisionTf = b.decisionTf || 'Min60';
    aiTrader.lastDecisionCandle = null;
    blog(`🧠 AI TRADER STARTED — $${aiTrader.allocatedUsd} allocation, decisions every ${aiTrader.decisionTf} candle`,'ok');
    sendTelegram(`🧠 <b>AI Trader started</b>\nAllocation: $${aiTrader.allocatedUsd}\nDecision cadence: ${aiTrader.decisionTf}\nMax leverage: ${aiTrader.maxLeverage}x | Kill switch: -${aiTrader.killSwitchPct}%`);
    return json(res,200,{started:true});
  }

  if(url==='/ai/stop' && req.method==='POST'){
    aiTrader.enabled = false;
    blog('🧠 AI Trader stopped','warn');
    sendTelegram('🛑 <b>AI Trader stopped</b>');
    return json(res,200,{stopped:true});
  }

  if(url==='/ai/status'){
    return json(res,200,{
      enabled: aiTrader.enabled,
      hasApiKey: !!ANTHROPIC_KEY,
      symbol: aiTrader.symbol,
      allocation: aiTrader.allocatedUsd,
      realizedPnl: aiTrader.realizedPnl,
      position: aiTrader.position,
      decisions: aiTrader.decisions.slice(-10),
      tradeHistory: aiTrader.tradeHistory.slice(-10),
      decisionTf: aiTrader.decisionTf,
    });
  }

  json(res,404,{error:'not found'});

}).listen(PORT, ()=> {
  blog(`🔄 SERVER STARTED (all bots cleared by restart)`, 'warn');
  console.log(`MEXC Trend Trader server on :${PORT}`);
  console.log(APP_PASSWORD ? '🔒 Password auth enabled' : '⚠️  Set APP_PASSWORD env var!');
  console.log(MEXC_KEY ? '🔑 MEXC keys loaded' : '⚠️  Set MEXC_API_KEY / MEXC_API_SECRET env vars!');
  console.log(TG_TOKEN && TG_CHAT ? '📨 Telegram alerts enabled' : 'ℹ️  Telegram off — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to enable');
  console.log(ANTHROPIC_KEY ? '🧠 AI Trader available' : 'ℹ️  AI Trader off — set ANTHROPIC_API_KEY to enable');
});
