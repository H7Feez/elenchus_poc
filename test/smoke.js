// Smoke tests for the parts of the extension that do not need the vscode API.
//
// The team has no Node.js installed, so run this with VS Code's own runtime:
//
//   ELECTRON_RUN_AS_NODE=1 "<path to>/Code.exe" test/smoke.js
//
// See the README for the full command on Windows.

const path = '../';
const guardrail = require(path + 'guardrail.js');
const providers = require(path + 'providers.js');
const prompt = require(path + 'prompt.js');
const parse = require(path + 'parse.js');

let fails = 0;
function check(name, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name);
  if (!cond) fails++;
}

// --- guardrail: things it MUST catch ---
const leak = 'The bug is on line 14.\n\n```python\nfor i in range(3):\n    print(i)\n```\n\nReplace your loop with that.';
check('catches fenced code', guardrail.inspect(leak).blocked);
check('catches "the bug is"', guardrail.inspect('The bug is an off-by-one.').blocked);
check('catches "replace X with Y"', guardrail.inspect('Just replace len(n) with len(n)-1 there.').blocked);
check('catches consecutive code lines', guardrail.inspect('total = 0\nfor i in range(3):\n    total = total + i\nreturn total').blocked);
check('catches over-long reply', guardrail.inspect('word '.repeat(200)).blocked);

// --- guardrail: things it MUST NOT catch (false positives) ---
const goodHints = [
  "Look at the line where the loop ends. What is the largest index your loop will actually reach?",
  "Print that index just before the line that fails. What number do you expect, and what do you get?",
  "So the index and the length of the list are not the same thing. Which one does the last valid position use?",
  "This is the shape of an off-by-one error. Where in your loop does the count start from?",
  "What do you think the problem is with that assumption?",
  "Where do you think the error is coming from?",
  "You said total should be 15. What is it actually?"
];
goodHints.forEach((h, i) => {
  const r = guardrail.inspect(h);
  check('no false positive #' + (i + 1) + (r.blocked ? ' -> ' + r.reasons.join('; ') : ''), !r.blocked);
});

check('hasQuestion true', guardrail.hasQuestion('What is x?'));
check('hasQuestion false', !guardrail.hasQuestion('That is correct.'));

// An empty reply usually means the model answered with a bare code block and
// the markers were all that survived parsing. Treat it as a leak, not as fine.
check('blocks an empty reply', guardrail.inspect('').blocked);
check('blocks a whitespace-only reply', guardrail.inspect('   \n  ').blocked);

// "you should add ..." is a hint technique when it is about a diagnostic, and
// a spoiler when it is the fix itself. The backticks are what separates them.
check('allows "you should add a print to check"', !guardrail.inspect('Good instinct. You should add a print inside the loop to check what total is doing. What comes out?').blocked);
check('blocks "you should add `total = 0`"', guardrail.inspect('You should add `total = 0` above the loop.').blocked);
check('still blocks "you need to change"', guardrail.inspect('You need to change line 3.').blocked);

// The friendlier prompt allows a sentence of warmth around the question, so
// the ceiling had to move. A reply of this length must pass.
check('allows a warm ~90-word hint', !guardrail.inspect(
  "Good one to get stuck on — this catches a lot of people, so don't feel bad about it. " +
  "Have a look at line 3 and think about how many times that particular line actually runs " +
  "while the loop is going round. It might help to put a print just after it and watch what " +
  "comes out on each pass. What's your guess before you run it?"
).blocked);

// --- trimThread: bounded conversation memory ---
// extension.js requires 'vscode', which does not exist outside the editor.
// It touches nothing on it at load time, so an empty stub is enough to import.
const Module = require('module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'vscode') return 'vscode';
  return realResolve.call(this, request, parent, isMain, options);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: {} };
const { trimThread, BACKENDS } = require(path + 'extension.js');

