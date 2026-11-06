import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const loadModule = createRequire(import.meta.url);

// Worktrees share node_modules via a symlink. Enlarge only Turbopack's filesystem
// boundary, not its output directory: this server still owns this worktree's .next.
// Run: env -u PI_WEB_PASSWORD NODE_ENV=development node tsgw/debug/e2e-dev.mjs
const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hostname = "127.0.0.1", port = Number(process.env.E2E_DEV_PORT ?? 30144);
// The custom-server router loads configuration independently of next({ conf }).
// Apply the test-only filesystem boundary to each load in this process.
const loader = loadModule("next/dist/server/config");
const loadConfig = loader.default;
loadModule.cache[loadModule.resolve("next/dist/server/config")].exports = {
  ...loader, __esModule: true, default: async (...args) => {
    const config = await loadConfig(...args);
    return { ...config, turbopack: { ...config.turbopack, root: dirname(dir) } };
  },
};
const { default: next } = await import("next");
const app = next({ dir, dev: true, turbopack: true, hostname, port });
await app.prepare();
const handler = app.getRequestHandler();
const server = createServer((req, res) => handler(req, res));
server.on("error", error => { console.error(error); process.exitCode = 1; });
server.listen(port, hostname, () => console.log(`Isolated debug e2e dev: http://${hostname}:${port}`));
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  server.close(); void app.close().then(() => process.exit());
});
