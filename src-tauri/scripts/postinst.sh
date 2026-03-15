#!/bin/sh
# Post-install: create fude-browser and fude-remote symlinks
chmod +x /usr/lib/Fude/browser/fude-browser 2>/dev/null || true
ln -sf /usr/lib/Fude/browser/fude-browser /usr/bin/fude-browser
chmod +x /usr/lib/Fude/browser/fude-remote 2>/dev/null || true
ln -sf /usr/lib/Fude/browser/fude-remote /usr/bin/fude-remote
