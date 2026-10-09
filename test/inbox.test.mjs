// The inbox: the fleet's real tasks on the board. The rule that matters is that a card is
// created for OPEN work and never backfilled for history - otherwise 50 finished tasks bury
// the live ones, which is the opposite of the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planInbox, inboxTitle, isOpen, INBOX_BOARD } from '../bridge/inbox.mjs';
import { normalizeTask } from '../bridge/reflect.mjs';

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
  // was 'pi5.default (pi5/jimmy) → atlas' - a device claim on one side and a session on the
  // other. Both sides are sessions now.
  assert.equal(inboxTitle(open()), 'jimmy → atlas');
  assert.equal(inboxTitle(open({ summary: 'reviewed PR 181' })), 'reviewed PR 181');
  assert.equal(inboxTitle({ id: 'x:y' }), 'task', 'nothing to say is honest');
  // the real bug: an EMPTY shrooms/from is falsy but is not a name
  assert.equal(inboxTitle({ from: '', session: 'jimmy', ref: 'pi5/jimmy:cli-1' }), 'pi5/jimmy:cli-1');
  assert.equal(inboxTitle({ from: 'pi5 (pi5/jimmy)', session: 'atlas' }), 'jimmy → atlas');
});

test('isOpen is not fooled by case or a missing state', () => {
  assert.equal(isOpen({ state: 'WORKING' }), true);
  assert.equal(isOpen({ state: 'Completed' }), false);
  assert.equal(isOpen({}), false, 'no state is not "open" - do not invent work');
});

// ---- the columns: the state IS the column, on the bridge's own board only -------------

import { COLUMNS, columnFor, planColumns, isTerminal, planTitles, requesterSession } from '../bridge/inbox.mjs';

test('every state maps to a column', () => {
  const t = (over) => ({ state: 'working', ack: 'pending', stalled: false, ...over });
  assert.equal(columnFor(t({ state: 'submitted' })), 'tasks-queued');
  assert.equal(columnFor(t({ state: 'queued' })), 'tasks-queued');
  assert.equal(columnFor(t({ state: 'unknown' })), 'tasks-queued');
  assert.equal(columnFor(t({ state: 'working' })), 'tasks-working');
  assert.equal(columnFor(t({ state: 'input-required' })), 'tasks-needs-you');
  assert.equal(columnFor(t({ state: 'auth-required' })), 'tasks-needs-you');
  assert.equal(columnFor(t({ state: 'completed', ack: 'pending' })), 'tasks-unacked');
  assert.equal(columnFor(t({ state: 'completed', ack: 'acked' })), 'tasks-acked');
  assert.equal(columnFor(t({ state: 'failed', ack: 'pending' })), 'tasks-unacked');
});

test('stalled wins over the state name - a stalled "working" task needs a human', () => {
  assert.equal(columnFor({ state: 'working', ack: 'pending', stalled: true }), 'tasks-stalled');
  assert.equal(columnFor({ state: 'completed', ack: 'acked', stalled: true }), 'tasks-stalled');
});

test('a task with no state does not invent one', () => {
  assert.equal(columnFor(null), 'tasks-queued');
  assert.equal(columnFor({}), 'tasks-queued');
});

test('isTerminal is not fooled by case', () => {
  assert.equal(isTerminal('COMPLETED'), true);
  assert.equal(isTerminal('working'), false);
  assert.equal(isTerminal(''), false);
});

const card = (over = {}) => ({ id: 'c1', board_id: 'tasks', list_id: 'tasks-queued',
                               task_ref: 'pi5/s:t-1', ...over });
const polled = (state, over = {}) => new Map([['pi5/s:t-1', { state, ack: 'pending', stalled: false, ...over }]]);

test('moves a card whose task changed column', () => {
  const out = planColumns([card()], polled('working'));
  assert.equal(out.length, 1);
  assert.equal(out[0].list_id, 'tasks-working');
  assert.equal(out[0].card_id, 'c1');
});

test('does NOT move a card already in the right column (idempotent)', () => {
  assert.equal(planColumns([card({ list_id: 'tasks-working' })], polled('working')).length, 0);
});

