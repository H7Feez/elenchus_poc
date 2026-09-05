'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { getReply, NEEDS_KEY, listLocalModels } = require('./providers');
const promptLib = require('./prompt');
const guardrail = require('./guardrail');
const { parseReply, sliceRange, mineLines, fixProblems } = require('./parse');

const SECRET_KEY = 'socraticTutor.apiKey';
const LAST_MODE_KEY = 'socraticTutor.lastMode';
const HISTORY_LIMIT = 10;

/**
 * How much of the conversation the model sees. The first turn (the code) is
 * always kept; after that only the most recent turns go. A bounded window is
 * the honest version of "limited context": a free-tier model on a long
 * back-and-forth would otherwise degrade or fail outright.
 */
const THREAD_TAIL = 6;

/**
 * The decoration used to point at lines in the editor.
 *
 * Created once at activation, on purpose. VS Code has no public priority knob
 * for decorations; where two types overlap, the one created earlier paints
 * underneath. Registering ours first is the only lever available, so we take it.
 *
 * The shape is deliberately minimal for the same reason: a translucent
 * background and nothing else. No `before`/`after` content, which is the
 * mechanism inline suggestions use, and no overview-ruler mark, so we never
 * compete with anything else for the same pixels.
 */
let highlightType = null;

let panel = null;
let panelReady = false;
const pendingPosts = [];
let extensionContext = null;

let session = newSession();

function newSession() {
  return {
    mode: promptLib.DEFAULT_MODE,
    thread: [],       // model conversation for the current selection
    history: [],      // display log, capped at HISTORY_LIMIT
    anchor: null,     // what we asked about: { uri, range, text, code, modelRange, stale }
    lastFix: null,
    stats: {
      asks: 0,
      byMode: { hint: 0, strong: 0, direct: 0 },
      guardrailFired: 0,
      guardrailBlocked: 0,
      repliesWithoutQuestion: 0,
      fixesApplied: 0,
      fixesRejected: 0,
      routed: { groq: 0, helper: 0, downgraded: 0 },
      reasons: []
    }
  };
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(context) {
  extensionContext = context;

  highlightType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    // Do not grow or shrink when the student edits next to it. A stale
    // highlight that has quietly swallowed new text is worse than none.
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  context.subscriptions.push(highlightType);

  // Start in whichever mode was used last, so the popup's Enter does what the
  // student expects rather than what the settings default says.
  session.mode = promptLib.modeOrDefault(
    context.globalState.get(LAST_MODE_KEY) ||
      vscode.workspace.getConfiguration('socraticTutor').get('defaultMode')
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('socraticTutor.askSelection', () => askSelection(context)),
    vscode.commands.registerCommand('socraticTutor.open', () => openPanel(context)),
    vscode.commands.registerCommand('socraticTutor.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('socraticTutor.clearApiKey', () => clearApiKey(context)),
    vscode.commands.registerCommand('socraticTutor.newSession', () => resetSession()),
    vscode.commands.registerCommand('socraticTutor.showStats', () => showStats()),
    vscode.commands.registerCommand('socraticTutor.testConnection', () => testConnection(context)),
    vscode.commands.registerCommand('socraticTutor.switchBackend', () => switchBackend(context))
  );

  // "The highlights get removed as soon as the code is clicked."
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (Date.now() < suppressClearUntil) return;
      if (session.anchor && e.textEditor.document.uri.toString() === session.anchor.uri) {
        clearHighlight();
      }
    })
  );
}

function deactivate() {}

function setMode(mode) {
  session.mode = promptLib.modeOrDefault(mode);
  if (extensionContext) {
    extensionContext.globalState.update(LAST_MODE_KEY, session.mode);
  }
  postModes();
}

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

/**
 * Applying a decoration can be followed by a selection event as focus returns
 * to the editor, which would clear the highlight before it was ever seen.
 */
let suppressClearUntil = 0;

function editorsFor(uriString) {
  return vscode.window.visibleTextEditors.filter(
    (e) => e.document.uri.toString() === uriString
  );
}

function applyHighlight(uriString, range) {
  const editors = editorsFor(uriString);
  if (!editors.length) return false;
  suppressClearUntil = Date.now() + 400;
  editors.forEach((e) => {
    e.setDecorations(highlightType, [range]);
    e.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });
  post({ type: 'highlightState', active: true });
  return true;
}

