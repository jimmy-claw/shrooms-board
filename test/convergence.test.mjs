// Convergence test — logos-multiwriter-sync decision #6, executed not claimed:
// N devices generate random offline edit streams; the union is folded in MANY
// shuffled arrival orders + injected duplicates; every trial must produce the
// identical state and satisfy the invariants oracle.
// Run: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Clock, compareHlc } from '../contract/hlc.mjs';
import { ev, DEFAULT_BOARD } from '../contract/events.mjs';
import { mergeEvents, foldBoard, checkInvariants, validateEvent } from '../engine/engine.mjs';

// Seeded RNG so failures reproduce exactly.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEVS = [
  'a'.repeat(32),
  'b'.repeat(32),
  'c'.repeat(32),
];

// Generate a random multi-device offline stream. Devices do NOT see each other's
// events while authoring (offline first, merge later) — the hard case.
function generateStream(seed, { devices = 3, steps = 120 } = {}) {
  const rng = mulberry32(seed);
  const clocks = DEVS.slice(0, devices).map((d) => new Clock(d, () => 0)); // fixed "time", ctr carries ordering
  const logs = DEVS.slice(0, devices).map(() => []);

  const listIds = [];
  const cardIds = [];
  const commentIds = [];

  for (let step = 0; step < steps; step++) {
    const di = Math.floor(rng() * devices);
    const clock = clocks[di];
    const log = logs[di];
    const roll = rng();
    if (roll < 0.12 || listIds.length === 0) {
      const id = randomUUID();
      listIds.push(id);
      log.push(ev.listCreate(id, `list-${listIds.length}`, Math.floor(rng() * 1e6), clock));
    } else if (roll < 0.4 || cardIds.length === 0) {
      const id = randomUUID();
      cardIds.push(id);
      const list = listIds[Math.floor(rng() * listIds.length)];
      log.push(ev.cardCreate(id, list, `card-${cardIds.length}`, Math.floor(rng() * 1e6), clock));
    } else if (roll < 0.5) {
      const id = listIds[Math.floor(rng() * listIds.length)];
      log.push(ev.listEdit(id, { title: `list-t${step}` }, clock));
    } else if (roll < 0.68) {
      const id = cardIds[Math.floor(rng() * cardIds.length)];
      const fields = {};
      if (rng() < 0.5) fields.title = `card-t${step}`;
      if (rng() < 0.3) fields.desc = `desc ${step}`;
      if (rng() < 0.3) fields.pos = Math.floor(rng() * 1e6);
      if (rng() < 0.2) fields.list_id = listIds[Math.floor(rng() * listIds.length)]; // move
      if (rng() < 0.2) fields.due = step % 2 ? null : 1760000000000 + step;
      if (Object.keys(fields).length) log.push(ev.cardEdit(id, fields, clock));
    } else if (roll < 0.8) {
      // per-actor register toggle: assign/unassign, sometimes twice (redelivery shape)
      const id = cardIds[Math.floor(rng() * cardIds.length)];
      const actor = DEVS[Math.floor(rng() * devices)];
      log.push(ev.cardAssign(id, actor, rng() < 0.6, clock));
    } else if (roll < 0.88) {
      const id = randomUUID();
      commentIds.push(id);
      const card = cardIds[Math.floor(rng() * cardIds.length)];
      log.push(ev.commentCreate(id, card, `comment ${step}`, clock));
    } else if (roll < 0.94) {
      const id = cardIds[Math.floor(rng() * cardIds.length)];
      log.push(ev.cardDelete(id, clock));
    } else if (commentIds.length) {
      const id = commentIds[Math.floor(rng() * commentIds.length)];
      log.push(ev.commentDelete(id, clock));
    } else {
      log.push(ev.boardRename(DEFAULT_BOARD, `board ${step}`, clock));
    }
  }
  return logs;
}

