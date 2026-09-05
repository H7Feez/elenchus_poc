'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { getReply, NEEDS_KEY } = require('./providers');
const promptLib = require('./prompt');
const guardrail = require('./guardrail');
const { parseReply, applyRange, sliceRange } = require('./parse');

const SECRET_KEY = 'socraticTutor.apiKey';

/** The single tutor panel, or null when closed. */
let panel = null;

/** Conversation state. Reset by socraticTutor.newSession. */
let session = newSession();

function newSession() {
  return {
    started: false,          // has the student submitted code yet
    mode: promptLib.DEFAULT_MODE,
    code: '',                // the submitted code, kept so fixes can be applied to it
    messages: [],            // OpenAI-shape turns, excluding the system prompt
    lastFix: null,           // { range, replacement } from the most recent direct answer
    stats: {
      asks: 0,
      byMode: { hint: 0, strong: 0, direct: 0 },
      guardrailFired: 0,     // a reply was caught and a rewrite requested
      guardrailBlocked: 0,   // the rewrite was ALSO bad, student saw nothing
      repliesWithoutQuestion: 0,
      fixesApplied: 0,
      reasons: []            // every reason string the filter produced
    }
  };
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('socraticTutor.open', () => openPanel(context)),
    vscode.commands.registerCommand('socraticTutor.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('socraticTutor.clearApiKey', () => clearApiKey(context)),
    vscode.commands.registerCommand('socraticTutor.newSession', () => resetSession()),
    vscode.commands.registerCommand('socraticTutor.showStats', () => showStats()),
    vscode.commands.registerCommand('socraticTutor.testConnection', () => testConnection(context))
  );
}

function deactivate() {}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function openPanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'socraticTutor',
    'Socratic Tutor',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
    }
  );

  panel.webview.html = renderHtml(context, panel.webview);

  panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);

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

