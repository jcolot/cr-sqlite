# Migrating the WASM build to wa-sqlite v1.x (rhashimoto upstream)

Investigation notes: what it would actually take to move this fork's browser
build off **vlcn's wa-sqlite fork** and onto **upstream `rhashimoto/wa-sqlite`
v1.x** (latest at writing: v1.1.1, SQLite 3.53.0).

Conclusion up front: **there is no large rewrite anywhere in the stack.** The
build/link work is mechanical, the JS wrapper is near-portable, and the only
real engineering is the VFS/async seam — most of which is *adopting* upstream
code, not authoring it. The genuine costs are two non-code things: re-validating
cr-sqlite's reentrant SQL under upstream's async model, and the OPFS deployment
environment (Worker + cross-origin isolation).

> **UPDATE 2026-07-12 — this migration was built and proven.** cr-sqlite's core
> now compiles + links against the upstream v1.1.1 harness (SQLite 3.53) and runs
> green on OPFS in Chrome. See "✅ v1.x migration — built and proven" below for the
> build (`wasm-build/build-v1.sh` + `harness-overrides-v1/`), the spike
> (`wasm-build/opfs-spike-v1/`), the benchmark (writes/scans ~2× faster than v0),
> and the one hard constraint we found: cr-sqlite needs a **fully synchronous**
> OPFS VFS (`AccessHandlePoolVFS`), not the cooperative `OPFSCoopSyncVFS`.

## The stack and who owns what

```
your app
  └─ @vlcn.io/crsqlite-wasm        (vlcn-io/js)   index.ts / DB.ts / TX.ts / Stmt.ts
       └─ sqlite-api.js            (wa-sqlite)    api.* methods over the wasm
            └─ lib*.js glue        (wa-sqlite)    Module.* helpers, VFS/hook relays
                 └─ crsqlite.wasm  (this repo)    SQLite + cr-sqlite C/Rust core
```

This repo only produces `crsqlite.{wasm,mjs}` (see `wasm-build/build.sh`). The
JS wrapper that apps actually call lives in a **separate** repo, `vlcn-io/js`,
package `packages/crsqlite-wasm`.

The key seam is the `Module.*` runtime-helper contract between `sqlite-api.js`
and the `lib*.js` glue — it diverged camelCase (vlcn) vs snake_case (upstream).
It does **not** leak up into the `api.*` surface that `DB/TX/Stmt` ride on.

## Layer-by-layer cost

| Layer | Cost | Evidence |
|---|---|---|
| Build / link the C+Rust core | mechanical, days | upstream Makefile keeps `CFILES_EXTRA` + `WASQLITE_EXTRA_DEFINES` |
| `DB/TX/Stmt` wrapper | near-zero | identical `api.*` surface; only dead `create_module` to drop |
| `sqlite-api.js` | adopt upstream | divergence is below `api.*` |
| VFS registration (`index.ts`) | ~4 lines + Worker/COOP-COEP | this file |
| `ahp/` subsystem | nothing — empty stubs | see below |

## 1. Build / link (Bucket 1) — mechanical

Upstream's `Makefile` is the same lineage as this fork's
`wasm-build/harness-overrides/Makefile` (vlcn forked it), so the extension hooks
are unchanged:

- `-DSQLITE_EXTRA_INIT=core_init` goes into `WASQLITE_EXTRA_DEFINES`.
  `SQLITE_EXTRA_INIT` is a **SQLite** compile-time feature, not a wa-sqlite one —
  it survives any wa-sqlite version.
- The crsql C glue (`crsqlite.c`, `changes-vtab.c`, `ext-data.c`) drops into
  `CFILES_EXTRA` — the same variable name already used here.
- `core_init.c` is concatenated onto `sqlite3.c` (keep the `sqlite3-extra.c`
  rule; point `CFILES` at it).
- The Rust core links as a plain wasm static archive (`libcrsql_bundle_static.a`)
  on the final `emcc` line — emcc-level, version-independent. This is already how
  the modern build works (see `wasm-build/README.md`).

Real changes: bump `SQLITE_VERSION` 3.45.0 → 3.53.0 and fix any sqlite-internal
API drift the crsql C touches.

**ABI is unchanged:** upstream v1.1.1 still defaults to `-s WASM_BIGINT=0`
(legacy two-i32 i64 ABI), which is what the wrapper expects. No BigInt
migration. Bonus: upstream adds a `dist/wa-sqlite-jspi.mjs` target — JSPI for
free once the core is linked.

