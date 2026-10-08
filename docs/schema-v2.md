# shrooms-board — event format v2: multiple boards, and agent access

Decision record, 2026-10-07 (Jimmy, pi5). Written BEFORE persistence is built,
because the event format is what persistence freezes. Review by the Duet session
and the Shrooms Claude.

## Why now

The board works on the Duet (v1 view, done). What it lacks is persistence and
transport, and the user needs **multiple boards in one instance** and **agents able
to read and write cards**. Both change the event format, so they land first.

## 1. Boards in the event format

Add `board_id` to every event that belongs to a board, and make board lifecycle its
own event type:

    board.create  { board_id, title, pos }          record
    board.rename  { board_id, title }               LWW
    board.delete  { board_id }                      sticky tombstone
    list.create   { board_id, id, title, pos }
    list.edit     { board_id, id, fields }
    list.delete   { board_id, id }
    card.create   { board_id, id, list_id, title, pos, task_ref? }
    card.edit     { board_id, id, fields }
    card.delete   { board_id, id }
    card.assign   { board_id, id, actor, present }
    comment.create{ board_id, id, card_id, text }

Rules that keep this cheap:

- **`board_id` is in the payload, not the envelope.** The event stays
  `{v, id, type, hlc, dev, payload}` — one log, one dataset, one sync topic, and
  boards are partitions of it.
- **The fold partitions by `board_id`**: the same pure fold, grouped. No new CRDT
  reasoning, no per-board clocks.
- **A board can later become its own dataset** (its own key and topic) without
  touching the event shape — only the routing changes. That is the skill's model:
  the privacy boundary is which dataset a record lives in. Until there is a real
  privacy need, one dataset is enough and much less plumbing.
