// Orphan surfacing (docs/task-bridge.md §5, build order step 5).
//
// The rule that matters: a `task_ref` the log has seen on a card, which no VISIBLE card
// carries any more, is surfaced - and NOTHING is written. The card is a view; the
// obligation belongs to the task store and its asker, so an orphan is never cancelled and
// never cleared. Each of these cases is a way that could go wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Clock } from '../contract/hlc.mjs';
import { ev } from '../contract/events.mjs';
import { foldBoard } from '../engine/engine.mjs';
import { planOrphans, stillOwed } from '../bridge/orphans.mjs';

const DEV = 'a'.repeat(32);
const clock = () => new Clock(DEV, () => 0);

// A log with one list, and whatever cards the caller wants. Each step is a function of
// the clock so a card can be created and then deleted by the same device.
function build(steps) {
  const c = clock();
  const log = [ev.listCreate('L1', 'List', 1000, c)];
  for (const s of steps) log.push(...s(c));
  return log;
}

function orphans(log, tasksByRef) {
  const st = foldBoard(log);
  return planOrphans(log, { cards: st.cards, lists: st.lists, tasksByRef });
}

const linked = (c, id, ref, board) => [
  ev.cardCreate(id, 'L1', 'card ' + id, 1000, c, board),
  ev.cardEdit(id, { task_ref: ref }, c, board),
];

test('a card deleted while its task is linked surfaces the ref', () => {
  const log = build([(c) => [...linked(c, 'C1', 'atlas/atlas:m1'), ev.cardDelete('C1', c)]]);
  const o = orphans(log);
  assert.equal(o.length, 1);
  assert.equal(o[0].ref, 'atlas/atlas:m1');
  assert.equal(o[0].card_id, 'C1');
  assert.equal(o[0].board_id, 'default');
});

test('a ref still on a live card is not an orphan', () => {
  const log = build([(c) => linked(c, 'C1', 'atlas/atlas:m1')]);
  assert.equal(orphans(log).length, 0);
});

test('a card whose COLUMN was deleted is an orphan too - it renders nowhere', () => {
  // The card is still in the fold; only its list is gone, so no surface draws it. This
  // is the copy the delete-list dialog already promises ("cards in it stay").
  const log = build([(c) => [...linked(c, 'C1', 'atlas/atlas:m1'), ev.listDelete('L1', c)]]);
  const o = orphans(log);
  assert.equal(o.length, 1);
  assert.equal(o[0].ref, 'atlas/atlas:m1');
});

test('a ref a human UNLINKED is a decision, not an orphan', () => {
  const log = build([(c) => [
    ...linked(c, 'C1', 'atlas/atlas:m1'),
    ev.cardEdit('C1', { task_ref: null }, c),
    ev.cardDelete('C1', c),
  ]]);
  assert.equal(orphans(log).length, 0);
});

test('one task on two cards is not an orphan while either card is live', () => {
  const log = build([(c) => [
    ...linked(c, 'C1', 'atlas/atlas:m1'),
    ...linked(c, 'C2', 'atlas/atlas:m1'),
    ev.cardDelete('C1', c),
  ]]);
  assert.equal(orphans(log).length, 0);
});

test('one entry per ref even when two deleted cards carried it', () => {
  const log = build([(c) => [
    ...linked(c, 'C1', 'atlas/atlas:m1'),
    ...linked(c, 'C2', 'atlas/atlas:m1'),
    ev.cardDelete('C1', c),
    ev.cardDelete('C2', c),
  ]]);
  assert.equal(orphans(log).length, 1);
});

test('when two deleted cards carried the ref, the FIRST one in the log is named', () => {
  // Both cards are gone, so neither is "the" card; the answer has to be deterministic or
  // two replicas would report different card_ids for the same orphan. The log order (HLC)
  // decides, and the entry names the first.
  const log = build([(c) => [
    ...linked(c, 'C1', 'atlas/atlas:m1'),
    ...linked(c, 'C2', 'atlas/atlas:m1'),
    ev.cardDelete('C1', c),
    ev.cardDelete('C2', c),
  ]]);
  assert.equal(orphans(log)[0].card_id, 'C1');
});

test('a deleted card with no task linked is not an orphan', () => {
  const log = build([(c) => [
    ev.cardCreate('C1', 'L1', 'plain', 1000, c),
    ev.cardDelete('C1', c),
  ]]);
  assert.equal(orphans(log).length, 0);
});

test('a card deleted and RESTORED is not an orphan - it is visible again', () => {
  const log = build([(c) => [
    ...linked(c, 'C1', 'atlas/atlas:m1'),
    ev.cardDelete('C1', c),
    // restore is not an ev constructor; it is the same record shape.
    { v: 1, id: 'r1-' + '0'.repeat(28), type: 'card.restore',
      hlc: c.send(), dev: DEV, payload: { board_id: 'default', id: 'C1' } },
  ]]);
  assert.equal(orphans(log).length, 0);
});

test('a task we KNOW is finished is history, not an orphan', () => {
  const log = build([(c) => [...linked(c, 'C1', 'atlas/atlas:m1'), ev.cardDelete('C1', c)]]);
  const tasks = new Map([['atlas/atlas:m1', { state: 'completed' }]]);
  assert.equal(orphans(log, tasks).length, 0);
});

test('a task we know is still open is surfaced, with its state attached', () => {
  const log = build([(c) => [...linked(c, 'C1', 'atlas/atlas:m1'), ev.cardDelete('C1', c)]]);
  const tasks = new Map([['atlas/atlas:m1', { state: 'working', ack: 'pending' }]]);
  const o = orphans(log, tasks);
  assert.equal(o.length, 1);
  assert.equal(o[0].task.state, 'working');
});

test('an UNKNOWN task is surfaced - hiding it would drop the one thing this keeps', () => {
  const log = build([(c) => [...linked(c, 'C1', 'atlas/atlas:m1'), ev.cardDelete('C1', c)]]);
  const tasks = new Map([['atlas/atlas:m1', { state: 'unknown' }]]);
  assert.equal(orphans(log, tasks).length, 1);
});

test('stillOwed: an empty state is unknown, not finished (isOpen says false for it)', () => {
  assert.equal(stillOwed(null), true);
  assert.equal(stillOwed({ state: '' }), true);
  assert.equal(stillOwed({ state: 'unknown' }), true);
  assert.equal(stillOwed({ state: 'working' }), true);
  assert.equal(stillOwed({ state: 'completed' }), false);
  assert.equal(stillOwed({ state: 'failed' }), false);
});

test('the orphan carries the board it was deleted from', () => {
  const log = build([(c) => [
    ev.boardCreate('B2', 'Other', 2000, c),
    ...linked(c, 'C1', 'atlas/atlas:m1', 'B2'),
    ev.cardDelete('C1', c, 'B2'),
  ]]);
  const o = orphans(log);
  assert.equal(o.length, 1);
  assert.equal(o[0].board_id, 'B2');
});

test('the order is deterministic, so a fixture can pin it', () => {
  const mk = () => build([(c) => [
    ...linked(c, 'C1', 'b/b:m2'),
    ...linked(c, 'C2', 'a/a:m1'),
    ev.cardDelete('C1', c),
    ev.cardDelete('C2', c),
  ]]);
  const a = orphans(mk()).map((o) => o.ref);
  const b = orphans(mk()).map((o) => o.ref);
  assert.deepEqual(a, ['a/a:m1', 'b/b:m2']);
  assert.deepEqual(b, a);
});
