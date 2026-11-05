import { parseHubCommandCounter } from "../../../chrome-extension/modules/hub-command-id.js";
import { HUB_NATIVE_FRAME_MAX_BYTES, HUB_WIRE_BUFFER_MAX_BYTES } from "../../../chrome-extension/modules/hub-wire-limits.js";
import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as Peer, type RawData } from "openclaw/plugin-sdk/websocket-runtime";
import { canonicalHubOrigin } from "../../../chrome-extension/modules/hub-installation-proof.js";
import { hasExactKeys, parseStrictJsonObject } from "../../../chrome-extension/modules/strict-json.js";
import { createHubAuthorityConnection, type Invalidation, type HubAuthorityWebSocketConstructor } from "./authority-client.js";
import { parseExtensionMessage } from "../extension-relay/relay-protocol.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const id = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
type Frame = Record<string, unknown>;
type Device = { socket: Peer; browserId: string; connectionId: string; clean: boolean;
  lastPing: number; lastPong: number; ready: boolean; revoked: boolean; session?: Session };
type Session = { socket: Peer; device: Device; sessionId: string; epoch: number; grantVersion: number;
  actor: Frame; leaseExpiresAt: number; active: boolean; starting: boolean; ending: boolean;
  seq: number; eventSeq: number; lastCommandCounter: number; pending: Map<string, { deadline: number; bytes: number }>; queue: Promise<void>; pendingCommandBytes: number;
  startTimer: ReturnType<typeof setTimeout> };

