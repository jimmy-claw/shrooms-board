#!/usr/bin/env python3
"""Catch assignments to properties that were never declared.

Why: a view shipped with `root.delCardTitle = ...` and no `property string
delCardTitle`. It compiled, my qml-check passed, and my runtime probe passed too -
because this box's Qt tolerates the assignment while Basecamp's bundled Qt throws
"Cannot assign to non-existent property" and the button does nothing. The device
found it. This is the check that can find it here.

Usage: tools/qml-propcheck.py module/Main.qml   (exit 1 if anything is undeclared)
"""
import re, sys

def main(path):
    src = open(path, encoding="utf-8").read()
    # the root object's id: the first `id:` in the file
    m = re.search(r'^\s*id:\s*(\w+)', src, re.M)
    if not m:
        print(f"{path}: no root id found; nothing to check"); return 0
    root = m.group(1)

    declared = set()
    for pat in (r'property\s+(?:alias\s+)?\w+\s+(\w+)', r'\bfunction\s+(\w+)\s*\(',
                r'\bsignal\s+(\w+)\s*\(', r'^\s*id:\s*(\w+)'):
        declared |= set(re.findall(pat, src, re.M))
    # QML built-ins a handler may legitimately set on the root
    declared |= {"width", "height", "visible", "state", "parent", "children",
                 "anchors", "objectName", "opacity", "enabled", "focus"}

    bad = []
    for line_no, line in enumerate(src.split("\n"), 1):
        code = re.sub(r'//.*$', '', line)
        code = re.sub(r'"(\\.|[^"\\])*"', '""', code)
        for name in re.findall(r'\b%s\.(\w+)\s*=(?!=)' % re.escape(root), code):
            if name not in declared:
                bad.append((line_no, name, line.strip()[:80]))
    if bad:
        print(f"{path}: assignment to undeclared {root}.* property/properties:")
        for ln, name, txt in bad:
            print(f"  line {ln}: {root}.{name}  <- {txt}")
        return 1
    print(f"{path}: every {root}.* assignment has a declaration")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "module/Main.qml"))
