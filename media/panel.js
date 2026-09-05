// Runs inside the webview. It has no access to Node or the vscode API beyond
// this message channel, which is the point: all model calls happen in the
// extension host, so no key ever reaches this context.
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var el = {
    history: document.getElementById('history'),
    empty: document.getElementById('empty'),
    busy: document.getElementById('busy'),
    notice: document.getElementById('notice'),
    model: document.getElementById('model'),
    modes: document.getElementById('modes'),
    modeNote: document.getElementById('modeNote'),
    composer: document.getElementById('composer'),
    reply: document.getElementById('reply'),
    send: document.getElementById('send'),
    restart: document.getElementById('restart'),
    reHighlight: document.getElementById('reHighlight')
  };

  var typewriterEnabled = true;
  var reducedMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- auto-growing reply box -------------------------------------------

  function grow(area) {
    var max = parseInt(area.getAttribute('data-max'), 10) || 200;
    area.style.height = 'auto';
    var wanted = area.scrollHeight;
    area.style.height = Math.min(wanted, max) + 'px';
    area.style.overflowY = wanted > max ? 'auto' : 'hidden';
  }
  grow(el.reply);
  el.reply.addEventListener('input', function () { grow(el.reply); });

  // --- modes ------------------------------------------------------------
  // The popup picks the mode for a new selection; this row changes it for
  // follow-ups, so "I'm stuck, give me a strong hint now" is one click.

  function renderModes(modes, active) {
    el.modes.replaceChildren();
    modes.forEach(function (mode) {
      var btn = document.createElement('button');
      btn.className = 'mode' + (mode.id === active ? ' active' : '');
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', mode.id === active ? 'true' : 'false');
      btn.title = mode.note;
      btn.textContent = mode.label;
      btn.addEventListener('click', function () {
        vscode.postMessage({ type: 'setMode', mode: mode.id });
      });
      el.modes.appendChild(btn);
      if (mode.id === active) el.modeNote.textContent = 'Next reply: ' + mode.note;
    });
  }

  // --- outgoing ---------------------------------------------------------

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

  el.reHighlight.addEventListener('click', requestHighlight);

  function requestHighlight() {
    clearNotice();
    vscode.postMessage({ type: 'reHighlight' });
  }

  function sendReply() {
    var text = el.reply.value.trim();
    if (!text) return;
    clearNotice();
    el.reply.value = '';
    grow(el.reply);
    vscode.postMessage({ type: 'reply', text: text });
  }

  // --- incoming ---------------------------------------------------------

  window.addEventListener('message', function (event) {
    var msg = event.data;
    switch (msg.type) {
      case 'init':
        typewriterEnabled = msg.typewriter !== false;
        finishTyping();
        el.history.replaceChildren();
        (msg.history || []).forEach(function (entry) {
          var node = renderEntry(entry);
          if (entry.response !== null && entry.response !== undefined) {
            fillResponse(node, entry, true); // already seen; no animation
          }
        });
        refreshChrome();
        break;
      case 'modes':
        renderModes(msg.modes, msg.active);
        break;
      case 'entry':
        renderEntry(msg.entry);
        refreshChrome();
        break;
      case 'resolve':
        var node = document.getElementById(msg.id);
        if (node) fillResponse(node, msg.entry, msg.instant === true);
        refreshChrome();
        break;
      case 'busy':
        el.busy.hidden = !msg.value;
        el.send.disabled = msg.value;
        if (msg.value) scrollToEnd();
        break;
      case 'notice':
        showNotice(msg.text);
        break;
      case 'model':
        el.model.textContent = msg.text;
        break;
      case 'highlightState':
        el.reHighlight.disabled = msg.active === true;
        break;
      case 'fixApplied':
        Array.prototype.forEach.call(document.querySelectorAll('.fixcard'), function (c) {
          c.remove();
        });
        break;
      default:
        break;
    }
  });

  // --- rendering --------------------------------------------------------

  // textContent everywhere, never innerHTML: model output is untrusted text and
  // this panel runs with scripts enabled.

  function renderEntry(entry) {
    // The same entry can arrive twice — once inside `init`, once as a queued
    // `entry` from before the panel was ready. Render it once.
    var existing = document.getElementById(entry.id);
    if (existing) return existing;

    var article = document.createElement('article');
    article.className = 'exchange';
    article.id = entry.id;

    var head = document.createElement('div');
    head.className = 'exchange-head';

    var badge = document.createElement('span');
    badge.className = 'mode-badge ' + entry.mode;
    badge.textContent = entry.modeLabel;
    head.appendChild(badge);

    if (entry.startLine) {
      var where = document.createElement('button');
      where.className = 'where';
      where.type = 'button';
      where.title = 'Show this code in the editor';
      var lines = entry.code ? entry.code.split('\n').length : 0;
      where.textContent =
        lines > 1
          ? 'lines ' + entry.startLine + '–' + (entry.startLine + lines - 1)
          : 'line ' + entry.startLine;
      where.addEventListener('click', requestHighlight);
      head.appendChild(where);
    }
    article.appendChild(head);

    if (entry.code) {
      var details = document.createElement('details');
      details.className = 'block code-block';
      details.open = entry.code.split('\n').length <= 12;

      var summary = document.createElement('summary');
      summary.textContent = 'Selected code';
      details.appendChild(summary);

      var ol = document.createElement('ol');
      ol.className = 'codelines';
      ol.start = entry.startLine || 1;
      entry.code.split('\n').forEach(function (line) {
        var li = document.createElement('li');
        li.textContent = line === '' ? ' ' : line;
        ol.appendChild(li);
      });
      details.appendChild(ol);
      article.appendChild(details);
    }

    if (entry.question) {
      var q = document.createElement('div');
      q.className = 'block question';
      var qlabel = document.createElement('span');
      qlabel.className = 'block-label';
      qlabel.textContent = entry.code ? 'You asked' : 'You';
      q.appendChild(qlabel);
      var qtext = document.createElement('p');
      qtext.textContent = entry.question;
      q.appendChild(qtext);
      article.appendChild(q);
    }

    var resp = document.createElement('div');
    resp.className = 'block response pending';
    var rlabel = document.createElement('span');
    rlabel.className = 'block-label';
    rlabel.textContent = 'Tutor';
    resp.appendChild(rlabel);
    var rtext = document.createElement('p');
    rtext.className = 'response-text';
    resp.appendChild(rtext);
    article.appendChild(resp);

    el.history.appendChild(article);
    scrollToEnd();
    return article;
  }

  function fillResponse(article, entry, instant) {
    var resp = article.querySelector('.response');
    var target = article.querySelector('.response-text');
    resp.classList.remove('pending');
    if (entry.flag === 'error') resp.classList.add('failed');

    type(target, entry.response || '', instant, function () {
      if (entry.flag && entry.flag !== 'error' && !resp.querySelector('.flag')) {
        var badge = document.createElement('span');
        badge.className = 'flag ' + entry.flag;
        badge.textContent =
          entry.flag === 'rewritten' ? 'guardrail: rewritten' : 'guardrail: blocked';
        resp.appendChild(badge);
      }
      if (entry.fix && !article.querySelector('.fixcard')) renderFix(article, entry.fix);
      scrollToEnd();
    });
  }

  function renderFix(article, fix) {
    var card = document.createElement('div');
    card.className = 'fixcard';

    var label = document.createElement('span');
    label.className = 'block-label';
    label.textContent =
      fix.range.start === fix.range.end
        ? 'Suggested fix — replaces line ' + fix.range.start + ' of the selection'
        : 'Suggested fix — replaces lines ' +
          fix.range.start + '–' + fix.range.end + ' of the selection';
    card.appendChild(label);

    var pre = document.createElement('pre');
    pre.textContent = fix.code;
    card.appendChild(pre);

    var actions = document.createElement('div');
    actions.className = 'fixcard-actions';

    var apply = document.createElement('button');
    apply.className = 'primary';
    apply.textContent = 'Apply to editor';
    apply.addEventListener('click', function () {
      clearNotice();
      vscode.postMessage({ type: 'applyFix' });
    });
    actions.appendChild(apply);

    var copy = document.createElement('button');
    copy.className = 'ghost';
    copy.textContent = 'Copy';
    copy.addEventListener('click', function () {
      navigator.clipboard.writeText(fix.code).then(
        function () {
          copy.textContent = 'Copied';
          setTimeout(function () { copy.textContent = 'Copy'; }, 1500);
        },
        function () { showNotice('Could not reach the clipboard. Select the fix and press Ctrl+C.'); }
      );
    });
    actions.appendChild(copy);

    card.appendChild(actions);
    article.appendChild(card);
  }

  // --- typewriter -------------------------------------------------------
  // Reveals the reply progressively so a wall of text does not land at once.
  // Purely cosmetic — the whole string is already here, and it is capped at
  // about a second regardless of length so it never becomes the slow part.

  var typing = null; // { timer, target, text, done }

  // If a new reply arrives mid-animation, the previous one is completed rather
  // than abandoned, so its badge and fix card still get rendered.
  function finishTyping() {
    if (!typing) return;
    clearInterval(typing.timer);
    typing.target.textContent = typing.text;
    var done = typing.done;
    typing = null;
    if (done) done();
  }

  function type(target, text, instant, done) {
    finishTyping();

    if (instant || !typewriterEnabled || reducedMotion || text.length < 24) {
      target.textContent = text;
      if (done) done();
      return;
    }

    var ticks = 70;
    var step = Math.max(2, Math.ceil(text.length / ticks));
    var i = 0;
    var job = { target: target, text: text, done: done, timer: null };
    job.timer = setInterval(function () {
      i += step;
      target.textContent = text.slice(0, i);
      scrollToEnd();
      if (i >= text.length) {
        clearInterval(job.timer);
        if (typing === job) typing = null;
        target.textContent = text;
        if (done) done();
      }
    }, 14);
    typing = job;
  }

  function refreshChrome() {
    var has = el.history.children.length > 0;
    el.empty.hidden = has;
    el.composer.hidden = !has;
  }

  function scrollToEnd() {
    window.scrollTo(0, document.body.scrollHeight);
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
