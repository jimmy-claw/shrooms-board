// BoardState tests — the action contract the view depends on:
// every action returns {"ok":true,...} or {"ok":false,"error":"..."}, refusals are
// up-front, ingest dedups by id and rejects malformed events, invariants hold.
#include <iostream>
#include <string>

#include "board_state.hpp"
#include "nlohmann/json.hpp"

using board::BoardState;
using json = nlohmann::json;

static int failures = 0;
static int checks = 0;

static void check(bool cond, const std::string& what) {
  ++checks;
  if (!cond) {
    ++failures;
    std::cout << "  FAIL " << what << "\n";
  }
}

static json parse(const std::string& s) {
  try {
    return json::parse(s);
  } catch (...) {
    return json{{"ok", false}, {"error", "unparseable"}};
  }
}

int main() {
  BoardState s("a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1");
  const std::string L1 = "11111111-1111-4111-8111-111111111111";
  const std::string C1 = "22222222-2222-4222-8222-222222222222";

  check(parse(s.createList(L1, "To Do", "1000")).at("ok").get<bool>(), "create list ok");
  check(!parse(s.createList(L1, "Again", "2000")).at("ok").get<bool>(), "duplicate list refused");
  check(!parse(s.createList("x", "", "1000")).at("ok").get<bool>(), "empty title refused");

  check(!parse(s.createCard(C1, "nope", "card", "1000")).at("ok").get<bool>(),
        "card into unknown list refused up front");
  check(parse(s.createCard(C1, L1, "first card", "1000")).at("ok").get<bool>(), "create card ok");
  check(!parse(s.editCard(C1, R"({"nonsense":1})")).at("ok").get<bool>(), "unknown field refused");
  check(!parse(s.editCard(C1, R"({"list_id":"missing"})")).at("ok").get<bool>(),
        "move to unknown list refused up front");
  check(parse(s.editCard(C1, R"({"title":"renamed","due":1760000000000})")).at("ok").get<bool>(),
        "edit ok");

  const json st = parse(s.snapshot());
  check(st.at("invariants").at("ok").get<bool>(), "invariants hold");
  check(st.at("cards").size() == 1, "one card");
  check(st.at("cards")[0].at("title").get<std::string>() == "renamed", "edit applied");

  check(parse(s.assign(C1, "jimmy", "true")).at("ok").get<bool>(), "assign ok");
  check(parse(s.snapshot()).at("cards")[0].at("assignees").size() == 1, "one assignee");
  check(parse(s.assign(C1, "jimmy", "false")).at("ok").get<bool>(), "unassign ok");
  check(parse(s.snapshot()).at("cards")[0].at("assignees").empty(), "assignee removed");

  check(!parse(s.assign("ghost", "jimmy", "true")).at("ok").get<bool>(), "assign to unknown card refused");
  check(!parse(s.addComment("c", C1, "")).at("ok").get<bool>(), "empty comment refused");

  // ingest: duplicate id is a no-op, malformed is rejected
  const std::string ev = R"([{"v":1,"id":"dup-00000001","type":"card.create","hlc":{"wall":9,"ctr":0,"dev":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"dev":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","payload":{"id":"33333333-3333-4333-8333-333333333333","list_id":"11111111-1111-4111-8111-111111111111","title":"from peer","pos":2000}}])";
  const json i1 = parse(s.ingestEvents(ev));
  check(i1.at("accepted").get<int>() == 1, "peer event accepted");
  const json i2 = parse(s.ingestEvents(ev));
  check(i2.at("duplicates").get<int>() == 1 && i2.at("accepted").get<int>() == 0, "resend is a no-op");
  const json i3 = parse(s.ingestEvents(R"([{"nope":true}])"));
  check(i3.at("rejected").get<int>() == 1, "malformed event rejected");
  check(parse(s.ingestEvents("not json")).at("ok").get<bool>() == false, "junk ingest refused");

  // tombstone: deleted card is gone and further edits are refused
  check(parse(s.deleteCard(C1)).at("ok").get<bool>(), "delete ok");
  check(!parse(s.editCard(C1, R"({"title":"late"})")).at("ok").get<bool>(), "edit of deleted card refused");
  check(parse(s.snapshot()).at("cards").size() == 1, "only the peer card remains");

  std::cout << "pass " << (checks - failures) << "/" << checks << " checks\n";
  return failures == 0 ? 0 : 1;
}
