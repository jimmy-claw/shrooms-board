// shrooms-board server — a replica holding the event log, served over HTTP.
// Zero dependencies (node stdlib only): runs on pi5 with no build step.
//
// Endpoints (all JSON):
//   GET  /state                current fold + invariant check
//   GET  /events?since=N       the raw log (seq > N), for sync/backfill
//   GET  /boards              the boards on this replica
//   GET  /boards/<id>/state   one board's fold (lists, cards, comments)
//   GET  /boards/<id>/events?since=N   that board's events (seq > N)
//   POST /boards/<id>/events  ingest events for that board
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
// A replica owns a state directory. Defaults to the repo, but a second replica
// (the hub, a test) points elsewhere without touching the checkout.
const STATE_DIR = process.env.SHROOMS_BOARD_STATE || ROOT;
const CONFIG_PATH = join(STATE_DIR, 'config.json');
const LOG_PATH = join(STATE_DIR, 'events.jsonl');

function loadConfig() {
  if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const cfg = { dev: randomBytes(16).toString('hex'), port: 8407, host: '::' };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

const cfg = loadConfig();
if (process.env.SHROOMS_BOARD_PORT) cfg.port = parseInt(process.env.SHROOMS_BOARD_PORT, 10);
if (process.env.SHROOMS_BOARD_HOST) cfg.host = process.env.SHROOMS_BOARD_HOST;
const clock = new Clock(cfg.dev);

// The log. Loaded once, then appended. Authored/ingested events are flushed to
// disk synchronously BEFORE the ack is sent — persistence before the wire
// (logos-multiwriter-sync silent-failure table: the vanishing-event fix).
// A malformed line must never brick startup: the file is appended to and
// persisted, so an unguarded parse turns one bad write into a server that
// cannot start again (review finding H1). Skip and count what cannot be read.
//
// Each entry carries a monotonic `seq`, assigned once at ingest and never
// recomputed. The old server served `?after=<index into the HLC-sorted log>`, and
// that index MOVES when a new event sorts into the middle - so a client polling
// with an index could skip an event permanently (review finding M1). seq fixes it.
const records = []; // [{ seq, event }]
let maxSeq = 0;
let skippedLines = 0;
if (existsSync(LOG_PATH)) {
  for (const line of readFileSync(LOG_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const event = parsed && parsed.event ? parsed.event : parsed; // v1 files are bare events
      records.push({ seq: ++maxSeq, event });
    } catch {
      skippedLines += 1;
    }
  }
  records.sort((a, b) => compareHlc(a.event.hlc, b.event.hlc));
  if (skippedLines) console.error(`shrooms-board: skipped ${skippedLines} unreadable log line(s)`);
}
const events = () => records.map((r) => r.event);
clock.prime(events());
const known = new Set(records.map((r) => r.event.id));

function persist(record) {
  appendFileSync(LOG_PATH, JSON.stringify(record) + '\n');
}

// Ingest: validate, dedup by id, merge by HLC, advance the clock past the cause,
// persist BEFORE acking (persistence before the wire).
function ingest(incoming) {
  const accepted = [];
  const duplicates = [];
  const rejected = [];
  for (const e of incoming) {
    const problems = validateEvent(e);
    if (problems.length) { rejected.push({ id: e && e.id, problems }); continue; }
    if (known.has(e.id)) { duplicates.push(e.id); continue; }
    known.add(e.id);
    const seq = ++maxSeq;
    records.push({ seq, event: e });
    records.sort((a, b) => compareHlc(a.event.hlc, b.event.hlc));
    clock.receive(e.hlc);
    persist({ seq, event: e });
    accepted.push({ id: e.id, seq });
  }
  return [accepted.length ? 202 : (rejected.length ? 422 : 200),
          { accepted, duplicates, rejected, head: maxSeq }];
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
      // ---- what this replica is -------------------------------------------
      if (req.method === 'GET' && url.pathname === '/whoami') {
        return json(res, 200, { dev: cfg.dev, events: records.length, head: maxSeq, model: 'event-log v2' });
      }
      if (req.method === 'GET' && url.pathname === '/state') {
        const state = foldBoard(events());
        return json(res, 200, { ...state, invariants: checkInvariants(state), head: maxSeq });
      }

      // ---- boards: the agent-facing surface -------------------------------
      // Agents read and write boards over plain HTTP. They author with their own
      // dev and HLC; ingest dedups by id and advances this replica's clock past
      // their cause, exactly as the module does.
      if (req.method === 'GET' && url.pathname === '/boards') {
        const state = foldBoard(events());
        return json(res, 200, {
          boards: state.boards, deleted_boards: state.deleted_boards, head: maxSeq,
        });
      }
      const boardMatch = url.pathname.match(/^\/boards\/([^/]+)\/(state|events)$/);
      if (boardMatch) {
        const boardId = decodeURIComponent(boardMatch[1]);
        const what = boardMatch[2];
        const all = foldBoard(events());
        const mine = new Set(all.lists.filter((l) => l.board_id === boardId).map((l) => l.id));
        const myCards = new Set(all.cards.filter((c) => c.board_id === boardId).map((c) => c.id));
        const belongs = (e) => {
          const p = e.payload || {};
          if (p.board_id !== undefined) return p.board_id === boardId;
          if (p.id === boardId) return true; // the board's own record (create/rename/delete)
          return (p.id !== undefined && (mine.has(p.id) || myCards.has(p.id)));
        };
        if (what === 'state' && req.method === 'GET') {
          const board = all.boards.find((b) => b.id === boardId)
                     || all.deleted_boards.find((b) => b.id === boardId);
          if (!board) return json(res, 404, { error: `no board ${boardId}` });
          return json(res, 200, {
            board,
            lists: all.lists.filter((l) => l.board_id === boardId),
            cards: all.cards.filter((c) => c.board_id === boardId),
            comments: all.comments.filter((c) => c.board_id === boardId),
            invariants: checkInvariants(all),
            head: maxSeq,
          });
        }
        if (what === 'events' && req.method === 'GET') {
          const since = parseInt(url.searchParams.get('since') || '0', 10);
          return json(res, 200, {
            events: records.filter((r) => r.seq > since && belongs(r.event)),
            head: maxSeq,
          });
        }
        if (what === 'events' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req));
          const incoming = Array.isArray(body.events) ? body.events : [body.event];
          if (incoming.some((e) => !e)) return json(res, 400, { error: 'missing event(s)' });
          // A board-scoped write must not smuggle an event into another board.
          // Every board-scoped event names its board in payload.board_id - except
          // board.create/rename/delete/restore, where the board IS the record, so the
          // board is payload.id. Both shapes have to be checked or the guard is theatre.
          const boardOf = (e) => {
            const p = (e && e.payload) || {};
            if (p.board_id !== undefined) return p.board_id;
            if (e && typeof e.type === 'string' && e.type.startsWith('board.')) return p.id;
            return undefined;
          };
          const off = incoming.filter((e) => {
            const b = boardOf(e);
            return b !== undefined && b !== boardId;
          });
          if (off.length) {
            return json(res, 422, {
              error: `event(s) belong to another board than ${boardId}`,
              ids: off.map((e) => e.id),
            });
          }
          return json(res, ...ingest(incoming));
        }
      }

      // ---- the raw log (also the view's sync path) -------------------------
      if (req.method === 'GET' && url.pathname === '/events') {
        const since = parseInt(url.searchParams.get('since') || '0', 10);
        return json(res, 200, { events: records.filter((r) => r.seq > since), head: maxSeq });
      }
      if (req.method === 'POST' && url.pathname === '/events') {
        const body = JSON.parse(await readBody(req));
        const incoming = Array.isArray(body.events) ? body.events : [body.event];
        if (incoming.some((e) => !e)) return json(res, 400, { error: 'missing event(s)' });
        return json(res, ...ingest(incoming));
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
