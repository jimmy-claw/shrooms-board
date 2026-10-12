// BoardCoreImpl — the Logos universal core module (logos-basecamp-module skill).
//
// All logic lives in the core; the QML view only calls these actions and renders the
// JSON they return. The same core runs standalone under the headless runtime as an
// always-on peer (milestone 3 wires the delivery transport).
//
// Contract rules this header must keep (the glue generator is literal):
//   - public methods are the dispatch API and return std::string (never int/bool)
//   - at most 4 arguments per method; structured data goes in as ONE JSON string
//   - no trailing // comments on a declaration line (the method would be dropped)
#pragma once

#include <memory>
#include <string>

#include <logos_module_context.h>

#include "board_state.hpp"
#include "hub_sync.hpp"

class BoardCoreImpl : public LogosModuleContext {
 public:
  BoardCoreImpl();
  ~BoardCoreImpl() override;

  std::string snapshot();

  // Orphans: task refs whose card no longer renders anywhere (docs/task-bridge.md s.5).
  std::string orphans();

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
  std::string ingestEvents(const std::string& eventsJson);

  std::string setPreference(const std::string& key, const std::string& value);
  std::string preference(const std::string& key);
  std::string resync();
  std::string version();

  // Hub sync. The fetch is HERE and not in the view because Basecamp's plugin sandbox
  // refuses the network for ui_qml modules - the Duet proved it ("sandboxed ui_qml modules
  // may not use the network", every 10 s), which is why the board showed only local data.
  // hubSyncStart takes a JSON array of base URLs and tries them in order, because the two
  // mesh names resolve on different devices. hubPoll is called by the view on a timer and
  // drains what the worker fetched, so no network call ever blocks the UI.
  std::string hubSyncStart(const std::string& urlsJson, const std::string& intervalMs);
  std::string hubSyncStop();
  std::string hubPoll();
  std::string hubStatus();

 logos_events:
  void stateChanged(const std::string& json);

 protected:
  void onContextReady() override;

 private:
  void pushState();
  std::string guard() const;
  std::string preferenceValue(const std::string& key);
  static std::string devFromSeed(const std::string& seed);

  // Persistence: the log IS the state, so saving it after every change is the whole
  // story. Writes go to a temp file and are renamed into place, so a crash mid-write
  // leaves the previous good log rather than a half-written one.
  void loadFromDisk();
  void saveToDisk();
  std::string eventsPath_;
  std::string viewPath_;
  std::string lastPublished_;  // so an unchanged state is not re-published

  std::unique_ptr<board::BoardState> state_;
  board::HubFetcher hub_;
};
