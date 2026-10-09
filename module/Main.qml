// shrooms-board — Basecamp view.
//
// Styled after the Shrooms Agents view (the same app family), per the Duet
// session's critique: plain QtQuick/Controls/Layouts, the Shrooms palette, mono
// type, one scale helper fs()/sz() used for EVERY size, 1px cLine borders,
// radius sz(6/8/12). Deliberately imports NO Logos.* module and uses NO Theme
// tokens: the bundled design system's blacks do not separate, and Theme.typography
// size tokens do not exist on this DS (a guard on them was dead code).
//
// All logic lives in board_core; this file only calls actions and renders the JSON.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: root
    width: 1280; height: 800

    // ---- the Shrooms palette (same meanings as the rest of the family) -----
    readonly property color cVoid:     "#07090B"
    readonly property color cPanel:    "#0E1216"
    readonly property color cLine:     "#1C2229"
    readonly property color cAsh:      "#6B7680"
    readonly property color cBone:     "#D6DDE3"
    readonly property color cPhosphor: "#35F0A0"
    readonly property color cAmber:    "#F0B429"
    readonly property color cRust:     "#E05252"

    // ---- one scale for every number (nothing fixed-pixel) ------------------
    readonly property real autoScale: Math.max(1.0, Math.min(1.6, root.width / 1200))
    readonly property real uiScale: Math.max(0.8, Math.min(2.2, autoScale))
    function fs(n) { return Math.round(n * root.uiScale) }
    function sz(n) { return Math.round(n * root.uiScale) }

    property string stateJson: ""
    property string meName: ""
    property string toastText: ""
    property bool toastIsError: false
    property int callTimeoutMs: 20000

    // ---- the ONE way the view talks to the module --------------------------
    function callVia(mod, method, args, cb) {
        var a = args || []
        var done = function (raw) {
            if (cb) { try { cb(raw === undefined || raw === null ? "" : raw) } catch (e) { console.warn("board: callback threw: " + e) } }
        }
        if (typeof logos === "undefined" || logos === null) { Qt.callLater(function () { done("") }); return }
        if (typeof logos.callModuleAsync === "function") {
            try { logos.callModuleAsync(mod, method, a, done, root.callTimeoutMs) }
            catch (e) { Qt.callLater(function () { done("") }) }
            return
        }
        Qt.callLater(function () { var r = ""; try { r = logos.callModule(mod, method, a) } catch (e) { r = "" } done(r) })
    }
    function core(method, args, cb) { root.callVia("board_core", method, args, cb) }
    function asState(raw) {
        var s = String(raw === undefined || raw === null ? "" : raw).trim()
        for (var i = 0; i < 2 && s.charAt(0) === '"'; i++) {
            try { s = String(JSON.parse(s)).trim() } catch (e) { return null }
        }
        if (s.charAt(0) !== "{") return null
        var o; try { o = JSON.parse(s) } catch (e) { return null }
        return (o && o.error === undefined) ? s : null
    }
    function state() { try { return JSON.parse(root.stateJson) } catch (e) { return ({}) } }
    // ---- boards (v2): one instance, many boards ---------------------------
    // A board is a partition of the same log, so switching boards is a local view
    // choice, not a reload. Records with no board_id are v1 data on the default board.
    property string currentBoardId: ""
    // WHO is doing it. The worker needs no stored field: it is the first half of the task
    // ref (machine/session:messageId). `task.by` is the requester, stored on the card.
    function workerOf(card) {
        var ref = card.task_ref || ""
        if (ref === "") return ""
        var colon = ref.indexOf(":")
        var who = colon > 0 ? ref.slice(0, colon) : ref
        var slash = who.indexOf("/")
        return slash >= 0 ? who.slice(slash + 1) : who
    }
    function workerFull(card) {
        var ref = card.task_ref || ""
        var colon = ref.indexOf(":")
        return colon > 0 ? ref.slice(0, colon) : ref
    }
    function taskState(card) { return (card.task && card.task.state) ? card.task.state : "" }
    function taskUnacked(card) {
        var t = card.task || {}
        var term = ["completed", "failed", "canceled", "rejected", "expired"]
        return term.indexOf(t.state) >= 0 && t.ack !== "acked"
    }
    function taskLabel(card) {
        var t = card.task || {}
        if (!t.state) return ""
        if (t.ack === "acked") return t.state + " \u00b7 acked"
        if (root.taskUnacked(card)) return t.state + " \u00b7 unacked"
        return t.state
    }

    // ---- the hub: the board the fleet actually uses --------------------------------
    // This module is its own replica, so it shows NOTHING the hub's bridge writes - the
    // Tasks board, its columns, the task state - until it syncs. This pulls the hub's
    // events since our cursor and hands them to the core (the same seam the hub uses).
    // READ-ONLY: writes stay local, so the Duet cannot fight the hub for the log.
    property string hubBase: ""
    property string hubStatus: ""
    property int hubCursor: 0
    function hubCandidates() {
        // The two mesh names resolve on different devices (the Duet found office.mesh where
        // pi5 and Atlas resolve default.mesh), so try both and remember the one that answers.
        return ["http://pi5.default.mesh:8407", "http://pi5.office.mesh:8407"]
    }
    function hubPoll() {
        var bases = root.hubBase !== "" ? [root.hubBase].concat(root.hubCandidates()) : root.hubCandidates()
        var i = 0
        function attempt() {
            if (i >= bases.length) { root.hubStatus = "no hub"; return }
            var b = bases[i++]
            var xhr = new XMLHttpRequest()
            xhr.open("GET", b + "/events?since=" + root.hubCursor)
            xhr.timeout = 8000
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return
                if (xhr.status !== 200) { attempt(); return }
                var d = null
                try { d = JSON.parse(xhr.responseText) } catch (e) { d = null }
                // VALIDATE BEFORE PINNING. A host answering 200 with the wrong shape used to pin
                // hubBase permanently, so the REAL hub was never contacted again - the reviewer
                // demonstrated that against a mock, with the real hub reachable throughout. A reply we
                // cannot use is a reason to try the NEXT candidate, not to remember this one.
                if (!d || !Array.isArray(d.events) || typeof d.head !== "number") {
                    root.hubStatus = "bad reply from " + b
                    attempt()
                    return
                }
                // A cursor past the hub's head means this is not the log we were following - it was
                // reset, or this is a different hub. Re-fetch from zero rather than asking for events
                // past the end of it forever.
                if (d.head < root.hubCursor) {
                    root.hubCursor = 0
                    i = i - 1
                    attempt()
                    return
                }
                var evs = []
                for (var k = 0; k < d.events.length; k++) evs.push(d.events[k].event)
                var advance = function () {
                    // ONLY NOW. The cursor is the promise that everything before it is in the local
                    // log. Advancing it before the ingest returns drops whatever the ingest did not
                    // take, and nothing recovers it: the next poll asks since=head. The reviewer showed
                    // head=5 with 3 events sent - e4 and e5 were unreachable forever. That is the whole
                    // HIGH finding, and it was true by construction, not a race.
                    root.hubBase = b
                    // Compare BEFORE assigning: the first version of this edit set hubCursor first, so
                    // `moved` was always false and the cursor was never persisted - the bug it was meant
                    // to avoid. Order matters, and no gate of mine can see it.
                    var moved = (d.head !== root.hubCursor)
                    root.hubCursor = d.head
                    root.hubStatus = "hub " + d.head
                    // Persist ONLY when it moved. A preference write every 10 s would be a disk write
                    // every 10 s, forever, on a tablet - and a poll that changed nothing has nothing to save.
                    if (moved) root.core("setPreference", ["hub_cursor", String(d.head)], function () {})
                }
                if (evs.length) root.core("ingestEvents", [JSON.stringify(evs)], advance)
                else advance()
            }
            xhr.send()
        }
        attempt()
    }
    Timer { interval: 10000; running: true; repeat: true; onTriggered: root.hubPoll() }

    function boards() { return root.state().boards || [] }
    function currentBoard() {
        var b = root.boards()
        // No live boards means no board is selected - NOT the default board. Returning
        // "default" here made a just-deleted board reappear as a phantom empty board
        // titled "MAIN": the fallback was written for a v1 log, but the fold enumerates
        // a v1 board now, so it only ever fired when every board was deleted. (Duet, 08/10.)
        if (b.length === 0) return ""
        for (var i = 0; i < b.length; i++) if (b[i].id === root.currentBoardId) return b[i].id
        return b[0].id
    }
    // A board's name for DISPLAY. A v1 log's board has no title at all - nothing ever
    // renamed it - and showing "(untitled)" or an empty row for the only board that log
    // has is unhelpful. It is the main board: call it "main".
    function boardName(b, fallback) {
        if (!b) return fallback || ""
        if (b.title) return b.title
        // "main" is the name of a v1 log's board whether it is live or deleted; the
        // fallback covers a board someone created and never named, which reads
        // "(untitled)" while it is there and "board" once it is gone.
        if (b.id === "default") return "main"
        return fallback || "(untitled)"
    }
    function currentBoardTitle() {
        var b = root.boards(); var id = root.currentBoard()
        for (var i = 0; i < b.length; i++) if (b[i].id === id) return root.boardName(b[i])
        // no live board: say so rather than naming a board that is not there
        if (b.length === 0) return "no boards"
        var t = root.state().board && root.state().board.title
        return t || "main"
    }
    // The name as STORED, which is not the same thing: prefilling RENAME with the
    // display name would write a title on an OK with no typing, turning a no-op into a
    // silent write.
    function currentBoardRawTitle() {
        var b = root.boards(); var id = root.currentBoard()
        for (var i = 0; i < b.length; i++) if (b[i].id === id) return b[i].title || ""
        var t = root.state().board && root.state().board.title
        return t || ""
    }
    // Deleted boards come from the fold WITH their names, so a restore can say which
    // board it would bring back instead of making the user guess.
    function deletedBoards() { return root.state().deleted_boards || [] }
    function restoreBoard(id) {
        root.act("restoreBoard", [id], "Board restored")
        // the restored board is the one to look at
        Qt.callLater(function () { root.selectBoard(id) })
    }
    // Local settings the view keeps for itself: which board you were looking at, and
    // who you are. NOT events - a peer has no business seeing either - so they live in
    // the core's view.json, never in the log.
    function setPref(key, value) { root.core("setPreference", [key, value], function () { }) }
    function getPref(key, cb) {
        root.core("preference", [key], function (raw) {
            var b = root.asState(raw)
            if (!b) return
            var o = null
            try { o = JSON.parse(b) } catch (e) { o = null }
            if (o && typeof o.value === "string" && o.value !== "") cb(o.value)
        })
    }
    function selectBoard(id) {
        root.currentBoardId = id
        root.setPref("last_board", id)
        root.refresh()
    }
    function restorePreferences() {
        if (root.currentBoardId === "") root.getPref("last_board", function (v) { root.currentBoardId = v })
        if (root.meName === "") root.getPref("me", function (v) { root.meName = v })
    }
    function lists() {
        var ls = root.state().lists || []
        var b = root.currentBoard()
        var out = []
        for (var i = 0; i < ls.length; i++) if ((ls[i].board_id || "default") === b) out.push(ls[i])
        return out
    }
    function cardsOf(listId) {
        var cs = root.state().cards || []
        var out = []
        for (var i = 0; i < cs.length; i++) if (cs[i].list_id === listId) out.push(cs[i])
        return out
    }

    // ---- read state: poll snapshot(), single-flight ------------------------
    property bool refreshBusy: false
    property bool refreshAgain: false
    property int misses: 0
    property bool firstLoadDone: false
    readonly property bool reachable: root.misses < 5
    readonly property bool everLoaded: root.stateJson !== ""
    function refresh() {
        if (root.refreshBusy) { root.refreshAgain = true; return }
        root.refreshBusy = true
        root.core("snapshot", [], function (raw) {
            var b = root.asState(raw)
            if (b) {
                root.misses = 0
                root.firstLoadDone = true
                var nu = root.countRecords(b)
                // never blank a populated view with an empty answer (multi-instance guard)
                if (!(nu === 0 && root.countRecords(root.stateJson) > 0)) root.stateJson = b
            } else {
                root.misses += 1
            }
            root.refreshBusy = false
            if (root.refreshAgain) { root.refreshAgain = false; root.refresh() }
        })
    }
    function countRecords(t) {
        try { var o = JSON.parse(t); return (o.lists ? o.lists.length : 0) + (o.cards ? o.cards.length : 0) } catch (e) { return 0 }
    }
    Timer { interval: 2500; running: true; repeat: true; onTriggered: root.refresh() }
    Component.onCompleted: {
        if (typeof logos !== "undefined" && logos !== null && logos.onModuleEvent)
            logos.onModuleEvent("board_core", "stateChanged")
        root.refresh()
        root.restorePreferences()
        // LAST: the first sync emits stateChanged, and we must be subscribed before it does.
        // The cursor is persisted (the design said so and the code did not), so a restart
        // continues instead of re-fetching the whole log. If the read fails we poll from 0,
        // which is today's behaviour and safe - ingest dedupes by id.
        root.core("preference", ["hub_cursor"], function (raw) {
            var v = parseInt(String(raw).replace(/[^0-9]/g, ""), 10)
            if (!isNaN(v) && v >= 0) root.hubCursor = v
            root.hubPoll()
        })
    }
    Connections {
        target: (typeof logos !== "undefined" && logos !== null) ? logos : null
        function onModuleEventReceived(mod, event, payload) {
            if (mod !== "board_core" || event !== "stateChanged") return
            var b = root.asState(payload); if (b) root.stateJson = b
        }
    }

    // ---- actions: every outcome is visible --------------------------------
    property bool actBusy: false
    function toast(msg, isErr) { root.toastText = msg; root.toastIsError = !!isErr; toastTimer.restart() }
    Timer { id: toastTimer; interval: 4000; onTriggered: root.toastText = "" }
    function act(method, args, okMsg, onOk) {
        if (root.actBusy) return
        root.actBusy = true
        root.core(method, args, function (raw) {
            root.actBusy = false
            var b = root.asState(raw)
            if (b) {
                root.stateJson = b
                // The card dialog renders a SNAPSHOT (`root.editing`, taken by openCard), so
                // without this an edit leaves the dialog showing what it OPENED with: it says
                // "Task linked" in the toast while the row still reads "no task linked". That
                // is exactly what the Duet saw at v10. Re-read the card from the state we were
                // just handed. Safe because the dialog's fields are set imperatively, not
                // bound to `editing` - replacing it does not clobber what is being typed.
                if (root.editing && root.editing.id) {
                    var fresh = (b.cards || []).filter(function (c) { return c.id === root.editing.id })[0]
                    if (fresh) root.editing = fresh
                }
                if (okMsg) root.toast(okMsg, false)
                if (onOk) onOk()
            }
            else {
                var o = null; try { o = JSON.parse(String(raw)) } catch (e) { o = null }
                root.toast((o && o.error) ? o.error : "Request failed - is board_core loaded?", true)
            }
        })
    }
    function newId() {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8)
            return v.toString(16)
        })
    }

    Rectangle { anchors.fill: parent; color: root.cVoid }

    // ---- shared small components (the family's idiom) ----------------------
    component Lnk: Text { textFormat: Text.PlainText;
        id: lnk
        signal clicked()
        property color base: root.cPhosphor
        color: lnkMouse.containsMouse ? root.cBone : base
        font.family: "monospace"; font.pixelSize: root.fs(11)
        font.underline: lnkMouse.containsMouse
        // a finger needs a bigger target than the glyphs (touch-first device)
        MouseArea { id: lnkMouse; anchors.fill: parent; anchors.margins: -root.sz(12)
                    hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: lnk.clicked() }
    }

    // Primary / ghost buttons: a Rectangle + MouseArea, sized for touch.
    component Btn: Rectangle {
        id: btn
        signal clicked()
        property string label: ""
        property bool primary: false
        property bool danger: false
        implicitWidth: btnText.implicitWidth + root.sz(28)
        implicitHeight: root.sz(36)
        radius: root.sz(8)
        color: !btn.enabled ? "transparent"
             : primary ? (btnMouse.containsMouse ? Qt.lighter(root.cPhosphor, 1.15) : root.cPhosphor)
             : danger ? (btnMouse.containsMouse ? Qt.rgba(0.88, 0.32, 0.32, 0.18) : "transparent")
             : (btnMouse.containsMouse ? root.cLine : "transparent")
        border.width: 1
        border.color: !btn.enabled ? root.cLine : primary ? root.cPhosphor : danger ? root.cRust : root.cLine
        opacity: btn.enabled ? 1 : 0.45
        Text { textFormat: Text.PlainText;
            id: btnText
            anchors.centerIn: parent
            text: btn.label
            color: !btn.enabled ? root.cAsh
                 : btn.primary ? root.cVoid : btn.danger ? root.cRust : root.cBone
            font.family: "monospace"; font.pixelSize: root.fs(11)
        }
        MouseArea { id: btnMouse; anchors.fill: parent; hoverEnabled: true; enabled: btn.enabled
                    cursorShape: Qt.PointingHandCursor; onClicked: btn.clicked() }
    }

    // Field: TextField with the family's background treatment.
    component Field: TextField {
        id: fld
        color: root.cBone
        placeholderTextColor: root.cAsh
        font.family: "monospace"; font.pixelSize: root.fs(12)
        selectByMouse: true
        background: Rectangle {
            color: root.cVoid; radius: root.sz(6)
            border.width: 1
            border.color: fld.activeFocus ? root.cPhosphor : root.cLine
        }
    }

    component SectionLabel: Text { textFormat: Text.PlainText;
        color: root.cPhosphor
        font.family: "monospace"; font.pixelSize: root.fs(11); font.letterSpacing: 1.5
    }

    // ---- one board, as a row in the switcher popup --------------------------
    component BoardRow: Rectangle {
        id: bRow
        required property var modelData
        property bool deleted: false
        readonly property bool current: !bRow.deleted && bRow.modelData.id === root.currentBoard()
        Layout.fillWidth: true
        implicitHeight: root.sz(30)
        radius: root.sz(4)
        // press feedback: an unselected row used to show nothing at all when tapped
        color: bRow.current ? root.cVoid : (bRowMouse.pressed ? root.cLine : "transparent")
        border.width: 1
        border.color: bRow.current ? root.cPhosphor : (bRowMouse.containsMouse ? root.cLine : "transparent")
        Text {
            anchors.verticalCenter: parent.verticalCenter
            anchors.left: parent.left; anchors.leftMargin: root.sz(10)
            textFormat: Text.PlainText
            text: (bRow.current ? "> " : "  ") + root.boardName(bRow.modelData)
            // grey, not amber: amber is the "needs attention" colour and a deleted board
            // must not compete with a live one
            color: bRow.current ? root.cBone : root.cAsh
            font.family: "monospace"; font.pixelSize: root.fs(11)
        }
        Text {
            visible: bRow.deleted
            anchors.verticalCenter: parent.verticalCenter
            anchors.right: parent.right; anchors.rightMargin: root.sz(10)
            textFormat: Text.PlainText; text: "RESTORE"
            color: bRowMouse.containsMouse ? root.cPhosphor : root.cAsh
            font.family: "monospace"; font.pixelSize: root.fs(9)
        }
        MouseArea {
            id: bRowMouse
            anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
            onClicked: Qt.callLater(function () {
                if (bRow.deleted) root.restoreBoard(bRow.modelData.id)
                else root.selectBoard(bRow.modelData.id)
                boardMenu.close()
            })
        }
    }

    // ---- header ------------------------------------------------------------
    RowLayout {
        id: header
        anchors { top: parent.top; left: parent.left; right: parent.right
                  margins: root.sz(16) }
        height: root.sz(36)
        spacing: root.sz(12)

        // The board title IS the rename affordance: no right-click on a tablet.
        Rectangle {
            implicitWidth: titleRow.implicitWidth + root.sz(14); implicitHeight: root.sz(30)
            radius: root.sz(4)
            color: "transparent"; border.width: 1
            border.color: titleMouse.containsMouse ? root.cLine : "transparent"
            Row {
                id: titleRow
                anchors.centerIn: parent
                spacing: root.sz(6)
                SectionLabel { text: root.currentBoardTitle().toUpperCase(); font.pixelSize: root.fs(13) }
                Text { textFormat: Text.PlainText; text: "v"; visible: root.boards().length > 0
                       color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(9) }
            }
            MouseArea {
                id: titleMouse
                anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                onClicked: Qt.callLater(function () { boardMenu.open() })
            }
        }
        // A deleted board can be brought back: restore is just an event, so this is undo.
        // With one deleted board it names it; with more it counts, and the popup lists
        // them by name.
        Btn {
            readonly property var gone: root.deletedBoards()
            // exactly one: a quick undo, named. More than one: the popup lists them by
            // name, and a permanent counter in the header would just be furniture.
            visible: gone.length === 1
            // `visible: false` does NOT stop a binding from being evaluated, so this
            // read gone[0] on an empty list and threw every time the board list emptied
            // (Duet, 08/10: Main.qml:352 TypeError x2). Guard the index, not the row.
            label: "RESTORE \"" + (gone.length === 1 ? root.boardName(gone[0], "board") : "board") + "\""
            onClicked: Qt.callLater(function () { if (gone.length === 1) root.restoreBoard(gone[0].id) })
        }
        // the spacer that actually works (critique #1)
        Item { Layout.fillWidth: true }
        // identity as a chip, not a placeholder field (critique #4)
        Rectangle {
            implicitWidth: idRow.implicitWidth + root.sz(16); implicitHeight: root.sz(28)
            radius: height / 2
            color: "transparent"; border.width: 1
            border.color: idMouse.containsMouse ? root.cPhosphor : root.cLine
            Row {
                id: idRow
                anchors.centerIn: parent
                spacing: root.sz(6)
                Text { textFormat: Text.PlainText; text: "you:"; color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10) }
                Text { textFormat: Text.PlainText; text: root.meName === "" ? "set your name" : root.meName
                       color: root.meName === "" ? root.cAmber : root.cBone
                       font.family: "monospace"; font.pixelSize: root.fs(11) }
            }
            MouseArea { id: idMouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: Qt.callLater(function () { nameField.text = root.meName; nameDialog.open() }) }
        }
        // A list needs a board. With every board gone this must not offer to add one.
        Btn { label: "ADD LIST"; primary: true
              visible: root.boards().length > 0
              enabled: root.reachable
              onClicked: Qt.callLater(function () { newListField.text = ""; addListDialog.open() }) }
    }

    // ---- board / states ----------------------------------------------------
    // No side rail: a nested ColumnLayout holding a Layout.fillWidth child absorbs the
    // whole row, which squeezed this area to 10px on the Duet. The switcher lives in a
    // header popup instead, and the board gets the full width. (Measured, not guessed.)
    Flickable {
        id: boardFlick
        anchors { top: header.bottom; left: parent.left; right: parent.right; bottom: parent.bottom
                  topMargin: root.sz(12); leftMargin: root.sz(16); rightMargin: root.sz(16); bottomMargin: root.sz(16) }
        contentWidth: Math.max(width, columns.implicitWidth)
        contentHeight: height
        clip: true
        ScrollBar.horizontal: ScrollBar { policy: ScrollBar.AsNeeded }

        RowLayout {
            id: columns
            spacing: root.sz(12)
            Repeater {
                model: root.lists()
                delegate: Rectangle {
                    id: colBox
                    required property var modelData
                    readonly property var colCards: root.cardsOf(colBox.modelData.id)
                    Layout.alignment: Qt.AlignTop
                    Layout.preferredWidth: root.sz(280)
                    implicitHeight: col.implicitHeight + root.sz(20)
                    radius: root.sz(8)
                    color: root.cPanel
                    border.width: 1
                    border.color: root.cLine

                  ColumnLayout {
                    id: col
                    anchors { left: parent.left; right: parent.right; top: parent.top; margins: root.sz(10) }
                    spacing: root.sz(8)

                    // list header: real labels, real touch targets (critique #6)
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: root.sz(6)
                        Text { textFormat: Text.PlainText;
                            text: (colBox.modelData.title || "") + "  " + colBox.colCards.length
                            color: root.cBone
                            font.family: "monospace"; font.pixelSize: root.fs(12); font.letterSpacing: 1
                            Layout.fillWidth: true; elide: Text.ElideRight
                        }
                        Lnk { text: "del"; base: root.cAsh
                              onClicked: Qt.callLater(function () { listDeleteId = colBox.modelData.id; listDeleteName = colBox.modelData.title; delListDialog.open() }) }
                        Item { Layout.preferredWidth: root.sz(10) }
                    }

                    Repeater {
                        model: colBox.colCards
                        delegate: Rectangle {
                            id: cardRect
                            required property var modelData
                            Layout.fillWidth: true
                            implicitHeight: cardCol.implicitHeight + root.sz(16)
                            radius: root.sz(8)
                            color: cardMouse.containsMouse ? Qt.lighter(root.cPanel, 1.25) : root.cPanel
                            border.width: 1
                            border.color: root.cLine

                            ColumnLayout {
                                id: cardCol
                                anchors { left: parent.left; right: parent.right; top: parent.top; margins: root.sz(8) }
                                spacing: root.sz(3)
                                Text { textFormat: Text.PlainText;
                                    Layout.fillWidth: true
                                    text: cardRect.modelData.title || ""
                                    color: root.cBone; font.family: "monospace"; font.pixelSize: root.fs(12)
                                    wrapMode: Text.Wrap
                                }
                                Text { textFormat: Text.PlainText;
                                    visible: (cardRect.modelData.desc || "") !== ""
                                    Layout.fillWidth: true
                                    text: cardRect.modelData.desc || ""
                                    color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10)
                                    wrapMode: Text.Wrap; maximumLineCount: 3; elide: Text.ElideRight
                                }
                                RowLayout {
                                    Layout.fillWidth: true
                                    spacing: root.sz(4)
                                    Rectangle {
                                        visible: root.workerOf(cardRect.modelData) !== ""
                                        implicitWidth: whoText.implicitWidth + root.sz(10); implicitHeight: root.sz(16)
                                        radius: root.sz(4); color: Qt.rgba(0.87, 0.91, 0.97, 0.10)
                                        border.width: 1; border.color: root.cBone
                                        Text { textFormat: Text.PlainText; id: whoText; anchors.centerIn: parent
                                               text: root.workerOf(cardRect.modelData)
                                               color: root.cBone; font.family: "monospace"; font.pixelSize: root.fs(9) }
                                    }
                                    Rectangle {
                                        visible: root.taskLabel(cardRect.modelData) !== ""
                                        implicitWidth: stText.implicitWidth + root.sz(10); implicitHeight: root.sz(16)
                                        radius: root.sz(4); color: "transparent"; border.width: 1
                                        border.color: root.taskUnacked(cardRect.modelData) ? root.cAmber
                                                    : (root.taskState(cardRect.modelData) === "completed" ? root.cPhosphor : root.cAsh)
                                        Text { textFormat: Text.PlainText; id: stText; anchors.centerIn: parent
                                               text: root.taskLabel(cardRect.modelData)
                                               color: parent.border.color; font.family: "monospace"; font.pixelSize: root.fs(9) }
                                    }
                                    Repeater {
                                        model: cardRect.modelData.assignees || []
                                        delegate: Rectangle {
                                            implicitWidth: asg.implicitWidth + root.sz(10); implicitHeight: root.sz(16)
                                            radius: root.sz(4); color: Qt.rgba(0.21, 0.94, 0.63, 0.12)
                                            border.width: 1; border.color: root.cPhosphor
                                            Text { textFormat: Text.PlainText; id: asg; anchors.centerIn: parent; text: modelData
                                                   color: root.cPhosphor; font.family: "monospace"; font.pixelSize: root.fs(9) }
                                        }
                                    }
                                    Item { Layout.fillWidth: true }
                                    Text { textFormat: Text.PlainText;
                                        visible: !!cardRect.modelData.due
                                        text: cardRect.modelData.due ? root.dueLabel(cardRect.modelData.due) : ""
                                        color: root.cAmber; font.family: "monospace"; font.pixelSize: root.fs(9)
                                    }
                                }
                            }
                            MouseArea {
                                id: cardMouse
                                anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                // Qt.callLater: the click triggers a core call, which can rebuild this card
                                onClicked: Qt.callLater(root.openCard, cardRect.modelData)
                            }
                        }
                    }

                    Lnk { text: "+ add a card"; base: root.cAsh
                          onClicked: Qt.callLater(function () { newCardListId = colBox.modelData.id; newCardField.text = ""; addCardDialog.open() }) }
                  }
                }
            }

            // a ghost column: the next list, before it exists. Hidden when the
            // board is empty, where the centre block already offers the same thing.
            Rectangle {
                visible: root.lists().length > 0
                Layout.alignment: Qt.AlignTop
                Layout.preferredWidth: root.sz(280)
                Layout.preferredHeight: root.sz(64)
                color: "transparent"
                radius: root.sz(8)
                border.width: 1
                border.color: ghostMouse.containsMouse ? root.cPhosphor : root.cLine
                Text { textFormat: Text.PlainText; anchors.centerIn: parent; text: "+ add a list"
                       color: ghostMouse.containsMouse ? root.cPhosphor : root.cAsh
                       font.family: "monospace"; font.pixelSize: root.fs(11) }
                MouseArea { id: ghostMouse; anchors.fill: parent; hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: Qt.callLater(function () { newListField.text = ""; addListDialog.open() }) }
            }
        }
    }

    // connecting / unreachable / empty (critique #3: no more blank slab)
    ColumnLayout {
        anchors.centerIn: parent
        spacing: root.sz(8)
        width: Math.min(parent.width - root.sz(40), root.sz(420))
        visible: !root.firstLoadDone || !root.reachable || root.lists().length === 0

        SectionLabel { Layout.alignment: Qt.AlignHCenter
                       text: !root.firstLoadDone ? "CONNECTING"
                           : !root.reachable ? "NO CONNECTION"
                           : root.boards().length === 0 ? "NO BOARDS"
                           : "NO LISTS YET" }
        Text { textFormat: Text.PlainText;
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(11)
            text: !root.firstLoadDone
                  ? "Reading the board..."
                  : !root.reachable
                    ? "board_core is not answering. The board is still being read; nothing has been lost."
                    : root.boards().length === 0
                      ? "There is no board here yet. Create one, or bring a deleted one back with the button above."
                      : "This board is empty. Add a list to start - a list is a column, cards live in it."
        }
        Text { textFormat: Text.PlainText;
            visible: root.firstLoadDone && root.reachable
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            color: root.cAmber; font.family: "monospace"; font.pixelSize: root.fs(10)
            text: "Saved on this device - the board survives a restart."
        }
        Btn {
            Layout.alignment: Qt.AlignHCenter
            visible: root.firstLoadDone
            // With no live board a list cannot exist, so the honest action is to make a
            // board, not to add a list to one that is not there. (Duet, 08/10.)
            label: root.boards().length === 0 ? "NEW BOARD"
                 : root.reachable ? "ADD THE FIRST LIST" : "TRY AGAIN"
            primary: true
            onClicked: Qt.callLater(function () {
                if (root.boards().length === 0) { boardCreateDialog.open() }
                else if (root.reachable) { newListField.text = ""; addListDialog.open() }
                else { root.misses = 0; root.refresh() }
            })
        }
    }

    // ---- the board switcher: a popup, so it costs the board no width ----------
    Popup {
        id: boardMenu
        x: root.sz(24)
        y: header.y + header.height + root.sz(4)
        width: root.sz(300)
        padding: root.sz(10)
        modal: false
        focus: true
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
        background: Rectangle { color: root.cPanel; border.color: root.cLine; border.width: 1; radius: root.sz(12) }
        contentItem: ColumnLayout {
            spacing: root.sz(3)
            SectionLabel { text: "BOARDS" }
            Repeater { model: root.boards(); delegate: BoardRow {} }
            Rectangle {
                visible: root.boards().length === 0
                Layout.fillWidth: true; implicitHeight: root.sz(30)
                Text { anchors.verticalCenter: parent.verticalCenter; anchors.left: parent.left; anchors.leftMargin: root.sz(10)
                       textFormat: Text.PlainText; text: "no boards yet"
                       color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(11) }
            }
            SectionLabel { visible: root.deletedBoards().length > 0; text: "DELETED" }
            Repeater { model: root.deletedBoards(); delegate: BoardRow { deleted: true } }
            Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: root.cLine }
            RowLayout {
                Layout.fillWidth: true
                spacing: root.sz(10)
                Lnk { text: "+ NEW"; base: root.cPhosphor
                      onClicked: Qt.callLater(function () { boardMenu.close(); boardCreateDialog.open() }) }
                Lnk { text: "RENAME"; base: root.cBone; visible: root.boards().length > 0
                      onClicked: Qt.callLater(function () { boardMenu.close(); renameBoardDialog.open() }) }
                Lnk { text: "DELETE"; base: root.cRust; visible: root.boards().length > 0
                      onClicked: Qt.callLater(function () { boardMenu.close(); deleteBoardDialog.open() }) }
                Item { Layout.fillWidth: true }
            }
        }
    }

    // ---- board dialogs -----------------------------------------------------
    ShroomsDialog {
        id: boardCreateDialog
        function submit() {
            if (boardNameField.text.trim() === "") return
            root.act("createBoard", [root.newId(), boardNameField.text.trim()], "Board added", function () {
                var b = root.boards()
                if (b.length) root.selectBoard(b[b.length - 1].id)
            })
            boardCreateDialog.close()
        }
        onOpened: Qt.callLater(function () {
            Qt.callLater(function () { boardNameField.text = ""; boardNameField.focusField() })
        })
        title: "new board"
        width: Math.min(root.sz(460), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "NEW BOARD" }
            Text { textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap
                   color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10)
                   text: "Boards are separate spaces on the same instance. They share one log, so they sync together." }
            LabelledField { id: boardNameField; label: "BOARD NAME"; onAccepted: Qt.callLater(boardCreateDialog.submit) }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Lnk { text: "CANCEL"; base: root.cBone; onClicked: boardCreateDialog.close() }
                Btn { label: "CREATE"; primary: true; enabled: boardNameField.text.trim() !== ""
                      onClicked: Qt.callLater(boardCreateDialog.submit) }
            }
        }
    }

    ShroomsDialog {
        id: renameBoardDialog
        function submit() {
            if (renameField.text.trim() === "") return
            root.act("renameBoard", [root.currentBoard(), renameField.text.trim()], "Board renamed")
            renameBoardDialog.close()
        }
        onOpened: Qt.callLater(function () {
            Qt.callLater(function () { renameField.text = root.currentBoardRawTitle(); renameField.focusField() })
        })
        title: "board"
        width: Math.min(root.sz(460), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "RENAME BOARD" }
            LabelledField { id: renameField; label: "BOARD NAME"; onAccepted: Qt.callLater(renameBoardDialog.submit) }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Lnk { text: "CANCEL"; base: root.cBone; onClicked: renameBoardDialog.close() }
                Btn { label: "SAVE"; primary: true; enabled: renameField.text.trim() !== ""
                      onClicked: Qt.callLater(renameBoardDialog.submit) }
            }
        }
    }

    ShroomsDialog {
        id: deleteBoardDialog
        function submit() {
            root.act("deleteBoard", [root.currentBoard()], "Board deleted - restore it from the header", function () {
                // the remembered board must not point at the board just deleted
                var b = root.boards()
                root.currentBoardId = b.length ? b[0].id : ""
                root.setPref("last_board", root.currentBoardId)
            })
            deleteBoardDialog.close()
        }
        title: "delete board"
        width: Math.min(root.sz(460), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "DELETE \"" + root.currentBoardTitle() + "\"?" }
            Text { textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap
                   color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10)
                   text: "Its lists and cards are hidden, not destroyed - they come back if you restore the board. Nothing else is affected." }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Lnk { text: "CANCEL"; base: root.cBone; onClicked: deleteBoardDialog.close() }
                Btn { label: "DELETE"; primary: true; onClicked: Qt.callLater(deleteBoardDialog.submit) }
            }
        }
    }

    // ---- toast -------------------------------------------------------------
    Rectangle {
        visible: root.toastText !== ""
        anchors { bottom: parent.bottom; horizontalCenter: parent.horizontalCenter; bottomMargin: root.sz(20) }
        width: toastLabel.implicitWidth + root.sz(28); height: root.sz(34)
        radius: root.sz(8)
        color: root.toastIsError ? Qt.rgba(0.88, 0.32, 0.32, 0.18) : root.cPanel
        border.width: 1; border.color: root.toastIsError ? root.cRust : root.cLine
        Text { textFormat: Text.PlainText; id: toastLabel; anchors.centerIn: parent; text: root.toastText
               color: root.toastIsError ? root.cRust : root.cBone
               font.family: "monospace"; font.pixelSize: root.fs(11) }
    }

    // ---- dialogs: the Shrooms modal shape (critique #10) -------------------
    property string newCardListId: ""
    property string listDeleteId: ""
    property string listDeleteName: ""
    property var editing: ({})

    component ShroomsDialog: Dialog {
        modal: true
        focus: true
        anchors.centerIn: parent
        padding: root.sz(20)
        closePolicy: Popup.CloseOnEscape
        Overlay.modal: Rectangle { color: Qt.rgba(0, 0, 0, 0.6) }
        background: Rectangle { color: root.cPanel; radius: root.sz(12); border.width: 1; border.color: root.cPhosphor }
        header: Item {}
        footer: Item {}
    }

    component LabelledArea: ColumnLayout {
        property alias label: lab2.text
        property alias text: area.text
        function focusField() { area.forceActiveFocus() }
        spacing: root.sz(4)
        Text { textFormat: Text.PlainText; id: lab2; color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10); font.letterSpacing: 1 }
        TextArea {
            id: area
            Layout.fillWidth: true
            Layout.preferredHeight: root.sz(80)
            color: root.cBone
            placeholderTextColor: root.cAsh
            font.family: "monospace"; font.pixelSize: root.fs(12)
            wrapMode: TextArea.Wrap
            background: Rectangle {
                color: root.cVoid; radius: root.sz(6)
                border.width: 1
                border.color: area.activeFocus ? root.cPhosphor : root.cLine
            }
        }
    }

    component LabelledField: ColumnLayout {
        property alias label: lab.text
        property alias text: fld.text
        function focusField() { fld.forceActiveFocus() }
        signal accepted()
        spacing: root.sz(4)
        Text { textFormat: Text.PlainText; id: lab; color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10); font.letterSpacing: 1 }
        Field { id: fld; Layout.fillWidth: true; onAccepted: parent.accepted() }
    }

    ShroomsDialog {
        id: nameDialog
        function submit() {
            if (nameField.text.trim() === "") return
            root.meName = nameField.text.trim()
            root.setPref("me", root.meName)  // survives a restart, or ASSIGN ME is dead again
            nameDialog.close()
        }
        onOpened: Qt.callLater(function () {
            Qt.callLater(function () { nameField.focusField() })
        })
        title: "your name"
        width: Math.min(root.sz(420), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "YOUR NAME" }
            Text { textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap; color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10)
                   text: "Cards you assign are signed with this. It is not an account - it only names you on this board." }
            LabelledField { id: nameField; label: "NAME"; onAccepted: Qt.callLater(nameDialog.submit) }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Lnk { text: "CANCEL"; base: root.cBone; onClicked: nameDialog.close() }
                Btn { label: "SAVE"; primary: true; enabled: nameField.text.trim() !== ""
                      onClicked: Qt.callLater(nameDialog.submit) }
            }
        }
    }

    ShroomsDialog {
        id: addListDialog
        function submit() {
            if (newListField.text.trim() === "") return
            root.act("createList", [root.currentBoard(), root.newId(), newListField.text.trim()], "List added")
            addListDialog.close()
        }
        onOpened: Qt.callLater(function () {
            Qt.callLater(function () { newListField.focusField() })
        })
        title: "add list"
        width: Math.min(root.sz(460), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "NEW LIST" }
            LabelledField { id: newListField; label: "LIST NAME"; onAccepted: Qt.callLater(addListDialog.submit) }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Lnk { text: "CANCEL"; base: root.cBone; onClicked: addListDialog.close() }
                Btn { label: "ADD"; primary: true
                      enabled: newListField.text.trim() !== ""
                      onClicked: Qt.callLater(addListDialog.submit) }
            }
        }
    }

    ShroomsDialog {
        id: addCardDialog
        function submit() {
            if (newCardField.text.trim() === "") return
            root.act("createCard", [root.currentBoard(), root.newId(), root.newCardListId, newCardField.text.trim()], "Card added")
            addCardDialog.close()
        }
        onOpened: Qt.callLater(function () {
            Qt.callLater(function () { newCardField.focusField() })
        })
        title: "add card"
        width: Math.min(root.sz(460), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "NEW CARD" }
            LabelledField { id: newCardField; label: "TITLE"; onAccepted: Qt.callLater(addCardDialog.submit) }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Lnk { text: "CANCEL"; base: root.cBone; onClicked: addCardDialog.close() }
                Btn { label: "ADD"; primary: true
                      enabled: newCardField.text.trim() !== ""
                      onClicked: Qt.callLater(addCardDialog.submit) }
            }
        }
    }

    ShroomsDialog {
        id: delListDialog
        title: "delete list"
        width: Math.min(root.sz(460), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "DELETE LIST" }
            Text { textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap; color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(11)
                   text: "Delete \"" + root.listDeleteName + "\" and its " + root.cardsOf(root.listDeleteId).length + " card(s)?" }
            Text { textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap; color: root.cAmber; font.family: "monospace"; font.pixelSize: root.fs(10)
                   text: "Deleting is permanent on this board - the cards go with it." }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Lnk { text: "KEEP"; base: root.cBone; onClicked: delListDialog.close() }
                Btn { label: "DELETE"; danger: true
                      onClicked: Qt.callLater(function () { root.act("deleteList", [root.listDeleteId], "List deleted"); delListDialog.close() }) }
            }
        }
    }

    // card detail: labelled fields, explicit assign, "Move to" for touch (#11, #12)
    ShroomsDialog {
        id: editCardDialog
        function submit() {
            var f = {}
            if (editTitle.text !== (root.editing.title || "")) f.title = editTitle.text
            if (editDesc.text !== (root.editing.desc || "")) f.desc = editDesc.text
            // due: the engine and the card have always supported it; the dialog did not
            // offer it, so it was unreachable. Empty clears it (0 is falsy to the card).
            var dueTxt = editDue.text.trim()
            var dueWas = root.editing.due ? new Date(root.editing.due).toISOString().slice(0, 10) : ""
            if (dueTxt !== dueWas) {
                if (dueTxt === "") f.due = 0
                else {
                    var ms = Date.parse(dueTxt)
                    if (!isNaN(ms)) f.due = ms
                }
            }
            if (Object.keys(f).length > 0) root.act("editCard", [root.editing.id, JSON.stringify(f)], "Card saved")
            editCardDialog.close()
        }
        onOpened: Qt.callLater(function () {
            editDue.text = root.editing.due ? new Date(root.editing.due).toISOString().slice(0, 10) : ""
            Qt.callLater(function () { editTitle.focusField() })
        })
        title: "card"
        width: Math.min(root.sz(560), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "CARD" }
            LabelledField { id: editTitle; label: "TITLE"; onAccepted: Qt.callLater(editCardDialog.submit) }
            LabelledArea { id: editDesc; label: "DESCRIPTION" }
            LabelledField { id: editDue; label: "DUE (YYYY-MM-DD)"; onAccepted: Qt.callLater(editCardDialog.submit) }

            RowLayout {
                Layout.fillWidth: true
                spacing: root.sz(8)
                Text { textFormat: Text.PlainText; visible: (root.editing.assignees || []).length > 0
                       text: "ASSIGNED"; color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10); font.letterSpacing: 1 }
                Repeater {
                    model: root.editing.assignees || []
                    delegate: Rectangle {
                        implicitWidth: aText.implicitWidth + root.sz(12); implicitHeight: root.sz(20)
                        radius: root.sz(4); color: Qt.rgba(0.21, 0.94, 0.63, 0.12)
                        border.width: 1; border.color: root.cPhosphor
                        Text { textFormat: Text.PlainText; id: aText; anchors.centerIn: parent; text: modelData
                               color: root.cPhosphor; font.family: "monospace"; font.pixelSize: root.fs(10) }
                    }
                }
                Item { Layout.fillWidth: true }
            }

            RowLayout {
                Layout.fillWidth: true
                Text { textFormat: Text.PlainText; visible: root.lists().length > 1
                       text: "MOVE TO"; color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10); font.letterSpacing: 1 }
                Repeater {
                    model: root.lists().filter(function (l) { return l.id !== root.editing.list_id })
                    delegate: Btn {
                        label: modelData.title || "list"
                        onClicked: Qt.callLater(function () {
                            var cs = root.cardsOf(modelData.id)
                            var last = cs.length ? cs[cs.length - 1].pos : 0
                            root.act("editCard", [root.editing.id, JSON.stringify({ list_id: modelData.id, pos: (last || 0) + 1000 })], "Card moved")
                            editCardDialog.close()
                        })
                    }
                }
                Item { Layout.fillWidth: true }
            }

            // The link: the human half of the join (docs/task-bridge.md step 2). Set it by
            // hand for a task that already exists; the bridge then reflects its state. A
            // dispatch will set this for you (step 3) - this is the manual door.
            RowLayout {
                Layout.fillWidth: true
                spacing: root.sz(8)
                Text { textFormat: Text.PlainText; text: "LINK"; color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10); font.letterSpacing: 1 }
                Text {
                    textFormat: Text.PlainText
                    Layout.fillWidth: true
                    elide: Text.ElideMiddle
                    color: root.editing.task_ref ? root.cPhosphor : root.cAsh
                    font.family: "monospace"; font.pixelSize: root.fs(10)
                    text: root.editing.task_ref ? root.editing.task_ref : "no task linked"
                }
                Btn {
                    label: root.editing.task_ref ? "UNLINK" : "LINK TO TASK"
                    onClicked: Qt.callLater(function () {
                        if (root.editing.task_ref) {
                            root.act("editCard", [root.editing.id, JSON.stringify({ task_ref: null })], "Task unlinked")
                            editCardDialog.close()
                        } else {
                            // Do NOT touch linkField here: linkDialog has probably never
                            // been opened, and a Popup's contentItem is created LAZILY, so
                            // linkField does not exist yet and this would throw - leaving
                            // the dialog unopened and the tap doing nothing. Clearing the
                            // fields is the dialog's own job, in onOpened.
                            linkDialog.open()
                        }
                    })
                }
            }

            RowLayout {
                Layout.fillWidth: true
                Btn { label: (root.editing.assignees || []).indexOf(root.meName) >= 0 ? "UNASSIGN ME" : "ASSIGN ME"
                      enabled: root.meName !== ""
                      onClicked: Qt.callLater(function () {
                          var on = (root.editing.assignees || []).indexOf(root.meName) >= 0
                          root.act("assign", [root.editing.id, root.meName, on ? "false" : "true"], on ? "Unassigned" : "Assigned")
                          editCardDialog.close()
                      }) }
                Text { textFormat: Text.PlainText; visible: root.meName === ""; text: "set your name first (top right)"
                       color: root.cAmber; font.family: "monospace"; font.pixelSize: root.fs(10) }
                Item { Layout.fillWidth: true }
                Btn { label: "DELETE"; danger: true
                      onClicked: Qt.callLater(function () { root.delCardId = root.editing.id; root.delCardTitle = root.editing.title || ""; editCardDialog.close(); delCardDialog.open() }) }
                Item { Layout.preferredWidth: root.sz(16) }
                Btn { label: "SAVE"; primary: true
                      onClicked: Qt.callLater(editCardDialog.submit) }
            }
        }
    }

    ShroomsDialog {
        id: linkDialog
        // The shape everything else relies on: machine/session:messageId. Checked HERE, while
        // the human is looking at it, so a typo cannot silently become a card that reflects
        // nothing. Deliberately not a regex: an escaped slash inside a character class is a
        // needless way to get this wrong in a QML string.
        function validRef(s) {
            var i = s.indexOf('/')
            var j = s.indexOf(':', i + 1)
            return i > 0 && j > i + 1 && j < s.length - 1 && s.indexOf(' ') < 0
        }
        function submit() {
            var s = linkField.text.trim()
            if (!validRef(s)) { linkWarn.text = "expected machine/session:messageId"; return }
            root.act("editCard", [root.editing.id, JSON.stringify({ task_ref: s })], "Task linked")
            linkDialog.close()
        }
        onOpened: Qt.callLater(function () {
            Qt.callLater(function () {
                // Safe here: the contentItem exists once the dialog is open.
                linkField.text = ""
                linkWarn.text = ""
                linkField.focusField()
            })
        })
        title: "link a task"
        width: Math.min(root.sz(560), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "LINK TO A TASK" }
            Text { textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap
                   color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10)
                   text: "Paste a task reference as machine/session:messageId. The bridge copies the task's state onto this card as it changes. It never moves the card, and it never writes to the task." }
            LabelledField { id: linkField; label: "TASK REF"; onAccepted: Qt.callLater(linkDialog.submit) }
            Text { textFormat: Text.PlainText; id: linkWarn; Layout.fillWidth: true; wrapMode: Text.Wrap
                   color: root.cAmber; font.family: "monospace"; font.pixelSize: root.fs(10); text: "" }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Lnk { text: "CANCEL"; base: root.cBone; onClicked: linkDialog.close() }
                Btn { label: "LINK"; primary: true; enabled: linkField.text.trim() !== ""
                      onClicked: Qt.callLater(linkDialog.submit) }
            }
        }
    }

    property string delCardId: ""
    property string delCardTitle: ""

    ShroomsDialog {
        id: delCardDialog
        title: "delete card"
        width: Math.min(root.sz(460), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "DELETE CARD" }
            Text { textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap; color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(11)
                   text: "Delete \"" + root.delCardTitle + "\"?" }
            Text { textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap; color: root.cAmber; font.family: "monospace"; font.pixelSize: root.fs(10)
                   text: "Deleting is permanent on this board." }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Lnk { text: "KEEP"; base: root.cBone; onClicked: delCardDialog.close() }
                Btn { label: "DELETE"; danger: true
                      onClicked: Qt.callLater(function () { root.act("deleteCard", [root.delCardId], "Card deleted"); delCardDialog.close() }) }
            }
        }
    }

    function openCard(card) {
        root.editing = card
        editTitle.text = card.title || ""
        editDesc.text = card.desc || ""
        editCardDialog.open()
    }
    function dueLabel(ms) {
        try { return new Date(ms).toLocaleDateString() } catch (e) { return "" }
    }
}
