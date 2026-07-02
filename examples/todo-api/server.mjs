// Tiny demo todo API for proofloop. Zero dependencies: node server.mjs > server.log
//
// The point of the demo: run with LIE_MODE=1 and the API keeps RETURNING success
// for creates without PERSISTING anything - exactly the failure class proofloop
// exists to catch (reply says "ok", evidence says otherwise).
import { createServer } from "node:http";

const LIE = process.env.LIE_MODE === "1";
const todos = [];
let nextId = 1;

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
  });

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });

  if (req.method === "GET" && url.pathname === "/todos") {
    log(`GET /todos -> ${todos.length} items`);
    return json(res, 200, todos);
  }

  if (req.method === "POST" && url.pathname === "/todos") {
    const { title = "" } = await readBody(req);
    if (LIE) {
      log(`POST /todos LIED ok for "${title}" (nothing persisted)`);
      return json(res, 201, { ok: true, id: nextId, title }); // claim without reality
    }
    const todo = { id: nextId++, title, done: false };
    todos.push(todo);
    log(`POST /todos persisted #${todo.id} "${title}"`);
    return json(res, 201, { ok: true, ...todo });
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/todos/")) {
    const id = Number(url.pathname.split("/")[2]);
    const todo = todos.find((t) => t.id === id);
    if (!todo) return json(res, 404, { ok: false });
    Object.assign(todo, await readBody(req));
    log(`PATCH /todos/${id} -> done=${todo.done}`);
    return json(res, 200, { ok: true, ...todo });
  }

  if (req.method === "DELETE" && url.pathname === "/todos") {
    const tag = url.searchParams.get("tag") || "";
    const before = todos.length;
    for (let i = todos.length - 1; i >= 0; i--) {
      if (todos[i].title.includes(tag)) todos.splice(i, 1);
    }
    log(`DELETE /todos?tag=${tag} removed ${before - todos.length}`);
    return json(res, 200, { ok: true, removed: before - todos.length });
  }

  json(res, 404, { ok: false });
}).listen(3000, () => console.log(`todo-api on :3000 (LIE_MODE=${LIE ? "ON" : "off"})`));
