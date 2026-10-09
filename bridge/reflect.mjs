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
  return t;
}

function sameTask(a, b) {
  if (!a || !b) return a === b;
  return a.state === b.state && a.ack === b.ack && a.at === b.at
    && Boolean(a.stalled) === Boolean(b.stalled);
}

// ISO-8601 UTC strings, so a string compare is a time compare; Date.parse is the
// fallback for anything else.
function newer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return String(a) > String(b);
  return ta > tb;
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
export function createBridge({ readCards, listTasks, emit, dev = BRIDGE_DEV, log = () => {} }) {
  return {
    dev,
    async tick() {
      const cards = readCards();
      const wanted = new Set();
      for (const c of cards) {
        if (!c.task_ref) continue;
        const p = parseRef(c.task_ref);
        if (p) wanted.add(p.machine + '/' + p.session);
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
      return plan;
    },
  };
}
