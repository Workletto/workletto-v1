// Bundles the server (and the generated database client) into dist/server.js.
// Packages in node_modules stay external and are installed on the host.
import { build } from "esbuild";

await build({
  entryPoints: ["src/server/index.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  logLevel: "warning",
});
