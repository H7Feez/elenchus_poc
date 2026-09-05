'use strict';

/**
 * Pulls the machine-readable parts out of a model reply.
 *
 * A reply may carry, after its prose:
 *   LINES: 3        or   LINES: 3-5
 *   FIX:
 *   ```python
 *   ...replacement text...
 *   ```
 *
 * Both are optional. Everything here degrades quietly: a missing or malformed
 * marker costs a highlight, never the reply itself. That matters because small
 * models drop formatting under pressure, and a student should still get their
 * hint when they do.
 */

const LINES_RE = /^[ \t]*LINES:[ \t]*(\d+)(?:[ \t]*[-–—][ \t]*(\d+))?[ \t]*$/m;
const FIX_FENCED_RE = /^[ \t]*FIX:[ \t]*\r?\n[ \t]*```[^\n]*\r?\n([\s\S]*?)^[ \t]*```/m;
const FIX_BARE_RE = /^[ \t]*FIX:[ \t]*\r?\n([\s\S]*)$/m;

/**
 * @param {string} raw the model's reply
 * @returns {{prose: string, range: {start: number, end: number}|null, fix: string|null}}
 */
function parseReply(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');

  let range = null;
  const linesMatch = text.match(LINES_RE);
  if (linesMatch) {
    const start = parseInt(linesMatch[1], 10);
    const end = linesMatch[2] ? parseInt(linesMatch[2], 10) : start;
    // A backwards or zero range means the model garbled it. Drop it rather
    // than highlighting something arbitrary.
    if (start >= 1 && end >= start) {
      range = { start, end };
    }
  }

  let fix = null;
  let fixMatch = text.match(FIX_FENCED_RE);
  if (fixMatch) {
    fix = trimTrailingBlank(fixMatch[1]);
  } else {
    // The model announced a fix but forgot the fence. Take the rest of the
    // reply rather than losing it.
    fixMatch = text.match(FIX_BARE_RE);
    if (fixMatch) {
      fix = trimTrailingBlank(stripStrayFences(fixMatch[1]));
    }
  }
  if (fix !== null && !fix.trim()) fix = null;

  // Prose is whatever came before the first marker.
  let cut = text.length;
  [linesMatch, fixMatch].forEach(function (m) {
    if (m && typeof m.index === 'number' && m.index < cut) cut = m.index;
  });

  return { prose: text.slice(0, cut).trim(), range, fix };
}

function trimTrailingBlank(s) {
  return String(s).replace(/\s+$/, '');
}

function stripStrayFences(s) {
  return String(s).replace(/^[ \t]*```[^\n]*\n?/gm, '');
}

/**
 * Swaps a 1-based inclusive line range in `code` for `replacement`.
 * Returns null if the range does not exist, so a bad marker can never
 * mangle the student's file.
 */
function applyRange(code, range, replacement) {
  if (!range) return null;
  const lines = String(code).replace(/\r\n?/g, '\n').split('\n');
  if (range.start < 1 || range.end > lines.length) return null;

  const before = lines.slice(0, range.start - 1);
  const after = lines.slice(range.end);
  const inserted = String(replacement).replace(/\r\n?/g, '\n').split('\n');
  return before.concat(inserted, after).join('\n');
}

/** The exact original text of a line range, for locating it in an editor. */
function sliceRange(code, range) {
  if (!range) return null;
  const lines = String(code).replace(/\r\n?/g, '\n').split('\n');
  if (range.start < 1 || range.end > lines.length) return null;
  return lines.slice(range.start - 1, range.end).join('\n');
}

module.exports = { parseReply, applyRange, sliceRange };
