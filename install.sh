#!/usr/bin/env bash
# Install Three Finger Show Desktop GNOME Shell extension (user scope).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
# Read the UUID rather than repeating it: metadata.json is the only place it
# is authoritative, and a copy here silently installs to the wrong directory
# whenever the two drift.
UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${SRC}/metadata.json")"
[ -n "${UUID}" ] || { echo "no uuid in ${SRC}/metadata.json" >&2; exit 1; }
DEST="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

echo "Installing ${UUID}"

# Remove legacy local UUID from earlier development builds.
rm -rf "${HOME}/.local/share/gnome-shell/extensions/three-finger-show-desktop@local"

rm -rf "${DEST}"
mkdir -p "${DEST}"

cp "${SRC}/extension.js" "${SRC}/metadata.json" "${DEST}/"
# DEST is wiped above, so anything meant to ship has to be named here.
for f in COPYING LICENSE README.md stylesheet.css; do
  [ -f "${SRC}/${f}" ] && cp "${SRC}/${f}" "${DEST}/"
done

# The settings are useless without their compiled schema, and every tunable
# this extension has lives there.
if [ -d "${SRC}/schemas" ]; then
  mkdir -p "${DEST}/schemas"
  cp "${SRC}"/schemas/*.gschema.xml "${DEST}/schemas/"
  glib-compile-schemas "${DEST}/schemas"
fi

echo "Files copied to: ${DEST}"

if ! command -v gnome-extensions >/dev/null 2>&1; then
  echo "Install the gnome-extensions CLI to enable the extension from the terminal."
  exit 0
fi

if gnome-extensions list 2>/dev/null | grep -Fxq "${UUID}"; then
  gnome-extensions disable "${UUID}" 2>/dev/null || true
  gnome-extensions enable "${UUID}" 2>/dev/null || true
  echo ""
  gnome-extensions info "${UUID}" 2>/dev/null || true
  echo ""
  echo "If the extension does not load, log out and back in (Wayland), then run:"
  echo "  gnome-extensions enable ${UUID}"
else
  echo ""
  echo "Install completed. Log out and back in, then run:"
  echo "  gnome-extensions enable ${UUID}"
fi
