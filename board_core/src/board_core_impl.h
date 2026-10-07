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

class BoardCoreImpl : public LogosModuleContext {
 public:
  BoardCoreImpl();
  ~BoardCoreImpl() override;

  std::string snapshot();

  std::string renameBoard(const std::string& title);
  std::string createList(const std::string& id, const std::string& title, const std::string& pos);
  std::string editList(const std::string& id, const std::string& fieldsJson);
  std::string deleteList(const std::string& id);
  std::string createCard(const std::string& id, const std::string& listId, const std::string& title,
                         const std::string& pos);
  std::string editCard(const std::string& id, const std::string& fieldsJson);
  std::string deleteCard(const std::string& id);
  std::string assign(const std::string& cardId, const std::string& actor, const std::string& present);
  std::string addComment(const std::string& id, const std::string& cardId, const std::string& text);
  std::string ingestEvents(const std::string& eventsJson);
  std::string resync();
  std::string version();

 logos_events:
  void stateChanged(const std::string& json);

 protected:
  void onContextReady() override;

 private:
  void pushState();
  std::string guard() const;
  static std::string devFromSeed(const std::string& seed);

  std::unique_ptr<board::BoardState> state_;
};
