// Bridge step 4: the ack, from the board (docs/task-bridge.md, "Ack as an action").
//
// The ack is the one thing a human on the board has to be able to say BACK to the machine
// side, so it is the only place the human surface writes to the task store besides dispatch
// and cancel. Two things therefore need pinning, and neither is visible from a green UI:
//
//   1. the ENVELOPE. It must be A2A's `AckTask {id}` sent to the WORKER's agent, with the task
//      id `SESSION:MESSAGE-ID`. Get the method or the id wrong and the store never records it -
//      the button would look like it worked and the task would stay unacked forever.
//   2. that nothing is INFERRED. Moving a card must never ack a task; only an explicit click
//      may. So there is no automatic path to test - there is a route, and it is called once.
//
// A stub agent stands in for the worker, so the envelope can be read rather than assumed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clock } from '../contract/hlc.mjs';
import { parseRef } from '../bridge/reflect.mjs';
import { ev } from '../contract/events.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const BOARD = 'bbbbbbbb-1111-4b11-8b11-111111111111';
const LIST = '11111111-1111-4111-8111-111111111111';
const CARD = '22222222-2222-4222-8222-222222222222';
const BARE = '33333333-3333-4333-8333-333333333333';
// A machine that is a literal address, so the hub talks to it verbatim instead of appending
// the mesh suffix - that is what lets a stub stand in for a worker.
const WORKER = '127.0.0.1';
const REF = `${WORKER}/sess:msg-1`;

