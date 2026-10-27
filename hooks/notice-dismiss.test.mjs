import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
const reducerNames = ["markOldestNoticeExiting", "fillPendingNotices", "noticeReducer"];
const declarations = reducerNames.map((name) => nodes.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source));
const dismiss = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "dismissNotice");
assert.ok(dismiss, "hook exposes a targeted dismiss callback");
const script = new Script(ts.transpileModule(`
  const MAX_NOTICES = 5;
  ${declarations.join("\n")}
  ${dismiss.getText(source).replace(/^dismissNotice =/, "const dismissNotice =")};
  dismissNotice;
`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
const notice = (id, exiting = false) => ({ id, message: id, type: "info", exiting });
function setup(visible, pending = [], paused = null) {
  const state = { value: { visible, pending }, paused };
  const context = createContext({
    useCallback: (fn) => fn,
    dispatchNotice: (action) => { state.value = context.noticeReducer(state.value, action); },
    setPausedNoticeId: (update) => { state.paused = update(state.paused); },
  });
  return { state, dismiss: script.runInContext(context) };
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
