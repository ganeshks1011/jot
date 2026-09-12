import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const PORT = 5173;
const ROOT = new URL("../public/", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url ?? "/", `http://localhost:${PORT}`).pathname);
  const filePath = normalize(join(ROOT, urlPath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    res.writeHead(301, { Location: `${urlPath.replace(/\/?$/, "/")}test-page.html` }).end();
    return;
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }

  res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log("Writeflo test page:");
  console.log(`  http://localhost:${PORT}/test-page.html`);
  console.log("\nLoad .output/chrome-mv3 as an unpacked extension, then open the URL above.");
  console.log("Press Ctrl+C to stop.");
});