/** The Hub sees authorization metadata only; all page payloads remain on this relay. */
export function attachHubBrowserRelay(server: Server, options: {
  hubOrigin: string; relayOrigin: string; relayToken: string;
  validateNativeCommand(frame: Frame): boolean;
  fetchImpl?: typeof fetch; AuthorityWebSocket?: HubAuthorityWebSocketConstructor;
  onAuthorityLost?(): void;
}) {
  const hubOrigin = canonicalHubOrigin(options.hubOrigin);
  const relayOrigin = canonicalHubOrigin(options.relayOrigin);
  const fetchImpl = options.fetchImpl ?? fetch;
  const devices = new Map<string, Device>();
  const preauth = new WeakMap<Peer, () => void>();
  const releasePreauth = (peer: Peer) => { preauth.get(peer)?.(); preauth.delete(peer); };
  const transportPongs = new Map<Peer, number>();
  let lastTransportPing = Date.now();
  const wss = new WebSocketServer({ noServer: true, maxPayload: HUB_NATIVE_FRAME_MAX_BYTES,
    perMessageDeflate: false, handleProtocols: (protocols: Set<string>) => protocols.has("agent-hub.browser.v1") ? "agent-hub.browser.v1" : false });
  let closed = false;
  const byteLength = (frame: unknown) => Buffer.byteLength(JSON.stringify(frame));
  const send = (socket: Peer, frame: Frame) => {
    const raw = JSON.stringify(frame);
    if (closed || socket.readyState !== 1 || Buffer.byteLength(raw) > HUB_NATIVE_FRAME_MAX_BYTES ||
        socket.bufferedAmount + Buffer.byteLength(raw) > HUB_WIRE_BUFFER_MAX_BYTES) {
      throw new Error("Browser relay backpressure");
    }
    socket.send(raw);
  };
  const shut = (socket: Peer) => socket.close(4001, "Browser relay session unavailable");
  const current = (session: Session) => !closed && authority.isCurrent() && session.active &&
    devices.get(session.device.browserId) === session.device && !session.device.revoked && session.device.session === session &&
    session.device.socket.readyState === 1 && session.socket.readyState === 1 && Date.now() < session.leaseExpiresAt;
  const bound = (session: Session) => ({ browserId: session.device.browserId, sessionId: session.sessionId, epoch: session.epoch });
  async function end(session: Session, reason: string, alreadyEnding = false) {
    if (session.ending) return;
    session.ending = true; session.active = false; session.pending.clear(); session.pendingCommandBytes = 0; session.device.clean = false;
    clearTimeout(session.startTimer);
    if (session.socket.readyState === 1) shut(session.socket);
    if (!authority.isCurrent()) { shut(session.device.socket); return; }
    if (!alreadyEnding) await authority.request("session.end", bound(session));
    if (devices.get(session.device.browserId) === session.device && session.device.socket.readyState === 1) {
      send(session.device.socket, { v: 1, type: "session.end", ...bound(session), reason });
    }
  }
  const lost = () => {
    for (const device of devices.values()) {
      device.clean = false;
      if (device.session) { device.session.active = false; device.session.pending.clear(); device.session.pendingCommandBytes = 0; shut(device.session.socket); }
      shut(device.socket);
    }
  };
  const authority = createHubAuthorityConnection({ hubOrigin, token: options.relayToken,
    WebSocketImpl: options.AuthorityWebSocket,
    onLost: () => { lost(); options.onAuthorityLost?.(); }, onSnapshot: () => { /* Reconnect needs fresh device.cleaned, never snapshot admission. */ },
    onInvalidate: (frame: Invalidation) => {
      const session = devices.get(frame.browserId)?.session;
      if (session?.sessionId === frame.sessionId && session.epoch === frame.epoch) {
        void end(session, frame.reason, true).catch(() => shut(session.device.socket));
      }
    },
    onBrowserInvalidated: (frame) => {
      const device = devices.get(frame.browserId);
      if (!device) return;
      device.revoked = true; device.clean = false;
      if (device.session) void end(device.session, frame.reason, true).catch(() => shut(device.socket));
      else shut(device.socket);
    },
  });
  const introspect = async (ticket: string, kind: "device" | "agent"): Promise<Frame> => {
    if (!authority.isCurrent()) throw new Error("Authority unavailable");
    const authorityId = authority.authorityId;
    const response = await fetchImpl(`${hubOrigin}/api/browser/relay/introspect`, {
      method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Hub-Relay-Token": options.relayToken },
      body: JSON.stringify({ ticket, kind, ...(kind === "agent" ? { authorityId } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Browser ticket denied");
    const raw = await response.text();
    if (!authority.isCurrent() || authority.authorityId !== authorityId || Buffer.byteLength(raw) > 8192) {
      throw new Error("Browser authority changed");
    }
    const value = parseStrictJsonObject(raw);
    if (!value || !id(value.browserId) || !id(value.accountId) || !positive(value.grantVersion)) {
      throw new Error("Invalid browser admission");
    }
    return value;
  };
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const role = request.url === "/browser/hub/device" ? "device" : request.url === "/browser/hub/agent" ? "agent" : null;
    if (closed || !role || !authority.isCurrent() || wss.clients.size >= 64 ||
        request.headers["sec-websocket-protocol"] !== "agent-hub.browser.v1" || head.length > 8192) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return;
    }
    // Count bytes before ws can assemble a large unauthenticated message. ws
    // re-emits Upgrade head via socket.unshift, so this counts that head once.
    // Large native frames are enabled only after ticket/proof authentication.
    let wireBytes = 0;
    const count = (chunk: Buffer) => { wireBytes += chunk.length; if (wireBytes > 8192) socket.destroy(); };
    const release = () => { socket.off("data", count); socket.off("close", release); };
    socket.on("data", count); socket.once("close", release);
    try {
      wss.handleUpgrade(request, socket, head, (peer: Peer) => {
        preauth.set(peer, release); wss.emit("connection", peer, request);
      });
    } catch { release(); socket.destroy(); }
  };
  server.on("upgrade", onUpgrade);
  wss.on("connection", (socket: Peer, request: IncomingMessage) => {
    const role = request.url === "/browser/hub/device" ? "device" : "agent";
    let stage: "authenticate" | "busy" | "proof" | "ready" = "authenticate";
    let alive = true;
    let metadata: Frame;
    let abandoning = false;
    let nonce: string;
    let challengeExpires = 0;
    let device: Device | undefined;
    let session: Session | undefined;
    const timeout = setTimeout(() => shut(socket), 10_000); timeout.unref();
    transportPongs.set(socket, Date.now());
    socket.on("pong", () => transportPongs.set(socket, Date.now()));
    const abandonUnstarted = () => {
      if (abandoning || role !== "agent" || session || !metadata || !id(metadata.sessionId) ||
          !positive(metadata.epoch) || !authority.isCurrent()) return;
      abandoning = true;
      const fields = { browserId: metadata.browserId, sessionId: metadata.sessionId, epoch: metadata.epoch };
      // This relay never sent session.start, so it can prove this admission
      // created no native ownership. Do not leave an unstarted lease occupied.
      void authority.request("session.end", fields).then(() => authority.request("session.cleaned", fields)).catch(() => {});
    };
    const fail = () => { if (alive) shut(socket); abandonUnstarted(); };
    socket.on("error", fail);
    socket.on("close", () => {
      alive = false; clearTimeout(timeout); releasePreauth(socket);
      transportPongs.delete(socket);
      abandonUnstarted();
      if (role === "device" && device && devices.get(device.browserId) === device) {
        devices.delete(device.browserId);
        device.clean = false;
        if (device.session) void end(device.session, "device_disconnected", true).catch(() => {});
        if (authority.isCurrent()) void authority.request("device.disconnected",
          { browserId: device.browserId, connectionId: device.connectionId }).catch(() => {});
      } else if (session && !session.ending) void end(session, "agent_disconnected").catch(() => shut(session!.device.socket));
    });
    const valid = () => alive && !closed && authority.isCurrent() && socket.readyState === 1;
    async function deviceFrame(frame: Frame) {
      if (device && hasExactKeys(frame, ["v", "type"]) && frame.type === "pong") {
        device.lastPong = Date.now(); return;
      }
      if (!device || frame.browserId !== device.browserId) throw new Error("Foreign device frame");
      if (frame.type === "device.cleaned") {
        if (!hasExactKeys(frame, ["v", "type", "browserId", "connectionId"]) || frame.connectionId !== device.connectionId || device.session) throw new Error("Invalid device cleanup");
        const reply = await authority.request("device.cleaned", { browserId: device.browserId, connectionId: device.connectionId });
        if (!valid() || (reply as Frame)?.accepted !== true || (reply as Frame)?.online === false) throw new Error("Device cleanup denied");
        device.clean = true; return;
      }
      const active = device.session;
      if (!active || frame.sessionId !== active.sessionId || frame.epoch !== active.epoch) throw new Error("Stale device session");
      if (frame.type === "session.cleaned") {
        if (!active.ending) throw new Error("Unexpected session cleanup");
        const reply = await authority.request("session.cleaned", bound(active));
        if (!valid() || (reply as Frame)?.accepted !== true) throw new Error("Session cleanup denied");
        device.session = undefined; device.clean = !device.revoked;
        if (device.revoked) shut(device.socket);
        return;
      }
      if (frame.type === "stopped") {
        active.active = false; active.pending.clear(); active.pendingCommandBytes = 0;
        await authority.request("stopped", bound(active));
        await end(active, "local_stop", true); return;
      }
      if (!current(active)) return;
      if (frame.type === "session.started") {
        if (!active.starting) throw new Error("Duplicate native start");
        const reply = await authority.request("session.started", bound(active));
        if (!valid() || !current(active) || (reply as Frame)?.accepted !== true) throw new Error("Native start denied");
        active.starting = false;
        clearTimeout(active.startTimer);
        send(active.socket, { v: 1, type: "ready", ...bound(active), grantVersion: active.grantVersion }); return;
      }
      if (active.starting) throw new Error("Native session not ready");
      if (frame.type === "event") {
        if (frame.eventSeq !== active.eventSeq + 1 || byteLength(frame) > HUB_NATIVE_FRAME_MAX_BYTES) throw new Error("Event resync required");
        const native = parseExtensionMessage(JSON.stringify(frame.frame));
        if (!native || !["hello", "tabs", "cdpEvent", "detached"].includes(native.type)) throw new Error("Invalid native event");
        active.eventSeq++; send(active.socket, frame); return;
      }
      if (frame.type === "result") {
        if (!id(frame.commandId) || !active.pending.has(frame.commandId)) return;
        const request = active.pending.get(frame.commandId)!;
        active.pending.delete(frame.commandId); active.pendingCommandBytes -= request.bytes;
        if (Date.now() > request.deadline) throw new Error("Completion deadline exceeded");
        if (Object.hasOwn(frame, "result") === Object.hasOwn(frame, "error")) throw new Error("Invalid native result");
        send(active.socket, frame); return;
      }
      throw new Error("Unknown device frame");
    }
    async function agentFrame(frame: Frame) {
      if (!session || !current(session) || session.starting || frame.sessionId !== session.sessionId ||
          !hasExactKeys(frame, ["v", "type", "sessionId", "commandId", "deadline", "method", "params"]) ||
          frame.type !== "command" || frame.method !== "relay.command" || !id(frame.commandId) ||
          !positive(frame.deadline) || frame.deadline <= Date.now() || frame.deadline > Date.now() + 30_000 ||
          !frame.params || typeof frame.params !== "object" || Array.isArray(frame.params) ||
          byteLength(frame) > HUB_NATIVE_FRAME_MAX_BYTES || !options.validateNativeCommand(frame.params as Frame)) throw new Error("Invalid agent command");
      const active = session;
      const commandId = frame.commandId;
      const counter = parseHubCommandCounter(active.sessionId, commandId);
      if (counter <= active.lastCommandCounter) throw new Error("Duplicate or regressing Hub command");
      active.lastCommandCounter = counter;
      const commandBytes = byteLength(frame);
      if (active.pendingCommandBytes + commandBytes > HUB_WIRE_BUFFER_MAX_BYTES) {
        send(active.socket, { v: 1, type: "result", ...bound(active), commandId,
          error: { code: "browser_busy", message: "Native command byte capacity exceeded" } });
        return;
      }
      if (active.pending.size >= 16) throw new Error("Browser command capacity or duplicate");
      active.pending.set(commandId, { deadline: frame.deadline, bytes: commandBytes });
      active.pendingCommandBytes += commandBytes;
      active.queue = active.queue.then(async () => {
        if (!current(active)) return;
        const permit = await authority.request("authorize", { browserId: active.device.browserId,
          sessionId: active.sessionId, grantVersion: active.grantVersion, commandId }) as Frame;
        if (!current(active)) return;
        if (permit.allowed !== true || !positive(permit.expiresAt)) throw new Error("Command authorization denied");
        const admissionDeadline = Math.min(Number(frame.deadline), permit.expiresAt, active.leaseExpiresAt);
        if (Date.now() >= admissionDeadline) throw new Error("Command admission expired");
        send(active.device.socket, { ...frame, ...bound(active), admissionDeadline,
          grantVersion: active.grantVersion, actor: active.actor, params: { ...(frame.params as Frame), seq: ++active.seq } });
      }).catch(() => end(active, "command_admission_failed")).catch(() => shut(active.device.socket));
    }
    let receiving = Promise.resolve();
    let queuedBytes = 0;
    socket.on("message", (data: RawData) => {
      const raw = Buffer.isBuffer(data) ? data.toString("utf8") : data instanceof ArrayBuffer
        ? Buffer.from(data).toString("utf8") : Buffer.concat(data).toString("utf8");
      const size = Buffer.byteLength(raw);
      queuedBytes += size;
      if (queuedBytes > HUB_WIRE_BUFFER_MAX_BYTES) return fail();
      receiving = receiving.then(async () => {
        if (!valid() || Buffer.byteLength(raw) > (stage === "ready" ? HUB_NATIVE_FRAME_MAX_BYTES : 8192)) throw new Error("Invalid relay frame size");
        const frame = parseStrictJsonObject(raw);
        if (!frame || frame.v !== 1) throw new Error("Invalid relay JSON");
        if (stage === "authenticate") {
          if (!hasExactKeys(frame, ["v", "type", "ticket"]) || frame.type !== "authenticate" ||
              typeof frame.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(frame.ticket)) throw new Error("Invalid ticket frame");
          stage = "busy"; metadata = await introspect(frame.ticket, role);
          if (!valid()) { abandonUnstarted(); return; }
          if (role === "device") {
            if (typeof metadata.publicKeySpki !== "string" || metadata.publicKeySpki.length > 512 || devices.has(String(metadata.browserId))) throw new Error("Device unavailable");
            nonce = randomBytes(32).toString("base64url"); challengeExpires = Date.now() + 30_000; stage = "proof";
            send(socket, { v: 1, type: "challenge", nonce, expiresAt: challengeExpires });
          } else {
            device = devices.get(String(metadata.browserId));
            if (!device?.clean || device.session || metadata.deviceConnectionId !== device.connectionId ||
                !id(metadata.sessionId) || !positive(metadata.epoch) || !positive(metadata.leaseExpiresAt) ||
                !metadata.actor || typeof metadata.actor !== "object") throw new Error("Browser not clean");
            session = { socket, device, sessionId: metadata.sessionId, epoch: metadata.epoch,
              grantVersion: Number(metadata.grantVersion), actor: metadata.actor as Frame, leaseExpiresAt: metadata.leaseExpiresAt,
              active: true, starting: true, ending: false, seq: 0, eventSeq: 0, lastCommandCounter: 0, pending: new Map(), queue: Promise.resolve(), pendingCommandBytes: 0, startTimer: timeout };
            device.session = session; stage = "ready"; releasePreauth(socket);
            send(device.socket, { v: 1, type: "session.start", ...bound(session), grantVersion: session.grantVersion, actor: session.actor });
          }
          return;
        }
        if (stage === "proof") {
          if (!hasExactKeys(frame, ["v", "type", "signature"]) || frame.type !== "proof" ||
              typeof frame.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(frame.signature) || Date.now() >= challengeExpires) throw new Error("Invalid device proof");
          const key = createPublicKey({ format: "der", type: "spki", key: Buffer.from(String(metadata.publicKeySpki), "base64url") });
          if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
              !verify("sha256", Buffer.from(`agent-hub.relay.v1\n${relayOrigin}\n${metadata.browserId}\n${nonce}`),
                { key, dsaEncoding: "ieee-p1363" }, Buffer.from(frame.signature, "base64url"))) throw new Error("Device proof denied");
          stage = "busy";
          const candidate = { socket, browserId: String(metadata.browserId), connectionId: randomUUID(), clean: false,
            lastPing: Date.now(), lastPong: Date.now(), ready: false, revoked: false };
          if (devices.has(candidate.browserId)) throw new Error("Device connection already exists");
          devices.set(candidate.browserId, candidate); device = candidate;
          await authority.request("device.connected", { browserId: device.browserId, connectionId: device.connectionId });
          if (!valid()) return;
          stage = "ready"; device.ready = true; clearTimeout(timeout); releasePreauth(socket);
          send(socket, { v: 1, type: "ready", browserId: device.browserId, connectionId: device.connectionId }); return;
        }
        if (stage !== "ready") throw new Error("Concurrent relay authentication");
        if (role === "device") await deviceFrame(frame); else await agentFrame(frame);
      }).catch(fail).finally(() => { queuedBytes -= size; });
    });
  });
  const maintenance = setInterval(() => {
    if (Date.now() - lastTransportPing >= 20_000) {
      lastTransportPing = Date.now();
      for (const [socket, pongAt] of transportPongs) {
        if (Date.now() - pongAt > 30_000) shut(socket);
        else if (socket.readyState === 1) socket.ping();
      }
    }
    for (const device of devices.values()) {
      if (device.ready && Date.now() - device.lastPong > 30_000) { shut(device.socket); continue; }
      if (device.ready && Date.now() - device.lastPing >= 20_000 && device.socket.readyState === 1) {
        device.lastPing = Date.now();
        try { send(device.socket, { v: 1, type: "ping" }); } catch { shut(device.socket); }
      }
      const session = device.session;
      if (!session || session.ending) continue;
      for (const request of session.pending.values()) if (Date.now() > request.deadline) {
        void end(session, "completion_deadline").catch(() => shut(device.socket)); break;
      }
      if (session.starting || !current(session)) {
        if (Date.now() >= session.leaseExpiresAt) void end(session, "lease_expired").catch(() => shut(device.socket));
      } else if (session.leaseExpiresAt - Date.now() < 40_000) {
        void authority.request("session.renew", { browserId: device.browserId, sessionId: session.sessionId }).then((lease) => {
          if (!lease || typeof lease !== "object" || !positive((lease as Frame).expiresAt)) return end(session, "lease_denied");
          session.leaseExpiresAt = Number((lease as Frame).expiresAt);
        }).catch(() => shut(device.socket));
      }
    }
  }, 5000); maintenance.unref();
  return { ready: authority.ready,
    isReady: () => !closed && authority.isCurrent(),
    async close() {
      if (closed) return;
      lost(); closed = true; clearInterval(maintenance); authority.close(); server.off("upgrade", onUpgrade);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
