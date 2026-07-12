// Step-0 spike, wa-sqlite v1.x (rhashimoto upstream) + OPFSCoopSyncVFS.
//
// Mirrors the v0 spike (../opfs-spike/worker.js) but against the *current* upstream
// harness: SQLite 3.53, the FacadeVFS/libadapters VFS base, and the sync build
// (wa-sqlite.mjs, no Asyncify) paired with the synchronous OPFSCoopSyncVFS.
//
// Same three correctness checks + throughput benchmark, so results are directly
// comparable to the v0 run.
import Factory from "./wa-sqlite.mjs";
import * as SQLite from "./wa-sqlite/sqlite-api.js";
// AccessHandlePoolVFS (fully synchronous, fixed handle pool) rather than
// OPFSCoopSyncVFS: the latter's cooperative async locking returns SQLITE_BUSY
// mid-open, which collides with cr-sqlite's core_init auto-extension running SQL
// during sqlite3_open (that SQL can't be retried at the JS boundary) → SQLITE_ERROR.
// A fully-sync VFS lets cr-sqlite's open-time init complete in one shot.
import { AccessHandlePoolVFS } from "./wa-sqlite/examples/AccessHandlePoolVFS.js";

try { Error.stackTraceLimit = 400; } catch {}

// Surface errors the OPFSCoopSyncVFS async-open op would otherwise swallow to
// console.error (see patched OPFSCoopSyncVFS.js). These are the real cause when
// open_v2 returns SQLITE_CANTOPEN.
globalThis.__vfsError = (e) => post("      VFS async-open error: " + (e?.stack || e), "fail");

const post = (line, cls = "") => self.postMessage({ line, cls });
const ok = (m) => post("PASS  " + m, "pass");
const bad = (m) => post("FAIL  " + m, "fail");
const info = (m) => post(m, "info");

async function queryAll(sqlite3, db, sql) {
  const rows = [];
  await sqlite3.exec(db, sql, (row) => rows.push(row));
  return rows;
}

