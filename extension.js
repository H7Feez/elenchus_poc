'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { getReply, NEEDS_KEY } = require('./providers');
const promptLib = require('./prompt');
const guardrail = require('./guardrail');
const { parseReply, sliceRange } = require('./parse');

const SECRET_KEY = 'socraticTutor.apiKey';
const HISTORY_LIMIT = 10;

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

let session = newSession();

function newSession() {
  return {
    mode: promptLib.DEFAULT_MODE,
    thread: [],       // model conversation for the current selection
    history: [],      // display log, capped at HISTORY_LIMIT
    anchor: null,     // { uri, range, text, code } — what we last highlighted
    lastFix: null,
    stats: {
      asks: 0,
      byMode: { hint: 0, strong: 0, direct: 0 },
      guardrailFired: 0,
      guardrailBlocked: 0,
      repliesWithoutQuestion: 0,
      fixesApplied: 0,
      reasons: []
    }
  };
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(context) {
  highlightType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    // Do not grow or shrink when the student edits next to it. A stale
    // highlight that has quietly swallowed new text is worse than none.
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  context.subscriptions.push(highlightType);

  context.subscriptions.push(
    vscode.commands.registerCommand('socraticTutor.askSelection', () => askSelection(context)),
    vscode.commands.registerCommand('socraticTutor.open', () => openPanel(context)),
    vscode.commands.registerCommand('socraticTutor.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('socraticTutor.clearApiKey', () => clearApiKey(context)),
    vscode.commands.registerCommand('socraticTutor.newSession', () => resetSession()),
    vscode.commands.registerCommand('socraticTutor.showStats', () => showStats()),
    vscode.commands.registerCommand('socraticTutor.testConnection', () => testConnection(context))
  );

  // "The highlights get removed as soon as the code is clicked."
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (Date.now() < suppressClearUntil) return;
      if (e.textEditor.document.uri.toString() === (session.anchor && session.anchor.uri)) {
        clearHighlight();
      }
    })
  );
}

function deactivate() {}

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
 */
async function reHighlight() {
  const a = session.anchor;
  if (!a) {
    post({ type: 'notice', text: 'Nothing has been highlighted yet.' });
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

  if (doc.getText(a.range) === a.text) {
    applyHighlight(a.uri, a.range);
    return;
  }

  // It may simply have moved. Accept that only when there is one candidate.
  const whole = doc.getText();
  const at = whole.indexOf(a.text);
  if (at !== -1 && at === whole.lastIndexOf(a.text)) {
    const moved = new vscode.Range(doc.positionAt(at), doc.positionAt(at + a.text.length));
    session.anchor.range = moved;
    applyHighlight(a.uri, moved);
    return;
  }

  post({
    type: 'notice',
    text: 'That code has changed since you asked, so the old highlight would point at the wrong thing.'
  });
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

  const selection = new vscode.Range(editor.selection.start, editor.selection.end);
  const code = editor.document.getText(selection);

  const asked = await askForContext();
  if (!asked) return; // dismissed

  session.mode = asked.mode;
  session.thread = [];
  session.lastFix = null;
  session.anchor = {
    uri: editor.document.uri.toString(),
    range: selection,
    text: code,
    code
  };

  openPanel(context);
  await run(context, {
    code,
    context: asked.context,
    firstTurn: true
  });
}

/**
 * One popup: a text field for the question, and three buttons for the modes.
 *
 * VS Code has no widget that is literally a box with buttons inside it. This
 * is the closest real thing — the QuickInput title-bar buttons — and it keeps
 * the whole interaction to a single popup as intended. Enter submits with
 * whichever mode was last used, which is named in the prompt line.
 */
function askForContext() {
  return new Promise((resolve) => {
    const input = vscode.window.createInputBox();

    const buttons = Object.keys(promptLib.MODES).map((id) => ({
      modeId: id,
      iconPath: new vscode.ThemeIcon(MODE_ICONS[id]),
      tooltip: promptLib.MODES[id].label + ' — ' + promptLib.MODES[id].note
    }));

    input.title = 'Ask Socratic Tutor';
    input.placeholder = 'Add a question or context, or leave empty';
    input.prompt =
      'Enter uses ' + promptLib.MODES[session.mode].label + '. The buttons choose a mode.';
    input.buttons = buttons;
    input.ignoreFocusOut = true;

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      input.hide();
    };

    input.onDidTriggerButton((b) => finish({ context: input.value.trim(), mode: b.modeId }));
    input.onDidAccept(() => finish({ context: input.value.trim(), mode: session.mode }));
    input.onDidHide(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
      input.dispose();
    });

    input.show();
  });
}

const MODE_ICONS = {
  hint: 'lightbulb',
  strong: 'search',
  direct: 'wrench'
};

// ---------------------------------------------------------------------------
// Asking the model
// ---------------------------------------------------------------------------

