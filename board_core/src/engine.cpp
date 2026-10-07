// Engine — C++ mirror of engine/engine.mjs
#include "engine.hpp"

#include <algorithm>
#include <string>
#include <unordered_map>
#include <unordered_set>

namespace board {

namespace {

// A record reconstructed from create + field-scoped edits (LWW by HLC) + terminal delete.
struct Record {
  bool deleted = false;
  std::unordered_map<std::string, json> fields;  // field -> value (LWW already applied)
};

// Groups events by record id, preserving FIRST-INSERTION order of the ids
// (JS Map semantics: set() on an existing key keeps its original position).
class OrderedGroups {
 public:
  void add(const std::string& id, const Event& e) {
    auto it = groups_.find(id);
    if (it == groups_.end()) {
      order_.push_back(id);
      groups_.emplace(id, std::vector<Event>{e});
    } else {
      it->second.push_back(e);
    }
  }
  const std::vector<std::string>& order() const { return order_; }
  const std::vector<Event>& at(const std::string& id) const { return groups_.at(id); }

 private:
  std::vector<std::string> order_;
  std::unordered_map<std::string, std::vector<Event>> groups_;
};

// create + edits + sticky delete; nullopt when there is no create (orphan edits ignored).
bool reconstruct(const std::string& kind, const std::vector<Event>& events, Record* out) {
  const Event* create = nullptr;
  std::vector<const Event*> edits;
  bool deleted = false;
  for (const auto& e : events) {  // pre-sorted by HLC
    if (e.type == kind + ".create") {
      if (!create) create = &e;  // duplicate record ids: first by HLC wins
    } else if (e.type == kind + ".edit") {
      edits.push_back(&e);
    } else if (e.type == kind + ".delete") {
      deleted = true;
    }
  }
  if (!create) return false;

  out->deleted = deleted;
  out->fields.clear();
  for (auto it = create->payload.begin(); it != create->payload.end(); ++it) {
    if (it.key() == "id") continue;
    out->fields[it.key()] = it.value();
  }
  for (const Event* e : edits) {
    if (!e->payload.contains("fields") || !e->payload.at("fields").is_object()) continue;
    for (auto it = e->payload.at("fields").begin(); it != e->payload.at("fields").end(); ++it) {
      out->fields[it.key()] = it.value();  // LWW per field by HLC sort order
    }
  }
  return true;
}

struct ActorReg {
  std::string actor;
  bool present = false;
  Hlc hlc;
};

// card id -> ordered actor registers (first-appearance order, LWW by HLC).
struct Registers {
  std::vector<std::string> card_order;
  std::unordered_map<std::string, std::vector<ActorReg>> by_card;

