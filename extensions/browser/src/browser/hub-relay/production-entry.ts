import { loadHubRelayConfig, startHubRelayServer } from "./production-server.js";

async function main() {
  const config = loadHubRelayConfig(process.env);
  const running = await startHubRelayServer(config);
  let requestedStop = false;
  const stop = () => { requestedStop = true; void running.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await running.ready;
    console.log(JSON.stringify({ status: "browser relay ready", host: config.host, port: (running.server.address() as { port: number }).port }));
    if (await running.closed === "authority_lost") process.exitCode = 1;
  } catch (error) {
    if (!requestedStop) throw error;
  } finally {
    await running.close();
    process.off("SIGTERM", stop); process.off("SIGINT", stop);
  }
}
void main().catch(() => {
  console.error("Browser relay could not start or lost its Hub authority");
  process.exitCode = 1;
});
