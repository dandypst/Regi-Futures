// lessons.js — Persistent lesson storage and injection system
// Generates structured trading insights from closed trade history via AI

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import axios from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';

const DATA_DIR = './data';
const LESSONS_FILE = resolve(DATA_DIR, 'lessons.json');
const MOD = 'LESSONS';

try { mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

let _lessons = [];

export function loadLessons() {
  try {
    if (existsSync(LESSONS_FILE)) {
      _lessons = JSON.parse(readFileSync(LESSONS_FILE, 'utf-8'));
      logger.sys(MOD, `Loaded ${_lessons.length} lessons`);
    }
  } catch (e) {
    logger.warn(MOD, 'No lessons found, starting fresh');
    _lessons = [];
  }
}

export function saveLessons() {
  try {
    writeFileSync(LESSONS_FILE, JSON.stringify(_lessons, null, 2));
  } catch (e) {
    logger.error(MOD, `Could not save lessons: ${e.message}`);
  }
}

export function getLessons() {
  return [..._lessons];
}

export function addLesson(lesson) {
  _lessons.push({ ...lesson, id: Date.now(), createdAt: new Date().toISOString() });
  saveLessons();
  logger.ai(MOD, `New lesson saved: ${lesson.insight?.slice(0, 80)}...`);
}

export function getLessonsContext() {
  if (_lessons.length === 0) return '';
  const top = _lessons.slice(-15);
  return `\n\n## LEARNED LESSONS (${_lessons.length} total, showing last 15):\n` +
    top.map((l, i) =>
      `${i + 1}. [${l.pair || 'GENERAL'}][${l.direction || 'ANY'}] ${l.insight} (confidence: ${l.confidence || 'medium'})`
    ).join('\n');
}

// ── AI-powered lesson generation ──────────────────────────────────────────────

export async function generateLessonsFromTrades(tradeHistory) {
  if (!config.openRouterApiKey) {
    logger.warn(MOD, 'No OpenRouter API key — skipping AI lesson generation');
    return 0;
  }
  if (tradeHistory.length < 3) {
    logger.info(MOD, 'Not enough trades to generate lessons (need 3+)');
    return 0;
  }

  const summary = tradeHistory.map(t =>
    `${t.symbol} ${t.side} entry:${t.entryPrice} exit:${t.exitPrice} ` +
    `pnl:${t.pnl?.toFixed(2)} pnlPct:${t.pnlPct?.toFixed(2)}% reason:${t.closeReason || 'unknown'} date:${t.closedAt}`
  ).join('\n');

  const prompt = `You are an expert crypto futures trading analyst.

Analyze the following closed futures trade history and extract 4-8 concrete, actionable lessons.
Focus on: entry timing, market conditions, leverage, stop-loss placement, take-profit levels, and pair-specific behavior.

Trade history:
${summary}

Respond ONLY with a JSON array. Each element must be:
{
  "pair": "BTCUSDT" or "GENERAL",
  "direction": "LONG" or "SHORT" or "ANY",
  "insight": "specific actionable insight under 120 characters",
  "confidence": "high" or "medium" or "low"
}

No preamble, no markdown fences, just raw JSON array.`;

  try {
    logger.ai(MOD, 'Generating lessons from trade history via AI...');
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: config.openRouterModel || 'anthropic/claude-3-haiku',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          Authorization: `Bearer ${config.openRouterApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const text = res.data.choices[0].message.content.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const newLessons = JSON.parse(clean);

    let added = 0;
    for (const l of newLessons) {
      if (l.insight) {
        addLesson({ ...l, source: 'ai-analysis' });
        added++;
      }
    }
    logger.ai(MOD, `Generated and saved ${added} new lessons`);
    return added;
  } catch (e) {
    logger.error(MOD, `Lesson generation failed: ${e.message}`);
    return 0;
  }
}
