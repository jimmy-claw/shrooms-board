// BoardCoreImpl — see board_core_impl.h.
#include "board_core_impl.h"

#include <cstdint>

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
}

std::string BoardCoreImpl::guard() const {
  if (!state_) return R"({"ok":false,"error":"The board core is not ready yet."})";
  return std::string();
}

void BoardCoreImpl::pushState() {
  if (state_) stateChanged(state_->snapshot());
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

std::string BoardCoreImpl::renameBoard(const std::string& title) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->renameBoard(title);
  pushState();
  return r;
}

std::string BoardCoreImpl::createList(const std::string& id, const std::string& title,
                                      const std::string& pos) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->createList(id, title, pos);
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

std::string BoardCoreImpl::createCard(const std::string& id, const std::string& listId,
                                      const std::string& title, const std::string& pos) {
  const std::string g = guard();
  if (!g.empty()) return g;
  const std::string r = state_->createCard(id, listId, title, pos);
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
