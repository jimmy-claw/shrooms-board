// The read-only bridge, tested by execution. The task store is fake, so every rule in
// docs/task-bridge.md can be stated and broken on purpose: idempotence, the source
// version, no clock-derived writes, the offline case, queued, unknown, and that the
// bridge's writes actually survive the fold's ownership gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldBoard } from '../engine/engine.mjs';
import { ev } from '../contract/events.mjs';
import { BRIDGE_DEV } from '../engine/engine.mjs';
import {
  createBridge, planReflection, projectTask, stateOf, parseRef, normalizeTask, taskMessageId,
} from '../bridge/reflect.mjs';

const CARD = 'dddddddd-1111-4d11-8d11-111111111111';
const LIST = 'cccccccc-1111-4c11-8c11-111111111111';
const REF = 'pi5/pi5.default:board-card-abc123';
const TASK = (over = {}) => ({
  message_id: 'board-card-abc123', state: 'working', updated: '2026-10-09T04:00:00Z',
  started: '2026-10-09T04:00:01Z', acked: false, ...over,
});

const card = (over = {}) => ({ id: CARD, board_id: 'default', task_ref: REF, task: null, ...over });

// ---- the shape of the REAL store (captured from the live agent, not assumed) -------
//
// An end-to-end run against the live store caught this, and no unit test could have:
// `status.message.messageId` is the *status* message's id and ends in `-status`, so
// using it as the join key made every card read `unknown`. The task id is
// `<session>:<messageId>`, and the part after the first colon is the only correct
// source. This fixture is the real shape, trimmed.
const REAL_TASK = {
  id: 'jimmy:cli-20261008T082932-fcfae41b6ccf0517',
  contextId: '01a091ff-b255-7405-9f43-25e3416cb05e',
  status: {
    state: 'TASK_STATE_COMPLETED',
    message: { messageId: 'cli-20261008T082932-fcfae41b6ccf0517-status', role: 'agent' },
    timestamp: '2026-10-08T09:01:05.102305419Z',
  },
  metadata: { 'shrooms/acknowledged': false, 'shrooms/stalled': false, 'shrooms/queued': false },
};

test('the join key is the task id, NOT the status message id', () => {
  const n = normalizeTask(REAL_TASK);
  assert.equal(n.message_id, 'cli-20261008T082932-fcfae41b6ccf0517');
  assert.notEqual(n.message_id, REAL_TASK.status.message.messageId,
    'the status message id has a -status suffix and is not the task');
  assert.equal(n.state, 'completed');
  assert.equal(n.updated, '2026-10-08T09:01:05.102305419Z');
  assert.equal(n.acked, false);
  assert.equal(n.started, true);
});

test('queued and stalled come from metadata, and queued wins over submitted', () => {
  const q = normalizeTask({
    ...REAL_TASK,
    status: { ...REAL_TASK.status, state: 'TASK_STATE_SUBMITTED' },
    metadata: { 'shrooms/queued': true },
  });
  assert.equal(stateOf(q), 'queued');
  const st = normalizeTask({ ...REAL_TASK, metadata: { 'shrooms/stalled': true } });
  assert.equal(st.stalled, true);
});

test('a task with no derivable message id yields none (so the caller can drop it)', () => {
  assert.equal(taskMessageId({ id: '', status: {} }), '');
  assert.equal(taskMessageId({ status: { message: { messageId: 'x-status' } } }), 'x');
});

test('the task id WINS when the two disagree', () => {
  // On the real shape both paths agree (the status id is the task id plus `-status`),
  // so the precedence is invisible - and a mutant that prefers the status message id
  // passes every other test. This pins the intent: the status message is ABOUT the
  // task, so it can never be the task's identity.
  assert.equal(taskMessageId({
    id: 'jimmy:cli-REAL',
    status: { message: { messageId: 'cli-OTHER-status' } },
  }), 'cli-REAL');
});

// ---- the two cases that were missing, found by mutation --------------------------

test('a newer timestamp with an UNCHANGED value writes nothing (a nudge bumps it)', () => {
  // The task store bumps `updated` when a nudge touches a task, without anything having
  // happened. If the equality check includes `at`, every bump looks like a change and
  // the bridge writes an edit per card per bump - and the log IS the dataset, so it
  // grows forever. Deleting the guard in `sameTask` did not fail the suite until this
  // test existed.
  const cards = [card({ task: { state: 'working', ack: 'pending', at: '2026-10-09T04:00:00Z' } })];
  const tasksByRef = new Map([[REF, TASK({ updated: '2026-10-09T04:30:00Z' })]]);
  const plan = planReflection(cards, { tasksByRef, polledMachines: new Set(['pi5']) });
  assert.equal(plan.length, 0, 'a bump with the same state and ack must not write');
});

test('a state change inside the same millisecond is not dropped', () => {
  // shrooms-agent timestamps have nanosecond precision (…05.102305419Z). Date.parse
  // truncates to milliseconds, so a real change a nanosecond later compares EQUAL and
  // the newer write is rejected as stale - the card would sit on the old state forever.
  const cards = [card({ task: { state: 'working', ack: 'pending', at: '2026-10-09T04:00:00.000000000Z' } })];
  const tasksByRef = new Map([[REF, TASK({ state: 'completed', updated: '2026-10-09T04:00:00.000000001Z' })]]);
  const plan = planReflection(cards, { tasksByRef, polledMachines: new Set(['pi5']) });
  assert.equal(plan.length, 1, 'millisecond truncation would have missed this change');
  assert.equal(plan[0].task.state, 'completed');
});

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
