#!/usr/bin/env python3
"""Measure a view's real geometry by running it on a real Qt engine.

Why this exists: a nested ColumnLayout holding a Layout.fillWidth child absorbed an
entire RowLayout on the Duet (rail 1230px, board area 10px, no list could render).
Nothing static catches that. Screenshots of an Xvfb window come back blank, and
console.log from the `qml` tool does not reach the caller - so this reports the value
through the EXIT CODE, which does come back.

It loads the real view with a stub `logos` module (a canned snapshot), waits for the
layout, then exits with the value you asked for.

Usage:
  tools/probe-render.py module/Main.qml 'Math.round(boardFlick.width / 10)'
  tools/probe-render.py module/Main.qml 'boardArea.children.length' --snapshot my.json
  tools/probe-render.py module/Main.qml 'rail.width' --host vpavlin@192.168.10.59

Exit code is the expression's value (0-250), so 125 means 1250 for a /10 expression.
Runs on --host (default $PROBE_HOST) because a Qt engine is not always local; the
file is copied over, run under Xvfb, and the exit code is read back.
"""
import argparse, json, os, pathlib, subprocess, sys, tempfile

DEFAULT_STATE = {
    "ok": True,
    "boards": [{"id": "b1", "title": "board one", "pos": 1000},
               {"id": "b2", "title": "board two", "pos": 2000}],
    "lists": [{"id": "l1", "board_id": "b1", "title": "todo", "pos": 1000}],
    "cards": [{"id": "c1", "board_id": "b1", "list_id": "l1", "title": "a card",
               "desc": "", "pos": 1000, "due": None, "assignees": []}],
    "comments": [],
    "_allIds": {"boards": ["b1", "b2"], "lists": ["l1"], "cards": ["c1"], "comments": []},
    "board": {"title": None},
    "invariants": {"ok": True, "problems": []},
}

STUB = '''
    // ---- PROBE STUB (injected by tools/probe-render.py; never in the real file) ----
    QtObject {
        id: logos
        signal moduleEventReceived(string mod, string event, string payload)
        property string snap: %(state)s
        function callModule(mod, method, args) { return snap }
        function onModuleEvent(mod, ev) { }
    }
    Timer {
        interval: %(wait)d; running: true
        onTriggered: Qt.exit(Math.max(0, Math.min(250, %(expr)s)))
    }
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("qml")
    ap.add_argument("expr", help="JS expression; the exit code is its value (0-250)")
    ap.add_argument("--snapshot", help="JSON file with the state the stub should return")
    ap.add_argument("--anchor", default="    id: root\n",
                    help="text after which the stub is injected")
    ap.add_argument("--wait", type=int, default=2500, help="ms to let the layout settle")
    ap.add_argument("--host", default=os.environ.get("PROBE_HOST", ""),
                    help="ssh host with a Qt engine; empty runs locally")
    ap.add_argument("--qml-bin", default="/usr/lib64/qt6/bin/qml")
    ap.add_argument("--display", default=":97")
    args = ap.parse_args()

    state = json.load(open(args.snapshot)) if args.snapshot else DEFAULT_STATE
    src = pathlib.Path(args.qml).read_text()
    if args.anchor not in src:
        sys.exit("anchor not found in %s: %r" % (args.qml, args.anchor))
    stub = STUB % {"state": json.dumps(json.dumps(state)), "expr": args.expr, "wait": args.wait}
    probe = src.replace(args.anchor, args.anchor + stub, 1)

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="probe-")) / "probe.qml"
    tmp.write_text(probe)

    run = ("export DISPLAY=%s QT_QUICK_BACKEND=software LIBGL_ALWAYS_SOFTWARE=1; "
           "pgrep -f 'Xvfb %s' >/dev/null || { Xvfb %s -screen 0 1400x900x24 >/dev/null 2>&1 & sleep 2; }; "
           "timeout 25 %s /tmp/__probe__.qml >/dev/null 2>&1; echo $?") % (
        args.display, args.display, args.display, args.qml_bin)

    if args.host:
        subprocess.run(["scp", "-q", str(tmp), "%s:/tmp/__probe__.qml" % args.host], check=True)
        out = subprocess.run(["ssh", "-o", "BatchMode=yes", args.host, run],
                             capture_output=True, text=True)
    else:
        subprocess.run(["cp", str(tmp), "/tmp/__probe__.qml"], check=True)
        out = subprocess.run(["bash", "-c", run], capture_output=True, text=True)

    code = (out.stdout or "").strip().splitlines()[-1:] or [""]
    print("%s  ->  exit %s" % (args.expr, code[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