function clearHighlight() {
  vscode.window.visibleTextEditors.forEach((e) => e.setDecorations(highlightType, []));
  post({ type: 'highlightState', active: false });
}

/**
 * Puts the highlight back, but only if the code is still the code we asked
 * about. If it has been edited the old range means nothing, and lighting up
 * whatever now sits at those coordinates would be actively misleading.
 *
 * Restores the lines the model pointed at, not the whole selection — that is
 * what "the last highlighted code" means to the student.
 */
async function reHighlight() {
  const a = session.anchor;
  if (!a) {
    post({ type: 'notice', text: 'Nothing has been highlighted yet.' });
    return;
  }
  if (a.stale) {
    post({
      type: 'notice',
      text: 'That code was changed by the fix you applied, so the old highlight no longer applies. Select it again to continue.'
    });
    return;
  }

  let doc;
  try {
    doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(a.uri));
  } catch (_e) {
    post({ type: 'notice', text: 'That file is no longer open.' });
    return;
  }
  await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });

  if (doc.getText(a.range) !== a.text) {
    // It may simply have moved. Accept that only when there is one candidate.
    const whole = doc.getText();
    const at = whole.indexOf(a.text);
    if (at === -1 || at !== whole.lastIndexOf(a.text)) {
      post({
        type: 'notice',
        text: 'That code has changed since you asked, so the old highlight would point at the wrong thing.'
      });
      return;
    }
    a.range = new vscode.Range(doc.positionAt(at), doc.positionAt(at + a.text.length));
  }

  const target = a.modelRange ? modelRangeToDocument(a.modelRange) : a.range;
  applyHighlight(a.uri, target || a.range);
}

// ---------------------------------------------------------------------------
// The selection flow
// ---------------------------------------------------------------------------

async function askSelection(context) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Socratic Tutor: open a file and select some code first.');
    return;
  }
  if (editor.selection.isEmpty) {
    vscode.window.showWarningMessage('Socratic Tutor: select the code you are stuck on first.');
    return;
  }

  // Snap to whole lines. Everything downstream — the numbering the model sees,
  // the highlight, the fix that gets written back — works in whole lines, so a
  // selection that starts mid-line would silently disagree with all of it.
  // Dragging down the gutter also leaves the end at column 0 of the NEXT line,
  // which would count one line too many.
  const doc = editor.document;
  let endLine = editor.selection.end.line;
  if (editor.selection.end.character === 0 && endLine > editor.selection.start.line) {
    endLine -= 1;
  }
  const selection = new vscode.Range(
    editor.selection.start.line, 0,
    endLine, doc.lineAt(endLine).range.end.character
  );

  const raw = doc.getText(selection);
  const code = raw.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (!code.trim()) {
    vscode.window.showWarningMessage('Socratic Tutor: the selection is empty.');
    return;
  }

  const asked = await askForContext();
  if (!asked) return; // dismissed

  setMode(asked.mode);
  session.thread = [];
  session.lastFix = null;
  session.anchor = {
    uri: doc.uri.toString(),
    range: selection,
    text: raw,         // exact document text, for "has it changed" checks
    code,              // normalised, what the model and the panel see
    modelRange: null,  // the lines the model last pointed at, 1-based
    stale: false
  };

  openPanel(context);
  await run(context, { code, context: asked.context, firstTurn: true });
}

/**
 * One popup: type a question (or nothing), then pick how much help you want.
 *
 * This is a QuickPick rather than an input box with title-bar buttons. The
 * buttons never reliably rendered, and rows have two other advantages: they
 * carry a label and a description, so the choice explains itself, and they
 * cannot fail to appear. `alwaysShow` keeps all three visible while the
 * student types, instead of being filtered away by their own question.
 *
 * Enter picks the highlighted row. The mode used last time is placed first and
 * kept active as the student types, so Enter stays predictable.
 */