// --- backend presets ---
// Each preset must set all three settings together: a half-applied switch is
// how you end up with results collected under a configuration nobody can
// reconstruct.
check('four backends offered', BACKENDS.length === 4);
check('every preset sets provider, baseUrl and model', BACKENDS.every(
  (b) => 'provider' in b.settings && 'baseUrl' in b.settings && 'model' in b.settings));
check('local presets clear baseUrl so they follow endpoint.txt', BACKENDS
  .filter((b) => b.settings.provider === 'local')
  .every((b) => b.settings.baseUrl === ''));
check('the trained and untrained presets differ only by model', (function () {
  const a = BACKENDS.find((b) => b.id === 'elenchus');
  const z = BACKENDS.find((b) => b.id === 'elenchus-base');
  return a && z && a.settings.provider === z.settings.provider &&
         a.settings.model !== z.settings.model;
})());
check('only the hosted preset demands a key', BACKENDS
  .filter((b) => b.needsKey).every((b) => b.settings.provider === 'openaiCompatible'));
check('preset ids are unique', new Set(BACKENDS.map((b) => b.id)).size === BACKENDS.length);

// --- context window matches what the model was trained with ---
const { THREAD_TAIL, looksLikeConceptQuestion } = require(path + 'extension.js');
check('serving keeps the same recent-turn window as training (6)', THREAD_TAIL === 6);

// --- concept-question detection: what gets routed away from the small model ---
[
  'what does counts[word] do?', "what's a KeyError", 'how does split() work',
  'why is it 10 and not 25', 'I dont understand what you mean', "I don't get it",
  'can you explain that', 'im confused', 'not sure what you mean'
].forEach((t) => check('concept question: ' + JSON.stringify(t), looksLikeConceptQuestion(t)));
[
  'is it because the dictionary is empty at first?', 'I think line 3 resets total',
  'thanks, that helped', 'ok let me try that', 'yes it prints 10'
].forEach((t) => check('not a concept question: ' + JSON.stringify(t), !looksLikeConceptQuestion(t)));

// --- mining a highlight from prose when the marker is missing ---
check('mines "line 4"', JSON.stringify(parse.mineLines('Have a look at line 4. What happens?')) === '{"start":4,"end":4}');
check('mines "lines 3-5"', JSON.stringify(parse.mineLines('lines 3-5 run every pass')) === '{"start":3,"end":5}');
check('mines "lines 2 to 4"', JSON.stringify(parse.mineLines('Compare lines 2 to 4.')) === '{"start":2,"end":4}');
check('mines "lines 2 and 4" as a range', JSON.stringify(parse.mineLines('lines 2 and 4 both matter')) === '{"start":2,"end":4}');
check('first mention wins', parse.mineLines('line 7, then line 2').start === 7);
check('no mention means null', parse.mineLines('What does the loop do?') === null);
check('ignores "online"', parse.mineLines('look online for docs') === null);
check('rejects a backwards range', parse.mineLines('lines 9-2') === null);

// --- refusing fixes that would embarrass the Apply button ---
const sel = 'def top_word(text):\n    counts = {}\n    for word in text.split():\n        counts[word] += 1\n    return max(counts, key=counts.get)';
check('accepts a real fix', parse.fixProblems(sel, { start: 4, end: 4 }, '        counts[word] = counts.get(word, 0) + 1').length === 0);
check('rejects a fix identical to the original', parse.fixProblems(sel, { start: 2, end: 4 }, '    counts = {}\n    for word in text.split():\n        counts[word] += 1').length > 0);
check('identical means identical up to whitespace', parse.fixProblems(sel, { start: 4, end: 4 }, 'counts[word] += 1').length > 0);
check('rejects an empty fix', parse.fixProblems(sel, { start: 4, end: 4 }, '   ').length > 0);
check('rejects a fix outside the selection', parse.fixProblems(sel, { start: 4, end: 40 }, 'x = 1').length > 0);
check('rejects names copied from the prompt example', parse.fixProblems(sel, { start: 2, end: 4 }, '    total = 0\n    for n in nums:\n        counts[n] += 1').some((p) => /prompt example/.test(p)));
check('allows those names when the code already uses them', parse.fixProblems('total = 0\nfor n in nums:\n    total = n', { start: 3, end: 3 }, '    total += n').length === 0);

