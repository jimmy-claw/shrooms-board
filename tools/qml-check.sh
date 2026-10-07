#!/bin/bash
# Load a view's QML in a real QML engine and fail on any error.
#
# The reason this exists: a view was once shipped with `property alias field: fld`
# plus `field: nameField` (an alias is read-only). The plain-text linter passed and
# the view silently refused to load in Basecamp - only a human looking at the
# device caught it. qml-plaintext.py checks text rendering, not compilation.
#
# Usage: tools/qml-check.sh module/Main.qml
set -uo pipefail
QML_FILE="${1:?usage: qml-check.sh <file.qml>}"
QML_BIN="$(command -v qml || echo /usr/lib64/qt6/bin/qml)"
[ -x "$QML_BIN" ] || { echo "qml runtime not found (install qt6-declarative-dev-tools)"; exit 2; }
DISP=":98"
pgrep -f "Xvfb $DISP" >/dev/null || { Xvfb "$DISP" -screen 0 1600x1000x24 >/dev/null 2>&1 & sleep 2; }
out=$(DISPLAY="$DISP" QT_QUICK_BACKEND=software LIBGL_ALWAYS_SOFTWARE=1 \
      timeout 15 "$QML_BIN" "$QML_FILE" 2>&1 | head -30)
if [ -n "$out" ]; then
  echo "QML CHECK FAILED for $QML_FILE:"
  printf '%s\n' "$out"
  exit 1
fi
echo "QML check passed: $QML_FILE loads with no errors"
