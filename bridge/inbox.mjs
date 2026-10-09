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

const OPEN_STATES = ['submitted', 'queued', 'working', 'input-required', 'auth-required', 'unknown'];

export function isOpen(task) {
  const s = String((task && task.state) || '').toLowerCase();
  return OPEN_STATES.indexOf(s) >= 0;
}

// A short, human title. Prefers what the worker said it did, then the requester, then the id.
export function inboxTitle(task) {
  const summary = task && task.summary;
  if (summary) return String(summary).replace(/\s+/g, ' ').trim().slice(0, 120);
  const from = (task && task.from) || (task && task.metadata && task.metadata['shrooms/from']);
  if (from) return `${from} → ${task.session || '?'}`.slice(0, 120);
  return `task ${String((task && task.id) || '').slice(0, 40)}`;
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
    out.push({ ref: f.ref, machine: f.machine, task: f.task, title: inboxTitle(f.task), boardId });
  }
  out.sort((a, b) => a.ref.localeCompare(b.ref));        // deterministic, so a fixture can pin it
  return out;
}
