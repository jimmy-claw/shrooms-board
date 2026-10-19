// Where an agent call goes: over this machine's unix socket, or over the mesh.
//
// Why this exists: shrooms-agent refuses an HTTP request from this machine's own mesh address
// with a 403 that says "use the agent's socket" (measured 19/10 17:18). The hub addressed every
// machine by mesh name, so after the agent restarted the board could not see the sessions on its
// OWN machine — 123 failed bridge polls — and dispatch/ack to a local session would have failed
// the same way. Each case below is one way that decision can be wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAgentPeer } from '../server/agentpeer.mjs';

const tmpSocket = () => join(mkdtempSync(join(tmpdir(), 'peer-')), 'agent.sock');

// a tiny agent on a unix socket: `reply` decides what it says
async function fakeAgent(sock, reply) {
  const srv = createServer((c) => {
    let buf = '';
    let done = false;
    const answer = () => {
      if (done) return;
      done = true;
      const { status, body } = reply(buf);
      c.write(`HTTP/1.1 ${status} X\r\ncontent-type: application/json\r\n` +
              `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
      c.end();
    };
    // an HTTP client sends headers (and any body) and then WAITS — it does not close its write
    // side, so waiting for 'end' here would never answer and every call would time out.
    c.on('data', (d) => { buf += d; setTimeout(answer, 5); });
  });
  await new Promise((r) => srv.listen(sock, r));
  return srv;
}

test('the machine itself is local; anyone else is not', () => {
  const p = makeAgentPeer({ self: 'pi5' });
  assert.equal(p.isLocal('pi5'), true);
  assert.equal(p.isLocal('atlas'), false);
  assert.equal(p.isLocal('laptop'), false);
  // a FQDN or a mesh name is a different string: it must not be treated as this machine
  assert.equal(p.isLocal('pi5.office.mesh'), false);
});

test('a local GET goes over the socket and never touches the mesh', async () => {
  const sock = tmpSocket();
  const seen = [];
  const srv = await fakeAgent(sock, (req) => {
    seen.push(req.split('\r\n')[0]);
    return { status: 200, body: JSON.stringify({ tasks: [{ id: 'a:1' }] }) };
  });
  let fetched = 0;
  const p = makeAgentPeer({
    self: 'pi5', socketPath: sock,
    fetchImpl: () => { fetched += 1; throw new Error('the mesh must not be used for this machine'); },
  });
  const d = await p.getJSON('pi5', '/v1/tasks?session=jimmy');
  assert.deepEqual(d, { tasks: [{ id: 'a:1' }] });
  assert.equal(fetched, 0, 'a mesh fetch was attempted for the local machine');
  assert.match(seen[0], /^GET \/v1\/tasks\?session=jimmy /);
  srv.close();
});

test('another machine goes over the mesh, with the address built from its name', async () => {
  const calls = [];
  const p = makeAgentPeer({
    self: 'pi5', meshSuffix: 'office.mesh', port: 7387,
    fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200,
      json: async () => ({ sessions: [{ name: 's' }] }) }; },
  });
  const d = await p.getJSON('atlas', '/v1/sessions');
  assert.deepEqual(d, { sessions: [{ name: 's' }] });
  assert.deepEqual(calls, ['http://atlas.office.mesh:7387/v1/sessions']);
});

test('a non-2xx over the socket is a FAILURE, not an empty answer', async () => {
  const sock = tmpSocket();
  const srv = await fakeAgent(sock, () => ({ status: 403, body: '{"error":"nope"}' }));
  const p = makeAgentPeer({ self: 'pi5', socketPath: sock, fetchImpl: () => { throw new Error('no'); } });
  await assert.rejects(() => p.getJSON('pi5', '/v1/sessions'), /403/);
  srv.close();
});

test('a local POST returns the status and body instead of swallowing them', async () => {
  const sock = tmpSocket();
  const srv = await fakeAgent(sock, () => ({ status: 200,
    body: '{"jsonrpc":"2.0","result":{"ok":true}}' }));
  const p = makeAgentPeer({ self: 'pi5', socketPath: sock, fetchImpl: () => { throw new Error('no'); } });
  const r = await p.postJSON('pi5', '/a2a/jimmy', { jsonrpc: '2.0', method: 'AckTask' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.match(r.text, /"result"/);
  srv.close();
});

test('a hanging socket agent times out instead of hanging the caller', async () => {
  const sock = tmpSocket();
  const srv = createServer(() => { /* accept and say nothing */ });
  await new Promise((r) => srv.listen(sock, r));
  const p = makeAgentPeer({ self: 'pi5', socketPath: sock, defaultTimeoutMs: 200,
    fetchImpl: () => { throw new Error('no'); } });
  await assert.rejects(() => p.getJSON('pi5', '/v1/sessions'), /timeout/);
  srv.close();
});
