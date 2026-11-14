import assert from "node:assert/strict";
import test from "node:test";
import { getTurnAnchors, isMessageGroupAnchor } from "../../lib/message-display.ts";

test("a displayed wakeup notification starts its own turn instead of folding the previous answer", () => {
  const message = { role: "custom", customType: "pi-web:wakeup-notification", display: true };
  assert.equal(isMessageGroupAnchor(message), true);
  assert.equal(isMessageGroupAnchor({ ...message, display: false }), false);
});

test("a wakeup keeps its own turn after a truncated or failed answer", () => {
  for (const stopReason of ["length", "error", undefined]) {
    const messages = [
      { role: "user" },
      { role: "assistant", stopReason },
      { role: "custom", customType: "pi-web:wakeup-notification", display: true },
      { role: "assistant", stopReason: "stop" },
    ];
    assert.deepEqual(getTurnAnchors(messages), [true, false, true, false], stopReason);
    assert.deepEqual(getTurnAnchors(messages.slice(0, -1), { openTail: true }), [true, false, true], stopReason);
  }
});

test("a wakeup and an extension trigger share one anchor while other extension runs still group upstream", () => {
  const messages = [
    { role: "user" },
    { role: "assistant", stopReason: "stop" },
    { role: "custom", customType: "pi-web:wakeup-notification", display: true },
    { role: "custom", customType: "extension-trigger", display: false },
    { role: "assistant", stopReason: "stop" },
    { role: "custom", customType: "extension-result", display: true },
    { role: "custom", customType: "extension-trigger", display: false },
    { role: "assistant", stopReason: "stop" },
  ];
  assert.deepEqual(getTurnAnchors(messages), [true, false, true, false, false, true, false, false]);
});