  void apply(const Event& e) {
    const std::string& card_id = e.payload.at("id").get<std::string>();
    const std::string& actor = e.payload.at("actor").get<std::string>();
    const bool present = e.payload.at("present").get<bool>();
    auto it = by_card.find(card_id);
    if (it == by_card.end()) {
      card_order.push_back(card_id);
      by_card.emplace(card_id, std::vector<ActorReg>{{actor, present, e.hlc}});
      return;
    }
    for (auto& reg : it->second) {
      if (reg.actor == actor) {
        if (compare_hlc(e.hlc, reg.hlc) > 0) {
          reg.present = present;
          reg.hlc = e.hlc;
        }
        return;
      }
    }
    it->second.push_back(ActorReg{actor, present, e.hlc});
  }
};

bool has(const std::unordered_map<std::string, json>& fields, const std::string& key) {
  return fields.find(key) != fields.end();
}

// JS: fieldVal(rec, k) -> value | undefined. Here: value, or json() (null) when absent.
json field_val(const Record& r, const std::string& key) {
  auto it = r.fields.find(key);
  if (it == r.fields.end()) return json();
  return it->second;
}

}  // namespace

std::vector<Event> merge_events(const std::vector<std::vector<Event>>& logs) {
  std::vector<Event> merged;
  std::unordered_set<std::string> seen;
  for (const auto& log : logs) {
    for (const auto& e : log) {
      if (seen.insert(e.id).second) merged.push_back(e);
    }
  }
  std::stable_sort(merged.begin(), merged.end(),
                   [](const Event& a, const Event& b) { return compare_hlc(a.hlc, b.hlc) < 0; });
  return merged;
}

json fold_board(const std::vector<Event>& events) {
  const std::vector<Event> sorted = merge_events({events});

  std::vector<const Event*> board_renames;
  OrderedGroups list_groups, card_groups, comment_groups;
  Registers regs;

  for (const auto& e : sorted) {
    if (e.type == "board.rename") {
      board_renames.push_back(&e);
      continue;
    }
    if (e.type == "card.assign") {
      regs.apply(e);
      continue;
    }
    const std::string kind = e.type.substr(0, e.type.find('.'));
    const std::string id = e.payload.at("id").get<std::string>();
    if (kind == "list") list_groups.add(id, e);
    else if (kind == "card") card_groups.add(id, e);
    else if (kind == "comment") comment_groups.add(id, e);
  }

  std::vector<std::string> list_order, card_order, comment_order;
  std::unordered_map<std::string, Record> list_state, card_state, comment_state;
  for (const auto& id : list_groups.order()) {
    Record r;
    if (reconstruct("list", list_groups.at(id), &r)) { list_state[id] = r; list_order.push_back(id); }
  }
  for (const auto& id : card_groups.order()) {
    Record r;
    if (reconstruct("card", card_groups.at(id), &r)) { card_state[id] = r; card_order.push_back(id); }
  }
  for (const auto& id : comment_groups.order()) {
    Record r;
    if (reconstruct("comment", comment_groups.at(id), &r)) { comment_state[id] = r; comment_order.push_back(id); }
  }

  json view;
  view["board"] = json{{"title", nullptr}};
  if (!board_renames.empty()) {
    view["board"]["title"] = board_renames.back()->payload.value("title", json());
  }

  view["lists"] = json::array();
  for (const auto& id : list_order) {
    const Record& r = list_state[id];
    if (r.deleted) continue;
    json l;
    l["id"] = id;
    if (has(r.fields, "title")) l["title"] = field_val(r, "title");
    if (has(r.fields, "pos")) l["pos"] = field_val(r, "pos");
    view["lists"].push_back(l);
  }

  view["cards"] = json::array();
  for (const auto& id : card_order) {
    const Record& r = card_state[id];
    if (r.deleted) continue;
    json c;
    c["id"] = id;
    if (has(r.fields, "list_id")) c["list_id"] = field_val(r, "list_id");
    if (has(r.fields, "title")) c["title"] = field_val(r, "title");
    // desc: fieldVal ?? ''
    { json d = field_val(r, "desc"); c["desc"] = d.is_null() ? json("") : d; }
    if (has(r.fields, "pos")) c["pos"] = field_val(r, "pos");
    // due: fieldVal ?? null
    { json d = field_val(r, "due"); c["due"] = d.is_null() ? json(nullptr) : d; }

    json assignees = json::array();
    auto it = regs.by_card.find(id);
    if (it != regs.by_card.end()) {
      for (const auto& reg : it->second) {
        if (reg.present) assignees.push_back(reg.actor);
      }
    }
    c["assignees"] = assignees;
    view["cards"].push_back(c);
  }

  view["comments"] = json::array();
  for (const auto& id : comment_order) {
    const Record& r = comment_state[id];
    if (r.deleted) continue;
    json m;
    m["id"] = id;
    if (has(r.fields, "card_id")) m["card_id"] = field_val(r, "card_id");
    if (has(r.fields, "text")) m["text"] = field_val(r, "text");
    view["comments"].push_back(m);
  }

  auto pos_of = [](const json& o) -> int64_t {
    auto it = o.find("pos");
    if (it == o.end() || !it->is_number_integer()) return 0;  // (a.pos ?? 0)
    return it->get<int64_t>();
  };
  auto by_pos = [&](const json& a, const json& b) {
    const int64_t pa = pos_of(a), pb = pos_of(b);
    if (pa != pb) return pa < pb;
    return a.at("id").get<std::string>() < b.at("id").get<std::string>();
  };
  std::sort(view["lists"].begin(), view["lists"].end(), by_pos);
  std::sort(view["cards"].begin(), view["cards"].end(), by_pos);
  std::sort(view["comments"].begin(), view["comments"].end(), [](const json& a, const json& b) {
    return a.at("id").get<std::string>() < b.at("id").get<std::string>();
  });

  // _assignRegisters: only for cards the fold knows (tombstones count).
  json reg_view = json::object();
  for (const auto& card_id : regs.card_order) {
    if (card_state.find(card_id) == card_state.end()) continue;
    json actors = json::object();
    for (const auto& reg : regs.by_card[card_id]) actors[reg.actor] = reg.present;
    reg_view[card_id] = actors;
  }
  view["_assignRegisters"] = reg_view;
  view["_allIds"] = json{{"lists", list_order}, {"cards", card_order}, {"comments", comment_order}};
  return view;
}

json check_invariants(const json& state) {
  std::unordered_set<std::string> list_ids, card_ids;
  if (state.contains("_allIds")) {
    const json& all = state.at("_allIds");
    if (all.contains("lists")) for (const auto& x : all.at("lists")) list_ids.insert(x.get<std::string>());
    if (all.contains("cards")) for (const auto& x : all.at("cards")) card_ids.insert(x.get<std::string>());
  }
  json problems = json::array();
  if (state.contains("cards")) {
    for (const auto& c : state.at("cards")) {
      const bool ok = c.contains("list_id") && c.at("list_id").is_string() &&
                      list_ids.count(c.at("list_id").get<std::string>()) > 0;
      if (!ok) {
        std::string ref = c.contains("list_id") && c.at("list_id").is_string()
                              ? c.at("list_id").get<std::string>()
                              : "undefined";
        problems.push_back(json{{"kind", "referential"},
                                {"what", "card " + c.at("id").get<std::string>() +
                                             " references unknown list " + ref}});
      }
    }
  }
  if (state.contains("comments")) {
    for (const auto& m : state.at("comments")) {
      const bool ok = m.contains("card_id") && m.at("card_id").is_string() &&
                      card_ids.count(m.at("card_id").get<std::string>()) > 0;
      if (!ok) {
        problems.push_back(json{{"kind", "referential"},
                                {"what", "comment " + m.at("id").get<std::string>() +
                                             " references unknown card"}});
      }
    }
  }
  if (state.contains("_assignRegisters")) {
    for (auto it = state.at("_assignRegisters").begin(); it != state.at("_assignRegisters").end(); ++it) {
      if (card_ids.count(it.key()) == 0) {
        problems.push_back(json{{"kind", "register-hygiene"},
                                {"what", "assign register for unknown card " + it.key()}});
      }
    }
  }
  return json{{"problems", problems}, {"ok", problems.empty()}};
}

}  // namespace board
