// Runs the bot and restarts it whenever it exits, with a short backoff.
//   npm run forever
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
let quickExits = 0;

function start() {
  const started = Date.now();
  const child = spawn(process.execPath, [tsx, path.join(root, "src", "index.ts")], {
    cwd: root,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    quickExits = Date.now() - started > 60_000 ? 0 : quickExits + 1;
    const wait = Math.min(30_000, 2_000 * 2 ** Math.min(quickExits, 4));
    console.log(`[forever] bot exited (${code ?? signal}); restarting in ${wait / 1000}s`);
    setTimeout(start, wait);
  });
}

console.log(`[forever] supervising the bot in ${root}`);
start();
