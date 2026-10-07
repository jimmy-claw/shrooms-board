// Hybrid Logical Clock — C++ mirror of contract/hlc.mjs
// (logos-multiwriter-sync decision #3: total order wall -> ctr -> dev).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace board {

struct Hlc {
  int64_t wall = 0;
  int64_t ctr = 0;
  std::string dev;
};

// Total order: wall, then ctr, then dev (lexicographic).
int compare_hlc(const Hlc& a, const Hlc& b);

bool valid_dev(const std::string& dev);  // 32 lowercase hex chars

// Monotonic HLC state for one device. Mirrors Clock in hlc.mjs.
class Clock {
 public:
  explicit Clock(std::string dev);

  // Stamp a locally-authored event.
  Hlc send();

  // Advance past an ingested event's cause. Call for EVERY ingested event.
  void receive(const Hlc& h);

  // Prime from a whole log on load.
  void prime(const std::vector<Hlc>& hlcs);

  const std::string& dev() const { return dev_; }

 private:
  std::string dev_;
  int64_t wall_ = 0;
  int64_t ctr_ = 0;
};

}  // namespace board
