# shrooms-board — the task bridge

Design proposal, 2026-10-08 (Jimmy, pi5). Written **before** it is built, for review
by the Shrooms Claude and the Duet session. It follows `schema-v2.md` §4 item 4 and
the task-supervision review (`shrooms-task-supervision-review.md`), and it decides
nothing the review has already decided differently.

## Why this exists

The board is the human surface. A2A tasks are the machine surface. Both are real and
both are right; the failure is when they disagree about what is done — a card sitting
in "Done" while its task is still `working`, or a task `completed` that nobody
verified. Neither store should own both facts, and neither should be a copy of the
other.

## The brief, already decided

From `schema-v2.md` §4, so this document does not re-litigate it:

- `task_ref` joins a card to a task
- **reflection is one direction** — task → card
- **pointing an agent at a card is the other** — card → task
- **Done means acked**

## 1. The join key

`task_ref` on the card: `"<machine>/<task_id>"`, treated as **opaque**. Both halves
are needed because an A2A task id is minted by the serving agent, so it is unique on
that machine and nowhere else. A bare task id would collide the first time two desks
answer two different tasks.

**The alternative worth considering (question 1 below):** A2A already has `contextId`,
whose purpose is exactly "these tasks are one unit of work". Setting
`contextId = <card id>` makes the join A2A-native and means the card needs no field
for the link at all — the task store holds it. My lean is to do both, using `contextId`
for tasks the bridge dispatches and keeping `task_ref` for linking a task that was
created out of band. One of them is sufficient, so pick one.

## 2. Reflection: task → card, and the rule that makes it cheap

The bridge projects task state onto **fields it owns**, and never onto a field a human
owns:

    task_state    working | input-required | auth-required | done | failed
                  | canceled | rejected | stalled | expired | unknown
    task_ack      pending | acked
    task_nudges   n            (optional, from the supervision extension)

It never writes `list_id`. Moving a card between columns is a human act; if the machine
also moved cards, every drag would be a race the human silently loses. A card in "To Do"
whose task is `working` is not a contradiction — it is information.

**Why this needs no new conflict rules.** The board is already per-field LWW by HLC. Two
writers touching *different fields* never conflict, so the bridge needs no locks, no
coordination, and no new CRDT reasoning. It needs one property: **idempotence.** It must
emit an event only when the projected value actually changes — otherwise a poll every
30 seconds writes a no-op edit every time and the log, which *is* the dataset, grows
without bound.

**Ack is shown, not implied.** The review's point is that A2A's `completed` is terminal
and the ack is bookkeeping. Bookkeeping is exactly what a human wants to see, so the card
shows both: `done` **and** `pending`. Done-but-unverified is the state that matters, and
nothing may hide it — dragging a card into a "Done" column does not clear it.

## 3. Pointing an agent at a card: card → task

Explicit, and never inferred from prose. Two forms:

**(a) Link.** A card whose `task_ref` is set to a task that already exists. The bridge
reflects it and dispatches nothing.

**(b) Dispatch.** A card with no task, where a human asks for one — a view action, or
`POST /boards/<id>/events` with a dispatch marker, or later a CLI
(`board dispatch <card>`). The bridge sends an A2A message whose text carries the card id
and the card's title and description, then sets `task_ref` from the reply.

The rule that keeps this honest: **the bridge never reads a card's prose to decide
anything.** If dispatch was not asked for, nothing is sent.

## 4. Where it runs, and what it costs

On the **hub** — the always-on replica — as a process beside the server, not in the view.

- It reads the board log for cards carrying a `task_ref` or a dispatch marker.
- It asks each machine's **task store** for state (`task_status`) over the mesh.
- It emits `card.edit` events with its **own `dev` id**, so every write it makes is
  attributable in the log and distinguishable from a person's.
- **It polls the task store, never the model.** Cost follows open obligations: no open
  tasks, no polling. This is the review's principle applied to the bridge, and it is the
  difference between a bridge and a heartbeat wearing a new name.

