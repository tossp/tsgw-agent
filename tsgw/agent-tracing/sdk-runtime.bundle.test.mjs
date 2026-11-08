import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack");
const exec = promisify(execFile);
const projectDir = fileURLToPath(new URL("../../", import.meta.url));

test("production bundle locates the same SDK after relocation, independent of the build path and cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tsgw-sdk-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, "build-source");
  const outputDir = join(root, "build-output");
  const installedDir = join(root, "installed");
  const unrelatedCwd = join(root, "unrelated-cwd");
  await mkdir(sourceDir);
  await mkdir(unrelatedCwd);
  const entry = join(sourceDir, "sdk-runtime.mjs");
  const source = await readFile(new URL("./sdk-runtime.ts", import.meta.url), "utf8");
  await writeFile(entry, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);

  // Use the production bundler shipped with Next, with the SDK external just as in next.config.ts.
  const compiler = webpack({
    mode: "production",
    // Next supplies its own minimizer; this regression exercises module resolution, not minification.
    optimization: { minimize: false },
    target: "node22",
    entry,
    experiments: { outputModule: true },
    externalsType: "module",
    externals: { "@earendil-works/pi-coding-agent": "@earendil-works/pi-coding-agent" },
    output: { path: outputDir, filename: "sdk-runtime.mjs", library: { type: "module" } },
  });
  await new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError) return reject(error ?? closeError);
        if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
        resolve();
      });
    });
  });
  await rename(outputDir, installedDir);
  await rm(sourceDir, { recursive: true });
  // Keep the real dependency copy, not fake SDK exports or a bundled second module instance.
  await symlink(join(projectDir, "node_modules"), join(installedDir, "node_modules"), "junction");
  const runner = join(installedDir, "check.mjs");
  await writeFile(runner, `
import assert from "node:assert/strict";
globalThis.fetch = () => { throw new Error("Network is forbidden in the relocated SDK regression"); };
const { AgentSession, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } =
  await import("@earendil-works/pi-coding-agent");
const { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
const { createTracingAgentSessionFromServices, inheritRuntimeStreamAuth } = await import("./sdk-runtime.mjs");
const faux = fauxProvider({ tokensPerSecond: 0 });
const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
});
runtime.registerNativeProvider(faux.provider);
const cwd = process.cwd();
const services = await createAgentSessionServices({
  cwd, agentDir: cwd, modelRuntime: runtime,
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  resourceLoaderOptions: {
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  },
});
const { session } = await createTracingAgentSessionFromServices({
  services, model: faux.getModel(), sessionManager: SessionManager.inMemory(cwd), tools: [],
});
try {
  assert.ok(session instanceof AgentSession, "the bundle must use the external SDK's own AgentSession");
  const original = session.agent.streamFunction;
  const wrapped = (...args) => original(...args);
  inheritRuntimeStreamAuth(original, wrapped);
  session.agent.streamFunction = wrapped;
  faux.setResponses([fauxAssistantMessage("relocated bundle works")]);
  await session.prompt("local regression");
  const reply = session.messages.find((message) => message.role === "assistant");
  assert.equal(reply.stopReason, "stop");
  assert.ok(reply.content.some((block) => block.type === "text" && block.text.includes("relocated bundle works")));
  console.log("RELOCATED_SDK_OK");
} finally {
  session.dispose();
}
`);
  const env = { ...process.env, HOME: unrelatedCwd, PI_CODING_AGENT_DIR: unrelatedCwd };
  delete env.PI_PACKAGE_DIR;
  const result = await exec(process.execPath, [runner], {
    cwd: unrelatedCwd, env, timeout: 30_000,
  });
  assert.match(result.stdout, /RELOCATED_SDK_OK/);
});
