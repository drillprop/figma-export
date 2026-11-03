import process from "node:process";
import { serve } from "@hono/node-server";
import { app, DEFAULT_OUT } from "./app";

const PORT = Number(process.env.PORT ?? 3579);

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`figma-export server → http://127.0.0.1:${info.port}`);
  console.log(`default output folder (OUT_DIR): ${DEFAULT_OUT || "— (set per-export in the plugin)"}`);
});
