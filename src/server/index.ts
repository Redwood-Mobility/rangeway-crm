import { config } from "./config.js";
import { createApp } from "./app.js";

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Atlas listening on port ${config.port}`);
});

let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down Atlas.`);
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
