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


def root_id(src):
    """The ROOT object's id: the one at the SMALLEST indentation.

    Not the first `id:` in the file. A nested object may legally declare its id before the
    root does - normal after a refactor - and then a check that takes the first one silently
    watches the wrong name and reports success. Proteus demonstrated exactly that: same file
    content, same broken call, only the order of two `id:` lines changed, and the check went
    from failing to passing. Latent in Main.qml today (root at line 16, children at 298+).
    """
    # The SMALLEST indentation is not enough on its own: a nested object may declare its
    # `id:` at the same indentation as the root's body, and a tie that goes to the first
    # one watches the wrong name. laptop/reviewer demonstrated the first hole (reorder two
    # `id:` lines and a broken call passes); this is the same failure one step further in.
    # So an `id:` only counts when it sits INSIDE the object whose opening brace is less
    # indented than it - which is true of the root's own id and of nothing nested.
    stack = []          # indentation of each open block, innermost last
    best, best_ind = None, None
    for line in src.split("\n"):
        code = re.sub(r'//.*$', '', line)
        code = re.sub(r'"(\\.|[^"\\])*"', '""', code)
        m = re.match(r'^(\s*)id:\s*(\w+)', code)
        if m and stack and stack[-1] < len(m.group(1)):
            if best_ind is None or stack[-1] < best_ind:
                best, best_ind = m.group(2), stack[-1]
        for ch in code:
            if ch == '{':
                stack.append(len(line) - len(line.lstrip()))
            elif ch == '}' and stack:
                stack.pop()
    return best


def strip_code(src):
    """Blank comments and every string form, preserving length and newlines.

    Only `//` was stripped and only `"..."` was blanked, so a call inside a block comment or
    a single-quoted string was flagged (false positives train people to ignore a tool), while
    a call inside a backtick template was not seen at all. Newlines are kept so line numbers
    survive.
    """
    out = list(src)
    i, n = 0, len(src)
    def blank(a, b):
        for k in range(a, min(b, n)):
            if out[k] != "\n":
                out[k] = " "
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            blank(i, j); i = j
        elif c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            blank(i, j); i = j
        elif c in "\"'`":
            q = c; j = i + 1
            while j < n and src[j] != q:
                j += 2 if src[j] == "\\" else 1
            j = min(j + 1, n)
            blank(i, j); i = j
        else:
            i += 1
    return "".join(out)


def declarations(src):
    declared = set()
    for pat in (r'property\s+(?:alias\s+)?\w+\s+(\w+)', r'\bfunction\s+(\w+)\s*\(',
                r'\bsignal\s+(\w+)\s*\(', r'^\s*id:\s*(\w+)'):
        declared |= set(re.findall(pat, src, re.M))
    return declared


def check_declared(src, path):
    """Every assignment to the root object must hit a declared property."""
    root = root_id(src)
    if not root:
        return 0, []
    declared = set()
    for pat in (r'property\s+(?:alias\s+)?\w+\s+(\w+)', r'\bfunction\s+(\w+)\s*\(',
                r'\bsignal\s+(\w+)\s*\(', r'^\s*id:\s*(\w+)'):
        declared |= set(re.findall(pat, src, re.M))
    declared = declarations(src) | {
        "width", "height", "visible", "state", "parent", "children",
        "anchors", "objectName", "opacity", "enabled", "focus"}
    code = strip_code(src)
    bad = []
    for m in re.finditer(r'\b%s\s*\??\s*\.\s*(\w+)\s*=(?!=)' % re.escape(root), code):
        name = m.group(1)
        if name not in declared:
            ln = code.count("\n", 0, m.start()) + 1
            bad.append((ln, name, src.split("\n")[ln - 1].strip()[:80]))
    return len(bad), bad


def check_called(src, path):
    """Every CALL on the root object must hit a declared function.

    This is the hole that let a broken view through: a card delegate's bindings never
    evaluate when no card is rendered, so `root.someMissingHelper(card)` compiles, passes
    qml-check (which only compiles) and passes the probe (which exercises dialogs) - and
    throws on the device the moment a card appears. The declared set already carried the
    functions; only assignments were ever checked.
    """
    root = root_id(src)
    if not root:
        return 0, []
    declared = declarations(src)
    # Qt's own Item methods are legitimately called on the root object.
    qt = {"mapToItem", "mapFromItem", "grabToImage", "forceActiveFocus", "contains",
          "childAt", "toString", "hasOwnProperty", "update"}
    code = strip_code(src)
    bad = []
    # `\s*` before the dot also catches the dot on the NEXT line; `\??` catches optional
    # chaining. Both were misses Proteus demonstrated.
    # A local alias for the root is still the root: `var r = root; r.missingHelper()` walked
    # straight past this check (laptop/reviewer, 2026-10-10). Only a BARE alias counts -
    # `var r = root.something` is not the root, and `r = root` after a `var r` elsewhere is
    # not worth guessing at.
    names = [re.escape(root)]
    for m in re.finditer(r'\b(?:var|let|const)\s+(\w+)\s*=\s*%s\s*(?=[\n;,)])' % re.escape(root), code):
        names.append(re.escape(m.group(1)))
    for m in re.finditer(r'\b(?:%s)\s*\??\s*\.\s*(\w+)\s*\(' % "|".join(names), code):
        name = m.group(1)
        if name not in declared and name not in qt:
            ln = code.count("\n", 0, m.start()) + 1
            bad.append((ln, name, src.split("\n")[ln - 1].strip()[:80]))
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

    n, bad = check_called(src, path)
    if n:
        print(f"{path}: call to undeclared function/function(s) on the root:")
        for ln, name, txt in bad:
            print(f"  line {ln}: {name}()  <- {txt}")
        print("  (a delegate's binding does not run until a delegate exists - this is invisible until the device)")
        failed = True

    n, bad = check_index_guards(src, path)
    if n:
        print(f"{path}: index read in a binding with no guard on the same line:")
        for ln, name, txt in bad:
            print(f"  line {ln}: {name}[...]  <- {txt}")
        print("  (visible: false does not stop a binding evaluating; guard the index)")
        failed = True

    if not failed:
        print(f"{path}: declarations complete, every call resolves, and every indexed binding is guarded")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "module/Main.qml"))