function fakeThread(n) {
  const t = [{ role: 'user', content: 'CODE' }];
  for (let i = 1; i < n; i++) t.push({ role: i % 2 ? 'assistant' : 'user', content: 't' + i });
  return t;
}
check('trimThread leaves a short thread alone', (function () {
  const s = { thread: fakeThread(5) };
  trimThread(s);
  return s.thread.length === 5;
})());
check('trimThread keeps the code turn first', (function () {
  const s = { thread: fakeThread(30) };
  trimThread(s);
  return s.thread[0].content === 'CODE';
})());
check('trimThread bounds the thread', (function () {
  const s = { thread: fakeThread(30) };
  trimThread(s);
  return s.thread.length <= 10;
})());
check('trimThread never puts two user turns together', (function () {
  for (let n = 10; n < 24; n++) {
    const s = { thread: fakeThread(n) };
    trimThread(s);
    for (let i = 1; i < s.thread.length; i++) {
      if (s.thread[i].role === 'user' && s.thread[i - 1].role === 'user') return false;
    }
  }
  return true;
})());

// --- parse: the LINES marker ---
check('parses a single line', (function () {
  const r = parse.parseReply('Look at it.\n\nLINES: 3');
  return r.range && r.range.start === 3 && r.range.end === 3 && r.prose === 'Look at it.';
})());
check('parses a range', (function () {
  const r = parse.parseReply('Look at it.\n\nLINES: 2-4');
  return r.range && r.range.start === 2 && r.range.end === 4;
})());
check('parses an en-dash range', (function () {
  const r = parse.parseReply('x\n\nLINES: 2–4');
  return r.range && r.range.end === 4;
})());
check('no marker means no range', parse.parseReply('Just a question?').range === null);
check('rejects a backwards range', parse.parseReply('x\nLINES: 9-2').range === null);
check('rejects line zero', parse.parseReply('x\nLINES: 0').range === null);
check('marker is stripped from prose', parse.parseReply('Ask this.\n\nLINES: 3').prose.indexOf('LINES') === -1);

// --- parse: the fix block ---
const directReply =
  'total is reset each pass.\n\nLINES: 2-4\nFIX:\n```python\n    total = 0\n    for n in nums:\n        total += n\n```';
check('parses a fenced fix', (function () {
  const r = parse.parseReply(directReply);
  return r.fix === '    total = 0\n    for n in nums:\n        total += n';
})());
check('fix reply keeps its prose', parse.parseReply(directReply).prose === 'total is reset each pass.');
check('fix reply keeps its range', (function () {
  const r = parse.parseReply(directReply);
  return r.range.start === 2 && r.range.end === 4;
})());
check('recovers a fix with no fence', (function () {
  const r = parse.parseReply('why\nLINES: 1\nFIX:\nx = 1');
  return r.fix === 'x = 1';
})());
check('no fix means null', parse.parseReply('Just a question?\nLINES: 2').fix === null);

// --- parse: applying a range ---
const sample = 'def average(nums):\n    for n in nums:\n        total = 0\n        total += n\n    return total / len(nums)';
check('applyRange swaps the right lines', (function () {
  const out = parse.applyRange(sample, { start: 2, end: 4 }, '    total = 0\n    for n in nums:\n        total += n');
  return out === 'def average(nums):\n    total = 0\n    for n in nums:\n        total += n\n    return total / len(nums)';
})());
check('applyRange refuses an out-of-bounds range', parse.applyRange(sample, { start: 2, end: 99 }, 'x') === null);
check('applyRange refuses a null range', parse.applyRange(sample, null, 'x') === null);
check('sliceRange returns the original lines', parse.sliceRange(sample, { start: 3, end: 3 }) === '        total = 0');
check('sliceRange refuses out of bounds', parse.sliceRange(sample, { start: 1, end: 99 }) === null);

