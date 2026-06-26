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

## Local checkouts used for this analysis

- `~/Workspace/vlcn-js` — fork of `vlcn-io/js` (the wrapper)
- `~/Workspace/vlcn-wa-sqlite` — fork of `vlcn-io/wa-sqlite` (current harness)
- `~/Workspace/rhashimoto-wa-sqlite` — clone of `rhashimoto/wa-sqlite` (upstream)
