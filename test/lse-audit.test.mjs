// The arm64 LSE audit, which guards the one package that must not SIGILL on the Duet.
//
// Why this file exists: the audit used to COUNT LSE-looking instructions and fail above 40,
// and laptop/reviewer proved by cross-compiling the real board_core that the count cannot
// tell a safe build from the one this audit exists to catch - 1 match safe, 3 matches unsafe,
// both far below 40. A real SIGILL-on-the-Duet build passed. These cases pin the distinction
// that replaced it: WHERE the instruction is, not how many there are.
//
// Each case asserts the tool's verdict BOTH ways - it must catch what it must catch, and it
// must not flag the build we actually ship. Run: node --test test/lse-audit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, '..', 'tools', 'lse-audit.py');

/** Feed a synthetic disassembly to the auditor; return { code, out }. */
function audit(disassembly) {
  const r = spawnSync('python3', [TOOL], { input: disassembly, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const sym = (name, ...insns) => `0000000000001000 <${name}>:\n` +
  insns.map((i, n) => `    ${(0x1000 + n * 4).toString(16)}:\t${i}\n`).join('');

const CAS = 'c8dffc20 \tcas\tx0, x1, [x1]';
const LDADD = 'c8dffc20 \tldadd\tx0, x1, [x1]';
const NOP = 'd503201f \tnop';

test('a helper-only build passes - that is the build we ship', () => {
  const r = audit(sym('__aarch64_cas8_acq', CAS) + sym('__aarch64_ldadd4_acq_rel', LDADD));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /outside the compiler's helpers: 0/);
});

test('an LSE inlined in APP code fails, whatever the count', () => {
  const r = audit(sym('_ZN6Engine5applyEv', NOP, CAS));
  assert.equal(r.code, 1, 'the whole point: app code may not contain LSE');
  assert.match(r.out, /Engine5applyEv/);
});

test('the count it replaced could not see this: 3 inline hits, far under 40', () => {
  // laptop/reviewer's cross-compiled armv8.1-a build: ~3 matches, all inline. The old audit
  // passed it. This one must not.
  const r = audit(sym('_ZN6Engine5applyEv', CAS, CAS, CAS));
  assert.equal(r.code, 1, 'three inline LSE atomics would SIGILL on the Duet');
});

test('a build with no LSE at all passes', () => {
  const r = audit(sym('main', NOP));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /LSE-looking instructions: 0/);
});

test('an instruction outside any symbol is not assumed to be a helper', () => {
  // No symbol header at all: a bare fragment must not be waved through by a missing name.
  const r = audit(`    1000:\t${CAS}\n`);
  assert.equal(r.code, 1);
  assert.match(r.out, /outside any symbol/);
});

test('every shape the old grep looked for is still looked for', () => {
  for (const op of ['swp', 'cas', 'ldadd', 'ldset', 'ldclr', 'ldeor']) {
    const r = audit(sym('_ZN6Engine5applyEv', `c8dffc20 \t${op}\tx0, x1, [x1]`));
    assert.equal(r.code, 1, `${op} in app code must fail`);
  }
});
