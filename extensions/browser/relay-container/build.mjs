import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const source = path.resolve(process.argv[2] ?? "../../../");
const outdir = path.resolve(process.argv[3] ?? "dist");
await mkdir(outdir, { recursive: true });
const result = await build({
  entryPoints: [path.join(source, "extensions/browser/src/browser/hub-relay/production-entry.ts")],
  outfile: path.join(outdir, "relay.mjs"), bundle: true, platform: "node", format: "esm",
  target: "node24", packages: "external", metafile: true,
  alias: { "openclaw/plugin-sdk/websocket-runtime": path.join(source, "src/plugin-sdk/websocket-runtime.ts") },
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const item of output.imports) {
    if (!item.path.startsWith("node:") && item.path !== "ws") throw new Error(`Unexpected runtime import: ${item.path}`);
  }
}
await writeFile(path.join(outdir, "metafile.json"), JSON.stringify(result.metafile, null, 2));
console.log(JSON.stringify({ status: "relay built", inputs: Object.keys(result.metafile.inputs).length }));
