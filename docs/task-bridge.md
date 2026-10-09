# shrooms-board — the task bridge

Design, 2026-10-08 (Jimmy, pi5); **revised 2026-10-09 after review** by laptop/shrooms
(`task-bridge-review.md`). Follows `schema-v2.md` §4 and the task-supervision review.
The review's four must-fixes and six answers are adopted below, not re-argued; where it
overturned me, the old text is gone rather than kept as an alternative.

## Why this exists

The board is the human surface. A2A tasks are the machine surface. Both are real; the
failure is when they disagree about what is done — a card in "Done" while its task is
still `working`, or a task `completed` that nobody verified. Neither store owns both
facts, and neither is a copy of the other.

## The brief, already decided

From `schema-v2.md` §4:

- `task_ref` joins a card to a task
- **reflection is one direction** — task → card
- **pointing an agent at a card is the other** — card → task
- **Done means acked**

## 1. The join key

`task_ref` = `"<machine>/<session>:<messageId>"`, treated as **opaque**. Both halves are
needed because an A2A task id is minted by the serving agent, so it is unique on that
machine and nowhere else.

**`contextId` cannot be the join, and the review proved it against the code.** shrooms-agent
sets a task's `contextId` to the session's own conversation id (`view()`: `ctx = s.convID`)
whatever the client sends, so a client cannot choose it. My earlier lean toward
`contextId` is withdrawn. `task_ref` is the key, and with §3 it is **computable from the
card** before anything is sent.

## 2. Reflection: task → card

The bridge writes **one object it owns**, never a field a human owns:

    task          { state, ack, at, stalled? }        (bridge-owned, single field)
    task_ref      "<machine>/<session>:<messageId>"   (a link; a human may set it)

