#!/usr/bin/env python3
"""Fail an arm64 build whose LSE atomics are NOT inside the compiler's outlined helpers.

WHY A COUNT IS NOT ENOUGH, in evidence. This audit used to count LSE-looking
instructions and fail above 40. laptop/reviewer cross-compiled the real board_core
both ways on 2026-10-09 and showed the count cannot tell the two apart:

    armv8-a   (safe, runs on the Duet)             1 matching line
    armv8.1-a (the mistake this exists to catch)   3 matching lines

Both are far below 40, because the safe build keeps its atomics inside outlined
`__aarch64_*` helpers (runtime-gated by libgcc/libstdc++) and the unsafe one has a
handful inline in app code. Roughly the same number, opposite safety - so a real
SIGILL-on-the-Duet build PASSED this audit.

WHAT THIS DOES INSTEAD. It attributes every LSE-looking instruction to the symbol
it sits in and fails if any of them is outside a `__aarch64_*` helper. That is the
distinction that matters: an outlined helper is the compiler doing the right thing
on a CPU that may not have LSE; the same instruction in `Engine::apply` is the
build promising the Duet has LSE, which it does not.

The checked-in safe build, for reference: 11 LSE-looking instructions, all 11
inside `__aarch64_*` helpers, 0 outside.

Usage:  objdump -d plugin.so | tools/lse-audit.py
        tools/lse-audit.py plugin.so        (it runs objdump itself)
"""

import re
import subprocess
import sys

# The same instruction shapes the old grep looked for.
LSE = re.compile(r"\s(swp|cas|ldadd|ldset|ldclr|ldeor)[a-z]*\s")
SYMBOL = re.compile(r"^[0-9a-f]+ <(.+)>:")


def scan(lines):
    """Every LSE-looking instruction, attributed to the function it is in."""
    symbol, hits = None, []
    for line in lines:
        m = SYMBOL.match(line)
        if m:
            symbol = m.group(1)
            continue
        if LSE.search(line):
            hits.append(symbol or "(outside any symbol)")
    return hits


def main(argv):
    if len(argv) > 1:
        out = subprocess.run(["objdump", "-d", argv[1]], capture_output=True, text=True)
        if out.returncode != 0:
            print("objdump failed: " + (out.stderr or "").strip()[:200])
            return 2
        lines = out.stdout.splitlines()
    else:
        lines = sys.stdin.read().splitlines()

    hits = scan(lines)
    by_symbol = {}
    for s in hits:
        by_symbol[s] = by_symbol.get(s, 0) + 1

    for s, n in sorted(by_symbol.items(), key=lambda kv: (-kv[1], kv[0])):
        kind = "helper" if s.startswith("__aarch64_") else "APP CODE"
        print("  %-56s %3d  %s" % (s[:56], n, kind))

    outside = sorted({s for s in hits if not s.startswith("__aarch64_")})
    print(
        "LSE-looking instructions: %d, in %d symbols; outside the compiler's helpers: %d"
        % (len(hits), len(by_symbol), len(outside))
    )

    if outside:
        # Name them: "too many" was never the useful message.
        print(
            "::error::LSE atomics outside the compiler's outlined helpers - this build would "
            "SIGILL on the Duet: " + ", ".join(outside[:5])
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