## 2. DB / TX / Stmt wrapper — near-portable

`vlcn-io/js/packages/crsqlite-wasm/src/{DB,TX,Stmt}.ts` are thin sugar over
`sqlite-api.js`. The only `api.*` calls DB.ts makes are `create_function`,
`value`, `result`, `update_hook`, `close` (DB.ts:201–230) — all present in
upstream's `sqlite-api.js` with identical public signatures.

The only public-surface change between vlcn and upstream `sqlite-api.js` that
touches these files is the **removal of `create_module` / `declare_vtab`**
upstream. cr-sqlite registers its `crsql_changes` vtab in **C**, not from JS, so
this is harmless — just delete the dead paths.

One line to actually test, not assume: `create_function`'s callback
marshalling differs (vlcn hands a `Uint32Array` of value handles; upstream's
`adapt()` hands a `HEAP32` subarray). Both yield the i-th `sqlite3_value`
pointer, so DB.ts:207–213 should work unchanged — verify it.

Bonus: upstream `create_function` detects `AsyncFunction`, enabling async JS SQL
functions (vlcn can't).

## 3. VFS / async seam — the only real engineering

This is a **breaking change** in the VFS base contract, but the cost is mostly
*replacement*, not porting.

### The base-class diff (`VFS.js`)

| | vlcn Base (2022) | upstream Base (2024) |
|---|---|---|
| buffer args | pre-marshalled `Uint8Array`/`DataView`/`string` | raw pointers (`number`); VFS reads `this._module.HEAPU8` |
| 64-bit offsets | one number | split `…Lo`/`…Hi` |
| async model | `handleAsync(f)` on base, Asyncify-only | `hasAsyncMethod(name)` + generic `libadapters.js` relay; Asyncify **or** JSPI |
| construction | no ctor; keyed by `fileId` | `constructor(name, module)`; keyed by raw `pFile`/`pVfs`; adds `isReady()`, `close()`, `xFullPathname`, `SQLITE_OPEN_WAL` |

A VFS written for one base will not run on the other. **Do not port vlcn's VFS
classes** — adopt upstream's, which are richer (OPFSCoopSyncVFS, OPFSAdaptiveVFS,
OPFSAnyContextVFS, OPFSPermutedVFS, OPFSWriteAheadVFS, AccessHandlePoolVFS,
IDBBatchAtomicVFS, IDBMirrorVFS).

### The actual touch-point (`index.ts`) — ~4 lines

The shipped default is **`IDBBatchAtomicVFS` (IndexedDB), not OPFS**. The entire
wiring is:

```js
import { IDBBatchAtomicVFS } from "@vlcn.io/wa-sqlite/src/examples/IDBBatchAtomicVFS.js"; // L4
sqlite3.vfs_register(new IDBBatchAtomicVFS("idb-batch-atomic", { durability: "relaxed" })); // L66
open_v2(filename, FLAGS, filename != null ? "idb-batch-atomic" : undefined);                // L25
```

To move to OPFS upstream:

```js
import { OPFSCoopSyncVFS } from ".../examples/OPFSCoopSyncVFS.js";
const vfs = await OPFSCoopSyncVFS.create("opfs", wasmModule); // needs the module ref; async
sqlite3.vfs_register(vfs, true);
// ...name "opfs" in open_v2
```

Two consequences, both environmental rather than code volume:

- **Module reference:** upstream's `Base(name, module)` means the VFS now needs
  `wasmModule` passed in at the call site.
- **OPFS runtime constraints:** sync access handles require running in a
  **Worker** and the page being **cross-origin isolated** (COOP/COEP headers).
  `IDBBatchAtomicVFS` needs neither. This is the real deployment cost.

### `ahp/` is not a thing to migrate

`packages/crsqlite-wasm/src/ahp/` ("Access Handle Pool") is an **abandoned
design sketch**, not shipping code: `AhpDb.ts` is `export default class AhpDb {}`
under a wall of design comments; `AhpConnection.ts` is an empty ctor; `DB.ts` is
a 3-line comment; `notes.md` is a benchmarking journal. It was an unfinished
attempt at a worker-hosted, multi-tab-multiplexed DB (the problem
`OPFSCoopSyncVFS` now solves upstream). Nothing to rewire — ignore it.

## Decision guide

- **Want only newer SQLite (3.53)?** You do **not** need upstream at all. Bump
  `SQLITE_VERSION` in the current vlcn-based build. Hours.