// The panel normalises to \n but files on disk here are CRLF. Both the parser
// and the range helpers must be indifferent to which one they are handed.
const crlfSample = sample.replace(/\n/g, '\r\n');
check('sliceRange handles CRLF input', parse.sliceRange(crlfSample, { start: 3, end: 3 }) === '        total = 0');
check('applyRange handles CRLF input', (function () {
  const out = parse.applyRange(crlfSample, { start: 3, end: 3 }, '        total = 1');
  return out !== null && out.indexOf('\r') === -1 && out.indexOf('total = 1') !== -1;
})());
check('parseReply handles CRLF input', (function () {
  const r = parse.parseReply('Look here.\r\n\r\nLINES: 2-4\r\nFIX:\r\n```py\r\nx = 1\r\n```');
  return r.range.start === 2 && r.fix === 'x = 1' && r.prose === 'Look here.';
})());

// --- prompt: modes ---
check('three modes exist', Object.keys(prompt.MODES).length === 3);
check('default mode is a real mode', prompt.isMode(prompt.DEFAULT_MODE));
check('unknown mode falls back', prompt.modeOrDefault('nonsense') === prompt.DEFAULT_MODE);
check('hint mode uses the guardrail', prompt.guardrailApplies('hint'));
check('strong mode uses the guardrail', prompt.guardrailApplies('strong'));
check('direct mode does NOT use the guardrail', !prompt.guardrailApplies('direct'));
check('each mode builds a distinct prompt', (function () {
  const a = prompt.buildSystemPrompt('hint');
  const b = prompt.buildSystemPrompt('strong');
  const c = prompt.buildSystemPrompt('direct');
  return a !== b && b !== c && a !== c && a.length > 200;
})());
check('hint mode does NOT highlight', !prompt.highlightApplies('hint'));
check('strong mode highlights', prompt.highlightApplies('strong'));
check('direct mode highlights', prompt.highlightApplies('direct'));
check('unknown mode inherits the default gate', prompt.highlightApplies('nonsense') === prompt.highlightApplies(prompt.DEFAULT_MODE));
check('hint prompt forbids the marker', /Do not use the LINES marker/.test(prompt.buildSystemPrompt('hint')));
check('strong prompt asks for the marker', /LINES: 3/.test(prompt.buildSystemPrompt('strong')));
check('direct prompt asks for a fix block', /FIX:/.test(prompt.buildSystemPrompt('direct')));

// --- prompt: line numbering ---
check('numbers lines from 1', prompt.numberLines('a\nb\nc').split('\n')[0] === '1 | a');
check('pads numbers to equal width', (function () {
  const out = prompt.numberLines(new Array(12).join('x\n') + 'x').split('\n');
  return out[0] === ' 1 | x' && out[9] === '10 | x';
})());
check('first turn includes numbered code', prompt.buildFirstTurn('x = 1\n', 'why?').indexOf('1 | x = 1') !== -1);
check('first turn includes the question', prompt.buildFirstTurn('x = 1', 'why is this wrong?').indexOf('why is this wrong?') !== -1);
check('first turn handles no question', /have not added a question/.test(prompt.buildFirstTurn('x = 1', '')));

// There is no error field any more, so the prompt must never imply we know
// whether the code runs. Asserting that hands the model a false premise and it
// argues with the code instead of reading it.
check('first turn never claims the code runs', (function () {
  const withQ = prompt.buildFirstTurn('x = 1', 'why?');
  const withoutQ = prompt.buildFirstTurn('x = 1', '');
  return !/runs without an error/i.test(withQ) && !/runs without an error/i.test(withoutQ);
})());
check('first turn warns against assuming it runs', (function () {
  const t = prompt.buildFirstTurn('x = 1', 'why?');
  return /Do not assume/.test(t) && /would fail/.test(t);
})());

