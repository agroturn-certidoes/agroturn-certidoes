// Servidor local para testes: node serve.js  →  http://localhost:5500
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 5500;
const ROOT = __dirname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(ROOT, url === "/" ? "index.html" : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": (TYPES[path.extname(file)] || "application/octet-stream") + "; charset=utf-8" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));
