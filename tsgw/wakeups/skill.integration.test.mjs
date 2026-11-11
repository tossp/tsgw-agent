import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionServices,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createWakeupExtension } = await jiti.import("./extension.ts");
const { WakeupRuntime } = await jiti.import("./runtime.ts");
const root = fileURLToPath(new URL("../../", import.meta.url));
const skillPath = "tsgw/wakeups/skills/tsgw-session-wakeup/SKILL.md";
const skillText = await readFile(join(root, skillPath), "utf8");
const skillBody = skillText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();

async function fixture(t) {
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
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        createWakeupExtension(runtime),
      ],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.inMemory(directory), model: faux.getModel("skill-fixture"),
  });
  t.after(async () => {
    await session.abort();
    session.dispose();
    runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await session.bindExtensions({});
  return { session, services, faux };
}

function assertSkill(f, path) {
  const { skills, diagnostics } = f.services.resourceLoader.getSkills();
  const skill = skills.find(item => item.name === "tsgw-session-wakeup");
  assert.ok(skill, JSON.stringify(diagnostics));
  assert.equal(skill.filePath, path);
  assert.ok(f.session.systemPrompt.includes("tsgw-session-wakeup"));
  assert.ok(f.session.systemPrompt.includes(path));
  assert.ok(!f.session.systemPrompt.includes(skillBody), "advertise the skill without eagerly injecting its body");
}

test("SDK discovers the bundled skill, expands its body on demand and avoids duplicates on reload", async t => {
  const f = await fixture(t);
  assertSkill(f, join(root, skillPath));
  f.faux.setResponses([fauxAssistantMessage([fauxText("skill loaded")])]);
  await f.session.prompt("/skill:tsgw-session-wakeup");
  const user = f.session.agent.state.messages.findLast(message => message.role === "user");
  const content = typeof user.content === "string" ? user.content
    : user.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  assert.ok(content.includes(skillBody), "expand the actual skill body rather than a fixed heading");
  await f.session.reload();
  await f.session.bindExtensions({});
  assertSkill(f, join(root, skillPath));
  assert.equal(f.services.resourceLoader.getSkills().skills.filter(skill => skill.name === "tsgw-session-wakeup").length, 1);
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
});
