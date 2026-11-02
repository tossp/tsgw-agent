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
  assert.deepEqual(counts, { held: 3, running: 1, awaiting: 1, subagents: 1, catalog: 1, total: 4, ordinary: 2, ordinaryRunning: 0, subagentResident: 1, subagentRunning: 1, contextParents: 0 });
});

test("runtime counts separate ordinary sessions from subagents; a fork stays ordinary", () => {
  const answer = reply();
  answer.sessions = [
    summary("s1", { running: true }),
    summary("sub-xyz-789", { subagent: true, running: true }),
    summary("notes-1", { awaitingInput: true }),
    summary("fork-42", { running: true }),
  ];
  const forked = { ...catalog[0], id: "fork-42", name: "Forked chat", relation: { kind: "fork", originSessionId: "s1" } };
  const counts = dashboardCounts(answer, [...catalog, forked]);
  assert.equal(counts.ordinary, 3, "s1, notes-1 and the fork are ordinary sessions");
  assert.equal(counts.ordinaryRunning, 2);
  assert.equal(counts.subagentResident, 1);
  assert.equal(counts.subagentRunning, 1);
  assert.equal(counts.subagents, 1, "the legacy flag count keeps its meaning");
  assert.equal(counts.ordinary + counts.subagentResident, counts.held);
  const groups = dashboardGroups(answer, [...catalog, forked]);
  assert.deepEqual(filterDashboardGroups(groups, "subagents", "", "", "recent").flatMap(group => group.rows.map(row => row.id)), ["s1", "sub-xyz-789"], "the family root is context for its delegated subagent");
  assert.ok(!filterDashboardGroups(groups, "subagents", "", "", "recent").flatMap(group => group.rows.map(row => row.id)).includes("fork-42"), "a fork is not a delegated subagent");
});

test("a non-resident parent is context only: not active, and its running subagent stays visible", () => {
  const answer = reply();
  answer.sessions = [summary("sub-xyz-789", { subagent: true, running: true })];
  const groups = dashboardGroups(answer, catalog);
  assert.deepEqual(groups.flatMap(group => group.rows.map(row => [row.id, row.depth, row.placeholder])), [["s1", 0, true], ["sub-xyz-789", 1, false], ["notes-1", 0, false]], "the saved note keeps its own catalog row");
  const counts = dashboardCounts(answer, catalog);
  assert.equal(counts.contextParents, 1);
  assert.equal(counts.held, 1, "the parent placeholder is not a held wrapper");
  assert.equal(counts.running, 1, "the parent is not counted as executing");
  assert.equal(counts.ordinary, 0);
  assert.equal(counts.ordinaryRunning, 0);
  assert.equal(counts.subagentResident, 1);
  assert.equal(counts.subagentRunning, 1);
  assert.equal(counts.catalog, 2);
  assert.deepEqual(filterDashboardGroups(groups, "held", "", "", "recent").flatMap(group => group.rows.map(row => row.id)), ["s1", "sub-xyz-789"], "a running subagent is not hidden");
  const running = filterDashboardGroups(groups, "running", "", "", "recent").flatMap(group => group.rows);
  assert.deepEqual(running.map(row => row.id), ["s1", "sub-xyz-789"]);
  assert.equal(running[0].summary, null, "the context parent is never relabeled as executing");
  assert.deepEqual(filterDashboardGroups(groups, "held", "", "", "name")[0].rows.map(row => row.id), ["s1", "sub-xyz-789"], "name sorting keeps the family together");
});

test("subagent runtime filter never leaks saved subagents; a context parent in the catalog is an ordinary record", () => {
  const saved = { ...catalog[1], id: "saved-child", relation: { ...catalog[1].relation, status: "completed" } };
  const answer = reply();
  answer.sessions = [summary("sub-xyz-789", { subagent: true, running: true })];
  const groups = dashboardGroups(answer, [...catalog, saved]);
  assert.deepEqual(filterDashboardGroups(groups, "subagents", "", "", "recent").flatMap(group => group.rows.map(row => row.id)), ["s1", "sub-xyz-789"]);
  const history = filterDashboardGroups(groups, "catalog", "", "", "recent").flatMap(group => group.rows);
  assert.equal(history.find(row => row.id === "s1").placeholder, false);
  assert.ok(history.every(row => row.depth === 0 && !row.placeholder));
});

