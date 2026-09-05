// Runs inside the webview. It has no access to Node or the vscode API beyond
// this message channel, which is the point: all model calls happen in the
// extension host, so no key ever reaches this context.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const el = {
    setup: document.getElementById('setup'),
    conversation: document.getElementById('conversation'),
    code: document.getElementById('code'),
    error: document.getElementById('error'),
    start: document.getElementById('start'),
    transcript: document.getElementById('transcript'),
    reply: document.getElementById('reply'),
    send: document.getElementById('send'),
    restart: document.getElementById('restart'),
    busy: document.getElementById('busy'),
    notice: document.getElementById('notice'),
    model: document.getElementById('model')
  };

  // --- outgoing ---------------------------------------------------------

  el.start.addEventListener('click', () => {
    clearNotice();
    vscode.postMessage({
      type: 'ask',
      code: el.code.value,
      error: el.error.value
    });
  });

  el.send.addEventListener('click', sendReply);

  el.reply.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendReply();
    }
  });

  el.restart.addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession' });
  });

  function sendReply() {
    const text = el.reply.value.trim();
    if (!text) return;
    clearNotice();
    el.reply.value = '';
    vscode.postMessage({ type: 'ask', message: text });
  }

  // --- incoming ---------------------------------------------------------

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'append':
        append(msg.role, msg.text, msg.flag);
        break;
      case 'sessionStarted':
        el.setup.hidden = true;
        el.conversation.hidden = false;
        el.reply.focus();
        break;
      case 'busy':
        el.busy.hidden = !msg.value;
        el.send.disabled = msg.value;
        el.start.disabled = msg.value;
        break;
      case 'notice':
        showNotice(msg.text);
        break;
      case 'model':
        el.model.textContent = msg.text;
        break;
      case 'reset':
        reset();
        break;
      default:
        break;
    }
  });

  // --- rendering --------------------------------------------------------

  // textContent everywhere, never innerHTML: model output is untrusted text and
  // this panel runs with scripts enabled.
  function append(role, text, flag) {
    const turn = document.createElement('div');
    turn.className = 'turn ' + role;

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = role === 'student' ? 'You' : 'Tutor';
    turn.appendChild(who);

    const body = document.createElement('span');
    body.textContent = text;
    turn.appendChild(body);

    if (flag) {
      const badge = document.createElement('span');
      badge.className = 'flag ' + flag;
      badge.textContent =
        flag === 'rewritten'
          ? 'guardrail: rewritten'
          : 'guardrail: blocked';
      turn.appendChild(document.createElement('br'));
      turn.appendChild(badge);
    }

    el.transcript.appendChild(turn);
    turn.scrollIntoView({ block: 'end' });
  }

  function reset() {
    el.transcript.replaceChildren();
    el.code.value = '';
    el.error.value = '';
    el.reply.value = '';
    el.setup.hidden = false;
    el.conversation.hidden = true;
    el.busy.hidden = true;
    el.start.disabled = false;
    el.send.disabled = false;
    clearNotice();
    el.code.focus();
  }

  function showNotice(text) {
    el.notice.textContent = text;
    el.notice.hidden = false;
  }

  function clearNotice() {
    el.notice.hidden = true;
    el.notice.textContent = '';
  }

  vscode.postMessage({ type: 'ready' });
})();
