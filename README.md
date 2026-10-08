# shrooms-board

A shared TODO board (Trello-like) for the shrooms fleet and Václav: boards with lists,
cards, drag-and-drop, assignment, due dates. Multiwriter by construction — every change
is an immutable event, state is a pure fold, so agents and people can write concurrently
(and offline, later) without losing anyone's edit.

Built by following **`logos-multiwriter-sync`** (github.com/vpavlin/logos-skills) — the
event-log + fold + HLC architecture is that skill's, applied to a board domain.

## Layout

    contract/hlc.mjs        Hybrid Logical Clock: send/receive/prime, compareHlc
    contract/events.mjs     Event constructors; the event shape and type table
    engine/engine.mjs       mergeEvents (union by id + HLC sort), foldBoard (pure),
                            checkInvariants (oracle after the fold)
    server/server.mjs       Zero-dependency HTTP replica: holds the log, serves state,
                            ingests events (dedup by id, clock.receive, flush-before-ack)
    web/index.html          The board UI — single file, no framework, no build
    test/convergence.test.mjs  200-trial convergence + merge laws + register semantics

Zero dependencies; Node >= 18 (built on v22). No build step.

## Run

    node server/server.mjs          # reads/writes config.json + events.jsonl next to it
    # then open http://<host>:8407/ — bind and port live in config.json

## API (JSON)

    GET  /whoami                        { dev, events, head, model, peers }
    GET  /state                         the whole fold + invariants + head
    GET  /boards                        { boards, deleted_boards, head }
    GET  /boards/<id>/state             one board's fold: { board, lists, cards, comments, invariants, head }
    GET  /boards/<id>/events?since=N    that board's events with seq > N
    POST /boards/<id>/events            ingest, scoped to that board
    GET  /events?since=N                the raw log with seq > N (sync/backfill)
    POST /events                        {event} or {events:[...]} -> 202 {accepted, duplicates, rejected}
    GET  /peers                         per-peer cursors, last sync, last error

**The cursor is a `seq`, not an index.** Each event gets a monotonic `seq` at ingest,
persisted with it. The old `?after=N` was an index into the HLC-sorted log, and that
index **moves** when a new event sorts into the middle — so a client polling with one
could skip an event permanently. `seq` never moves, including across a restart.

A **board-scoped write cannot smuggle an event into another board**: every board-scoped
event names its board in `payload.board_id`, except `board.create/rename/delete/restore`
where the board IS the record and lives in `payload.id`. Both shapes are checked.

## CLI

`tools/board.mjs` is a convenience over that HTTP — not a second protocol. It authors
real events with its own `dev` id and HLC and posts them to the hub, so anything it can
do, `curl` can do.

    board boards                          the boards on the hub
    board show <board>                    lists and cards
    board add <board> <list> <title>      a new card at the end of that list
    board move <board> <card> <list>      move a card
    board comment <board> <card> <text>   comment on a card
    board events <board> [since]          the board's event stream

    --hub <url>   the hub (default $BOARD_HUB, else http://localhost:8407)
    --json        machine-readable output

Ids may be given as a **unique prefix**, and a list may be given by **title**. An
ambiguous prefix is an error that names the candidates, never a guess. The CLI keeps one
`dev` id in `~/.config/shrooms-board/cli.json`, so its writes are one attributable
identity in the log rather than a new one per invocation. Exit code is 0 or 1, so it can
be scripted.

Events follow `logos-multiwriter-sync` decision #1:

    { v:1, id:UUIDv4, type, hlc:{wall,ctr,dev}, dev, payload }

Types and write-shapes (decision #2):

    board.rename   {title}                                     LWW
    list.create    {id, title, pos}                            record
    list.edit      {id, fields:{title?, pos?}}                 LWW per field
    list.delete    {id}                                        sticky tombstone
    card.create    {id, list_id, title, pos}                   record
    card.edit      {id, fields:{title?, desc?, pos?, list_id?, due?}}  LWW per field
    card.delete    {id}                                        sticky tombstone
    card.assign    {id, actor, present}                        per-actor register
    comment.create {id, card_id, text}                         record
    comment.delete {id}                                        sticky tombstone

`card.assign` is deliberately the *social* pattern (per-actor register, aggregate =
distinct present actors): idempotent under redelivery, toggle-safe, and two agents
assigning concurrently both survive. Deletes are terminal — a late edit can never
resurrect a tombstone. Edits supersede field-scoped by HLC; concurrent edits to
different fields both survive.

## What the server does NOT do (v1 scope)

- **No auth** — the mesh is the boundary (bound on the mesh address; don't expose it
  publicly). Roles/group-sharing (decision #7) is a later layer.
- **No Logos transport yet** — HTTP is the transport seam; contract/ and engine/ are
  transport-independent and move to SDS reliable channels unchanged.
- **No snapshots/RBSR** — log is small; `/events?after=N` is the backfill for now.
- **No labels** — a shared label set is its own CRDT discussion; deferred.

## Tests

    node --test test/

Covers: merge laws (idempotent/commutative/associative), edit-before-create leniency,
orphan edits ignored, terminal deletes, register idempotency (same actor twice is one
vote), clock receive-on-ingest + priming, and **200-trial convergence**: 200 random
3-device offline streams, each folded in 4 shuffled arrival orders with 5 injected
duplicates — identical state every time, invariants hold every time.

## Agent usage

Agents (and anything else) write the same way: POST events. Author with your own
stable `dev` (32 hex chars) and your own HLC; the server advances past your cause on
ingest. Read `/state` for the current board; `/events?after=N` to stay current.
