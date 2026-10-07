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
    readonly property real autoScale: Math.max(1.0, Math.min(1.45, root.width / 2000))
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
    function lists() { return root.state().lists || [] }
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

    // ---- header ------------------------------------------------------------
    RowLayout {
        id: header
        anchors { top: parent.top; left: parent.left; right: parent.right
                  margins: root.sz(16) }
        height: root.sz(36)
        spacing: root.sz(12)

        Text { textFormat: Text.PlainText;
            text: (root.state().board && root.state().board.title) ? root.state().board.title : "shrooms-board"
            color: root.cBone
            font.family: "monospace"; font.pixelSize: root.fs(15); font.letterSpacing: 0.5
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
                            text: (col.modelData.title || "") + "  " + colBox.colCards.length
                            color: root.cBone
                            font.family: "monospace"; font.pixelSize: root.fs(12); font.letterSpacing: 1
                            Layout.fillWidth: true; elide: Text.ElideRight
                        }
                        Lnk { text: "del"; base: root.cAsh
                              onClicked: Qt.callLater(function () { listDeleteId = colBox.modelData.id; listDeleteName = col.modelData.title; delListDialog.open() }) }
                        Lnk { text: "+"; base: root.cPhosphor
                              onClicked: Qt.callLater(function () { newCardListId = colBox.modelData.id; newCardField.text = ""; addCardDialog.open() }) }
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
        anchors.centerIn: parent
        padding: root.sz(20)
        closePolicy: Popup.CloseOnEscape
        Overlay.modal: Rectangle { color: Qt.rgba(0, 0, 0, 0.6) }
        background: Rectangle { color: root.cPanel; radius: root.sz(12); border.width: 1; border.color: root.cPhosphor }
        header: Item {}
        footer: Item {}
    }

    component LabelledField: ColumnLayout {
        property alias label: lab.text
        property alias text: fld.text
        spacing: root.sz(4)
        Text { textFormat: Text.PlainText; id: lab; color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10); font.letterSpacing: 1 }
        Field { id: fld; Layout.fillWidth: true }
    }

    ShroomsDialog {
        id: nameDialog
        title: "your name"
        width: Math.min(root.sz(420), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "YOUR NAME" }
            Text { textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap; color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10)
                   text: "Cards you assign are signed with this. It is not an account - it only names you on this board." }
            LabelledField { id: nameField; label: "NAME" }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Lnk { text: "CANCEL"; base: root.cBone; onClicked: nameDialog.close() }
                Btn { label: "SAVE"; primary: true; enabled: nameField.text.trim() !== ""
                      onClicked: Qt.callLater(function () { root.meName = nameField.text.trim(); nameDialog.close() }) }
            }
        }
    }

    ShroomsDialog {
        id: addListDialog
        title: "add list"
        width: Math.min(root.sz(460), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "NEW LIST" }
            LabelledField { id: newListField; label: "LIST NAME" }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Lnk { text: "CANCEL"; base: root.cBone; onClicked: addListDialog.close() }
                Btn { label: "ADD"; primary: true
                      enabled: newListField.text.trim() !== ""
                      onClicked: Qt.callLater(function () {
                          var ls = root.lists()
                          var last = ls.length ? ls[ls.length - 1].pos : 0
                          root.act("createList", [root.newId(), newListField.text.trim(), String((last || 0) + 1000)], "List added")
                          addListDialog.close()
                      }) }
            }
        }
    }

    ShroomsDialog {
        id: addCardDialog
        title: "add card"
        width: Math.min(root.sz(460), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "NEW CARD" }
            LabelledField { id: newCardField; label: "TITLE" }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Lnk { text: "CANCEL"; base: root.cBone; onClicked: addCardDialog.close() }
                Btn { label: "ADD"; primary: true
                      enabled: newCardField.text.trim() !== ""
                      onClicked: Qt.callLater(function () {
                          var cs = root.cardsOf(root.newCardListId)
                          var last = cs.length ? cs[cs.length - 1].pos : 0
                          root.act("createCard", [root.newId(), root.newCardListId, newCardField.text.trim(), String((last || 0) + 1000)], "Card added")
                          addCardDialog.close()
                      }) }
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
        title: "card"
        width: Math.min(root.sz(560), root.width - root.sz(40))
        contentItem: ColumnLayout {
            spacing: root.sz(12)
            SectionLabel { text: "CARD" }
            LabelledField { id: editTitle; label: "TITLE" }
            LabelledField { id: editDesc; label: "DESCRIPTION" }

            RowLayout {
                Layout.fillWidth: true
                spacing: root.sz(8)
                Text { textFormat: Text.PlainText; text: "ASSIGNED"; color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10); font.letterSpacing: 1 }
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
                Text { textFormat: Text.PlainText; text: "MOVE TO"; color: root.cAsh; font.family: "monospace"; font.pixelSize: root.fs(10); font.letterSpacing: 1 }
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
                      onClicked: Qt.callLater(function () { root.act("deleteCard", [root.editing.id], "Card deleted"); editCardDialog.close() }) }
                Btn { label: "SAVE"; primary: true
                      onClicked: Qt.callLater(function () {
                          var f = {}
                          if (editTitle.text !== (root.editing.title || "")) f.title = editTitle.text
                          if (editDesc.text !== (root.editing.desc || "")) f.desc = editDesc.text
                          if (Object.keys(f).length > 0) root.act("editCard", [root.editing.id, JSON.stringify(f)], "Card saved")
                          editCardDialog.close()
                      }) }
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
