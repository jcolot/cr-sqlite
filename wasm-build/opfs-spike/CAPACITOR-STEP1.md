# Step 1 — cr-sqlite on OPFS inside a Capacitor Android app

Step 0 proved cr-sqlite runs on the sync OPFS VFS in desktop Chrome. Step 1 runs the
**exact same web assets** inside a Capacitor Android WebView on a real device, to answer:

1. Is OPFS (`createSyncAccessHandle`) available in the app's WebView?
2. Does cr-sqlite persist across app restarts?
3. **Throughput vs desktop** — the "is WASM/OPFS fast enough, or do we need native
   static-link?" decision. `worker.js` prints insert rows/s, scan ms, pk-lookup q/s, and
   db size; compare the device numbers against the desktop baseline you got in Step 0.

Nothing here needs SharedArrayBuffer or COOP/COEP — that's the whole reason
`AccessHandlePoolVFS` (sync) was chosen. The DB runs in a Worker (OPFS sync access handles
are Worker-only on some WebView versions), which is already how this harness is built.

## Prerequisites

- Node + a Capacitor toolchain, Android Studio + SDK, and a device/emulator whose
  **Android System WebView is Chromium ≥ ~108** (OPFS sync access handles). Update
  "Android System WebView" and Chrome from the Play Store on the test device.
- The built sync artifacts: `crsqlite-sync.mjs` + `crsqlite-sync.wasm` (from
  `wasm-build/build.sh`'s sync target — gitignored here, so build them first).

## Assemble the app

```bash
npm create @capacitor/app         # or add Capacitor to an existing web app
cd <app>
npm install
```

Copy the spike web assets into the Capacitor web dir (the `webDir` in
`capacitor.config.ts`, e.g. `www/` or `dist/`), preserving the layout:

```
<webDir>/
  index.html
  worker.js
  wa-sqlite/           # sqlite-api.js (const async = false), sqlite-constants.js,
                       # VFS.js, examples/AccessHandlePoolVFS.js (patched xRead/xWrite)
  crsqlite-sync.mjs
  crsqlite-sync.wasm
```

Then:

```bash
npx cap add android
npx cap copy
npx cap open android        # build & run on the device from Android Studio
```

The page auto-runs on load: expect 🟢 plus the benchmark lines.

## What to verify on-device

- **🟢 all checks pass** → cr-sqlite + OPFS works in the Android WebView.
- **Persistence**: kill and relaunch the app; the harness wipes OPFS on boot by design,
  so to test real persistence, temporarily comment out the `wipeOPFS` block in `worker.js`
  and confirm the reopen check still finds the rows on a second launch.
- **Benchmark**: record `rows/s`, `scan ms`, `q/s`, `db size`. Compare to desktop. A large
  gap (e.g. WASM/OPFS an order of magnitude under your workload's bar) is the signal to
  fall back to native static-link (see `notes-v1-migration.md` → Path 1).

## Gotchas (most-likely failure modes first)

- **OPFS unavailable / boot error** → WebView too old. Update Android System WebView;
  check `chrome://version` in the WebView or log `navigator.userAgent`.
- **Module/wasm fails to load** → the WebView's asset handler must serve `.mjs` as
  `text/javascript` and `.wasm` as `application/wasm`. Capacitor's local server normally
  does; if not, that's the cause (same class of bug the spike's `serve.mjs` fixes for
  desktop).
- **`createSyncAccessHandle` throws on main thread** → must be in a Worker. The harness
  already is; don't move DB calls to the main thread.
- **Storage scope**: OPFS lives in the app sandbox under a stable Capacitor origin
  (`https://localhost` / `capacitor://localhost`), so it persists across launches and is
  cleared on uninstall.

## If throughput is good

The data layer is then identical to the web app (same wasm, same `DB`/`TX`/`Stmt`
wrapper once wired through `@vlcn.io/crsqlite-wasm` with `{ vfs: "opfs" }`), and the
Worker-owns-the-DB shape here is the production architecture. If throughput is not good
enough, `notes-v1-migration.md` covers the native static-link alternative.
