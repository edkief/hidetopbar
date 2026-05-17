#!/bin/bash
set -euo pipefail

UUID="hidetopbar@kieffer.me"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
SRC="$(cd "$(dirname "$0")" && pwd)"

echo "Installing $UUID from $SRC to $DEST"

rm -rf "$DEST"
mkdir -p "$DEST"

cp "$SRC"/*.js "$SRC"/*.ui "$SRC"/metadata.json "$DEST"/

mkdir -p "$DEST/schemas"
cp "$SRC/schemas/"*.xml "$SRC/schemas/gschemas.compiled" "$DEST/schemas/"

if [ -d "$SRC/locale" ]; then
    cp -r "$SRC/locale" "$DEST/"
fi

echo "Installed to $DEST"
echo "Run: gnome-extensions enable $UUID"
