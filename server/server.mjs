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
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Clock, compareHlc } from '../contract/hlc.mjs';
import { validateEvent, BRIDGE_DEV } from '../engine/engine.mjs';
import { ev, DEFAULT_BOARD } from '../contract/events.mjs';
import { mergeEvents, foldBoard, checkInvariants } from '../engine/engine.mjs';
import { createBridge, normalizeTask, projectTask, parseRef, historyText } from '../bridge/reflect.mjs';
import { INBOX_BOARD, COLUMNS } from '../bridge/inbox.mjs';
import { createDispatcher } from '../bridge/dispatch.mjs';

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
// Peers: config.json, an environment list, or --peer <url> (repeatable).
const cliPeers = [];
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--peer' && process.argv[i + 1]) cliPeers.push(process.argv[i + 1]);
}
const peers = [...(cfg.peers || []), ...cliPeers,
  ...(process.env.SHROOMS_BOARD_PEERS || '').split(',')]
  .map((s) => String(s).trim()).filter(Boolean);
const syncMs = parseInt(process.env.SHROOMS_BOARD_SYNC_MS || '0', 10);
const clock = new Clock(cfg.dev);

// The bridge's clock. A separate dev id from the hub's, so every reflection write is
// attributable in the log - and the fold's ownership gate accepts `task` only from it.
const bridgeClock = new Clock(BRIDGE_DEV);

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

// ---- replicas: the transport seam -------------------------------------------
// A replica syncs with a peer over exactly two calls: "give me everything after my
// cursor" and "here is everything after yours". Those are the two things a Logos
// reliable-channel transport has to provide, so the transport can be replaced
// without touching contract/ or engine/ - which is the whole point of the seam.
//
// The cursor is per peer and persisted: `pull` is the peer's seq we have consumed,
// `push` is our seq the peer has been given. A push is idempotent (the peer dedups
// by id), so the cursor is only there to stop us re-sending the whole log each time.
const PEERS_PATH = join(STATE_DIR, 'peers.json');
let peerState = {};
if (existsSync(PEERS_PATH)) {
  try { peerState = JSON.parse(readFileSync(PEERS_PATH, 'utf8')); } catch { peerState = {}; }
}
const savePeers = () => writeFileSync(PEERS_PATH, JSON.stringify(peerState, null, 2));
function peerCursors(url) {
  if (!peerState[url]) peerState[url] = { pull: 0, push: 0 };
  return peerState[url];
}

const PUSH_BATCH = 200;

