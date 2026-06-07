# Browser-WASM build for this cr-sqlite fork

`superfly/cr-sqlite` maintains the **native** loadable extension (it powers
Fly's Corrosion fleet-gossip), but deleted the browser/WASM build chain. This
directory resurrects it so the fork can also produce `crsqlite.wasm` for
offline-first web apps that use the `@vlcn.io/crsqlite-wasm` JS wrapper.

## Quick start

```bash
./wasm-build/build.sh
# => wasm-build/dist/crsqlite.wasm  (~1.8 MB, -Oz -flto)
#    wasm-build/dist/crsqlite.mjs   (emscripten loader)
```

## How it works

Three stacked layers (see `build.sh` for the exact commands):

1. **Core (this fork)** — the Rust crate (`core/rs/bundle`) + C glue
   (`core/src/{crsqlite,changes-vtab,ext-data}.c`). Compiled to LLVM bitcode
   for `wasm32-unknown-emscripten`.
2. **SQLite-as-WASM harness** — vlcn's frozen `wa-sqlite` emscripten harness,
   repointed via a `crsql` symlink at *this* fork's `core/`. `emcc` links the
   bitcode + C glue + SQLite amalgamation into `crsqlite.wasm`.
3. **JS wrapper** — `@vlcn.io/crsqlite-wasm` (unchanged, from npm) loads the
   `.wasm`/`.mjs` pair.

## Why the toolchain is pinned

LLVM bitcode is **not portable across major LLVM versions**, and rustc's
emscripten target must match emcc's LLVM. The known-good pair is:

| Tool        | Version            | LLVM |
|-------------|--------------------|------|
| rustc       | nightly-2023-10-05 | 17   |
| emscripten  | 3.1.45             | 18   |

(LLVM 18 reads LLVM 17 bitcode via auto-upgrade.)

## Patches carried in this fork

* `core/rs/bundle/src/lib.rs`: added `use core::alloc::Layout;` — the
  `#[cfg(target_family="wasm")]` alloc-error handler referenced `Layout`
  without importing it. Dead code on native builds (so superfly never hit
  it), broken on WASM.

## Modernising the toolchain (follow-up)

The pin above is the *fast, proven* path. To track current tooling instead
(recommended long-term so nothing stays frozen), the core compiles cleanly on
**current nightly** with three trivial source changes — all verified:

* delete `#![feature(concat_idents)]` in `sqlite-rs-embedded/sqlite3_capi`
  (dead — the macro is never invoked);
* delete `#![feature(error_in_core)]` in `sqlite-rs-embedded/sqlite_nostd`
  (stabilised in Rust 1.81);
* `vec_into_raw_parts` is now a warning (stabilised in 1.93), not an error.

Pair that with **emsdk 4.x** (matching modern rustc's LLVM) and, ideally,
rebase the harness onto the actively-maintained upstream `rhashimoto/wa-sqlite`
rather than vlcn's 2024 fork — that also brings the newer OPFS VFSs
(`OPFSCoopSyncVFS`/SAHPool), which behave better under Capacitor.
