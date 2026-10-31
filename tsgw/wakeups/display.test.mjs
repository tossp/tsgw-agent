import assert from "node:assert/strict";
import test from "node:test";
import { isMessageGroupAnchor } from "../../lib/message-display.ts";

test("a displayed wakeup notification starts its own turn instead of folding the previous answer", () => {
  const message = { role: "custom", customType: "pi-web:wakeup-notification", display: true };
  assert.equal(isMessageGroupAnchor(message), true);
  assert.equal(isMessageGroupAnchor({ ...message, display: false }), false);
});
