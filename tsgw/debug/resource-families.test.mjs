import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { catalog, reply, summary } from "./fixtures.mjs";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { dashboardGroups } = await jiti.import("./dashboard-state.ts");
const { resourceFamilies } = await jiti.import("./resource-families.ts");
const info = (id, extra = {}) => ({ ...catalog[0], id, name: "Same display name", ...extra });
const child = (id, parentSessionId) => info(id, { relation: { kind: "subagent", parentSessionId, profile: "review", description: `Check ${id}`, status: "running" } });
function families(summaries, entries) {
  return resourceFamilies(dashboardGroups({ ...reply(), sessions: summaries }, entries), new Set(summaries.map(row => row.sessionId)));
}

test("independent roots in one project form separate cells, each retaining only its actual children", () => {
  const entries = [info("a"), info("b"), child("a-child", "a"), child("b-child", "b")];
  const runtime = [summary("b"), summary("a-child", { subagent: true }), summary("a"), summary("b-child", { subagent: true })];
  const original = JSON.stringify([runtime, entries]);
  const cells = families(runtime, entries);
  assert.deepEqual(cells.map(cell => [cell.id, cell.rows.map(row => row.id)]), [["b", ["b", "b-child"]], ["a", ["a", "a-child"]]]);
  assert.equal(cells[0].project, cells[1].project, "a project is metadata, not a single giant grid cell");
  assert.equal(JSON.stringify([runtime, entries]), original);
});

test("a context root stays with its resident descendant; unrelated history makes no grid cells", () => {
  const entries = [info("root"), child("middle", "root"), child("grandchild", "middle"), ...Array.from({ length: 200 }, (_, i) => info(`saved-${i}`))];
  const cells = families([summary("grandchild", { subagent: true, running: true })], entries);
  assert.equal(cells.length, 1);
  assert.deepEqual(cells[0].rows.map(row => row.id), ["root", "grandchild"]);
  assert.equal(cells[0].rows[0].summary, null);
  assert.equal(cells[0].rows[1].info.relation.parentSessionId, "middle");
});

test("side chats and forks remain independent roots while a side chat may own real delegated children", () => {
  const entries = [info("source"), info("side", { relation: { kind: "side", parentSessionId: "source" } }), info("fork", { relation: { kind: "fork", originSessionId: "source" } }), child("delegate", "side")];
  const runtime = [summary("side", { subagent: true }), summary("fork"), summary("delegate", { subagent: true })];
  const cells = families(runtime, entries);
  assert.deepEqual(cells.map(cell => [cell.id, cell.rows.map(row => row.id)]), [["side", ["side", "delegate"]], ["fork", ["fork"]]]);
  assert.ok(!cells.some(cell => cell.id === "source"));
});

test("missing metadata preserves orphan identity and different projects do not merge identical names", () => {
  const cells = families([summary("orphan", { subagent: true }), summary("a"), summary("b")], [info("a"), info("b", { cwd: "/different/project", projectRoot: "/different/project" })]);
  assert.equal(cells.length, 3);
  assert.deepEqual(cells.find(cell => cell.id === "orphan").rows.map(row => row.id), ["orphan"]);
  assert.equal(cells.find(cell => cell.id === "orphan").rows[0].summary.subagent, true);
  assert.notEqual(cells.find(cell => cell.id === "a").project, cells.find(cell => cell.id === "b").project);
});

test("a family disappears when its last resident exits, even if stale grouped rows remain", () => {
  const groups = dashboardGroups(reply(), catalog);
  const cells = resourceFamilies(groups, new Set(["notes-1"]));
  assert.deepEqual(cells.map(cell => cell.id), ["notes-1"]);
  assert.deepEqual(resourceFamilies(groups, new Set()), []);
});
