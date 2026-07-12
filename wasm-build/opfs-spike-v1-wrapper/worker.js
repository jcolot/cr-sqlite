// Wrapper-repoint validation, wa-sqlite v1.x.
//
// Drives the ACTUAL @vlcn.io/crsqlite-wasm DB/TX/Stmt facade (compiled to
// wrapper-bundle.js from the repointed source, with tiny stubs for async-mutex and
// @vlcn.io/xplat-api) against the v1 module + AccessHandlePoolVFS. This exercises the
// code the repoint changed end-to-end: initWasm/VFS wiring, TX.statements() over v1's
// statements() iterator, TX.prepare() via the unscoped iterator, Stmt lifecycle,
// createFunction (value/result), onUpdate (update_hook), tx() savepoints, and
// close/reopen persistence.
import initWasm from "./wrapper-bundle.js";

try { Error.stackTraceLimit = 200; } catch {}
const post = (line, cls = "") => self.postMessage({ line, cls });
const ok = (m) => post("PASS  " + m, "pass");
const info = (m) => post(m, "info");
let failures = 0;
const check = async (label, fn) => {
  info("→ " + label);
  try { await fn(); ok(label); }
  catch (e) { post(`FAIL  ${label}: ${e?.stack || e}`, "fail"); failures++; }
};

async function main() {
  info("wiping OPFS (clean slate) …");
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) { try { await root.removeEntry(name, { recursive: true }); } catch {} }
  } catch (e) { info("wipe note: " + e); }

  info("initWasm({ vfs: 'opfs' }) — repointed onto wa-sqlite v1 …");
  const sqlite3 = await initWasm(undefined, { vfs: "opfs" });

  const FILE = "wrapper-spike.db";
  // open() internally uses TX.prepare (unscoped iterator) for tables_used + execA for
  // site_id — so a successful open already exercises the repointed prepare path.
  let db = await sqlite3.open(FILE);
  info(`opened via facade; siteid=${db.siteid}`);
  ok("DB.open (exercises TX.prepare + execA on v1)");

  await check("exec: CREATE TABLE + crsql_as_crr", async () => {
    await db.exec("CREATE TABLE IF NOT EXISTS todo (id PRIMARY KEY NOT NULL, text)");
    await db.exec("SELECT crsql_as_crr('todo')");
  });

  await check("exec with bind params (TX.statements + bind)", async () => {
    await db.exec("INSERT INTO todo VALUES (?, ?)", [1, "buy milk"]);
    await db.exec("INSERT INTO todo VALUES (?, ?)", [2, "walk dog"]);
  });

  await check("execA returns array rows", async () => {
    const rows = await db.execA("SELECT id, text FROM todo ORDER BY id");
    if (JSON.stringify(rows) !== JSON.stringify([[1, "buy milk"], [2, "walk dog"]]))
      throw new Error("unexpected: " + JSON.stringify(rows));
  });

  await check("execO returns object rows", async () => {
    const rows = await db.execO("SELECT id, text FROM todo WHERE id = 1");
    if (rows[0]?.text !== "buy milk") throw new Error("unexpected: " + JSON.stringify(rows));
  });

  await check("crsql_changes non-empty", async () => {
    const n = await db.execA("SELECT count(*) FROM crsql_changes");
    if (!(n[0][0] > 0)) throw new Error("crsql_changes empty");
    info(`  crsql_changes rows: ${n[0][0]}`);
  });

  await check("prepare() + Stmt.all/get (unscoped iterator path)", async () => {
    const stmt = await db.prepare("SELECT text FROM todo WHERE id > ? ORDER BY id");
    stmt.bind([0]);
    const all = await stmt.all(null);
    if (all.length !== 2) throw new Error("all(): " + JSON.stringify(all));
    await stmt.finalize(null); // exercises Stmt.finalize without str_finish
  });

  await check("createFunction (create_function/value/result)", async () => {
    db.createFunction("addone", (x) => x + 1);
    const r = await db.execA("SELECT addone(41)");
    if (r[0][0] !== 42) throw new Error("addone → " + JSON.stringify(r));
  });

  await check("onUpdate (update_hook fires)", async () => {
    let fired = null;
    const off = db.onUpdate((type, dbName, tbl, rowid) => { fired = { type, tbl, rowid }; });
    await db.exec("INSERT INTO todo VALUES (?, ?)", [3, "water plants"]);
    off();
    // cr-sqlite CRRs route physical writes to backing tables (todo__crsql_pks /
    // todo__crsql_clock), so the update hook reports those, not "todo". Assert it
    // fired with a todo-related table name and a bigint rowid.
    if (!fired || !String(fired.tbl).startsWith("todo") || typeof fired.rowid !== "bigint")
      throw new Error("hook did not fire as expected: " + JSON.stringify(fired, (k, v) => typeof v === "bigint" ? v.toString() : v));
    info(`  update hook fired: type=${fired.type} tbl=${fired.tbl} rowid=${fired.rowid}`);
  });

  await check("tx() savepoint commit + rollback", async () => {
    await db.tx(async (tx) => { await tx.exec("INSERT INTO todo VALUES (?, ?)", [10, "committed"]); });
    try {
      await db.tx(async (tx) => {
        await tx.exec("INSERT INTO todo VALUES (?, ?)", [11, "rolled back"]);
        throw new Error("boom");
      });
    } catch {}
    const has10 = await db.execA("SELECT count(*) FROM todo WHERE id = 10");
    const has11 = await db.execA("SELECT count(*) FROM todo WHERE id = 11");
    if (has10[0][0] !== 1 || has11[0][0] !== 0) throw new Error(`commit/rollback wrong: 10=${has10[0][0]} 11=${has11[0][0]}`);
  });

  const beforeClose = (await db.execA("SELECT count(*) FROM todo"))[0][0];
  await check("DB.close", async () => { await db.close(); });

  await check("reopen persists (OPFS write-through via facade)", async () => {
    db = await sqlite3.open(FILE);
    const after = (await db.execA("SELECT count(*) FROM todo"))[0][0];
    if (after !== beforeClose) throw new Error(`row count ${after} != ${beforeClose}`);
    info(`  ${after} rows survived close+reopen`);
    await db.close();
  });

  post(failures === 0
    ? "\n🟢 WRAPPER REPOINT VERIFIED — @vlcn.io/crsqlite-wasm facade runs on wa-sqlite v1."
    : `\n🔴 ${failures} CHECK(S) FAILED.`, failures === 0 ? "pass" : "fail");
  self.postMessage({ done: true, failures });
}

main().catch((e) => { post("\n🔴 UNCAUGHT: " + (e?.stack || e), "fail"); self.postMessage({ done: true, failures: -1 }); });
