// The read-only half of the task bridge (docs/task-bridge.md, build order step 1).
//
// It reads nothing from a model and writes nothing to the task store. For each card
// that carries a `task_ref` it projects the task's state onto the card's ONE
// bridge-owned `task` object — and only when the task store's own timestamp is newer
// AND the projected value differs. Those two rules together are what make it idempotent
// and what make duplicate bridges harmless: the writes are monotonic in the task
// store's clock, so a second bridge, a replay or a late poller cannot flap the log.
//
// Everything time-derived stays OUT of the log: `at` is the task store's `updated`,
// never our clock. `stalled` is the store's own supervision fact, not our guess.

import { BRIDGE_DEV } from '../engine/engine.mjs';
import { planInbox, planColumns, planTitles, requesterSession } from './inbox.mjs';

// The task's own message id, which is what a `task_ref` is built from. The task id is
// `<session>:<messageId>`, so the part after the first colon IS the message id - and it
// is the ONLY correct source: `status.message.messageId` is the *status* message's id
// and carries a `-status` suffix. Verified against the live store; the unit tests could
// not have caught it, because they used the shape I had assumed.
export function taskMessageId(t) {
  const id = String((t && t.id) || '');
  const colon = id.indexOf(':');
  if (colon >= 0) return id.slice(colon + 1);
  const sm = t && t.status && t.status.message && t.status.message.messageId;
  return sm ? sm.replace(/-status$/, '') : '';
}

// shrooms-agent's task shape -> what the bridge projects. The state arrives as
// `TASK_STATE_*`, the queue/stall/ack facts live in metadata, and the source version is
// `status.timestamp`. All checked against the live `GET /v1/tasks`, not assumed.
export function normalizeTask(t) {
  const md = (t && t.metadata) || {};
  const raw = (t && t.status && t.status.state) || '';
  return {
    message_id: taskMessageId(t),
    state: raw.replace(/^TASK_STATE_/, '').toLowerCase().replace(/_/g, '-') || 'unknown',
    updated: t && t.status && t.status.timestamp,
    acked: !!md['shrooms/acknowledged'],
    stalled: !!md['shrooms/stalled'],
    started: !md['shrooms/queued'],
    from: md['shrooms/from'],
    // The last thing said in the task. It is what the store gives us - there is no separate
    // "original request" field - and it is far better as a card title than "who -> whom".
    latest: (t && t.status && t.status.message && Array.isArray(t.status.message.parts)
             && t.status.message.parts[0] && t.status.message.parts[0].text) || '',
  };
}

// `submitted` with no `started` is shrooms' queue: the session is busy, and a human
// looking at the board needs to know that nothing is happening yet.
export function stateOf(task) {
  const s = task.state || 'unknown';
  if (s === 'submitted' && !task.started) return 'queued';
  return s;
}

// A task as shrooms-agent reports it (`GET /v1/tasks?session=NAME` -> `{tasks:[Task]}`)
// projected onto the card. `null` task means "the store was polled and does not know
// this ref" -> `unknown`, which is surfaced, never silently cleared.
export function projectTask(task) {
  if (!task) return { state: 'unknown' };
  const t = { state: stateOf(task), ack: task.acked ? 'acked' : 'pending', at: task.updated };
  if (task.stalled) t.stalled = true;
  // WHO ASKED. The worker needs no field of its own: it is in the task_ref
  // (`machine/session:messageId`). `shrooms/from` is a device claim - "laptop.default
  // (laptop/SPEL)" - so store the session, which is what a person reads.
  const by = requesterSession({ from: task.from });
  if (by) t.by = by;
  return t;
}

// Compare the MEANINGFUL fields, not `at`. `at` is the source version, and the task
// store bumps it on a nudge without anything having happened - so including it here
// makes every bump look like a change and the bridge writes an edit per card per bump.
// The log IS the dataset; that grows it forever. The card keeps the timestamp of the
// last real change, which is what `as of` should mean.
function sameTask(a, b) {
  if (!a || !b) return a === b;
  return a.state === b.state && a.ack === b.ack
    && Boolean(a.stalled) === Boolean(b.stalled) && a.by === b.by;
}

// ISO-8601 UTC with a NANOSECOND fraction (shrooms-agent emits `…05.102305419Z`).
// Date.parse truncates to milliseconds, so two timestamps a microsecond apart compare
// EQUAL and a real change a nanosecond later would be rejected as stale, leaving the
// card on the old state forever. Compare the parts instead.
function tsKey(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(s);
  if (!m) return null;
  const secs = Date.parse(`${m[1]}Z`);
  if (Number.isNaN(secs)) return null;
  return [secs, (m[2] || '').padEnd(9, '0').slice(0, 9)];
}

function newer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const x = tsKey(a), y = tsKey(b);
  if (x && y) {
    if (x[0] !== y[0]) return x[0] > y[0];
    return x[1] > y[1];
  }
  return String(a) > String(b); // fallback for anything not in that exact shape
}

