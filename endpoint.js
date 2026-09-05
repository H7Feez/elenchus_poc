'use strict';

/**
 * Finds out where the team's model is currently running.
 *
 * Every free tunnel hands out a different address each time it restarts, and
 * baking one into the published extension would mean cutting a new release
 * every time that happened. Instead the extension reads the current address
 * from a small text file in the project's public repository. Whoever is
 * hosting the model edits one line on github.com and everyone's extension
 * picks it up, with nothing to install and no settings to change.
 *
 * The file is plain text containing a URL:
 *
 *     https://something.trycloudflare.com/v1
 *
 * A JSON object with a "baseUrl" key is also accepted, so the format can grow
 * without breaking older installs. Blank lines and lines starting with # are
 * ignored, which leaves room for a note about who is hosting and when.
 */

const CACHE_MS = 5 * 60 * 1000;   // re-check at most every five minutes
const FETCH_TIMEOUT_MS = 8000;    // a dead discovery URL must not hang a reply

let cache = { url: null, at: 0, source: null };

/** Forget the cached address, so the next call fetches a fresh one. */
function invalidate() {
  cache = { url: null, at: 0, source: null };
}

function parse(text) {
  const body = String(text || '').trim();
  if (!body) return null;

  if (body.startsWith('{')) {
    try {
      const obj = JSON.parse(body);
      const url = obj && (obj.baseUrl || obj.base_url || obj.url);
      return typeof url === 'string' ? url.trim() : null;
    } catch (_e) {
      return null;
    }
  }

  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  return line || null;
}

function normalise(url) {
  if (!url) return null;
  let out = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(out)) return null;
  // The discovery file may or may not include the /v1 suffix; accept either.
  if (!/\/v\d+$/.test(out)) out += '/v1';
  return out;
}

/**
 * @param {string} discoveryUrl where the address is published
 * @param {(msg: string) => void} [log]
 * @returns {Promise<string|null>} a base URL ending in /v1, or null
 */
async function resolve(discoveryUrl, log) {
  if (!discoveryUrl) return null;

  const fresh = cache.url && Date.now() - cache.at < CACHE_MS && cache.source === discoveryUrl;
  if (fresh) return cache.url;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(discoveryUrl, {
      signal: controller.signal,
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const url = normalise(parse(await res.text()));
    if (!url) throw new Error('no usable URL in the file');
    cache = { url, at: Date.now(), source: discoveryUrl };
    if (log) log('endpoint resolved to ' + url);
    return url;
  } catch (err) {
    if (log) {
      log('could not read the endpoint file (' +
          (err && err.message ? err.message : err) + ')');
    }
    // A stale address beats none: the tunnel may still be up.
    return cache.url;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { resolve, invalidate, parse, normalise };