function post(message) {
  if (panel) panel.webview.postMessage(message);
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

/** Sends the mode list and the current selection, so the panel never hardcodes them. */
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

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(context, msg) {
  switch (msg.type) {
    case 'ready':
      session.mode = promptLib.modeOrDefault(
        vscode.workspace.getConfiguration('socraticTutor').get('defaultMode')
      );
      postModes();
      postModelLabel();
      break;
    case 'setMode':
      session.mode = promptLib.modeOrDefault(msg.mode);
      postModes();
      break;
    case 'ask':
      await ask(context, msg);
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

async function ask(context, msg) {
  const cfg = vscode.workspace.getConfiguration('socraticTutor');
  const provider = cfg.get('provider');

  // Build the student's turn. The first one carries the code and the error;
  // every turn after that is a plain reply in the conversation.
  let userText;
  if (!session.started) {
    if (!msg.code || !msg.code.trim()) {
      post({ type: 'notice', text: 'Paste some code first.' });
      return;
    }
    session.code = msg.code.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    userText = promptLib.buildFirstTurn(session.code, msg.error);
    session.started = true;
    post({ type: 'sessionStarted', code: session.code });
    post({ type: 'append', role: 'student', text: summariseFirstTurn(session.code, msg.error) });
  } else {
    if (!msg.message || !msg.message.trim()) return;
    userText = msg.message.trim();
    post({ type: 'append', role: 'student', text: userText });
  }

  session.messages.push({ role: 'user', content: userText });
  session.stats.asks += 1;
  session.stats.byMode[session.mode] += 1;

  const apiKey = await context.secrets.get(SECRET_KEY);
  if (NEEDS_KEY.has(provider) && !apiKey) {
    post({ type: 'notice', text: 'No API key set. Run "Socratic Tutor: Set API Key".' });
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
    session.messages.push({ role: 'assistant', content: reply.raw });

    // A fix only makes sense against code we can still address by line number.
    session.lastFix =
      reply.fix && reply.range ? { range: reply.range, replacement: reply.fix } : null;

    post({
      type: 'append',
      role: 'tutor',
      text: reply.text,
      flag: reply.flag,
      range: reply.range,
      fix: session.lastFix ? { range: reply.range, code: reply.fix } : null
    });
  } catch (err) {
    post({ type: 'notice', text: String(err && err.message ? err.message : err) });
  } finally {
    post({ type: 'busy', value: false });
  }
}

/**
 * One model call, parsed and inspected.
 *
 * The guardrail sees only the prose. The LINES marker and the fix block are
 * structure, not the tutor talking, and running the filter over them would
 * make strong-hint and direct modes block themselves every single time.
 */
async function askWithGuardrail(opts) {
  const cfg = vscode.workspace.getConfiguration('socraticTutor');
  const enabled = cfg.get('guardrailEnabled') && promptLib.guardrailApplies(session.mode);

  const base = [{ role: 'system', content: promptLib.buildSystemPrompt(session.mode) }]
    .concat(session.messages);

  const first = await getReply(base, opts);
  const parsedFirst = parseReply(first);

  // Hint mode never highlights, whatever the model chose to emit.
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
      fix: null, // a fix in a hint mode is exactly what we are here to prevent
      flag: null
    };
  }

  session.stats.guardrailFired += 1;
  session.stats.reasons.push.apply(
    session.stats.reasons,
    check.reasons.map((r) => session.mode + ': ' + r)
  );
  log('guardrail fired (' + session.mode + '): ' + check.reasons.join('; '));

  const retryMessages = base.concat([
    { role: 'assistant', content: first },
    { role: 'user', content: promptLib.REWRITE_INSTRUCTION }
  ]);
  const second = await getReply(retryMessages, opts);
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

function summariseFirstTurn(code, errorText) {
  const lines = code.trim().split('\n').length;
  const plural = lines === 1 ? '' : 's';
  const bits = ['Submitted ' + lines + ' line' + plural + ' of code'];
  if (errorText && errorText.trim()) {
    bits.push(errorText.trim().split('\n')[0]);
  }
  return bits.join(' — ');
}

// ---------------------------------------------------------------------------
// Applying a fix
// ---------------------------------------------------------------------------

/**
 * Writes the suggested fix into the open editor.
 *
 * Deliberately conservative: it only edits when the original lines are found
 * verbatim, exactly once, in the active document. Anything less certain and it
 * refuses and explains, because silently rewriting the wrong part of a
 * student's file is far worse than making them paste it themselves.
 */
async function applyFixToEditor() {
  const fix = session.lastFix;
  if (!fix) {
    post({ type: 'notice', text: 'There is no fix to apply.' });
    return;
  }

  const original = sliceRange(session.code, fix.range);
  if (original === null) {
    post({
      type: 'notice',
      text: 'The suggested lines are outside the code you submitted, so the fix was not applied. Copy it instead.'
    });
    return;
  }

  // The panel normalises everything to \n, but the file on disk is very likely
  // CRLF on Windows. Searching for the \n form alone finds nothing, so try the
  // document's own line endings too.
  let editor = null;
  let needle = null;
  for (const candidate of vscode.window.visibleTextEditors) {
    const crlf = candidate.document.eol === vscode.EndOfLine.CRLF;
    const forms = crlf ? [original.replace(/\n/g, '\r\n'), original] : [original];
    const found = forms.find((f) => candidate.document.getText().indexOf(f) !== -1);
    if (found) {
      editor = candidate;
      needle = found;
      break;
    }
  }

  if (!editor) {
    post({
      type: 'notice',
      text: 'Could not find those lines in any open editor. Open the file you pasted from, or use Copy.'
    });
    return;
  }

  const text = editor.document.getText();
  const at = text.indexOf(needle);
  if (at !== text.lastIndexOf(needle)) {
    post({
      type: 'notice',
      text: 'Those lines appear more than once in the file, so it is not clear which to change. Use Copy and edit by hand.'
    });
    return;
  }

  // Write back in the document's own line endings, so the edit does not leave
  // a block of mismatched newlines in the middle of the file.
  const replacement =
    editor.document.eol === vscode.EndOfLine.CRLF
      ? fix.replacement.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n')
      : fix.replacement;

  const start = editor.document.positionAt(at);
  const end = editor.document.positionAt(at + needle.length);
  const target = new vscode.Range(start, end);

  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, target, replacement);
  const ok = await vscode.workspace.applyEdit(edit);

  if (!ok) {
    post({ type: 'notice', text: 'VS Code refused the edit. The file may be read-only.' });
    return;
  }

  // Keep the panel's copy in step, so a second fix still counts lines correctly.
  const updated = applyRange(session.code, fix.range, fix.replacement);
  if (updated !== null) {
    session.code = updated;
    post({ type: 'codeUpdated', code: updated });
  }

  session.stats.fixesApplied += 1;
  session.lastFix = null;
  post({ type: 'fixApplied' });

  const newEnd = editor.document.positionAt(
    editor.document.offsetAt(start) + replacement.length
  );
  editor.revealRange(new vscode.Range(start, newEnd), vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(start, newEnd);
  vscode.window.showInformationMessage('Socratic Tutor: fix applied. Undo with Ctrl+Z.');
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

  // Storing a key does not switch the backend, and nothing on screen says so.
  // Left alone, the panel keeps answering from the canned mock and the student
  // reasonably concludes the key did not work.
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

/**
 * Sends one throwaway message so a broken key, URL or model id surfaces here
 * instead of halfway through a demo.
 */
async function testConnection(context) {
  const cfg = vscode.workspace.getConfiguration('socraticTutor');
  const provider = cfg.get('provider');
  const opts = {
    provider,
    baseUrl: cfg.get('baseUrl'),
    model: cfg.get('model'),
    temperature: cfg.get('temperature'),
    mode: session.mode,
    apiKey: await context.secrets.get(SECRET_KEY)
  };

  // Testing the mock backend proves nothing — it always answers. Saying so is
  // more useful than a green tick that means the opposite of what it looks like.
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

  if (NEEDS_KEY.has(provider) && !opts.apiKey) {
    vscode.window.showWarningMessage(
      'Socratic Tutor: no API key stored. Run "Socratic Tutor: Set API Key" first.'
    );
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Socratic Tutor: testing connection…' },
    async () => {
      try {
        const reply = await getReply(
          [{ role: 'user', content: 'Reply with the single word: ready' }],
          opts
        );
        log('connection test OK: ' + reply.replace(/\s+/g, ' ').slice(0, 120));
        vscode.window.showInformationMessage(
          `Socratic Tutor: ${provider} answered — "${reply.replace(/\s+/g, ' ').slice(0, 60)}"`
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
  session = newSession();
  session.mode = keepMode;
  post({ type: 'reset' });
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