function askForContext() {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();

    const order = [session.mode].concat(
      Object.keys(promptLib.MODES).filter((id) => id !== session.mode)
    );
    const items = order.map((id) => ({
      modeId: id,
      label: '$(' + MODE_ICONS[id] + ') ' + promptLib.MODES[id].label,
      description: promptLib.MODES[id].note,
      alwaysShow: true
    }));

    qp.title = 'Ask Socratic Tutor';
    qp.placeholder = 'Type a question or some context — or leave this empty and just pick a row';
    qp.items = items;
    qp.activeItems = [items[0]];
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;
    qp.ignoreFocusOut = true;

    // Typing changes the fuzzy match, which can move the active row. Pin it
    // back so Enter always means "the row that was highlighted a moment ago".
    let pinned = items[0];
    qp.onDidChangeValue(() => {
      if (!qp.activeItems.length || qp.activeItems[0] !== pinned) {
        qp.activeItems = [pinned];
      }
    });
    qp.onDidChangeActive((active) => {
      if (active.length && active[0] !== pinned && qp.value === '') {
        pinned = active[0];
      }
    });

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      qp.hide();
    };

    qp.onDidAccept(() => {
      const item = qp.selectedItems[0] || qp.activeItems[0] || pinned;
      finish({ context: qp.value.trim(), mode: item.modeId });
    });
    qp.onDidHide(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
      qp.dispose();
    });

    qp.show();
  });
}

const MODE_ICONS = {
  hint: 'lightbulb',
  strong: 'search',
  direct: 'wrench'
};

// ---------------------------------------------------------------------------
// Switching backends
// ---------------------------------------------------------------------------

/**
 * The backends worth one click.
 *
 * Comparing the team's model against a hosted one is not a one-off — it is the
 * evaluation. Doing it by hand-editing three settings invites collecting
 * results under a configuration nobody can reconstruct afterwards, so each
 * preset sets all three together.
 *
 * baseUrl is emptied deliberately on the local presets: left set, it pins the
 * extension to one tunnel address and it silently stops following endpoint.txt.
 */
const BACKENDS = [
  {
    id: 'elenchus',
    label: '$(mortar-board) Your model',
    detail: "The team's fine-tuned Socratic tutor, wherever endpoint.txt currently points",
    settings: { provider: 'local', baseUrl: '', model: 'elenchus' }
  },
  {
    id: 'elenchus-base',
    label: '$(circle-slash) Untrained base model',
    detail: 'The same model with the training switched off — the before, for a before-and-after',
    settings: { provider: 'local', baseUrl: '', model: 'elenchus-base' }
  },
  {
    id: 'groq',
    label: '$(cloud) Groq — Qwen 27B',
    detail: 'A large hosted model, for comparison. Needs an API key.',
    settings: {
      provider: 'openaiCompatible',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'qwen/qwen3.8-27b'
    },
    needsKey: true
  },
  {
    id: 'mock',
    label: '$(debug-disconnect) Mock — offline',
    detail: 'Canned replies from a fixed script. No network, no key, no cost.',
    settings: { provider: 'mock', baseUrl: '', model: '' }
  }
];

function currentBackendId() {
  const cfg = vscode.workspace.getConfiguration('socraticTutor');
  const provider = cfg.get('provider');
  const model = cfg.get('model');
  const found = BACKENDS.find(
    (b) => b.settings.provider === provider &&
           (!b.settings.model || b.settings.model === model)
  );
  return found ? found.id : null;
}

async function switchBackend(context) {
  const active = currentBackendId();

  const picked = await vscode.window.showQuickPick(
    BACKENDS.map((b) => ({
      backend: b,
      label: b.label,
      description: b.id === active ? 'current' : undefined,
      detail: b.detail
    })),
    { title: 'Which model should answer?', placeHolder: 'Pick a backend' }
  );
  if (!picked) return;

  const b = picked.backend;
  const cfg = vscode.workspace.getConfiguration('socraticTutor');
  for (const [key, value] of Object.entries(b.settings)) {
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
  }

  if (b.needsKey && !(await context.secrets.get(SECRET_KEY))) {
    const pick = await vscode.window.showWarningMessage(
      `Socratic Tutor: ${b.id} needs an API key, and none is stored.`,
      'Set API Key'
    );
    if (pick === 'Set API Key') {
      await setApiKey(context);
    }
  }

  postModelLabel();
  vscode.window.showInformationMessage(
    'Socratic Tutor: now answering with ' + b.label.replace(/\$\([^)]*\)\s*/, '') + '.'
  );
}