`state` is A2A's, plus the two the review added: `submitted | queued | working |
input-required | auth-required | completed | failed | canceled | rejected | stalled |
expired | unknown`. `ack` is `pending | acked`. `at` is the **task store's own
`status.timestamp`** for that state. `stalled` comes from the task store's supervision,
not from the bridge's clock.

It never writes `list_id`. Moving a card between columns is a human act; if the machine
also moved cards, every drag would be a race the human silently loses. A card in "To Do"
whose task is `working` is not a contradiction — it is information.

### The three rules, without which it flaps

1. **Idempotence alone is not enough; it needs a source version.** "Emit only when the
   projected value changes" compares the observation against the log, so two bridges with
   different observations rewrite each other forever — and two bridges happen easily (a
   second hub, a local dev bridge, or one bridge that sees a machine offline and one that
   does not). So the bridge **writes only when the task store's timestamp is newer than
   the one already on the card *and* the value differs.** Its writes are then monotonic in
   the task store's own clock, and duplicate bridges, replays and late pollers are
   harmless. Per-field LWW by HLC orders writes, not observations; this is what supplies
   the missing agreement between bridges and across a restart or partition.
2. **Nothing derived from the clock or the network goes in the log.** No `stale: true`
   (a laptop lid would write it twice per card per night, forever) and no `task_nudges`
   (reminder chatter). The card shows **`as of <at>`** and lets the view judge age; a
   stalled task is shown as `stalled`, which is a fact from the task store.
3. **Ownership is enforced, not a convention.** The fold accepts `task_*` fields **only
   from the bridge's `dev` id(s)**, and the view does not offer to edit them. The
   failure-mode row "a human edits `task_state` by hand" then cannot happen.

**Why one object, not three fields.** LWW on one field keeps `state`, `ack` and `at`
consistent with each other, so a reader never sees `completed` from one write beside
`pending` from another. It is also a smaller engine change: one field in each projection.

**Ack is shown, not implied.** A2A's `completed` is terminal; the ack is bookkeeping, and
bookkeeping is what a human wants to see. The card shows both — `completed` **and**
`pending` — and dragging into a "Done" column does not clear it.

## 3. Pointing an agent at a card: card → task

Explicit, never inferred from prose. Two forms:

**(a) Link.** A card whose `task_ref` is set to a task that already exists. The bridge
reflects it and dispatches nothing.

**(b) Dispatch.** A card with no task, where a human asks for one. **Idempotent by
construction**, so a crash cannot start a second turn on the same card:

1. derive the `messageId` from the card — `board-<cardId>-<dispatchEventId>` — and so
   derive `task_ref` = `<machine>/<session>:<messageId>`;
2. **write `task_ref` to the card first**;
3. then send the A2A message.

shrooms-agent treats a repeated `messageId` as the same task ("a messageId seen before is
the same task"), so a replay after a crash lands on the same task instead of a new one.
The earlier order — send, then set `task_ref` from the reply — is withdrawn: a crash
between the two duplicated the work.

The rule that keeps this honest: **the bridge never reads a card's prose to decide
anything.** If dispatch was not asked for, nothing is sent.

## 4. Where it runs, and what it costs

**Inside the hub's process, as its own loop with its own `dev` id** — not a separate
binary. Being part of the hub gives one bridge per board for free; a separate binary
invites the "dev runs one locally" duplicate that rule 1 would then have to absorb.

- It reads the board log for cards carrying `task_ref` or a dispatch marker.
- It asks each machine's **task store** for state — **per machine, not per card**:
  `GET /v1/tasks` (or A2A `ListTasks`) returns all of that machine's tasks in one request,
  which stays one request per machine per tick as the board grows.
- It emits `card.edit` events with its own `dev` id, so every write is attributable.
- **It polls the task store, never the model.** Cost follows open obligations: no open
  tasks, no polling. That is the difference between a bridge and a heartbeat under a new
  name.

Terminal-but-unacked tasks are **polled on the slow schedule until acked** — not dropped
after one more look — because an ack may be given anywhere (CLI, MCP `task_ack`), and the
card would otherwise say `pending` forever. They are polled until acked or until the task
store drops them (finished tasks are kept about a week). Proposed interval: 30 s while
open, backing off to 5 minutes after an hour; terminal-unacked on the slow schedule.

## 5. Failure modes

| Failure | Behaviour |
|---|---|
| `task_ref` names a task no machine knows | `state: unknown`. Surface it. Never create a task, never silently clear the ref. |
| Card deleted while its task is open | **Do not cancel the task, and do not write to the task store** (§6). Surface the orphan **on the board**: a board-level list of `task_ref`s whose card is gone. The card is a view; the obligation belongs to the task store and its asker. |
| The machine holding the task is offline | Keep the last known object; the card shows `as of <at>`. No `stale` flag — nothing clock-derived is written. Do not guess `failed`. |
| Two cards carry the same `task_ref` | Allowed — one task seen from two boards. Reflect to both; flag the duplicate link on the board. |
| The bridge restarts | Its projection is derived, not stored: it re-reads the log and re-projects. Nothing to recover. |
| A second bridge exists | Harmless: with the source-version rule the writes are monotonic in the task store's clock, so they cannot flap. |
| A human edits the bridge's `task` object | The fold rejects `task_*` from any `dev` other than the bridge's, so it cannot happen. |
| Board and task store change at the same instant | Different fields, so no conflict. The one-field object keeps the bridge's own fields consistent. |
| Task "re-opened" after completion | It cannot be: `completed` is final and a follow-up is refused ("task … is completed"). Further work is a **new task** with `referenceTaskIds`, which is a dispatch from the board and sets a new `task_ref`. |

## 6. What v1 will not do

- no automatic task creation from card creation
- no derivation of columns from task state
- **no writes to the task store except an explicit dispatch or cancel** — including no
  "orphaned" marker (the task store has no such field)
- no reading of card prose to decide anything
- no polling of models
- **no clock- or network-derived writes** (no `stale`, no nudge counts)

## 7. Build order

1. **Read-only reflection.** The `task` object projected onto cards that carry a
   `task_ref`, polled per machine, version-gated, no dispatch. Useful on its own and it
   cannot lose anyone's work.
2. **Link** — set and clear `task_ref` from the view.
3. **Dispatch** — card → task, `task_ref` first, then send.
4. **Ack as an action** — the submitter verifies from the board (the review's `AckTask`
   reached from the human surface).
5. **Orphan surfacing** — the board-level list from §5.

## 8. The review's answers (adopted)

1. **Join key:** `task_ref`, derived from the card at dispatch (fix 1) or set by hand.
2. **Machine state on the card:** yes — as one bridge-owned object, written only on a
   newer source version, with nothing time-derived. A cache of facts with provenance and a
   timestamp, not a second opinion. Offline rendering is worth it; a fetched projection
   gives up exactly what a phone on a train needs.
3. **The ack:** in the same object, carrying the task's timestamp — a labelled copy
   (`as of …`), not a second authority. The task store stays the authority; the card says
   when it last heard.
4. **Process:** inside the hub, its own loop, its own `dev` id.
5. **Orphan:** surface, never cancel.
6. **The queue:** show `queued` (`submitted` + `shrooms/queued`).

**The decision I was proudest of, amended.** Disjoint field ownership under per-field LWW
does remove human-vs-bridge coordination. What it does not give is agreement between
bridges, or between one bridge and its past self across a restart or partition — which is
where idempotence alone flaps. The source version (rule 1) makes it sound.

## Note on scope

**The engine needs a small change, and I checked this rather than assumed it.** The fold
copies every payload key into the record's fields, but the **card projection emits a fixed
field set** — `id, board_id, list_id, title, desc, pos, due, assignees` — in both engines.
So a new field on the wire is silently dropped today:

    card.create { ..., task_ref: "pi5/..." }   ->  dropped by the fold

Verified by execution: folding a card with `task_ref` and a `card.edit { task }` returns a
card with neither. So v1 needs, in each engine's card projection (JS and the C++ mirror):

- **two fields** — `task_ref` and `task` (one object, not three fields);
- **an ownership gate** — `task` accepted only from the bridge's `dev` id(s);
- **a golden fixture** to pin both, with parity keeping the two engines honest.

That fixed field set is deliberate: the fold emits what the view needs, not everything on
the wire. Adding two named fields keeps that choice; letting the bridge add fields freely
would erode it.

Board: <https://github.com/jimmy-claw/shrooms-board>
