// Persistence test: the log must survive a restart, and the module must publish only
// what it has already written down.
//
// The generated glue defines stateChanged(); here it is defined to RECORD, so the test
// can assert the order of "wrote the log" vs "told the UI".
#include "board_core_impl.h"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include "nlohmann/json.hpp"

static std::vector<std::string> g_emitted;
static std::vector<bool> g_file_existed_at_emit;
static std::string g_path;

void BoardCoreImpl::stateChanged(const std::string& json) {
  g_emitted.push_back(json);
  g_file_existed_at_emit.push_back(std::filesystem::exists(g_path));
}

static int checks = 0, failures = 0;
static void check(bool ok, const std::string& what) {
  ++checks;
  if (!ok) { ++failures; std::cout << "    FAIL " << what << "\n"; }
}

static std::string read_file(const std::string& p) {
  std::ifstream in(p);
  return std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

// A fresh instance over a given directory, as the host would create it.
static std::unique_ptr<BoardCoreImpl> boot(const std::string& dir, const std::string& instance) {
  auto impl = std::make_unique<BoardCoreImpl>();
  impl->_logosCoreSetModuleName_("board_core");
  impl->_logosCoreSetContext_("/tmp/board_core", instance, dir);
  return impl;
}

int main() {
  namespace fs = std::filesystem;
  const fs::path root = fs::temp_directory_path() / "board-core-persist-test";
  fs::remove_all(root);
  fs::create_directories(root / "one");
  g_path = (root / "one" / "board-events.json").string();

  const std::string L1 = "11111111-1111-4111-8111-111111111111";
  const std::string C1 = "22222222-2222-4222-8222-222222222222";

  {  // ---- first run: make some state -------------------------------------
    auto impl = boot((root / "one").string(), "one");
    check(nlohmann::json::parse(impl->snapshot()).at("boards").empty(), "starts empty");
    check(nlohmann::json::parse(impl->createBoard("b1", "One")).at("ok").get<bool>(), "create board");
    check(nlohmann::json::parse(impl->createList("b1", L1, "To Do")).at("ok").get<bool>(), "create list");
    check(nlohmann::json::parse(impl->createCard("b1", C1, L1, "a card")).at("ok").get<bool>(), "create card");
    check(fs::exists(g_path), "the log was written to disk");
    check(g_emitted.size() == 3, "one publish per change (3 changes so far)");
    const std::size_t published = g_emitted.size();
    check(!nlohmann::json::parse(impl->createBoard("b1", "One")).at("ok").get<bool>(),
          "a duplicate board is refused");
    check(g_emitted.size() == published, "and a refused action publishes nothing");
    // persist-then-publish: the file was already there when each publish happened
    bool always_after = true;
    for (bool existed : g_file_existed_at_emit) always_after = always_after && existed;
    check(always_after, "every publish happened AFTER the log was on disk");
  }

  {  // ---- restart: the state must come back ------------------------------
    auto impl = boot((root / "one").string(), "one");
    const auto s = nlohmann::json::parse(impl->snapshot());
    check(s.at("boards").size() == 1, "board survived the restart");
    check(s.at("boards")[0].at("title").get<std::string>() == "One", "its title too");
    check(s.at("lists").size() == 1, "list survived");
    check(s.at("cards").size() == 1, "card survived");
    check(s.at("cards")[0].at("title").get<std::string>() == "a card", "card content too");
    // and the restored state is writable, not just readable
    check(nlohmann::json::parse(impl->createCard("b1", "33333333-3333-4333-8333-333333333333",
                                                 L1, "second"))
              .at("ok").get<bool>(),
          "can still write after a restore");
  }

  {  // ---- restart again: the appended change is there too -----------------
    auto impl = boot((root / "one").string(), "one");
    check(nlohmann::json::parse(impl->snapshot()).at("cards").size() == 2, "second card persisted");
  }

  {  // ---- the last-viewed board is remembered, and is NOT an event --------
    auto impl = boot((root / "one").string(), "one");
    check(nlohmann::json::parse(impl->lastBoard()).at("board").get<std::string>() == "",
          "no remembered board on a fresh instance");
    check(nlohmann::json::parse(impl->setLastBoard("b1")).at("ok").get<bool>(), "remember a board");
    const std::string events_before = read_file(g_path);
    check(nlohmann::json::parse(impl->lastBoard()).at("board").get<std::string>() == "b1",
          "and it comes back");
    check(read_file(g_path) == events_before,
          "remembering it did NOT touch the log (it is view state, not an event)");
    check(fs::exists((root / "one" / "view.json").string()), "it is kept beside the log");
  }
  {
    auto impl = boot((root / "one").string(), "one");  // a fresh process
    check(nlohmann::json::parse(impl->lastBoard()).at("board").get<std::string>() == "b1",
          "and survives a restart");
    check(nlohmann::json::parse(impl->snapshot()).at("boards").size() == 1,
          "while the board itself is unaffected");
  }
  {
    fs::create_directories(root / "corrupt-view");
    { std::ofstream out(root / "corrupt-view" / "view.json"); out << "not json"; }
    auto impl = boot((root / "corrupt-view").string(), "corrupt-view");
    check(nlohmann::json::parse(impl->lastBoard()).at("ok").get<bool>(),
          "a corrupt preference is not fatal - the view still loads");
  }

  {  // ---- a different instance is a different board -----------------------
    fs::create_directories(root / "two");
    auto impl = boot((root / "two").string(), "two");
    check(nlohmann::json::parse(impl->snapshot()).at("boards").empty(),
          "another instance does not see the first board");
  }

  {  // ---- no persistence path (no host) is not a crash --------------------
    auto impl = std::make_unique<BoardCoreImpl>();
    impl->_logosCoreSetModuleName_("board_core");
    impl->_logosCoreSetContext_("/tmp/board_core", "nohost", "");
    check(nlohmann::json::parse(impl->createBoard("b1", "One")).at("ok").get<bool>(),
          "works in memory with no persistence path");
    check(nlohmann::json::parse(impl->snapshot()).at("boards").size() == 1, "state is there anyway");
  }

  {  // ---- NEGATIVE CONTROL: a corrupt log is left alone, not wiped --------
    fs::create_directories(root / "bad");
    const std::string bad = (root / "bad" / "board-events.json").string();
    { std::ofstream out(bad); out << "{ this is not a log"; }
    auto impl = boot((root / "bad").string(), "bad");
    check(read_file(bad) == "{ this is not a log", "a corrupt log is not overwritten on load");
    // and writing afterwards must not destroy it either, until a real change happens
    check(nlohmann::json::parse(impl->createBoard("b1", "One")).at("ok").get<bool>(),
          "can still create a board over a corrupt log");
    check(read_file(bad).find("board.create") != std::string::npos, "the new log is valid now");
  }

  std::cout << "pass " << (checks - failures) << "/" << checks << " checks\n";
  fs::remove_all(root);
  return failures == 0 ? 0 : 1;
}
