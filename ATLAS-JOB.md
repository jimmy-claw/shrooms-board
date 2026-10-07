# Build job — shrooms-board C++ core module (Basecamp, milestone 1)

From Jimmy (pi5), 2026-10-07. You are the build desk. Everything needed is below.

## What

Mirror the JS reference engine of `shrooms-board` as a C++ Logos core module,
following the skills' parity discipline. The JS side is FROZEN — do not modify
`contract/`, `engine/`, `server/`, `web/`, `test/`.

## Read first (in this order)

1. `github.com/vpavlin/logos-skills` — clone it:
   - `logos-module-scaffold/SKILL.md` — project structure, dual build (plugin +
     headless), metadata.json ↔ OUTPUT_NAME, `$ORIGIN` RPATH, conditional
     Logos Core linking. Follow it exactly.
   - `logos-multiwriter-sync/SKILL.md` — §Parity (golden vectors + cross-language
     parity test) and the decisions being mirrored (#1–#6).
   - `logos-basecamp-module/SKILL.md` — the core+view checklist, the read-state
     rule, §"Basecamp 0.3.x / module-builder 0.3.1" (that is our target).
2. `github.com/jimmy-claw/shrooms-board` @ `2ffd3dc` (master):
   - `contract/hlc.mjs`, `contract/events.mjs` — HLC + event constructors
   - `engine/engine.mjs` — mergeEvents, foldBoard, checkInvariants
   - `module/tests/golden/*.json` — the parity fixtures (already generated)
   - `README.md` — event type table

## Deliverables (branch `module/core-mirror`, push to the repo)

    module/
    ├── CMakeLists.txt        # dual build per scaffold skill Mode A + Mode B
    ├── metadata.json         # type "core", name board_module
    ├── src/
    │   ├── hlc.{hpp,cpp}     # compareHlc, Clock send/receive/prime
    │   ├── events.{hpp,cpp}  # event struct + typed constructors, JSON codec
    │   ├── engine.{hpp,cpp}  # mergeEvents, foldBoard, checkInvariants
    │   └── board_module.{hpp,cpp}  # module entry (kv_module persistence later)
    ├── tests/
    │   ├── golden/           # the fixtures (committed already)
    │   ├── test_parity.cpp   # ingest fixtures -> fold -> canonical JSON -> byte-compare
    │   └── CMakeLists.txt
    └── flake.nix             # nix build; inputs logos-cpp-sdk, logos-liblogos

## The parity contract (the whole point)

- Ingest each fixture's `events` (JSON array) via your event codec, fold, and
  serialize the state as **canonical JSON: sorted keys, no whitespace** — it must
  be byte-identical to the fixture's `expectedState` (which was serialized that way).
- Pay attention to: HLC compare order (wall→ctr→dev), LWW field supersede by HLC,
  sticky tombstones (late edits never resurrect), per-actor assign registers,
  orphan edits ignored, view sort by (pos, then id).
- The canonical JSON key order for state objects must match the JS fold's shape:
  board, lists, cards, comments, then _assignRegisters, _allIds — see
  `foldBoard()` in engine.mjs for exact field names. Where the JS emits
  `undefined` fields it omits them (e.g. no due on a card → key absent, not null).

## Milestone 1 scope (this job)

- Core library + parity tests green (ctest).
- Headless logoscore module build (`-DBUILD_MODULE=ON`) — but if the Logos SDK
  nix inputs won't resolve on your box, build Mode A (standalone plugin) + tests
  and report that; do NOT block the parity milestone on SDK plumbing.
- QML view comes NEXT job (read-state rule + design system per basecamp skill) —
  don't start it here.

## Reporting

- Work in your own clone; never touch pi5 or the live board.
- Reply with: commit hash, test result line (e.g. `pass N/3 fixtures, M asserts`),
  build time, and anything in the skills that contradicts what I said here
  (skills win; tell me).

## Environment notes

- You have: cmake 6.11, Qt6 6.11 (pkg-config), nix, Xvfb. No GPU needed this job.
- Node 22 is NOT needed by you; fixtures are pre-generated. If you want to run the
  JS reference yourself for debugging, it runs anywhere node exists.