async function main() {
  let failures = 0;
  const fail = (m) => { bad(m); failures++; };

  // Clean slate so accumulated files don't mask a regression.
  info("wiping OPFS (clean slate) …");
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      try { await root.removeEntry(name, { recursive: true }); } catch {}
    }
  } catch (e) { info("OPFS wipe note: " + e); }

  info("booting wa-sqlite.mjs (v1 sync build) …");
  const module = await Factory();
  const sqlite3 = SQLite.Factory(module);

  info("creating + registering AccessHandlePoolVFS …");
  // v1 VFS API: static async create(name, module); register as default.
  const vfs = await AccessHandlePoolVFS.create("crsqlite", module);
  sqlite3.vfs_register(vfs, true);
  info(`VFS registered as "${vfs.name}" (default)`);

  const FILE = "spike.db";

  // --- 1. boot cr-sqlite on OPFS -----------------------------------------
  let db = await sqlite3.open_v2(FILE); // default VFS
  try {
    const sid = await queryAll(sqlite3, db, "SELECT quote(crsql_site_id())");
    if (sid.length && typeof sid[0][0] === "string") ok(`cr-sqlite booted on OPFS (site_id ${sid[0][0]})`);
    else fail("crsql_site_id() returned nothing");
  } catch (e) { fail("boot: " + e); }

  // --- 2. crsql_as_crr / crsql_changes over OPFS -------------------------
  const step = async (label, fn) => {
    info("→ " + label);
    try { await fn(); ok(label); return true; }
    catch (e) {
      fail(`${label}: ${e}`);
      if (e && e.stack) {
        const frames = String(e.stack).split("\n");
        const compact = []; let prev = null, run = 0;
        for (const f of frames) {
          const norm = f.replace(/:\d+:\d+/g, "").trim();
          if (norm === prev) { run++; continue; }
          if (run > 0) { compact.push(`      … ×${run + 1} (repeated)`); run = 0; }
          compact.push("      " + f.trim());
          prev = norm;
        }
        if (run > 0) compact.push(`      … ×${run + 1} (repeated)`);
        info(compact.slice(0, 40).join("\n"));
      }
      return false;
    }
  };

  await step("CREATE TABLE todo", () =>
    sqlite3.exec(db, "CREATE TABLE IF NOT EXISTS todo (id PRIMARY KEY NOT NULL, text)"));
  await step("SELECT crsql_as_crr('todo')", () =>
    sqlite3.exec(db, "SELECT crsql_as_crr('todo')"));
  await step("INSERT row 1", () =>
    sqlite3.exec(db, "INSERT INTO todo VALUES (1, 'buy milk')"));
  await step("INSERT row 2", () =>
    sqlite3.exec(db, "INSERT INTO todo VALUES (2, 'walk dog')"));
  await step("SELECT count(*) FROM todo == 2", async () => {
    const cnt = await queryAll(sqlite3, db, "SELECT count(*) FROM todo");
    if (cnt[0][0] !== 2) throw new Error(`count ${cnt[0][0]} != 2`);
  });
  await step("SELECT count(*) FROM crsql_changes > 0", async () => {
    const changes = await queryAll(sqlite3, db, "SELECT count(*) FROM crsql_changes");
    if (!(changes[0][0] > 0)) throw new Error("crsql_changes empty");
    info(`  crsql_changes rows: ${changes[0][0]}`);
  });

  let closedClean = true;
  try { await sqlite3.exec(db, "SELECT crsql_finalize()"); } catch (e) { info("finalize note: " + e); }
  try { await sqlite3.close(db); info("closed db"); }
  catch (e) { closedClean = false; info("close note: " + e); }

  // --- 3. persistence across close + reopen ------------------------------
  if (!closedClean) info("skipping reopen test — db did not close cleanly");
  else try {
    db = await sqlite3.open_v2(FILE);
    const cnt = await queryAll(sqlite3, db, "SELECT count(*) FROM todo");
    if (cnt[0][0] === 2) ok("data persisted across reopen (OPFS write-through)");
    else fail(`after reopen row count ${cnt[0][0]} != 2 — OPFS did not persist`);
    const t = await queryAll(sqlite3, db, "SELECT text FROM todo WHERE id = 1");
    if (t[0]?.[0] === "buy milk") ok('reread value correct ("buy milk")'); else fail("reread value wrong: " + JSON.stringify(t));
    try { await sqlite3.exec(db, "SELECT crsql_finalize()"); } catch {}
    await sqlite3.close(db);
  } catch (e) { fail("reopen: " + e); }

  // --- 4. throughput benchmark (compare to v0 numbers) -------------------
  if (failures === 0) {
    info("\n— benchmark (wa-sqlite v1 sync / AccessHandlePoolVFS) —");
    const N = 10000;
    let bdb;
    try {
      bdb = await sqlite3.open_v2("bench.db");
      await sqlite3.exec(bdb, "CREATE TABLE bench (id INTEGER PRIMARY KEY NOT NULL, a INTEGER, b TEXT)");
      await sqlite3.exec(bdb, "SELECT crsql_as_crr('bench')");

      let s = performance.now();
      await sqlite3.exec(bdb,
        `WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x < ${N})
         INSERT INTO bench(id, a, b) SELECT x, x * 2, 'row-' || x FROM seq`);
      const insMs = performance.now() - s;
      info(`  CRR bulk insert : ${N} rows in ${insMs.toFixed(0)} ms  →  ${Math.round(N / (insMs / 1000)).toLocaleString()} rows/s`);

      s = performance.now();
      const agg = await queryAll(sqlite3, bdb, "SELECT count(*), sum(a) FROM bench");
      info(`  full scan       : ${agg[0][0].toLocaleString()} rows in ${(performance.now() - s).toFixed(1)} ms`);

      s = performance.now();
      for (let i = 0; i < 1000; i++) await queryAll(sqlite3, bdb, `SELECT b FROM bench WHERE id = ${1 + ((i * 997) % N)}`);
      const lookupMs = performance.now() - s;
      info(`  1000 pk lookups : ${lookupMs.toFixed(0)} ms  →  ${Math.round(1000 / (lookupMs / 1000)).toLocaleString()} q/s`);

      const chg = await queryAll(sqlite3, bdb, "SELECT count(*) FROM crsql_changes");
      const pc = await queryAll(sqlite3, bdb, "PRAGMA page_count");
      const ps = await queryAll(sqlite3, bdb, "PRAGMA page_size");
      info(`  crsql_changes   : ${chg[0][0].toLocaleString()} rows`);
      info(`  db size on OPFS : ${((pc[0][0] * ps[0][0]) / 1048576).toFixed(2)} MB`);

      try { await sqlite3.exec(bdb, "SELECT crsql_finalize()"); } catch {}
      await sqlite3.close(bdb);
    } catch (e) {
      info("  benchmark error: " + e);
      try { if (bdb) await sqlite3.close(bdb); } catch {}
    }
  }

  post(failures === 0 ? "\n🟢 ALL CHECKS PASSED — cr-sqlite runs on wa-sqlite v1 / OPFSCoopSyncVFS." : `\n🔴 ${failures} CHECK(S) FAILED.`,
       failures === 0 ? "pass" : "fail");
  self.postMessage({ done: true, failures });
}

main().catch((e) => {
  post("\n🔴 UNCAUGHT: " + (e?.stack || e), "fail");
  if (e && typeof e.code !== "undefined") post(`      SQLite result code: ${e.code}`, "fail");
  self.postMessage({ done: true, failures: -1 });
});
