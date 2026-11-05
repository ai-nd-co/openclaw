import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { expect, it } from "vitest";
import { loadHubRelayConfig, startHubRelayServer } from "./production-server.js";

const env = { HUB_ORIGIN: "https://hub.example", HUB_RELAY_ORIGIN: "https://browser.example", HUB_RELAY_TOKEN: "synthetic-relay-token-not-a-real-secret-0001" };
it("keeps public identity separate from internal Hub transport and defaults local binds", () => {
  expect(loadHubRelayConfig(env)).toMatchObject({ hubOrigin: env.HUB_ORIGIN,
    hubConnectOrigin: env.HUB_ORIGIN, host: "127.0.0.1", port: 8080 });
  expect(loadHubRelayConfig({ ...env, HUB_CONNECT_ORIGIN: "http://hub-server.namespace.svc:3000" }).hubConnectOrigin)
    .toBe("http://hub-server.namespace.svc:3000");
  for (const value of ["http://secret@hub.example/", "http://hub.example/path", "ws://hub.example/"]) {
    expect(() => loadHubRelayConfig({ ...env, HUB_CONNECT_ORIGIN: value })).toThrow();
  }
  expect(() => loadHubRelayConfig({ ...env, HUB_RELAY_TOKEN: undefined })).toThrow("Missing HUB_RELAY_TOKEN");
  expect(() => loadHubRelayConfig({ ...env, HUB_RELAY_PORT: "65536" })).toThrow("Invalid HUB_RELAY_PORT");
});

