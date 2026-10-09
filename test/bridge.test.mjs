// The read-only bridge, tested by execution. The task store is fake, so every rule in
// docs/task-bridge.md can be stated and broken on purpose: idempotence, the source
// version, no clock-derived writes, the offline case, queued, unknown, and that the
// bridge's writes actually survive the fold's ownership gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldBoard } from '../engine/engine.mjs';
import { ev } from '../contract/events.mjs';
import { BRIDGE_DEV } from '../engine/engine.mjs';
import { createBridge, planReflection, projectTask, stateOf, parseRef } from '../bridge/reflect.mjs';

const CARD = 'dddddddd-1111-4d11-8d11-111111111111';
const LIST = 'cccccccc-1111-4c11-8c11-111111111111';
const REF = 'pi5/pi5.default:board-card-abc123';
const TASK = (over = {}) => ({
  message_id: 'board-card-abc123', state: 'working', updated: '2026-10-09T04:00:00Z',
  started: '2026-10-09T04:00:01Z', acked: false, ...over,
});

const card = (over = {}) => ({ id: CARD, board_id: 'default', task_ref: REF, task: null, ...over });

// ---- the projection -------------------------------------------------------------

test('projects state, ack and the store timestamp', () => {
  const p = projectTask(TASK());
  assert.equal(p.state, 'working');
  assert.equal(p.ack, 'pending');
  assert.equal(p.at, '2026-10-09T04:00:00Z');
  assert.equal(p.stalled, undefined);
});

test('submitted with no started is queued', () => {
  assert.equal(stateOf(TASK({ state: 'submitted', started: undefined })), 'queued');
  assert.equal(stateOf(TASK({ state: 'submitted' })), 'submitted', 'started set -> not queued');
  assert.equal(stateOf(TASK({ state: 'submitted', started: '' })), 'queued');
});

test('a stalled task carries stalled; an acked one says so', () => {
  const p = projectTask(TASK({ stalled: true, acked: true }));
  assert.equal(p.stalled, true);
  assert.equal(p.ack, 'acked');
});

test('a ref the store does not know projects as unknown', () => {
  assert.deepEqual(projectTask(null), { state: 'unknown' });
});

test('parseRef splits machine, session and message id', () => {
  assert.deepEqual(parseRef('pi5/pi5.default:board-x'), { machine: 'pi5', session: 'pi5.default', messageId: 'board-x' });
  assert.equal(parseRef('nonsense'), null);
});

// ---- the rules ------------------------------------------------------------------

test('first observation writes the projected task', () => {
  const plan = planReflection([card()], {
    tasksByRef: new Map([[REF, TASK()]]), polledMachines: new Set(['pi5']),
  });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].task, { state: 'working', ack: 'pending', at: '2026-10-09T04:00:00Z' });
});

test('idempotent: the same observation a second time writes nothing', () => {
  const cur = card({ task: { state: 'working', ack: 'pending', at: '2026-10-09T04:00:00Z' } });
  const plan = planReflection([cur], {
    tasksByRef: new Map([[REF, TASK()]]), polledMachines: new Set(['pi5']),
  });
  assert.equal(plan.length, 0);
});

test('the source version: an OLDER timestamp never overwrites a newer one', () => {
  const cur = card({ task: { state: 'completed', ack: 'pending', at: '2026-10-09T04:05:00Z' } });
  const plan = planReflection([cur], {
    tasksByRef: new Map([[REF, TASK({ state: 'working', updated: '2026-10-09T04:00:00Z' })]]),
    polledMachines: new Set(['pi5']),
  });
  assert.equal(plan.length, 0, 'a late poller must not move the card backwards');
});

test('a newer timestamp with a changed value writes', () => {
  const cur = card({ task: { state: 'working', ack: 'pending', at: '2026-10-09T04:00:00Z' } });
  const plan = planReflection([cur], {
    tasksByRef: new Map([[REF, TASK({ state: 'completed', updated: '2026-10-09T04:05:00Z' })]]),
    polledMachines: new Set(['pi5']),
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].task.state, 'completed');
});

test('an offline machine writes nothing and keeps the last value', () => {
  const cur = card({ task: { state: 'working', ack: 'pending', at: '2026-10-09T04:00:00Z' } });
  const plan = planReflection([cur], { tasksByRef: new Map(), polledMachines: new Set() });
  assert.equal(plan.length, 0);
});

test('a ref the polled store does not know becomes unknown, once', () => {
  const plan = planReflection([card()], { tasksByRef: new Map(), polledMachines: new Set(['pi5']) });
  assert.deepEqual(plan[0].task, { state: 'unknown' });
  const again = planReflection([card({ task: { state: 'unknown' } })], {
    tasksByRef: new Map(), polledMachines: new Set(['pi5']),
  });
  assert.equal(again.length, 0, 'unknown must not churn');
});

test('a card with no task_ref is never touched', () => {
  const plan = planReflection([card({ task_ref: null })], {
    tasksByRef: new Map([[REF, TASK()]]), polledMachines: new Set(['pi5']),
  });
  assert.equal(plan.length, 0);
});

// ---- the poller -----------------------------------------------------------------

test('polls once per machine+session, not once per card', async () => {
  const cards = [card(), card({ id: 'eeeeeeee-1111-4e11-8e11-111111111111' })];
  const calls = [];
  const b = createBridge({
    readCards: () => cards,
    listTasks: async ({ machine, session }) => { calls.push(machine + '/' + session); return [TASK()]; },
    emit: () => {},
  });
  await b.tick();
  assert.deepEqual(calls, ['pi5/pi5.default'], 'two cards, one ref -> one request');
});

test('a failing poll is logged, not thrown, and the tick continues', async () => {
  const logs = [];
  const b = createBridge({
    readCards: () => [card()],
    listTasks: async () => { throw new Error('offline'); },
    emit: () => {},
    log: (m) => logs.push(m),
  });
  const plan = await b.tick();
  assert.equal(plan.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /offline/);
});

test('emits with the bridge dev, so the fold accepts the write', async () => {
  let emitted = null;
  const b = createBridge({
    readCards: () => [card()],
    listTasks: async () => [TASK()],
    emit: (plan, dev) => { emitted = { plan, dev }; },
  });
  await b.tick();
  assert.equal(emitted.dev, BRIDGE_DEV);
  assert.equal(emitted.plan.length, 1);
});

// ---- end to end through the fold ------------------------------------------------

test('the emitted write survives the fold, and a forged one does not', () => {
  const clock = (dev, wall) => ({ dev, send: () => ({ wall, ctr: 0, dev }) });
  const human = clock('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1000);
  const bridge = clock(BRIDGE_DEV, 2000);
  const forger = clock('dddddddddddddddddddddddddddddddd', 3000);
  const events = [
    ev.listCreate(LIST, 'To Do', 1000, human),
    ev.cardCreate(CARD, LIST, 'a dispatched card', 1000, human),
    ev.cardEdit(CARD, { task_ref: REF }, human),
    ev.cardEdit(CARD, { task: { state: 'working', ack: 'pending', at: '2026-10-09T04:00:00Z' } }, bridge),
    // a forged task with a LATER HLC: the gate must ignore it at write time
    ev.cardEdit(CARD, { task: { state: 'canceled', ack: 'acked', at: '2026-10-09T23:59:00Z' } }, forger),
  ];
  const st = foldBoard(events);
  const c = st.cards.find((x) => x.id === CARD);
  assert.equal(c.task_ref, REF);
  assert.deepEqual(c.task, { state: 'working', ack: 'pending', at: '2026-10-09T04:00:00Z' },
    'the bridge value stands; the forgery never entered the register');
});
