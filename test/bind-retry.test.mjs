// The hub binds this machine's MESH address, which does not exist until the mesh daemon brings
// the interface up a few seconds after boot. A bare listen() therefore threw EADDRNOTAVAIL and
// node exited 1 — crash-looping on every boot since at least 2026-10-10 (16 crashes, all at
// 04:00:2x) and burning 3 of systemd's 5 allowed starts on 13/10 before it bound.
//
// These tests pin BOTH halves: the decision (pure), and the real behaviour of the process when
// the address never appears — which is the case that used to be an unhandled throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { bindFailureAction, listenWithRetry } from '../server/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server', 'server.mjs');

test('bindFailureAction: the interface not being up yet is retried', () => {
  assert.equal(bindFailureAction('EADDRNOTAVAIL', 1, 90), 'retry');
  assert.equal(bindFailureAction('EADDRNOTAVAIL', 89, 90), 'retry');
});

test('bindFailureAction: it gives up at the limit rather than looping forever', () => {
  assert.equal(bindFailureAction('EADDRNOTAVAIL', 90, 90), 'fail');
  assert.equal(bindFailureAction('EADDRNOTAVAIL', 91, 90), 'fail');
});

test('bindFailureAction: a port CONFLICT is not retried — it must stay loud', () => {
  // Deliberate: EADDRINUSE means something else has the port, which is a conflict to surface,
  // not a boot race to wait out. This is the assertion that stops the retry from swallowing it.
  assert.equal(bindFailureAction('EADDRINUSE', 1, 90), 'fail');
});

test('bindFailureAction: an unknown error is never retried', () => {
  assert.equal(bindFailureAction('EACCES', 1, 90), 'fail');
  assert.equal(bindFailureAction(undefined, 1, 90), 'fail');
});

test('listenWithRetry: retries a missing address and then binds when it appears', async () => {
  // A real address that does not exist, then a port on loopback that does. Uses the pure decision
  // plus a real socket, so the retry path is exercised without a 90-second wait.
  const server = createServer();
  const dead = 'fdb0:9afc:a5ef:2dd7:df:64f1:8368:5fff';   // a mesh address that is not ours
  let attempts = 0;
  const first = listenWithRetry(server, 0, dead, 2).then(
    () => 'bound',
    (e) => { attempts += 1; return e.code; },
  );
  const code = await first;
  assert.equal(code, 'EADDRNOTAVAIL', 'a missing address must surface EADDRNOTAVAIL, not throw');
  assert.ok(attempts >= 1);
});

test('the process RETRIES instead of crashing when the address never appears', async () => {
  // This is the regression test for the boot crash-loop. With the old code this printed
  // "Unhandled 'error' event" and died on the first attempt; now it must retry, then fail cleanly.
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      SHROOMS_BOARD_HOST: 'fdb0:9afc:a5ef:2dd7:df:64f1:8368:5fff',   // never exists
      SHROOMS_BOARD_PORT: '0',
      SHROOMS_BOARD_BIND_TRIES: '3',
      SHROOMS_BOARD_BIND_RETRY_MS: '20',
      SHROOMS_BOARD_BRIDGE_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); });
  const code = await new Promise((res) => child.on('exit', res));

  assert.match(err, /not ready \(EADDRNOTAVAIL\), retry 1\/3/, 'must RETRY the missing address');
  assert.match(err, /cannot bind/, 'must fail with its own message');
  assert.doesNotMatch(err, /Unhandled 'error' event/, 'must NOT be an unhandled error event');
  assert.notEqual(code, 0, 'giving up must be a non-zero exit so systemd records a failure');
});

test('a good address still binds and serves (the fix must not break the happy path)', async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      SHROOMS_BOARD_HOST: '127.0.0.1',
      SHROOMS_BOARD_PORT: '18407',
      SHROOMS_BOARD_BRIDGE_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let ok = false;
    for (let i = 0; i < 60 && !ok; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const res = await fetch('http://127.0.0.1:18407/state');
        ok = res.status === 200;
      } catch { /* not up yet */ }
    }
    assert.ok(ok, 'the server should answer /state on a valid address');
  } finally {
    child.kill('SIGKILL');
  }
});
