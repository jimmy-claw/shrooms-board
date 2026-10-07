// Hybrid Logical Clock — logos-multiwriter-sync decision #3.
// Total order is wall -> ctr -> dev, identical on every replica.
// Wall time is for ordering ONLY — never for quantities (decision #5).

const DEV_LEN = 32; // hex chars; the stable per-device id, distinct from any dataset secret

export function isValidDev(dev) {
  return typeof dev === 'string' && dev.length === DEV_LEN && /^[0-9a-f]+$/.test(dev);
}

export function compareHlc(a, b) {
  return a.wall - b.wall || a.ctr - b.ctr || (a.dev < b.dev ? -1 : a.dev > b.dev ? 1 : 0);
}

export function sameHlc(a, b) {
  return a.wall === b.wall && a.ctr === b.ctr && a.dev === b.dev;
}

// Monotonic HLC state for one device.
export class Clock {
  constructor(dev, nowMs = Date.now) {
    if (!isValidDev(dev)) throw new Error(`Clock: dev must be ${DEV_LEN} hex chars`);
    this.dev = dev;
    this._now = nowMs;
    this.wall = 0;
    this.ctr = 0;
  }

  // Stamp a locally-authored event (skill [^2]: Clock.send).
  send() {
    const p = this._now();
    if (p > this.wall) {
      this.wall = p;
      this.ctr = 0;
    } else {
      this.ctr += 1;
    }
    return { wall: this.wall, ctr: this.ctr, dev: this.dev };
  }

  // Advance past an ingested event's cause (skill [^2]: Clock.receive).
  // Call for EVERY ingested event, else locally authored events can sort
  // before causes we already saw.
  receive(h) {
    if (!h || typeof h.wall !== 'number' || typeof h.ctr !== 'number' || !isValidDev(h.dev)) {
      throw new Error('Clock.receive: malformed hlc');
    }
    const p = this._now();
    const w = Math.max(p, this.wall, h.wall);
    if (w === this.wall && w === h.wall) this.ctr = Math.max(this.ctr, h.ctr) + 1;
    else if (w === this.wall) this.ctr = this.ctr + 1;
    else if (w === h.wall) this.ctr = h.ctr + 1;
    else this.ctr = 0;
    this.wall = w;
    return { wall: this.wall, ctr: this.ctr, dev: this.dev };
  }

  // Prime from a whole log on load (skill [^2] and [^11]).
  prime(events) {
    for (const e of events) this.receive(e.hlc);
  }
}
