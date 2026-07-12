#!/usr/bin/env bash
#
# Reproducible browser-WASM build for this cr-sqlite fork — MODERN toolchain.
#
# superfly/cr-sqlite (and upstream vlcn) ship only the native loadable
# extension; the browser/WASM build chain was removed. This script
# resurrects it using vlcn's wa-sqlite emscripten harness pointed at THIS
# fork's core, and builds with a *current, unpinned* toolchain.
#
# Output: wasm-build/dist/crsqlite.{wasm,mjs} — the artifacts the
# @vlcn.io/crsqlite-wasm JS wrapper loads.
#
# WHY THIS IS UNPINNED (unlike the original vlcn build):
#   The original linked the Rust core as LLVM *bitcode* (--emit=llvm-bc),
#   which forced rustc and emscripten to share an LLVM major version — a
#   brittle pin (nightly-2023-10-05 + emsdk 3.1.45). We instead build the
#   core as a normal wasm STATIC ARCHIVE (crate-type=staticlib, real wasm
#   objects). Wasm objects link across LLVM versions, so ANY current rust
#   nightly + ANY current emscripten works. Drops cross-language LTO (a
#   negligible size/perf cost here).
#
# Requirements:
#   * a recent rust nightly (no_std + custom lang items need nightly; NOT
#     build-std). We override the repo's 2023 toolchain pin below.
#   * emscripten via emsdk (latest is fine — tested with 6.0.0).
#
# Source patches this build needs (all carried/applied here):
#   * core/rs/bundle/src/lib.rs: `use core::alloc::Layout;` (committed in
#     this fork — the wasm-only alloc-error handler referenced it).
#   * sqlite-rs-embedded submodule (vlcn's), applied at build time below:
#       - drop `#![feature(concat_idents)]`  (removed from rustc; unused)
#       - drop `#![feature(error_in_core)]`   (stabilised in Rust 1.81)
#
# emscripten-6 compat (baked into harness-overrides/Makefile + the json):
#   * export HEAP views in EXPORTED_RUNTIME_METHODS (no longer automatic)
#   * -s WASM_BIGINT=0 (the 0.22 wrapper expects the legacy i64 ABI)
set -euo pipefail

CORE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-/tmp/crsqlite-wasm-build}"
HERE="$CORE_DIR/wasm-build"

# 1. Toolchain -------------------------------------------------------------
: "${RUSTUP_TOOLCHAIN:=nightly}"          # override the repo's 2023 pin
export RUSTUP_TOOLCHAIN
rustup target add wasm32-unknown-emscripten --toolchain "$RUSTUP_TOOLCHAIN"

if [ ! -d "$WORK/emsdk" ]; then
  git clone https://github.com/emscripten-core/emsdk.git "$WORK/emsdk"
fi
( cd "$WORK/emsdk" && ./emsdk install latest && ./emsdk activate latest )
# shellcheck disable=SC1091
source "$WORK/emsdk/emsdk_env.sh"

# 2. Patch the (vlcn) submodule for modern rustc ---------------------------
SRE="$CORE_DIR/core/rs/sqlite-rs-embedded"
perl -0pi -e 's/^#!\[feature\(concat_idents\)\]\n//m' "$SRE/sqlite3_capi/src/lib.rs"
perl -0pi -e 's/^#!\[feature\(error_in_core\)\]\n//m'  "$SRE/sqlite_nostd/src/lib.rs"

# 3. Harness: vlcn's wa-sqlite, with our modern overrides -------------------
if [ ! -d "$WORK/wa-sqlite" ]; then
  git clone --depth 1 https://github.com/vlcn-io/wa-sqlite.git "$WORK/wa-sqlite"
fi
cd "$WORK/wa-sqlite"
ln -sfn "$CORE_DIR/core" crsql
cp "$HERE/harness-overrides/Makefile" Makefile
cp "$HERE/harness-overrides/extra_exported_runtime_methods.json" src/extra_exported_runtime_methods.json

# 4. Build -----------------------------------------------------------------
export CRSQLITE_COMMIT_SHA="$(git -C "$CORE_DIR" rev-parse HEAD)"
rm -rf tmp dist

# Pre-generate the amalgamated SQLite sources BEFORE `make dist`. The Makefile's
# `deps` target is an empty .PHONY (inherited from vlcn), so it does not actually
# build deps/$SQLITE_VERSION/sqlite3-extra.c or deps/extension-functions.c. Those
# are prerequisites of the dist objects only via vpath, which requires the files to
# already exist on disk when the object graph is evaluated — otherwise `make dist`
# aborts with "No rule to make target tmp/obj/dist/sqlite3-extra.o". Generating them
# in a prior make invocation puts them where vpath can find them.
make crsqlite-extra                 # -> deps/$SQLITE_VERSION/{sqlite3.c,sqlite3-extra.c}
make deps/extension-functions.c     # -> deps/extension-functions.c (fetched + sha-checked)

make dist

mkdir -p "$HERE/dist"
cp dist/crsqlite.wasm dist/crsqlite.mjs "$HERE/dist/"
echo "==> built: $HERE/dist/crsqlite.{wasm,mjs}"
