// Hybrid Logical Clock — C++ mirror of contract/hlc.mjs
#include "hlc.hpp"

#include <chrono>
#include <stdexcept>

namespace board {

namespace {
int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}
}  // namespace

int compare_hlc(const Hlc& a, const Hlc& b) {
  if (a.wall != b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.ctr != b.ctr) return a.ctr < b.ctr ? -1 : 1;
  if (a.dev != b.dev) return a.dev < b.dev ? -1 : 1;
  return 0;
}

bool valid_dev(const std::string& dev) {
  if (dev.size() != 32) return false;
  for (char c : dev) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

Clock::Clock(std::string dev) : dev_(std::move(dev)) {
  if (!valid_dev(dev_)) throw std::invalid_argument("Clock: dev must be 32 hex chars");
}

Hlc Clock::send() {
  const int64_t p = now_ms();
  if (p > wall_) {
    wall_ = p;
    ctr_ = 0;
  } else {
    ctr_ += 1;
  }
  return Hlc{wall_, ctr_, dev_};
}

void Clock::receive(const Hlc& h) {
  const int64_t p = now_ms();
  int64_t w = p;
  if (wall_ > w) w = wall_;
  if (h.wall > w) w = h.wall;

  if (w == wall_ && w == h.wall) {
    ctr_ = (ctr_ > h.ctr ? ctr_ : h.ctr) + 1;
  } else if (w == wall_) {
    ctr_ = ctr_ + 1;
  } else if (w == h.wall) {
    ctr_ = h.ctr + 1;
  } else {
    ctr_ = 0;
  }
  wall_ = w;
}

void Clock::prime(const std::vector<Hlc>& hlcs) {
  for (const auto& h : hlcs) receive(h);
}

}  // namespace board
