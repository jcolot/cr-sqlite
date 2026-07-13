// The single DB owner — a *dedicated* Worker (spawned by the SharedWorker router).
//
// OPFS createSyncAccessHandle is dedicated-worker-only (it throws in a SharedWorker), so
// the DB lives here. Exactly one of these exists per origin because the SharedWorker that
// spawns it is itself a singleton. Holds the one cr-sqlite connection on OPFS via the
// real repointed @vlcn.io/crsqlite-wasm facade (wa-sqlite v1).
import initWasm from "./wrapper-bundle.js";

let dbPromise = null;
let changed = new Set();
let flushScheduled = false;
function noteChange(tbl) {
  changed.add(String(tbl).replace(/__crsql_.*$/, "")); // logical table name
  if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      const tables = [...changed];
      changed = new Set();
      self.postMessage({ notify: "changed", tables });
    });
  }
}

async function getDB() {
  if (!dbPromise) {
    dbPromise = (async () => {
      // Wipe the origin's OPFS before opening. This must happen BEFORE initWasm, because
      // AccessHandlePoolVFS pre-acquires its handle pool at create() time — wiping after
      // would strand those handles. Two consequences worth knowing for a spike:
      //   * it clears any leftover/locked pool files from a prior aborted run (which is
      //     what was making sqlite3_open_v2 fail on this origin), and
      //   * the DB resets whenever a fresh leader boots (including on re-election). This
      //     spike demonstrates live cross-tab sharing, not durability — persistence was
      //     already proven in opfs-spike-v1 / opfs-spike-v1-wrapper. A production owner
      //     would NOT wipe.
      const root = await navigator.storage.getDirectory();
      for await (const name of root.keys()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }

      const sqlite3 = await initWasm(undefined, { vfs: "opfs" });
      const db = await sqlite3.open("shared-multitab.db");
      await db.exec("CREATE TABLE IF NOT EXISTS todo (id PRIMARY KEY NOT NULL, text)");
      await db.exec("SELECT crsql_as_crr('todo')");
      db.onUpdate((_type, _dbName, tbl) => noteChange(tbl));
      return db;
    })();
  }
  return dbPromise;
}

self.onmessage = async (ev) => {
  const { reqId, op, sql, bind } = ev.data;
  try {
    const db = await getDB();
    let result;
    if (op === "execA") result = await db.execA(sql, bind);
    else if (op === "execO") result = await db.execO(sql, bind);
    else if (op === "exec") await db.exec(sql, bind);
    else throw new Error("unknown op " + op);
    self.postMessage({ reqId, ok: true, result });
  } catch (err) {
    self.postMessage({ reqId, ok: false, error: String(err?.stack || err) });
  }
};

// Open eagerly so tabs get a prompt ready/error signal.
getDB()
  .then(() => self.postMessage({ notify: "ready" }))
  .catch((err) => self.postMessage({ notify: "error", error: String(err?.stack || err) }));
