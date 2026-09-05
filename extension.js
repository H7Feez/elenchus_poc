'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { getReply, NEEDS_KEY } = require('./providers');
const { SYSTEM_PROMPT, REWRITE_INSTRUCTION, BLOCKED_MESSAGE, buildFirstTurn } = require('./prompt');
const guardrail = require('./guardrail');

const SECRET_KEY = 'socraticTutor.apiKey';

/** The single tutor panel, or null when closed. */
let panel = null;

/** Conversation state. Reset by socraticTutor.newSession. */
let session = newSession();

function newSession() {
  return {
    started: false,          // has the student submitted code yet
    messages: [],            // OpenAI-shape turns, excluding the system prompt
    stats: {
      asks: 0,
      guardrailFired: 0,     // a reply was caught and a rewrite requested
      guardrailBlocked: 0,   // the rewrite was ALSO bad, student saw nothing
      repliesWithoutQuestion: 0,
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

  postModelLabel();
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

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(context, msg) {
  switch (msg.type) {
    case 'ready':
      postModelLabel();
      break;
    case 'ask':
      await ask(context, msg);
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
    userText = buildFirstTurn(msg.code, msg.error);
    session.started = true;
    post({ type: 'sessionStarted' });
    post({ type: 'append', role: 'student', text: summariseFirstTurn(msg.code, msg.error) });
  } else {
    if (!msg.message || !msg.message.trim()) return;
    userText = msg.message.trim();
    post({ type: 'append', role: 'student', text: userText });
  }

  session.messages.push({ role: 'user', content: userText });
  session.stats.asks += 1;

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
    apiKey
  };

  post({ type: 'busy', value: true });
  try {
    const reply = await askWithGuardrail(opts);
    session.messages.push({ role: 'assistant', content: reply.text });
    post({ type: 'append', role: 'tutor', text: reply.text, flag: reply.flag });
  } catch (err) {
    post({ type: 'notice', text: String(err && err.message ? err.message : err) });
  } finally {
    post({ type: 'busy', value: false });
  }
}

/**
 * One model call, inspected. If the filter trips, one automatic rewrite
 * attempt. If the rewrite also trips, the student sees the blocked message
 * instead - never the leaked solution.
 */
async function askWithGuardrail(opts) {
  const cfg = vscode.workspace.getConfiguration('socraticTutor');
  const enabled = cfg.get('guardrailEnabled');

  const base = [{ role: 'system', content: SYSTEM_PROMPT }].concat(session.messages);
  const first = await getReply(base, opts);

  if (!enabled) return { text: first, flag: null };

  const check = guardrail.inspect(first);
  if (!check.blocked) {
    if (!guardrail.hasQuestion(first)) session.stats.repliesWithoutQuestion += 1;
    return { text: first, flag: null };
  }

  session.stats.guardrailFired += 1;
  session.stats.reasons.push.apply(session.stats.reasons, check.reasons);
  log('guardrail fired: ' + check.reasons.join('; '));

  const retryMessages = base.concat([
    { role: 'assistant', content: first },
    { role: 'user', content: REWRITE_INSTRUCTION }
  ]);
  const second = await getReply(retryMessages, opts);

  const recheck = guardrail.inspect(second);
  if (!recheck.blocked) {
    return { text: second, flag: 'rewritten' };
  }

  session.stats.guardrailBlocked += 1;
  session.stats.reasons.push.apply(
    session.stats.reasons,
    recheck.reasons.map((r) => 'on rewrite: ' + r)
  );
  log('guardrail blocked after rewrite: ' + recheck.reasons.join('; '));
  return { text: BLOCKED_MESSAGE, flag: 'blocked' };
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
    apiKey: await context.secrets.get(SECRET_KEY)
  };

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
  session = newSession();
  post({ type: 'reset' });
  postModelLabel();
}

function showStats() {
  const s = session.stats;
  const lines = [
    'Student turns:            ' + s.asks,
    'Guardrail fired:          ' + s.guardrailFired,
    'Blocked after rewrite:    ' + s.guardrailBlocked,
    'Replies with no question: ' + s.repliesWithoutQuestion,
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
