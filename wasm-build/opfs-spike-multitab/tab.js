// Per-tab client using Web Locks leader election + BroadcastChannel.
//
// Why not a SharedWorker: in Chrome a SharedWorker can neither call OPFS
// createSyncAccessHandle (dedicated-worker-only) nor spawn a dedicated Worker
// (`Worker` is undefined in SharedWorkerGlobalScope). So instead:
//
//   * Every tab contends for an exclusive Web Lock ("cr-sqlite-leader"). The one that
//     holds it is the LEADER and is the only tab that opens the DB — it spawns a
//     dedicated Worker (db-owner.js) which holds the single cr-sqlite/OPFS connection.
//   * Non-leader tabs send queries to the leader over a BroadcastChannel and await
//     results on the same channel.
//   * cr-sqlite onUpdate (in the owner) is broadcast so every tab refreshes live.
//   * If the leader tab closes, its Web Lock releases and a waiting tab becomes the new
//     leader and spawns its own owner. (Single connection preserved throughout.)
//
// This is the Capacitor/Android-compatible design (no SharedWorker needed).
const tabId = Math.random().toString(36).slice(2, 7);
const logEl = document.getElementById("log");
const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
document.getElementById("tabid").textContent = tabId;
const log = (m) => { const d = document.createElement("div"); d.textContent = m; logEl.prepend(d); };

const channel = new BroadcastChannel("cr-sqlite-multitab");

let isLeader = false;
let ownerWorker = null;

// ---- leader side: talk directly to the owned dedicated Worker ----
const workerPending = new Map();
let wReq = 1;
function workerCall(op, sql, bind) {
  return new Promise((resolve, reject) => {
    const reqId = wReq++;
    workerPending.set(reqId, { resolve, reject });
    ownerWorker.postMessage({ reqId, op, sql, bind });
  });
}

function becomeLeader() {
  isLeader = true;
  statusEl.textContent = "LEADER — owns the DB connection";
  statusEl.className = "ok";
  log("👑 became leader; spawning DB owner worker");
  ownerWorker = new Worker(new URL("./db-owner.js", import.meta.url), { type: "module" });
  ownerWorker.onmessage = (ev) => {
    const { reqId, ok, result, error, notify, tables } = ev.data;
    if (reqId != null) {
      const p = workerPending.get(reqId);
      if (p) { workerPending.delete(reqId); ok ? p.resolve(result) : p.reject(new Error(error)); }
      return;
    }
    if (notify === "ready") { refresh(); }
    else if (notify === "error") { statusEl.textContent = "owner error: " + error; statusEl.className = "fail"; log(error); }
    else if (notify === "changed") {
      // fan out to other tabs, and refresh ourselves (BroadcastChannel doesn't echo).
      channel.postMessage({ type: "changed", tables });
      onChanged(tables);
    }
  };
}

// ---- non-leader side: request/response over the channel ----
const channelPending = new Map();
let cReq = 1;
function channelCall(op, sql, bind) {
  return new Promise((resolve, reject) => {
    const reqId = `${tabId}:${cReq++}`;
    channelPending.set(reqId, { resolve, reject });
    channel.postMessage({ type: "query", reqId, op, sql, bind });
    setTimeout(() => {
      if (channelPending.delete(reqId)) reject(new Error("leader timeout (re-election?)"));
    }, 5000);
  });
}

channel.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === "query") {
    if (!isLeader) return; // only the leader serves queries
    try {
      const result = await workerCall(m.op, m.sql, m.bind);
      channel.postMessage({ type: "result", reqId: m.reqId, ok: true, result });
    } catch (e) {
      channel.postMessage({ type: "result", reqId: m.reqId, ok: false, error: String(e) });
    }
  } else if (m.type === "result") {
    const p = channelPending.get(m.reqId);
    if (p) { channelPending.delete(m.reqId); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)); }
  } else if (m.type === "changed") {
    onChanged(m.tables);
  }
};

// unified query entrypoint
async function query(op, sql, bind) {
  return isLeader ? workerCall(op, sql, bind) : channelCall(op, sql, bind);
}

function onChanged(tables) {
  log(`↺ change: [${tables.join(", ")}]`);
  if (tables.includes("todo")) refresh();
}

async function refresh() {
  try {
    const rows = await query("execA", "SELECT id, text FROM todo ORDER BY id");
    listEl.innerHTML = "";
    for (const [id, text] of rows) {
      const li = document.createElement("li");
      li.textContent = `#${id}  ${text}`;
      listEl.appendChild(li);
    }
  } catch (e) { log("refresh failed: " + e); }
}

document.getElementById("add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("text");
  const text = input.value.trim();
  if (!text) return;
  const id = Date.now() % 1000000;
  input.value = "";
  try {
    await query("exec", "INSERT INTO todo VALUES (?, ?)", [id, text]);
    log(`＋ inserted #${id} "${text}"`);
    // The owner's change broadcast refreshes every tab (including this one).
  } catch (e) { log("insert failed: " + e); }
});

// Contend for leadership. The callback runs when THIS tab holds the lock; returning a
// never-resolving promise holds it for the tab's lifetime (released on tab close →
// triggers re-election in a waiting tab).
navigator.locks.request("cr-sqlite-leader", () => {
  becomeLeader();
  return new Promise(() => {});
});

// Until we win leadership we're a follower; show that and try an initial render (routed
// to whoever is leader).
statusEl.textContent = "follower — routing to leader";
statusEl.className = "";
setTimeout(() => { if (!isLeader) refresh(); }, 300);
