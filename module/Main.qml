// shrooms-board — the Basecamp view. Pure QML, no C++ backend (logos-basecamp-module:
// a ui_qml module with a C++ backend depending on a custom core is the combination
// that silently fails to open). All logic lives in board_core; this file only calls
// actions and renders the JSON they return.
import QtQuick
import QtQuick.Controls
import Logos.Theme
import Logos.Controls

Item {
    id: root
    width: 1200
    height: 800

    property string stateJson: ""
    property string meName: ""
    property string toastText: ""
    property bool toastIsError: false
    property int callTimeoutMs: 20000

    // ---- the ONE way the view talks to a module -----------------------------
    function callVia(mod, method, args, cb) {
        var a = args || []
        var done = function (raw) {
            if (cb) {
                try { cb(raw === undefined || raw === null ? "" : raw) }
                catch (e) { console.warn("board: callback threw: " + e) }
            }
        }
        if (typeof logos === "undefined" || logos === null) { Qt.callLater(function () { done("") }); return }
        if (typeof logos.callModuleAsync === "function") {
            try { logos.callModuleAsync(mod, method, a, done, root.callTimeoutMs) }
            catch (e) { Qt.callLater(function () { done("") }) }
            return
        }
        // host without the async API: defer so at least the frame paints
        Qt.callLater(function () {
            var r = ""
            try { r = logos.callModule(mod, method, a) } catch (e) { r = "" }
            done(r)
        })
    }
    function core(method, args, cb) { root.callVia("board_core", method, args, cb) }
    function unq(raw) { return String(raw === undefined || raw === null ? "" : raw).replace(/^"|"$/g, "") }
    // the bridge may hand back raw JSON, a quoted string, or a doubly-encoded one
    function asState(raw) {
        var s = String(raw === undefined || raw === null ? "" : raw).trim()
        for (var i = 0; i < 2 && s.charAt(0) === '"'; i++) {
            try { s = String(JSON.parse(s)).trim() } catch (e) { return null }
        }
        if (s.charAt(0) !== "{") return null
        var o
        try { o = JSON.parse(s) } catch (e) { return null }
        return (o && o.error === undefined) ? s : null
    }
    function state() { try { return JSON.parse(root.stateJson) } catch (e) { return ({}) } }

    // ---- read state: poll snapshot(), single-flight ------------------------
    property bool refreshBusy: false
    property bool refreshAgain: false
    property int missed: 0
    function refresh() {
        if (root.refreshBusy) { root.refreshAgain = true; return }
        root.refreshBusy = true
        root.core("snapshot", [], function (raw) {
            var b = root.asState(raw)
            if (b) {
                root.missed = 0
                var nu = root.countEvents(b)
                // never blank a populated view with an empty answer (multi-instance guard)
                if (!(nu === 0 && root.countEvents(root.stateJson) > 0)) root.stateJson = b
            } else {
                root.missed += 1
                if (root.missed === 5) root.toast("Cannot reach board_core - is the module loaded?", true)
            }
            root.refreshBusy = false
            if (root.refreshAgain) { root.refreshAgain = false; root.refresh() }
        })
    }
    function countEvents(jsonText) {
        try {
            var o = JSON.parse(jsonText)
            return (o.lists ? o.lists.length : 0) + (o.cards ? o.cards.length : 0)
        } catch (e) { return 0 }
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
            var b = root.asState(payload)
            if (b) root.stateJson = b
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
                if (okMsg) root.toast(okMsg, false)
                if (onOk) onOk()
            } else {
                var o = null
                try { o = JSON.parse(String(raw)) } catch (e) { o = null }
                var why = (o && o.error) ? o.error : "Request failed - is board_core loaded?"
                root.toast(why, true)
            }
        })
    }
    function newId() {
        // uuid-shaped, from Math.random: the core treats it as an opaque key
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8)
            return v.toString(16)
        })
    }

    Rectangle { anchors.fill: parent; color: Theme.palette.background }

    // ---- header ------------------------------------------------------------
    Row {
        id: header
        anchors { top: parent.top; left: parent.left; right: parent.right; margins: Theme.spacing.large }
        height: 40
        spacing: Theme.spacing.medium

        LogosText { textFormat: Text.PlainText;
            anchors.verticalCenter: parent.verticalCenter
            text: root.state().board && root.state().board.title ? root.state().board.title : "shrooms-board"
            font.pixelSize: Theme.typography.titleSize ? Theme.typography.titleSize : 20
            font.bold: true
            color: Theme.palette.text
        }
        Item { width: 1; height: 1 }

        AppField {
            id: meField
            width: 160
            anchors.verticalCenter: parent.verticalCenter
            placeholderText: "your name"
            text: root.meName
            onEditingFinished: root.meName = text
        }
        LogosButton {
            anchors.verticalCenter: parent.verticalCenter
            text: "Add list"
            onClicked: addListDialog.open()
        }
    }

    // ---- board -------------------------------------------------------------
    Flickable {
        id: boardFlick
        anchors { top: header.bottom; left: parent.left; right: parent.right; bottom: parent.bottom
                  topMargin: Theme.spacing.medium; leftMargin: Theme.spacing.large
                  rightMargin: Theme.spacing.large; bottomMargin: Theme.spacing.large }
        contentWidth: columnsRow.width
        contentHeight: height
        clip: true

        Row {
            id: columnsRow
            spacing: Theme.spacing.medium
            Repeater {
                model: root.state().lists ? root.state().lists : []
                delegate: Column {
                    width: 260
                    spacing: Theme.spacing.small
                    property var listData: modelData
                    property var cardsOf: root.cardsFor(listData.id)

                    Rectangle {
                        width: parent.width
                        height: 32
                        color: Theme.palette.surfaceRaised
                        radius: Theme.spacing.radiusSmall
                        LogosText { textFormat: Text.PlainText;
                            anchors { left: parent.left; verticalCenter: parent.verticalCenter; leftMargin: Theme.spacing.small }
                            text: listData.title ? listData.title : ""
                            color: Theme.palette.text
                            font.bold: true
                        }
                        Row {
                            anchors { right: parent.right; verticalCenter: parent.verticalCenter; rightMargin: Theme.spacing.tiny }
                            spacing: Theme.spacing.tiny
                            LogosButton {
                                text: "+"
                                onClicked: { addCardListId = listData.id; addCardDialog.open() }
                            }
                            LogosButton {
                                text: "x"
                                onClicked: root.act("deleteList", [listData.id], "List deleted")
                            }
                        }
                    }

                    Repeater {
                        model: parent.cardsOf
                        delegate: Rectangle {
                            id: cardRect
                            width: parent.width
                            height: cardColumn.height + Theme.spacing.small * 2
                            color: Theme.palette.surface
                            radius: Theme.spacing.radiusSmall
                            border.width: 1
                            border.color: Theme.palette.borderHairline
                            property var cardData: modelData

                            Column {
                                id: cardColumn
                                anchors { left: parent.left; right: parent.right; top: parent.top; margins: Theme.spacing.small }
                                spacing: Theme.spacing.tiny
                                LogosText { textFormat: Text.PlainText;
                                    width: parent.width
                                    text: cardRect.cardData.title ? cardRect.cardData.title : ""
                                    color: Theme.palette.text
                                    wrapMode: Text.Wrap
                                }
                                LogosText { textFormat: Text.PlainText;
                                    width: parent.width
                                    visible: cardRect.cardData.desc !== undefined && cardRect.cardData.desc !== ""
                                    text: cardRect.cardData.desc ? cardRect.cardData.desc : ""
                                    color: Theme.palette.textTertiary
                                    wrapMode: Text.Wrap
                                    font.pixelSize: Theme.typography.smallSize ? Theme.typography.smallSize : 12
                                }
                                Row {
                                    spacing: Theme.spacing.tiny
                                    Repeater {
                                        model: cardRect.cardData.assignees ? cardRect.cardData.assignees : []
                                        delegate: Rectangle {
                                            height: 18
                                            width: badgeText.width + Theme.spacing.small
                                            color: Theme.palette.surfaceRaised
                                            radius: Theme.spacing.radiusSmall
                                            LogosText { textFormat: Text.PlainText;
                                                id: badgeText
                                                anchors.centerIn: parent
                                                text: modelData
                                                color: Theme.palette.primary
                                                font.pixelSize: 10
                                            }
                                        }
                                    }
                                }
                            }

                            MouseArea {
                                anchors.fill: parent
                                onClicked: { editCardData = cardRect.cardData; editCardDialog.open() }
                                drag.target: cardDrag
                                onPressAndHold: cardDrag.visible = true
                            }
                            Item {
                                id: cardDrag
                                visible: false
                                width: cardRect.width
                                height: cardRect.height
                                Drag.active: cardRect.MouseArea.pressed
                                Drag.mimeData: ({ "cardId": cardRect.cardData.id })
                                Drag.hotSpot.x: width / 2
                                Drag.hotSpot.y: height / 2
                                Rectangle {
                                    anchors.fill: parent
                                    color: Theme.palette.surfaceRaised
                                    radius: Theme.spacing.radiusSmall
                                    opacity: 0.9
                                    LogosText { textFormat: Text.PlainText; anchors.centerIn: parent; text: cardRect.cardData.title ? cardRect.cardData.title : ""; color: Theme.palette.text }
                                }
                            }
                        }
                    }

                    DropArea {
                        width: parent.width
                        height: 40
                        onDropped: function (drop) {
                            if (!drop.hasOwnProperty("cardId")) return
                            var cards = parent.cardsOf
                            var last = cards.length ? cards[cards.length - 1].pos : 0
                            root.act("editCard", [drop.cardId, JSON.stringify({ list_id: parent.listData.id, pos: (last ? last : 0) + 1000 })], "Card moved")
                        }
                        Rectangle {
                            anchors.fill: parent
                            color: "transparent"
                            border.width: parent.containsDrag ? 1 : 0
                            border.color: Theme.palette.primary
                            radius: Theme.spacing.radiusSmall
                        }
                    }
                }
            }
        }
    }

    // ---- toast -------------------------------------------------------------
    Rectangle {
        visible: root.toastText !== ""
        anchors { bottom: parent.bottom; horizontalCenter: parent.horizontalCenter; bottomMargin: Theme.spacing.large }
        width: toastLabel.width + Theme.spacing.large * 2
        height: toastLabel.height + Theme.spacing.medium * 2
        radius: Theme.spacing.radiusSmall
        color: root.toastIsError ? Theme.palette.warning : Theme.palette.surfaceRaised
        LogosText { textFormat: Text.PlainText;
            id: toastLabel
            anchors.centerIn: parent
            text: root.toastText
            color: root.toastIsError ? Theme.palette.background : Theme.palette.text
        }
    }

    // ---- dialogs -----------------------------------------------------------
    property string addCardListId: ""
    property var editCardData: ({})

    Dialog {
        id: addListDialog
        title: "New list"
        modal: true
        anchors.centerIn: parent
        standardButtons: Dialog.Ok | Dialog.Cancel
        contentItem: AppField { id: newListTitle; placeholderText: "List name" }
        onAccepted: {
            if (newListTitle.text.length > 0) {
                var lists = root.state().lists ? root.state().lists : []
                var last = lists.length ? lists[lists.length - 1].pos : 0
                root.act("createList", [root.newId(), newListTitle.text, String((last ? last : 0) + 1000)], "List added")
            }
            newListTitle.text = ""
        }
    }

    Dialog {
        id: addCardDialog
        title: "New card"
        modal: true
        anchors.centerIn: parent
        standardButtons: Dialog.Ok | Dialog.Cancel
        contentItem: AppField { id: newCardTitle; placeholderText: "Card title" }
        onAccepted: {
            if (newCardTitle.text.length > 0) {
                var cards = root.cardsFor(root.addCardListId)
                var last = cards.length ? cards[cards.length - 1].pos : 0
                root.act("createCard", [root.newId(), root.addCardListId, newCardTitle.text, String((last ? last : 0) + 1000)], "Card added")
            }
            newCardTitle.text = ""
        }
    }

    Dialog {
        id: editCardDialog
        title: "Card"
        modal: true
        anchors.centerIn: parent
        standardButtons: Dialog.Save | Dialog.Cancel
        contentItem: Column {
            spacing: Theme.spacing.small
            AppField { id: editTitle; placeholderText: "Title"; text: root.editCardData.title ? root.editCardData.title : "" }
            AppField { id: editDesc; placeholderText: "Description"; text: root.editCardData.desc ? root.editCardData.desc : "" }
            Row {
                spacing: Theme.spacing.small
                LogosButton {
                    text: root.isAssigned(root.meName) ? "Unassign me" : "Assign me"
                    onClicked: {
                        if (root.meName.length === 0) { root.toast("Set your name first (top right)", true); return }
                        root.act("assign", [root.editCardData.id, root.meName, root.isAssigned(root.meName) ? "false" : "true"], "Assignment updated")
                    }
                }
                LogosButton {
                    text: "Delete card"
                    onClicked: { root.act("deleteCard", [root.editCardData.id], "Card deleted"); editCardDialog.close() }
                }
            }
        }
        onAccepted: {
            var fields = {}
            if (editTitle.text !== (root.editCardData.title ? root.editCardData.title : "")) fields.title = editTitle.text
            if (editDesc.text !== (root.editCardData.desc ? root.editCardData.desc : "")) fields.desc = editDesc.text
            if (Object.keys(fields).length > 0) root.act("editCard", [root.editCardData.id, JSON.stringify(fields)], "Card saved")
        }
    }

    // ---- helpers -----------------------------------------------------------
    function cardsFor(listId) {
        var s = root.state()
        if (!s.cards) return []
        var out = []
        for (var i = 0; i < s.cards.length; i++) if (s.cards[i].list_id === listId) out.push(s.cards[i])
        return out
    }
    function isAssigned(name) {
        if (!root.editCardData || !root.editCardData.assignees) return false
        return root.editCardData.assignees.indexOf(name) >= 0
    }

    // version-safe themed text field (older hosts lack newer Logos* components)
    component AppField: TextField {
        color: Theme.palette.text
        placeholderTextColor: Theme.palette.textTertiary
        background: Rectangle {
            color: Theme.palette.surface
            radius: Theme.spacing.radiusSmall
            border.width: 1
            border.color: Theme.palette.borderHairline
        }
    }
}
