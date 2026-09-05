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
 * @param {{provider: string, baseUrl: string, model: string, temperature: number, apiKey: string|undefined}} opts
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
// mock — the only adapter implemented right now
// ---------------------------------------------------------------------------

/**
 * Canned replies that escalate the way the system prompt tells a real model to.
 * No network, no key, no cost. This is what lets the team iterate on the UI,
 * the transcript flow and the guardrail before deciding on a model.
 *
 * Type "/leak" as a student reply to force a guardrail-tripping response — the
 * fastest way to demo the Direct Output Filter to someone.
 */
const MOCK_LADDER = [
  "Look at the line where the loop ends. What is the largest index your loop will actually reach?",
  "Print that index just before the line that fails. What number do you expect, and what do you get?",
  "So the index and the length of the list are not the same thing. Which one does the last valid position use?",
  "This is the shape of an off-by-one error. Where in your loop does the count start from?"
];

const MOCK_LEAK = `The bug is on line 14 — your range goes one step too far.

\`\`\`python
for i in range(len(items) - 1):
    print(items[i])
\`\`\`

Replace your loop with that and it will work.`;

async function mockAdapter(messages, _opts) {
  await new Promise((r) => setTimeout(r, 400)); // fake latency, keeps the UI honest

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUser && /\/leak\b/.test(lastUser.content)) {
    return MOCK_LEAK;
  }

  const turnsSoFar = messages.filter((m) => m.role === 'assistant').length;
  return MOCK_LADDER[Math.min(turnsSoFar, MOCK_LADDER.length - 1)];
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
      'e.g. llama-3.3-70b-versatile'
    );
  }

  const headers = { 'Content-Type': 'application/json' };
  if (opts.apiKey) {
    headers['Authorization'] = 'Bearer ' + opts.apiKey;
  }

  const body = {
    model: opts.model,
    messages,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.6,
    max_tokens: 300 // a hint is short; this is a cheap second brake on rambling
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
// HTTP
// ---------------------------------------------------------------------------

/**
 * The failure messages here are deliberately specific. A student hitting a
 * rate limit and a student with a bad key should not see the same sentence.
 */
async function postJson(url, headers, body) {
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

  if (!response.ok) {
    throw new Error(explainHttpError(response.status, raw));
  }

  try {
    return JSON.parse(raw);
  } catch (_e) {
    throw new Error('The provider returned something that is not JSON: ' + preview(raw));
  }
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
  ollama: ollamaAdapter
};

/** Providers that need a key before they can be called. */
const NEEDS_KEY = new Set(['openaiCompatible']);

module.exports = { getReply, NEEDS_KEY };
