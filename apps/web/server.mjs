import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.WEB_PORT ?? 3000);
const root = new URL("./public/", import.meta.url);

createServer(async (_request, response) => {
  const html = await readFile(join(root.pathname, "index.html"), "utf8");
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}).listen(port, () => {
  console.log(`web started on http://localhost:${port}`);
});

