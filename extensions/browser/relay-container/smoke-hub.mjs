// Synthetic authority for the CI image smoke only; never copied into the image.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
const token = process.env.SMOKE_RELAY_TOKEN;
if (!token) throw new Error("Synthetic relay token required");
const http = createServer((request, response) => {
  const health = request.method === "GET" && request.url === "/healthz";
  response.writeHead(health ? 200 : 403, { "Content-Type": "application/json" });
  response.end(health ? '{"ok":true}' : '{"error":"denied"}');
});
const wss = new WebSocketServer({ server: http, path: "/api/browser/relay/control" });
wss.on("connection", (socket) => {
  let accepted = false;
  let timer;
  socket.on("message", (raw) => {
    if (accepted) return socket.close();
    let frame; try { frame = JSON.parse(String(raw)); } catch { return socket.close(); }
    if (frame.v !== 1 || frame.type !== "authenticate" || frame.token !== token) return socket.close();
    accepted = true;
    const authorityId = randomUUID();
    socket.send(JSON.stringify({ v: 1, type: "ready", authorityId, controlSeq: 0, expiresAt: Date.now() + 10_000 }));
    timer = setInterval(() => socket.send(JSON.stringify({ v: 1, type: "heartbeat", authorityId, expiresAt: Date.now() + 10_000 })), 5_000);
  });
  socket.on("close", () => clearInterval(timer));
});
http.listen(8081, "0.0.0.0");