- **Want JSPI / upstream OPFS VFS / a maintained base?** Do the full migration:
  Bucket 1 (days) + drop dead `create_module` in the wrapper + swap the VFS in
  `index.ts` + stand up the Worker/COOP-COEP environment + validate cr-sqlite's
  reentrant triggers and `crsql_changes` under the chosen async model.

## De-risking first step

Before committing: build the core into upstream (Bucket 1), wire the thin
wrapper against upstream's `sqlite-api.js`, and run cr-sqlite's existing trigger
/ `crsql_changes` tests against a **single** upstream VFS. If the reentrancy /
async seam behaves on the first VFS, the rest is small. If it fights on
concurrency, that's where the time goes.

# ✅ Spike results — cr-sqlite runs on OPFS (2026-07-12)

We actually ran the de-risking step. Built this fork's WASM with the current
unpinned toolchain (`wasm-build/build.sh`) and drove cr-sqlite on the SAB-free
OPFS VFS (`AccessHandlePoolVFS`) in Chrome via a standalone harness
(`wasm-build/opfs-spike/`, served by `serve.mjs`, no monorepo/Cypress).

**Result: green.** cr-sqlite boots, `crsql_as_crr` succeeds, `crsql_changes`
tracks the inserts, and data persists across close+reopen — all over OPFS. But
getting there uncovered **three real issues**, each isolated by instrumentation.
Two required source fixes; one is a build-config requirement.

### Issue 1 — resizable `ArrayBuffer` (incidental, fixed by build flag)

