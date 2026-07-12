# cr-sqlite × OPFS — Step-0 standalone spike

Proves the freshly-built `crsqlite.wasm` runs on the SAB-free OPFS VFS
(`AccessHandlePoolVFS`) in a real browser, with **no monorepo and no Cypress**. This
directly de-risks the wa-sqlite-v1 / Android-Capacitor direction: the one real unknown is
"does cr-sqlite's CRDT machinery work on a sync OPFS handle?", and this answers it.

## What's here

- `crsqlite.mjs` / `crsqlite.wasm` — built from this fork's core via `wasm-build/build.sh`.
- `wa-sqlite/` — the minimal matching wa-sqlite JS (`sqlite-api.js`, `sqlite-constants.js`,
  `VFS.js`, `examples/AccessHandlePoolVFS.js`) that pairs with the built `.mjs`.
- `worker.js` — runs the DB in a Web Worker (OPFS `createSyncAccessHandle` is Worker-only
  in some browsers; also the Capacitor-production shape). Registers the OPFS VFS, opens a
  named db, runs `crsql_as_crr` + `crsql_changes`, then closes and reopens to prove
  persistence.
- `index.html` — spawns the worker and renders PASS/FAIL.
- `serve.mjs` — tiny Node static server with correct `.mjs`/`.wasm` MIME types.

## Run

```bash
cd wasm-build/opfs-spike
node serve.mjs           # → http://localhost:8712/
```

Then open **http://localhost:8712/** in **Chrome** (best OPFS sync-access-handle support).
`localhost` is a secure context, so OPFS is available; no COOP/COEP headers are needed
because `AccessHandlePoolVFS` does not use SharedArrayBuffer.

## Reading the result

- 🟢 **ALL CHECKS PASSED** → cr-sqlite boots on OPFS, the CRR/`crsql_changes` path works,
  and writes persist across close+reopen. Step 0 is proven → move to Step 1 (same build in
  a Capacitor WebView on an Android device; benchmark throughput).
- 🔴 **boot / worker error** → likely OPFS unavailable in that browser/context. Try current
  Chrome; confirm you loaded over `http://localhost` (not `file://`).
- 🔴 **CRR/changes assertions fail** → the real finding this spike exists to surface:
  cr-sqlite's vtabs/functions misbehave on this VFS.

To re-run from a clean slate, clear the origin's OPFS storage (DevTools → Application →
Storage → Clear site data) — the db file `spike.db` persists between runs by design.
```