// The pure decision: which cards need a write, and what to write. No I/O, so the
// rules can be tested directly.
//   cards          - the fold's cards (only `id`, `board_id`, `task_ref`, `task` are read)
//   tasksByRef     - Map<ref, Task> from the polls that succeeded
//   polledMachines - the machines we actually heard from this tick
export function planReflection(cards, { tasksByRef, polledMachines }) {
  const out = [];
  for (const card of cards) {
    const ref = card.task_ref;
    if (!ref) continue;
    const machine = ref.split('/')[0];
    // No fresh observation from that machine: keep the last known value rather than
    // inventing one. (The card already shows `as of <at>`.)
    if (!polledMachines.has(machine)) continue;
    const next = projectTask(tasksByRef.get(ref) || null);
    const cur = card.task || null;
    if (sameTask(cur, next)) continue;
    // Never go backwards in the task store's own clock. `unknown` has no timestamp,
    // so it is written only as a change of state, once.
    if (cur && next.at && cur.at && !newer(next.at, cur.at)) continue;
    out.push({ card_id: card.id, board_id: card.board_id, task: next });
  }
  return out;
}

// `machine/session:messageId` -> its two parts. The ref is opaque everywhere else;
// only the poller needs to take it apart, and only to ask the right session.
export function parseRef(ref) {
  // A card with no task linked has no ref at all, and "there is no ref" is an answer, not a
  // crash: `undefined.indexOf` threw and turned a 400 into a 500.
  if (typeof ref !== 'string' || ref === '') return null;
  const slash = ref.indexOf('/');
  if (slash < 0) return null;
  const machine = ref.slice(0, slash);
  const rest = ref.slice(slash + 1);
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  return { machine, session: rest.slice(0, colon), messageId: rest.slice(colon + 1) };
}

// The poller. I/O is injected so the loop is testable and so the hub can wire it to
// the real task store. One request per (machine, session) — never per card.
export function createBridge({ readCards, listTasks, listSessions, emit, emitInbox, emitColumns,
                               ensureBoard, emitTitles, dev = BRIDGE_DEV, log = () => {} }) {
  return {
    dev,
    async tick() {
      // Before anything else: the board the bridge owns must EXIST. Doing this only when
      // there is a card to create or a card to move means it never happens once things are
      // quiet - which is how the columns went missing while the moves still landed.
      if (ensureBoard) ensureBoard();
      const cards = readCards();
      const wanted = new Set();
      for (const c of cards) {
        if (!c.task_ref) continue;
        const p = parseRef(c.task_ref);
        if (p) wanted.add(p.machine + '/' + p.session);
      }
      // The INBOX needs the whole fleet, not only the sessions a card already points at -
      // otherwise a task that nobody linked is invisible, which is the state we are fixing.
      if (listSessions) {
        try {
          for (const s of (await listSessions()) || []) {
            if (s && s.machine && s.session) wanted.add(s.machine + '/' + s.session);
          }
        } catch (e) {
          log(`bridge: could not list sessions (${e.message}); inbox sees only linked sessions this tick`);
        }
      }
      const tasksByRef = new Map();
      const polledMachines = new Set();
      for (const pair of wanted) {
        const [machine, session] = pair.split('/');
        let tasks;
        try {
          tasks = await listTasks({ machine, session });
        } catch (e) {
          log(`bridge: poll ${pair} failed: ${e && e.message ? e.message : e}`);
          continue; // offline: the card keeps its last value and its `as of`
        }
        polledMachines.add(machine);
        for (const t of tasks || []) {
          if (t && t.message_id) tasksByRef.set(`${machine}/${session}:${t.message_id}`, t);
        }
      }
      const plan = planReflection(cards, { tasksByRef, polledMachines });
      if (plan.length) emit(plan, dev);

      // The inbox: open tasks with no card at all become cards, once. This is what makes the
      // board show the fleet's real work instead of only what someone linked by hand.
      let created = [];
      if (emitInbox) {
        const found = [];
        for (const [ref, task] of tasksByRef) {
          found.push({ ref, task, machine: ref.split('/')[0] });
        }
        created = planInbox(found, cards);
        if (created.length) emitInbox(created, dev);
      }

      // The columns ARE the state on the bridge's own board, so move a card when its task
      // moves. A human's board is never touched (see planColumns), and a card already in
      // the right column is not written at all.
      if (emitColumns) {
        const moves = planColumns(cards, tasksByRef);
        if (moves.length) emitColumns(moves, dev);
      }
      // And the title: the card should say what the task IS, not who sent it to whom.
      if (emitTitles) {
        const titles = planTitles(cards, tasksByRef);
        if (titles.length) emitTitles(titles, dev);
      }
      return plan;
    },
  };
}
