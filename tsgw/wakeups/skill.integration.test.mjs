import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionServices, createCodemodeExtension,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createWakeupExtension, WAKEUP_TOOL_NAMES } = await jiti.import("./extension.ts");
const { WakeupRuntime } = await jiti.import("./runtime.ts");
const root = fileURLToPath(new URL("../../", import.meta.url));
const skillPath = "tsgw/wakeups/skills/tsgw-session-wakeup/SKILL.md";
const skillText = await readFile(join(root, skillPath), "utf8");
const scripts = [...skillText.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]);

async function fixture(t, tools) {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-wakeup-skill-"));
  const runtime = new WakeupRuntime({
    assertTarget: async () => assert.fail("skill discovery must not schedule timers"),
    append: async () => assert.fail("skill discovery must not write wakeup history"),
    read: async () => [],
  }, async () => assert.fail("skill discovery must not deliver notifications"));
  const faux = fauxProvider({ models: [{ id: "skill-fixture" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: directory, agentDir: directory, modelRuntime,
    settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"] }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        { name: "codemode", factory: createCodemodeExtension({ models: false }) },
        createWakeupExtension(runtime),
      ],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.inMemory(directory), model: faux.getModel("skill-fixture"),
    ...(tools ? { tools } : {}),
  });
  t.after(async () => {
    await session.abort();
    session.dispose();
    runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await session.bindExtensions({});
  async function run(code) {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("checked")]),
    ]);
    await session.prompt("Check the bundled wakeup skill without creating a timer");
    return session.agent.state.messages.findLast(message => message.role === "toolResult" && message.toolName === "codemode");
  }
  return { session, services, runtime, faux, run };
}

function assertSkill(f, path) {
  const { skills, diagnostics } = f.services.resourceLoader.getSkills();
  const skill = skills.find(item => item.name === "tsgw-session-wakeup");
  assert.ok(skill, JSON.stringify(diagnostics));
  assert.equal(skill.filePath, path);
  assert.ok(f.session.systemPrompt.includes("tsgw-session-wakeup"));
  assert.ok(f.session.systemPrompt.includes(path));
  assert.ok(!f.session.systemPrompt.includes("## 交接消息模板"), "advertise the skill without eagerly injecting its body");
}

function textOf(result) {
  return result.content.map(block => block.text ?? "").join("");
}

test("SDK discovers the bundled skill beside wakeup tools and executes its read-only capability check", async t => {
  const f = await fixture(t);
  assertSkill(f, join(root, skillPath));
  for (const name of WAKEUP_TOOL_NAMES) assert.ok(f.session.getCallableToolNames().includes(name), name);
  const result = await f.run(scripts[0]);
  assert.equal(result.isError, false, textOf(result));
  assert.match(textOf(result), /schedule_wakeup/);
  assert.match(textOf(result), /list_session_wakeups/);
  assert.deepEqual(f.runtime.list(), []);

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.equal(scripts.length, 5, "check every JavaScript example without running scheduling or cancellation");
  for (const script of scripts) assert.doesNotThrow(() => new AsyncFunction(script));
  f.faux.setResponses([fauxAssistantMessage([fauxText("skill loaded")])]);
  await f.session.prompt("/skill:tsgw-session-wakeup");
  const user = f.session.agent.state.messages.findLast(message => message.role === "user");
  assert.match(JSON.stringify(user.content), /## 交接消息模板/);
  await f.session.reload();
  await f.session.bindExtensions({});
  assertSkill(f, join(root, skillPath));
  assert.equal(f.services.resourceLoader.getSkills().skills.filter(skill => skill.name === "tsgw-session-wakeup").length, 1);
});

test("the skill remains discoverable under an existing tool allow-list and reports missing tools without fallback", async t => {
  const missing = "list_session_wakeups";
  const f = await fixture(t, ["read", "codemode", ...WAKEUP_TOOL_NAMES.filter(name => name !== missing)]);
  assertSkill(f, join(root, skillPath));
  assert.equal(f.session.getCallableToolNames().includes(missing), false);
  const result = await f.run(scripts[0]);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /宿主能力不一致：缺少工具 list_session_wakeups/);
  assert.ok(!textOf(result).includes("==> text"), "fail before discovery output or any tool action");
  assert.deepEqual(f.runtime.list(), []);
});

test("npm packs the skill and SDK discovery follows the relocated package root, not the session cwd", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-wakeup-skill-pack-"));
  const originalCwd = process.cwd();
  t.after(async () => { process.chdir(originalCwd); await rm(directory, { recursive: true, force: true }); });
  const source = join(directory, "source"), artifacts = join(directory, "artifacts"), installed = join(directory, "installed");
  await Promise.all([source, artifacts, installed].map(path => mkdir(path)));
  await cp(join(root, "package.json"), join(source, "package.json"));
  await mkdir(join(source, "tsgw/wakeups/skills"), { recursive: true });
  await cp(join(root, "tsgw/wakeups/skills"), join(source, "tsgw/wakeups/skills"), { recursive: true });
  const output = JSON.parse(execFileSync("npm", ["pack", "--offline", "--json", "--ignore-scripts", "--pack-destination", artifacts], {
    cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
  const [packed] = Array.isArray(output) ? output : Object.values(output);
  assert.ok(packed.files.some(file => file.path === skillPath), "the real package files allow-list must include the skill");
  execFileSync("tar", ["-xzf", join(artifacts, packed.filename), "-C", installed]);
  const packageRoot = join(installed, "package");
  assert.equal(await readFile(join(packageRoot, skillPath), "utf8"), skillText);
  process.chdir(packageRoot);
  const f = await fixture(t);
  assertSkill(f, join(packageRoot, skillPath));
  assert.notEqual(f.session.sessionManager.getCwd(), packageRoot);
  assert.equal(f.session.getCallableToolNames().includes("schedule_wakeup"), true);
});
