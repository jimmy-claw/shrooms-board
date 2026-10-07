// Golden vector generator — the parity contract between the JS reference and the
// C++ mirror (logos-multiwriter-sync §Parity: one reference, mirrored
// implementations, golden-vector fixtures + cross-language parity test).
//
// Deterministic: fixed dev ids, fixed UUIDs, seeded op order, fixed wall clock.
// Output: module/tests/golden/<name>.json  { description, events, expectedState }
// expectedState is canonical JSON (sorted keys) — the C++ fold must serialize to
// the exact same bytes.
//
// Run: node tools/gen-golden.mjs   (from the repo root)

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clock } from '../contract/hlc.mjs';
import { ev } from '../contract/events.mjs';
import { mergeEvents, foldBoard, checkInvariants } from '../engine/engine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'module', 'tests', 'golden');
mkdirSync(OUT, { recursive: true });

const DEV_A = 'a'.repeat(32);
const DEV_B = 'b'.repeat(32);
const DEV_C = 'c'.repeat(32);

// Canonical JSON: sorted keys, no whitespace — the parity byte format.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

// Deterministic clock: wall advances by a fixed step per stamp, no Date.now.
function fixedClock(dev, startWall, stepMs) {
  let wall = startWall;
  let ctr = 0;
  return {
    dev,
    send() { ctr += 1; return { wall, ctr, dev }; },
    tick() { wall += stepMs; ctr = 0; },
  };
}

function fixtures() {
  const f = [];

  // ---- fixture 1: happy path, single device -------------------------------
  {
    const c = fixedClock(DEV_A, 1000, 10);
    const L1 = '11111111-1111-4111-8111-111111111111';
    const L2 = '22222222-2222-4222-8222-222222222222';
    const C1 = '33333333-3333-4333-8333-333333333333';
    const C2 = '44444444-4444-4444-8444-444444444444';
    const M1 = '55555555-5555-4555-8555-555555555555';
    const events = [
      ev.boardRename('Fleet', c),
      ev.listCreate(L1, 'To Do', 1000, c),
      ev.listCreate(L2, 'Doing', 2000, c),
      ev.cardCreate(C1, L1, 'first card', 1000, c),
      ev.cardCreate(C2, L1, 'second card', 2000, c),
      ev.cardEdit(C1, { desc: 'the description', due: 1760000000000 }, c),
      ev.cardEdit(C1, { list_id: L2, pos: 1500 }, c), // move
      ev.cardAssign(C1, 'jimmy', true, c),
      ev.cardAssign(C1, 'proteus', true, c),
      ev.cardAssign(C1, 'jimmy', false, c),           // un-vote
      ev.commentCreate(M1, C1, 'a comment', c),
    ];
    f.push({ name: 'happy-path', description: 'single device, full happy path incl. move, register toggle, comment', events });
  }

  // ---- fixture 2: three devices, conflicts + tombstones -------------------
  {
    const a = fixedClock(DEV_A, 1000, 10);
    const b = fixedClock(DEV_B, 1005, 10);
    const cc = fixedClock(DEV_C, 1010, 10);
    const L1 = 'aaaaaaaa-1111-4a11-8a11-111111111111';
    const L2 = 'aaaaaaaa-2222-4a22-8a22-222222222222';
    const C1 = 'bbbbbbbb-1111-4b11-8b11-111111111111';
    const C2 = 'bbbbbbbb-2222-4b22-8b22-222222222222';
    const events = [
      ev.listCreate(L1, 'To Do', 1000, a),
      ev.listCreate(L2, 'Done', 2000, a),
      ev.cardCreate(C1, L1, 'original title', 1000, a),
      ev.cardCreate(C2, L1, 'doomed card', 2000, a),
      // same-field conflict: LWW by HLC must pick b's edit (wall 1005+ > a's 1000+)
      ev.cardEdit(C1, { title: 'edit from A' }, a),
      ev.cardEdit(C1, { title: 'edit from B wins' }, b),
      // different-field concurrent edits: both survive
      ev.cardEdit(C1, { desc: 'A description' }, a),
      ev.cardEdit(C1, { due: 1760000000001 }, cc),
      // register: same actor from two devices — later HLC wins
      ev.cardAssign(C1, 'jimmy', true, a),
      ev.cardAssign(C1, 'jimmy', false, b),
      ev.cardAssign(C1, 'proteus', true, cc),
      // tombstone: delete then a late edit must NOT resurrect
      ev.cardDelete(C2, b),
      ev.cardEdit(C2, { title: 'late edit, must vanish' }, cc),
      // comment on the deleted card: legitimate, stays referentially valid
      ev.commentCreate('cccccccc-1111-4c11-8c11-111111111111', C2, 'on a deleted card', cc),
    ];
    f.push({ name: 'conflicts-tombstones', description: '3 devices: LWW same-field, multi-field survival, register last-wins, terminal delete, comment-on-deleted', events });
  }

  // ---- fixture 3: offline merge — union in "wrong" order still converges --
  {
    const a = fixedClock(DEV_A, 1000, 10);
    const b = fixedClock(DEV_B, 2000, 10);
    const L1 = 'dddddddd-1111-4d11-8d11-111111111111';
    const C1 = 'dddddddd-2222-4d22-8d22-222222222222';
    const events = [
      ev.listCreate(L1, 'list', 1000, a),
      ev.cardCreate(C1, L1, 'card', 1000, a),
      ev.cardEdit(C1, { pos: 500 }, a),
      ev.cardAssign(C1, 'scribe', true, b),
    ];
    // deliberately scrambled + duplicated: fold must be arrival-order independent
    const scrambled = [events[2], events[0], events[2], events[3], events[1], events[3]];
    f.push({ name: 'offline-merge', description: 'scrambled arrival + duplicates: fold equals canonical order', events: scrambled });
  }

  return f;
}

let n = 0;
for (const fx of fixtures()) {
  const state = foldBoard(fx.events);
  const inv = checkInvariants(state);
  if (!inv.ok) throw new Error(`fixture ${fx.name}: reference fold violates invariants: ${JSON.stringify(inv.problems)}`);
  const doc = {
    description: fx.description,
    // events as they would arrive on the wire (the C++ side ingests these)
    events: fx.events,
    // canonical expected fold — the C++ mirror must serialize identically
    expectedState: JSON.parse(canonical(state)),
  };
  writeFileSync(join(OUT, `${fx.name}.json`), JSON.stringify(doc, null, 2) + '\n');
  n++;
  console.log(`  ${fx.name}: ${fx.events.length} events -> expected fold written`);
}
console.log(`  ${n} golden fixtures in module/tests/golden/`);
