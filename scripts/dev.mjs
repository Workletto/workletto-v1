// Runs the API (with reload on save) and the Vite dev server together.
import { spawn } from "node:child_process";

// The API always listens on 3000 in development; Vite (5173) forwards /api to it.
// PORT is ignored here because preview tools set it to the Vite port.
const children = [
  spawn("npx", ["tsx", "watch", "src/server/index.ts"], { stdio: "inherit", env: { ...process.env, PORT: "3000" } }),
  spawn("npx", ["vite"], { stdio: "inherit" }),
];

function stop() {
  for (const child of children) child.kill("SIGTERM");
  process.exit();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
