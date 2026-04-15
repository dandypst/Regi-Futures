// agent.js — AI brain / ReAct reasoning engine
// Calls OpenRouter → returns trading decisions
// Falls back to rule-based logic if no API key

import axios from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';
import { getLessonsContext } from './lessons.js';
import { getMemoryContext, rankPairs } from './pool-memory.js';
import { getState } from './state.js';
import {
  getKlines, getTicker,
  getFundingRate, getOpenInterest,
} from './binance.js';

const MOD = 'AGENT';

// ── Technical indicators ──────────────────────────────────────────────────────

function calcEMA(data, period) {
  if (!data || data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const rs = gains / (losses || 0.0001);
  return 100 - 100 / (1 + rs);
}

function calcBB(closes, period = 20) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((s, v) => s + v, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period);
  return {
    upper:     mean + 2 * std,
    middle:    mean,
    lower:     mean - 2 * std,
    bandwidth: mean > 0 ? (4 * std) / mean : 0,
  };
}

function detectRegime(klines) {
  if (!klines || klines.length < 50) return 'UNKNOWN';
  const closes = klines.map(k => k.close);
  const ema20  = calcEMA(closes.slice(-20), 20);
  const ema50  = calcEMA(closes.slice(-50), 50);
  if (!ema20 || !ema50) return 'UNKNOWN';
  const cur = closes[closes.length - 1];
  if (cur > ema20 && ema20 > ema50) return 'UPTREND';
  if (cur < ema20 && ema20 < ema50) return 'DOWNTREND';
  return 'RANGING';
}

// ── Market data ───────────────────────────────────────────────────────────────

async function gatherMarketData(symbol) {
  const [klines4h, klines1h, ticker, funding, oi] = await Promise.all([
    getKlines(symbol, '4h', 100).catch(() => []),
    getKlines(symbol, '1h', 100).catch(() => []),
    getTicker(symbol).catch(() => null),
    getFundingRate(symbol).catch(() => null),
    getOpenInterest(symbol).catch(() => null),
  ]);

  const c1h = klines1h.map(k => k.close);
  const c4h = klines4h.map(k => k.close);
  const bb  = calcBB(c1h);

  return {
    symbol,
    price:        ticker ? parseFloat(ticker.lastPrice) : null,
    change24h:    ticker ? parseFloat(ticker.priceChangePercent) : null,
    volume24h:    ticker ? parseFloat(ticker.quoteVolume) : null,
    regime4h:     detectRegime(klines4h),
    regime1h:     detectRegime(klines1h),
    rsi4h:        calcRSI(c4h).toFixed(1),
    rsi1h:        calcRSI(c1h).toFixed(1),
    bb_bandwidth: bb ? bb.bandwidth.toFixed(4) : null,
    ema20_1h:     calcEMA(c1h.slice(-20), 20)?.toFixed(2) ?? null,
    ema50_1h:     calcEMA(c1h.slice(-50), 50)?.toFixed(2) ?? null,
    fundingRate:  funding ? (parseFloat(funding.lastFundingRate) * 100).toFixed(4) : null,
    openInterest: oi ? parseFloat(oi.openInterest).toFixed(0) : null,
  };
}

// ── Screening agent ───────────────────────────────────────────────────────────

export async function runScreeningAgent(pairs) {
  logger.ai(MOD, `Screening ${pairs.length} pairs...`);

  const ranked   = rankPairs(pairs);
  // FIX: jika semua pairs di-cooldown, ranked bisa kosong — fallback ke pairs asli
  const topPairs = ranked.length > 0
    ? ranked.slice(0, 6).map(r => r.symbol)
    : pairs.slice(0, 6);

  const marketDataAll = await Promise.all(
    topPairs.map(s => gatherMarketData(s).catch(e => {
      logger.warn(MOD, `Data gagal untuk ${s}: ${e.message}`);
      return { symbol: s, error: e.message };
    }))
  );

  const valid = marketDataAll.filter(d => !d.error && d.price);
  if (!valid.length) {
    logger.warn(MOD, 'Tidak ada data pasar valid — skip screening');
    return { action: 'WAIT', reasoning: 'No valid market data', confidence: 0 };
  }

  const state      = getState();
  const lessonsCtx = getLessonsContext();

  const marketSummary = valid.map(d =>
    `${d.symbol}: price=${d.price} chg=${d.change24h}% vol=${d.volume24h?.toFixed(0)} ` +
    `regime4h=${d.regime4h} regime1h=${d.regime1h} rsi4h=${d.rsi4h} rsi1h=${d.rsi1h} ` +
    `bb_bw=${d.bb_bandwidth} ema20=${d.ema20_1h} ema50=${d.ema50_1h} ` +
    `funding=${d.fundingRate}% oi=${d.openInterest}\n` +
    `  Memory: ${getMemoryContext(d.symbol)}`
  ).join('\n\n');

  if (!config.openRouterApiKey || config.openRouterApiKey.startsWith('GANTI_')) {
    logger.warn(MOD, 'OpenRouter key tidak ada — pakai rule-based screening');
    return ruleBasedScreening(valid, state);
  }

  return callAI(buildScreeningPrompt(marketSummary, state, lessonsCtx), 'screening');
}