async function run(context, req) {
  const cfg = vscode.workspace.getConfiguration('socraticTutor');
  const provider = cfg.get('provider');

  const userText = req.firstTurn
    ? promptLib.buildFirstTurn(req.code, req.context)
    : req.context;

  session.thread.push({ role: 'user', content: userText });
  session.stats.asks += 1;
  session.stats.byMode[session.mode] += 1;

  const entry = {
    id: 'e' + Date.now() + Math.random().toString(36).slice(2, 6),
    mode: session.mode,
    modeLabel: promptLib.MODES[session.mode].label,
    code: req.firstTurn ? req.code : null,
    startLine: req.firstTurn && session.anchor ? session.anchor.range.start.line + 1 : null,
    question: req.context || '',
    response: null,
    flag: null,
    fix: null
  };
  pushHistory(entry);
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
    model: cfg.get('model'),
    temperature: cfg.get('temperature'),
    mode: session.mode,
    apiKey
  };

  post({ type: 'busy', value: true });
  try {
    const reply = await askWithGuardrail(opts);
    session.thread.push({ role: 'assistant', content: reply.raw });

    entry.response = reply.text;
    entry.flag = reply.flag;

    if (reply.fix && reply.range) {
      session.lastFix = { range: reply.range, replacement: reply.fix };
      entry.fix = { range: reply.range, code: reply.fix };
    }

    if (reply.range && session.anchor) {
      highlightModelRange(reply.range);
    }

    post({ type: 'resolve', id: entry.id, entry });
  } catch (err) {
    entry.response = String(err && err.message ? err.message : err);
    entry.flag = 'error';
    post({ type: 'resolve', id: entry.id, entry, instant: true });
  } finally {
    post({ type: 'busy', value: false });
  }
}

/** Maps a 1-based line range inside the selection onto the document. */
function modelRangeToDocument(range) {
  const a = session.anchor;
  if (!a) return null;
  const base = a.range.start.line;
  const startLine = base + range.start - 1;
  const endLine = base + range.end - 1;
  if (startLine < a.range.start.line || endLine > a.range.end.line) return null;
  return new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER);
}

function highlightModelRange(range) {
  const docRange = modelRangeToDocument(range);
  if (!docRange) return;
  session.anchor.highlighted = docRange;
  applyHighlight(session.anchor.uri, docRange);
}

async function askWithGuardrail(opts) {
  const cfg = vscode.workspace.getConfiguration('socraticTutor');
  const enabled = cfg.get('guardrailEnabled') && promptLib.guardrailApplies(session.mode);

  const base = [{ role: 'system', content: promptLib.buildSystemPrompt(session.mode) }]
    .concat(session.thread);

  const first = await getReply(base, opts);
  const parsedFirst = parseReply(first);
  const mayHighlight = promptLib.highlightApplies(session.mode);

  if (!enabled) {
    return {
      raw: first,
      text: parsedFirst.prose || first,
      range: mayHighlight ? parsedFirst.range : null,
      fix: parsedFirst.fix,
      flag: null
    };
  }

  const check = guardrail.inspect(parsedFirst.prose);
  if (!check.blocked) {
    if (!guardrail.hasQuestion(parsedFirst.prose)) session.stats.repliesWithoutQuestion += 1;
    return {
      raw: first,
      text: parsedFirst.prose,
      range: mayHighlight ? parsedFirst.range : null,
      fix: null,
      flag: null
    };
  }

  session.stats.guardrailFired += 1;
  session.stats.reasons.push.apply(
    session.stats.reasons,
    check.reasons.map((r) => session.mode + ': ' + r)
  );
  log('guardrail fired (' + session.mode + '): ' + check.reasons.join('; '));

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
      range: mayHighlight ? parsedSecond.range : null,
      fix: null,
      flag: 'rewritten'
    };
  }

  session.stats.guardrailBlocked += 1;
  session.stats.reasons.push.apply(
    session.stats.reasons,
    recheck.reasons.map((r) => session.mode + ' on rewrite: ' + r)
  );
  log('guardrail blocked after rewrite (' + session.mode + '): ' + recheck.reasons.join('; '));
  return {
    raw: promptLib.BLOCKED_MESSAGE,
    text: promptLib.BLOCKED_MESSAGE,
    range: null,
    fix: null,
    flag: 'blocked'
  };
}

function pushHistory(entry) {
  session.history.push(entry);
  while (session.history.length > HISTORY_LIMIT) {
    session.history.shift();
  }
}

// ---------------------------------------------------------------------------
// Applying a fix
// ---------------------------------------------------------------------------

/**
 * Much more certain than it used to be: we know the exact document and range
 * the student selected, so the fix goes back where it came from. It still
 * verifies the text has not changed underneath it first.
 */
async function applyFixToEditor() {
  const fix = session.lastFix;
  const a = session.anchor;
  if (!fix || !a) {
    post({ type: 'notice', text: 'There is no fix to apply.' });
    return;
  }

  const expected = sliceRange(a.code, fix.range);
  if (expected === null) {
    post({ type: 'notice', text: 'The suggested lines fall outside the code you selected.' });
    return;
  }

  const docRange = modelRangeToDocument(fix.range);
  if (!docRange) {
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
  session.anchor = null; // the code we asked about no longer exists
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
 * The panel is now opened at the moment a question is asked, so the first few
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

function flushPosts() {
  while (pendingPosts.length) {
    panel.webview.postMessage(pendingPosts.shift());
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

async function handleMessage(context, msg) {
  switch (msg.type) {
    case 'ready':
      panelReady = true;
      panel.webview.postMessage({
        type: 'init',
        history: session.history,
        typewriter: vscode.workspace.getConfiguration('socraticTutor').get('typewriter'),
        limit: HISTORY_LIMIT
      });
      flushPosts();
      postModelLabel();
      break;
    case 'reply':
      if (!session.anchor) {
        post({ type: 'notice', text: 'Select some code and ask a question to start.' });
        return;
      }
      await run(context, { context: msg.text, firstTurn: false });
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
    model: cfg.get('model'),
    temperature: cfg.get('temperature'),
    mode: session.mode,
    apiKey: await context.secrets.get(SECRET_KEY)
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
  post({ type: 'init', history: [], typewriter: vscode.workspace.getConfiguration('socraticTutor').get('typewriter'), limit: HISTORY_LIMIT });
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

module.exports = { activate, deactivate };
