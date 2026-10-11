// Orphan surfacing (docs/task-bridge.md §5, build order step 5).
//
// An ORPHAN is a `task_ref` the log has seen on a card, which no VISIBLE card carries any
// more. Visible means the card is in the fold AND its column is in the fold: a card whose
// list was deleted renders nowhere on the board, so its task would otherwise disappear
// from the human surface while the obligation still lives in the task store. That is the
// whole point - the card is a view, and cancelling the task is not ours to do (§5, §6).
//
// Derived, never stored. The log IS the dataset, so this is recomputed from the events on
// every read, and NOTHING is written anywhere: in particular there is no "orphaned"
// marker, because the task store has no such field.

import { mergeEvents } from '../engine/engine.mjs';
import { DEFAULT_BOARD } from '../contract/events.mjs';
import { isOpen } from './inbox.mjs';

// A card deleted while its task is still owed is the case this exists for. A FINISHED
// task's card is history, so it is not surfaced - but an UNKNOWN task is: we cannot tell
// whether it is still owed, and hiding it would drop the one thing this is here to keep.
// (`isOpen` alone answers false for an empty state, which is the trap.)
export function stillOwed(task) {
  if (!task) return true;
  const s = String(task.state || '').toLowerCase();
  if (s === '' || s === 'unknown') return true;
  return isOpen(task);
}

// events     - the raw log (or a board-scoped slice of it)
// cards      - the fold's live cards
// lists      - the fold's live lists
// tasksByRef - optional Map<ref, normalizedTask>; carried onto the entry when known
export function planOrphans(events, { cards = [], lists = [], tasksByRef } = {}) {
  const listIds = new Set(lists.map((l) => l.id));
  const liveById = new Map(cards.map((c) => [c.id, c]));
  const visible = new Set();
  for (const c of cards) {
    if (!c.task_ref) continue;
    // A card whose column is gone is not rendered by any surface, so its task is an
    // orphan even though the card itself still exists in the fold.
    if (c.list_id !== undefined && !listIds.has(c.list_id)) continue;
    visible.add(c.task_ref);
  }

  // The ref each card last carried, from the log. A CLEARED ref (a human unlinked it) is
  // removed, not remembered: an unlinked card is a decision, not an orphan. Deleting a
  // card is different - the card is gone but the obligation is not - so no delete
  // tracking is needed: the fold simply stops listing the card and its ref stops being
  // visible, which is exactly the signal above.
  const lastRef = new Map(); // card_id -> {ref, board_id, list_id}
  for (const e of mergeEvents(events)) {
    const p = (e && e.payload) || {};
    if (e.type === 'card.create') {
      if (p.task_ref) {
        lastRef.set(p.id, { ref: p.task_ref, board_id: p.board_id ?? DEFAULT_BOARD, list_id: p.list_id });
      }
    } else if (e.type === 'card.edit') {
      const f = p.fields || {};
      if (Object.prototype.hasOwnProperty.call(f, 'task_ref')) {
        if (f.task_ref) {
          lastRef.set(p.id, { ref: f.task_ref, board_id: p.board_id ?? DEFAULT_BOARD, list_id: p.list_id });
        } else {
          lastRef.delete(p.id);
        }
      }
    }
  }

  const byRef = new Map(); // one entry per REF, not per card: one task seen from two boards
  for (const [cardId, info] of lastRef) {
    if (visible.has(info.ref)) continue; // still on a card a human can see
    if (byRef.has(info.ref)) continue;
    const task = tasksByRef ? tasksByRef.get(info.ref) : undefined;
    if (!stillOwed(task)) continue;
    const live = liveById.get(cardId);
    const entry = {
      ref: info.ref,
      board_id: info.board_id,
      card_id: cardId,
      list_id: (live && live.list_id !== undefined) ? live.list_id : (info.list_id ?? null),
    };
    if (task) entry.task = task;
    byRef.set(info.ref, entry);
  }

  const out = [...byRef.values()];
  // Deterministic, so a fixture can pin the order.
  out.sort((a, b) => String(a.board_id).localeCompare(String(b.board_id)) || a.ref.localeCompare(b.ref));
  return out;
}
