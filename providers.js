'use strict';

/**
 * Backend adapters.
 *
 * Everything the rest of the extension knows about models lives behind
 * getReply(). Swapping backends must never require touching extension.js.
 *
 * Message format is the OpenAI chat shape — [{role, content}] with roles
 * 'system' | 'user' | 'assistant' — because Groq, Together, OpenRouter, Ollama
 * and vLLM all accept it directly, and the two that do not (Google, Anthropic)
 * need only a translation inside their own adapter.
 */

/**
 * @param {Array<{role: string, content: string}>} messages
 * @param {{provider: string, baseUrl: string, model: string, temperature: number, apiKey: string|undefined, mode: string|undefined}} opts
 * @returns {Promise<string>} the assistant's reply text
 */
async function getReply(messages, opts) {
  const provider = opts.provider || 'mock';
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new Error(`Unknown provider "${provider}".`);
  }
  return adapter(messages, opts);
}

// ---------------------------------------------------------------------------
// mock — offline, canned, free
// ---------------------------------------------------------------------------

/**
 * Canned replies that escalate the way the system prompts tell a real model to.
 * No network, no key, no cost. This is what lets the team iterate on the panel,
 * the prompts and the guardrail without spending a call.
 *
 * The content is written for samples/wrong_average.py — against any other
 * snippet it will be confidently irrelevant, which is the honest cost of a
 * canned backend. Connect a model for replies that respond to real code.
 *
 * Type "/leak" as a student reply to force a guardrail-tripping response — the
 * fastest way to demo the Direct Output Filter to someone.
 */
const MOCK_LADDER = {
  hint: [
    "Good one to get stuck on — this catches a lot of people. Have a look at line 3 and think about how many times that line actually runs while the loop is going. What's your guess?",
    "Fair enough, it's not obvious from reading. Try printing total at the start and end of each pass. What do you expect to see, and what actually comes out?",
    "You're close. So total isn't carrying anything between passes — what would have to be true for it to build up instead of starting over?",
    "You've basically found it. This is a variable being reset inside the very thing that's supposed to be accumulating it. Where does yours get its starting value?"
  ],
  strong: [
    "Nice, this is a good one to learn from. Line 3 runs on every pass of the loop, not once before it — is that what you meant to happen?\n\nLINES: 3",
    "No worries, let's narrow it. On the second pass through the loop, what's the value of total immediately after line 3 runs?\n\nLINES: 3",
    "Right — so each pass throws away what the last one added. Which of these lines needs to run only once?\n\nLINES: 2-4",
    "You're nearly there. This is a variable being reset inside the loop that should be accumulating it. Where should it start instead?\n\nLINES: 2-4"
  ],
  direct: [
    "Here's what's going on: total gets set back to 0 on every pass of the loop, so it only ever holds the last value that was added. " +
      "The line that starts it at 0 belongs above the loop, where it runs once. Easy one to miss.\n\n" +
      'LINES: 2-4\nFIX:\n```python\n    total = 0\n    for n in nums:\n        total += n\n```'
  ]
};

const MOCK_LEAK = `The bug is on line 3 — total is reset every pass.

\`\`\`python
def average(nums):
    total = 0
    for n in nums:
        total += n
    return total / len(nums)
\`\`\`

Replace your function with that and it will work.`;

async function mockAdapter(messages, opts) {
  await new Promise((r) => setTimeout(r, 400)); // fake latency, keeps the UI honest

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUser && /\/leak\b/.test(lastUser.content)) {
    return MOCK_LEAK;
  }

  const ladder = MOCK_LADDER[opts.mode] || MOCK_LADDER.hint;
  const turnsSoFar = messages.filter((m) => m.role === 'assistant').length;
  return ladder[Math.min(turnsSoFar, ladder.length - 1)];
}

// ---------------------------------------------------------------------------
// openaiCompatible — Groq, Together, OpenRouter, vLLM, and others
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 45000;

/**
 * One adapter for every provider that speaks the OpenAI chat shape. Changing
 * provider is a baseUrl + model + key change in settings, not a code change.
 */
