import { canonicalHubOrigin } from "../../../chrome-extension/modules/hub-installation-proof.js";
import { hasExactKeys, parseStrictJsonObject } from "../../../chrome-extension/modules/strict-json.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const id = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export type DispatchPermit =
  | { allowed: true; grantVersion: number; authorizationId: string; expiresAt: number }
  | { allowed: false; error: string };
export type Invalidation = {
  browserId: string; sessionId: string; epoch: number; grantVersion: number; reason: string;
};
export type BrowserInvalidation = { browserId: string; grantVersion: number; reason: string };
// The authority owner uses this small EventTarget surface in both browser-style
// tests and the server transport. A Node transport may hard-close its own socket.
export type HubAuthoritySocket = {
  protocol: string;
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
};
export type HubAuthorityWebSocketConstructor = new (url: string, protocols: string[]) => HubAuthoritySocket;

type Rpc = "device.connected" | "device.cleaned" | "device.disconnected" | "session.started" | "session.cleaned" |
  "session.renew" | "session.end" | "stopped" | "authorize";
type Pending = { type: Rpc; grantVersion?: number; resolve(value: unknown): void;
  reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Metadata-only authority channel. Loss retires native admission before notifying callers. */
export function createHubAuthorityConnection({ hubOrigin, token, onInvalidate, onBrowserInvalidated, onSnapshot, onLost,
  WebSocketImpl = WebSocket, now = Date.now, newId = () => crypto.randomUUID(),
  setTimer = setTimeout, clearTimer = clearTimeout,
}: {
  hubOrigin: string; token: string;
  onInvalidate(frame: Invalidation): void; onSnapshot(lease: Record<string, unknown>): void;
  onBrowserInvalidated?(frame: BrowserInvalidation): void;
  onLost(): void; WebSocketImpl?: HubAuthorityWebSocketConstructor; now?: () => number; newId?: () => string;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
}) {
  const origin = canonicalHubOrigin(hubOrigin);
  if (typeof token !== "string" || token.length < 32) throw new Error("Missing Hub relay credential");
  const url = new URL("/api/browser/relay/control", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocketImpl(url.href, ["agent-hub.relay.v1"]);
  const pending = new Map<string, Pending>();
  let state: "opening" | "ready" | "closed" = "opening";
  let authorityId: string | undefined;
  let expiresAt = 0;
  let controlSeq = 0;
  let resolveReady: (value: { authorityId: string }) => void;
  let rejectReady: (reason: Error) => void;
  const ready = new Promise<{ authorityId: string }>((resolve, reject) => {
    resolveReady = resolve; rejectReady = reject;
  });
  // The owner can attach its await after creating the relay; never emit an unhandled rejection.
  void ready.catch(() => {});
  let expiryTimer: ReturnType<typeof setTimeout>;
  const fail = () => {
    if (state === "closed") return;
    state = "closed";
    clearTimer(expiryTimer);
    const error = new Error("Hub relay authority is unavailable");
    // Fail the data plane synchronously, including any already-resolved permits.
    try { onLost(); } catch { /* Callback failure cannot leave the control socket usable. */ }
    rejectReady(error);
    for (const request of pending.values()) {
      clearTimer(request.timer); request.reject(error);
    }
    pending.clear();
    socket.close(4001, "Hub authority unavailable");
  };
  expiryTimer = setTimer(fail, 10_000);
  const isCurrent = () => state === "ready" && socket.readyState === 1 && now() < expiresAt;
  const send = (frame: Record<string, unknown>) => {
    const raw = JSON.stringify(frame);
    if (socket.readyState !== 1 || Buffer.byteLength(raw) > 8192 ||
        socket.bufferedAmount + Buffer.byteLength(raw) > 64 * 1024) {
      throw new Error("Hub authority transport is full");
    }
    socket.send(raw);
  };
  const renew = (value: unknown) => {
    if (!positive(value) || value <= now() || value > now() + 15_000) {
      throw new Error("Invalid Hub authority expiry");
    }
    expiresAt = value;
    clearTimer(expiryTimer);
    expiryTimer = setTimer(fail, Math.max(1, expiresAt - now()));
  };
  socket.addEventListener("open", () => {
    try {
      if (state !== "opening" || socket.protocol !== "agent-hub.relay.v1") return fail();
      send({ v: 1, type: "authenticate", token });
    } catch { fail(); }
  });
  socket.addEventListener("message", (event) => {
    try {
      if (state === "closed") return;
      if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 8192) return fail();
      const frame = parseStrictJsonObject(event.data);
      if (!frame || frame.v !== 1) return fail();
      if (state === "opening") {
        if (!hasExactKeys(frame, ["v", "type", "authorityId", "expiresAt", "controlSeq"]) ||
            frame.type !== "ready" || !id(frame.authorityId) ||
            !Number.isSafeInteger(frame.controlSeq) || Number(frame.controlSeq) < 0) return fail();
        renew(frame.expiresAt);
        authorityId = frame.authorityId;
        controlSeq = Number(frame.controlSeq);
        state = "ready";
        resolveReady({ authorityId });
        return;
      }
      if (!isCurrent()) return fail();
      if (frame.type === "heartbeat") {
        if (!hasExactKeys(frame, ["v", "type", "authorityId", "expiresAt"]) || frame.authorityId !== authorityId) return fail();
        renew(frame.expiresAt);
        return;
      }
      if (frame.type === "invalidate") {
        if (!hasExactKeys(frame, ["v", "type", "controlSeq", "browserId", "sessionId", "epoch", "grantVersion", "reason"]) ||
            frame.controlSeq !== controlSeq + 1 || !id(frame.browserId) || !id(frame.sessionId) ||
            !positive(frame.epoch) || !positive(frame.grantVersion) ||
            typeof frame.reason !== "string" || frame.reason.length > 2048) return fail();
        controlSeq++;
        onInvalidate({ browserId: frame.browserId, sessionId: frame.sessionId,
          epoch: frame.epoch, grantVersion: frame.grantVersion, reason: frame.reason });
        return;
      }
      if (frame.type === "browser.invalidated") {
        if (!onBrowserInvalidated || !hasExactKeys(frame, ["v", "type", "controlSeq", "browserId", "grantVersion", "reason"]) ||
            frame.controlSeq !== controlSeq + 1 || !id(frame.browserId) || !positive(frame.grantVersion) ||
            typeof frame.reason !== "string" || frame.reason.length > 2048) return fail();
        controlSeq++;
        onBrowserInvalidated({ browserId: frame.browserId, grantVersion: frame.grantVersion, reason: frame.reason });
        return;
      }
      if (frame.type === "session.snapshot") {
        if (!hasExactKeys(frame, ["v", "type", "lease"]) || !frame.lease ||
            typeof frame.lease !== "object" || Array.isArray(frame.lease)) return fail();
        onSnapshot(frame.lease as Record<string, unknown>);
        return;
      }
      if (!id(frame.requestId)) return fail();
      const request = pending.get(frame.requestId);
      if (!request) return fail();
      let result: unknown;
      if (frame.type === "authorized" && request.type === "authorize") {
        if (frame.allowed === true) {
          if (!hasExactKeys(frame, ["v", "type", "requestId", "allowed", "grantVersion", "authorizationId", "expiresAt"]) ||
              frame.grantVersion !== request.grantVersion || !id(frame.authorizationId) ||
              !positive(frame.expiresAt) || frame.expiresAt <= now() || frame.expiresAt > now() + 1000) return fail();
          result = { allowed: true, grantVersion: frame.grantVersion,
            authorizationId: frame.authorizationId, expiresAt: frame.expiresAt };
        } else {
          if (!hasExactKeys(frame, ["v", "type", "requestId", "allowed", "error"]) ||
              frame.allowed !== false || typeof frame.error !== "string" || frame.error.length > 2048) return fail();
          result = { allowed: false, error: frame.error };
        }
      } else if (frame.type === "reply" && request.type !== "authorize") {
        if (frame.ok === true && hasExactKeys(frame, ["v", "type", "requestId", "ok", "result"])) result = frame.result;
        else if (frame.ok === false && hasExactKeys(frame, ["v", "type", "requestId", "ok", "error"]) &&
            typeof frame.error === "string" && frame.error.length <= 2048) {
          pending.delete(frame.requestId); clearTimer(request.timer);
          request.reject(new Error("Hub authority RPC was denied")); return;
        } else return fail();
      } else return fail();
      pending.delete(frame.requestId); clearTimer(request.timer); request.resolve(result);
    } catch { fail(); }
  });
  socket.addEventListener("close", fail);
  socket.addEventListener("error", fail);
  return {
    ready,
    isCurrent,
    get authorityId() { return authorityId; },
    close: fail,
    request(type: Rpc, fields: Record<string, unknown>): Promise<unknown> {
      if (!isCurrent()) { fail(); return Promise.reject(new Error("Hub authority is unavailable")); }
      if (pending.size >= 16) return Promise.reject(new Error("Hub authority is busy"));
      const requestId = newId();
      if (!id(requestId) || pending.has(requestId)) return Promise.reject(new Error("Invalid authority request identifier"));
      return new Promise((resolve, reject) => {
        const timer = setTimer(fail, Math.min(5000, Math.max(1, expiresAt - now())));
        pending.set(requestId, { type, grantVersion: Number(fields.grantVersion), resolve, reject, timer });
        try { send({ ...fields, v: 1, type, requestId }); } catch { fail(); }
      });
    },
  };
}