// ---------------------------------------------------------------------------
// Asking the model
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Routing by capability
// ---------------------------------------------------------------------------

const FINE_TUNED_MODEL = 'elenchus';
const HELPER_MODEL = 'elenchus-helper';

function isFineTuned(model) {
  return !model || model === FINE_TUNED_MODEL;
}

/**
 * Follow-ups that ask for an explanation rather than offer an answer. The
 * fine-tuned model learned from tutors who almost never explain, only ask, so
 * it answers "what does split() do?" with "what does counts.get() do?". A
 * model that can explain should take those turns.
 */
const CONCEPT_RE =
  /\b(what (is|are|does|do|did|would|will)|what'?s|how (does|do|is|are|did)|why (does|do|is|are|did)|explain|mean(s|ing)?\b|i (don'?t|do not|dont) (understand|get|follow|see)|confus|not sure (what|how|why))/i;

function looksLikeConceptQuestion(text) {
  return CONCEPT_RE.test(String(text || ''));
}

/**
 * The small fine-tuned model is genuinely good at one thing: Socratic
 * questioning in Hint mode. It cannot emit the line markers Strong hint
 * needs, cannot produce a fix, and deflects concept questions. Rather than
 * let those requests silently degrade, send them to something that can:
 * Groq when a key is stored, else the server's larger untrained helper
 * model, else run as Hint and say so on the reply.
 */
async function chooseRoute(context, s, opts, req) {
  const asIs = {
    opts,
    prompt: systemPromptFor(s.mode, opts.provider, opts.model),
    mode: s.mode,
    via: null
  };

  const routing = vscode.workspace.getConfiguration('socraticTutor').get('helperRouting');
  const smallLocal = opts.provider === 'local' && isFineTuned(opts.model);
  if (!routing || !smallLocal) return asIs;

  const needsHelp =
    s.mode !== 'hint' || (!req.firstTurn && looksLikeConceptQuestion(req.context));
  if (!needsHelp) return asIs;

  const apiKey = await context.secrets.get(SECRET_KEY);
  if (apiKey) {
    const groq = BACKENDS.find((b) => b.id === 'groq').settings;
    return {
      opts: { ...opts, provider: groq.provider, baseUrl: groq.baseUrl, model: groq.model, apiKey },
      prompt: promptLib.buildSystemPrompt(s.mode),
      mode: s.mode,
      via: 'groq'
    };
  }

  const available = await listLocalModels(opts);
  if (available.has(HELPER_MODEL)) {
    return {
      opts: { ...opts, model: HELPER_MODEL },
      prompt: promptLib.buildSystemPrompt(s.mode),
      mode: s.mode,
      via: 'helper'
    };
  }

  // Nowhere to send it. A concept question can still go to the small model;
  // a mode it cannot do becomes Hint, labelled as such.
  if (s.mode === 'hint') return asIs;
  return {
    opts,
    prompt: systemPromptFor('hint', opts.provider, opts.model),
    mode: 'hint',
    via: 'downgraded'
  };
}

