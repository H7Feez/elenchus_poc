// Runs inside the webview. It has no access to Node or the vscode API beyond
// this message channel, which is the point: all model calls happen in the
// extension host, so no key ever reaches this context.
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var el = {
    setup: document.getElementById('setup'),
    conversation: document.getElementById('conversation'),
    modes: document.getElementById('modes'),
    modeNote: document.getElementById('modeNote'),
    code: document.getElementById('code'),
    error: document.getElementById('error'),
    start: document.getElementById('start'),
    codeView: document.getElementById('codeView'),
    codeBody: document.getElementById('codeBody'),
    codeLines: document.getElementById('codeLines'),
    toggleCode: document.getElementById('toggleCode'),
    transcript: document.getElementById('transcript'),
    reply: document.getElementById('reply'),
    send: document.getElementById('send'),
    restart: document.getElementById('restart'),
    busy: document.getElementById('busy'),
    notice: document.getElementById('notice'),
    model: document.getElementById('model'),
    fixCard: document.getElementById('fixCard'),
    fixRange: document.getElementById('fixRange'),
    fixCode: document.getElementById('fixCode'),
    applyFix: document.getElementById('applyFix'),
    copyFix: document.getElementById('copyFix')
  };

  var submittedCode = '';

  // --- auto-growing textareas -------------------------------------------
  // Start at two rows and grow with the content up to a per-field ceiling,
  // after which the field scrolls. Keeps the panel usable in a narrow column.

  function grow(area) {
    var max = parseInt(area.getAttribute('data-max'), 10) || 300;
    area.style.height = 'auto';
    var wanted = area.scrollHeight;
    area.style.height = Math.min(wanted, max) + 'px';
    area.style.overflowY = wanted > max ? 'auto' : 'hidden';
  }

  function watchGrowth(area) {
    grow(area);
    area.addEventListener('input', function () { grow(area); });
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-autogrow]'), watchGrowth);

  // --- modes ------------------------------------------------------------

  function renderModes(modes, active) {
    el.modes.replaceChildren();
    modes.forEach(function (mode) {
      var btn = document.createElement('button');
      btn.className = 'mode' + (mode.id === active ? ' active' : '');
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', mode.id === active ? 'true' : 'false');
      btn.dataset.mode = mode.id;
      btn.dataset.note = mode.note;
      btn.textContent = mode.label;
      btn.addEventListener('click', function () {
        vscode.postMessage({ type: 'setMode', mode: mode.id });
      });
      el.modes.appendChild(btn);
      if (mode.id === active) el.modeNote.textContent = mode.note;
    });
    el.start.textContent = active === 'direct' ? 'Ask for the answer' : 'Ask for help';
  }

  // --- outgoing ---------------------------------------------------------

  el.start.addEventListener('click', function () {
    clearNotice();
    vscode.postMessage({ type: 'ask', code: el.code.value, error: el.error.value });
  });

  el.send.addEventListener('click', sendReply);

  el.reply.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendReply();
    }
  });

  el.restart.addEventListener('click', function () {
    vscode.postMessage({ type: 'newSession' });
  });

  el.applyFix.addEventListener('click', function () {
    clearNotice();
    vscode.postMessage({ type: 'applyFix' });
  });

  el.copyFix.addEventListener('click', function () {
    var text = el.fixCode.textContent;
    navigator.clipboard.writeText(text).then(function () {
      flash(el.copyFix, 'Copied');
    }, function () {
      showNotice('Could not reach the clipboard. Select the fix and press Ctrl+C.');
    });
  });

  el.toggleCode.addEventListener('click', function () {
    var hidden = el.codeBody.hidden;
    el.codeBody.hidden = !hidden;
    el.toggleCode.textContent = hidden ? 'Hide' : 'Show';
    el.toggleCode.setAttribute('aria-expanded', hidden ? 'true' : 'false');
  });

  function sendReply() {
    var text = el.reply.value.trim();
    if (!text) return;
    clearNotice();
    el.reply.value = '';
    grow(el.reply);
    vscode.postMessage({ type: 'ask', message: text });
  }

  // --- incoming ---------------------------------------------------------

  window.addEventListener('message', function (event) {
    var msg = event.data;
    switch (msg.type) {
      case 'modes':
        renderModes(msg.modes, msg.active);
        break;
      case 'append':
        append(msg.role, msg.text, msg.flag);
        if (msg.range) highlight(msg.range);
        showFix(msg.fix);
        break;
      case 'sessionStarted':
        submittedCode = msg.code;
        renderCode(msg.code);
        el.setup.hidden = true;
        el.conversation.hidden = false;
        el.reply.focus();
        break;
      case 'codeUpdated':
        submittedCode = msg.code;
        renderCode(msg.code);
        break;
      case 'fixApplied':
        el.fixCard.hidden = true;
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
    var turn = document.createElement('div');
    turn.className = 'turn ' + role;

    var who = document.createElement('span');
    who.className = 'who';
    who.textContent = role === 'student' ? 'You' : 'Tutor';
    turn.appendChild(who);

    var body = document.createElement('span');
    body.textContent = text;
    turn.appendChild(body);

    if (flag) {
      var badge = document.createElement('span');
      badge.className = 'flag ' + flag;
      badge.textContent = flag === 'rewritten' ? 'guardrail: rewritten' : 'guardrail: blocked';
      turn.appendChild(document.createElement('br'));
      turn.appendChild(badge);
    }

    el.transcript.appendChild(turn);
    turn.scrollIntoView({ block: 'end' });
  }

  function renderCode(code) {
    el.codeLines.replaceChildren();
    code.split('\n').forEach(function (line) {
      var li = document.createElement('li');
      li.textContent = line === '' ? ' ' : line;
      el.codeLines.appendChild(li);
    });
  }

  function highlight(range) {
    var items = el.codeLines.children;
    for (var i = 0; i < items.length; i++) {
      items[i].classList.remove('marked');
    }
    var first = null;
    for (var n = range.start; n <= range.end; n++) {
      var li = items[n - 1];
      if (!li) continue;
      li.classList.add('marked');
      if (!first) first = li;
    }
    if (first) {
      if (el.codeBody.hidden) {
        el.codeBody.hidden = false;
        el.toggleCode.textContent = 'Hide';
        el.toggleCode.setAttribute('aria-expanded', 'true');
      }
      first.scrollIntoView({ block: 'nearest' });
    }
  }

  function showFix(fix) {
    if (!fix) {
      el.fixCard.hidden = true;
      return;
    }
    var r = fix.range;
    el.fixRange.textContent =
      r.start === r.end ? 'line ' + r.start : 'lines ' + r.start + '–' + r.end;
    el.fixCode.textContent = fix.code;
    el.applyFix.disabled = false;
    el.fixCard.hidden = false;
    el.fixCard.scrollIntoView({ block: 'nearest' });
  }

  function flash(button, text) {
    var original = button.textContent;
    button.textContent = text;
    setTimeout(function () { button.textContent = original; }, 1500);
  }

  function reset() {
    el.transcript.replaceChildren();
    el.codeLines.replaceChildren();
    el.code.value = '';
    el.error.value = '';
    el.reply.value = '';
    [el.code, el.error, el.reply].forEach(grow);
    el.setup.hidden = false;
    el.conversation.hidden = true;
    el.busy.hidden = true;
    el.fixCard.hidden = true;
    el.codeBody.hidden = false;
    el.toggleCode.textContent = 'Hide';
    el.start.disabled = false;
    el.send.disabled = false;
    submittedCode = '';
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
