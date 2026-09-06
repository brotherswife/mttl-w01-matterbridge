#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != Darwin ]]; then
    echo "Run this script on macOS." >&2
    exit 1
fi
PYTHON="${PYTHON:-python3}"
"$PYTHON" -c 'import tkinter, nuitka'
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mttl-build.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT
for app in ota setup_wifi; do
    "$PYTHON" -m nuitka \
        --standalone --macos-create-app-bundle --enable-plugin=tk-inter \
        --macos-app-name="MTTL-W01 ${app}" \
        --macos-app-icon="icons/${app}.icns" \
        --include-data-files="icons/${app}.png=icons/${app}.png" \
        --output-dir="$BUILD_DIR" \
        --report="$BUILD_DIR/${app}-report.xml" \
        "${app}_gui.py"
done
for app in ota setup_wifi; do
    test -d "$BUILD_DIR/${app}_gui.app"
    /usr/bin/ditto -c -k --sequesterRsrc --keepParent \
        "$BUILD_DIR/${app}_gui.app" "$BUILD_DIR/${app}_gui_macos.zip"
    /usr/bin/unzip -tq "$BUILD_DIR/${app}_gui_macos.zip"
done
for app in ota setup_wifi; do
    mv -f "$BUILD_DIR/${app}_gui_macos.zip" ../
    rm -rf "../${app}_gui.app"
done
