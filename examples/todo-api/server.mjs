// Tiny demo todo API for proofloop. Zero dependencies: node server.mjs > server.log
//
// The liar's gym: four ways to lie, one per failure class proofloop catches.
//   LIE_MODE=1   - the API returns success for creates without persisting anything
//                  (reply says "ok", every evidence surface says otherwise)
//   STALE_UI=1   - the API and data are HONEST, but the web UI at / renders a
//                  snapshot frozen at boot (reply ok, API ok, user sees nothing)
//   LOG_LIE=1    - nothing persists, but the LOG claims it did (reply ok, log ok,
//                  state says otherwise - the judge must weigh state over logs)
//   PARTIAL=1    - persists the todo but DROPS the title (reply echoes the full
//                  title back; state exists but the data is mangled - and the
//                  orphan is untagged, so tag-based cleanup cannot sweep it)
import { createServer } from "node:http";

const LIE = process.env.LIE_MODE === "1";
const STALE_UI = process.env.STALE_UI === "1";
const LOG_LIE = process.env.LOG_LIE === "1";
const PARTIAL = process.env.PARTIAL === "1";
const todos = [];
const bootSnapshot = [];   // what the stale UI is stuck rendering
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

  if (req.method === "GET" && url.pathname === "/") {
    const list = STALE_UI ? bootSnapshot : todos;
    log(`GET / rendered ${list.length} todos${STALE_UI ? " (STALE_UI snapshot)" : ""}`);
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><html><head><title>Todos</title></head><body>
<h1>Todos</h1>
<ul id="todo-list">${list.map((t) => `<li>${t.title}${t.done ? " (done)" : ""}</li>`).join("")}</ul>
<p id="count">${list.length} todo(s)</p>
</body></html>`);
  }

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
    if (LOG_LIE) {
      log(`POST /todos persisted #${nextId} "${title}" at ${new Date().toISOString()}`); // the log lies
      return json(res, 201, { ok: true, id: nextId, title });                            // nothing persisted
    }
    if (PARTIAL) {
      const todo = { id: nextId++, title: "", done: false, createdAt: new Date().toISOString() };
      todos.push(todo);                                        // persists, but the title (and its tag) is gone
      log(`POST /todos persisted #${todo.id} "" (title dropped)`);
      return json(res, 201, { ok: true, ...todo, title });     // reply echoes the full title back
    }
    const todo = { id: nextId++, title, done: false, createdAt: new Date().toISOString() };
    todos.push(todo);
    log(`POST /todos persisted #${todo.id} "${title}" at ${todo.createdAt}`);
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

  if (req.method === "DELETE" && /^\/todos\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split("/")[2]);
    const idx = todos.findIndex((t) => t.id === id);
    if (idx === -1) {
      log(`DELETE /todos/${id} -> 404 (no such todo)`);
      return json(res, 404, { ok: false });
    }
    const [removed] = todos.splice(idx, 1);
    log(`DELETE /todos/${id} removed "${removed.title}"`);
    return json(res, 200, { ok: true, removed: id });
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
