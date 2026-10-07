// shrooms-board server — a replica holding the event log, served over HTTP.
// Zero dependencies (node stdlib only): runs on pi5 with no build step.
//
// Endpoints (all JSON):
//   GET  /state                current fold + invariant check
//   GET  /events?after=N       the event log (index > N), for sync/backfill
//   POST /events               {event} or {events:[...]} — validate, dedup by id,
//                              merge, advance the clock, append to disk BEFORE ack
//   GET  /whoami               {dev, events: n}
//   /                          the web UI (web/index.html)
//
// The server is NOT an authority: it folds the same log the same way any replica
// would. The transport seam (this HTTP layer) can be replaced by a Logos
// reliable-channel transport later without touching contract/ or engine/.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Clock, compareHlc } from '../contract/hlc.mjs';
import { validateEvent } from '../engine/engine.mjs';
import { mergeEvents, foldBoard, checkInvariants } from '../engine/engine.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const CONFIG_PATH = join(ROOT, 'config.json');
const LOG_PATH = join(ROOT, 'events.jsonl');

function loadConfig() {
  if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const cfg = { dev: randomBytes(16).toString('hex'), port: 8407, host: '::' };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

const cfg = loadConfig();
const clock = new Clock(cfg.dev);

// The log. Loaded once, then appended. Authored/ingested events are flushed to
// disk synchronously BEFORE the ack is sent — persistence before the wire
// (logos-multiwriter-sync silent-failure table: the vanishing-event fix).
const log = existsSync(LOG_PATH)
  ? readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
clock.prime(log);
const known = new Set(log.map((e) => e.id));

function persist(event) {
  appendFileSync(LOG_PATH, JSON.stringify(event) + '\n');
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function startServer({ port = cfg.port, host = cfg.host } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/whoami') {
        return json(res, 200, { dev: cfg.dev, events: log.length, model: 'event-log v1' });
      }
      if (req.method === 'GET' && url.pathname === '/state') {
        const state = foldBoard(log);
        const inv = checkInvariants(state);
        return json(res, 200, { ...state, invariants: inv, head: log.length });
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        const after = parseInt(url.searchParams.get('after') || '-1', 10);
        // indices are positions in THIS replica's HLC-sorted log
        return json(res, 200, { events: log.slice(after + 1), head: log.length });
      }
      if (req.method === 'POST' && url.pathname === '/events') {
        const body = JSON.parse(await readBody(req));
        const incoming = Array.isArray(body.events) ? body.events : [body.event];
        if (incoming.some((e) => !e)) return json(res, 400, { error: 'missing event(s)' });

        const accepted = [];
        const duplicates = [];
        const rejected = [];
        for (const e of incoming) {
          const problems = validateEvent(e);
          if (problems.length) { rejected.push({ id: e && e.id, problems }); continue; }
          if (known.has(e.id)) { duplicates.push(e.id); continue; }
          // Order-insensitive ingest: dedup, merge by HLC, advance the clock past
          // the cause (decision #3 — receive on every ingest).
          known.add(e.id);
          log.push(e);
          log.sort((a, b) => compareHlc(a.hlc, b.hlc));
          clock.receive(e.hlc);
          persist(e); // flush BEFORE ack (persistence before the wire)
          accepted.push(e.id);
        }
        return json(res, accepted.length ? 202 : (rejected.length ? 422 : 200), {
          accepted, duplicates, rejected, head: log.length,
        });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = readFileSync(join(ROOT, 'web', 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
        return res.end(html);
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: String(err && err.message || err) });
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

// Run directly: `node server/server.mjs`
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  startServer().then(() => console.log(`shrooms-board on [${cfg.host}]:${cfg.port} dev=${cfg.dev.slice(0, 8)}…`));
}
