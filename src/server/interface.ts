import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

/**
 * Serves the built interface: its files, and for any other address the app's page (the app
 * chooses what to show). An address that looks like a file (/favicon.ico, /x.png) but isn't one is
 * "not found", not the app page.
 */
export function serveInterface(app: Hono, root: string) {
  app.use("/assets/*", serveStatic({ root }));
  app.use("*", serveStatic({ root }));
  const page = serveStatic({ path: join(root, "index.html") });
  app.get("*", async (c, next) => {
    if (/\.[A-Za-z0-9]{1,10}$/.test(c.req.path)) return c.text("Not found.", 404);
    return (await page(c, next)) ?? undefined;
  });
}
