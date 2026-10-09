// Events — C++ mirror of contract/events.mjs
#include "events.hpp"

#include <stdexcept>

namespace board {

const std::vector<std::string> kListFields = {"title", "pos"};
const std::vector<std::string> kCardFields = {"title", "desc", "pos", "list_id", "due", "task_ref", "task"};

namespace {
int64_t get_i64(const json& j, const char* key) {
  if (!j.contains(key) || !j.at(key).is_number_integer()) {
    throw std::invalid_argument(std::string("expected integer field: ") + key);
  }
  return j.at(key).get<int64_t>();
}
std::string get_str(const json& j, const char* key) {
  if (!j.contains(key) || !j.at(key).is_string()) {
    throw std::invalid_argument(std::string("expected string field: ") + key);
  }
  return j.at(key).get<std::string>();
}
}  // namespace

Event parse_event(const json& j) {
  const auto problems = validate_event(j);
  if (!problems.empty()) {
    std::string msg = "invalid event:";
    for (const auto& p : problems) msg += " " + p + ";";
    throw std::invalid_argument(msg);
  }
  Event e;
  e.v = j.at("v").get<int>();
  e.id = get_str(j, "id");
  e.type = get_str(j, "type");
  const json& h = j.at("hlc");
  e.hlc = Hlc{get_i64(h, "wall"), get_i64(h, "ctr"), get_str(h, "dev")};
  e.dev = get_str(j, "dev");
  e.payload = j.at("payload");
  return e;
}

std::vector<std::string> validate_event(const json& j) {
  std::vector<std::string> problems;
  if (!j.is_object()) return {"event is not an object"};
  if (!j.contains("v") || !j.at("v").is_number_integer() || j.at("v").get<int>() != 1) {
    problems.push_back("v must be 1");
  }
  if (!j.contains("id") || !j.at("id").is_string() || j.at("id").get<std::string>().size() < 8) {
    problems.push_back("id must be a string");
  }
  if (!j.contains("type") || !j.at("type").is_string()) problems.push_back("type must be a string");
  if (!j.contains("hlc") || !j.at("hlc").is_object()) {
    problems.push_back("hlc must be {wall, ctr, dev}");
  } else {
    const json& h = j.at("hlc");
    const bool ok = h.contains("wall") && h.at("wall").is_number_integer() && h.contains("ctr") &&
                    h.at("ctr").is_number_integer() && h.contains("dev") && h.at("dev").is_string() &&
                    valid_dev(h.at("dev").get<std::string>());
    if (!ok) problems.push_back("hlc must be {wall, ctr, dev}");
  }
  if (!j.contains("dev") || !j.at("dev").is_string() || !valid_dev(j.at("dev").get<std::string>())) {
    problems.push_back("dev must be 32 hex chars");
  }
  if (!j.contains("payload") || !j.at("payload").is_object()) {
    problems.push_back("payload must be an object");
  }
  return problems;
}

json event_to_json(const Event& e) {
  return json{{"v", e.v},
              {"id", e.id},
              {"type", e.type},
              {"hlc", json{{"wall", e.hlc.wall}, {"ctr", e.hlc.ctr}, {"dev", e.hlc.dev}}},
              {"dev", e.dev},
              {"payload", e.payload}};
}

}  // namespace board