let boardPort = 19200;
function startBoard(stateDir, agentPort) {
  boardPort += 1;
  const p = spawn('node', [join(ROOT, 'server', 'server.mjs')], {
    env: {
      ...process.env,
      SHROOMS_BOARD_STATE: stateDir,
      SHROOMS_BOARD_PORT: String(boardPort),
      SHROOMS_BOARD_HOST: '127.0.0.1',
      SHROOMS_AGENT_PORT: String(agentPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${boardPort}`;
  const ready = new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    p.stdout.on('data', (d) => { out += d; if (out.includes('shrooms-board on')) { clearTimeout(t); resolve(); } });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => { clearTimeout(t); reject(new Error(`server exited ${c}: ${out}`)); });
  });
  return { p, base, ready };
}

/** A stub worker's agent: records every JSON-RPC body it is sent. */
function startAgent(reply) {
  const seen = [];
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(b); } catch { /* recorded as null */ }
      seen.push({ path: req.url, body: parsed });
      const body = reply
        ? reply(parsed)
        : { jsonrpc: '2.0', id: parsed && parsed.id,
            result: { task: { id: 'sess:msg-1', status: { state: 'TASK_STATE_COMPLETED' },
                              metadata: { 'shrooms/acknowledged': true } } } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port })));
}

const post = async (base, path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' },
                                       body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json() };
};

async function boardWithCard(agentPort, ref) {
  const dir = mkdtempSync(join(tmpdir(), 'board-ack-'));
  const { p, base, ready } = startBoard(dir, agentPort);
  await ready;
  const clock = new Clock('feedfacefeedfacefeedfacefeedface');
  const events = [
    ev.boardCreate(BOARD, 'Errands', 1000, clock),
    ev.listCreate(LIST, 'Today', 1000, clock, BOARD),
    ev.cardCreate(CARD, LIST, 'buy milk', 1000, clock, BOARD),
    ev.cardCreate(BARE, LIST, 'no task', 2000, clock, BOARD),
  ];
  if (ref) events.push(ev.cardEdit(CARD, { task_ref: ref }, clock, BOARD));
  await post(base, `/boards/${BOARD}/events`, { events });
  return { p, base };
}

test('the ack sends A2A `AckTask` to the WORKER, with the task id SESSION:MESSAGE-ID', async (t) => {
  const agent = await startAgent();
  const { p, base } = await boardWithCard(agent.port, REF);
  t.after(() => { p.kill(); agent.srv.close(); });

  const r = await post(base, `/boards/${BOARD}/cards/${CARD}/ack`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.acked, true);
  assert.equal(r.body.id, 'sess:msg-1');

  assert.equal(agent.seen.length, 1, 'exactly one call - an ack is not a broadcast');
  const sent = agent.seen[0];
  assert.equal(sent.path, '/a2a/sess', 'the WORKER session is the addressee');
  assert.equal(sent.body.method, 'AckTask', 'the method is what the store acts on');
  assert.deepEqual(sent.body.params, { id: 'sess:msg-1' },
    'the id is the TASK id, not the message id and not the ref');
});

test('the store is the authority: its answer is what comes back', async (t) => {
  const agent = await startAgent(() => ({
    jsonrpc: '2.0', id: 'ack-x',
    result: { task: { id: 'sess:msg-1', status: { state: 'TASK_STATE_FAILED' },
                      metadata: { 'shrooms/acknowledged': true } } },
  }));
  const { p, base } = await boardWithCard(agent.port, REF);
  t.after(() => { p.kill(); agent.srv.close(); });

  const r = await post(base, `/boards/${BOARD}/cards/${CARD}/ack`);
  assert.equal(r.status, 200);
  assert.equal(r.body.task.state, 'TASK_STATE_FAILED', 'the board reports what the store said');
  assert.equal(r.body.task.acked, true);
});

test('acking twice is harmless - no requestId needed, unlike dispatch', async (t) => {
  const agent = await startAgent();
  const { p, base } = await boardWithCard(agent.port, REF);
  t.after(() => { p.kill(); agent.srv.close(); });

  const a = await post(base, `/boards/${BOARD}/cards/${CARD}/ack`);
  const b = await post(base, `/boards/${BOARD}/cards/${CARD}/ack`);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200, 'the second click must not be an error');
  assert.equal(agent.seen.length, 2, 'and both reached the store - setting a flag is idempotent');
});

test('a card with no task linked is refused, and nothing is sent', async (t) => {
  const agent = await startAgent();
  const { p, base } = await boardWithCard(agent.port, null);
  t.after(() => { p.kill(); agent.srv.close(); });

  const r = await post(base, `/boards/${BOARD}/cards/${BARE}/ack`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no task linked/);
  assert.equal(agent.seen.length, 0, 'nothing to ack, nothing sent');
});

test('no such card is a 404, and nothing is sent', async (t) => {
  const agent = await startAgent();
  const { p, base } = await boardWithCard(agent.port, REF);
  t.after(() => { p.kill(); agent.srv.close(); });

  const r = await post(base, `/boards/${BOARD}/cards/does-not-exist/ack`);
  assert.equal(r.status, 404);
  assert.equal(agent.seen.length, 0);
});

test('an unreachable worker is a 502, not a silent success', async (t) => {
  // A port nobody listens on: the button must be able to say it failed.
  const agent = await startAgent();
  const deadPort = agent.port;
  agent.srv.close();
  const { p, base } = await boardWithCard(deadPort, REF);
  t.after(() => { p.kill(); });

  const r = await post(base, `/boards/${BOARD}/cards/${CARD}/ack`);
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.match(r.body.error, /could not ack/);
});

test('a JSON-RPC error from the store is a failure, not a success', async (t) => {
  const agent = await startAgent(() => ({ jsonrpc: '2.0', id: 'ack-x', error: { code: -32001, message: 'no such task' } }));
  const { p, base } = await boardWithCard(agent.port, REF);
  t.after(() => { p.kill(); agent.srv.close(); });

  const r = await post(base, `/boards/${BOARD}/cards/${CARD}/ack`);
  assert.equal(r.status, 502, 'the store said no; the board must not report acked');
  assert.match(r.body.error, /no such task/);
});

// The route guards `task_ref` before calling parseRef, so the defensiveness below is not
// reachable THROUGH the route - which is exactly why it needs its own test. Without this,
// removing it leaves the suite green (I checked: the mutation survived), and the next caller
// to pass a card's ref straight in would get a 500 instead of a "no".
test('parseRef answers "no" for a missing ref instead of throwing', () => {
  assert.equal(parseRef(undefined), null, 'a card with no task linked has no ref');
  assert.equal(parseRef(null), null);
  assert.equal(parseRef(''), null, 'an empty string is not a ref');
  assert.equal(parseRef('no-slash-here'), null, 'machine/session is required');
  assert.equal(parseRef('machine/session-with-no-colon'), null, 'a message id is required');
  assert.deepEqual(parseRef('atlas/duet-kit:msg-1'),
    { machine: 'atlas', session: 'duet-kit', messageId: 'msg-1' });
});

// The dispatch ENVELOPE is asserted here because this file has the stub agent that can read what
// was really sent. The card title must arrive as `shrooms/title` - the asker naming the task -
// or the title branch of the board's precedence chain is dead code on every dispatched card.
test('a dispatched card sends its title as the task NAME, in the metadata', async (t) => {
  const agent = await startAgent();
  const { p, base } = await boardWithCard(agent.port, null);
  t.after(() => { p.kill(); agent.srv.close(); });

  const r = await post(base, `/boards/${BOARD}/cards/${CARD}/dispatch`,
    { machine: WORKER, session: 'sess', requestId: 'req-1' });
  assert.equal(r.status, 202, JSON.stringify(r.body));

  const sent = agent.seen.find((s) => s.body && s.body.method === 'SendMessage');
  assert.ok(sent, 'the dispatch reached the agent');
  assert.equal(sent.body.params.message.metadata['shrooms/title'], 'buy milk',
    'the card title IS the task name');
  assert.equal(sent.body.params.message.metadata['shrooms/from'], 'shrooms-board',
    'and the sender claim is still there');
});
