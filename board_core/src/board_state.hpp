// BoardState — the app logic, free of any Logos/Qt dependency so it is unit-testable
// on its own (the module wrapper delegates here; the engine fold does the work).
//
// Every action returns a JSON result string: {"ok":true,...} or
// {"ok":false,"error":"<a sentence the user can act on>"} — never throws across the
// IPC boundary, never returns int/bool (logos-basecamp-module, error handling).
#pragma once

#include <string>
#include <vector>

#include "events.hpp"
#include "hlc.hpp"
#include "nlohmann/json.hpp"

namespace board {

class BoardState {
 public:
  explicit BoardState(std::string dev);

  // Read surface: the dispatchable action the view polls (never a bare getter).
  std::string snapshot() const;

  // Mutations. Each returns the fresh state on success (the view renders from it
  // directly) or {"ok":false,"error":...}.
  // v2: boards are partitions. Creates name their board; everything else derives it
  // from the target record, which keeps every method at four arguments or fewer (the
  // module glue drops a method with more) and spares the view from passing board ids
  // and positions around.
  std::string createBoard(const std::string& id, const std::string& title);
  std::string renameBoard(const std::string& id, const std::string& title);
  std::string deleteBoard(const std::string& id);
  std::string restoreBoard(const std::string& id);
  std::string createList(const std::string& boardId, const std::string& id, const std::string& title);
  std::string editList(const std::string& id, const std::string& fieldsJson);
  std::string deleteList(const std::string& id);
  std::string createCard(const std::string& boardId, const std::string& id, const std::string& listId,
                         const std::string& title);
  std::string editCard(const std::string& id, const std::string& fieldsJson);
  std::string deleteCard(const std::string& id);
  std::string assign(const std::string& cardId, const std::string& actor, const std::string& present);
  std::string addComment(const std::string& id, const std::string& cardId, const std::string& text);

  // Merge events from a peer (the sync entry point; also what a hub serves).
  std::string ingestEvents(const std::string& eventsJson);

  const std::vector<Event>& log() const { return log_; }
  const std::string& dev() const { return dev_; }

  // The log as ingestEvents accepts it: what persistence writes and reads back.
  std::string eventsJson() const;
  std::size_t head() const { return log_.size(); }

 private:
  std::string append(const std::string& type, const json& payload);
  std::string okState() const;
  std::string fail(const std::string& message) const;
  bool cardExists(const std::string& id) const;
  bool listExists(const std::string& id) const;
  bool boardExists(const std::string& id) const;   // includes tombstones
  bool boardVisible(const std::string& id) const;  // live boards only
  std::string boardOfCard(const std::string& cardId) const;
  std::string boardOfList(const std::string& listId) const;
  int64_t nextListPos(const std::string& boardId) const;
  int64_t nextCardPos(const std::string& listId) const;

  std::string dev_;
  Clock clock_;
  std::vector<Event> log_;
};

// UUIDv4-shaped id (the event idempotency key).
std::string make_id();

}  // namespace board
