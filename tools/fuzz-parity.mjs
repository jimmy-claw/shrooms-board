// fuzz-parity.mjs — differential fuzz between the JS reference engine and the C++ board_core.
//
// Written by PROTEUS, the independent reviewer, during the review of 2026-10-09, and adopted
// here because it is the strongest evidence we have that the mirror holds: 200 random logs,
// each folded in JS and in C++ and compared byte-for-byte, including deliberate forgeries of
// the bridge-owned `task` field and HLC ties. It caught nothing - which is the point, and is
// only meaningful because the same generator DOES fail when a gate is removed (mutation).
//
// Method: generate random event logs, fold each with the JS reference (engine/engine.mjs), and write
// them out as golden fixtures in the format board_core/tests/test_parity.cpp already consumes. Then run
// test_parity against them: it folds the same events in C++ and requires byte-identical canonical JSON.
// Any FAIL is a concrete event sequence where the two disagree - which is what was asked for.
//
// Deliberately covered:
//   - the bridge-owned `task` field, written by BRIDGE_DEV (legitimate) and by non-bridge devs (forgery)
//   - `task_ref` (ungated), titles, desc, pos, list_id, due
//   - boards: create / rename / delete / restore, and cards on non-default boards
//   - tombstones, restore-after-delete, comments, per-actor registers
//   - HLC ties (same wall+ctr+dev, different events) and out-of-order arrival
//
// Usage: node fuzz-parity.mjs <repo> <outdir> <trials> [seed]
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, outdir, trialsArg, seedArg] = process.argv.slice(2);
const TRIALS = parseInt(trialsArg || '200', 10);
let seed = parseInt(seedArg || '1', 10);

const { Clock } = await import(pathToFileURL(join(repo, 'contract/hlc.mjs')).href);
const { ev } = await import(pathToFileURL(join(repo, 'contract/events.mjs')).href);
const { foldBoard, mergeEvents, BRIDGE_DEV } = await import(pathToFileURL(join(repo, 'engine/engine.mjs')).href);

// deterministic PRNG (mulberry32) so any failure can be reproduced from its seed
function rng() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rng() * a.length)];
const int = (n) => Math.floor(rng() * n);
const dev = () => [...Array(32)].map(() => '0123456789abcdef'[int(16)]).join('');

const STATES = ['submitted', 'queued', 'working', 'input-required', 'auth-required', 'completed', 'failed', 'canceled', 'rejected', 'stalled', 'expired', 'unknown'];
const ACKS = ['pending', 'acked'];

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

let written = 0;
const summaries = [];
for (let trial = 0; trial < TRIALS; trial++) {
  const startSeed = seed;
  const devices = [dev(), dev(), dev()];
  const clocks = new Map(devices.map((d) => [d, new Clock(d, () => 1000)]));
  const bridge = new Clock(BRIDGE_DEV, () => 1000);
  const clockFor = (d) => (d === BRIDGE_DEV ? bridge : clocks.get(d));

  const boards = ['board-default'];
  const lists = [];
  const cards = [];
  const comments = [];
  const events = [];

  const n = 4 + int(18);
  for (let i = 0; i < n; i++) {
    // occasionally forge: a non-bridge dev writing `task`
    const forger = rng() < 0.18 ? pick(devices) : BRIDGE_DEV;
    const c = clockFor(forger);
    const what = int(100);
    if (what < 6) {
      const id = 'board-' + int(4); events.push(ev.boardCreate(id, 'B' + int(9), (boards.length + 1) * 1000, c));
      if (!boards.includes(id)) boards.push(id);
    } else if (what < 10) {
      events.push(ev.boardRename(pick(boards), 'R' + int(9), c));
    } else if (what < 13) {
      events.push(ev.boardDelete(pick(boards), c));
    } else if (what < 15) {
      events.push(ev.boardRestore(pick(boards), c));
    } else if (what < 26) {
      const id = 'list-' + int(6); lists.push(id);
      events.push(ev.listCreate(id, 'L' + int(9), int(5) * 1000, c, pick(boards)));
    } else if (what < 34) {
      if (!lists.length) continue;
      const f = {}; if (rng() < 0.6) f.title = 'L' + int(9); if (rng() < 0.5) f.pos = int(9) * 1000;
      events.push(ev.listEdit(pick(lists), f, c, pick(boards)));
    } else if (what < 38) {
      if (!lists.length) continue;
      events.push(ev.listDelete(pick(lists), c, pick(boards)));
    } else if (what < 52) {
      if (!lists.length) continue;
      const id = 'card-' + int(8); cards.push(id);
      events.push(ev.cardCreate(id, pick(lists), 'C' + int(9), int(9) * 1000, c, pick(boards)));
    } else if (what < 78) {
      if (!cards.length) continue;
      const f = {};
      if (rng() < 0.4) f.title = 'T' + int(9);
      if (rng() < 0.3) f.desc = 'D' + int(9);
      if (rng() < 0.3) f.pos = int(9) * 1000;
      if (rng() < 0.3 && lists.length) f.list_id = pick(lists);
      if (rng() < 0.2) f.due = 1800000000000 + int(1000);
      // the two bridge-facing fields
      if (rng() < 0.45) {
        const t = { state: pick(STATES), ack: pick(ACKS), at: 1700000000000 + int(100000) };
        if (rng() < 0.3) t.stalled = true;
        f.task = t;
      }
      if (rng() < 0.3) f.task_ref = 'm' + int(3) + '/s' + int(3) + ':msg' + int(9);
      events.push(ev.cardEdit(pick(cards), f, c, pick(boards)));
    } else if (what < 82) {
      if (!cards.length) continue;
      events.push(ev.cardDelete(pick(cards), c, pick(boards)));
    } else if (what < 90) {
      if (!cards.length) continue;
      events.push(ev.cardAssign(pick(cards), 'actor' + int(3), rng() < 0.7, c, pick(boards)));
    } else if (what < 96) {
      if (!cards.length) continue;
      const id = 'cmt-' + int(6); comments.push(id);
      events.push(ev.commentCreate(id, pick(cards), 'x' + int(9), c, pick(boards)));
    } else {
      if (!comments.length) continue;
      events.push(ev.commentDelete(pick(comments), c, pick(boards)));
    }
  }
  // HLC ties: clone an event's hlc onto another, occasionally
  if (rng() < 0.25 && events.length >= 2) {
    const a = events[int(events.length)], b = events[int(events.length)];
    if (a && b && a !== b) b.hlc = { ...a.hlc };
  }

  const expected = foldBoard(events);
  const name = `fuzz-${String(trial).padStart(4, '0')}.json`;
  writeFileSync(join(outdir, name), JSON.stringify({
    description: `fuzz trial ${trial} (seed ${startSeed}) - ${events.length} events`,
    events, expectedState: expected,
  }, null, 1));
  written++;
  summaries.push([name, events.length]);
}
console.log(`  wrote ${written} fuzz fixtures to ${outdir}`);
console.log(`  (seed started at ${seedArg || 1}; each fixture records its own trial seed in the description)`);