async function run(context, req) {
  const s = session; // so a Clear History mid-request cannot leak into the new one
  const cfg = vscode.workspace.getConfiguration('socraticTutor');
  const provider = cfg.get('provider');

  const userText = req.firstTurn
    ? promptLib.buildFirstTurn(req.code, req.context)
    : req.context;

  s.thread.push({ role: 'user', content: userText });
  trimThread(s);
  s.stats.asks += 1;
  s.stats.byMode[s.mode] += 1;

  const entry = {
    id: 'e' + Date.now() + Math.random().toString(36).slice(2, 6),
    mode: s.mode,
    modeLabel: promptLib.MODES[s.mode].label,
    code: req.firstTurn ? req.code : null,
    startLine: req.firstTurn && s.anchor ? s.anchor.range.start.line + 1 : null,
    question: req.context || '',
    response: null,
    flag: null,
    via: null,
    fix: null,
    fixRejected: null
  };
  pushHistory(s, entry);
  post({ type: 'entry', entry });

  const apiKey = await context.secrets.get(SECRET_KEY);
  if (NEEDS_KEY.has(provider) && !apiKey) {
    entry.response = 'No API key set. Run "Socratic Tutor: Set API Key".';
    entry.flag = 'error';
    post({ type: 'resolve', id: entry.id, entry, instant: true });
    return;
  }

  const opts = {
    provider,
    baseUrl: cfg.get('baseUrl'),
    endpointUrl: cfg.get('endpointUrl'),
    model: cfg.get('model'),
    temperature: cfg.get('temperature'),
    mode: s.mode,
    apiKey,
    log
  };

  post({ type: 'busy', value: true });
  try {
    const route = await chooseRoute(context, s, opts, req);
    entry.via = route.via;
    if (route.via) {
      s.stats.routed[route.via] += 1;
      log('routed ' + s.mode + ' request: ' + route.via);
    }

    const reply = await askWithGuardrail(s, route);
    if (s !== session) return; // history was cleared while we waited

    s.thread.push({ role: 'assistant', content: reply.raw });

    entry.response = reply.text;
    entry.flag = reply.flag;

    if (reply.fix && reply.range && s.anchor && !s.anchor.stale) {
      const problems = fixProblems(s.anchor.code, reply.range, reply.fix);
      if (problems.length) {
        s.stats.fixesRejected += 1;
        entry.fixRejected = problems;
        log('fix rejected: ' + problems.join('; '));
        if (!entry.response || entry.response === "Here's the fix.") {
          entry.response =
            'The model offered a fix that did not hold up: ' + problems[0] +
            '. Ask again, or switch to a larger model.';
        }
      } else {
        s.lastFix = { range: reply.range, replacement: reply.fix };
        entry.fix = { range: reply.range, code: reply.fix };
      }
    }

    if (reply.range && s.anchor && !s.anchor.stale) {
      s.anchor.modelRange = reply.range;
      highlightModelRange(reply.range);
    }

    post({ type: 'resolve', id: entry.id, entry });
  } catch (err) {
    if (s !== session) return;
    entry.response = String(err && err.message ? err.message : err);
    entry.flag = 'error';
    post({ type: 'resolve', id: entry.id, entry, instant: true });
  } finally {
    post({ type: 'busy', value: false });
  }
}

/**
 * Keeps the first user turn (the code) and the most recent turns. The tail is
 * cut at an assistant turn so the model never sees two user messages in a row,
 * which some providers reject.
 */
function trimThread(s) {
  if (s.thread.length <= THREAD_TAIL + 1) return;
  let tail = s.thread.slice(-THREAD_TAIL);
  if (tail[0].role === 'user' && s.thread.length > THREAD_TAIL + 1) {
    tail = s.thread.slice(-(THREAD_TAIL + 1));
  }
  s.thread = [s.thread[0]].concat(tail);
}

/** Maps a 1-based line range inside the selection onto the document. */
function modelRangeToDocument(range) {
  const a = session.anchor;
  if (!a || !range) return null;
  const base = a.range.start.line;
  const startLine = base + range.start - 1;
  const endLine = base + range.end - 1;
  if (endLine > a.range.end.line) return null;
  return new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER);
}

function highlightModelRange(range) {
  const docRange = modelRangeToDocument(range);
  if (!docRange) return;
  applyHighlight(session.anchor.uri, docRange);
}

