// shrooms-board — the inbox: the fleet's real A2A work ON the board.
//
// Reflection (bridge/reflect.mjs) needs a card to project onto, so until now the board only
// showed tasks somebody had linked by hand. That is backwards for a human who wants to see
// what the fleet is doing: the tasks are the work, and the board is the surface. So the
// bridge also projects OPEN tasks onto a board of their own:
//
//   * one card per open task that has no card, in a dedicated board (default `tasks`), so a
//     human's own board is never flooded with machine chatter;
//   * the bridge writes the card ONCE (title, description, link). After that it only ever
//     writes the `task` object, so a human may retitle or move the card without a fight;
//   * TERMINAL tasks with no card are ignored. They are history - backfilling 50 finished
//     tasks would bury the live ones, which is the opposite of the point;
//   * a card whose task is gone is left alone here; surfacing that is the orphan pass.
//
// The card's title comes from what the task store knows: the requester's summary if the
// worker gave one, else who asked and the first line of the request. The bridge never reads
// prose to DECIDE anything - this is only text for a human.

export const INBOX_BOARD = 'tasks';

// The Tasks board's columns ARE the task state - the point of a machine-owned board.
//
// This is NOT the rule for a human's board. There the bridge must never write `list_id`:
// moving a card is a human act, and a machine that also moved cards would win races the
// human never sees. On this board the cards are the bridge's own, so the column is the
// state and the bridge moves them.
//
// Ordered left to right by what needs attention first.
export const COLUMNS = [
  { id: 'tasks-queued',   title: 'Queued',          match: (s) => s === 'submitted' || s === 'queued' || s === 'unknown' },
  { id: 'tasks-working',  title: 'Working',         match: (s) => s === 'working' },
  { id: 'tasks-needs-you', title: 'Needs you',      match: (s) => s === 'input-required' || s === 'auth-required' },
  { id: 'tasks-stalled',  title: 'Stalled',         match: (s) => s === 'stalled' },
  { id: 'tasks-unacked',  title: 'Done, unacked',   match: (s, ack) => isTerminal(s) && ack !== 'acked' },
  { id: 'tasks-acked',    title: 'Acked',           match: (s, ack) => isTerminal(s) && ack === 'acked' },
];

const TERMINAL_STATES = ['completed', 'failed', 'canceled', 'rejected', 'expired'];
export function isTerminal(state) {
  return TERMINAL_STATES.indexOf(String(state || '').toLowerCase()) >= 0;
}

// Which column a projected task belongs in. `stalled` is the store's own fact, so it wins
// over the state name - a stalled `working` task needs a human, not a "Working" column.
export function columnFor(task) {
  if (!task) return COLUMNS[0].id;
  const s = String(task.state || '').toLowerCase();
  if (task.stalled) return 'tasks-stalled';
  for (const c of COLUMNS) {
    if (c.match(s, task.ack)) return c.id;
  }
  return COLUMNS[0].id;
}

const OPEN_STATES = ['submitted', 'queued', 'working', 'input-required', 'auth-required', 'unknown'];

// The task as the CARD sees it: the bridge's projection ({state, ack, at}), which is what
// the fold stores and what the column decision must be based on - not the raw store shape.
function projected(task) {
  const s = String((task && task.state) || '').toLowerCase();
  return { state: s, ack: (task && task.acked) ? 'acked' : 'pending', stalled: !!(task && task.stalled) };
}

export function isOpen(task) {
  const s = String((task && task.state) || '').toLowerCase();
  return OPEN_STATES.indexOf(s) >= 0;
}

// A short, human title. Prefers what the worker said it did, then the requester, then the id.
export function inboxTitle(task) {
  // WHAT WAS ASKED comes first. `latest` is the worker's reply, so titling by it makes every
  // card read like a status line. Fall through to `latest` on an agent that does not carry the
  // request yet, which is every machine until it is updated.
  const asked = task && task.request;
  if (asked) {
    const line = String(asked).replace(/\s+/g, ' ').trim();
    if (line) return line.length > 90 ? line.slice(0, 89) + '\u2026' : line;
  }
  // The task's own words. This is the useful title: what the work actually is.
  const text = task && task.latest;
  if (text) {
    const line = String(text).replace(/\s+/g, ' ').trim();
    if (line) return line.length > 90 ? line.slice(0, 89) + '\u2026' : line;
  }
  const summary = task && task.summary;
  if (summary) return String(summary).replace(/\s+/g, ' ').trim().slice(0, 120);
  // The fallback names SESSIONS on both sides. The raw `shrooms/from` is a device claim
  // ("laptop.default (laptop/SPEL)"), which is why the old titles read
  // "laptop.default (laptop/SPEL) -> duet-kit" - lopsided, device on one side and session
  // on the other. `session -> session` is at least consistent.
  const from = requesterSession(task) || (task && task.from);
  if (from) return `${from} \u2192 ${task.session || '?'}`.slice(0, 120);
  const ref = (task && task.ref) || '';
  if (ref) return ref.slice(0, 120);
  const mid = task && task.message_id;
  return mid ? `task ${mid}`.slice(0, 120) : 'task';
}

