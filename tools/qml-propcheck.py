#!/usr/bin/env python3
"""Static checks for the QML bug classes that reached the device.

Two classes, both of which compiled, passed my runtime probe, and then failed on the
real Basecamp - which is why they are checked here instead:

1. ASSIGNMENT TO AN UNDECLARED PROPERTY. A view shipped with `root.delCardTitle = ...`
   and no `property string delCardTitle`. This box's Qt tolerates the assignment;
   Basecamp's throws "Cannot assign to non-existent property" and the button does
   nothing.

2. AN INDEX READ IN A BINDING WITH NO GUARD ON THE SAME LINE. `label: gone[0].title`
   guarded only by `visible: gone.length === 1` on the line above. `visible: false`
   does NOT stop a binding from being evaluated, so the read threw every time the list
   emptied ("TypeError: Cannot read property 'title' of undefined"). The guard has to
   be in the expression, not in a neighbouring property.

   Only BINDINGS are checked, not statements: inside a function a guard on an earlier
   line is real, so `if (b.length === 0) return ""; ... return b[0].id` is fine.

Usage: tools/qml-propcheck.py module/Main.qml   (exit 1 if anything is found)
"""
import re, sys


def check_declared(src, path):
    """Every assignment to the root object must hit a declared property."""
    m = re.search(r'^\s*id:\s*(\w+)', src, re.M)
    if not m:
        return 0, []
    root = m.group(1)
    declared = set()
    for pat in (r'property\s+(?:alias\s+)?\w+\s+(\w+)', r'\bfunction\s+(\w+)\s*\(',
                r'\bsignal\s+(\w+)\s*\(', r'^\s*id:\s*(\w+)'):
        declared |= set(re.findall(pat, src, re.M))
    declared |= {"width", "height", "visible", "state", "parent", "children",
                 "anchors", "objectName", "opacity", "enabled", "focus"}
    bad = []
    for line_no, line in enumerate(src.split("\n"), 1):
        code = re.sub(r'//.*$', '', line)
        code = re.sub(r'"(\\.|[^"\\])*"', '""', code)
        for name in re.findall(r'\b%s\.(\w+)\s*=(?!=)' % re.escape(root), code):
            if name not in declared:
                bad.append((line_no, name, line.strip()[:80]))
    return len(bad), bad


def check_index_guards(src, path):
    """An index read in a binding needs its guard in the same expression."""
    bad = []
    for line_no, line in enumerate(src.split("\n"), 1):
        code = re.sub(r'//.*$', '', line)
        if '"' in code:  # keep it simple: skip lines with strings, they are prose-heavy
            code_nostr = re.sub(r'"(\\.|[^"\\])*"', '""', code)
        else:
            code_nostr = code
        # a binding: `prop: expression` at the start of the line (not `a == b`, not a label)
        if not re.match(r'\s*(?:readonly\s+)?(?:property\s+\w+\s+)?\w+\s*:\s*\S', code_nostr):
            continue
        if re.match(r'\s*(?:if|else|for|while|return|function|signal|property|id|import|pragma)\b', code_nostr):
            continue
        for name in set(re.findall(r'\b(\w+)\s*\[\s*[^\]]+\s*\]', code_nostr)):
            # guarded inline if the same expression also mentions the list's length
            if re.search(r'\b%s\s*\.\s*length\b' % re.escape(name), code_nostr):
                continue
            # `x && x[0]` is a guard too
            if re.search(r'\b%s\s*&&' % re.escape(name), code_nostr):
                continue
            bad.append((line_no, name, line.strip()[:80]))
    return len(bad), bad


def main(path):
    src = open(path, encoding="utf-8").read()
    failed = False

    n, bad = check_declared(src, path)
    if n:
        print(f"{path}: assignment to undeclared property/properties:")
        for ln, name, txt in bad:
            print(f"  line {ln}: {name}  <- {txt}")
        failed = True

    n, bad = check_index_guards(src, path)
    if n:
        print(f"{path}: index read in a binding with no guard on the same line:")
        for ln, name, txt in bad:
            print(f"  line {ln}: {name}[...]  <- {txt}")
        print("  (visible: false does not stop a binding evaluating; guard the index)")
        failed = True

    if not failed:
        print(f"{path}: declarations complete, and every indexed binding is guarded")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "module/Main.qml"))
