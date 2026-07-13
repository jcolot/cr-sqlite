# cr-sqlite multi-tab spike — one connection, many tabs (wa-sqlite v1)

Demonstrates the recommended answer to cr-sqlite's single-connection OPFS constraint:
**one owner holds the DB, all tabs share it, and cr-sqlite `onUpdate` fans out so tabs
refresh live.** Runs the real repointed `@vlcn.io/crsqlite-wasm` facade on wa-sqlite v1
over OPFS (same `wrapper-bundle.js` as `../opfs-spike-v1-wrapper/`).

## Run

```bash
cd wasm-build/opfs-spike-multitab
node serve.mjs            # → http://localhost:8715/
```

Open in **two tabs**. One becomes **LEADER**, the other a **follower**. Add a todo in
either — it appears in both live. Close the leader tab and the follower is promoted
(re-election).

## Architecture: Web Locks leader election + BroadcastChannel

```
tab A (LEADER) ── holds Web Lock "cr-sqlite-leader" ── spawns ─► db-owner Worker ─ cr-sqlite/OPFS
   ▲                                                                   │
   └─────────── BroadcastChannel  (query / result / changed)  ─────────┤
tab B (follower) ── routes queries to the leader over the channel ─────┘
```

- Every tab contends for an exclusive Web Lock. The holder is the **leader** and the only
  tab that opens the DB — it spawns a dedicated `db-owner` Worker holding the single
  cr-sqlite connection.
- Followers send queries to the leader over a `BroadcastChannel` and await results there.
- The owner's `onUpdate` notifications are broadcast to every tab → live refresh.
- Leader closes → its Web Lock releases → a follower's lock callback fires → it becomes
  the new leader and spawns its own owner. Single connection preserved throughout.

## Why not a SharedWorker? (three stacked browser constraints)

The obvious design — a SharedWorker that owns the DB — is blocked in Chrome, twice, on
top of the VFS constraint:

1. **OPFS `createSyncAccessHandle` is dedicated-worker-only.** In a SharedWorker it throws
   `handle.createSyncAccessHandle is not a function` (seen in `AccessHandlePoolVFS.addCapacity`).
2. **A SharedWorker can't spawn a dedicated Worker** — `Worker` is `undefined` in
   `SharedWorkerGlobalScope`. So a SharedWorker can't even delegate the DB to a dedicated
   worker.
3. **`AccessHandlePoolVFS` is single-connection** — it takes an exclusive OPFS lock per
   file, so only one context can open a given database at a time.

Leader-election + BroadcastChannel threads all three: the leader is a normal *window*
(which *can* spawn a Worker), only one leader exists at a time (Web Lock), and the DB
lives in that leader's dedicated worker (where sync handles work).

## Capacitor / Android

This design needs **no SharedWorker**, so it ports directly to the Capacitor WebView
(where SharedWorker is unavailable). `navigator.locks` and `BroadcastChannel` are
available there; the leader's dedicated Worker holds the OPFS connection exactly as here.

## Spike caveat

The owner wipes OPFS before opening (see `db-owner.js`) so the demo is reliable and
self-heals leftover pool state. That means the DB resets when a fresh leader boots
(including on re-election). This spike demonstrates **live cross-tab sharing**, not
durability — persistence was proven in `../opfs-spike-v1{,-wrapper}/`. A production owner
would not wipe.
