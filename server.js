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
  const slPrice = cfg.sl.type==='price' ? parseFloat(cfg.sl.value)
    : (side==='BUY' ? entry*(1-cfg.sl.value/100) : entry*(1+cfg.sl.value/100));

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
