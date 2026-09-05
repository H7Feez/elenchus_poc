'use strict';

/**
 * The Direct Output Filter.
 *
 * This exists to answer the obvious challenge to the whole project: "why not
 * just prompt ChatGPT to be Socratic?" A prompt is a request the model may
 * ignore. This is enforcement applied after the fact, outside the model.
 *
 * It is deliberately crude. A cheap, transparent, countable filter is worth
 * more to the write-up than a clever one, because every rule here is a rule we
 * can explain and measure. Track how often it fires — that number is evidence.
 */

// Fenced code blocks: ```python ... ``` — the most common leak by far.
const FENCE = /```/;

// Lines that are almost certainly code being handed over rather than discussed.
const CODE_LINE_PATTERNS = [
  /^\s*(def|class)\s+\w+\s*\(/,          // Python definitions
  /^\s*(function|const|let|var)\s+\w+\s*[=(]/, // JavaScript definitions
  /^\s*(public|private|protected)\s+\w+/, // Java-ish declarations
  /^\s*(if|elif|else|for|while|try|except|switch)\b.*[:{]\s*$/, // control flow opening a body
  /^\s*return\s+.+/,                     // a returned value
  /^\s*\w+\s*=\s*.+/                     // an assignment
];

// Phrases that state the bug outright instead of asking about it.
const SPOILER_PHRASES = [
  /\bthe (bug|problem|issue|error) is\b/i,
  /\bthe fix is\b/i,
  /\byou (need to|should) (change|replace|add|remove)\b/i,
  /\bchange (line|it) .* to\b/i,
  /\breplace .* with\b/i,
  /\bhere('s| is) the (corrected|fixed|working)\b/i,
  /\bsimply (change|replace|add)\b/i
];

const MAX_CONSECUTIVE_CODE_LINES = 2;
const MAX_WORDS = 120; // the prompt asks for 60; this is the hard ceiling

/**
 * Inspects a model reply and decides whether it gave the game away.
 *
 * Returns { blocked: boolean, reasons: string[] } so the caller can log WHY,
 * not just that it happened. The reasons are what turns this into data.
 */
function inspect(reply) {
  const reasons = [];
  const text = String(reply || '');

  if (FENCE.test(text)) {
    reasons.push('contains a fenced code block');
  }

  let run = 0;
  let maxRun = 0;
  for (const line of text.split('\n')) {
    const isCode = CODE_LINE_PATTERNS.some((p) => p.test(line));
    run = isCode ? run + 1 : 0;
    if (run > maxRun) maxRun = run;
  }
  if (maxRun > MAX_CONSECUTIVE_CODE_LINES) {
    reasons.push(`${maxRun} consecutive lines that look like code`);
  }

  // Spoiler phrases are checked per sentence, and questions are exempt.
  // "The problem is a wrong index." is a spoiler; "What do you think the
  // problem is?" is the tutor doing exactly its job. Scanning the whole reply
  // in one pass cannot tell those apart and blocks the good one.
  outer:
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (/\?\s*$/.test(sentence.trim())) continue;
    for (const phrase of SPOILER_PHRASES) {
      if (phrase.test(sentence)) {
        reasons.push(`states the answer directly (matched ${phrase})`);
        break outer;
      }
    }
  }

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS) {
    reasons.push(`${words} words, over the ${MAX_WORDS} ceiling`);
  }

  return { blocked: reasons.length > 0, reasons };
}

/**
 * A reply should normally contain a question. A tutor that has stopped asking
 * has usually started telling. Not grounds to block on its own — the tutor is
 * allowed to confirm a correct answer — but worth counting.
 */
function hasQuestion(reply) {
  return /\?/.test(String(reply || ''));
}

module.exports = { inspect, hasQuestion };
