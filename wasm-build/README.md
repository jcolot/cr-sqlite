# Browser-WASM build for this cr-sqlite fork

`superfly/cr-sqlite` maintains the **native** loadable extension (it powers
Fly's Corrosion fleet-gossip) but deleted the browser/WASM build chain. This
directory resurrects it so the fork can also produce `crsqlite.wasm` for
offline-first web apps that use the `@vlcn.io/crsqlite-wasm` JS wrapper.

## Quick start

```bash
./wasm-build/build.sh
# => wasm-build/dist/crsqlite.wasm  (~1.8 MB)
#    wasm-build/dist/crsqlite.mjs   (emscripten loader)
```

Uses a **current, unpinned toolchain** (any recent rust nightly + latest
emscripten). Tested with rustc 1.98-nightly (LLVM 22) + emscripten 6.0.0.

## How it works

1. **Core (this fork)** — the Rust crate (`core/rs/bundle_static`,
   crate-type=`staticlib`) + C glue (`core/src/*.c`), compiled for
   `wasm32-unknown-emscripten`.
2. **Harness** — vlcn's `wa-sqlite` emscripten harness, repointed via a
   `crsql` symlink at this fork's `core/`, with our modern overrides from
   `harness-overrides/` (see below). `emcc` links the wasm archive + C glue
   + SQLite into `crsqlite.wasm`.
3. **JS wrapper** — `@vlcn.io/crsqlite-wasm` (from npm, unchanged) loads the
   `.wasm`/`.mjs` pair.

## Why this build is unpinned (the key change vs. vlcn's)

vlcn's original linked the Rust core as **LLVM bitcode** (`--emit=llvm-bc`)
for cross-language LTO. That forces rustc and emscripten to share an LLVM
major version — a brittle pin (`nightly-2023-10-05` + `emsdk 3.1.45`, both
LLVM 17/18).

We instead build the core as a normal **wasm static archive** (real wasm
objects). Wasm objects link across LLVM versions, so **any** current nightly
+ **any** current emscripten works, with no version matching. The only cost
is losing cross-language LTO — negligible for this extension.

## Patches carried in this fork

* `core/rs/bundle/src/lib.rs`: `use core::alloc::Layout;` — the
  `#[cfg(target_family="wasm")]` alloc-error handler referenced `Layout`
  without importing it (dead on native builds, broke WASM). **Committed.**
* `sqlite-rs-embedded` submodule (vlcn's, so applied at build time by
  `build.sh`): drop `#![feature(concat_idents)]` (removed from rustc;
  unused) and `#![feature(error_in_core)]` (stabilised in Rust 1.81).

## emscripten-6 compatibility (in `harness-overrides/`)

The harness `Makefile` and `extra_exported_runtime_methods.json` here carry
two fixes the 0.22 `@vlcn.io/wa-sqlite` JS wrapper needs on emscripten 6:

* **Export HEAP views** (`HEAPU8`, …) in `EXPORTED_RUNTIME_METHODS` —
  emscripten 6 no longer attaches them to `Module` automatically.
* **`-s WASM_BIGINT=0`** — emscripten 6 defaults i64 → JS BigInt, but the
  wrapper expects the legacy two-i32 i64 ABI.

## Native extension

The native loadable extension (`core/dist/crsqlite.{dylib,so}`) builds with
the repo's `make` and the same modern nightly (`RUSTUP_TOOLCHAIN=nightly`).
For linux, build in Docker (`rust:bookworm` + `clang libclang-dev` for
bindgen). The native and wasm cores are behaviourally identical — the
submodule patches above only remove unused/stabilised feature *gates*.
