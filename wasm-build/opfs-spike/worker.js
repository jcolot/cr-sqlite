// Step-0 OPFS spike — DB logic, runs inside a Web Worker.
//
// Self-contained: loads the freshly-built crsqlite.mjs (emscripten module) directly and
// the matching wa-sqlite JS API, registers AccessHandlePoolVFS (SAB-free OPFS), and runs
// the real cr-sqlite path (crsql_as_crr / crsql_changes) with a close+reopen persistence
// check. No @vlcn.io/crsqlite-wasm wrapper, no monorepo, no Cypress.
//
// OPFS createSyncAccessHandle is Worker-only in some browsers, which is why this lives in
// a Worker (also the Capacitor-production shape).
// Sync build (no Asyncify) — correct pairing for the synchronous AccessHandlePoolVFS,
// and it avoids Asyncify's per-frame wasm-stack bloat that overflowed on crsql_as_crr.
// NOTE: requires `const async = false` in wa-sqlite/sqlite-api.js.
import Factory from "./crsqlite-sync.mjs";
import * as SQLite from "./wa-sqlite/sqlite-api.js";
import { AccessHandlePoolVFS } from "./wa-sqlite/examples/AccessHandlePoolVFS.js";

// Capture deep stacks so an overflow shows the full recursion cycle (not just 10 frames).
try { Error.stackTraceLimit = 400; } catch {}

const post = (line, cls = "") => self.postMessage({ line, cls });
const ok = (m) => post("PASS  " + m, "pass");
const bad = (m) => post("FAIL  " + m, "fail");
const info = (m) => post(m, "info");

// Collect all rows of a query into an array of value-arrays.
async function queryAll(sqlite3, db, sql) {
  const rows = [];
  await sqlite3.exec(db, sql, (row) => rows.push(row));
  return rows;
}

async function main() {
  let failures = 0;
  const fail = (m) => { bad(m); failures++; };

  // Wipe OPFS before constructing the VFS so every run starts from a clean pool.
  // AccessHandlePoolVFS keeps a *fixed-capacity* pool and persists MAIN_DB files across
  // sessions; without this, accumulated spike DBs exhaust the pool and open_v2 fails.
  info("wiping OPFS (clean slate) …");
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      try { await root.removeEntry(name, { recursive: true }); } catch {}
    }
  } catch (e) { info("OPFS wipe note: " + e); }

  info("booting crsqlite.mjs …");
  const module = await Factory();
  const sqlite3 = SQLite.Factory(module);

  info("registering AccessHandlePoolVFS (OPFS) …");
  const vfs = new AccessHandlePoolVFS("/crsqlite-opfs");
  await vfs.isReady;
  sqlite3.vfs_register(vfs, false);
  info(`VFS registered as "${vfs.name}"`);

  // Fixed filename — safe now that we wipe OPFS at startup (idempotent across runs).
  const FILE = "spike.db";
  const OPEN = SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_URI;

  // --- 1. boot cr-sqlite on OPFS -----------------------------------------
  let db = await sqlite3.open_v2(FILE, OPEN, vfs.name);
  try {
    const sid = await queryAll(sqlite3, db, "SELECT quote(crsql_site_id())");
    if (sid.length && typeof sid[0][0] === "string") ok(`cr-sqlite booted on OPFS (site_id ${sid[0][0]})`);
    else fail("crsql_site_id() returned nothing");
  } catch (e) { fail("boot: " + e); }

  // --- 2. crsql_as_crr / crsql_changes over OPFS -------------------------
  // Granular per-statement steps so a failure pinpoints the exact SQL/code path.
  const step = async (label, fn) => {
    info("→ " + label);
    try { await fn(); ok(label); return true; }
    catch (e) {
      fail(`${label}: ${e}`);
      // Dump the (unminified) stack so a recursion/signature failure names the path.
      if (e && e.stack) {
        const frames = String(e.stack).split("\n");
        // De-dupe consecutive repeats to expose the recursion cycle compactly.
        const compact = [];
        let prev = null, run = 0;
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

  // cr-sqlite requires a non-nullable primary key for a CRR. A bare `id PRIMARY KEY`
  // is nullable in SQLite unless declared NOT NULL — so declare it.
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

  // cr-sqlite requires finalize before close
  let closedClean = true;
  try { await sqlite3.exec(db, "SELECT crsql_finalize()"); } catch (e) { info("finalize note: " + e); }
  try { await sqlite3.close(db); info("closed db"); }
  catch (e) { closedClean = false; info("close note (expected after a mid-run failure): " + e); }

  // --- 3. persistence across close + reopen ------------------------------
  if (!closedClean) info("skipping reopen test — db did not close cleanly");
  else try {
    db = await sqlite3.open_v2(FILE, OPEN, vfs.name);
    const cnt = await queryAll(sqlite3, db, "SELECT count(*) FROM todo");
    if (cnt[0][0] === 2) ok("data persisted across reopen (OPFS write-through)");
    else fail(`after reopen row count ${cnt[0][0]} != 2 — OPFS did not persist`);

    const t = await queryAll(sqlite3, db, "SELECT text FROM todo WHERE id = 1");
    if (t[0]?.[0] === "buy milk") ok('reread value correct ("buy milk")'); else fail("reread value wrong: " + JSON.stringify(t));
    try { await sqlite3.exec(db, "SELECT crsql_finalize()"); } catch {}
    await sqlite3.close(db);
  } catch (e) { fail("reopen: " + e); }

  // --- 4. throughput benchmark (Step 1) ----------------------------------
  // Same code path on desktop Chrome and inside the Android Capacitor WebView, so the
  // two numbers are directly comparable. Measures cr-sqlite's CRR write path + scans
  // over OPFS — the "is WASM/OPFS fast enough vs native?" question.
  if (failures === 0) {
    info("\n— benchmark (identical on desktop + Android WebView) —");
    const N = 10000;
    let bdb;
    try {
      bdb = await sqlite3.open_v2("bench.db", OPEN, vfs.name);
      await sqlite3.exec(bdb, "CREATE TABLE bench (id INTEGER PRIMARY KEY NOT NULL, a INTEGER, b TEXT)");
      await sqlite3.exec(bdb, "SELECT crsql_as_crr('bench')");

      // Bulk insert N rows in one transaction (OPFS-write / CRR-trigger bound).
      let s = performance.now();
      await sqlite3.exec(bdb,
        `WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x < ${N})
         INSERT INTO bench(id, a, b) SELECT x, x * 2, 'row-' || x FROM seq`);
      const insMs = performance.now() - s;
      info(`  CRR bulk insert : ${N} rows in ${insMs.toFixed(0)} ms  →  ${Math.round(N / (insMs / 1000)).toLocaleString()} rows/s`);

      // Full-table scan.
      s = performance.now();
      const agg = await queryAll(sqlite3, bdb, "SELECT count(*), sum(a) FROM bench");
      info(`  full scan       : ${agg[0][0].toLocaleString()} rows in ${(performance.now() - s).toFixed(1)} ms`);

      // Point lookups by PK (index path).
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

  post(failures === 0 ? "\n🟢 ALL CHECKS PASSED — cr-sqlite runs on OPFS." : `\n🔴 ${failures} CHECK(S) FAILED.`,
       failures === 0 ? "pass" : "fail");
  self.postMessage({ done: true, failures });
}

main().catch((e) => { post("\n🔴 UNCAUGHT: " + (e?.stack || e), "fail"); self.postMessage({ done: true, failures: -1 }); });
