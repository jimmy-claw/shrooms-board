#include "hub_sync.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sstream>

#include <nlohmann/json.hpp>

namespace board {

// ---- the pure part --------------------------------------------------------

// The cursor may only promise what is in OUR log. Mirrors the view's nextCursor /
// replyHasNoSeq exactly, because those were pinned by tests and the semantics are the
// point: the max seq the reply actually carried, never the head it claims.
HubReply parseHubReply(long cursor, const std::string& body) {
  HubReply r;
  nlohmann::json d = nlohmann::json::parse(body, nullptr, false);
  if (d.is_discarded() || !d.is_object()) {
    r.error = "reply is not JSON";
    return r;
  }
  if (!d.contains("events") || !d["events"].is_array()) {
    r.error = "reply has no events array";
    return r;
  }
  if (!d.contains("head") || !d["head"].is_number_integer()) {
    r.error = "reply has no numeric head";
    return r;
  }
  const nlohmann::json& evs = d["events"];
  r.head = d["head"].get<long>();
  r.taken = static_cast<int>(evs.size());

  long last = cursor;
  bool anySeq = false;
  nlohmann::json inner = nlohmann::json::array();
  for (const auto& w : evs) {
    // The hub sends [{seq, event}]: the seq is for the cursor, the INNER event is what
    // gets ingested. A bare event is accepted too rather than dropped.
    if (w.is_object() && w.contains("event")) inner.push_back(w["event"]);
    else inner.push_back(w);
    if (w.is_object() && w.contains("seq") && w["seq"].is_number_integer()) {
      anySeq = true;
      long s = w["seq"].get<long>();
      if (s > last) last = s;
    }
  }
  // Only when there is something to place and nothing in it can be placed.
  r.hasNoSeq = (r.taken > 0 && !anySeq);
  r.cursor = last;
  r.moved = (last > cursor);
  r.eventsJson = inner.dump();
  r.ok = true;
  return r;
}

// ---- the transport --------------------------------------------------------

HttpUrl parseHttpUrl(const std::string& url) {
  HttpUrl u;
  std::string s = url;
  const std::string scheme = "http://";
  if (s.rfind(scheme, 0) != 0) {
    u.error = "only http:// is supported";
    return u;
  }
  s = s.substr(scheme.size());
  const size_t slash = s.find('/');
  std::string authority = (slash == std::string::npos) ? s : s.substr(0, slash);
  u.path = (slash == std::string::npos) ? "/" : s.substr(slash);
  if (authority.empty()) {
    u.error = "no host";
    return u;
  }
  // An IPv6 literal is bracketed: http://[fdb0::1]:8407/ - the brackets are the only way
  // to tell its colons from the port's.
  if (authority[0] == '[') {
    const size_t close = authority.find(']');
    if (close == std::string::npos) {
      u.error = "unterminated IPv6 literal";
      return u;
    }
    u.host = authority.substr(1, close - 1);
    const std::string rest = authority.substr(close + 1);
    if (!rest.empty()) {
      if (rest[0] != ':') {
        u.error = "bad authority";
        return u;
      }
      u.port = std::atoi(rest.c_str() + 1);
    }
  } else {
    const size_t colon = authority.rfind(':');
    if (colon == std::string::npos) {
      u.host = authority;
    } else {
      u.host = authority.substr(0, colon);
      u.port = std::atoi(authority.c_str() + colon + 1);
    }
  }
  if (u.host.empty()) u.error = "no host";
  else if (u.port <= 0 || u.port > 65535) u.error = "bad port";
  return u;
}

namespace {

// A chunked body is not what HTTP/1.0 asks for, but a server may send it anyway - and a
// body left chunk-framed parses as garbage JSON, which looks like "the hub is broken".
std::string dechunk(const std::string& b) {
  std::string out;
  size_t i = 0;
  while (i < b.size()) {
    const size_t eol = b.find("\r\n", i);
    if (eol == std::string::npos) break;
    std::string line = b.substr(i, eol - i);
    const size_t semi = line.find(';');
    if (semi != std::string::npos) line = line.substr(0, semi);
    long n = std::strtol(line.c_str(), nullptr, 16);
    if (n <= 0) break;
    const size_t start = eol + 2;
    if (start + static_cast<size_t>(n) > b.size()) { out.append(b, start, std::string::npos); break; }
    out.append(b, start, static_cast<size_t>(n));
    i = start + static_cast<size_t>(n) + 2;
  }
  return out;
}

std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

}  // namespace

HttpResult httpGet(const std::string& url, int timeoutMs) {
  HttpResult out;
  const HttpUrl u = parseHttpUrl(url);
  if (!u.error.empty()) {
    out.error = u.error;
    return out;
  }

  struct addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  struct addrinfo* res = nullptr;
  const std::string port = std::to_string(u.port);
  const int gai = ::getaddrinfo(u.host.c_str(), port.c_str(), &hints, &res);
  if (gai != 0 || !res) {
    out.error = std::string("resolve failed: ") + ::gai_strerror(gai);
    return out;
  }

  int fd = -1;
  for (struct addrinfo* a = res; a; a = a->ai_next) {
    fd = ::socket(a->ai_family, a->ai_socktype, a->ai_protocol);
    if (fd < 0) continue;
    // Non-blocking connect + poll, so a black-holed address cannot hang the worker.
    const int flags = ::fcntl(fd, F_GETFL, 0);
    ::fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    const int rc = ::connect(fd, a->ai_addr, a->ai_addrlen);
    if (rc == 0) break;
    if (errno == EINPROGRESS) {
      struct pollfd p{};
      p.fd = fd;
      p.events = POLLOUT;
      if (::poll(&p, 1, timeoutMs) == 1) {
        int err = 0;
        socklen_t len = sizeof(err);
        ::getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len);
        if (err == 0) break;
      }
    }
    ::close(fd);
    fd = -1;
  }
  ::freeaddrinfo(res);
  if (fd < 0) {
    out.error = "connect failed";
    return out;
  }
  ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) & ~O_NONBLOCK);

  // HTTP/1.0 + Connection: close: no keep-alive, no chunked needed, the server closes.
  std::ostringstream req;
  req << "GET " << u.path << " HTTP/1.0\r\n"
      << "Host: " << u.host << ":" << u.port << "\r\n"
      << "Accept: application/json\r\n"
      << "User-Agent: shrooms-board-core/1\r\n"
      << "Connection: close\r\n\r\n";
  const std::string r = req.str();
  size_t sent = 0;
  while (sent < r.size()) {
    struct pollfd p{};
    p.fd = fd;
    p.events = POLLOUT;
    if (::poll(&p, 1, timeoutMs) <= 0) { out.error = "send timeout"; ::close(fd); return out; }
    const ssize_t n = ::send(fd, r.data() + sent, r.size() - sent, MSG_NOSIGNAL);
    if (n <= 0) { out.error = "send failed"; ::close(fd); return out; }
    sent += static_cast<size_t>(n);
  }

  std::string raw;
  char buf[8192];
  for (;;) {
    struct pollfd p{};
    p.fd = fd;
    p.events = POLLIN;
    const int pr = ::poll(&p, 1, timeoutMs);
    if (pr == 0) { out.error = "read timeout"; break; }
    if (pr < 0) { out.error = "poll failed"; break; }
    const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
    if (n == 0) break;  // closed: the body is complete
    if (n < 0) { out.error = "read failed"; break; }
    raw.append(buf, static_cast<size_t>(n));
  }
  ::close(fd);

  const size_t sep = raw.find("\r\n\r\n");
  if (sep == std::string::npos) {
    if (out.error.empty()) out.error = "no header terminator in the reply";
    return out;
  }
  const std::string head = raw.substr(0, sep);
  std::string body = raw.substr(sep + 4);
  const size_t sp = head.find(' ');
  out.status = (sp == std::string::npos) ? 0 : std::atoi(head.c_str() + sp + 1);
  if (lower(head).find("transfer-encoding: chunked") != std::string::npos) body = dechunk(body);
  out.body = body;
  out.ok = (out.status == 200);
  if (!out.ok && out.error.empty()) out.error = "HTTP " + std::to_string(out.status);
  return out;
}

