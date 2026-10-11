// Hub sync — pulling the shared board's events over HTTP.
//
// WHY THIS LIVES IN THE CORE AND NOT IN THE VIEW: Basecamp's plugin sandbox blocks the
// network for `ui_qml` modules — "sandboxed ui_qml modules may not use the network" — so
// the XMLHttpRequest the view used could never work on a device. The Duet proved it: the
// request was refused every 10 s and the board showed only local data. The fetch has to
// happen in a `core` module.
//
// The shape here is deliberately split so the parts that can be wrong are testable
// without a device or a hub:
//   * parseHubReply  — pure: a reply body + the current cursor -> what to ingest and what
//                      the cursor becomes. This is the logic that silently loses events
//                      when it is wrong (the cursor may only promise what is in OUR log,
//                      never the head the hub reports).
//   * httpGet        — a minimal HTTP/1.0 GET on POSIX sockets, no dependencies. Testable
//                      against a local server.
//   * HubFetcher     — a worker thread that fetches, and a drain the main thread calls, so
//                      no network call ever blocks the UI.
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace board {

// ---- the pure part --------------------------------------------------------

struct HubReply {
  bool ok = false;             // parsed, and has an events array with a numeric head
  bool hasNoSeq = false;       // events present but at least one carries no seq
  bool moved = false;          // the cursor advanced
  long head = 0;               // the hub's latest seq (its own claim, not ours)
  long cursor = 0;             // the cursor AFTER this reply
  int taken = 0;               // how many events this reply actually carried
  std::string eventsJson;      // the `events` array, as JSON text, for ingest
  std::string error;
};

// The cursor may only promise what is in OUR log: it is the seq of the LAST EVENT TAKEN,
// never the head. A reply may carry fewer events than it reports (a cap, a truncation, a
// hub mid-write), and trusting the head makes the gap unreachable forever. With no events
// the cursor does not move at all.
//
// `hasNoSeq` is separate because a hub sending events without `seq` would otherwise stall
// the sync SILENTLY — and a sync that silently stops advancing looks exactly like being
// caught up.
HubReply parseHubReply(long cursor, const std::string& body);

// ---- the transport --------------------------------------------------------

struct HttpResult {
  bool ok = false;
  int status = 0;
  std::string body;
  std::string error;
};

// A URL as far as this needs to understand one: http://host[:port]/path
struct HttpUrl {
  std::string host;
  int port = 80;
  std::string path = "/";
  std::string error;
};

HttpUrl parseHttpUrl(const std::string& url);

// One blocking HTTP/1.0 GET. `timeoutMs` bounds connect AND each read, so a hung hub
// cannot wedge the caller. HTTP/1.0 + Connection: close means the server closes after the
// body; chunked responses are de-chunked anyway, because a server may not honour that.
HttpResult httpGet(const std::string& url, int timeoutMs = 4000);

// ---- the worker -----------------------------------------------------------

// A thread that fetches, and a drain the main thread calls. Nothing here touches the
// board's state: the worker only fills a one-slot queue, and the main thread takes it.
// That is what keeps the network off the UI thread without any locking around the engine.
class HubFetcher {
 public:
  HubFetcher() = default;
  ~HubFetcher();
  HubFetcher(const HubFetcher&) = delete;
  HubFetcher& operator=(const HubFetcher&) = delete;

  // Restart with a new candidate list. Tried in order; the first that answers wins.
  void start(const std::vector<std::string>& urls, int intervalMs);
  void stop();
  bool running() const { return running_.load(); }

  struct Batch {
    bool ready = false;
    long cursor = 0;
    long head = 0;
    int taken = 0;
    std::string eventsJson;
    std::string error;
    std::string status;   // a short human string, mirroring what the view used to say
  };

  // Main thread. Non-blocking. Returns the pending batch once, then an empty one.
  Batch take();

  // Main thread, after a successful ingest: the cursor the NEXT request uses.
  void setCursor(long c) { cursor_.store(c); }
  long cursor() const { return cursor_.load(); }

  // Diagnostics for the UI.
  //
  // `sinceOutcomeMs` and `attempting` exist because the last OUTCOME is not enough to
  // describe the sync's health: an attempt that never finishes (a blackholed route also
  // blocks DNS, and getaddrinfo blocks) leaves the last good line on screen forever, and
  // an outage then looks exactly like being caught up. The Duet found this on the device:
  // it blackholed the hub for 48 s and the header never changed. So the fetcher says how
  // long it has been since it last heard anything, and whether an attempt is in flight.
  struct Stats {
    long cursor = 0;
    unsigned long fetches = 0;
    unsigned long errors = 0;
    std::string lastError;
    std::string status;
    std::string url;            // the candidate that last answered
    long sinceOutcomeMs = -1;   // -1 = no attempt has completed yet
    long attemptMs = 0;         // how long the IN-FLIGHT attempt has been running
    bool attempting = false;
    int intervalMs = 10000;
  };
  Stats stats() const;

 private:
  void loop();
  void publish(Batch b);

  std::thread thread_;
  std::atomic<bool> running_{false};
  std::atomic<long> cursor_{0};
  int intervalMs_ = 10000;
  std::vector<std::string> urls_;

  mutable std::mutex mu_;
  std::condition_variable cv_;
  Batch pending_;
  bool hasPending_ = false;
  bool attempting_ = false;
  bool haveOutcome_ = false;
  std::chrono::steady_clock::time_point lastOutcome_{};
  std::chrono::steady_clock::time_point attemptStart_{};
  Stats stats_;
};

}  // namespace board
