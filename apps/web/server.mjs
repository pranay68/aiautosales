import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.WEB_PORT ?? 3000);
const root = new URL("./public/", import.meta.url);
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"]
]);

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const relativePath = url.pathname === "/" ? "index.html" : normalize(url.pathname.replace(/^\/+/, ""));
    const filePath = join(root.pathname, relativePath);
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes.get(extname(filePath)) ?? "application/octet-stream"
    });
    response.end(body);
  } catch {
    const html = await readFile(join(root.pathname, "index.html"), "utf8");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  }
}).listen(port, () => {
  console.log(`web started on http://localhost:${port}`);
});
