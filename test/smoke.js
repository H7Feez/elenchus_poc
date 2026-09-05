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

// --- mock provider ---
(async () => {
  const opts = { provider: 'mock' };
  const m0 = await providers.getReply([{ role: 'user', content: 'help' }], opts);
  check('mock returns first rung', m0.includes('largest index'));

  const m1 = await providers.getReply(
    [{ role: 'user', content: 'help' }, { role: 'assistant', content: m0 }, { role: 'user', content: 'idk' }],
    opts
  );
  check('mock escalates on turn 2', m1 !== m0);

  const leaked = await providers.getReply([{ role: 'user', content: '/leak' }], opts);
  check('mock /leak produces a leak', guardrail.inspect(leaked).blocked);

  // every mock rung must survive its own filter, or the demo self-blocks
  for (let i = 0; i < 5; i++) {
    const msgs = [{ role: 'user', content: 'help' }];
    for (let j = 0; j < i; j++) msgs.push({ role: 'assistant', content: 'x' }, { role: 'user', content: 'y' });
    const r = await providers.getReply(msgs, opts);
    const g = guardrail.inspect(r);
    check('mock rung ' + i + ' passes guardrail' + (g.blocked ? ' -> ' + g.reasons.join('; ') : ''), !g.blocked);
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
  check('unreachable host gives a clear error', await providers
    .getReply([{ role: 'user', content: 'hi' }], {
      provider: 'openaiCompatible',
      baseUrl: 'https://no-such-host.invalid/v1',
      model: 'x',
      apiKey: 'k'
    })
    .then(() => false, (e) => /Could not reach/.test(e.message)));

  // --- prompt ---
  const t = prompt.buildFirstTurn('x = 1\n', 'IndexError: list index out of range');
  check('first turn includes code', t.includes('x = 1'));
  check('first turn includes error', t.includes('IndexError'));
  check('first turn handles no error', prompt.buildFirstTurn('x = 1', '').includes('without an error'));
  check('system prompt non-empty', prompt.SYSTEM_PROMPT.length > 200);

  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
  process.exit(fails === 0 ? 0 : 1);
})();