test('NEVER moves a card on a human board', () => {
  const out = planColumns([card({ board_id: 'default' })], polled('working'));
  assert.equal(out.length, 0, 'the human owns their columns');
});

test('leaves a card alone when its task was not polled this tick', () => {
  assert.equal(planColumns([card()], new Map()).length, 0);
  assert.equal(planColumns([card()], new Map([['other/ref:x', { state: 'working' }]])).length, 0);
});

test('ignores cards with no link, and is deterministic', () => {
  assert.equal(planColumns([card({ task_ref: null })], polled('working')).length, 0);
  const a = planColumns([card({ id: 'b' }), card({ id: 'a' })], polled('working'));
  assert.deepEqual(a.map((x) => x.card_id), ['a', 'b']);
});

test('every column has an id and a title, and the ids are unique', () => {
  const ids = COLUMNS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of COLUMNS) { assert.ok(c.id); assert.ok(c.title); }
});


// ---- the title: the task's own words, not "who sent it to whom" -----------------------

test('the title is the task text, one line, truncated', () => {
  assert.equal(inboxTitle({ latest: 'Published to lan03 (updated versions)' }), 'Published to lan03 (updated versions)');
  assert.equal(inboxTitle({ latest: 'a\n\nb   c' }), 'a b c', 'newlines collapse');
  const long = inboxTitle({ latest: 'x'.repeat(200) });
  assert.equal(long.length, 90);
  assert.ok(long.endsWith('\u2026'));
});

test('the fallback names SESSIONS on both sides, not a device claim', () => {
  // the old bug: "laptop.default (laptop/SPEL) -> duet-kit" - device one side, session the other
  assert.equal(requesterSession({ from: 'laptop.default (laptop/SPEL)' }), 'SPEL');
  assert.equal(requesterSession({ from: 'pi5 (pi5/jimmy)' }), 'jimmy');
  assert.equal(requesterSession({ from: 'plain' }), 'plain');
  assert.equal(requesterSession({}), '');
  assert.equal(inboxTitle({ from: 'laptop.default (laptop/SPEL)', session: 'duet-kit' }), 'SPEL \u2192 duet-kit');
});

test('the ref is the last resort', () => {
  assert.equal(inboxTitle({ ref: 'pi5/jimmy:cli-1' }), 'pi5/jimmy:cli-1');
});

const tcard = (over = {}) => ({ id: 'c1', board_id: 'tasks', list_id: 'tasks-working',
                                task_ref: 'pi5/s:t-1', title: 'old', ...over });
const tpolled = (latest) => new Map([['pi5/s:t-1', { state: 'working', latest, ack: 'pending', session: 's' }]]);

test('retitles a card when the task says something new', () => {
  const out = planTitles([tcard()], tpolled('the task is doing a thing'));
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'the task is doing a thing');
});

test('does not rewrite a title that already matches (idempotent)', () => {
  assert.equal(planTitles([tcard({ title: 'same' })], tpolled('same')).length, 0);
});

test('NEVER retitles a card on a human board', () => {
  assert.equal(planTitles([tcard({ board_id: 'default' })], tpolled('new words')).length, 0);
});

test('leaves titles alone when the task was not polled', () => {
  assert.equal(planTitles([tcard()], new Map()).length, 0);
});

// ---- the REQUEST as the title ---------------------------------------------------------
// `latest` is the worker's reply, so titling by it made every card read like a status line
// ("Published to lan03...", "Your withdrawal arrived after..."). shrooms-agent master now
// returns the request as the task's A2A `history`; the title is that, and the reply goes
// underneath. Each machine needs the updated agent, so the fallback is what runs today.

test('the title is WHAT WAS ASKED, not the worker reply', () => {
  const task = { request: 'review the board app and report', latest: 'Published to lan03: 3 packages',
                 session: 'reviewer', from: 'pi5.default (pi5/jimmy)' };
  assert.equal(inboxTitle(task), 'review the board app and report');
});

test('with no request it falls back to the reply - every machine until its agent is updated', () => {
  assert.equal(inboxTitle({ latest: 'Published to lan03: 3 packages', session: 'publisher' }),
    'Published to lan03: 3 packages');
});

