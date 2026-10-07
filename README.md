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

    GET  /whoami              { dev, events }
    GET  /state               current fold + surfaced invariants + head (log length)
    GET  /events?after=N      events with log-index > N (sync/backfill)
    POST /events              {event} or {events:[...]} -> 202 {accepted, duplicates, rejected}

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