test("catalog filtering never injects an unmatched historical parent", () => {
  const answer = reply();
  answer.sessions = [summary("sub-xyz-789", { subagent: true, running: true })];
  const groups = dashboardGroups(answer, catalog);
  assert.deepEqual(filterDashboardGroups(groups, "catalog", "", "", "recent").flatMap(group => group.rows.map(row => row.id)), ["s1", "notes-1"], "catalog rows are the non-resident sessions themselves");
  assert.deepEqual(filterDashboardGroups(groups, "catalog", "inspect source", "", "recent"), [], "a query that matches only the running child keeps no historical parent");
});

test("an orphan subagent summary keeps its role without an invented parent", () => {
  const answer = reply();
  answer.sessions = [summary("orphan-sub", { subagent: true, running: true })];
  const groups = dashboardGroups(answer, []);
  const row = groups[0].rows[0];
  assert.deepEqual([row.id, row.depth, row.info, row.placeholder], ["orphan-sub", 0, null, false]);
  const counts = dashboardCounts(answer, []);
  assert.equal(counts.ordinary, 0);
  assert.equal(counts.subagentResident, 1);
  assert.equal(counts.subagentRunning, 1);
  assert.equal(counts.contextParents, 0, "no catalog entry means no fabricated context parent");
  assert.equal(counts.catalog, 0);
  assert.deepEqual(filterDashboardGroups(groups, "subagents", "", "", "recent").flatMap(group => group.rows.map(row => row.id)), ["orphan-sub"]);
  assert.deepEqual(filterDashboardGroups(groups, "catalog", "", "", "recent"), []);
});

test("a nested subagent keeps its direct parent relation and stays one level under the family root", () => {
  const grand = { ...catalog[0], id: "grand", name: "Root chat" };
  const middle = { ...catalog[0], id: "parent", name: "Middle", relation: { kind: "subagent", parentSessionId: "grand", profile: "explore", description: "outer", status: "running" } };
  const kid = { ...catalog[0], id: "kid", name: "Kid", relation: { kind: "subagent", parentSessionId: "parent", profile: "explore", description: "inner", status: "running" } };
  const answer = reply();
  answer.sessions = [summary("kid", { subagent: true, running: true })];
  const groups = dashboardGroups(answer, [grand, middle, kid]);
  const rows = groups.flatMap(group => group.rows);
  assert.deepEqual(rows.map(row => row.id), ["grand", "kid", "parent"], "the non-resident parent gets no extra family row, only its own catalog row");
  assert.equal(rows[1].depth, 1, "families stay one level deep");
  assert.equal(rows[1].info.relation.parentSessionId, "parent", "the direct parent stays the recorded one, not the family root");
  assert.equal(rows[2].summary, null, "the direct parent's catalog row is not a runtime summary");
  assert.equal(rows[2].placeholder, false, "only the family root is a context placeholder");
  assert.equal(rows[0].placeholder, true);
  const counts = dashboardCounts(answer, [grand, middle, kid]);
  assert.equal(counts.contextParents, 1, "one family root, not one row per ancestor");
  assert.equal(counts.catalog, 2);
  assert.equal(counts.subagentResident, 1);
  assert.equal(counts.subagentRunning, 1);
});

test("the catalog subagent relation decides the role when the wrapper flag disagrees", () => {
  const answer = reply();
  answer.sessions = [summary("legacy-sub", { subagent: false, running: true })];
  const info = { ...catalog[0], id: "legacy-sub", name: "Legacy sub", relation: { kind: "subagent", parentSessionId: "s1", profile: "explore", description: "role from catalog", status: "running" } };
  const counts = dashboardCounts(answer, [...catalog, info]);
  assert.equal(counts.ordinary, 0);
  assert.equal(counts.subagentResident, 1);
  assert.equal(counts.subagentRunning, 1);
  assert.equal(counts.subagents, 0, "the legacy field still reports only the wrapper flag");
  assert.equal(counts.contextParents, 1);
  assert.ok(filterDashboardGroups(dashboardGroups(answer, [...catalog, info]), "subagents", "", "", "recent").flatMap(group => group.rows.map(row => row.id)).includes("legacy-sub"));
});