test('the request is read out of the A2A history, in the shape status.message uses', () => {
  const t = normalizeTask({
    status: { state: 'TASK_STATE_WORKING', timestamp: '2026-10-09T17:00:00Z',
              message: { parts: [{ text: 'working on it' }] } },
    history: [{ role: 'ROLE_USER', parts: [{ text: 'please review the module' }] }],
  });
  assert.equal(t.request, 'please review the module');
  assert.equal(t.latest, 'working on it', 'the reply is still carried, for underneath');
});

test('the history reader does not crash on a shape it has not seen', () => {
  // I could not verify the exact shape against a live agent - none had been updated - so the
  // reader accepts the reasonable variants rather than trusting one.
  const req = (h) => normalizeTask({ status: { state: 'TASK_STATE_WORKING' }, history: h }).request;
  assert.equal(req([{ role: 'user', text: 'bare text field' }]), 'bare text field');
  assert.equal(req([{ role: 'ROLE_USER', content: 'bare content field' }]), 'bare content field');
  assert.equal(req([{ role: 'ROLE_AGENT', parts: [{ text: 'not the request' }] },
                    { role: 'ROLE_USER', parts: [{ text: 'the request' }] }]), 'the request',
    'a non-user entry is skipped, not mistaken for the request');
  assert.equal(req(undefined), '', 'no history is empty, not a crash');
  assert.equal(req([]), '');
  assert.equal(req('not-an-array'), '');
  assert.equal(req([null, 42]), '');
});

test('a request longer than the card fits is truncated, not wrapped', () => {
  const long = 'x'.repeat(300);
  const out = inboxTitle({ request: long });
  assert.equal(out.length, 90, '89 chars plus the ellipsis');
  assert.ok(out.endsWith('\u2026'));
});

// ---- the asker NAMES the task ---------------------------------------------------------
// Agreed with the store's authors (shrooms 8da1adc): the asker sets a title, the receiving
// agent stores it and returns it as `shrooms/title` / `title`. Precedence on the board:
// that name, then the FIRST LINE of the request (history[0]), then today's text. The rollout
// has not happened, so on most machines only the last branch runs - which is why every
// fallback below is load-bearing rather than theoretical.

test('the name the asker gave wins over everything', () => {
  assert.equal(inboxTitle({ title: 'Basecamp app review', request: 'From Jimmy: please review...',
                            latest: 'Published to lan03' }), 'Basecamp app review');
});

test('the asker name is read from the metadata too, whichever an agent version fills', () => {
  const t1 = normalizeTask({ status: { state: 'TASK_STATE_WORKING' }, title: 'top level name' });
  const t2 = normalizeTask({ status: { state: 'TASK_STATE_WORKING' },
                             metadata: { 'shrooms/title': 'metadata name' } });
  assert.equal(t1.title, 'top level name');
  assert.equal(t2.title, 'metadata name');
  assert.equal(inboxTitle(t2), 'metadata name');
});

test('an empty or whitespace-only name falls through instead of making a blank card', () => {
  assert.equal(inboxTitle({ title: '   ', request: 'the real ask', latest: 'reply' }), 'the real ask');
  assert.equal(inboxTitle({ title: '', latest: 'reply' }), 'reply');
  assert.equal(inboxTitle({ title: null, latest: 'reply' }), 'reply');
});

test('the request contributes its FIRST LINE, not the whole multi-line ask', () => {
  const request = 'From Jimmy (pi5): please review the module\n\nIt has a read-only sync.\nSecond para.';
  assert.equal(inboxTitle({ request, latest: 'working' }), 'From Jimmy (pi5): please review the module');
});

test('the whole chain, in order, with each link removed in turn', () => {
  const full = { title: 'N', request: 'From X: ask', latest: 'reply', summary: 'sum',
                 session: 'reviewer', from: 'pi5.default (pi5/jimmy)' };
  assert.equal(inboxTitle(full), 'N');
  assert.equal(inboxTitle({ ...full, title: '' }), 'From X: ask');
  assert.equal(inboxTitle({ ...full, title: '', request: '' }), 'reply');
  assert.equal(inboxTitle({ ...full, title: '', request: '', latest: '' }), 'sum');
  assert.equal(inboxTitle({ ...full, title: '', request: '', latest: '', summary: '' }), 'jimmy \u2192 reviewer');
});
