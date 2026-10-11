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
                                   "LINK TO TASK", "LINK", "\u25c0", "\u25b6"]

    function trigger() {
        var v = l.item
        // The hub sync now lives in the CORE: Basecamp's sandbox refuses the network for
        // ui_qml modules, so the cursor decision moved to C++ and is pinned there, in
        // board_core/tests/test_hub.cpp, where the same cases live. What is left for the
        // VIEW is the one thing it still owns: WHICH names to try. The Duet resolves
        // office.mesh where pi5 and Atlas resolve default.mesh, so dropping either name
        // loses the hub on that device - and it is invisible, because the board just shows
        // local data. That is exactly what the Duet reported at v11.
        var cands = v.hubCandidates()
        var hasOffice = cands.indexOf("http://pi5.office.mesh:8407") >= 0
        var hasDefault = cands.indexOf("http://pi5.default.mesh:8407") >= 0
        if (cands.length !== 2 || !hasOffice || !hasDefault) {
            console.error("HUBCANDS FAILED: got " + JSON.stringify(cands))
            Qt.exit(9)
            return
        }
        console.error("HUBCANDS " + cands.join(" "))

        // A reply from the core. The runtime JSON-QUOTES a module's return, and the first
        // version did ONE JSON.parse of it - which yields the inner STRING, so .ok was
        // undefined and the header said "the core did not answer" while the sync was
        // demonstrably working (Duet, v13). It must also survive an error key, which
        // asState() rejects - so this cannot simply reuse that.
        var inner = JSON.stringify({ ok: true, status: "hub 7 (took 2)" })
        var withErr = JSON.stringify({ ok: true, applied: 0, error: "no hub" })
        var replies = [
            (v.coreReply(inner) || {}).status,
            (v.coreReply(JSON.stringify(inner)) || {}).status,
            (v.coreReply(JSON.stringify(withErr)) || {}).error,
            String(v.coreReply("not json")),
            String(v.coreReply(undefined))
        ]
        if (replies.join(",") !== "hub 7 (took 2),hub 7 (took 2),no hub,null,null") {
            console.error("COREREPLY FAILED: got " + replies.join(","))
            Qt.exit(12)
            return
        }
        console.error("COREREPLY " + replies.join(","))

        // What the header SAYS. The last outcome is not enough: an attempt that never
        // returns leaves the last good line on screen, so an outage looks exactly like
        // being caught up. The Duet blackholed the hub for 48 s on the device and the
        // header never changed. A stale reading must therefore WIN over a good status -
        // that precedence is the fix, so it is the case that must fail when broken.
        var lines = [
            v.hubLine({ status: "hub 7 (caught up)" }),
            v.hubLine({ stale: true, since_outcome_ms: 40000, cursor: 2063, status: "hub 2063 (caught up)" }),
            v.hubLine({ stale: true, attempt_ms: 30000, cursor: 0 }),
            v.hubLine({ status: "connect failed", error: "connect failed" }),
            v.hubLine({ attempting: true }),
            v.hubLine(null)
        ]
        var wantLines = "hub 7 (caught up),no news from the hub for 40s - last ok 2063,no news from the hub for 30s - nothing taken yet,connect failed,asking the hub...,the core did not answer"
        if (lines.join(",") !== wantLines) {
            console.error("HUBLINE FAILED: got " + lines.join(","))
            Qt.exit(13)
            return
        }
        console.error("HUBLINE " + lines.join(","))

        // A column whose every card is FINISHED folds to its count. The hub's Tasks board
        // reached 159 cards with nearly all of them done, so the live work was buried on the
        // tablet too - the same rule the web UI applies. PURE, and the cases are the ones
        // that decide it, so a broken rule fails here rather than on the device.
        var term = { task: { state: "completed" } }
        var work = { task: { state: "working" } }
        var none = {}
        var cols = [
            v.isHistoryColumn([]),                                 // false: an empty column is not clutter
            v.isHistoryColumn([term, term]),                       // true
            v.isHistoryColumn([term, work]),                       // false: ONE live card is enough
            v.isHistoryColumn([none]),                             // false: no task means we know nothing
            v.isHistoryColumn(null),                               // false
            v.isHistoryColumn([{ task: { state: "failed" } }])     // true: failed is terminal
        ]
        if (cols.join(",") !== "false,true,false,false,false,true") {
            console.error("FOLDCOL FAILED: got " + cols.join(","))
            Qt.exit(14)
            return
        }
        console.error("FOLDCOL " + cols.join(","))

        // The choice: follow the data until a human says otherwise, then the human wins.
        v.foldedCols = {}
        var folded = [ v.columnFolded("c1", [term, term]), v.columnFolded("c2", [work]) ]
        v.foldedCols = { c1: false, c2: true }
        folded.push(v.columnFolded("c1", [term, term]))   // opened by hand: stays open
        folded.push(v.columnFolded("c2", [work]))         // folded by hand: stays folded
        v.foldedCols = {}
        if (folded.join(",") !== "true,false,false,true") {
            console.error("FOLDPICK FAILED: got " + folded.join(","))
            Qt.exit(15)
            return
        }
        console.error("FOLDPICK " + folded.join(","))

        // The board is wider than a tablet screen and the Duet found it could not be scrolled
        // at all, so the finished columns were unreachable. The arrows' STEP is pure, and the
        // cases that matter are the two ends and "there is nothing to scroll".
        var scroll = [
            v.nextContentX(0, 1000, 200, 1),      // 200  a normal step
            v.nextContentX(900, 1000, 200, 1),    // 1000 clamped at the right edge
            v.nextContentX(0, 1000, 200, -1),     // 0    never negative
            v.nextContentX(500, 0, 200, 1),       // 0    nothing to scroll: rest at the start
            v.nextContentX(500, 100, 200, 1),     // 100  a shrink clamps, it does not strand
            v.nextContentX(1000, 1000, 200, 1)    // 1000 already at the end
        ]
        if (scroll.join(",") !== "200,1000,0,0,100,1000") {
            console.error("SCROLLX FAILED: got " + scroll.join(","))
            Qt.exit(16)
            return
        }
        console.error("SCROLLX " + scroll.join(","))

        // The dialog renders a SNAPSHOT, so act() re-reads the card from the state it was
        // handed. That refresh silently did NOTHING for two rounds: asState() returns the
        // state as a STRING, and the first version indexed its 'cards' field on that string. The
        // Duet caught it on the device (toast "Task linked", row still "no task linked") and
        // I confirmed it in its screenshot. act()'s callback is async, so the DECISION is
        // pure and is pinned here. The state argument is TEXT, not an object.
        var fresh = [
            (v.freshCard('{"cards":[{"id":"c1","task_ref":"a/b:1"}]}', 'c1') || {}).task_ref,
            String(v.freshCard('{"cards":[]}', 'c1')),
            String(v.freshCard('not json', 'c1')),
            String(v.freshCard(undefined, 'c1')),
            String(v.freshCard('{"cards":[{"id":"c1"}]}', '')),
            (v.freshCard('{"cards":[{"id":"x"},{"id":"c1","task_ref":"a/b:2"}]}', 'c1') || {}).task_ref
        ]
        if (fresh.join(",") !== "a/b:1,null,null,null,null,a/b:2") {
            console.error("FRESH FAILED: got " + fresh.join(",") + ", want a/b:1,null,null,null,null,a/b:2")
            Qt.exit(11)
            return
        }
        console.error("FRESH " + fresh.join(","))
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
# The scroll arrows must come BEFORE the sync status in the header. The status string changes
# length on every poll ("hub 2310 (took 5)" vs "(caught up)"), and anything laid out after it
# slides sideways - the Duet measured ~25 px, i.e. a button that moves out from under a finger
# mid-tap. A harness cannot click in a real header, so this is a SOURCE-ORDER check, and it
# fails when the order is wrong (verified by putting them back).
arrow_line=$(grep -n 'root.scrollBoard(1)' "$VIEW" | head -1 | cut -d: -f1)
status_line=$(grep -n 'visible: root.hubStatus' "$VIEW" | head -1 | cut -d: -f1)
if [ -n "$arrow_line" ] && [ -n "$status_line" ] && [ "$arrow_line" -gt "$status_line" ]; then
  echo "PROBE FAILED: the scroll arrows are laid out AFTER the changing status text ($VIEW)"
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
  9)   echo "PROBE FAILED: hubCandidates lost a mesh name ($VIEW)"; exit 1 ;;
  11)  echo "PROBE FAILED: freshCard does not read a state STRING ($VIEW)"; exit 1 ;;
  12)  echo "PROBE FAILED: coreReply does not unwrap a quoted core reply ($VIEW)"; exit 1 ;;
  13)  echo "PROBE FAILED: the header line lets a good status hide a stalled sync ($VIEW)"; exit 1 ;;
  14)  echo "PROBE FAILED: the history-column rule is wrong ($VIEW)"; exit 1 ;;
  15)  echo "PROBE FAILED: an explicit fold choice does not win over the data ($VIEW)"; exit 1 ;;
  16)  echo "PROBE FAILED: the board scroll step is wrong ($VIEW)"; exit 1 ;;
  124) echo "PROBE INCONCLUSIVE: timed out ($VIEW)"; exit 2 ;;
  *)   echo "PROBE FAILED: qml exited $rc for $VIEW"; printf '%s\n' "$out" | head -10; exit 1 ;;
esac
