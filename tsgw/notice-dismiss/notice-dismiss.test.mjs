import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("../../hooks/__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" }, tsconfigPaths: true,
  alias: { "react/jsx-runtime": fileURLToPath(import.meta.resolve("react/jsx-runtime")), react: shimPath },
});
const { renderHook } = await import(shimPath);
const { useNoticeDismiss } = await jiti.import("./index.ts");

const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("../../hooks/useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const dismissSource = ts.createSourceFile("useNoticeDismiss.ts", await readFile(new URL("./useNoticeDismiss.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
const reducerNames = ["markOldestNoticeExiting", "fillPendingNotices", "noticeReducer"];
const declarations = reducerNames.map((name) => nodes.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source));
const dismiss = dismissSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "useNoticeDismiss");
assert.ok(dismiss, "module exposes the targeted dismiss hook");
assert.match(source.text, /const dismissNotice = useNoticeDismiss\(dispatchNotice, setPausedNoticeId\)/);
const script = new Script(ts.transpileModule(`
  const MAX_NOTICES = 5;
  ${declarations.join("\n")}
`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
const notice = (id, exiting = false) => ({ id, message: id, type: "info", exiting });
function setup(visible, pending = [], paused = null) {
  const state = { value: { visible, pending }, paused };
  const context = createContext({
    dispatchNotice: (action) => { state.value = context.noticeReducer(state.value, action); },
    setPausedNoticeId: (update) => { state.paused = update(state.paused); },
  });
  script.runInContext(context);
  const hook = renderHook(() => useNoticeDismiss(context.dispatchNotice, context.setPausedNoticeId));
  return { state, dismiss: hook.result };
}
const ids = (items) => Array.from(items, (item) => item.id);

test("dismissing a newer card preserves older cards and their pause", () => {
  const { state, dismiss } = setup([notice("first"), notice("second")], [], "first");
  dismiss("second");
  assert.deepEqual(ids(state.value.visible), ["first"]);
  assert.equal(state.paused, "first");
  dismiss("second");
  assert.deepEqual(ids(state.value.visible), ["first"], "repeated dismissal is safe");
});

test("dismissing the focused card clears its pause and fills the pending slot", () => {
  const visible = [notice("first", true), ...["second", "third", "fourth", "fifth"].map((id) => notice(id))];
  const { state, dismiss } = setup(visible, [notice("sixth")], "third");
  dismiss("third");
  assert.deepEqual(ids(state.value.visible), ["first", "second", "fourth", "fifth", "sixth"]);
  assert.equal(state.value.visible[0].exiting, true, "existing expiry animation remains intact");
  assert.equal(state.value.pending.length, 0);
  assert.equal(state.paused, null);
});

test("dismissing the last card empties the shelf without changing its contents", () => {
  const original = notice("only");
  const { state, dismiss } = setup([original], [], "only");
  dismiss("only");
  assert.equal(state.value.visible.length, 0);
  assert.equal(state.paused, null);
  assert.deepEqual(original, notice("only"));
});
