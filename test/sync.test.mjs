// Two replicas, mutually peered, over the HTTP transport seam. The point is not
// that bytes moved: it is that after syncing, both replicas fold to the SAME state
// from different event orders and different seq numbers, which is the property the
// whole design rests on. If this passes with the HTTP seam, swapping in a Logos
// reliable-channel transport later has one job: move the same two batches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clock } from '../contract/hlc.mjs';
import { ev } from '../contract/events.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const BOARD = 'aaaaaaaa-1111-4a11-8a11-111111111111';
const LIST = '11111111-1111-4111-8111-111111111111';
const CARD_A = '22222222-2222-4222-8222-222222222222';
const CARD_B = '33333333-3333-4333-8333-333333333333';

let port = 18600;
function start(stateDir, peerUrl) {
  port += 1;
  const p = spawn('node', [join(ROOT, 'server', 'server.mjs')], {
    env: {
      ...process.env, SHROOMS_BOARD_STATE: stateDir, SHROOMS_BOARD_PORT: String(port),
      SHROOMS_BOARD_HOST: '127.0.0.1', SHROOMS_BOARD_SYNC_MS: '300',
      ...(peerUrl ? { SHROOMS_BOARD_PEERS: peerUrl } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  const ready = new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    p.stdout.on('data', (d) => { out += d; if (out.includes('shrooms-board on')) { clearTimeout(t); resolve(); } });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => { clearTimeout(t); reject(new Error(`server exited ${c}: ${out}`)); });
  });
  return { p, base, ready };
}
const get = async (base, path) => (await fetch(base + path)).json();
const post = async (base, path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
// compare only what the fold is FOR: the boards and their contents
const shape = (s) => JSON.stringify({
  boards: s.boards, deleted_boards: s.deleted_boards,
  lists: s.lists, cards: s.cards, comments: s.comments,
});
async function waitFor(fn, what, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('two replicas converge, in both directions, over the transport seam', async (t) => {
  const dirA = mkdtempSync(join(tmpdir(), 'board-A-'));
  const dirB = mkdtempSync(join(tmpdir(), 'board-B-'));
  // A knows B, B knows A: a mutual peer pair, which is the smallest gossip topology.
  let A = start(dirA);
  await A.ready;
  let B = start(dirB, A.base);
  await B.ready;
  // now that B has a port, tell A about B (restart A with the peer configured)
  A.p.kill('SIGTERM'); await new Promise((r) => A.p.on('exit', r));
  A = start(dirA, B.base); await A.ready;

  try {
    const clockA = new Clock('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const clockB = new Clock('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    // A authors a board with a list and one card
    const w1 = await post(A.base, '/events', { events: [
      ev.boardCreate(BOARD, 'Shared', 1000, clockA),
      ev.listCreate(LIST, 'Today', 1000, clockA, BOARD),
      ev.cardCreate(CARD_A, LIST, 'from A', 1000, clockA, BOARD),
    ] });
    assert.equal(w1.status, 202, JSON.stringify(w1.body));

    // B must come to see A's work without anyone copying a file
    await waitFor(async () => (await get(B.base, `/boards/${BOARD}/state`)).cards?.length === 1,
      "B to pull A's card");

    // B authors a card of its own
    const w2 = await post(B.base, '/events', { event: ev.cardCreate(CARD_B, LIST, 'from B', 2000, clockB, BOARD) });
    assert.equal(w2.status, 202, JSON.stringify(w2.body));

    // and A must come to see B's
    await waitFor(async () => (await get(A.base, `/boards/${BOARD}/state`)).cards?.length === 2,
      "A to pull B's card");

    // the real assertion: same fold on both, from different orders and seqs
    const sa = await get(A.base, '/state');
    const sb = await get(B.base, '/state');
    assert.equal(shape(sa), shape(sb), 'both replicas fold to the same board');
    assert.equal(sa.cards.length, 2);
    assert.deepEqual(sa.cards.map((c) => c.title).sort(), ['from A', 'from B']);
    assert.deepEqual(sa.invariants.problems || [], []);

    // no silent sync: /peers must show a clean, recent sync
    const pa = await get(A.base, '/peers');
    assert.equal(pa.peers.length, 1);
    assert.equal(pa.peers[0].lastError, null, 'A reports no sync error');
    assert.ok(pa.peers[0].pull > 0, 'A has consumed events from B');

    // B restarts: the log AND the cursors survive, so it does not start over
    B.p.kill('SIGTERM'); await new Promise((r) => B.p.on('exit', r));
    B = start(dirB, A.base); await B.ready;
    const after = await get(B.base, '/state');
    assert.equal(shape(after), shape(sa), 'B folds the same state after a restart');
    const pb = await get(B.base, '/peers');
    assert.ok(pb.peers[0].pull > 0, 'the pull cursor survived the restart');

    // a third write still converges after both restarts
    const w3 = await post(A.base, '/events', { event: ev.cardCreate('44444444-4444-4444-8444-444444444444', LIST, 'after restart', 3000, clockA, BOARD) });
    assert.equal(w3.status, 202);
    await waitFor(async () => (await get(B.base, `/boards/${BOARD}/state`)).cards?.length === 3,
      'B to pull the post-restart card');
    assert.equal(shape(await get(A.base, '/state')), shape(await get(B.base, '/state')));
  } finally {
    A.p.kill('SIGTERM'); B.p.kill('SIGTERM');
  }
});
