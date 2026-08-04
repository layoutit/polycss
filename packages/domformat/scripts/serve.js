import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 4178);
const types = new Map([
  [".css", "text/css; charset=utf-8"],
  [".json", "application/octet-stream"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const target = resolve(root, `.${pathname === "/" ? "/viewer/index.html" : pathname}`);
    if (!(target === root || target.startsWith(`${root}${sep}`))) throw new Error("path escapes root");
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": info.size,
      "content-type": types.get(extname(target)) ?? "application/octet-stream",
    });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`domformat server http://127.0.0.1:${port}/ root=${root}\n`);
});