function shuffledCopy(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('mergeEvents: union by id — idempotent, commutative, associative', () => {
  const a = [{ id: '1', type: 'x', hlc: { wall: 1, ctr: 0, dev: 'a'.repeat(32) }, dev: 'a'.repeat(32), payload: {} }];
  const b = [{ id: '2', type: 'x', hlc: { wall: 2, ctr: 0, dev: 'a'.repeat(32) }, dev: 'a'.repeat(32), payload: {} }];
  const c = [{ id: '3', type: 'x', hlc: { wall: 3, ctr: 0, dev: 'a'.repeat(32) }, dev: 'a'.repeat(32), payload: {} }];
  const ab = mergeEvents(a, b);
  const ba = mergeEvents(b, a);
  assert.deepEqual(ab, ba);                 // commutative
  assert.deepEqual(mergeEvents(ab, ab), ab); // idempotent
  assert.deepEqual(mergeEvents(mergeEvents(a, b), c), mergeEvents(a, mergeEvents(b, c))); // associative
});

test('fold: edit-before-create is lenient; orphan edit ignored; delete terminal', () => {
  const dev = 'a'.repeat(32);
  const clock = new Clock(dev, () => 0);

  // (a) Early edit on a field the create does NOT set: the content survives.
  //     (Same-field would be superseded by the create's own LWW stamp — expected.)
  const eEditDesc = ev.cardEdit('card-1', { desc: 'kept from early edit' }, clock);
  const eCreate = ev.cardCreate('card-1', 'list-1', 'card', 1, clock); // later HLC, no desc
  assert.ok(compareHlc(eEditDesc.hlc, eCreate.hlc) < 0, 'edit genuinely sorts before create');
  const stateA = foldBoard([eCreate, eEditDesc]);
  const cardA = stateA.cards.find((c) => c.id === 'card-1');
  assert.ok(cardA, 'card exists; edit-before-create did not break the fold');
  assert.equal(cardA.desc, 'kept from early edit', 'early edit content survives the fold');

  // (b) Delete is terminal: a late edit (HLC after the delete) cannot resurrect.
  const eDelete = ev.cardDelete('card-1', clock);
  const eLateEdit = ev.cardEdit('card-1', { title: 'late edit' }, clock);
  assert.ok(compareHlc(eDelete.hlc, eLateEdit.hlc) < 0, 'late edit sorts after delete');
  const stateB = foldBoard([eCreate, eDelete, eLateEdit]);
  assert.equal(stateB.cards.length, 0, 'tombstoned card absent from the view');

  // (c) Orphan edit (no create at all) is ignored, not an error.
  const stateC = foldBoard([ev.cardEdit('ghost', { title: 'x' }, new Clock(dev, () => 0))]);
  assert.equal(stateC.cards.length, 0, 'orphan edit ignored');
});

test('assign register: same actor twice is one vote; different actors both survive', () => {
  const dev = 'a'.repeat(32);
  const clock = new Clock(dev, () => 0);
  const list = ev.listCreate('L1', 'todo', 1, clock);
  const card = ev.cardCreate('C1', 'L1', 'card', 1, clock);
  const a1 = ev.cardAssign('C1', 'a'.repeat(32), true, clock);
  const a2 = ev.cardAssign('C1', 'a'.repeat(32), true, clock); // redelivery of the same actor
  const a3 = ev.cardAssign('C1', 'b'.repeat(32), true, clock);
  const state = foldBoard([list, card, a1, a2, a3]);
  const card1 = state.cards.find((c) => c.id === 'C1');
  assert.equal(card1.assignees.length, 2, 'two distinct actors, no double count');
});

test('200-trial convergence: shuffled orders + duplicates -> identical state, invariants hold', () => {
  const TRIALS = 200;
  const ORDERS_PER_TRIAL = 4; // shuffles per stream, each + 5 duplicate redeliveries
  let totalEvents = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    const seed = 1000 + trial;
    const rng = mulberry32(seed);
    const logs = generateStream(seed);
    const all = mergeEvents(...logs);
    totalEvents = Math.max(totalEvents, all.length);

    for (const e of all) {
      const problems = validateEvent(e);
      assert.equal(problems.length, 0, `generated event invalid: ${problems.join('; ')}`);
    }

    // Reference: the canonical HLC-sorted fold of the union.
    const reference = JSON.stringify(foldBoard(all));
    const refInv = checkInvariants(JSON.parse(reference));
    assert.ok(refInv.ok, `trial ${trial}: reference state violates invariants: ${JSON.stringify(refInv.problems)}`);

    // Same edits, different arrival orders + redelivery — state must be identical.
    for (let k = 0; k < ORDERS_PER_TRIAL; k++) {
      let arrived = shuffledCopy(all, rng);
      for (let i = 0; i < 5; i++) {
        arrived.push(arrived[Math.floor(rng() * arrived.length)]);
      }
      const state = foldBoard(arrived);
      assert.equal(JSON.stringify(state), reference, `trial ${trial} order ${k}: state diverged`);
      const inv = checkInvariants(state);
      assert.ok(inv.ok, `trial ${trial} order ${k}: invariants violated: ${JSON.stringify(inv.problems)}`);
    }
  }
  assert.ok(totalEvents > 50, `stream too small to be meaningful (${totalEvents} events)`);
});

test('clock: receive-on-ingest keeps local events ordering after remote causes; prime from log', () => {
  const local = new Clock(DEVS[0], () => 1000);
  const remote = new Clock(DEVS[1], () => 5000);
  const remoteEvent = { ...ev.listCreate('L1', 'x', 1, remote) };

  // local authors BEFORE seeing the remote event
  const before = local.send();
  // ingest the remote event (advance past its cause)
  local.receive(remoteEvent.hlc);
  const after = local.send();
  assert.ok(compareHlc(after, remoteEvent.hlc) > 0, 'post-ingest stamp sorts after the cause');
  assert.ok(compareHlc(before, remoteEvent.hlc) < 0, 'pre-ingest stamp sorts before (expected)');

  // priming a fresh clock from a whole log must reproduce the same ordering safety
  const fresh = new Clock(DEVS[2], () => 1000);
  fresh.prime([remoteEvent]);
  const stamped = fresh.send();
  assert.ok(compareHlc(stamped, remoteEvent.hlc) > 0, 'primed clock sorts after the log cause');
});
