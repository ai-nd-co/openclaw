import { createServer } from "node:http";
import { WebSocket as NodeWebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { canonicalHubOrigin } from "../../../chrome-extension/modules/hub-installation-proof.js";
import { isHubNativeCommand } from "../../../chrome-extension/modules/hub-method-policy.js";
import { attachHubBrowserRelay } from "./relay-server.js";
import { safeRelayErrorCode, type HubRelayDiagnostic } from "./startup-diagnostics.js";

export type HubRelayConfig = {
  hubOrigin: string;
  hubConnectOrigin: string;
  relayOrigin: string;
  relayToken: string;
  host: string;
  port: number;
};

export function loadHubRelayConfig(env: Record<string, string | undefined>): HubRelayConfig {
  const required = (name: string) => {
    const value = env[name];
    if (!value?.trim()) throw new Error(`Missing ${name}`);
    return value;
  };
  const hubOrigin = canonicalHubOrigin(required("HUB_ORIGIN"));
  const relayOrigin = canonicalHubOrigin(required("HUB_RELAY_ORIGIN"));
  const connect = new URL(env.HUB_CONNECT_ORIGIN ?? hubOrigin);
  if (!["https:", "http:"].includes(connect.protocol) || connect.username || connect.password ||
      connect.pathname !== "/" || connect.search || connect.hash) {
    throw new Error("HUB_CONNECT_ORIGIN must be an HTTP(S) origin without credentials or a path");
  }
  const port = Number(env.HUB_RELAY_PORT ?? "8080");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid HUB_RELAY_PORT");
  return { hubOrigin, hubConnectOrigin: connect.origin, relayOrigin,
    relayToken: required("HUB_RELAY_TOKEN"), host: env.HUB_RELAY_HOST ?? "127.0.0.1", port };
}

// Canonical public identity remains unchanged; only the operator-selected server
// transport uses the cluster Service. Browser commands and URLs are not examined.
function hubTransport(config: HubRelayConfig, report: (diagnostic: HubRelayDiagnostic) => void) {
  const map = (raw: string | URL, socket: boolean) => {
    const input = new URL(String(raw));
    const expected = new URL(config.hubOrigin);
    const target = new URL(config.hubConnectOrigin);
    if (socket) {
      expected.protocol = expected.protocol === "https:" ? "wss:" : "ws:";
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    }
    if (input.origin !== expected.origin) throw new Error("Unexpected Hub transport destination");
    return new URL(input.pathname + input.search, target);
  };
  class AuthoritySocket extends NodeWebSocket {
    constructor(url: string, protocols: string[]) {
      super(map(url, true), protocols);
      this.once("open", () => report({ stage: "hub_socket", event: "open",
        protocolMatches: this.protocol === "agent-hub.relay.v1" }));
      this.once("error", (error) => report({ stage: "hub_socket", event: "error", code: safeRelayErrorCode(error) }));
      this.once("unexpected-response", (_request, response) => {
        report({ stage: "hub_socket", event: "upgrade_rejected", status: response.statusCode });
        response.resume(); this.terminate();
      });
      this.once("close", (code) => report({ stage: "hub_socket", event: "closed", closeCode: code }));
    }
    // Authority is already invalidated before close. Do not keep the process
    // alive waiting for a stalled peer to acknowledge a WebSocket close frame.
    override close() { this.terminate(); }
  }
  const fetchImpl: typeof fetch = (input, init) => {
    const raw = input instanceof Request ? input.url : input;
    return fetch(map(raw, false), init);
  };
  return { AuthorityWebSocket: AuthoritySocket, fetchImpl };
}

export async function startHubRelayServer(config: HubRelayConfig,
  report: (diagnostic: HubRelayDiagnostic) => void = () => {}) {
  let relay: ReturnType<typeof attachHubBrowserRelay> | undefined;
  let closing: Promise<void> | undefined;
  let resolveClosed!: (reason: "shutdown" | "authority_lost") => void;
  const closed = new Promise<"shutdown" | "authority_lost">((resolve) => { resolveClosed = resolve; });
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200); response.end('{"ok":true}');
    } else if (request.method === "GET" && request.url === "/readyz") {
      const ready = relay?.isReady() === true;
      response.writeHead(ready ? 200 : 503); response.end(JSON.stringify({ ready }));
    } else { response.writeHead(404); response.end('{"error":"not_found"}'); }
  });
  const close = (reason: "shutdown" | "authority_lost" = "shutdown") => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      try {
        try { await relay?.close(); }
        finally {
          server.closeAllConnections();
          if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
      } finally { resolveClosed(reason); }
    });
    return closing;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject); report({ stage: "http", event: "listening" }); resolve();
      });
    });
    relay = attachHubBrowserRelay(server, { ...hubTransport(config, report), hubOrigin: config.hubOrigin,
      relayOrigin: config.relayOrigin, relayToken: config.relayToken, validateNativeCommand: isHubNativeCommand,
      onAuthorityLost: () => { void close("authority_lost").catch(() => {}); } });
    return { server, ready: relay.ready, closed, close };
  } catch (error) { await close(); throw error; }
}