// "laptop.default (laptop/SPEL)" -> "SPEL"; "pi5 (pi5/jimmy)" -> "jimmy"; anything else is
// returned as-is so a plain name still works.
export function requesterSession(task) {
  const from = String((task && task.from) || '');
  if (!from) return '';
  const m = /\(([^)]+)\)\s*$/.exec(from);
  if (!m) return from.trim();
  const inner = m[1];
  const slash = inner.lastIndexOf('/');
  return (slash >= 0 ? inner.slice(slash + 1) : inner).trim();
}

/**
 * Which tasks need a card.
 *
 * @param {Array<{ref: string, task: object, machine: string}>} found  every task the polls saw
 * @param {Array} cards  the fold's cards across all boards (only id/board_id/task_ref read)
 * @param {string} [boardId]
 * @returns {Array<{ref, machine, task, title}>} cards to create, in a stable order
 */
export function planInbox(found, cards, boardId = INBOX_BOARD) {
  const known = new Set();
  for (const c of cards || []) {
    if (c && c.task_ref) known.add(c.task_ref);
  }
  const out = [];
  const seen = new Set();
  for (const f of found || []) {
    if (!f || !f.ref || !f.task) continue;
    if (known.has(f.ref) || seen.has(f.ref)) continue;  // already on the board
    if (!isOpen(f.task)) continue;                      // history: not backfilled
    seen.add(f.ref);
    const t = { ...f.task, ref: f.ref };
    out.push({ ref: f.ref, machine: f.machine, task: f.task, title: inboxTitle(t), boardId,
               listId: columnFor(projected(f.task)) });
  }
  out.sort((a, b) => a.ref.localeCompare(b.ref));        // deterministic, so a fixture can pin it
  return out;
}

/**
 * Which task cards are in the WRONG column.
 *
 * Only the bridge's own board is touched - a human's board is never moved, which is the
 * rule that matters. Only cards whose column actually differs are returned, so this is
 * idempotent: a task whose state has not changed produces no write at all, and the log
 * does not grow on every poll.
 *
 * @param {Array} cards  the fold's cards
 * @param {Map<string, object>} tasksByRef  the tasks the polls saw this tick (normalized)
 * @param {string} [boardId]
 */
export function planColumns(cards, tasksByRef, boardId = INBOX_BOARD) {
  const out = [];
  for (const c of cards || []) {
    if (!c || !c.task_ref) continue;
    if ((c.board_id || '') !== boardId) continue;   // never move a human's card
    const task = tasksByRef.get(c.task_ref);
    if (!task) continue;                            // not polled this tick: leave it
    const want = columnFor(projected(task));
    if (want !== c.list_id) {
      out.push({ card_id: c.id, board_id: boardId, list_id: want, ref: c.task_ref });
    }
  }
  out.sort((a, b) => a.card_id.localeCompare(b.card_id));  // deterministic, so a test can pin it
  return out;
}

/**
 * Cards whose title no longer matches the task's own words.
 *
 * The bridge owns the titles of the cards IT created, on its own board - the same rule as
 * the columns. A human's board is never touched, and a card already showing the right title
 * is not written, so this is idempotent. (Renaming one of these machine cards will be
 * reverted the next time the task says something; use the Fleet board for titles you own.)
 */
export function planTitles(cards, tasksByRef, boardId = INBOX_BOARD) {
  const out = [];
  for (const c of cards || []) {
    if (!c || !c.task_ref) continue;
    if ((c.board_id || '') !== boardId) continue;
    const task = tasksByRef.get(c.task_ref);
    if (!task) continue;
    const want = inboxTitle({ ...task, ref: c.task_ref });
    if (want && want !== c.title) out.push({ card_id: c.id, board_id: boardId, title: want });
  }
  out.sort((a, b) => a.card_id.localeCompare(b.card_id));
  return out;
}
