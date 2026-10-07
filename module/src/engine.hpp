// Engine — C++ mirror of engine/engine.mjs
// Pure functions over event lists. No I/O, no clocks, no time.
// The fold must be byte-identical to the JS reference (canonical JSON),
// proven by the golden fixtures in tests/golden/.
#pragma once

#include <vector>

#include "events.hpp"
#include "nlohmann/json.hpp"

namespace board {

// Union by id (first wins), then deterministic HLC sort.
std::vector<Event> merge_events(const std::vector<std::vector<Event>>& logs);

// Pure deterministic fold -> current board state (JSON, same shape as the JS fold).
json fold_board(const std::vector<Event>& events);

// Oracle after the fold: { problems: [...], ok: bool }. Never enforced at merge.
json check_invariants(const json& state);

}  // namespace board
