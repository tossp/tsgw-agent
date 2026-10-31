import assert from "node:assert/strict";
import test from "node:test";
import { createSessionOwnerAccess } from "./session-owner.ts";

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test("mutates the live owner immediately, without waiting on session_start", async () => {
  const owner = { isAlive: () => true };
  const access = createSessionOwnerAccess(() => owner, () => { throw new Error("must not wait"); });
  assert.equal(await access("id", (wrapper) => wrapper === owner, () => assert.fail("disk")), true);
});

test("unowned mutation runs synchronously after the owner check", async () => {
  const order = [];
  const access = createSessionOwnerAccess(() => undefined, () => null);
  const result = access("id", () => assert.fail("owned"), () => { order.push("write"); return 42; });
  order.push("after call");
  assert.deepEqual(order, ["write", "after call"]);
  assert.equal(await result, 42);
});

test("waits for a start, then rechecks and mutates its registered owner", async () => {
  let owner;
  let finish;
  let lock = new Promise((resolve) => { finish = resolve; });
  const access = createSessionOwnerAccess(() => owner, () => lock);
  let written = false;
  const result = access("id", (wrapper) => { written = true; return wrapper; }, () => assert.fail("disk"));
  await nextTick();
  assert.equal(written, false);
  owner = { isAlive: () => true };
  lock = undefined;
  finish();
  assert.equal(await result, owner);
});

test("waits for closing owner or failed start before a disk write", async () => {
  for (const failed of [false, true]) {
    let finish;
    let lock = new Promise((resolve, reject) => { finish = failed ? reject : resolve; });
    const access = createSessionOwnerAccess(() => ({ isAlive: () => false }), () => lock);
    let written = false;
    const result = access("id", () => assert.fail("closing owner"), () => { written = true; });
    await nextTick();
    assert.equal(written, false);
    lock = undefined;
    finish(failed ? new Error("start failed") : undefined);
    await result;
    assert.equal(written, true);
  }
});
