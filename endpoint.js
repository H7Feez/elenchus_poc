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
      // GitHub's contents API wraps the file in JSON, base64-encoded. Reading
      // it that way rather than through raw.githubusercontent.com matters:
      // raw sits behind a five-minute CDN cache that a query string cannot
      // defeat, so a freshly published address stayed invisible and Refresh
      // Endpoint had nothing fresher to find.
      if (obj && typeof obj.content === 'string' && obj.encoding === 'base64') {
        return parse(Buffer.from(obj.content, 'base64').toString('utf8'));
      }
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

  // The API is authoritative and uncached; raw is the fallback for when the
  // API's unauthenticated rate limit is exhausted. Trying both means a rate
  // limit costs freshness rather than the connection.
  const attempts = [discoveryUrl];
  const raw = rawFallbackFor(discoveryUrl);
  if (raw) attempts.push(raw);

  let lastError = null;
  for (const attempt of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(attempt, {
        signal: controller.signal,
        headers: { 'Cache-Control': 'no-cache', Accept: 'application/vnd.github.raw+json, text/plain, */*' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const url = normalise(parse(await res.text()));
      if (!url) throw new Error('no usable URL in the file');
      cache = { url, at: Date.now(), source: discoveryUrl };
      if (log) {
        log('endpoint resolved to ' + url + (attempt === discoveryUrl ? '' : ' (via the cached mirror)'));
      }
      return url;
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }

  if (log) {
    log('could not read the endpoint file (' +
        (lastError && lastError.message ? lastError.message : lastError) + ')');
  }
  // A stale address beats none: the tunnel may still be up.
  return cache.url;
}

/**
 * The raw.githubusercontent mirror of a GitHub contents-API URL, or null.
 * Used only when the API itself fails.
 */
function rawFallbackFor(url) {
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(String(url || ''));
  if (!m) return null;
  const [, owner, repo, rest] = m;
  const path = rest.split('?')[0];
  const refMatch = /[?&]ref=([^&]+)/.exec(rest);
  const ref = refMatch ? refMatch[1] : 'main';
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
}

module.exports = { resolve, invalidate, parse, normalise, rawFallbackFor };
