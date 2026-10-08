// BoardCoreImpl — see board_core_impl.h.
#include "board_core_impl.h"

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>

#include "nlohmann/json.hpp"

namespace {
// Stable 32-hex author id per module instance (the engine requires 32 hex chars).
// Derived, not random, so a restarted instance keeps writing as the same device.
std::string fnv64(const std::string& s) {
  uint64_t h = 1469598103934665603ULL;
  for (unsigned char c : s) {
    h ^= c;
    h *= 1099511628211ULL;
  }
  static const char* d = "0123456789abcdef";
  std::string out(16, '0');
  for (int i = 15; i >= 0; --i) {
    out[i] = d[h & 0xf];
    h >>= 4;
  }
  return out;
}
}  // namespace

BoardCoreImpl::BoardCoreImpl() = default;
BoardCoreImpl::~BoardCoreImpl() = default;

std::string BoardCoreImpl::devFromSeed(const std::string& seed) {
  return fnv64("board_core|" + seed) + fnv64("board_core#2|" + seed);
}

void BoardCoreImpl::onContextReady() {
  // No cross-module calls here: the 0.3 runtime rejects them before the module's
  // token is registered. Milestone 3 arms the transport with a QTimer instead.
  state_ = std::make_unique<board::BoardState>(devFromSeed(moduleName() + "/" + instanceId()));

  // instancePersistencePath() is empty when the module is driven without a host (unit
  // tests), so an absent path simply means "in memory only".
  const std::string dir = instancePersistencePath();
  if (!dir.empty()) {
    eventsPath_ = dir + "/board-events.json";
    viewPath_ = dir + "/view.json";
    loadFromDisk();
  }
}