async function askWithGuardrail(s, route) {
  const cfg = vscode.workspace.getConfiguration('socraticTutor');
  const mode = route.mode;
  const opts = route.opts;
  const enabled = cfg.get('guardrailEnabled') && promptLib.guardrailApplies(mode);
  const mayHighlight = promptLib.highlightApplies(mode);

  // When the marker is missing, a "look at line 4" in the prose is the next
  // best thing. Hint mode still never highlights: that is enforced by mode.
  const rangeOf = (p) => (mayHighlight ? p.range || mineLines(p.prose) : null);

  const base = [{ role: 'system', content: route.prompt }].concat(s.thread);

  const first = await getReply(base, opts);
  const parsedFirst = parseReply(first);

  if (!enabled) {
    return {
      raw: first,
      // A reply that is nothing but a fix block still needs a sentence in front.
      text: parsedFirst.prose || (parsedFirst.fix ? "Here's the fix." : first),
      range: rangeOf(parsedFirst),
      fix: parsedFirst.fix,
      flag: null
    };
  }

  const check = guardrail.inspect(parsedFirst.prose);
  if (!check.blocked) {
    if (!guardrail.hasQuestion(parsedFirst.prose)) s.stats.repliesWithoutQuestion += 1;
    return {
      raw: first,
      text: parsedFirst.prose,
      range: rangeOf(parsedFirst),
      fix: null,
      flag: null
    };
  }

  s.stats.guardrailFired += 1;
  s.stats.reasons.push.apply(s.stats.reasons, check.reasons.map((r) => mode + ': ' + r));
  log('guardrail fired (' + mode + '): ' + check.reasons.join('; '));

  const second = await getReply(
    base.concat([
      { role: 'assistant', content: first },
      { role: 'user', content: promptLib.REWRITE_INSTRUCTION }
    ]),
    opts
  );
  const parsedSecond = parseReply(second);
  const recheck = guardrail.inspect(parsedSecond.prose);

  if (!recheck.blocked) {
    return {
      raw: second,
      text: parsedSecond.prose,
      range: rangeOf(parsedSecond),
      fix: null,
      flag: 'rewritten'
    };
  }

  s.stats.guardrailBlocked += 1;
  s.stats.reasons.push.apply(
    s.stats.reasons,
    recheck.reasons.map((r) => mode + ' on rewrite: ' + r)
  );
  log('guardrail blocked after rewrite (' + mode + '): ' + recheck.reasons.join('; '));
  return {
    raw: promptLib.BLOCKED_MESSAGE,
    text: promptLib.BLOCKED_MESSAGE,
    range: null,
    fix: null,
    flag: 'blocked'
  };
}

/**
 * The long prompt in prompt.js is for models that were never trained on this
 * task — it has to carry the whole behaviour. The team's fine-tuned model was
 * trained WITH the short prompts in model/compact_prompt*.txt, so those are
 * what it gets: the behaviour is in its weights now, and a prompt it never saw
 * in training would only confuse a 0.5B model. The same files feed training,
 * so the two cannot drift apart.
 *
 * Only the fine-tuned model gets a compact prompt. The untrained base and the
 * helper model have no training to lean on, so they get the full one.
 */
const compactPromptCache = new Map();
function compactPrompt(file) {
  if (!compactPromptCache.has(file)) {
    let text = null;
    try {
      text = fs.readFileSync(path.join(extensionContext.extensionPath, 'model', file), 'utf8').trim() || null;
    } catch (_e) {
      text = null;
    }
    compactPromptCache.set(file, text);
  }
  return compactPromptCache.get(file);
}

function systemPromptFor(mode, provider, model) {
  if (provider !== 'local' || !isFineTuned(model)) return promptLib.buildSystemPrompt(mode);
  const file = mode === 'strong' ? 'compact_prompt_strong.txt' : 'compact_prompt.txt';
  return compactPrompt(file) || promptLib.buildSystemPrompt(mode);
}

function pushHistory(s, entry) {
  s.history.push(entry);
  while (s.history.length > HISTORY_LIMIT) {
    s.history.shift();
  }
}

// ---------------------------------------------------------------------------
// Applying a fix
// ---------------------------------------------------------------------------

/**
 * We know the exact document and range the student selected, so the fix goes
 * back where it came from. It still verifies the text has not changed
 * underneath it first.
 *
 * Afterwards the anchor is marked stale rather than dropped: the conversation
 * can continue ("why did that work?"), but highlighting and a second fix are
 * off until the student selects again, because the line numbers the model was
 * given no longer describe the file.
 */
