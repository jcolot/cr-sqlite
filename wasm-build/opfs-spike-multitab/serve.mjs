// Minimal static server for the OPFS spike.
// Sets correct MIME for .mjs (module scripts) and .wasm — python's http.server does not,
// and browsers hard-fail module/wasm loads on a wrong MIME type.
// No COOP/COEP needed: AccessHandlePoolVFS is SAB-free.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 8712;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(req.url.split("?")[0]));
    if (p === "/" || p === "\\") p = "/index.html";
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      "cache-control": "no-store", // iterating on the spike — never serve stale modules
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => console.log(`OPFS spike → http://localhost:${PORT}/`));
