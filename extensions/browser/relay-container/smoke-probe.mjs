// Read-only CI observation: process/authority health and rejection of bad tickets.
const origin = process.env.PROBE_ORIGIN;
const path = process.env.PROBE_PATH ?? "/readyz";
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try { ready = (await fetch(origin + path, { signal: AbortSignal.timeout(1_000) })).status === 200; } catch {}
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!ready) throw new Error("Image did not become healthy");
if (process.env.PROBE_SOCKETS === "1") {
  for (const role of ["device", "agent"]) {
    const socket = new WebSocket(origin.replace("http:", "ws:") + `/browser/hub/${role}`, "agent-hub.browser.v1");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Bad ticket was not rejected")); }, 5_000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ v: 1, type: "authenticate", ticket: "x".repeat(43) })), { once: true });
      socket.addEventListener("message", () => { clearTimeout(timer); socket.close(); reject(new Error("Bad ticket received a relay message")); }, { once: true });
      socket.addEventListener("error", () => {});
      socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  // Cross the first real authority heartbeat; a malformed fake heartbeat must
  // fail the smoke instead of passing only during the initial ready window.
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  if ((await fetch(origin + "/readyz")).status !== 200) throw new Error("Authority heartbeat failed");
  if ((await fetch(origin + "/healthz")).status !== 200) throw new Error("Liveness failed");
}
console.log("Browser relay image smoke passed");
