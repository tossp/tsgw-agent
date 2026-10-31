import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { LOCAL, SERVER, catalog, reply, server, summary } from "./fixtures.mjs";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { dashboardGroups, filterDashboardGroups, dashboardCounts, dashboardIssues, dashboardFreshness } = await jiti.import("./dashboard-state.ts");

test("catalog-only rows have no invented runtime summary; runtime families remain intact", () => {
  const answer = reply();
  const saved = { ...catalog[0], id: "saved", name: "Saved chat" };
  const input = JSON.stringify([answer, catalog]);
  const groups = dashboardGroups(answer, [...catalog, saved]);
  assert.deepEqual(groups.flatMap(group => group.rows.map(row => row.id)), ["notes-1", "s1", "sub-xyz-789", "saved"]);
  assert.equal(groups.at(-1).rows[0].summary, null);
  assert.equal(groups[1].rows[1].depth, 1);
  assert.equal(JSON.stringify([answer, catalog]), input);
});

test("filters select actual state; awaiting input is not counted twice as executing", () => {
  const answer = reply();
  answer.sessions[2].running = true;
  const groups = dashboardGroups(answer, catalog);
  assert.deepEqual(filterDashboardGroups(groups, "running", "", "", "recent").flatMap(group => group.rows.map(row => row.id)), ["s1", "sub-xyz-789"]);
  assert.deepEqual(filterDashboardGroups(groups, "awaiting", "", "", "recent").flatMap(group => group.rows.map(row => row.id)), ["notes-1"]);
  const counts = dashboardCounts(answer, [...catalog, { ...catalog[0], id: "saved" }]);
  assert.deepEqual(counts, { held: 3, running: 1, awaiting: 1, subagents: 1, catalog: 1, total: 4 });
});

test("search includes actual assignments and keeps a matched child's root as context", () => {
  const groups = dashboardGroups(reply(), catalog);
  const rows = filterDashboardGroups(groups, "all", "inspect source", "", "recent").flatMap(group => group.rows);
  assert.deepEqual(rows.map(row => row.id), ["s1", "sub-xyz-789"]);
  assert.equal(rows[0].summary.running, false, "context parent is not relabeled as executing");
  assert.equal(filterDashboardGroups(groups, "all", "missing", "", "recent").length, 0);
});

test("name sorting never separates a child from its runtime family", () => {
  const answer = reply();
  answer.sessions.push(summary("other"));
  const info = { ...catalog[0], id: "other", name: "Another chat" };
  const groups = dashboardGroups(answer, [...catalog, info]);
  const app = filterDashboardGroups(groups, "all", "", "/work/app", "name")[0];
  assert.deepEqual(app.rows.map(row => row.id), ["other", "s1", "sub-xyz-789"]);
});

test("project-root search works for worktrees with unrelated directory names", () => {
  const info = { ...catalog[0], cwd: "/tmp/tree-42", projectRoot: "/srv/repository" };
  const groups = dashboardGroups(reply(), [info]);
  assert.deepEqual(filterDashboardGroups(groups, "all", "repository", "", "recent").flatMap(group => group.rows.map(row => row.id)), ["s1"]);
});

test("name sorting uses the visible title when the session has no explicit name", () => {
  const rows = [{ ...catalog[0], id: "a", name: undefined, firstMessage: "Zulu" }, { ...catalog[0], id: "z", name: undefined, firstMessage: "Alpha" }];
  const groups = dashboardGroups({ ...reply(), sessions: [] }, rows);
  assert.deepEqual(filterDashboardGroups(groups, "all", "", "", "name")[0].rows.map(row => row.id), ["z", "a"]);
});

test("saved child relations are not fabricated into a runtime tree under an unrelated saved row", () => {
  const answer = reply();
  answer.sessions = [];
  const groups = dashboardGroups(answer, catalog);
  const child = groups.flatMap(group => group.rows).find(row => row.id === "sub-xyz-789");
  assert.equal(child.depth, 0);
  assert.equal(child.info.relation.parentSessionId, "s1");
  assert.equal(child.summary, null);
});

test("attention signals use only the supplied detail and include listener/provider/MCP failures", () => {
  assert.deepEqual(dashboardIssues(null), []);
  const detail = reply().session;
  detail.wrapper.eventListeners = 3;
  detail.wrapper.extensions = "failed";
  detail.providers[0].active = "error";
  detail.eventStreams[0].droppedEvents = 5;
  const kinds = dashboardIssues(detail).map(issue => issue.kind);
  assert.deepEqual(kinds, ["listeners", "extensions", "provider", "mcpConfig", "mcp", "dropped"]);
  detail.wrapper.stale = true;
  assert.ok(!dashboardIssues(detail).some(issue => ["listeners", "extensions"].includes(issue.kind)), "stale wrappers cannot prove those states");
});

test("queued bytes are observable pressure, not by themselves proof of a stuck browser", () => {
  const detail = reply().session;
  detail.mcp = null;
  detail.eventStreams[0].queuedBytes = 1000;
  assert.deepEqual(dashboardIssues(detail), []);
});

test("freshness is based on browser receive age, not the unrelated server epoch", () => {
  assert.equal(dashboardFreshness(server({ receivedAt: LOCAL }), LOCAL + 1000, false), "current");
  assert.equal(dashboardFreshness(server({ receivedAt: LOCAL }), LOCAL + 6100, false), "stale");
  assert.equal(dashboardFreshness(server({ receivedAt: LOCAL }), LOCAL + 1000, true), "hidden");
  assert.equal(dashboardFreshness(server({ receivedAt: null, reply: null }), LOCAL, false), "waiting");
  assert.equal(dashboardFreshness(server({ failure: { kind: "http", status: 503, at: SERVER } }), LOCAL, false), "stale");
});
