import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getAgentsBadge, getSessionFamily } = await jiti.import("@/lib/session-family");
const { getRunningSubagents } = await jiti.import("./running-subagents.ts");

function session(id, modified, relation) {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/tmp",
    created: modified,
    modified,
    messageCount: 1,
    firstMessage: id,
    ...(relation ? { relation } : {}),
  };
}

test("the running list includes nested descendants but excludes the main agent and other families", () => {
  const main = session("main", "2026-01-01T00:00:00.000Z");
  const child = session("child", main.modified, {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Explore", status: "running",
  });
  const nested = session("nested", main.modified, {
    kind: "subagent", parentSessionId: "child", profile: "review", description: "Review", status: "running",
  });
  const family = getSessionFamily([main, child, nested], "main");
  const running = new Set(["main", "nested", "elsewhere"]);
  assert.deepEqual(getRunningSubagents(family.subagents, running), [nested]);
  assert.equal(getAgentsBadge(family.subagents, running).count, getRunningSubagents(family.subagents, running).length);
  assert.deepEqual(getRunningSubagents(family.subagents, new Set()), []);
});

test("side chats stay in the upstream family badge but not the fork subagent status", () => {
  const main = session("main", "2026-01-01T00:00:00.000Z");
  const side = session("side", main.modified, { kind: "side", parentSessionId: main.id });
  const child = session("child", main.modified, {
    kind: "subagent", parentSessionId: main.id, profile: "explore", description: "Explore", status: "running",
  });
  const family = getSessionFamily([main, side, child], side.id);
  assert.equal(family.root.id, main.id);
  assert.deepEqual(family.subagents, [side, child]);
  const running = new Set([side.id, child.id]);
  assert.deepEqual(getAgentsBadge(family.subagents, running), { count: 2, running: true });
  assert.deepEqual(getRunningSubagents(family.subagents, running), [child]);
  assert.deepEqual(getAgentsBadge(family.subagents, new Set([side.id])), { count: 1, running: true });
  assert.deepEqual(getRunningSubagents(family.subagents, new Set([side.id])), []);
});