// --- mock provider ---
(async () => {
  const m0 = await providers.getReply([{ role: 'user', content: 'help' }], { provider: 'mock', mode: 'hint' });
  check('mock hint returns first rung', m0.indexOf('line 3') !== -1);

  const m1 = await providers.getReply(
    [{ role: 'user', content: 'help' }, { role: 'assistant', content: m0 }, { role: 'user', content: 'idk' }],
    { provider: 'mock', mode: 'hint' }
  );
  check('mock escalates on turn 2', m1 !== m0);

  const strong = await providers.getReply([{ role: 'user', content: 'help' }], { provider: 'mock', mode: 'strong' });
  check('mock strong carries a LINES marker', parse.parseReply(strong).range !== null);

  const direct = await providers.getReply([{ role: 'user', content: 'help' }], { provider: 'mock', mode: 'direct' });
  const parsedDirect = parse.parseReply(direct);
  check('mock direct carries a fix', parsedDirect.fix !== null);
  check('mock direct carries a range', parsedDirect.range !== null);
  check('mock direct fix actually repairs the sample', (function () {
    const fixed = parse.applyRange(sample, parsedDirect.range, parsedDirect.fix);
    return fixed !== null && /^\s+total = 0\n\s+for n in nums:/m.test(fixed);
  })());

  const leaked = await providers.getReply([{ role: 'user', content: '/leak' }], { provider: 'mock', mode: 'hint' });
  check('mock /leak produces a leak', guardrail.inspect(parse.parseReply(leaked).prose).blocked);

  // Every hint and strong rung must survive its own filter, or the demo
  // self-blocks. The filter sees prose only, so that is what we inspect.
  for (const mode of ['hint', 'strong']) {
    for (let i = 0; i < 5; i++) {
      const msgs = [{ role: 'user', content: 'help' }];
      for (let j = 0; j < i; j++) msgs.push({ role: 'assistant', content: 'x' }, { role: 'user', content: 'y' });
      const r = await providers.getReply(msgs, { provider: 'mock', mode });
      const g = guardrail.inspect(parse.parseReply(r).prose);
      check('mock ' + mode + ' rung ' + i + ' passes guardrail' + (g.blocked ? ' -> ' + g.reasons.join('; ') : ''), !g.blocked);
    }
  }

  check('unknown provider throws', await providers.getReply([], { provider: 'nope' }).then(() => false, () => true));

  // Configuration mistakes must fail loudly and say which setting is wrong,
  // before any network call is attempted.
  check('openaiCompatible demands a baseUrl', await providers
    .getReply([], { provider: 'openaiCompatible', model: 'x' })
    .then(() => false, (e) => /socraticTutor\.baseUrl/.test(e.message)));
  check('openaiCompatible demands a model', await providers
    .getReply([], { provider: 'openaiCompatible', baseUrl: 'https://example.invalid/v1' })
    .then(() => false, (e) => /socraticTutor\.model/.test(e.message)));
  // With no discovery URL configured, the local provider falls back to
  // localhost and fails as unreachable, not as a configuration error.
  check('local provider needs no key or settings', await providers
    .getReply([{ role: 'user', content: 'hi' }], { provider: 'local' })
    .then(() => false, (e) => /Could not reach http:\/\/127\.0\.0\.1:8008/.test(e.message)));

  // A dead tunnel answers in HTML, and students should not be shown it.
  const CF_530 = '<!doctype html><html lang="en-US"><head><title>notre-x.trycloudflare.com | 530: Origin DNS error</title></head><body>...</body></html>';
  check('a dead tunnel is explained, not dumped', await providers
    .getReply([{ role: 'user', content: 'hi' }], {
      provider: 'openaiCompatible', baseUrl: 'https://example.invalid/v1', model: 'x', apiKey: 'k',
      __testResponse: { status: 530, body: CF_530 }
    })
    .then(() => false, (e) => /offline/.test(e.message) && !/<!doctype/i.test(e.message)));
  check('the explanation says what to do', await providers
    .getReply([{ role: 'user', content: 'hi' }], {
      provider: 'openaiCompatible', baseUrl: 'https://example.invalid/v1', model: 'x', apiKey: 'k',
      __testResponse: { status: 530, body: CF_530 }
    })
    .then(() => false, (e) => /Refresh Endpoint/.test(e.message)));
  check('a genuine JSON error is still passed through', await providers
    .getReply([{ role: 'user', content: 'hi' }], {
      provider: 'openaiCompatible', baseUrl: 'https://example.invalid/v1', model: 'x', apiKey: 'k',
      __testResponse: { status: 404, body: '{"error":{"message":"model not found"}}' }
    })
    .then(() => false, (e) => /model not found/.test(e.message)));

  // --- endpoint discovery: reading the team's current address ---
  const endpoint = require(path + 'endpoint.js');
  check('parses a bare URL', endpoint.parse('https://a.trycloudflare.com/v1') === 'https://a.trycloudflare.com/v1');
  check('ignores comments and blanks', endpoint.parse('# note\n\nhttps://b.example.com\n') === 'https://b.example.com');
  check('parses JSON form', endpoint.parse('{"baseUrl": "https://c.example.com/v1"}') === 'https://c.example.com/v1');
// GitHub's contents API wraps the file base64 in JSON. Reading it that way
// avoids raw.githubusercontent's five-minute CDN cache, which hid freshly
// published addresses and made Refresh Endpoint useless.
check('parses the GitHub contents API shape', (function () {
  const file = '# a note\n\nhttps://api-form.trycloudflare.com/v1\n';
  const body = JSON.stringify({ encoding: 'base64', content: Buffer.from(file).toString('base64') });
  return endpoint.parse(body) === 'https://api-form.trycloudflare.com/v1';
})());
check('ignores a base64 blob with the wrong encoding field', endpoint.parse('{"encoding":"utf-8","content":"aHR0cHM6Ly94LmNvbQ=="}') === null);
check('derives the raw mirror from an API url',
  endpoint.rawFallbackFor('https://api.github.com/repos/H7Feez/elenchus_poc/contents/endpoint.txt') ===
  'https://raw.githubusercontent.com/H7Feez/elenchus_poc/main/endpoint.txt');
check('honours an explicit ref in the mirror',
  endpoint.rawFallbackFor('https://api.github.com/repos/o/r/contents/f.txt?ref=dev') ===
  'https://raw.githubusercontent.com/o/r/dev/f.txt');
check('no mirror for a non-GitHub url', endpoint.rawFallbackFor('https://example.com/endpoint.txt') === null);
  check('empty file yields nothing', endpoint.parse('   \n # only a comment\n') === null);
  check('adds the /v1 suffix when missing', endpoint.normalise('https://d.example.com') === 'https://d.example.com/v1');
  check('keeps an existing /v1', endpoint.normalise('https://d.example.com/v1') === 'https://d.example.com/v1');
  check('strips a trailing slash', endpoint.normalise('https://d.example.com/v1/') === 'https://d.example.com/v1');
  check('rejects a non-URL', endpoint.normalise('not a url') === null);
  check('rejects nothing', endpoint.normalise(null) === null);
  // A dead discovery URL must not throw; it degrades to no address.
  check('unreachable discovery file returns null', await endpoint
    .resolve('https://no-such-host.invalid/endpoint.txt') === null);
  check('unreachable host gives a clear error', await providers
    .getReply([{ role: 'user', content: 'hi' }], {
      provider: 'openaiCompatible',
      baseUrl: 'https://no-such-host.invalid/v1',
      model: 'x',
      apiKey: 'k'
    })
    .then(() => false, (e) => /Could not reach/.test(e.message)));

  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
  process.exit(fails === 0 ? 0 : 1);
})();
