#!/usr/bin/env bash
#
# Browser-WASM build of this cr-sqlite fork against rhashimoto/wa-sqlite v1.x
# (upstream), producing the SYNC target `wa-sqlite.mjs` + `wa-sqlite.wasm`.
#
# Companion to build.sh (which targets the older vlcn-io/wa-sqlite 0.22 harness).
# This one uses the current upstream harness: SQLite 3.53, the FacadeVFS/libadapters
# VFS base, and (for us) the no-Asyncify sync build that pairs with OPFSCoopSyncVFS.
#
# Same modern, unpinned toolchain approach as build.sh: Rust core as a wasm static
# archive (crate-type=staticlib), any current rust nightly + any current emscripten.
set -euo pipefail

CORE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-/tmp/crsqlite-wasm-build-v1}"
HERE="$CORE_DIR/wasm-build"
# Reuse build.sh's emsdk if present, else install into WORK.
EMSDK_DIR="${EMSDK_DIR:-/tmp/crsqlite-wasm-build/emsdk}"

mkdir -p "$WORK"

# 1. Toolchain -------------------------------------------------------------
: "${RUSTUP_TOOLCHAIN:=nightly}"
export RUSTUP_TOOLCHAIN
rustup target add wasm32-unknown-emscripten --toolchain "$RUSTUP_TOOLCHAIN"

if [ ! -d "$EMSDK_DIR" ]; then
  EMSDK_DIR="$WORK/emsdk"
  [ -d "$EMSDK_DIR" ] || git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
  ( cd "$EMSDK_DIR" && ./emsdk install latest && ./emsdk activate latest )
fi
# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh"

# 2. Harness: rhashimoto's wa-sqlite v1.x, with our overrides ---------------
if [ ! -d "$WORK/wa-sqlite" ]; then
  git clone --depth 1 https://github.com/rhashimoto/wa-sqlite.git "$WORK/wa-sqlite"
fi
cd "$WORK/wa-sqlite"
ln -sfn "$CORE_DIR/core" crsql
cp "$HERE/harness-overrides-v1/Makefile" Makefile

# 3. Build -----------------------------------------------------------------
export CRSQLITE_COMMIT_SHA="$(git -C "$CORE_DIR" rev-parse HEAD)"
rm -rf tmp dist

# Pre-generate the amalgamated sources before the link (see build.sh for the why:
# vpath needs the generated .c on disk when the object graph is evaluated).
make crsqlite-extra
make deps/extension-functions.c

make dist

mkdir -p "$HERE/dist-v1"
cp dist/wa-sqlite.mjs dist/wa-sqlite.wasm "$HERE/dist-v1/"
echo "==> built: $HERE/dist-v1/wa-sqlite.{mjs,wasm}"