async function openAiCompatibleAdapter(messages, opts) {
  const baseUrl = String(opts.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error(
      'No endpoint set. Put the provider base URL in the setting ' +
      'socraticTutor.baseUrl, e.g. https://api.groq.com/openai/v1'
    );
  }
  if (!opts.model) {
    throw new Error(
      'No model set. Put the model identifier in the setting socraticTutor.model, ' +
      'e.g. qwen/qwen3.8-27b'
    );
  }

  const headers = { 'Content-Type': 'application/json' };
  if (opts.apiKey) {
    headers['Authorization'] = 'Bearer ' + opts.apiKey;
  }
  // ngrok's free tier answers browser-ish requests with an interstitial warning
  // page instead of proxying them. This header opts out of it. Harmless
  // everywhere else, so it is not conditional on the provider.
  headers['ngrok-skip-browser-warning'] = 'true';

  const body = {
    model: opts.model,
    messages,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.6,
    // Direct answers carry a code block, so they need more room than a hint.
    max_tokens: opts.mode === 'direct' ? 700 : 300
  };

  const json = await postJson(baseUrl + '/chat/completions', headers, body);

  const text =
    json &&
    json.choices &&
    json.choices[0] &&
    json.choices[0].message &&
    json.choices[0].message.content;

  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('The provider replied, but with no message content: ' + preview(json));
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// ollama — a local server, same request shape, no key
// ---------------------------------------------------------------------------

async function ollamaAdapter(messages, opts) {
  return openAiCompatibleAdapter(messages, {
    ...opts,
    baseUrl: opts.baseUrl || 'http://localhost:11434/v1',
    apiKey: undefined
  });
}

// ---------------------------------------------------------------------------
// local — the team's own fine-tuned model, served by model/serve.py
// ---------------------------------------------------------------------------

async function localAdapter(messages, opts) {
  return openAiCompatibleAdapter(messages, {
    ...opts,
    baseUrl: opts.baseUrl || 'http://127.0.0.1:8008/v1',
    model: opts.model || 'elenchus',
    apiKey: undefined
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * The failure messages here are deliberately specific. A student hitting a
 * rate limit and a student with a bad key should not see the same sentence.
 */
/**
 * Free tiers meter input tokens per minute, and a quick back-and-forth with a
 * ~1k-token system prompt hits that ceiling in a handful of turns. Providers
 * say exactly how long to wait, so when it is short we just wait, once, rather
 * than hand the student an error for something that clears itself in seconds.
 */
const RETRY_AFTER_MAX_S = 15;

async function postJson(url, headers, body, attempt) {
  attempt = attempt || 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`The model did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new Error(`Could not reach ${url} — ${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();

  if (response.status === 429 && attempt === 1) {
    const wait = retryAfterSeconds(response, raw);
    if (wait !== null && wait <= RETRY_AFTER_MAX_S) {
      await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 250));
      return postJson(url, headers, body, 2);
    }
  }

  if (!response.ok) {
    throw new Error(explainHttpError(response.status, raw));
  }

  try {
    return JSON.parse(raw);
  } catch (_e) {
    throw new Error('The provider returned something that is not JSON: ' + preview(raw));
  }
}

/** The Retry-After header when present; otherwise Groq's "try again in 1.3s". */
function retryAfterSeconds(response, raw) {
  const header = response.headers && response.headers.get && response.headers.get('retry-after');
  if (header && !isNaN(parseFloat(header))) return parseFloat(header);
  const m = /try again in\s+([\d.]+)\s*(ms|s)?/i.exec(raw || '');
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'ms' ? n / 1000 : n;
}

function explainHttpError(status, raw) {
  const detail = extractProviderMessage(raw);
  switch (status) {
    case 401:
    case 403:
      return `The provider rejected the API key (HTTP ${status}). ` +
             `Run "Socratic Tutor: Set API Key" again. ${detail}`;
    case 404:
      return `Endpoint or model not found (HTTP 404). Check socraticTutor.baseUrl ` +
             `ends at /v1 and that socraticTutor.model is a current model id. ${detail}`;
    case 429:
      return `Rate limit or quota reached (HTTP 429). Wait a moment, or switch ` +
             `socraticTutor.provider to "mock" while you work on the prompt. ${detail}`;
    default:
      return `The provider returned HTTP ${status}. ${detail}`;
  }
}

/** Most providers put a human-readable reason at error.message. */
function extractProviderMessage(raw) {
  try {
    const j = JSON.parse(raw);
    const m = (j && j.error && (j.error.message || j.error)) || j.message;
    if (typeof m === 'string') return m;
  } catch (_e) {
    // not JSON, fall through
  }
  return preview(raw);
}

function preview(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '';
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

const ADAPTERS = {
  mock: mockAdapter,
  openaiCompatible: openAiCompatibleAdapter,
  ollama: ollamaAdapter,
  local: localAdapter
};

/** Providers that need a key before they can be called. */
const NEEDS_KEY = new Set(['openaiCompatible']);

module.exports = { getReply, NEEDS_KEY };
