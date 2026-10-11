// The hub sync: the cursor decision, the URL parser, and the HTTP client.
//
// The cursor cases mirror the ones the QML probe pinned, because they are the semantics:
// the cursor is the seq of the last event TAKEN, never the head the hub reports. Getting
// that wrong drops events permanently and silently.
//
// The HTTP client is tested against a stub server on loopback, so the transport is proven
// without a hub and without a device - including the two shapes that would otherwise look
// like "the hub is broken": a chunked body, and a connection refused.

#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cstring>
#include <string>
#include <thread>

#include "hub_sync.hpp"

static int failures = 0;
static int checks = 0;

static void expect(bool cond, const std::string& what) {
  checks++;
  if (!cond) {
    failures++;
    std::printf("FAIL: %s\n", what.c_str());
  }
}

static void expectEq(const std::string& got, const std::string& want, const std::string& what) {
  checks++;
  if (got != want) {
    failures++;
    std::printf("FAIL: %s\n  got  %s\n  want %s\n", what.c_str(), got.c_str(), want.c_str());
  }
}

// A one-shot HTTP server on loopback: serves `raw` to each accepted connection.
class StubServer {
 public:
  explicit StubServer(std::string raw) : raw_(std::move(raw)) {
    fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    ::setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = 0;
    ::bind(fd_, reinterpret_cast<sockaddr*>(&a), sizeof(a));
    socklen_t len = sizeof(a);
    ::getsockname(fd_, reinterpret_cast<sockaddr*>(&a), &len);
    port_ = ntohs(a.sin_port);
    ::listen(fd_, 4);
    thread_ = std::thread([this] {
      while (!stop_.load()) {
        struct timeval tv{0, 200000};
        ::setsockopt(fd_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        const int c = ::accept(fd_, nullptr, nullptr);
        if (c < 0) continue;
        char buf[4096];
        ::recv(c, buf, sizeof(buf), 0);  // the request; its content does not matter
        ::send(c, raw_.data(), raw_.size(), 0);
        ::close(c);
      }
    });
  }
  ~StubServer() {
    stop_.store(true);
    if (thread_.joinable()) thread_.join();
    ::close(fd_);
  }
  int port() const { return port_; }

 private:
  int fd_ = -1;
  int port_ = 0;
  std::string raw_;
  std::atomic<bool> stop_{false};
  std::thread thread_;
};

static std::string ok200(const std::string& body) {
  return "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
         std::to_string(body.size()) + "\r\n\r\n" + body;
}

int main() {
  using board::parseHubReply;
  using board::parseHttpUrl;

  // ---- the cursor decision, the probe's cases verbatim ---------------------
  {
    auto r = parseHubReply(0, R"({"head":5,"events":[{"seq":1},{"seq":2},{"seq":3}]})");
    expect(r.ok, "a well-formed reply parses");
    expectEq(std::to_string(r.cursor), "3", "the cursor is the last event TAKEN, not the head 5");
    expectEq(std::to_string(r.taken), "3", "three events taken");
    expect(r.moved, "the cursor moved");
    expect(!r.hasNoSeq, "events with seq are placeable");
  }
  {
    auto r = parseHubReply(7, R"({"head":9,"events":[]})");
    expectEq(std::to_string(r.cursor), "7", "no events: the cursor does not move");
    expect(!r.moved, "no events: nothing moved");
  }
  {
    auto r = parseHubReply(7, R"({"head":9,"events":[{"seq":8},{"seq":9}]})");
    expectEq(std::to_string(r.cursor), "9", "the cursor reaches the last event");
  }
  {
    auto r = parseHubReply(3, R"({"head":9,"events":[{"seq":2}]})");
    expectEq(std::to_string(r.cursor), "3", "the cursor never goes back");
  }
  {
    auto r = parseHubReply(0, R"({"head":5,"events":[{"event":{"id":"e1"}}]})");
    expect(r.ok, "a wrapper without seq still parses");
    expect(r.hasNoSeq, "events with no seq are reported, not silently ignored");
    expectEq(std::to_string(r.cursor), "0", "and the cursor does not move");
  }
  {
    auto r = parseHubReply(0, R"({"head":5,"events":[{"seq":1}]})");
    expect(!r.hasNoSeq, "one placeable event is enough to be placeable");
  }
  // The INNER event is what gets ingested - the wrapper's seq is only for the cursor.
  {
    auto r = parseHubReply(0, R"({"head":1,"events":[{"seq":1,"event":{"id":"e1","type":"card.create"}}]})");
    expectEq(r.eventsJson, R"([{"id":"e1","type":"card.create"}])", "ingest the inner event, not the wrapper");
  }
  // Validation: a reply we cannot use must not be treated as empty-and-fine.
  {
    expect(!parseHubReply(0, "not json").ok, "garbage is not a reply");
    expect(!parseHubReply(0, R"({"head":5})").ok, "no events array is not a reply");
    expect(!parseHubReply(0, R"({"events":[]})").ok, "no head is not a reply");
    expect(!parseHubReply(0, R"({"head":"5","events":[]})").ok, "a string head is not a numeric head");
  }

  // ---- the URL parser ------------------------------------------------------
  {
    auto u = parseHttpUrl("http://pi5.default.mesh:8407/events?since=0");
    expectEq(u.host, "pi5.default.mesh", "host");
    expectEq(std::to_string(u.port), "8407", "port");
    expectEq(u.path, "/events?since=0", "path keeps the query");
    expect(u.error.empty(), "a plain URL parses");
  }
  {
    auto u = parseHttpUrl("http://[fdb0:9afc::1]:8407/x");
    expectEq(u.host, "fdb0:9afc::1", "an IPv6 literal keeps its colons");
    expectEq(std::to_string(u.port), "8407", "IPv6 port");
  }
  {
    auto u = parseHttpUrl("http://host/");
    expectEq(std::to_string(u.port), "80", "the default port");
  }
  {
    expect(!parseHttpUrl("https://x/").error.empty(), "https is refused, not silently downgraded");
    expect(!parseHttpUrl("http://").error.empty(), "a URL with no host is refused");
  }

  // ---- the HTTP client, against a stub ------------------------------------
  {
    StubServer s(ok200(R"({"head":3,"events":[{"seq":3,"event":{"id":"e3"}}]})"));
    auto h = board::httpGet("http://127.0.0.1:" + std::to_string(s.port()) + "/events?since=0");
    expect(h.ok, "a 200 is ok");
    expectEq(std::to_string(h.status), "200", "status 200");
    auto r = parseHubReply(0, h.body);
    expect(r.ok, "the body of a real response parses");
    expectEq(std::to_string(r.cursor), "3", "and the cursor is right");
  }
  {
    // Chunked: not what HTTP/1.0 asks for, but a server may send it, and a chunk-framed
    // body parses as garbage - which looks like the hub being broken.
    const std::string body = R"({"head":2,"events":[]})";
    std::string raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
    raw += "0008\r\n" + body.substr(0, 8) + "\r\n";
    char lenbuf[16];
    std::snprintf(lenbuf, sizeof(lenbuf), "%04zx", body.size() - 8);
    raw += std::string(lenbuf) + "\r\n" + body.substr(8) + "\r\n0\r\n\r\n";
    StubServer s(raw);
    auto h = board::httpGet("http://127.0.0.1:" + std::to_string(s.port()) + "/x");
    expect(h.ok, "chunked 200 is ok");
    auto r = parseHubReply(0, h.body);
    expect(r.ok, "a de-chunked body parses");
    expectEq(std::to_string(r.head), "2", "and the head survives de-chunking");
  }
  {
    // Nothing listening: a clear error, not a hang and not an empty 200.
    auto h = board::httpGet("http://127.0.0.1:1/x", 800);
    expect(!h.ok, "a refused connection is not ok");
    expect(!h.error.empty(), "and it says why");
  }
  {
    // A host that cannot resolve must not be reported as an empty board.
    auto h = board::httpGet("http://no-such-host.invalid:8407/x", 1500);
    expect(!h.ok, "an unresolvable host is not ok");
    expect(!h.error.empty(), "and it says why");
  }

  std::printf("%s (%d checks)\n", failures == 0 ? "hub sync: all good" : "hub sync: FAILURES", checks);
  return failures == 0 ? 0 : 1;
}
