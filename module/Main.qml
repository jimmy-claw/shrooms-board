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
    function boards() { return root.state().boards || [] }
    function currentBoard() {
        var b = root.boards()
        if (b.length === 0) return "default"
        for (var i = 0; i < b.length; i++) if (b[i].id === root.currentBoardId) return b[i].id
        return b[0].id
    }
    function currentBoardTitle() {
        var b = root.boards(); var id = root.currentBoard()
        for (var i = 0; i < b.length; i++) if (b[i].id === id) return b[i].title || "(untitled)"
        var t = root.state().board && root.state().board.title
        return t || "shrooms-board"
    }
    // A deleted board is hidden by the fold but still known by id, which is what makes
    // restore (undo) possible without any extra state.
    function deletedBoards() {
        var all = (root.state()._allIds && root.state()._allIds.boards) || []
        var live = root.boards(); var out = []
        for (var i = 0; i < all.length; i++) {
            var found = false
            for (var j = 0; j < live.length; j++) if (live[j].id === all[i]) { found = true; break }
            if (!found) out.push(all[i])
        }
        return out
    }
    function selectBoard(id) {
        root.currentBoardId = id
        // remembered locally, NOT as an event: which board I was looking at is not
        // board data, and a peer has no business seeing it
        root.core("setLastBoard", [id], function () { })
        root.refresh()
    }
    function restoreLastBoard() {
        if (root.currentBoardId !== "") return
        root.core("lastBoard", [], function (raw) {
            var b = root.asState(raw)
            if (!b) return
            var o = null
            try { o = JSON.parse(b) } catch (e) { o = null }
            if (o && typeof o.board === "string" && o.board !== "") root.currentBoardId = o.board
        })
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
        root.restoreLastBoard()
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
            if (b) { root.stateJson = b; if (okMsg) root.toast(okMsg, false); if (onOk) onOk() }
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
        readonly property bool current: bRow.modelData.id === root.currentBoard()
        Layout.fillWidth: true
        implicitHeight: root.sz(34)
        radius: root.sz(4)
        color: bRow.current ? root.cVoid : "transparent"
        border.width: 1
        border.color: bRow.current ? root.cPhosphor : "transparent"
        Text {
            anchors.verticalCenter: parent.verticalCenter
            anchors.left: parent.left; anchors.leftMargin: root.sz(10)
            textFormat: Text.PlainText
            text: (bRow.current ? "> " : "  ") + (bRow.modelData.title || "(untitled)")
            color: bRow.current ? root.cBone : root.cAsh
            font.family: "monospace"; font.pixelSize: root.fs(11)
        }
        MouseArea {
            anchors.fill: parent; cursorShape: Qt.PointingHandCursor
            onClicked: Qt.callLater(function () { root.selectBoard(bRow.modelData.id); boardMenu.close() })
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
        Btn {
            visible: root.deletedBoards().length > 0
            label: "RESTORE BOARD (" + root.deletedBoards().length + ")"
            onClicked: Qt.callLater(function () { root.act("restoreBoard", [root.deletedBoards()[0]], "Board restored") })
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
        Btn { label: "ADD LIST"; primary: true; enabled: root.reachable
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
            label: root.reachable ? "ADD THE FIRST LIST" : "TRY AGAIN"
            primary: true
            onClicked: Qt.callLater(function () {
                if (root.reachable) { newListField.text = ""; addListDialog.open() } else { root.misses = 0; root.refresh() }
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
            spacing: root.sz(4)
            SectionLabel { text: "BOARDS" }
            Repeater { model: root.boards(); delegate: BoardRow {} }
            Rectangle {
                visible: root.boards().length === 0
                Layout.fillWidth: true; implicitHeight: root.sz(30)
                Text { anchors.verticalCenter: parent.verticalCenter; anchors.left: parent.left; anchors.leftMargin: root.sz(10)
                       textFormat: Text.PlainText; text: "no boards yet"
                       color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(11) }
            }
            Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: root.cLine }
            RowLayout {
                Layout.fillWidth: true
                spacing: root.sz(10)
                Lnk { text: "+ NEW BOARD"; base: root.cPhosphor
                      onClicked: Qt.callLater(function () { boardMenu.close(); boardCreateDialog.open() }) }
                Item { Layout.fillWidth: true }
                Lnk { text: "RENAME"; base: root.cBone; visible: root.boards().length > 0
                      onClicked: Qt.callLater(function () { boardMenu.close(); renameBoardDialog.open() }) }
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
            Qt.callLater(function () { renameField.text = root.currentBoardTitle(); renameField.focusField() })
        })
        title: "board"
        width: Math.min(root.sz(460), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "RENAME BOARD" }
            LabelledField { id: renameField; label: "BOARD NAME"; onAccepted: Qt.callLater(renameBoardDialog.submit) }
            RowLayout {
                Layout.fillWidth: true
                Lnk { text: "DELETE"; base: root.cRust
                      onClicked: Qt.callLater(function () { renameBoardDialog.close(); deleteBoardDialog.open() }) }
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
            root.act("deleteBoard", [root.currentBoard()], "Board deleted - restore it from the header")
            deleteBoardDialog.close()
        }
        title: "delete board"
        width: Math.min(root.sz(460), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "DELETE THIS BOARD?" }
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
            if (Object.keys(f).length > 0) root.act("editCard", [root.editing.id, JSON.stringify(f)], "Card saved")
            editCardDialog.close()
        }
        onOpened: Qt.callLater(function () {
            Qt.callLater(function () { editTitle.focusField() })
        })
        title: "card"
        width: Math.min(root.sz(560), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "CARD" }
            LabelledField { id: editTitle; label: "TITLE"; onAccepted: Qt.callLater(editCardDialog.submit) }
            LabelledArea { id: editDesc; label: "DESCRIPTION" }

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
