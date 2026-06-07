#!/usr/bin/env bash
#
# Reproducible browser-WASM build for this cr-sqlite fork.
#
# superfly/cr-sqlite (and upstream vlcn) ship only the *native* loadable
# extension; the browser/WASM build chain (the old js/ tree) was removed.
# This script resurrects it by reusing vlcn's frozen wa-sqlite emscripten
# harness and pointing it at *this* fork's (newer, bug-fixed) core/.
#
# Output: dist/crsqlite.wasm + dist/crsqlite.mjs  (the artifacts the
# @vlcn.io/crsqlite-wasm JS wrapper loads).
#
# Toolchain pins (MUST match — LLVM bitcode is not portable across major
# LLVM versions, and the rustc emscripten target must match emcc's LLVM):
#   * rustc: nightly-2023-10-05      (LLVM 17, pinned via rust-toolchain.toml)
#   * emscripten (emsdk): 3.1.45     (clang/LLVM 18 — reads LLVM 17 bitcode)
#
# Gotchas this script encodes (each cost real debugging):
#   * Keep Cargo.lock at lockfile v3 — modern cargo rewrites it to v4 which
#     the 2023 nightly rejects.
#   * CARGO_INCREMENTAL=0 — incremental builds emit split *.rcgu.bc files
#     that cargo then fails to assemble into the single *.bc emcc needs.
#   * -C codegen-units=1 — same reason, belt-and-suspenders.
#   * core/rs/bundle/src/lib.rs needs `use core::alloc::Layout;` (the
#     #[cfg(target_family="wasm")] alloc-error handler) — fixed in this fork.
#
# See wasm-build/README.md for the modern-toolchain path (emsdk 4.x +
# current nightly + upstream rhashimoto/wa-sqlite).
set -euo pipefail

CORE_DIR="$(cd "$(dirname "$0")/.." && pwd)"          # this fork's root
WORK="${WORK:-/tmp/crsqlite-wasm-build}"
EM_VERSION="3.1.45"

# 1. Toolchain ---------------------------------------------------------------
rustup target add wasm32-unknown-emscripten --toolchain nightly-2023-10-05

if [ ! -d "$WORK/emsdk" ]; then
  git clone https://github.com/emscripten-core/emsdk.git "$WORK/emsdk"
fi
( cd "$WORK/emsdk" && ./emsdk install "$EM_VERSION" && ./emsdk activate "$EM_VERSION" )
# shellcheck disable=SC1091
source "$WORK/emsdk/emsdk_env.sh"

# 2. Harness: vlcn's frozen wa-sqlite, pointed at THIS fork's core -----------
if [ ! -d "$WORK/wa-sqlite" ]; then
  git clone --depth 1 https://github.com/vlcn-io/wa-sqlite.git "$WORK/wa-sqlite"
fi
cd "$WORK/wa-sqlite"
ln -sfn "$CORE_DIR/core" crsql

# codegen-units=1 in the rust->bitcode recipes (see header)
sed -i.bak 's|RUSTFLAGS="--emit=llvm-bc -C linker=/usr/bin/true"|RUSTFLAGS="--emit=llvm-bc -C linker=/usr/bin/true -C codegen-units=1"|g' Makefile

# 3. Build -------------------------------------------------------------------
git -C "$CORE_DIR" checkout -- core/rs/bundle/Cargo.lock 2>/dev/null || true   # keep lockfile v3
export CRSQLITE_COMMIT_SHA="$(git -C "$CORE_DIR" rev-parse HEAD)"
export CARGO_INCREMENTAL=0
( cd crsql/rs/bundle && cargo clean )   # avoid mixing bitcode from other toolchains
make dist

mkdir -p "$CORE_DIR/wasm-build/dist"
cp dist/crsqlite.wasm dist/crsqlite.mjs "$CORE_DIR/wasm-build/dist/"
echo "==> built: $CORE_DIR/wasm-build/dist/crsqlite.{wasm,mjs}"
