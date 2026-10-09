// Dispatch: the order is the point. The review found that sending first and writing
// task_ref from the reply duplicates the work on a crash, so these tests pin the ORDER,
// not just the result - and pin that a retry is the SAME task.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDispatcher, dispatchMessageId, dispatchRef, dispatchText,
} from '../bridge/dispatch.mjs';
import { BRIDGE_DEV } from '../engine/engine.mjs';
import { foldBoard } from '../engine/engine.mjs';

const CARD = { id: 'dddddddd-1111-4d11-8d11-111111111111', board_id: 'board-a',
               title: 'Rotate the leaked tokens', desc: 'the two GitHub ones' };
const EVENT = 'eeeeeeee-2222-4e22-8e22-222222222222';

function harness({ sendFails = false } = {}) {
  const calls = [];
  const events = [];
  const d = createDispatcher({
    send: async (args) => {
      calls.push({ kind: 'send', ...args });
      if (sendFails) throw new Error('unreachable');
      return { task: { id: `${args.session}:${args.messageId}` } };
    },
    appendEvents: (evs) => {
      calls.push({ kind: 'append', n: evs.length });
      events.push(...evs);
    },
    log: () => {},
  });
  return { d, calls, events };
}

test('writes the link BEFORE sending - the whole point of the order', async () => {
  const h = harness();
  await h.d.dispatch({ card: CARD, machine: 'pi5', session: 'jimmy', dispatchEventId: EVENT });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].kind, 'append', 'the link must be written first');
  assert.equal(h.calls[1].kind, 'send', 'the send comes second');
});

test('the ref is on the card, and it is machine/session:messageId', async () => {
  const h = harness();
  const r = await h.d.dispatch({ card: CARD, machine: 'pi5', session: 'jimmy', dispatchEventId: EVENT });
  assert.equal(r.ref, `pi5/jimmy:${r.messageId}`);
  assert.equal(r.ref, h.events[0].payload.fields.task_ref);
  assert.equal(h.events[0].hlc.dev, BRIDGE_DEV, 'attributable to the bridge');
  assert.equal(h.events[0].payload.board_id, 'board-a');
  assert.equal(h.events[0].type, 'card.edit');
});

test('the messageId is derived from the card and the dispatch request, so a retry is the same task', async () => {
  const h1 = harness();
  const a = await h1.d.dispatch({ card: CARD, machine: 'pi5', session: 'jimmy', dispatchEventId: EVENT });
  const h2 = harness();
  const b = await h2.d.dispatch({ card: CARD, machine: 'pi5', session: 'jimmy', dispatchEventId: EVENT });
  assert.equal(a.messageId, b.messageId, 'the same request must reuse the messageId, not make a new task');
  assert.equal(h1.calls[1].messageId, h1.calls[1].messageId);
});

test('a different dispatch request makes a different task (a new request is a new turn)', async () => {
  const h = harness();
  const a = await h.d.dispatch({ card: CARD, machine: 'pi5', session: 'jimmy', dispatchEventId: EVENT });
  const b = await h.d.dispatch({ card: CARD, machine: 'pi5', session: 'jimmy', dispatchEventId: 'ffffffff-3333-4f33-8f33-333333333333' });
  assert.notEqual(a.messageId, b.messageId);
});

test('a failed send is not fatal: the link stays, and a retry reuses the same task', async () => {
  const h = harness({ sendFails: true });
  const r = await h.d.dispatch({ card: CARD, machine: 'pi5', session: 'jimmy', dispatchEventId: EVENT });
  assert.equal(r.sent, false);
  assert.equal(h.events.length, 1, 'the link is still written');
  const again = harness({ sendFails: true });
  const r2 = await again.d.dispatch({ card: CARD, machine: 'pi5', session: 'jimmy', dispatchEventId: EVENT });
  assert.equal(r.ref, r2.ref, 'a retry must target the same task, not a second one');
});

test('the link survives the fold, and it is the ref that was sent', async () => {
  const h = harness();
  const r = await h.d.dispatch({ card: CARD, machine: 'pi5', session: 'jimmy', dispatchEventId: EVENT });
  const created = [{ type: 'card.create', id: 'x1', hlc: h.events[0].hlc,
                     payload: { id: CARD.id, board_id: 'board-a', list_id: 'l', title: CARD.title, pos: 1 } }];
  const folded = foldBoard([...created, ...h.events]);
  assert.equal(folded.cards[0].task_ref, r.ref);
  assert.equal(h.calls[1].text.includes(CARD.id), true, 'the agent is told which card');
  assert.equal(h.calls[1].text.includes('Rotate the leaked tokens'), true);
});

test('the text carries the card id, title and description', () => {
  const t = dispatchText(CARD);
  assert.ok(t.includes(CARD.id));
  assert.ok(t.includes('Rotate the leaked tokens'));
  assert.ok(t.includes('the two GitHub ones'));
});

test('refuses to dispatch without a machine or a session', async () => {
  const h = harness();
  await assert.rejects(() => h.d.dispatch({ card: CARD, machine: '', session: 'jimmy', dispatchEventId: EVENT }));
  await assert.rejects(() => h.d.dispatch({ card: CARD, machine: 'pi5', session: '', dispatchEventId: EVENT }));
  assert.equal(h.calls.length, 0, 'nothing is written and nothing is sent');
});

test('dispatchMessageId refuses junk instead of inventing an id', () => {
  assert.throws(() => dispatchMessageId('', EVENT));
  assert.throws(() => dispatchMessageId(CARD.id, ''));
  // the id is normalised to alphanumerics, so it is `board-<12 of the card>-<8 of the request>`
  assert.equal(dispatchMessageId(CARD.id, EVENT), 'board-dddddddd1111-eeeeeeee');
  assert.equal(dispatchMessageId('a b/c:d', 'e f'), 'board-abcd-ef');
});
