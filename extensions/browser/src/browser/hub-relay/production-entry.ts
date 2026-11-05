import { loadHubRelayConfig, startHubRelayServer } from "./production-server.js";
import { safeRelayErrorCode } from "./startup-diagnostics.js";

let stage = "config";

async function main() {
  const config = loadHubRelayConfig(process.env);
  stage = "http_start";
  const running = await startHubRelayServer(config, (diagnostic) => console.error(JSON.stringify(diagnostic)));
  let requestedStop = false;
  const stop = () => { requestedStop = true; void running.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    stage = "authority_ready";
    await running.ready;
    stage = "running";
    console.log(JSON.stringify({ status: "browser relay ready", host: config.host, port: (running.server.address() as { port: number }).port }));
    if (await running.closed === "authority_lost") process.exitCode = 1;
  } catch (error) {
    if (!requestedStop) throw error;
  } finally {
    await running.close();
    process.off("SIGTERM", stop); process.off("SIGINT", stop);
  }
}
void main().catch((error: unknown) => {
  console.error("Browser relay could not start or lost its Hub authority");
  console.error(JSON.stringify({ event: "relay_failed", stage, code: safeRelayErrorCode(error) }));
  process.exitCode = 1;
});
