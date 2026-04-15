// evolve.js — Threshold evolution system
// Analyzes closed trade history and evolves strategy parameters
// Requires 5+ closed trades to activate (configurable via evolveMinTrades)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import axios from 'axios';
import { config, saveUserConfig } from './config.js';
import { logger } from './logger.js';

const DATA_DIR = './data';
const TRADE_HISTORY_FILE = resolve(DATA_DIR, 'trade-history.json');
const MOD = 'EVOLVE';

try { mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

export function loadTradeHistory() {
  try {
    if (existsSync(TRADE_HISTORY_FILE)) {
      return JSON.parse(readFileSync(TRADE_HISTORY_FILE, 'utf-8'));
    }
  } catch (_) {}
  return [];
}

export function saveTradeToHistory(trade) {
  const history = loadTradeHistory();
  history.push({ ...trade, savedAt: new Date().toISOString() });
  const trimmed = history.slice(-200); // keep last 200
  writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(trimmed, null, 2));
  logger.info(MOD, `Trade saved to history (total: ${trimmed.length})`);
}

export async function evolveThresholds() {
  const history = loadTradeHistory();
  const closed = history.filter(t => t.closedAt);

  if (closed.length < (config.evolveMinTrades || 5)) {
    logger.warn(MOD, `Need ${config.evolveMinTrades || 5}+ closed trades to evolve (have ${closed.length})`);
    return null;
  }

  if (!config.openRouterApiKey) {
    logger.warn(MOD, 'No OpenRouter API key — using rule-based evolution');
    return ruleBasedEvolve(closed);
  }

  return aiEvolve(closed);
}

// ── Rule-based evolution (no AI required) ────────────────────────────────────

function ruleBasedEvolve(trades) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const winRate = wins.length / trades.length;

  const changes = {};
  const rationale = [];

  // Leverage: reduce if win rate < 45%, increase if > 65%
  if (winRate < 0.45 && config.leverage > 2) {
    changes.leverage = Math.max(2, config.leverage - 1);
    rationale.push(`Win rate ${(winRate*100).toFixed(1)}% < 45% → reducing leverage ${config.leverage}x → ${changes.leverage}x`);
  } else if (winRate > 0.65 && config.leverage < 10) {
    changes.leverage = Math.min(10, config.leverage + 1);
    rationale.push(`Win rate ${(winRate*100).toFixed(1)}% > 65% → increasing leverage ${config.leverage}x → ${changes.leverage}x`);
  }

  // Stop loss: widen if too many SL hits
  const slHits = losses.filter(t => t.closeReason === 'stop_loss').length;
  if (slHits / trades.length > 0.4) {
    const newSL = Math.min(0.03, config.stopLossPct + 0.002);
    changes.stopLossPct = parseFloat(newSL.toFixed(3));
    rationale.push(`${slHits} SL hits (${(slHits/trades.length*100).toFixed(0)}%) → widening SL to ${(changes.stopLossPct*100).toFixed(1)}%`);
  }

  // Take profit: lower if rarely hitting TP
  const tpHits = wins.filter(t => t.closeReason === 'take_profit').length;
  if (wins.length > 0 && tpHits / wins.length < 0.3) {
    const newTP = Math.max(0.01, config.takeProfitPct - 0.005);
    changes.takeProfitPct = parseFloat(newTP.toFixed(3));
    rationale.push(`Only ${(tpHits/wins.length*100).toFixed(0)}% TP hits → lowering TP to ${(changes.takeProfitPct*100).toFixed(1)}%`);
  }

  // Risk per trade: reduce on recent losing streak
  const last5 = trades.slice(-5);
  const recentLosses = last5.filter(t => t.pnl < 0).length;
  if (recentLosses >= 4 && config.riskPerTrade > 0.01) {
    changes.riskPerTrade = Math.max(0.01, config.riskPerTrade - 0.005);
    rationale.push(`${recentLosses}/5 recent losses → reducing risk to ${(changes.riskPerTrade*100).toFixed(1)}%`);
  }

  if (Object.keys(changes).length === 0) {
    rationale.push('Performance within acceptable range — no changes needed');
  }

  applyChanges(changes, rationale);
  return { changes, rationale };
}

// ── AI-powered evolution ──────────────────────────────────────────────────────

async function aiEvolve(trades) {
  const summary = trades.slice(-30).map(t =>
    `${t.symbol} ${t.side} leverage:${t.leverage}x entry:${t.entryPrice} exit:${t.exitPrice} ` +
    `pnl:${t.pnl?.toFixed(2)} pnlPct:${t.pnlPct?.toFixed(2)}% reason:${t.closeReason} hold:${t.holdMinutes}min`
  ).join('\n');

  const current = {
    leverage: config.leverage,
    riskPerTrade: config.riskPerTrade,
    takeProfitPct: config.takeProfitPct,
    stopLossPct: config.stopLossPct,
  };

  const prompt = `You are a quant trading risk manager for a Binance Futures bot.

Current thresholds: ${JSON.stringify(current, null, 2)}

Last ${Math.min(30, trades.length)} closed trades:
${summary}

Analyze performance and suggest threshold adjustments. Consider:
- Win rate and risk/reward ratio
- Stop loss hit frequency vs take profit hit frequency
- Leverage appropriateness

Respond ONLY with a JSON object:
{
  "changes": {
    "leverage": <number or omit>,
    "riskPerTrade": <0.01-0.05 or omit>,
    "takeProfitPct": <0.01-0.1 or omit>,
    "stopLossPct": <0.005-0.05 or omit>
  },
  "rationale": ["reason 1", "reason 2"]
}

Only include fields that should actually change. No preamble, raw JSON only.`;

  try {
    logger.ai(MOD, 'Running AI threshold evolution...');
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: config.openRouterModel || 'anthropic/claude-3-haiku',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          Authorization: `Bearer ${config.openRouterApiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const text = res.data.choices[0].message.content.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    applyChanges(result.changes || {}, result.rationale || []);
    return result;
  } catch (e) {
    logger.error(MOD, `AI evolution failed: ${e.message} — falling back to rule-based`);
    return ruleBasedEvolve(trades);
  }
}

function applyChanges(changes, rationale) {
  if (Object.keys(changes).length > 0) {
    // Validate bounds
    if (changes.leverage)      changes.leverage      = Math.min(20, Math.max(1, changes.leverage));
    if (changes.riskPerTrade)  changes.riskPerTrade  = Math.min(0.05, Math.max(0.005, changes.riskPerTrade));
    if (changes.takeProfitPct) changes.takeProfitPct = Math.min(0.2, Math.max(0.01, changes.takeProfitPct));
    if (changes.stopLossPct)   changes.stopLossPct   = Math.min(0.1, Math.max(0.005, changes.stopLossPct));

    saveUserConfig(changes); // persists to user-config.json + updates live config
    logger.ai(MOD, `Thresholds evolved: ${JSON.stringify(changes)}`);
  }

  for (const r of rationale) {
    logger.ai(MOD, `→ ${r}`);
  }
}

export function getEvolveSummary() {
  const history = loadTradeHistory();
  const closed = history.filter(t => t.closedAt);
  const wins = closed.filter(t => t.pnl > 0);
  return {
    totalClosed: closed.length,
    winRate: closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : '0.0',
    totalPnl: closed.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2),
    avgPnl: closed.length > 0
      ? (closed.reduce((s, t) => s + (t.pnl || 0), 0) / closed.length).toFixed(2)
      : '0.00',
    canEvolve: closed.length >= (config.evolveMinTrades || 5),
  };
}