test("counts accept precomputed groups, never mutate the snapshot, and hold no phantom values", () => {
  const answer = reply();
  const input = JSON.stringify([answer, catalog]);
  const groups = dashboardGroups(answer, catalog);
  assert.deepEqual(dashboardCounts(answer, catalog, groups), dashboardCounts(answer, catalog));
  assert.equal(JSON.stringify([answer, catalog]), input);
  assert.deepEqual(dashboardCounts(null, catalog), { held: 0, running: 0, awaiting: 0, subagents: 0, catalog: 3, total: 3, ordinary: 0, ordinaryRunning: 0, subagentResident: 0, subagentRunning: 0, contextParents: 0 });
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

test("side chats and real subagents coexist without sharing role counts or filters", () => {
  const side = { ...catalog[0], id: "side-1", name: "Side investigation", relation: { kind: "side", parentSessionId: "s1" } };
  const savedSide = { ...side, id: "saved-side" };
  const answer = reply();
  // The real upstream debug contract uses the same notification-suppression flag for both.
  answer.sessions.push(summary(side.id, { subagent: true, running: true }));
  const infos = [...catalog, side, savedSide];
  const before = JSON.stringify([answer, infos]);
  const groups = dashboardGroups(answer, infos);
  const rows = groups.flatMap(group => group.rows);
  assert.equal(rows.find(row => row.id === side.id).depth, 0, "side chats are independent copied conversations, not delegated tasks");
  assert.equal(rows.find(row => row.id === "sub-xyz-789").depth, 1, "real subagents retain their family");
  const counts = dashboardCounts(answer, infos, groups);
  assert.equal(counts.ordinary, 3, "the side chat belongs to the non-subagent total");
  assert.equal(counts.ordinaryRunning, 1);
  assert.equal(counts.subagents, 1, "notification suppression must not inflate subagent counts");
  assert.equal(counts.subagentResident, 1);
  assert.equal(counts.subagentRunning, 1);
  assert.equal(counts.ordinary + counts.subagentResident, counts.held);
  assert.equal(counts.running, 2);
  assert.deepEqual(filterDashboardGroups(groups, "subagents", "", "", "recent").flatMap(group => group.rows.map(row => row.id)), ["s1", "sub-xyz-789"]);
  assert.ok(filterDashboardGroups(groups, "running", "", "", "recent").flatMap(group => group.rows).some(row => row.id === side.id));
  assert.deepEqual(filterDashboardGroups(groups, "catalog", "", "", "recent").flatMap(group => group.rows.map(row => row.id)), [savedSide.id]);
  assert.equal(JSON.stringify([answer, infos]), before, "no normalization may alter the API data or catalog");
});

test("a side chat with a non-resident or missing source creates no delegated parent placeholder", () => {
  const answer = reply();
  answer.sessions = [summary("side-1", { subagent: true, awaitingInput: true, running: true })];
  for (const parentSessionId of ["s1", "missing"]) {
    const side = { ...catalog[0], id: "side-1", relation: { kind: "side", parentSessionId } };
    const groups = dashboardGroups(answer, [...catalog, side]);
    const counts = dashboardCounts(answer, [...catalog, side], groups);
    assert.equal(counts.contextParents, 0);
    assert.equal(counts.ordinary, 1);
    assert.equal(counts.ordinaryRunning, 0, "awaiting input is not execution");
    assert.equal(counts.subagentResident, 0);
    assert.equal(counts.subagents, 0);
    assert.deepEqual(filterDashboardGroups(groups, "subagents", "", "", "recent"), []);
    assert.deepEqual(filterDashboardGroups(groups, "held", "", "", "recent").flatMap(group => group.rows.map(row => row.id)), [side.id]);
  }
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
