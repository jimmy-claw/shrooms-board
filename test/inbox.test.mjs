// The inbox: the fleet's real tasks on the board. The rule that matters is that a card is
// created for OPEN work and never backfilled for history - otherwise 50 finished tasks bury
// the live ones, which is the opposite of the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInbox, inboxTitle, isOpen, INBOX_BOARD } from '../bridge/inbox.mjs';

const open = (over = {}) => ({ message_id: 'm1', state: 'working', session: 'atlas', from: 'pi5.default (pi5/jimmy)', ...over });
const found = (ref, task) => ({ ref, task, machine: ref.split('/')[0] });

test('creates a card for an open task that has none', () => {
  const plan = planInbox([found('atlas/atlas:m1', open())], []);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].ref, 'atlas/atlas:m1');
  assert.equal(plan[0].boardId, INBOX_BOARD);
  assert.ok(plan[0].title.length > 0);
});

test('does NOT backfill terminal tasks - they are history', () => {
  for (const s of ['completed', 'failed', 'canceled', 'rejected', 'expired']) {
    assert.equal(planInbox([found('atlas/atlas:m1', open({ state: s }))], []).length, 0, s);
  }
});

test('every OPEN state does get a card, including queued and input-required', () => {
  for (const s of ['submitted', 'queued', 'working', 'input-required', 'auth-required']) {
    assert.equal(planInbox([found('atlas/atlas:m1', open({ state: s }))], []).length, 1, s);
  }
});

test('a task that already has a card is not duplicated', () => {
  const cards = [{ id: 'c1', board_id: 'default', task_ref: 'atlas/atlas:m1' }];
  assert.equal(planInbox([found('atlas/atlas:m1', open())], cards).length, 0);
});

test('the same task seen twice in one tick makes one card', () => {
  const plan = planInbox([found('atlas/atlas:m1', open()), found('atlas/atlas:m1', open())], []);
  assert.equal(plan.length, 1);
});

test('the order is deterministic, so a fixture can pin it', () => {
  const a = planInbox([found('b/b:x', open()), found('a/a:y', open())], []);
  const b = planInbox([found('a/a:y', open()), found('b/b:x', open())], []);
  assert.deepEqual(a.map((x) => x.ref), b.map((x) => x.ref));
  assert.deepEqual(a.map((x) => x.ref), ['a/a:y', 'b/b:x']);
});

test('the title prefers the requester over the raw id', () => {
  assert.equal(inboxTitle(open()), 'pi5.default (pi5/jimmy) → atlas');
  assert.equal(inboxTitle(open({ summary: 'reviewed PR 181' })), 'reviewed PR 181');
  assert.ok(inboxTitle({ id: 'x:y' }).includes('x:y'), 'falls back to the id');
});

test('isOpen is not fooled by case or a missing state', () => {
  assert.equal(isOpen({ state: 'WORKING' }), true);
  assert.equal(isOpen({ state: 'Completed' }), false);
  assert.equal(isOpen({}), false, 'no state is not "open" - do not invent work');
});
