import { hubCommandId } from "../../../chrome-extension/modules/hub-command-id.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createHubAuthorityConnection } from "./authority-client.js";

class Socket {
  static instance: Socket;
  protocol = "agent-hub.relay.v1";
  readyState = 0;
  bufferedAmount = 0;
  events = new Map<string, (event?: {data:string}) => void>();
  sent: Record<string, unknown>[] = [];
  constructor() { Socket.instance = this; }
  addEventListener(name: string, callback: (event?: {data:string}) => void) { this.events.set(name, callback); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close(code = 1000) {
    expect(code === 1000 || (code >= 3000 && code <= 4999)).toBe(true);
    this.readyState=3; this.events.get("close")?.();
  }
  open() { this.readyState=1; this.events.get("open")?.(); }
  receive(frame: unknown) { this.events.get("message")?.({data:JSON.stringify(frame)}); }
}
const authorityId = randomUUID();
const browserId = randomUUID();
const sessionId = randomUUID();
function fixture() {
  let lost = 0;
  const invalidations: unknown[] = [];
  const browserInvalidations: unknown[] = [];
  const client = createHubAuthorityConnection({hubOrigin:"https://hub.example",token:"synthetic-service-secret-1234567890",
    now:()=>1000,WebSocketImpl:Socket as unknown as typeof WebSocket,
    onLost:()=>{lost++;},onInvalidate:(frame)=>invalidations.push(frame),onBrowserInvalidated:(frame)=>browserInvalidations.push(frame),onSnapshot:()=>{},
  });
  const socket=Socket.instance;
  socket.open();
  socket.receive({v:1,type:"ready",authorityId,expiresAt:16_000,controlSeq:0});
  return {client,socket,invalidations,browserInvalidations,get lost(){return lost;}};
}

it("correlates one-second permits and immediately fences a lost authority", async () => {
  const f=fixture();
  try {
    await f.client.ready;
    const pending=f.client.request("authorize",{browserId,sessionId,grantVersion:1,commandId:hubCommandId(sessionId, 1)});
    const request=f.socket.sent.at(-1)!;
    f.socket.receive({v:1,type:"authorized",requestId:request.requestId,allowed:true,grantVersion:1,
      authorizationId:randomUUID(),expiresAt:2000});
    expect(await pending).toMatchObject({allowed:true,expiresAt:2000});
    f.socket.close();
    expect(f.client.isCurrent()).toBe(false);
    expect(f.lost).toBe(1);
    await expect(f.client.request("authorize",{browserId})).rejects.toThrow("unavailable");
  } finally {f.client.close();}
});

it("a control sequence gap rejects pending permits and never calls the invalidation consumer", async () => {
  const f=fixture();
  try {
    await f.client.ready;
    const pending=f.client.request("authorize",{browserId,sessionId,grantVersion:1,commandId:hubCommandId(sessionId, 1)});
    const rejected=expect(pending).rejects.toThrow("unavailable");
    f.socket.receive({v:1,type:"invalidate",controlSeq:2,browserId,sessionId,epoch:1,grantVersion:2,reason:"revoked"});
    await rejected;
    expect(f.client.isCurrent()).toBe(false);
    expect(f.invalidations).toEqual([]);
  } finally {f.client.close();}
});

it("delivers ordered invalidation metadata and rejects a mismatched-grant permit", async () => {
  const f=fixture();
  try {
    await f.client.ready;
    f.socket.receive({v:1,type:"invalidate",controlSeq:1,browserId,sessionId,epoch:1,grantVersion:2,reason:"revoked"});
    expect(f.invalidations).toHaveLength(1);
    const pending=f.client.request("authorize",{browserId,sessionId,grantVersion:1,commandId:hubCommandId(sessionId, 1)});
    const rejected=expect(pending).rejects.toThrow("unavailable");
    f.socket.receive({v:1,type:"authorized",requestId:f.socket.sent.at(-1)!.requestId,allowed:true,grantVersion:2,
      authorizationId:randomUUID(),expiresAt:2000});
    await rejected;
    expect(f.client.isCurrent()).toBe(false);
  } finally {f.client.close();}
});

it("idle browser invalidation shares sequencing with session invalidations", async () => {
  const f=fixture();
  try {
    await f.client.ready;
    f.socket.receive({v:1,type:"browser.invalidated",controlSeq:1,browserId,grantVersion:2,reason:"browser_revoked"});
    expect(f.browserInvalidations).toEqual([{browserId,grantVersion:2,reason:"browser_revoked"}]);
    f.socket.receive({v:1,type:"invalidate",controlSeq:2,browserId,sessionId,epoch:1,grantVersion:2,reason:"revoked"});
    expect(f.invalidations).toHaveLength(1);
    expect(f.client.isCurrent()).toBe(true);
    f.socket.receive({v:1,type:"browser.invalidated",controlSeq:2,browserId,grantVersion:3,reason:"replay"});
    expect(f.client.isCurrent()).toBe(false);
    expect(f.browserInvalidations).toHaveLength(1);
  } finally {f.client.close();}
});
