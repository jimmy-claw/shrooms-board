// BoardState — app logic over the engine. See board_state.hpp.
#include "board_state.hpp"

#include "engine.hpp"

#include <algorithm>
#include <random>
#include <stdexcept>

namespace board {

namespace {
std::string to_hex(uint64_t v, int digits) {
  static const char* d = "0123456789abcdef";
  std::string out(digits, '0');
  for (int i = digits - 1; i >= 0; --i) {
    out[i] = d[v & 0xf];
    v >>= 4;
  }
  return out;
}
}  // namespace

std::string make_id() {
  static std::mt19937_64 rng{std::random_device{}()};
  const uint64_t a = rng(), b = rng();
  // 8-4-4-4-12 with the v4 / variant nibbles set, so it looks like a UUIDv4
  return to_hex(a >> 32, 8) + "-" + to_hex((a >> 16) & 0xffff, 4) + "-4" + to_hex(a & 0xfff, 3) + "-" +
         ((b >> 60) & 0x3 ? "8" : "8") + to_hex((b >> 48) & 0xfff, 3) + "-" + to_hex(b & 0xffffffffffffULL, 12);
}

BoardState::BoardState(std::string dev) : dev_(std::move(dev)), clock_(dev_) {
  if (!valid_dev(dev_)) throw std::invalid_argument("BoardState: dev must be 32 hex chars");
}

std::string BoardState::append(const std::string& type, const json& payload) {
  Event e;
  e.v = 1;
  e.id = make_id();
  e.type = type;
  e.hlc = clock_.send();
  e.dev = dev_;
  e.payload = payload;
  log_.push_back(e);
  return e.id;
}

std::string BoardState::okState() const {
  const json state = fold_board(log_);
  const json inv = check_invariants(state);
  json out = state;
  out["ok"] = true;
  out["head"] = log_.size();
  out["invariants"] = inv;
  return out.dump();
}

std::string BoardState::fail(const std::string& message) const {
  return json{{"ok", false}, {"error", message}}.dump();
}

bool BoardState::listExists(const std::string& id) const {
  const json state = fold_board(log_);
  for (const auto& l : state.at("lists")) {
    if (l.at("id").get<std::string>() == id) return true;
  }
  return false;
}

bool BoardState::cardExists(const std::string& id) const {
  const json state = fold_board(log_);
  for (const auto& c : state.at("cards")) {
    if (c.at("id").get<std::string>() == id) return true;
  }
  return false;
}

std::string BoardState::snapshot() const { return okState(); }

std::string BoardState::eventsJson() const {
  json arr = json::array();
  for (const auto& e : log_) arr.push_back(event_to_json(e));
  return arr.dump();
}

// A board that EXISTS is not the same as a board that is VISIBLE: a deleted board is
// still in the fold's id set (a tombstone), and that is what restore/rename need. Using
// the visible list here made restoreBoard refuse to restore the very board just deleted.
bool BoardState::boardExists(const std::string& id) const {
  if (id == "default") return true;  // v1 data needs no board record
  const json state = fold_board(log_);
  const json& ids = state.at("_allIds").at("boards");
  for (const auto& b : ids) {
    if (b.get<std::string>() == id) return true;
  }
  return false;
}

bool BoardState::boardVisible(const std::string& id) const {
  if (id == "default") return true;
  const json state = fold_board(log_);
  for (const auto& b : state.at("boards")) {
    if (b.at("id").get<std::string>() == id) return true;
  }
  return false;
}

// Which board a record belongs to (v1 records with no board_id are the default board).
std::string BoardState::boardOfCard(const std::string& cardId) const {
  const json state = fold_board(log_);
  for (const auto& c : state.at("cards")) {
    if (c.at("id").get<std::string>() == cardId && c.contains("board_id")) {
      return c.at("board_id").get<std::string>();
    }
  }
  return "default";
}

std::string BoardState::boardOfList(const std::string& listId) const {
  const json state = fold_board(log_);
  for (const auto& l : state.at("lists")) {
    if (l.at("id").get<std::string>() == listId && l.contains("board_id")) {
      return l.at("board_id").get<std::string>();
    }
  }
  return "default";
}

// Positions are the core's business: the view should not compute them, and a
// create must stay within four arguments for the module glue.
int64_t BoardState::nextListPos(const std::string& boardId) const {
  const json state = fold_board(log_);
  int64_t maxp = 0;
  for (const auto& l : state.at("lists")) {
    if (l.value("board_id", std::string("default")) == boardId) {
      maxp = std::max(maxp, l.value("pos", (int64_t)0));
    }
  }
  return maxp + 1000;
}

int64_t BoardState::nextCardPos(const std::string& listId) const {
  const json state = fold_board(log_);
  int64_t maxp = 0;
  for (const auto& c : state.at("cards")) {
    if (c.value("list_id", std::string()) == listId) {
      maxp = std::max(maxp, c.value("pos", (int64_t)0));
    }
  }
  return maxp + 1000;
}

// --- boards ---------------------------------------------------------------
std::string BoardState::createBoard(const std::string& id, const std::string& title) {
  if (id.empty()) return fail("Missing board id.");
  if (title.empty()) return fail("A board needs a name.");
  if (boardVisible(id)) return fail("That board already exists.");
  int64_t maxp = 0;
  {
    const json state = fold_board(log_);
    for (const auto& b : state.at("boards")) maxp = std::max(maxp, b.value("pos", (int64_t)0));
  }
  append("board.create", json{{"id", id}, {"title", title}, {"pos", maxp + 1000}});
  return okState();
}

std::string BoardState::deleteBoard(const std::string& id) {
  if (!boardVisible(id)) return fail("That board is already gone.");
  append("board.delete", json{{"id", id}});
  return okState();
}

std::string BoardState::restoreBoard(const std::string& id) {
  if (!boardExists(id)) return fail("That board does not exist.");
  append("board.restore", json{{"id", id}});
  return okState();
}

std::string BoardState::renameBoard(const std::string& id, const std::string& title) {
  if (title.empty()) return fail("A board needs a name.");
  if (!boardExists(id)) return fail("That board does not exist.");
  append("board.rename", json{{"id", id}, {"fields", json{{"title", title}}}});
  return okState();
}

std::string BoardState::createList(const std::string& boardId, const std::string& id,
                                   const std::string& title) {
  if (id.empty()) return fail("Missing list id.");
  if (title.empty()) return fail("A list needs a name.");
  if (!boardExists(boardId)) return fail("That board does not exist.");
  if (listExists(id)) return fail("That list already exists.");
  append("list.create", json{{"board_id", boardId}, {"id", id}, {"title", title},
                             {"pos", nextListPos(boardId)}});
  return okState();
}

std::string BoardState::editList(const std::string& id, const std::string& fieldsJson) {
  if (!listExists(id)) return fail("That list is gone; refresh and try again.");
  json fields;
  try {
    fields = json::parse(fieldsJson);
  } catch (...) {
    return fail("Could not read the change; refresh and try again.");
  }
  if (!fields.is_object() || fields.empty()) return fail("Nothing to change.");
  for (auto it = fields.begin(); it != fields.end(); ++it) {
    if (std::find(kListFields.begin(), kListFields.end(), it.key()) == kListFields.end()) {
      return fail("Unknown list field: " + it.key());
    }
  }
  append("list.edit", json{{"board_id", boardOfList(id)}, {"id", id}, {"fields", fields}});
  return okState();
}

std::string BoardState::deleteList(const std::string& id) {
  if (!listExists(id)) return fail("That list is already gone.");
  append("list.delete", json{{"board_id", boardOfList(id)}, {"id", id}});
  return okState();
}

std::string BoardState::createCard(const std::string& boardId, const std::string& id,
                                   const std::string& listId, const std::string& title) {
  if (id.empty()) return fail("Missing card id.");
  if (title.empty()) return fail("A card needs a title.");
  if (!listExists(listId)) return fail("That list is gone; refresh and try again.");
  if (cardExists(id)) return fail("That card already exists.");
  append("card.create", json{{"board_id", boardId}, {"id", id}, {"list_id", listId},
                             {"title", title}, {"pos", nextCardPos(listId)}});
  return okState();
}

std::string BoardState::editCard(const std::string& id, const std::string& fieldsJson) {
  if (!cardExists(id)) return fail("That card is gone; refresh and try again.");
  json fields;
  try {
    fields = json::parse(fieldsJson);
  } catch (...) {
    return fail("Could not read the change; refresh and try again.");
  }
  if (!fields.is_object() || fields.empty()) return fail("Nothing to change.");
  for (auto it = fields.begin(); it != fields.end(); ++it) {
    if (std::find(kCardFields.begin(), kCardFields.end(), it.key()) == kCardFields.end()) {
      return fail("Unknown card field: " + it.key());
    }
  }
  // Refuse up front instead of folding the write away (error handling rule).
  if (fields.contains("list_id")) {
    const std::string target = fields.at("list_id").is_string() ? fields.at("list_id").get<std::string>() : "";
    if (!listExists(target)) return fail("Cannot move the card: that list is gone.");
  }
  append("card.edit", json{{"board_id", boardOfCard(id)}, {"id", id}, {"fields", fields}});
  return okState();
}

std::string BoardState::deleteCard(const std::string& id) {
  if (!cardExists(id)) return fail("That card is already gone.");
  append("card.delete", json{{"board_id", boardOfCard(id)}, {"id", id}});
  return okState();
}

std::string BoardState::assign(const std::string& cardId, const std::string& actor,
                               const std::string& present) {
  if (!cardExists(cardId)) return fail("That card is gone; refresh and try again.");
  if (actor.empty()) return fail("Set your name first (top right).");
  const bool on = (present == "true" || present == "1");
  append("card.assign", json{{"board_id", boardOfCard(cardId)}, {"id", cardId}, {"actor", actor}, {"present", on}});
  return okState();
}

std::string BoardState::addComment(const std::string& id, const std::string& cardId,
                                   const std::string& text) {
  if (!cardExists(cardId)) return fail("That card is gone; refresh and try again.");
  if (text.empty()) return fail("A comment needs some text.");
  append("comment.create", json{{"board_id", boardOfCard(cardId)}, {"id", id}, {"card_id", cardId}, {"text", text}});
  return okState();
}

std::string BoardState::ingestEvents(const std::string& eventsJson) {
  json incoming;
  try {
    incoming = json::parse(eventsJson);
  } catch (...) {
    return fail("Could not read the incoming events.");
  }
  if (!incoming.is_array()) return fail("Expected a JSON array of events.");
  size_t accepted = 0, duplicates = 0, rejected = 0;
  for (const auto& je : incoming) {
    const auto problems = validate_event(je);
    if (!problems.empty()) {
      ++rejected;
      continue;
    }
    Event e = parse_event(je);
    bool known = false;
    for (const auto& k : log_) {
      if (k.id == e.id) {
        known = true;
        break;
      }
    }
    if (known) {
      ++duplicates;
      continue;
    }
    log_.push_back(e);
    clock_.receive(e.hlc);
    ++accepted;
  }
  json out = json::parse(okState());
  out["accepted"] = accepted;
  out["duplicates"] = duplicates;
  out["rejected"] = rejected;
  return out.dump();
}

}  // namespace board
