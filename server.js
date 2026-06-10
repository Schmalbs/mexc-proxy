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

// Public (unsigned) GET to MEXC
function mexcPublic(path){
  return new Promise((resolve, reject)=>{
    https.get(FUTURES_BASE + path, res=>{
      let data=''; res.on('data',d=>data+=d);
      res.on('end',()=>{ try{ resolve(JSON.parse(data)); }catch(e){ resolve(null); } });
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────
// BOT ENGINE — runs 24/7 server-side
// ─────────────────────────────────────────────────────────────
let botConfig   = null;   // armed config from client
let activeTrade = null;   // server-managed open trade
let botLogs     = [];     // recent log lines for client display
let lastCandleTime = null, lastTpCandle = null, lastSlCandle = null;

function blog(msg, type=''){
  const line = { t: new Date().toISOString(), msg, type };
  botLogs.push(line);
  if(botLogs.length > 100) botLogs.shift();
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

async function placeOrder(symbol, side, vol, leverage, openType, price, type){
  // side: 1=open long, 3=open short, 4=close long, 2=close short
  // type: 5=market, 1=limit
  return mexcRequest('POST', '/api/v1/private/order/submit', {
    symbol, price: price||0, vol, side, type: type||5, openType: openType||1, leverage: leverage||1
  });
}

let syncCounter = 0;

async function botTick(){
  if(!botConfig) return;
  try{
    const cfg = botConfig;
    syncCounter++;

    // ── POSITION SYNC CHECK every ~32s ──
    // Verify the position still exists on MEXC (user may have closed it manually)
    if(activeTrade && syncCounter % 4 === 0){
      const d = await mexcRequest('GET','/api/v1/private/position/open_positions');
      if(d.success){
        const stillOpen = (d.data||[]).some(p =>
          p.symbol === cfg.symbol && parseFloat(p.holdVol) > 0 &&
          ((activeTrade.side==='BUY'  && p.positionType===1) ||
           (activeTrade.side==='SELL' && p.positionType===2)));
        if(!stillOpen){
          blog('⚠️ Position closed externally on MEXC — clearing bot tracking','warn');
          sendTelegram('⚠️ <b>Position closed externally</b> on MEXC — bot tracking cleared. Bot remains armed for next trigger.');
          activeTrade = null;
          return;
        }
      }
    }

    // ── Manage open trade exits ──
    if(activeTrade){
      const t = activeTrade;
      // Price-hit exits
      const price = await getTicker(cfg.symbol);
      if(price != null){
        if(t.tp.type==='price' || t.tp.mode==='price'){
          const hit = t.side==='BUY' ? price >= t.tpPrice : price <= t.tpPrice;
          if(hit) return exitTrade('TP', price);
        }
        if(t.sl.mode==='price'){
          const hit = t.side==='BUY' ? price <= t.slPrice : price >= t.slPrice;
          if(hit) return exitTrade('SL', price);
        }
      }
      // Candle-close exits
      if(t.tp.mode==='candle'){
        const c = await getLastClosedCandle(cfg.symbol, t.tp.tf);
        if(c && c.time !== lastTpCandle){
          lastTpCandle = c.time;
          const hit = t.side==='BUY' ? c.close >= t.tpPrice : c.close <= t.tpPrice;
          if(hit) return exitTrade('TP (candle)', c.close);
        }
      }
      if(t.sl.mode==='candle'){
        const c = await getLastClosedCandle(cfg.symbol, t.sl.tf);
        if(c && c.time !== lastSlCandle){
          lastSlCandle = c.time;
          const hit = t.side==='BUY' ? c.close <= t.slPrice : c.close >= t.slPrice;
          if(hit) return exitTrade('SL (candle)', c.close);
        }
      }
      return; // trade open — don't look for new entries
    }

    // ── Look for entry trigger ──
    const candle = await getLastClosedCandle(cfg.symbol, cfg.trigTf);
    if(!candle || candle.time === lastCandleTime) return;
    lastCandleTime = candle.time;

    const dir  = cfg.dir; // 'above' or 'below'
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
    blog(`🔔 Trigger! Candle closed ${dir} ${triggerLabel} @ ${candle.close}`, 'ok');
    sendTelegram(`🔔 <b>Entry trigger fired!</b>\n${cfg.symbol} candle closed ${dir} ${triggerLabel}\nClose: $${candle.close}`);

    // Calculate TP/SL prices
    const entry = candle.close;
    const tpPrice = cfg.tp.type==='price' ? parseFloat(cfg.tp.value)
      : (side==='BUY' ? entry*(1+cfg.tp.value/100) : entry*(1-cfg.tp.value/100));
    const slPrice = cfg.sl.type==='price' ? parseFloat(cfg.sl.value)
      : (side==='BUY' ? entry*(1-cfg.sl.value/100) : entry*(1+cfg.sl.value/100));

    // Set leverage then place order
    if(cfg.leverage > 1){
      await mexcRequest('POST','/api/v1/private/position/change_leverage',{
        symbol: cfg.symbol, leverage: cfg.leverage, openType: cfg.marginType==='isolated'?1:2
      }).catch(()=>{});
    }
    const futSide = side==='BUY' ? 1 : 3;
    const res = await placeOrder(cfg.symbol, futSide, cfg.qty, cfg.leverage, cfg.marginType==='isolated'?1:2, 0, 5);
    if(res.success){
      blog(`✅ Order placed! ID: ${res.data}`, 'ok');
      sendTelegram(`✅ <b>${side} order placed</b>\n${cfg.symbol} @ $${entry}\nQty: ${cfg.qty} | ${cfg.leverage}×\nTP: $${tpPrice.toFixed(4)} | SL: $${slPrice.toFixed(4)}`);
      activeTrade = {
        side, entryPrice: entry, tpPrice, slPrice, qty: cfg.qty,
        leverage: cfg.leverage,
        tp: { mode: cfg.tp.mode, tf: cfg.tp.tf },
        sl: { mode: cfg.sl.mode, tf: cfg.sl.tf },
        openedAt: Date.now(),
      };
      lastTpCandle = null; lastSlCandle = null;
    } else {
      blog(`Order error: ${JSON.stringify(res)}`, 'err');
      sendTelegram(`❌ <b>Order failed</b>\n${JSON.stringify(res).slice(0,200)}`);
    }
  }catch(e){
    blog(`Bot tick error: ${e.message}`, 'err');
  }
}

async function exitTrade(reason, price){
  if(!activeTrade) return;
  const t = activeTrade;
  const dir = t.side==='BUY'?1:-1;
  const pct = ((price - t.entryPrice)/t.entryPrice*100*dir*(t.leverage||1)).toFixed(2);
  blog(`🏁 ${reason} hit @ ${price} | P&L: ${pct>=0?'+':''}${pct}%`, pct>=0?'ok':'err');
  const emoji = pct>=0 ? '💰' : '🔻';
  sendTelegram(`${emoji} <b>${reason} — trade closed</b>\nExit: $${price}\nP&L: ${pct>=0?'+':''}${pct}%`);
  const closeSide = t.side==='BUY' ? 4 : 2; // close long / close short
  const res = await placeOrder(botConfig.symbol, closeSide, t.qty, t.leverage, 1, 0, 5);
  if(res.success) blog(`✅ Exit order placed. ID: ${res.data}`, 'ok');
  else blog(`Exit order error: ${JSON.stringify(res)}`, 'err');
  activeTrade = null;
}

setInterval(botTick, 8000); // bot heartbeat every 8s

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
  if(url.startsWith('/https://') || url.startsWith('/http://')){
    const target = url.slice(1);
    try{
      const tu = new URL(target);
      https.get({ hostname: tu.hostname, path: tu.pathname + tu.search }, pres=>{
        let data=''; pres.on('data',d=>data+=d);
        pres.on('end',()=>{
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
    botConfig = await readBody(req);
    lastCandleTime = null;
    blog(`Bot ARMED — ${botConfig.symbol} | trigger: candle close ${botConfig.dir} [${botConfig.trigTf}] | source: ${botConfig.triggerSource}`, 'ok');
    sendTelegram(`🤖 <b>Bot ARMED</b>\n${botConfig.symbol} — waiting for candle close ${botConfig.dir} [${botConfig.trigTf}]`);
    return json(res,200,{armed:true});
  }

  if(url==='/bot/disarm' && req.method==='POST'){
    botConfig = null;
    blog('Bot DISARMED','warn');
    sendTelegram('🛑 <b>Bot DISARMED</b>');
    return json(res,200,{armed:false});
  }

  if(url==='/bot/status'){
    return json(res,200,{
      armed: !!botConfig,
      config: botConfig,
      activeTrade,
      logs: botLogs.slice(-20),
    });
  }

  // ── MANUAL TRADES (server-managed) ──
  if(url==='/trade/open' && req.method==='POST'){
    const b = await readBody(req);
    if(b.leverage > 1){
      await mexcRequest('POST','/api/v1/private/position/change_leverage',{
        symbol: b.symbol, leverage: b.leverage, openType: b.marginType==='isolated'?1:2
      }).catch(()=>{});
    }
    const futSide = b.side==='BUY' ? 1 : 3;
    const r = await placeOrder(b.symbol, futSide, b.qty, b.leverage, b.marginType==='isolated'?1:2, b.limitPrice||0, b.orderType==='LIMIT'?1:5);
    if(r.success){
      activeTrade = {
        side: b.side, entryPrice: b.entryPrice, tpPrice: b.tpPrice, slPrice: b.slPrice,
        qty: b.qty, leverage: b.leverage,
        tp: { mode: b.tpMode, tf: b.tpTf }, sl: { mode: b.slMode, tf: b.slTf },
        openedAt: Date.now(),
      };
      if(!botConfig) botConfig = { symbol: b.symbol, trigTf:'15m', dir:'above', triggerSource:'price', manualPrice:0, lines:[], selectedLineId:'all', qty:b.qty, leverage:b.leverage, marginType:b.marginType, tp:{mode:b.tpMode,type:'pct',value:0,tf:b.tpTf}, sl:{mode:b.slMode,type:'pct',value:0,tf:b.slTf} };
      blog(`Manual ${b.side} opened @ ${b.entryPrice}`, 'ok');
      return json(res,200,{success:true, orderId:r.data});
    }
    return json(res,500,r);
  }

  if(url==='/trade/close' && req.method==='POST'){
    if(!activeTrade) return json(res,400,{error:'no active trade'});
    const b = await readBody(req);
    const fraction = Math.min(1, Math.max(0, parseFloat(b.fraction)||1));
    const symbol = botConfig ? botConfig.symbol : (b.symbol||'BTC_USDT');
    const price = await getTicker(symbol);

    if(fraction >= 0.999){
      await exitTrade('MANUAL', price || activeTrade.entryPrice);
      return json(res,200,{closed:true, fraction:1});
    }

    // Partial close
    const closeVol = Math.max(1, Math.floor(activeTrade.qty * fraction));
    const closeSide = activeTrade.side==='BUY' ? 4 : 2;
    const r = await placeOrder(symbol, closeSide, closeVol, activeTrade.leverage, 1, 0, 5);
    if(r.success){
      activeTrade.qty -= closeVol;
      blog(`Partial close ${Math.round(fraction*100)}% (${closeVol} contracts) @ ${price}`, 'ok');
      if(activeTrade.qty <= 0) activeTrade = null;
      return json(res,200,{closed:true, fraction, remaining: activeTrade ? activeTrade.qty : 0});
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
  console.log(`MEXC Trend Trader server on :${PORT}`);
  console.log(APP_PASSWORD ? '🔒 Password auth enabled' : '⚠️  Set APP_PASSWORD env var!');
  console.log(MEXC_KEY ? '🔑 MEXC keys loaded' : '⚠️  Set MEXC_API_KEY / MEXC_API_SECRET env vars!');
  console.log(TG_TOKEN && TG_CHAT ? '📨 Telegram alerts enabled' : 'ℹ️  Telegram off — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to enable');
});
