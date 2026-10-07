// Cross-language parity test — logos-multiwriter-sync §Parity.
// Ingest each golden fixture's events, fold, serialize canonical JSON, and
// require byte-identical output to the fixture's expectedState (which was
// produced by the JS reference). The fold is the contract.
//
// Usage: test_parity [fixtures-dir]   (default: tests/golden)

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include "engine.hpp"
#include "events.hpp"
#include "nlohmann/json.hpp"

namespace fs = std::filesystem;
using board::Event;
using board::json;

int main(int argc, char** argv) {
  const std::string dir = argc > 1 ? argv[1] : "tests/golden";

  std::vector<fs::path> fixtures;
  if (!fs::is_directory(dir)) {
    std::cerr << "no fixtures dir: " << dir << "\n";
    return 2;
  }
  for (const auto& entry : fs::directory_iterator(dir)) {
    if (entry.path().extension() == ".json") fixtures.push_back(entry.path());
  }
  std::sort(fixtures.begin(), fixtures.end());

  int passed = 0;
  int failed = 0;
  for (const auto& path : fixtures) {
    std::ifstream in(path);
    json doc;
    try {
      doc = json::parse(in);
    } catch (const std::exception& ex) {
      std::cout << "FAIL " << path.filename() << " (parse: " << ex.what() << ")\n";
      ++failed;
      continue;
    }

    std::vector<Event> events;
    try {
      for (const auto& je : doc.at("events")) events.push_back(board::parse_event(je));
    } catch (const std::exception& ex) {
      std::cout << "FAIL " << path.filename() << " (ingest: " << ex.what() << ")\n";
      ++failed;
      continue;
    }

    const json state = board::fold_board(events);
    const std::string got = state.dump();            // canonical: sorted keys, no spaces
    const std::string want = doc.at("expectedState").dump();

    if (got == want) {
      std::cout << "PASS " << path.filename() << " (" << events.size() << " events)\n";
      ++passed;
    } else {
      std::cout << "FAIL " << path.filename() << "\n";
      // print the first divergence, so the author can see what broke
      size_t i = 0;
      while (i < got.size() && i < want.size() && got[i] == want[i]) ++i;
      std::cout << "  first divergence at byte " << i << "\n";
      std::cout << "  want: " << want.substr(i > 60 ? i - 60 : 0, 160) << "\n";
      std::cout << "  got:  " << got.substr(i > 60 ? i - 60 : 0, 160) << "\n";
      ++failed;
    }
  }

  std::cout << "pass " << passed << "/" << (passed + failed) << " fixtures\n";
  return failed == 0 ? 0 : 1;
}
