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

    // Walk the object tree and call fn on each. It walks .data, NOT .children: a Qt
    // Popup is a QObject child of its declarer but NOT a visual child, so .children
    // finds ZERO dialogs - which is exactly what this probe did while reporting "passed".
    // (Ten dialogs live in this view; .children found none of them.)
    function walk(o, fn, depth) {
        if (!o || depth > 24) return
        fn(o)
        var kids = o.data
        if (kids) for (var i = 0; i < kids.length; i++) walk(kids[i], fn, depth + 1)
        if (o.contentItem) walk(o.contentItem, fn, depth + 1)
    }

    property int fired: 0
    // A thrown handler is recorded and turned into a non-zero exit. Do NOT rely on
    // parsing qml's output for this: QML logging is suppressed unless
    // QT_ASSUME_STDERR_HAS_CONSOLE=1, so a grep for "TypeError" silently found nothing.
    property string err: ""
    function tryRun(fn) {
        try { fn() } catch (e) { if (probe.err === "") probe.err = String(e) }
    }

    // Every label that runs a handler worth running. A new affordance that is not in this
    // list is NOT tested, however green the probe looks - so add the label with the button.
    readonly property var wanted: ["DELETE", "ADD", "SAVE", "KEEP", "CANCEL", "ADD LIST",
                                   "LINK TO TASK", "LINK"]

    function trigger() {
        var v = l.item
        // The cursor after a reply. The reviewer reproduced a hub reporting head=5 while
        // sending only 3 events: trusting the head left e4/e5 unreachable forever, and my
        // first fix moved the ASSIGNMENT but still took the VALUE from the reply. The poll
        // itself is async and this probe cannot drive it, so the decision is a pure
        // function and is pinned here - a wrong cursor is a silent, permanent data loss.
        var cursors = [
            v.nextCursor(0, { head: 5, events: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] }),  // 3, NOT 5
            v.nextCursor(7, { head: 9, events: [] }),                                    // 7, NOT 9
            v.nextCursor(7, { head: 9, events: [{ seq: 8 }, { seq: 9 }] }),              // 9
            v.nextCursor(3, { head: 9, events: [{ seq: 2 }] }),                          // 3, never back
            v.nextCursor(0, null),                                                       // 0
            v.nextCursor(4, { head: 4, events: [] })                                     // 4
        ]
        if (cursors.join(",") !== "3,7,9,3,0,4") {
            console.error("CURSOR FAILED: got " + cursors.join(",") + ", want 3,7,9,3,0,4")
            Qt.exit(9)
            return
        }
        console.error("CURSOR " + cursors.join(","))

        // And whether the poll can TELL that a reply is one it cannot place. The reviewer's
        // own mock sent {event:{...}} with no seq, which under nextCursor stalls the sync for
        // the wrong reason and looks exactly like being caught up.
        var noseq = [
            v.replyHasNoSeq({ head: 5, events: [{ seq: 1 }] }),      // false: placeable
            v.replyHasNoSeq({ head: 5, events: [{ event: {} }] }),    // TRUE: the old mock shape
            v.replyHasNoSeq({ head: 5, events: [] }),                 // false: nothing to place
            v.replyHasNoSeq(null)                                      // false: no reply at all
        ]
        if (noseq.join(",") !== "false,true,false,false") {
            console.error("NOSEQ FAILED: got " + noseq.join(",") + ", want false,true,false,false")
            Qt.exit(10)
            return
        }
        console.error("NOSEQ " + noseq.join(","))
        if (!v) { Qt.exit(4); return }
        v.meName = "probe"
        v.editing = { id: "probe-card", title: "probe", desc: "", assignees: [] }

        var dialogs = []
        walk(v, function (o) {
            if (o && typeof o.open === "function" && typeof o.title === "string") dialogs.push(o)
        })
        // No dialog found means the walk is broken and the probe tests nothing. (It spent
        // a long time reporting "passed" while finding zero dialogs, because it walked
        // .children, where Qt Popups do not appear.) Refuse to pass vacuously.
        if (dialogs.length === 0) Qt.exit(8)

        var linkDlg = null
        for (var m = 0; m < dialogs.length; m++) {
            if (dialogs[m].title === "link a task") linkDlg = dialogs[m]
        }

        function clickWanted() {
            walk(v, function (o) {
                if (o && typeof o.clicked === "function" && typeof o.label === "string"
                    && wanted.indexOf(o.label) >= 0) {
                    probe.fired++
                    var b = o
                    probe.tryRun(function () { b.clicked() })
                }
            })
        }

        // Open the dialogs ONE AT A TIME, clicking after each, so a handler runs with the
        // other dialogs still closed.
        Qt.callLater(function () {
            for (var i = 0; i < dialogs.length; i++) {
                dialogs[i].open()
                clickWanted()
            }
            // A pass with a link ALREADY set: the UNLINK branch only exists then.
            v.editing = { id: "probe-card", title: "probe", desc: "", assignees: [],
                          task_ref: "pi5/probe:t-1" }
            walk(v, function (o) {
                if (o && typeof o.clicked === "function" && typeof o.label === "string"
                    && o.label === "UNLINK") {
                    probe.fired++
                    var u = o
                    probe.tryRun(function () { u.clicked() })
                }
            })
            for (var k = 0; k < dialogs.length; k++) {
                var dlg = dialogs[k]
                if (typeof dlg.submit === "function") probe.tryRun(function () { dlg.submit() })
            }
            // A handler that threw synchronously is a failure; it must not depend on
            // reading the log.
            if (probe.err !== "") Qt.exit(7)
            // Nothing fired means the probe proved nothing - say so loudly rather than pass.
            if (probe.fired === 0) Qt.exit(6)
            // NOTE, and it is a real limit: this probe CANNOT test the cold path. Its own
            // walk reads .contentItem on every dialog, which materialises the popup, so by
            // the time a handler runs the lazily-created field already exists. I tried an
            // outcome assertion here ("did LINK TO TASK open its dialog?") and proved it
            // cannot fail - a mutant whose handler never opens the dialog still passed - so
            // it is gone rather than left as false comfort. The DEVICE is the gate for that
            // class: on the tablet, tap LINK TO TASK as the FIRST thing after opening a
            // card, before the link dialog has ever been shown.
            Qt.quit()
        })
    }
    Timer { interval: 1200; running: true; onTriggered: probe.trigger() }
    Timer { interval: 2600; running: true; onTriggered: Qt.quit() }
}
EOF
# QT_ASSUME_STDERR_HAS_CONSOLE=1: without it qml discards console output entirely, so a
# grep for errors finds nothing and a broken view "passes".
out=$(QT_ASSUME_STDERR_HAS_CONSOLE=1 DISPLAY="$DISP" QT_QUICK_BACKEND=software LIBGL_ALWAYS_SOFTWARE=1 \
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
  7)   echo "PROBE FAILED: a handler threw ($VIEW)"; printf '%s\n' "$out" | grep -E "DIAG|Error|TypeError|undefined" | head -5; exit 1 ;;
  8)   echo "PROBE INCONCLUSIVE: no dialog was found - the walk is broken ($VIEW)"; exit 2 ;;
  124) echo "PROBE INCONCLUSIVE: timed out ($VIEW)"; exit 2 ;;
  *)   echo "PROBE FAILED: qml exited $rc for $VIEW"; printf '%s\n' "$out" | head -10; exit 1 ;;
esac
