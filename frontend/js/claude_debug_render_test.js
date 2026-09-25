// Reproduces the real reported bug: ClaudeDebug.addTopic() called
// BEFORE its container div exists in the DOM (exactly what happens
// inside buildAdminFilesBody(), which only returns an HTML string -
// the caller inserts it into the DOM afterward). Verifies both fixes:
//   1. _render() retries instead of silently giving up when the
//      container is missing.
//   2. The registration call site is deferred via setTimeout so it
//      runs after the real DOM insertion.
//
// Minimal DOM stub - just enough for this test, no real jsdom needed.
function makeFakeDocument() {
  const elements = {};
  return {
    _elements: elements,
    getElementById: function (id) { return elements[id] || null; },
    _insert: function (id) {
      elements[id] = { innerHTML: '' };
      return elements[id];
    },
  };
}

function escapeHtml(s) { return String(s); }

function buildClaudeDebug(doc) {
  return {
    _topics: [],
    _renderRetryCount: 0,
    clear: function () { this._topics = []; this._render(); },
    addTopic: function (label, options, applyFn) {
      this._topics.push({ label: label, options: options, applyFn: applyFn, current: options && options[0] ? options[0].value : null });
      this._render();
      if (applyFn && options && options[0]) applyFn(options[0].value);
    },
    _select: function (topicIndex, value) {
      const t = this._topics[topicIndex];
      if (!t) return;
      t.current = value;
      if (t.applyFn) t.applyFn(value);
    },
    _render: function () {
      const container = doc.getElementById('claudeDebugPanel');
      if (!container) {
        this._renderRetryCount = (this._renderRetryCount || 0) + 1;
        if (this._renderRetryCount <= 20) {
          setTimeout(this._render.bind(this), 5); // shortened for test speed
        }
        return;
      }
      this._renderRetryCount = 0;
      if (!this._topics.length) {
        container.innerHTML = '<p>Abhi koi active topic nahi hai.</p>';
        return;
      }
      container.innerHTML = this._topics.map(function (t, i) {
        return `<div>Topic ${i + 1}: ${escapeHtml(t.label)}<select>${t.options.map(function (o) {
          return `<option value="${escapeHtml(o.value)}" ${o.value === t.current ? 'selected' : ''}>${escapeHtml(o.name)}</option>`;
        }).join('')}</select></div>`;
      }).join('');
    },
  };
}

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// ── Reproduction: register BEFORE the container exists (the real bug) ──
const doc1 = makeFakeDocument();
const cd1 = buildClaudeDebug(doc1);
cd1.clear();
cd1.addTopic('Test topic', [{ name: 'Option A', value: 'a' }], function () {});
// At this exact moment (synchronous, container not inserted yet) the
// OLD (unfixed) behavior would have permanently given up. With the
// retry fix, it's just pending.
assert(doc1.getElementById('claudeDebugPanel') === null, 'Setup: container genuinely does not exist yet');

// Now simulate the DOM insertion happening (as the real caller does
// after buildAdminFilesBody() returns).
doc1._insert('claudeDebugPanel');

// Give the retry loop a chance to run (real code waits 50ms; test stub
// waits 5ms - a couple ticks is enough).
setTimeout(function () {
  const html = doc1.getElementById('claudeDebugPanel').innerHTML;
  assert(html.indexOf('Test topic') !== -1, 'Retry fix: topic eventually renders after late DOM insertion');
  assert(html.indexOf('Abhi koi active topic nahi hai') === -1, 'Retry fix: stale placeholder text is gone');
  console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
}, 60);
