// config.js — Central configuration loader
// Reads from .env and user-config.json
// Pure sync — safe to import from any module at startup

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const CONFIG_PATH = resolve('./user-config.json');

const DEFAULTS = {
  mode: 'testnet',              // 'testnet' | 'live'
  dryRun: true,
  pairs: ['BTCUSDT', 'ETHUSDT'],
  leverage: 5,
  maxPositions: 3,
  riskPerTrade: 0.02,
  takeProfitPct: 0.03,
  stopLossPct: 0.015,
  trailingStop: false,
  managementIntervalMin: 10,
  screeningIntervalMin: 30,
  evolveMinTrades: 5,
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: 'anthropic/claude-3-haiku',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  dashboardPort: 3000,
};

let userConfig = {};
try {
  if (existsSync(CONFIG_PATH)) {
    userConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  }
} catch (e) {
  console.warn('[config] Could not load user-config.json, using defaults.');
}

export const config = { ...DEFAULTS, ...userConfig };

// Binance API endpoints
export const BINANCE = {
  testnet: {
    baseUrl: 'https://testnet.binancefuture.com',
    wsUrl: 'wss://stream.binancefuture.com/ws',
  },
  live: {
    baseUrl: 'https://fapi.binance.com',
    wsUrl: 'wss://fstream.binance.com/ws',
  },
};

// FIX: pisahkan API key testnet dan live
// Jika mode=testnet → pakai BINANCE_TESTNET_API_KEY
// Jika mode=live    → pakai BINANCE_LIVE_API_KEY
// Fallback ke BINANCE_API_KEY jika key spesifik tidak ada
export function getBinanceConfig() {
  const mode = config.mode || 'testnet';

  let apiKey, apiSecret;

  if (mode === 'testnet') {
    apiKey    = process.env.BINANCE_TESTNET_API_KEY    || process.env.BINANCE_API_KEY    || '';
    apiSecret = process.env.BINANCE_TESTNET_API_SECRET || process.env.BINANCE_API_SECRET || '';
  } else {
    apiKey    = process.env.BINANCE_LIVE_API_KEY    || process.env.BINANCE_API_KEY    || '';
    apiSecret = process.env.BINANCE_LIVE_API_SECRET || process.env.BINANCE_API_SECRET || '';
  }

  return {
    ...BINANCE[mode],
    apiKey,
    apiSecret,
    mode,
  };
}

// Persist config changes to disk (sync)
export function saveUserConfig(updates) {
  try {
    let current = {};
    if (existsSync(CONFIG_PATH)) {
      current = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    }
    const merged = { ...current, ...updates };
    writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
    Object.assign(userConfig, updates);
    Object.assign(config, updates);
  } catch (e) {
    console.error('[config] Could not save user config:', e.message);
  }
}