async function hubFixture() {
  const introspections: Array<{ path: string; token: string | string[] | undefined }> = [];
  const server = createServer((req, res) => {
    introspections.push({ path: req.url!, token: req.headers["x-hub-relay-token"] });
    res.writeHead(403, { "Content-Type": "application/json" }); res.end('{"error":"denied"}');
  });
  const sockets = new WebSocketServer({ server, path: "/api/browser/relay/control" });
  let resolveAuth!: (socket: import("ws").WebSocket) => void;
  const authenticated = new Promise<import("ws").WebSocket>((resolve) => { resolveAuth = resolve; });
  sockets.on("connection", (socket) => socket.once("message", (raw) => {
    const value = JSON.parse(String(raw));
    expect(value).toEqual({ v: 1, type: "authenticate", token: env.HUB_RELAY_TOKEN });
    resolveAuth(socket);
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, sockets, introspections, authenticated,
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const ready = (socket: import("ws").WebSocket) => socket.send(JSON.stringify({ v: 1,
  type: "ready", authorityId: randomUUID(), expiresAt: Date.now() + 10_000, controlSeq: 0 }));

it("actual HTTP readiness follows Hub auth; unauthenticated browser sockets get no control and authority loss closes the server", async () => {
  const hub = await hubFixture();
  let running: Awaited<ReturnType<typeof startHubRelayServer>> | undefined;
  try {
    running = await startHubRelayServer(loadHubRelayConfig({ ...env, HUB_CONNECT_ORIGIN: hub.origin, HUB_RELAY_PORT: "0" }));
    const base = `http://127.0.0.1:${(running.server.address() as { port: number }).port}`;
    const authority = await hub.authenticated;
    expect((await fetch(base + "/healthz")).status).toBe(200);
    expect((await fetch(base + "/readyz")).status).toBe(503);
    ready(authority); await running.ready;
    expect(await (await fetch(base + "/readyz")).json()).toEqual({ ready: true });
    expect((await fetch(base + "/other")).status).toBe(404);
    const denied = new WebSocket(base.replace("http:", "ws:") + "/browser/hub/device", "agent-hub.browser.v1");
    const closed = new Promise<void>((resolve) => denied.addEventListener("close", () => resolve(), { once: true }));
    denied.addEventListener("open", () => denied.send(JSON.stringify({ v: 1, type: "authenticate", ticket: "x".repeat(43) })), { once: true });
    await closed;
    expect(hub.introspections).toEqual([{ path: "/api/browser/relay/introspect", token: env.HUB_RELAY_TOKEN }]);
    authority.terminate();
    expect(await running.closed).toBe("authority_lost");
    expect(running.server.listening).toBe(false);
  } finally { await running?.close(); await hub.close(); }
});

it("normal shutdown stays normal when closing its own authority connection", async () => {
  const hub = await hubFixture();
  let running: Awaited<ReturnType<typeof startHubRelayServer>> | undefined;
  try {
    running = await startHubRelayServer(loadHubRelayConfig({ ...env, HUB_CONNECT_ORIGIN: hub.origin, HUB_RELAY_PORT: "0" }));
    ready(await hub.authenticated); await running.ready;
    await Promise.all([running.close(), running.close()]);
    expect(await running.closed).toBe("shutdown");
    expect(running.server.listening).toBe(false);
  } finally { await running?.close(); await hub.close(); }
});


it("bounds unauthenticated wire bytes before large-frame reassembly, including Upgrade head", async () => {
  const hub = await hubFixture();
  let running: Awaited<ReturnType<typeof startHubRelayServer>> | undefined;
  try {
    running = await startHubRelayServer(loadHubRelayConfig({ ...env, HUB_CONNECT_ORIGIN: hub.origin, HUB_RELAY_PORT: "0" }));
    ready(await hub.authenticated); await running.ready;
    const port = (running.server.address() as { port: number }).port;
    for (const role of ["device", "agent"]) for (const headBytes of [0, 4000]) {
      const socket = createConnection({ host: "127.0.0.1", port });
      try {
        let resolveUpgrade!: () => void;
        const upgraded = new Promise<void>((resolve) => { resolveUpgrade = resolve; });
        const closed = new Promise<void>((resolve, reject) => {
          socket.once("close", () => resolve());
          socket.setTimeout(2000, () => reject(new Error("Pre-auth frame remained buffered")));
        });
        socket.on("error", () => {});
        socket.on("data", (data) => { if (String(data).includes("101 Switching Protocols")) resolveUpgrade(); });
        await new Promise<void>((resolve) => socket.once("connect", resolve));
        const header = Buffer.alloc(14); header[0] = 0x81; header[1] = 0xff;
        header.writeBigUInt64BE(BigInt(64 * 1024 * 1024), 2); // Valid mask; deliberately incomplete large payload.
        const handshake = `GET /browser/hub/${role} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: agent-hub.browser.v1\r\n\r\n`;
        socket.write(Buffer.concat([Buffer.from(handshake), header, Buffer.alloc(headBytes)]));
        await Promise.race([upgraded, closed.then(() => { throw new Error("Upgrade did not succeed"); })]);
        socket.write(Buffer.alloc(9000 - headBytes));
        await closed;
      } finally { socket.destroy(); }
    }
    expect(hub.introspections).toEqual([]);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
  } finally { await running?.close(); await hub.close(); }
});


it("the built Node process exits on SIGTERM and heartbeat expiry even when the Hub peer never reads close frames", async () => {
  const source = fileURLToPath(new URL("../../../../../", import.meta.url));
  const component = path.join(source, "extensions/browser/relay-container");
  const output = await mkdtemp(path.join(tmpdir(), "hub-relay-process-"));
  try {
    const require = createRequire(path.join(component, "package.json"));
    await symlink(path.dirname(path.dirname(require.resolve("ws/package.json"))), path.join(output, "node_modules"), "dir");
    const build = spawn(process.execPath, [path.join(component, "build.mjs"), source, output], { stdio: "ignore" });
    expect(await new Promise((resolve) => build.once("exit", resolve))).toBe(0);
    for (const mode of ["shutdown", "expiry"]) {
      const hub = await hubFixture();
      const child = spawn(process.execPath, [path.join(output, "relay.mjs")], { env: {
        ...env, HUB_CONNECT_ORIGIN: hub.origin, HUB_RELAY_PORT: "0", HUB_RELAY_HOST: "127.0.0.1",
      }, stdio: ["ignore", "pipe", "pipe"] });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject); child.once("exit", (code) => resolve(code));
      });
      const lines = createInterface({ input: child.stdout });
      const started = new Promise<void>((resolve) => lines.on("line", (line) => {
        if (JSON.parse(line).status === "browser relay ready") resolve();
      }));
      try {
        const socket = await hub.authenticated;
        socket.send(JSON.stringify({ v: 1, type: "ready", authorityId: randomUUID(), controlSeq: 0,
          expiresAt: Date.now() + (mode === "expiry" ? 1000 : 10_000) }));
        await Promise.race([started, exited.then(() => { throw new Error("Relay exited before ready"); })]);
        socket.pause(); // Real TCP stays open; the peer cannot acknowledge a close frame.
        if (mode === "shutdown") child.kill("SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Authority transport kept Node alive")), 4000);
          })]);
          expect(result).toBe(mode === "shutdown" ? 0 : 1);
        } finally { clearTimeout(timer); }
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await exited; lines.close(); await hub.close();
      }
    }
  } finally { await rm(output, { recursive: true, force: true }); }
});