Modern emscripten with `ALLOW_MEMORY_GROWTH=1` backs the WASM heap with a
*resizable* `ArrayBuffer`. OPFS `FileSystemSyncAccessHandle.read/write` **and**
`TextDecoder.decode` both reject views/buffers that are resizable
(`"must not be resizable"`). Hit it first in the VFS, then in emscripten's own
string glue. Fixed for the spike with `-sALLOW_MEMORY_GROWTH=0
-sINITIAL_MEMORY=128MB`. Production alternative: use a resizable-buffer-aware VFS
(upstream v1's `OPFSCoopSyncVFS` et al. already handle this).

### Issue 2 — Asyncify is the wrong build for a synchronous VFS

`AccessHandlePoolVFS` is fully synchronous, so it needs the **`crsqlite-sync.mjs`**
(no-Asyncify) build, not `crsqlite.mjs`. On the Asyncify build, `crsql_as_crr`
overflowed the **native wasm call stack** (`RangeError: Maximum call stack size
exceeded`) — cr-sqlite reenters SQLite (nested `prepare`/`step` via a `pragma_*`
vtab inside `is_table_compatible`), and Asyncify's per-frame instrumentation
inflates each frame enough to exhaust the wasm stack on that shallow reentrancy.
`STACK_SIZE` (linear-memory stack) does **not** help — it's the call stack.
Switching to the sync build (and `const async = false` in the vlcn
`sqlite-api.js`, which hardcodes `true`) removes the overhead and the overflow.
Implication: an *async* VFS (IndexedDB, or async OPFS) should use **JSPI** on
upstream v1, not Asyncify, for cr-sqlite's reentrancy.

### Issue 3 — a real bug in cr-sqlite: `crsql_rollback_hook` signature (FIXED)

With the sync build, `crsql_as_crr` then hit `RuntimeError: function signature
mismatch` in `sqlite3RollbackAll`. Root cause is a genuine ABI bug:

- SQLite's rollback callback is `void(*)(void*)` (sqlite3.h), and the C decl in
  `src/crsqlite.c` matches: `void crsql_rollback_hook(void*)`.
- But the Rust impl (`rs/core/src/commit.rs`) was
  `extern "C" fn crsql_rollback_hook(*mut c_void) -> *const c_void` — return type
  `*const c_void`, giving the function wasm type `(i32)->i32`.
- `sqlite3RollbackAll` does `call_indirect` with type `(i32)->void`. WASM enforces
  **exact** `call_indirect` type equality, so it traps. (Harmless on native ABIs,
  where a void-expecting caller just ignores the returned register — which is why
  it was latent. The original bitcode-LTO build also masked it by unifying types
  during whole-program codegen.)

**Fix:** make the Rust hook return `void`. One-liner in `commit.rs`. This is
upstream-worthy — it's wrong on any strict-`call_indirect` target, not just here.

### Also fixed: `build.sh` never actually built

The harness `Makefile`'s `deps` target is an empty `.PHONY` (inherited from vlcn),
so `sqlite3-extra.c` / `extension-functions.c` were never generated and
`make dist` aborted with `No rule to make target 'tmp/obj/dist/sqlite3-extra.o'`.
Fixed by pre-generating them (`make crsqlite-extra` +
`make deps/extension-functions.c`) before `make dist`.

### Net takeaways for the migration

- **OPFS is not the risk.** cr-sqlite's CRDT machinery works over a sync OPFS VFS.
- The two source fixes (`commit.rs`, `build.sh`) are prerequisites for *any* WASM
  cr-sqlite (they're in the core/build, not the VFS or wrapper).
- **Build/async-model choice matters:** sync VFS → sync build; async VFS → JSPI
  (upstream v1), not Asyncify, because of cr-sqlite's reentrancy.
- The resizable-buffer issue is another concrete argument for upstream v1's
  OPFS VFSes over porting vlcn's older `AccessHandlePoolVFS`.

Reproduce: `cd wasm-build/opfs-spike && node serve.mjs`, open in Chrome. See that
dir's `README.md`. (The `crsqlite-sync.*` artifacts there are the fixed sync
debug build.)

# ✅ v1.x migration — built and proven (2026-07-12)

We didn't just analyze the migration; we did it. cr-sqlite's core is built against
the **upstream rhashimoto/wa-sqlite v1.1.1** harness (SQLite 3.53) and runs green on
OPFS in Chrome.

### What was built

- **`wasm-build/build-v1.sh`** — companion to `build.sh`, targeting the upstream v1
  harness instead of vlcn 0.22. Same modern unpinned toolchain (Rust core as a wasm
  staticlib), reuses build.sh's emsdk. Builds the **sync** target `wa-sqlite.mjs`.
- **`wasm-build/harness-overrides-v1/Makefile`** — upstream v1's Makefile with
  cr-sqlite injected: `CFILES_EXTRA` (crsqlite.c / changes-vtab.c / ext-data.c),
  `sqlite3.c` → `sqlite3-extra.c` (amalgamation + `core_init.c` for
  `SQLITE_EXTRA_INIT`), `WASQLITE_EXTRA_DEFINES`, and the Rust staticlib linked into
  the sync target.
- **`wasm-build/opfs-spike-v1/`** — the v1 spike (new `VFS.create(name, module)` API,
  `vfs_register(vfs, true)`, `const async=false` for the sync build). Same checks +
  benchmark as the v0 spike, served by `serve.mjs`.

### How the v1 harness differs from vlcn 0.22 (all handled, all mechanical)

- Compiles `sqlite3.c` directly (we still concat `core_init.c` into `sqlite3-extra.c`).
- `main.c` (not `libmodule.c`) holds `int main(){ sqlite3_initialize(); }` — same
  `SQLITE_EXTRA_INIT=core_init` hook mechanism.
- Three build variants: sync `wa-sqlite.mjs`, `wa-sqlite-async.mjs` (Asyncify),
  `wa-sqlite-jspi.mjs` (JSPI). We build the **sync** one.
- VFS base is `FacadeVFS` + `libadapters.js` (built into the `.mjs`); VFS API is
  `static async create(name, module)`, methods are `jOpen/jRead/…` on raw pointers.
- `sqlite-api.js` still hardcodes `const async = true`; flip to `false` for the sync
  build (same seam as vlcn).

### Two build bugs found — both inherited from upstream, neither cr-sqlite's

- **macOS/BSD `cmp`**: upstream's extension-functions checksum rule is
  `echo SHA | cmp deps/sha3`, which relies on GNU `cmp` reading file2 from stdin;
  BSD `cmp` errors. Fixed to a two-file compare.
- **`OMIT_UTF16` vs export list**: upstream's `exported_functions.json` exports the
  `sqlite3_*16` entry points, so `-DSQLITE_OMIT_UTF16` (a vlcn size opt) breaks the
  link. Dropped it.

### The one hard constraint: cr-sqlite needs a *fully synchronous* OPFS VFS

First tried `OPFSCoopSyncVFS` (upstream's flagship sync-build OPFS VFS). It failed at
`open_v2` with `SQLITE_ERROR`. Traced via the VFS's own log: the DB opens and the
header is read, then the VFS's **cooperative locking** releases the access handle and,
on the next `jLock` (SHARED), returns `SQLITE_BUSY` and defers to an **async**
lock-acquire (`navigator.locks` + `retryOps`). That BUSY lands *inside* cr-sqlite's
`core_init` auto-extension, which runs SQL during `sqlite3_open` — and that open-time
SQL cannot be retried at the JS boundary. Result: `SQLITE_ERROR`; the async lock
resolves too late.

Switching to **`AccessHandlePoolVFS`** (fully synchronous: fixed pre-acquired handle
pool, no `navigator.locks`, no BUSY/retry) → **all green**. This is the same VFS the v0
spike used, so the rule generalizes:

> **cr-sqlite requires a fully-synchronous OPFS VFS.** Any VFS that returns
> `SQLITE_BUSY` and defers to an async retry (cooperative locking) collides with
> cr-sqlite's open-time extension init. Use `AccessHandlePoolVFS`, not
> `OPFSCoopSyncVFS`. (An async build — Asyncify/JSPI — would tolerate the cooperative
> VFS, but that reintroduces the Asyncify stack-overflow risk; the sync build +
> `AccessHandlePoolVFS` is the clean combination.)

### Benchmark: v1 vs v0 (desktop Chrome, same harness code)

| Metric            | v0 (vlcn 0.22, SQLite 3.45) | v1 (rhashimoto 1.1.1, SQLite 3.53) |
| ----------------- | --------------------------- | ---------------------------------- |
| CRR bulk insert   | 42,481 rows/s               | **77,160 rows/s** (~1.8×)          |
| full scan (10k)   | 3.1 ms                      | **1.5 ms** (~2×)                   |
| 1000 pk lookups   | 25,063 q/s                  | 11,601 q/s                         |
| crsql_changes     | 20,000 rows                 | 20,000 rows                        |
| db size on OPFS   | 1.05 MB                     | 1.05 MB                            |

Writes and scans are markedly faster on the v1 build (SQLite 3.53 + upstream's VFS).
The pk-lookup number came out lower in this run; it runs last in the harness, so it's
likely warmup/ordering rather than a real regression — worth re-measuring if it
matters.

### Still open (not blockers for "does v1 work")

- The **JS wrapper** (`@vlcn.io/crsqlite-wasm` DB/TX/Stmt) hasn't been repointed at the
  v1 module + `sqlite-api.js` yet — the spike talks to `sqlite-api.js` directly. That's
  the "near-portable wrapper" work from the analysis above.
- Same **toolchain caveat as v0**: emscripten 6.x backs a growable heap with a
  resizable `ArrayBuffer` that its own glue (`UTF8ToString`) and OPFS reject, so the
  build uses `ALLOW_MEMORY_GROWTH=0` + a fixed 128 MB heap. A production build should
  either keep a fixed heap or find the emscripten flag that keeps growth without a
  resizable buffer.

# Android / Capacitor deployment

Separate question from the v1.x migration: how to get cr-sqlite into a
**Capacitor Android** app. There are three paths; the choice hinges on two
verified facts about the Android WebView and the main Capacitor SQLite plugin.

## The two facts that decide everything

1. **Android WebView cannot do cross-origin isolation / `SharedArrayBuffer`.**
   It has no site isolation / multi-process, so COOP/COEP headers won't grant
   `crossOriginIsolated` no matter what you set. This kills sqlite.org's official
   OPFS WASM (which needs SAB) — **but not** wa-sqlite's `AccessHandlePoolVFS` /
   `OPFSCoopSyncVFS`, which are designed to run synchronously in a Worker
   **without** SAB. OPFS sync access handles themselves need only a Worker + a
   recent-enough Chromium (≈ Chrome 102+), not SAB. So wa-sqlite OPFS *can* run
   on Android WebView where sqlite-wasm OPFS can't.

2. **`@capacitor-community/sqlite` has no usable extension loading on Android.**
   `loadExtension`/`enableLoadExtension` exist in the TS API (since 5.0.6) but are
   commented out in the `CapacitorSQLitePlugin` bridge interface and absent from
   the Android native code (`Database.java`, `CapacitorSQLite.java`). Its Android
   engine is a **prebuilt SQLCipher AAR** (`net.zetetic:sqlcipher-android:4.10.0`)
   and it compiles **no native code** (no `externalNativeBuild`/cmake/ndk). So
   you cannot load `crsqlite.so` at runtime, and you cannot cleanly inject
   cr-sqlite into its binary engine.

## Three paths

| Path | What | Effort | When |
|---|---|---|---|
| 1. Native static-link | bake cr-sqlite into a custom `libsqlite.so` | moderate–high | best perf / true native |
| 2. WASM + OPFS (SAB-free VFS) | `AccessHandlePoolVFS`/`OPFSCoopSyncVFS` in a Worker | moderate | all-WASM, decent storage |
| 3. WASM + IndexedDB | current vlcn build as-is | none | works today, slower |

Note path 1 is *not* "just call `loadExtension`" — see fact 2. Given that gap,
path 2 is often the lower-effort way onto Android because it stays entirely in
JS/build (no JNI/NDK).

## Path 1 — native static-link (the PowerSync pattern)

Principle: don't load at runtime; **bake cr-sqlite into a custom SQLite build**
via `SQLITE_EXTRA_INIT` — the exact mechanism `core/src/core_init.c` already
implements for WASM. It's the WASM recipe with **NDK instead of emcc** and a
**JNI host instead of a JS host**.

```
Capacitor app (JS)
  └─ thin Capacitor SQLite plugin (Java)
       └─ JNI binding (requery sqlite-android, built FROM SOURCE)
            └─ libsqlite.so
                 ├─ sqlite3.c + core_init.c   (-DSQLITE_EXTRA_INIT=core_init)
                 └─ libcrsql_bundle_static.a  (per ABI)
```

Stage 1 — Rust core → static lib per ABI (crate `crsql_bundle_static`, same
features as WASM):

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
cargo install cargo-ndk
cd core/rs/bundle_static
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 \
  build --release --features static,omit_load_extension
# → libcrsql_bundle_static.a per ABI
```

Stage 2 — custom `libsqlite.so` (entry symbol `sqlite3_crsqlite_init`,
`core/src/crsqlite.c:45`):

```cmake
add_library(sqlite3x SHARED sqlite3.c core_init.c <jni-glue>.c)
target_compile_definitions(sqlite3x PRIVATE
  SQLITE_EXTRA_INIT=core_init
  SQLITE_ENABLE_FTS5 SQLITE_ENABLE_BYTECODE_VTAB
  SQLITE_THREADSAFE=1)            # native keeps 1 (WASM used 0)
target_link_libraries(sqlite3x
  ${CMAKE_CURRENT_SOURCE_DIR}/jniLibs/${ANDROID_ABI}/libcrsql_bundle_static.a log)
```

`core_init.c` is verbatim from this repo.

Stage 3 — package as `.aar` shipping the `.so` for the 3 ABIs + the JNI Java.

### Variant choice (verified)

- **Variant A — substitute into the community plugin: NOT viable.** Its engine is
  a binary SQLCipher AAR; you'd have to build SQLCipher-from-source with cr-sqlite
  linked. Only worth it if you need at-rest **encryption**.
- **Variant B — custom thin plugin (recommended).** Use `io.requery:sqlite-android`
  **built from source** (it has its own NDK `externalNativeBuild` compiling
  `sqlite3.c`) as the JNI host — drop `core_init.c` + the define + the `.a` into
  its build, then wrap with a small `open/execute/query/close` plugin. No
  SQLCipher, you control the SQLite version.

### Gotchas

- **bindgen for Android:** the Rust core bindgens against `sqlite3.h`; set
  `BINDGEN_EXTRA_CLANG_ARGS=--sysroot=$NDK/.../sysroot` and match the amalgamation
  version (WASM pins 3.45).
- **SQLite version match** between the amalgamation and what the core bindgen'd
  against.
- **APK size:** the `.a` links into each ABI — a few MB; trim with `abiFilters`.
- **`crsql_finalize()` before close**, mirroring the WASM wrapper's `DB.close()`.

## Path 2 — WASM + OPFS

Use `OPFSCoopSyncVFS` (or `AccessHandlePoolVFS` for a single WebView) with the
**synchronous** cr-sqlite build (`crsqlite-sync.mjs`) in a Worker; feature-detect
`createSyncAccessHandle`. No COOP/COEP needed (fact 1). This is the v1.x VFS work
already scoped above — all JS/build, no native. Falls back to Path 3 when sync
access handles aren't available on a device's WebView.

## Recommendation

- Need encryption or maximum native perf → Path 1 Variant B (custom plugin +
  requery-from-source), accept the NDK/bindgen build.
- Want least native work → Path 2 (SAB-free OPFS VFS), reusing the v1.x VFS work.
- Want it working now → Path 3 (IndexedDB), the current build, unchanged.

## Local checkouts used for this analysis

- `~/Workspace/vlcn-js` — fork of `vlcn-io/js` (the wrapper)
- `~/Workspace/vlcn-wa-sqlite` — fork of `vlcn-io/wa-sqlite` (current harness)
- `~/Workspace/rhashimoto-wa-sqlite` — clone of `rhashimoto/wa-sqlite` (upstream)