- **The v1 events without `board_id`** are read as belonging to a single default
  board, so existing logs (and the Duet's test data) still fold.

## 2. What the view needs

- A **board switcher** in the header (a compact list of boards, plus "new board").
- The view keeps one `board_id` in state; every call carries it.
- The board list itself is folded from `board.create/rename/delete`.

## 3. Agent access: a wrapper, not a new protocol

Agents must read and write cards. They already speak HTTP on the mesh, so:

- **Read:** `GET /boards`, `GET /boards/<id>/state` (the fold for one board).
- **Write:** `POST /boards/<id>/events` with the same event shape the core uses.
  Agents author with their own `dev` and HLC; the hub advances past their cause.
- **One wrapper, one implementation**: the same core module runs headless as the
  hub (the skill's hub pattern), so the agent path and the view fold identically —
  no second implementation to drift.

A CLI (`board list|add|move|comment`) over that HTTP is a convenience, not a second
protocol. Ship it once the hub exists.

## 4. Order

1. **Event format v2 + the fold** (this document) — core-side, testable against the
   golden fixtures with new multi-board fixtures added.
2. **Persistence** — the log survives a restart (this is what makes it not a toy).
3. **Transport + headless hub** — boards shared with the fleet, and the agent HTTP
   wrapper comes with the hub.
4. **The task bridge** — separately designed and reviewed before it is built, since
   it touches the A2A task layer: `task_ref` joins a card to a task, reflection is
   one direction, pointing an agent at a card is the other, and Done means acked.

## 5. Open questions

1. Board membership/privacy: one dataset for everything now. When a board needs to
   be private, is it one key per board (share the key) or roles admitted on merge
   (the skill's group model)? Not needed yet; the format does not decide it.
2. ~~Does `board.delete` cascade?~~ **SETTLED (Duet, 2026-10-07):** the fold cascades,
   the events are kept. A deleted board's lists and cards are treated as gone by the
   fold (derived, nothing extra emitted), so every device agrees, including for a card
   a peer adds to a board that was just deleted. Orphan-surfacing via the oracle was
   the wrong instinct: the user model is "delete board = it is gone".

   **Restore semantics (defined here because the format freezes with them):**
   - `board.restore { board_id }` clears the board's tombstone. Like every other field,
     the board's `deleted` flag is LWW by HLC, so restore is an ordinary supersede.
   - The cascade is **derived, not materialised**: a list or card is only hidden while
     its board is deleted. Nothing is written to them at delete time, so restore brings
     back the board with all its lists and cards as of the delete **plus** anything added
     while it was deleted (those events were never deleted, only unreachable).
   - A card explicitly deleted *before* the board was deleted keeps its own tombstone and
     stays gone after a restore. The two tombstones are independent.
   - An "undo" in the UI is just a `board.restore` within ~30 s; after that the board is
     simply a board again. No special undo state in the format.
3. The board switcher: a dropdown in the header, or a narrow left rail of boards?
   The rail matches the Shrooms Agents view's shape (a list on the left).

---

## 6. What the implementation settled (2026-10-08)

These were open questions above; they are now decisions, because the code forced them.

**A rename is an edit, so it carries `fields`.**
`board.rename` is `{ id, fields: { title } }`, exactly like `list.edit`. It was
briefly `{ id, title }`, and the fold ignored it silently - the edit machinery reads
`payload.fields`. One shape for every edit is worth more than a shorter payload.

**`restore` is `deleted = false`, applied in HLC order.**
The fold walks each record's events in HLC order, so "the last delete/restore wins" is
the whole implementation, on both sides. There is no separate "restored" flag: a record
is deleted if the last such event says so.

**Deleted ids stay in the fold's id set.**
`_allIds.boards` includes tombstoned boards. This is what makes restore possible at all
(and it is the same rule the oracle already used for cards: a reference to a deleted
thing is legitimate state). "Exists" and "is visible" are different questions, and
conflating them made `restoreBoard` refuse to restore the board just deleted.

**The core owns positions and board ids.**
Creates name their board (`createList(boardId, id, title)`); every other action derives
it from the target record. Positions are computed in the core (max + 1000), not passed
in from the view. This keeps every dispatch method at four arguments or fewer, which the
module glue requires, and it stops the view from having to know how ordering works.

**Persistence: the log is the state.**
The core writes the whole log after every change - temp file, then rename - and does so
BEFORE publishing to the UI, so what the user sees is never ahead of what a restart
would restore. A log that cannot be read is reported and left alone, never silently
replaced by an empty one. With no host-provisioned path the core runs in memory.

**A refused action publishes nothing.** `pushState` compares against the last published
state and returns early if it is identical, so a rejected action cannot make the view
re-render or rewrite the log.

**Parity is not enough.** Two engines agreeing proves they agree, not that they are
right: this work found three cases where both folds produced the same wrong answer (an
unimplemented restore, an ignored rename, and a fixture that deleted a card id where it
meant a board id). The v2 semantics are therefore asserted directly, in
`test/semantics.test.mjs` and in the C++ state tests, not only through golden fixtures.

## 7. The layout bug the device found (2026-10-08)

The first v2 build put the board switcher in a narrow left rail: a `ColumnLayout`
inside the board `RowLayout`, with `Layout.preferredWidth` on it and
`Layout.fillWidth` on the board chips inside it. On the Duet that rail took **the whole
row** - measured, rail 1230px, board area 10px - so no list column could render. The
board looked empty while the log was correct, which is exactly the kind of failure that
gets blamed on the data layer.

A nested layout holding a `Layout.fillWidth` child is what does it: `Layout.fillWidth`
inside the rail's ColumnLayout made that ColumnLayout absorb the outer row's extra
space, ignoring its own `Layout.preferredWidth`. Reproduced in isolation: a rail with
only a label measures 180px; the same rail with one `Layout.fillWidth` child measures
1230px.

The fix is not a different rail - a rail was the wrong shape anyway, and the device said
so. The switcher is a **popup on the board name in the header**, so it costs the board
no width at all.

Two lessons worth keeping:
1. **A nested layout with a fill child can eat its parent's space.** Measure the
   geometry; do not reason about it.
2. **`tools/probe-render.py` exists because reasoning failed.** It runs the real view on
   a real Qt engine against a canned snapshot and returns the value you ask for as an
   EXIT CODE (console.log from the `qml` tool does not reach the caller, and screenshots
   of an Xvfb window come back blank). It discriminates: pointed at the pre-fix view it
   reports 1 (10px), at the fixed view 125 (1250px).