// ── Management agent ──────────────────────────────────────────────────────────

export async function runManagementAgent(positions) {
  if (!positions?.length) return { decisions: [] };

  logger.ai(MOD, `Managing ${positions.length} positions...`);

  const positionData = await Promise.all(
    positions.map(async p => ({
      ...p,
      market: await gatherMarketData(p.symbol).catch(() => ({})),
    }))
  );

  const lessonsCtx = getLessonsContext();

  const posSummary = positionData.map(p => {
    const qty   = Math.abs(parseFloat(p.positionAmt));
    const side  = parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const entry = parseFloat(p.entryPrice);
    const pnl   = parseFloat(p.unRealizedProfit);
    const pnlPct = (qty > 0 && entry > 0) ? ((pnl / (qty * entry)) * 100).toFixed(2) : '0.00';
    return (
      `${p.symbol} ${side} qty=${qty} entry=${entry} mark=${p.markPrice} ` +
      `pnl=${pnl.toFixed(2)}USDT (${pnlPct}%) liq=${p.liquidationPrice}\n` +
      `  Market: regime4h=${p.market.regime4h} rsi1h=${p.market.rsi1h} funding=${p.market.fundingRate}%\n` +
      `  Memory: ${getMemoryContext(p.symbol)}`
    );
  }).join('\n\n');

  if (!config.openRouterApiKey || config.openRouterApiKey.startsWith('GANTI_')) {
    return ruleBasedManagement(positionData);
  }

  return callAI(buildManagementPrompt(posSummary, lessonsCtx), 'management');
}

// ── Prompts ───────────────────────────────────────────────────────────────────

function buildScreeningPrompt(marketSummary, state, lessonsCtx) {
  return `You are Hunter Alpha, an autonomous Binance Futures trading agent.

Settings: positions=${state.openPositions.length}/${config.maxPositions}, leverage=${config.leverage}x, risk=${(config.riskPerTrade*100).toFixed(1)}%, TP=${(config.takeProfitPct*100).toFixed(1)}%, SL=${(config.stopLossPct*100).toFixed(1)}%
${lessonsCtx}

MARKET DATA:
${marketSummary}

Rules: Trade WITH 4h trend. Avoid funding >0.05%. Only OPEN if confidence >60%.

Respond ONLY with raw JSON (no markdown fences):
{"action":"OPEN","pair":"BTCUSDT","side":"LONG","confidence":75,"reasoning":"reason max 200 chars","suggestedEntry":65000.00,"keyRisk":"risk"}
OR: {"action":"WAIT","reasoning":"reason","confidence":0}`;
}

function buildManagementPrompt(posSummary, lessonsCtx) {
  return `You are Healer Alpha, managing open Binance Futures positions.

Settings: TP=${(config.takeProfitPct*100).toFixed(1)}%, SL=${(config.stopLossPct*100).toFixed(1)}%
${lessonsCtx}

POSITIONS:
${posSummary}

Respond ONLY with raw JSON (no markdown fences):
{"decisions":[{"symbol":"BTCUSDT","action":"HOLD","reason":"reason max 150 chars","newSL":null,"newTP":null}]}`;
}

// ── AI caller ─────────────────────────────────────────────────────────────────