async function applyFixToEditor() {
  const fix = session.lastFix;
  const a = session.anchor;
  if (!fix || !a || a.stale) {
    post({ type: 'notice', text: 'There is no fix to apply.' });
    return;
  }

  const expected = sliceRange(a.code, fix.range);
  const docRange = modelRangeToDocument(fix.range);
  if (expected === null || !docRange) {
    post({ type: 'notice', text: 'The suggested lines fall outside the code you selected.' });
    return;
  }

  let doc;
  try {
    doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(a.uri));
  } catch (_e) {
    post({ type: 'notice', text: 'That file is no longer open.' });
    return;
  }

  const clamped = doc.validateRange(docRange);
  const current = doc.getText(clamped).replace(/\r\n?/g, '\n');
  if (current.trim() !== expected.trim()) {
    post({
      type: 'notice',
      text: 'Those lines have changed since you asked, so the fix was not applied. Use Copy instead.'
    });
    return;
  }

  const crlf = doc.eol === vscode.EndOfLine.CRLF;
  const replacement = crlf
    ? fix.replacement.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n')
    : fix.replacement;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, clamped, replacement);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    post({ type: 'notice', text: 'VS Code refused the edit. The file may be read-only.' });
    return;
  }

  session.stats.fixesApplied += 1;
  session.lastFix = null;
  a.stale = true;
  clearHighlight();
  post({ type: 'fixApplied' });
  vscode.window.showInformationMessage('Socratic Tutor: fix applied. Undo with Ctrl+Z.');
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function openPanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside, true);
    return;
  }

  panelReady = false;
  panel = vscode.window.createWebviewPanel(
    'socraticTutor',
    'Socratic Tutor',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
    }
  );

  panel.webview.html = renderHtml(context, panel.webview);

  panel.onDidDispose(
    () => {
      panel = null;
      panelReady = false;
      pendingPosts.length = 0;
    },
    null,
    context.subscriptions
  );

  panel.webview.onDidReceiveMessage(
    (msg) => handleMessage(context, msg),
    null,
    context.subscriptions
  );
}

function renderHtml(context, webview) {
  const mediaPath = (file) =>
    webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', file)));

  const html = fs.readFileSync(path.join(context.extensionPath, 'media', 'panel.html'), 'utf8');
  const nonce = String(Math.random()).slice(2) + String(Date.now());

  return html
    .replace(/\{\{cspSource\}\}/g, webview.cspSource)
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{styleUri\}\}/g, mediaPath('panel.css').toString())
    .replace(/\{\{scriptUri\}\}/g, mediaPath('panel.js').toString());
}

/**
 * The panel is opened at the moment a question is asked, so the first few
 * messages routinely arrive before the webview has finished loading. Queue
 * until it says it is ready, or the opening exchange vanishes.
 */
function post(message) {
  if (!panel) return;
  if (!panelReady) {
    pendingPosts.push(message);
    return;
  }
  panel.webview.postMessage(message);
}

/**
 * On ready, `init` already carries the full history, so any queued `entry`
 * for something in that history would render it a second time. Drop those;
 * keep everything else (the `resolve` that fills it in, busy state, notices).
 */
function flushPosts() {
  const known = new Set(session.history.map((e) => e.id));
  while (pendingPosts.length) {
    const m = pendingPosts.shift();
    if (m.type === 'entry' && known.has(m.entry.id)) continue;
    panel.webview.postMessage(m);
  }
}

function postModelLabel() {
  const cfg = vscode.workspace.getConfiguration('socraticTutor');
  const provider = cfg.get('provider');
  const model = cfg.get('model');
  post({
    type: 'model',
    text: provider === 'mock' ? 'mock (offline)' : provider + (model ? ' · ' + model : '')
  });
}

function postModes() {
  post({
    type: 'modes',
    modes: Object.keys(promptLib.MODES).map((id) => ({
      id,
      label: promptLib.MODES[id].label,
      note: promptLib.MODES[id].note
    })),
    active: session.mode
  });
}

function initPayload() {
  return {
    type: 'init',
    history: session.history,
    typewriter: vscode.workspace.getConfiguration('socraticTutor').get('typewriter'),
    limit: HISTORY_LIMIT
  };
}