// Persist-then-publish: the log hits the disk before the UI is told anything changed,
// so what the user sees is never ahead of what a restart would restore.
void BoardCoreImpl::loadFromDisk() {
  std::ifstream in(eventsPath_);
  if (!in.good()) return;  // first run
  std::string body((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  in.close();
  if (body.empty()) return;
  const std::string r = state_->ingestEvents(body);
  const auto j = nlohmann::json::parse(r, nullptr, false);
  if (j.is_discarded() || !j.value("ok", false)) {
    // A log we cannot read is left alone rather than overwritten: a corrupt file is
    // evidence, and the user's board should not be silently replaced by an empty one.
    std::cerr << "board_core: could not load " << eventsPath_ << ": " << r << std::endl;
  }
}

void BoardCoreImpl::saveToDisk() {
  if (eventsPath_.empty() || !state_) return;
  const std::string tmp = eventsPath_ + ".tmp";
  {
    std::ofstream out(tmp, std::ios::trunc);
    if (!out.good()) {
      std::cerr << "board_core: cannot write " << tmp << std::endl;
      return;
    }
    out << state_->eventsJson();
    out.flush();
  }
  std::error_code ec;
  std::filesystem::rename(tmp, eventsPath_, ec);
  if (ec) std::cerr << "board_core: cannot replace " << eventsPath_ << ": " << ec.message() << std::endl;
}

std::string BoardCoreImpl::guard() const {
  if (!state_) return R"({"ok":false,"error":"The board core is not ready yet."})";
  return std::string();
}

void BoardCoreImpl::pushState() {
  if (!state_) return;
  // Publish only on a real change. A refused action still calls pushState(), and
  // re-rendering the UI (and rewriting the log) with identical state is noise the
  // view does not need to handle. Comparing here keeps that rule in one place
  // instead of thirteen.
  const std::string snap = state_->snapshot();
  if (snap == lastPublished_) return;
  saveToDisk();  // persist BEFORE publishing
  lastPublished_ = snap;
  stateChanged(snap);
}

// Small local settings the view needs to survive a restart: which board it was looking
// at, and who "you" are. Deliberately NOT events - this is view state, not board data,
// so it must never reach the log, the fold, or a peer. Kept in one small JSON object
// beside the log, so a corrupt or missing file is a non-event rather than a failure.
std::string BoardCoreImpl::preference(const std::string& key) {
  const auto reply = [&](const std::string& v) {
    return nlohmann::json{{"ok", true}, {"value", v}}.dump();
  };
  if (viewPath_.empty() || key.empty()) return reply("");
  std::ifstream in(viewPath_);
  if (!in.good()) return reply("");  // first run
  std::string body((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  const auto j = nlohmann::json::parse(body, nullptr, false);
  if (j.is_discarded() || !j.is_object()) return reply("");
  const auto it = j.find(key);
  if (it == j.end() || !it->is_string()) return reply("");
  return reply(it->get<std::string>());
}

std::string BoardCoreImpl::setPreference(const std::string& key, const std::string& value) {
  const auto reply = nlohmann::json{{"ok", true}, {"value", value}}.dump();
  if (viewPath_.empty() || key.empty()) return reply;  // nothing to remember, not an error

  // read-modify-write: several keys share the file, so it must not be clobbered
  nlohmann::json prefs = nlohmann::json::object();
  {
    std::ifstream in(viewPath_);
    if (in.good()) {
      std::string body((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
      const auto j = nlohmann::json::parse(body, nullptr, false);
      if (j.is_object()) prefs = j;
    }
  }
  prefs[key] = value;

  const std::string tmp = viewPath_ + ".tmp";
  {
    std::ofstream out(tmp, std::ios::trunc);
    if (!out.good()) return nlohmann::json{{"ok", false}, {"error", "Could not remember that."}}.dump();
    out << prefs.dump();
    out.flush();
  }
  std::error_code ec;
  std::filesystem::rename(tmp, viewPath_, ec);
  if (ec) return nlohmann::json{{"ok", false}, {"error", "Could not remember that."}}.dump();
  return reply;
}

std::string BoardCoreImpl::snapshot() {
  const std::string g = guard();
  if (!g.empty()) return g;
  return state_->snapshot();
}

std::string BoardCoreImpl::resync() {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string s = state_->snapshot();
  stateChanged(s);
  return s;
}

std::string BoardCoreImpl::version() {
  return nlohmann::json{{"ok", true}, {"version", "0.1.0"}, {"contract", "board v1"}}.dump();
}

std::string BoardCoreImpl::createBoard(const std::string& id, const std::string& title) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->createBoard(id, title);
  pushState();
  return r;
}

std::string BoardCoreImpl::renameBoard(const std::string& id, const std::string& title) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->renameBoard(id, title);
  pushState();
  return r;
}

std::string BoardCoreImpl::deleteBoard(const std::string& id) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->deleteBoard(id);
  pushState();
  return r;
}

std::string BoardCoreImpl::restoreBoard(const std::string& id) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->restoreBoard(id);
  pushState();
  return r;
}

std::string BoardCoreImpl::createList(const std::string& boardId, const std::string& id,
                                      const std::string& title) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->createList(boardId, id, title);
  pushState();
  return r;
}

std::string BoardCoreImpl::editList(const std::string& id, const std::string& fieldsJson) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->editList(id, fieldsJson);
  pushState();
  return r;
}

std::string BoardCoreImpl::deleteList(const std::string& id) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->deleteList(id);
  pushState();
  return r;
}

std::string BoardCoreImpl::createCard(const std::string& boardId, const std::string& id,
                                      const std::string& listId, const std::string& title) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->createCard(boardId, id, listId, title);
  pushState();
  return r;
}

std::string BoardCoreImpl::editCard(const std::string& id, const std::string& fieldsJson) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->editCard(id, fieldsJson);
  pushState();
  return r;
}

std::string BoardCoreImpl::deleteCard(const std::string& id) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->deleteCard(id);
  pushState();
  return r;
}

std::string BoardCoreImpl::assign(const std::string& cardId, const std::string& actor,
                                  const std::string& present) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->assign(cardId, actor, present);
  pushState();
  return r;
}

std::string BoardCoreImpl::addComment(const std::string& id, const std::string& cardId,
                                      const std::string& text) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->addComment(id, cardId, text);
  pushState();
  return r;
}

std::string BoardCoreImpl::ingestEvents(const std::string& eventsJson) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->ingestEvents(eventsJson);
  pushState();
  return r;
}