// ---- the worker -----------------------------------------------------------

HubFetcher::~HubFetcher() { stop(); }

void HubFetcher::start(const std::vector<std::string>& urls, int intervalMs) {
  stop();
  {
    std::lock_guard<std::mutex> lk(mu_);
    urls_ = urls;
    intervalMs_ = intervalMs > 200 ? intervalMs : 200;
    hasPending_ = false;
    pending_ = Batch();
    stats_ = Stats();
    stats_.cursor = cursor_.load();
  }
  running_.store(true);
  thread_ = std::thread(&HubFetcher::loop, this);
}

void HubFetcher::stop() {
  if (!running_.exchange(false)) {
    if (thread_.joinable()) thread_.join();
    return;
  }
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

HubFetcher::Batch HubFetcher::take() {
  std::lock_guard<std::mutex> lk(mu_);
  if (!hasPending_) return Batch();
  Batch b = pending_;
  b.ready = true;
  hasPending_ = false;
  pending_ = Batch();
  cv_.notify_all();
  return b;
}

HubFetcher::Stats HubFetcher::stats() const {
  std::lock_guard<std::mutex> lk(mu_);
  Stats s = stats_;
  s.cursor = cursor_.load();
  return s;
}

void HubFetcher::publish(Batch b) {
  std::lock_guard<std::mutex> lk(mu_);
  pending_ = b;
  hasPending_ = true;
}

void HubFetcher::loop() {
  std::vector<std::string> urls;
  int interval = 10000;
  {
    std::lock_guard<std::mutex> lk(mu_);
    urls = urls_;
    interval = intervalMs_;
  }
  while (running_.load()) {
    // Never fetch ahead of the drain: one outstanding batch is the whole contract, and it
    // is what makes "the cursor is what we have ingested" true without a lock on the log.
    {
      std::unique_lock<std::mutex> lk(mu_);
      cv_.wait_for(lk, std::chrono::milliseconds(50), [this] { return !hasPending_ || !running_.load(); });
      if (!running_.load()) break;
      if (hasPending_) continue;
    }

    long cursor = cursor_.load();
    bool done = false;
    std::string lastErr = "no hub";
    std::string used;
    for (const std::string& base : urls) {
      if (!running_.load()) return;
      const std::string url = base + "/events?since=" + std::to_string(cursor);
      const HttpResult h = httpGet(url);
      if (!h.ok) {
        lastErr = h.error.empty() ? ("HTTP " + std::to_string(h.status)) : h.error;
        continue;  // a reply we cannot use is a reason to try the NEXT candidate
      }
      const HubReply r = parseHubReply(cursor, h.body);
      if (!r.ok) {
        lastErr = "bad reply from " + base + ": " + r.error;
        continue;
      }
      // A cursor past the hub's head means this is not the log we were following - it was
      // reset, or this is a different hub. Re-fetch from zero rather than asking for events
      // past the end of it forever.
      if (r.head < cursor) {
        cursor_.store(0);
        lastErr = "cursor past the hub head; restarting from 0";
        done = true;  // let the next pass re-ask from 0
        break;
      }
      used = base;
      Batch b;
      b.cursor = r.cursor;
      b.head = r.head;
      b.taken = r.taken;
      b.eventsJson = r.eventsJson;
      if (r.hasNoSeq) {
        b.status = "reply carried no seq: cannot advance";
      } else if (r.taken == 0) {
        b.status = "hub " + std::to_string(r.head) + " (caught up)";
      } else {
        b.status = "hub " + std::to_string(r.head) + " (took " + std::to_string(r.taken) + ")";
      }
      {
        std::lock_guard<std::mutex> lk(mu_);
        stats_.fetches++;
        stats_.status = b.status;
        stats_.url = used;
        stats_.lastError.clear();
      }
      publish(b);
      done = true;
      break;
    }
    if (!done) {
      std::lock_guard<std::mutex> lk(mu_);
      stats_.errors++;
      stats_.lastError = lastErr;
      stats_.status = lastErr;
    }
    {
      std::unique_lock<std::mutex> lk(mu_);
      cv_.wait_for(lk, std::chrono::milliseconds(interval), [this] { return !running_.load(); });
    }
  }
}

}  // namespace board