async function handleMessage(context, msg) {
  switch (msg.type) {
    case 'ready':
      panelReady = true;
      panel.webview.postMessage(initPayload());
      flushPosts();
      postModes();
      postModelLabel();
      break;
    case 'reply':
      if (!session.anchor) {
        post({ type: 'notice', text: 'Select some code and ask a question to start.' });
        return;
      }
      await run(context, { context: msg.text, firstTurn: false });
      break;
    case 'setMode':
      setMode(msg.mode);
      break;
    case 'reHighlight':
      await reHighlight();
      break;
    case 'applyFix':
      await applyFixToEditor();
      break;
    case 'newSession':
      resetSession();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function setApiKey(context) {
  const value = await vscode.window.showInputBox({
    prompt: 'API key for the model provider',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'Stored in the OS credential vault, never in settings or the repo.'
  });
  if (value === undefined) return;
  await context.secrets.store(SECRET_KEY, value.trim());

  const cfg = vscode.workspace.getConfiguration('socraticTutor');
  if (cfg.get('provider') === 'mock') {
    const pick = await vscode.window.showWarningMessage(
      'Socratic Tutor: key saved, but the provider is still "mock", so replies stay offline and canned. ' +
        'Set socraticTutor.provider, baseUrl and model to use it.',
      'Open Settings'
    );
    if (pick === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'socraticTutor');
    }
    return;
  }

  vscode.window.showInformationMessage('Socratic Tutor: API key saved.');
}

async function clearApiKey(context) {
  await context.secrets.delete(SECRET_KEY);
  vscode.window.showInformationMessage('Socratic Tutor: API key cleared.');
}

async function testConnection(context) {
  const cfg = vscode.workspace.getConfiguration('socraticTutor');
  const provider = cfg.get('provider');

  if (provider === 'mock') {
    const pick = await vscode.window.showWarningMessage(
      'Socratic Tutor: the provider is "mock", which answers offline from a canned script. ' +
        'There is no connection to test.',
      'Open Settings'
    );
    if (pick === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'socraticTutor');
    }
    return;
  }

  const opts = {
    provider,
    baseUrl: cfg.get('baseUrl'),
    endpointUrl: cfg.get('endpointUrl'),
    model: cfg.get('model'),
    temperature: cfg.get('temperature'),
    mode: session.mode,
    apiKey: await context.secrets.get(SECRET_KEY),
    log
  };

  if (NEEDS_KEY.has(provider) && !opts.apiKey) {
    vscode.window.showWarningMessage(
      'Socratic Tutor: no API key stored. Run "Socratic Tutor: Set API Key" first.'
    );
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Socratic Tutor: testing connection…'
    },
    async () => {
      try {
        const reply = await getReply(
          [{ role: 'user', content: 'Reply with the single word: ready' }],
          opts
        );
        log('connection test OK: ' + reply.replace(/\s+/g, ' ').slice(0, 120));
        vscode.window.showInformationMessage(
          'Socratic Tutor: ' + provider + ' answered — "' + reply.replace(/\s+/g, ' ').slice(0, 60) + '"'
        );
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        log('connection test FAILED: ' + message);
        vscode.window.showErrorMessage('Socratic Tutor: ' + message, 'Show Log').then((pick) => {
          if (pick === 'Show Log') channel().show(true);
        });
      }
    }
  );
}

function resetSession() {
  const keepMode = session.mode;
  clearHighlight();
  session = newSession();
  session.mode = keepMode;
  post(initPayload());
  postModes();
  postModelLabel();
}

function showStats() {
  const s = session.stats;
  const lines = [
    'Student turns:            ' + s.asks,
    '  in hint mode:           ' + s.byMode.hint,
    '  in strong hint mode:    ' + s.byMode.strong,
    '  in direct answer mode:  ' + s.byMode.direct,
    'Guardrail fired:          ' + s.guardrailFired,
    'Blocked after rewrite:    ' + s.guardrailBlocked,
    'Replies with no question: ' + s.repliesWithoutQuestion,
    'Fixes applied to editor:  ' + s.fixesApplied,
    'Fixes rejected as bad:    ' + s.fixesRejected,
    'Routed to Groq:           ' + s.routed.groq,
    'Routed to helper model:   ' + s.routed.helper,
    'Downgraded to Hint:       ' + s.routed.downgraded,
    '',
    'Reasons:'
  ].concat(s.reasons.length ? s.reasons.map((r) => '  - ' + r) : ['  (none)']);

  const ch = channel();
  ch.appendLine('');
  ch.appendLine('=== Session stats ===');
  lines.forEach((l) => ch.appendLine(l));
  ch.show(true);
}

let _channel = null;
function channel() {
  if (!_channel) _channel = vscode.window.createOutputChannel('Socratic Tutor');
  return _channel;
}
function log(text) {
  channel().appendLine('[' + new Date().toISOString() + '] ' + text);
}

module.exports = { activate, deactivate, trimThread, BACKENDS, looksLikeConceptQuestion, THREAD_TAIL, chooseRoute, systemPromptFor };
