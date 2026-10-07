// Events — C++ mirror of contract/events.mjs
// Event = { v:1, id:UUIDv4, type, hlc:{wall,ctr,dev}, dev, payload }
#pragma once

#include <string>
#include <vector>

#include "hlc.hpp"
#include "nlohmann/json.hpp"

namespace board {

using json = nlohmann::json;

struct Event {
  int v = 1;
  std::string id;
  std::string type;
  Hlc hlc;
  std::string dev;
  json payload;
};

// Parse a wire event. Throws std::invalid_argument when malformed.
Event parse_event(const json& j);

// Non-throwing validation: empty vector == valid. Mirrors validateEvent().
std::vector<std::string> validate_event(const json& j);

// Serialize an event back to its wire form (same key set as the JS object).
json event_to_json(const Event& e);

// Payload field allowlists (mirrors LIST_FIELDS / CARD_FIELDS).
extern const std::vector<std::string> kListFields;
extern const std::vector<std::string> kCardFields;

}  // namespace board
