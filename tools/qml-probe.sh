#!/bin/bash
# Behaviour probe for a view: load it, then TRIGGER the interactive paths and fail
# on any QML runtime error.
#
# Why this exists next to qml-check.sh: qml-check only compiles. A view shipped with
# `root.delCardTitle = ...` where that property was never declared compiled fine and
# then threw "Cannot assign to non-existent property" the moment the handler ran -
# caught only by a person tapping the button on a device. This runs the handlers.
#
# Usage: tools/qml-probe.sh module/Main.qml
set -uo pipefail
VIEW="$(readlink -f "${1:?usage: qml-probe.sh <view.qml>}")"
QML_BIN="$(command -v qml || echo /usr/lib64/qt6/bin/qml)"
[ -x "$QML_BIN" ] || { echo "qml runtime not found"; exit 2; }
DISP=":97"
pgrep -f "Xvfb $DISP" >/dev/null || { Xvfb "$DISP" -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
TMP="$(mktemp -d)"
cat > "$TMP/probe.qml" <<EOF
import QtQuick
import QtQuick.Controls

Item {
    id: probe
    width: 1600; height: 1000
    Loader { id: l; source: "$VIEW" }

    // Walk the object tree (items, children and Popup contentItems) and call fn on each.
    function walk(o, fn, depth) {
        if (!o || depth > 24) return
        fn(o)
        var kids = o.children
        if (kids) for (var i = 0; i < kids.length; i++) walk(kids[i], fn, depth + 1)
        if (o.contentItem) walk(o.contentItem, fn, depth + 1)
    }

    property int fired: 0

    function trigger() {
        var v = l.item
        if (!v) { Qt.exit(4); return }
        v.meName = "probe"
        v.editing = { id: "probe-card", title: "probe", desc: "", assignees: [] }

        // Open every dialog FIRST: a Popup's contentItem is created lazily, so walking
        // before opening finds none of its buttons (which is how the first two attempts
        // at this probe passed a file with a broken handler).
        var dialogs = []
        walk(v, function (o) {
            if (o && typeof o.open === "function" && typeof o.title === "string") {
                o.open(); dialogs.push(o)
            }
        })
        // Now the buttons exist: emit their clicked() signals, which run the real handlers.
        var wanted = ["DELETE", "ADD", "SAVE", "KEEP", "CANCEL", "ADD LIST"]
        walk(v, function (o) {
            if (o && typeof o.clicked === "function" && typeof o.label === "string"
                && wanted.indexOf(o.label) >= 0) {
                probe.fired++
                o.clicked()
            }
        })
        for (var i = 0; i < dialogs.length; i++) {
            if (typeof dialogs[i].submit === "function") dialogs[i].submit()
            dialogs[i].close()
        }
        // Nothing fired means the probe proved nothing - say so loudly rather than pass.
        if (probe.fired === 0) Qt.exit(6)
    }
    Timer { interval: 1200; running: true; onTriggered: probe.trigger() }
    Timer { interval: 2600; running: true; onTriggered: Qt.quit() }
}
EOF
out=$(DISPLAY="$DISP" QT_QUICK_BACKEND=software LIBGL_ALWAYS_SOFTWARE=1 \
      timeout 20 "$QML_BIN" "$TMP/probe.qml" 2>&1)
rc=$?
rm -rf "$TMP"
bad=$(printf '%s\n' "$out" | grep -E "Error:|is not defined|Cannot assign|Unable to assign|TypeError" || true)
if [ -n "$bad" ]; then
  echo "PROBE FAILED for $VIEW:"
  printf '%s\n' "$bad" | head -10
  exit 1
fi
# The probe exits non-zero when it could not exercise anything. Ignoring that would
# make this script pass on a broken view - which is exactly what it did before.
case "$rc" in
  0)   echo "probe passed: handlers ran with no QML errors ($VIEW)" ;;
  4)   echo "PROBE INCONCLUSIVE: the view did not load ($VIEW)"; exit 2 ;;
  6)   echo "PROBE INCONCLUSIVE: no handler was exercised - the probe is not testing anything ($VIEW)"; exit 2 ;;
  124) echo "PROBE INCONCLUSIVE: timed out ($VIEW)"; exit 2 ;;
  *)   echo "PROBE FAILED: qml exited $rc for $VIEW"; printf '%s\n' "$out" | head -10; exit 1 ;;
esac
