// The checker that guards the view needs guarding itself.
//
// Why this file exists: qml-propcheck.py is regex-based, and a regex-based checker fails by
// quietly doing nothing - it reports success. That happened twice. First the check only ever
// looked at ASSIGNMENTS to the root object, never CALLS, so a card delegate calling a helper
// that was never written compiled, passed qml-check and passed the probe, and would have
// thrown on the tablet the moment a card appeared. Then, after adding the call check, Proteus
// (independent review, 2026-10-09) found it took the FIRST `id:` in the file as the root: move
// one nested `id:` above the root's and the same broken call passes. A tool that cannot fail
// is not a check, so every case below is a way the tool has been wrong or could be.
//
// Each case asserts the tool's VERDICT, both ways: it must catch what it must catch, and it
// must not flag what it must not. Run: node --test test/propcheck.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, '..', 'tools', 'qml-propcheck.py');
const dir = mkdtempSync(join(tmpdir(), 'propcheck-'));

/** Run the checker on a fixture; return { ok, out }. */
function check(name, src) {
  const p = join(dir, name);
  writeFileSync(p, src);
  try {
    const out = execFileSync('python3', [TOOL, p], { encoding: 'utf8' });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const head = 'import QtQuick\nItem {\n';

test('catches a call to a function that was never written', () => {
  const r = check('missing.qml', head + '    id: root\n    Component.onCompleted: root.nope(1)\n}\n');
  assert.equal(r.ok, false, 'a missing helper must fail the check');
  assert.match(r.out, /nope\(\)/);
});

test('catches it even when a NESTED id is declared before the root id', () => {
  // Proteus's reproduction: same content, same broken call, only the order of two `id:` lines
  // differs. The check used to take the first `id:` in the file, so it watched `child` and
  // reported success. This is the case that must never pass again.
  const r = check('child-first.qml',
    'import QtQuick\nItem {\n    Item {\n        id: child\n    }\n    id: root\n' +
    '    Component.onCompleted: root.nope(1)\n}\n');
  assert.equal(r.ok, false, 'a nested id must not become the root');
  assert.match(r.out, /nope\(\)/);
});

test('catches a dot on the NEXT line', () => {
  const r = check('nextline.qml', head + '    id: root\n    Component.onCompleted: root\n        .nope(1)\n}\n');
  assert.equal(r.ok, false);
  assert.match(r.out, /nope\(\)/);
});

test('catches optional chaining', () => {
  const r = check('optchain.qml', head + '    id: root\n    Component.onCompleted: root?.nope(1)\n}\n');
  assert.equal(r.ok, false);
  assert.match(r.out, /nope\(\)/);
});

test('does NOT flag a call inside a block comment', () => {
  const r = check('blockcomment.qml',
    head + '    id: root\n    /* root.nope(1) is only a note */\n    property int x: 1\n}\n');
  assert.equal(r.ok, true, 'a comment is not code; flagging it trains people to ignore the tool');
});

test('does NOT flag a call inside a single-quoted string or a template literal', () => {
  const r = check('strings.qml',
    head + "    id: root\n    property string a: 'root.nope(1)'\n" +
    '    property string b: `root.nope(1)`\n}\n');
  assert.equal(r.ok, true);
});

test('passes a call to a declared function, and does not flag Qt methods', () => {
  const r = check('declared.qml',
    head + '    id: root\n    function helper(a) { return a }\n' +
    '    Component.onCompleted: root.helper(root.mapToItem(null, 0, 0))\n}\n');
  assert.equal(r.ok, true);
});

test('catches an assignment to an undeclared property (same outermost-root rule)', () => {
  const r = check('assign.qml',
    'import QtQuick\nItem {\n    Item {\n        id: child\n    }\n    id: root\n' +
    '    Component.onCompleted: root.nopeProp = 1\n}\n');
  assert.equal(r.ok, false);
  assert.match(r.out, /nopeProp/);
});

test('catches a call made through a LOCAL ALIAS for the root', () => {
  // laptop/reviewer, 2026-10-10: `var r = root; r.missingHelper()` walked straight past the
  // call check. The checker matched the root's NAME, so an alias was invisible - the same
  // class as taking the first `id:`, one step further in.
  const { ok, out } = check('alias.qml', head +
    '    id: root\n' +
    '    Component.onCompleted: {\n' +
    '        var r = root\n' +
    '        r.neverWritten(1)\n' +
    '    }\n' +
    '}\n');
  assert.equal(ok, false, 'a call through a local alias must be caught');
  assert.match(out, /neverWritten/);
});

test('does NOT flag an alias for something that is not the root', () => {
  // `var r = root.child` is not the root, so `r.missing()` is not this check's business.
  const { ok } = check('alias-other.qml', head +
    '    id: root\n' +
    '    property QtObject child: QtObject { }\n' +
    '    Component.onCompleted: {\n' +
    '        var r = root.child\n' +
    '        r.neverWritten(1)\n' +
    '    }\n' +
    '}\n');
  assert.equal(ok, true, 'an alias for a child object is not an alias for the root');
});

test('catches a call when a NESTED id sits at the SAME indent, earlier', () => {
  // The tie Proteus's first finding led to: the old rule was "smallest indentation", and a
  // tie went to the FIRST one - so a nested object whose `id:` is at the root's body indent
  // and earlier in the file won, and the root's own calls were never checked (exit 0).
  const { ok, out } = check('tie.qml',
    'import QtQuick\nItem {\n' +
    '    Item {\n' +
    '    id: inner\n' +
    '    }\n' +
    '    id: root\n' +
    '    Component.onCompleted: root.neverWritten(1)\n' +
    '}\n');
  assert.equal(ok, false, 'a same-indent tie must not hand the root name to a nested object');
  assert.match(out, /neverWritten/);
});