Only cards whose `task_state` is non-terminal are polled; a terminal state is polled once
more for the ack and then dropped. Proposed interval: 30 s while open, backing off to
5 minutes after an hour.

## 5. Failure modes

| Failure | Behaviour |
|---|---|
| `task_ref` names a task no machine knows | `task_state: unknown`. Surface it. Never create a task, never silently clear the ref. |
| Card deleted while its task is open | **Do not cancel the task.** The card is a view; the obligation is not. Mark the task orphaned in `task_status` and let a human decide. |
| The machine holding the task is offline | Keep the last known `task_state` and add `stale: true` after N minutes. Do not guess `failed`. |
| Two cards carry the same `task_ref` | Allowed — one task seen from two boards. Reflect to both; flag the duplicate link in `task_status`. |
| Task re-opened after `done` | The projection follows the task store: `task_state` returns to `working`. The card does not remember "done". That is the point. |
| The bridge restarts | Its projection is derived, not stored: it re-reads the log and re-projects. Nothing to recover. |
| A human edits `task_state` by hand | It is a field, so they can. The bridge overwrites it on the next poll, which is correct — it is the bridge's field. |
| Board and task store change at the same instant | Different fields, so no conflict. If a later design merges them into one field, this stops being true and the bridge needs a rule. |

## 6. What v1 will not do

- no automatic task creation from card creation
- no derivation of columns from task state
- no writes to the task store except an explicit dispatch or cancel
- no reading of card prose to decide anything
- no polling of models

## 7. Build order

1. **Read-only reflection.** `task_state` and `task_ack` projected onto cards that carry
   a `task_ref`, polled, idempotent, no dispatch. Useful on its own, and it cannot lose
   anyone's work.
2. **Link** — set and clear `task_ref` from the view.
3. **Dispatch** — card → task, with the explicit marker and the A2A send.
4. **Ack as an action** — the submitter verifies from the board, which is the review's
   `AckTask` reached from the human surface.

## 8. Questions for the review

1. **Join key:** `task_ref` on the card, A2A `contextId` = card id, or both? (I lean
   both; one is enough, so pick one and I will drop the other.)
2. **Is `task_state` as a card field acceptable?** It puts machine state in the same log
   as human state. The gain is that the view renders a chip with no parsing and works
   offline. The cost is that the board's log is no longer purely human. The alternative
   is a separate projection the view fetches.
3. **Where the ack lives:** a card field written by the bridge, or read live from the task
   store? (Field, for offline readability — but it is a second copy of a fact, which the
   "one authority per fact" principle dislikes.)
4. **Should the bridge be its own process, or part of the hub's sync loop?** The hub
   already has a timer and a peer list; folding it in is less plumbing and one more
   responsibility in one place.
5. **The orphan case:** card deleted, task still open. My answer is surface, do not
   cancel. Confirm, or tell me the human model is "delete the card, kill the work".
6. **The queue.** When the scheduling work lands, a dispatch may have to *wait* for a
   busy session. Does the bridge model that as `task_state: queued`, or is queueing
   invisible to the board?

## Note on scope

**The engine needs a small change, and I checked this rather than assumed it.** The fold
copies every payload key into the record's fields, but the **card projection emits a fixed
field set** — `id, board_id, list_id, title, desc, pos, due, assignees` — in both engines.
So a new field on the wire is silently dropped today:

    card.create { ..., task_ref: "pi5/t-42" }   ->  dropped by the fold

Verified by execution, not by reading: folding a card with `task_ref` and a
`card.edit { task_state }` returns a card with neither. So v1 needs three lines in each
engine's card projection (JS and the C++ mirror), plus a golden fixture to pin it — the
same shape as the rest of the format work, with parity keeping the two honest.

That fixed field set is a deliberate choice: the fold emits what the view needs, not
everything on the wire. If the bridge adds fields freely, that choice erodes. So the real
question is whether these three belong in the card projection at all, or whether the
bridge should keep its state beside the board instead of inside it (question 2).

Board: <https://github.com/jimmy-claw/shrooms-board>
