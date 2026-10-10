#!/bin/sh
# Stage fude-cli as the Tauri sidecar (`bundle.externalBin` in tauri.conf.json).
#
# tauri-build refuses to compile the `fude` crate at all while the sidecar file
# is missing, so this must run before `cargo test` / `cargo clippy` / `tauri
# build`, not just before bundling. The file name must carry the host triple.
set -e
cd "$(dirname "$0")/../src-tauri"
cargo build --release -p fude-cli
triple="$(rustc -vV | sed -n 's/^host: //p')"
mkdir -p binaries
case "$triple" in
  *windows*) cp target/release/fude-cli.exe "binaries/fude-cli-${triple}.exe" ;;
  *)         cp target/release/fude-cli     "binaries/fude-cli-${triple}" ;;
esac
echo "sidecar: binaries/fude-cli-${triple}"