async function callAI(prompt, type) {
  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model:      config.openRouterModel || 'anthropic/claude-3-haiku',
        max_tokens: 600,
        messages:   [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'Authorization': `Bearer ${config.openRouterApiKey}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://github.com/rrl-futures',
          'X-Title':       'RRL-Futures',
        },
        timeout: 30000,
      }
    );

    const raw   = res.data.choices[0].message.content.trim();
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const result = JSON.parse(clean);
    logger.ai(MOD, `${type}: ${result.action || result.decisions?.length + ' decisions'}`);
    return result;
  } catch (e) {
    logger.error(MOD, `AI call gagal (${type}): ${e.message}`);
    return type === 'screening'
      ? { action: 'WAIT', reasoning: 'AI unavailable', confidence: 0 }
      : { decisions: [] };
  }
}

// ── Rule-based fallbacks ──────────────────────────────────────────────────────

function ruleBasedScreening(marketData, state) {
  if (state.openPositions.length >= (config.maxPositions || 3)) {
    return { action: 'WAIT', reasoning: 'Max posisi tercapai', confidence: 0 };
  }
  for (const d of marketData) {
    if (!d.rsi1h || d.regime4h === 'UNKNOWN') continue;
    const rsi = parseFloat(d.rsi1h);
    if (d.regime4h === 'UPTREND'   && rsi < 40 && rsi > 25)
      return { action: 'OPEN', pair: d.symbol, side: 'LONG',  confidence: 65, reasoning: `RSI ${rsi} oversold in uptrend`,   suggestedEntry: d.price, keyRisk: 'Trend reversal' };
    if (d.regime4h === 'DOWNTREND' && rsi > 60 && rsi < 78)
      return { action: 'OPEN', pair: d.symbol, side: 'SHORT', confidence: 65, reasoning: `RSI ${rsi} overbought in downtrend`, suggestedEntry: d.price, keyRisk: 'Short squeeze'   };
  }
  return { action: 'WAIT', reasoning: 'Tidak ada setup berkualitas', confidence: 0 };
}

function ruleBasedManagement(positions) {
  return {
    decisions: positions.map(p => {
      const qty    = Math.abs(parseFloat(p.positionAmt));
      const entry  = parseFloat(p.entryPrice);
      const pnl    = parseFloat(p.unRealizedProfit);
      const pnlPct = (qty > 0 && entry > 0) ? pnl / (qty * entry) : 0;
      if (pnlPct >=  (config.takeProfitPct || 0.03))
        return { symbol: p.symbol, action: 'CLOSE', reason: `TP: ${(pnlPct*100).toFixed(2)}%`, newSL: null, newTP: null };
      if (pnlPct <= -(config.stopLossPct   || 0.015))
        return { symbol: p.symbol, action: 'CLOSE', reason: `SL: ${(pnlPct*100).toFixed(2)}%`, newSL: null, newTP: null };
      return { symbol: p.symbol, action: 'HOLD', reason: `PnL ${(pnlPct*100).toFixed(2)}% dalam range`, newSL: null, newTP: null };
    }),
  };
}

// ── Free-form chat ────────────────────────────────────────────────────────────

let chatHistory = [];

export async function chat(userMessage) {
  if (!config.openRouterApiKey || config.openRouterApiKey.startsWith('GANTI_')) {
    return 'OpenRouter API key belum diset di .env';
  }

  const state   = getState();
  const sysMsg  = {
    role: 'system',
    content: `You are a helpful assistant for RRL-Futures AI trading bot.
State: mode=${state.mode}, running=${state.running}, positions=${state.openPositions.length}, balance=${JSON.stringify(state.balance)}
${getLessonsContext()}
Be concise. Reply in the same language as the user.`,
  };

  const messages = [sysMsg, ...chatHistory, { role: 'user', content: userMessage }];

  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      { model: config.openRouterModel || 'anthropic/claude-3-haiku', max_tokens: 500, messages },
      {
        headers: {
          'Authorization': `Bearer ${config.openRouterApiKey}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://github.com/rrl-futures',
          'X-Title':       'RRL-Futures',
        },
        timeout: 20000,
      }
    );

    const reply = res.data.choices[0].message.content;
    chatHistory.push({ role: 'user', content: userMessage }, { role: 'assistant', content: reply });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
    return reply;
  } catch (e) {
    logger.error(MOD, `Chat error: ${e.message}`);
    return `AI error: ${e.message}`;
  }
}