async function syncPeer(url) {
  const cur = peerCursors(url);
  // PULL. /events is the whole log, so once the batch is in, the peer's head is the
  // correct new cursor - and because seq never moves, a cursor cannot skip an event.
  const r = await fetch(`${url}/events?since=${cur.pull}`);
  if (!r.ok) throw new Error(`GET /events -> ${r.status}`);
  const { events: batch, head } = await r.json();
  for (const rec of batch) ingest([rec.event]); // one ingest path: dedups, advances the clock
  if (typeof head === 'number') cur.pull = head;

  // PUSH our tail.
  const tail = records.filter((x) => x.seq > cur.push).slice(0, PUSH_BATCH);
  const out = tail.map((x) => x.event);
  if (out.length) {
    const pr = await fetch(`${url}/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: out }),
    });
    if (pr.status !== 202 && pr.status !== 200) throw new Error(`POST /events -> ${pr.status}`);
    cur.push = tail[tail.length - 1].seq;
  }
  cur.lastSync = Date.now();
  cur.lastError = null;
  savePeers();
  return { pulled: batch.length, pushed: out.length };
}

let syncTimer = null;
function startSync() {
  if (!peers.length) return;
  const tick = async () => {
    for (const url of peers) {
      try { await syncPeer(url); } catch (e) {
        const c = peerCursors(url);
        c.lastError = String((e && e.message) || e);
        c.lastSync = Date.now();
        savePeers();
      }
    }
  };
  tick();
  if (syncMs > 0) {
    syncTimer = setInterval(tick, syncMs);
    if (syncTimer.unref) syncTimer.unref();
  }
}

// ---- the task bridge: reflection only (docs/task-bridge.md, build order step 1) -----
// It projects the task store onto cards that carry a `task_ref`. It never writes to the
// task store, never moves a card, and never reads a model. Nothing it writes comes from
// its own clock - `at` is the store's timestamp - so it cannot flap. OFF unless
// SHROOMS_BOARD_BRIDGE_MS is set: polling is a cost that follows open obligations, and a
// hub with no bridge configured should not be polling anyone.
const bridgeMs = parseInt(process.env.SHROOMS_BOARD_BRIDGE_MS || '0', 10);
const AGENT_PORT = process.env.SHROOMS_AGENT_PORT || '7387';
const MESH_SUFFIX = process.env.SHROOMS_MESH_SUFFIX || 'default.mesh';

// Every session on the mesh, best effort: a machine that is down is skipped rather than
// failing the request, because the board must still render. `shrooms-agent a2a list` is the
// CLI view of the same thing. Used by GET /agents AND by the inbox, which must poll the
// whole fleet - not only the sessions a card already points at.
async function listMeshAgents() {
  let machines = [SELF];
  try {
    const p = await (await fetch(`${agentUrl(SELF)}/v1/peers`,
      { signal: AbortSignal.timeout(5000) })).json();
    machines = [SELF, ...(p.peers || []).map((x) => x.name)];
  } catch { /* the local agent did not answer; offer at least this machine */ }
  const agents = [];
  await Promise.all(machines.map(async (m) => {
    try {
      const r = await fetch(`${agentUrl(m)}/v1/sessions`, { signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      for (const s of d.sessions || []) {
        agents.push({ machine: m, session: s.name, state: s.state, harness: s.harness });
      }
    } catch { /* unreachable: skip it */ }
  }));
  agents.sort((a, b) => (a.machine + '/' + a.session).localeCompare(b.machine + '/' + b.session));
  return agents;
}

// The inbox board: the bridge's own board for the fleet's live work, so a human's board is
// never flooded with machine chatter.
const INBOX_LIST = 'b0a4d111-0000-4000-8000-000000000001';
// The board and its columns must exist INDEPENDENTLY of whether a new card is being made.
// They were first created only inside the card-creation path, so with no new tasks the
// columns never appeared - while the moves still happened, leaving cards pointing at
// list ids that did not exist.
function ensureInboxBoard() {
  const st = foldBoard(events());
  const evs = [];
  if (!(st.boards || []).some((b) => b.id === INBOX_BOARD)) {
    evs.push(ev.boardCreate(INBOX_BOARD, 'Tasks (the fleet, live)', 1000, bridgeClock));
  }
  // The columns ARE the task state (bridge/inbox.mjs COLUMNS), created in order if absent.
  let pos = 1000;
  for (const col of COLUMNS) {
    if (!(st.lists || []).some((l) => l.id === col.id)) {
      evs.push(ev.listCreate(col.id, col.title, pos, bridgeClock, INBOX_BOARD));
    }
    pos += 1000;
  }
  if (evs.length) ingest(evs);
}

function emitInbox(plan) {
  ensureInboxBoard();
  const evs = [];
  // Cards are created in the column for their state; after that the bridge moves them
  // rather than rewriting them (emitColumns), so a title a human edited is never clobbered.
  let cardPos = 1000;
  for (const item of plan) {
    const id = randomUUID();
    evs.push(ev.cardCreate(id, item.listId || COLUMNS[0].id, item.title, cardPos, bridgeClock, INBOX_BOARD));
    evs.push(ev.cardEdit(id, { task_ref: item.ref }, bridgeClock, INBOX_BOARD));
    const t = projectTask(item.task);
    if (t) evs.push(ev.cardEdit(id, { task: t }, bridgeClock, INBOX_BOARD));
    cardPos += 1000;
  }
  if (evs.length) {
    ingest(evs);
    console.error(`shrooms-board: inbox created ${plan.length} card(s) for open tasks`);
  }
}

// Moving a task card between the board's own columns. The bridge owns these cards, so the
// column is the state; a card already in the right column is never written (planColumns).
// The card's title, kept in step with the task's own words. The bridge owns titles on the
// board it created (never on a human's board - see planTitles).
function emitTitles(plan) {
  if (!plan.length) return;
  ingest(plan.map((m) => ev.cardEdit(m.card_id, { title: m.title }, bridgeClock, m.board_id)));
}

function emitColumns(plan) {
  if (!plan.length) return;
  ingest(plan.map((m) => ev.cardEdit(m.card_id, { list_id: m.list_id }, bridgeClock, m.board_id)));
}

// ---- dispatch: point an agent at a card (docs/task-bridge.md step 3) --------------
// The A2A send. JSON-RPC 2.0 `SendMessage` at /a2a/<session>, per docs/agents.md: the
// task id is SESSION:MESSAGE-ID and the same messageId is the same task, which is what
// makes dispatch idempotent. `metadata['shrooms/from']` is the sender's claim.
// This machine's mesh name, for asking our own agent (it listens on the mesh address
// only). Overridable so a test can point at a stub.
const SELF = process.env.SHROOMS_BOARD_SELF || hostname();

// A bare mesh name gets the suffix (`pi5` -> `pi5.default.mesh`); anything that already
// looks like a host (an IP or an FQDN) is used as given, which is also what lets this be
// tested against a stub on localhost.
const agentUrl = (host) =>
  `http://${/[.:]/.test(host) ? host : `${host}.${MESH_SUFFIX}`}:${AGENT_PORT}`;

// ---- the ack: the board closes a task whose result it has seen (docs/task-bridge.md step 4)
// A2A's `AckTask {id}` goes to the WORKER's agent: the asker is the one who acks, and the task
// lives on the machine that ran it. This is the only place the human surface writes to the task
// store besides dispatch and cancel, and it is always an explicit click - never inferred from a
// card being moved. `GET /v1/tasks` is the worker's own word on state; this is the asker's.
async function ackTaskOnAgent({ machine, session, taskId }) {
  const url = `${agentUrl(machine)}/a2a/${encodeURIComponent(session)}`;
  const body = {
    jsonrpc: '2.0',
    id: `ack-${taskId}`,
    method: 'AckTask',
    params: { id: taskId },
  };
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
                               body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (out.error) throw new Error(`a2a ${out.error.code}: ${out.error.message}`);
  return out.result;
}

async function sendToAgent({ machine, session, messageId, text, title }) {
  const url = `${agentUrl(machine)}/a2a/${encodeURIComponent(session)}`;
  const body = {
    jsonrpc: '2.0',
    id: messageId,
    method: 'SendMessage',
    params: { message: { messageId, role: 'user', parts: [{ text }],
                        // `shrooms/title` is the asker naming the task (shrooms 8da1adc). The card
                        // title already IS a name, so it goes out as one - one line, cut to 120.
                        metadata: Object.assign({ 'shrooms/from': 'shrooms-board' },
                          title ? { 'shrooms/title': String(title).replace(/\s+/g, ' ').trim().slice(0, 120) } : {}) } },
    };
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
                               body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (out.error) throw new Error(`a2a ${out.error.code}: ${out.error.message}`);
  return out.result;
}

const dispatcher = createDispatcher({
  send: sendToAgent,
  appendEvents: (evs) => { ingest(evs); },
  log: (m) => console.error(m),
});

function startBridge({ readCards, ingest: ingestFn }) {
  const bridge = createBridge({
    readCards,
    listSessions: () => listMeshAgents(),
    emitInbox,
    emitColumns,
    emitTitles,
    ensureBoard: ensureInboxBoard,
    listTasks: async ({ machine, session }) => {
      const url = `http://${machine}.${MESH_SUFFIX}:${AGENT_PORT}/v1/tasks?session=${encodeURIComponent(session)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
      const body = await r.json();
      // A task with no derivable message id cannot match any ref, so it is dropped here
      // rather than silently becoming an `unknown` on someone's card.
      // `session` travels with the task: the inbox needs it for a human-readable title.
      return (body.tasks || []).map(normalizeTask).filter((t) => t.message_id)
        .map((t) => ({ ...t, session }));
    },
    emit: (plan) => {
      // The same ingest path as a client's POST: validated, deduped, persisted before
      // the ack, and broadcast to replicas. The bridge is not a privileged writer.
      ingestFn(plan.map((p) => ev.cardEdit(p.card_id, { task: p.task }, bridgeClock, p.board_id)));
    },
    log: (m) => console.error(m),
  });
  const timer = setInterval(() => {
    bridge.tick().catch((e) => console.error(`bridge: tick failed: ${e.message}`));
  }, bridgeMs);
  if (timer.unref) timer.unref();
  return bridge;
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
        return json(res, 200, {
          dev: cfg.dev, events: records.length, head: maxSeq, model: 'event-log v2', peers: peers.length,
        });
      }
      // What this replica knows about its peers: the cursors, the last sync, the last
      // error. A silent sync is the failure mode worth being able to see.
      if (req.method === 'GET' && url.pathname === '/peers') {
        return json(res, 200, {
          head: maxSeq,
          peers: peers.map((u) => ({ url: u, ...peerCursors(u) })),
        });
      }
      if (req.method === 'GET' && url.pathname === '/state') {
        const state = foldBoard(events());
        return json(res, 200, { ...state, invariants: checkInvariants(state), head: maxSeq });
      }

      // ---- boards: the agent-facing surface -------------------------------
      // Agents read and write boards over plain HTTP. They author with their own
      // dev and HLC; ingest dedups by id and advances this replica's clock past
      // their cause, exactly as the module does.
      // ---- who could be dispatched to ------------------------------------------
      // Every peer's sessions, best effort: a machine that is down is skipped rather
      // than failing the request, because the board must still render. `shrooms-agent
      // a2a list` is the CLI view of the same thing.
      // ---- the task's own words, fetched LIVE -----------------------------------
      // Deliberately NOT stored on the card: the log IS the dataset, and copying task
      // prose into it would grow it without bound. The board keeps {state, ack, at}; the
      // text is fetched from the task store when someone actually looks.
      const tm = url.pathname.match(/^\/tasks\/(.+)$/);
      if (req.method === 'GET' && tm) {
        const ref = decodeURIComponent(tm[1]);
        const pr = parseRef(ref);
        if (!pr) return json(res, 400, { error: 'not a task ref (want machine/session:messageId)' });
        try {
          const r = await fetch(`${agentUrl(pr.machine)}/v1/tasks?session=${encodeURIComponent(pr.session)}`,
            { signal: AbortSignal.timeout(6000) });
          const d = await r.json();
          const id = `${pr.session}:${pr.messageId}`;
          const t2 = (d.tasks || []).find((x) => x.id === id);
          if (!t2) return json(res, 404, { error: 'the task store does not know that task' });
          const st = t2.status || {};
          const msg = st.message || {};
          const parts = Array.isArray(msg.parts) ? msg.parts : [];
          const arts = Array.isArray(t2.artifacts) ? t2.artifacts : [];
          const artParts = (arts[0] && Array.isArray(arts[0].parts)) ? arts[0].parts : [];
          return json(res, 200, {
            ref, id: t2.id, state: st.state, at: st.timestamp,
            acked: !!(t2.metadata || {})['shrooms/acknowledged'],
            from: (t2.metadata || {})['shrooms/from'],
            // The name the asker gave it, when the store has it (shrooms/title).
            title: (t2.title || (t2.metadata || {})['shrooms/title'] || ''),
            // What was ASKED (the A2A request), then the latest reply underneath.
            request: historyText(t2),
            latest: (parts[0] && parts[0].text) || '',
            result: (artParts[0] && artParts[0].text) || '',
          });
        } catch (e) {
          return json(res, 502, { error: `could not reach ${pr.machine}: ${e.message}` });
        }
      }

      if (req.method === 'GET' && url.pathname === '/agents') {
        return json(res, 200, { agents: await listMeshAgents() });
      }

      // ---- dispatch: point an agent at a card ---------------------------------
      // `requestId` is REQUIRED and comes from the client, one per click: the messageId
      // is derived from it, so a retry of the same click is the same task instead of a
      // second agent turn. Requiring it is what makes that true.
      const dm = url.pathname.match(/^\/boards\/([^/]+)\/cards\/([^/]+)\/dispatch$/);
      if (req.method === 'POST' && dm) {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
        const { machine, session, requestId } = body;
        if (!machine || !session) return json(res, 400, { error: 'machine and session are required' });
        if (!requestId) return json(res, 400, { error: 'requestId is required (it makes a retry the same task)' });
        const card = foldBoard(events()).cards.find((c) => c.id === dm[2]);
        if (!card) return json(res, 404, { error: 'no such card' });
        const out = await dispatcher.dispatch({ card, machine, session, dispatchEventId: requestId });
        return json(res, 202, out);
      }

      // ---- ack: the human has seen the result --------------------------------
      // No requestId, unlike dispatch: acking twice sets the same flag, so a retry is
      // harmless. Dispatch needs one because a retry there starts a second agent turn.
      const am = url.pathname.match(/^\/boards\/([^/]+)\/cards\/([^/]+)\/ack$/);
      if (req.method === 'POST' && am) {
        const card = foldBoard(events()).cards.find((c) => c.id === am[2]);
        if (!card) return json(res, 404, { error: 'no such card' });
        if (!card.task_ref) return json(res, 400, { error: 'this card has no task linked' });
        const pr = parseRef(card.task_ref);
        if (!pr) return json(res, 400, { error: 'this card has no task linked' });
        const taskId = `${pr.session}:${pr.messageId}`;
        try {
          const out = await ackTaskOnAgent({ machine: pr.machine, session: pr.session, taskId });
          const task = out && out.task ? out.task : null;
          return json(res, 200, {
            acked: true, ref: card.task_ref, id: taskId,
            task: task ? { state: (task.status || {}).state,
                          acked: !!((task.metadata || {})['shrooms/acknowledged']) } : null,
          });
        } catch (e) {
          return json(res, 502, { error: `could not ack at ${pr.machine}: ${e.message}` });
        }
      }

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
        // Which board does an event belong to? One rule, used by both the read filter
        // and the write guard. Every board-scoped event names its board in board_id,
        // except board.* where the board IS the record - and a v1 board.rename has no
        // id at all (v1 had a single board, so there was nothing to name), which makes
        // it the default board's. Dropping it meant a cursor replica never saw the
        // board renamed or deleted, so `since` stopped meaning "this board's log".
        const boardOf = (e) => {
          const p = (e && e.payload) || {};
          if (p.board_id !== undefined) return p.board_id;
          if (e && typeof e.type === 'string' && e.type.startsWith('board.')) {
            return p.id !== undefined ? p.id : DEFAULT_BOARD;
          }
          return undefined;
        };
        const belongs = (e) => {
          const b = boardOf(e);
          if (b !== undefined) return b === boardId;
          const p = e.payload || {};
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
  startServer().then(() => {
    startSync();
    if (bridgeMs > 0) {
      startBridge({ readCards: () => foldBoard(events()).cards, ingest });
      console.error(`shrooms-board: task bridge on, polling every ${bridgeMs} ms`);
    }
    console.log(`shrooms-board on [${cfg.host}]:${cfg.port} dev=${cfg.dev.slice(0, 8)}…`);
  });
}
