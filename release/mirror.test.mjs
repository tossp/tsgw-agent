import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Run the actual workflow's inline script with fetch mocked: tests must never
// enqueue real mirror tasks or publish npm packages.
const workflow = readFileSync(new URL("../.github/workflows/tsgw-npm.yml", import.meta.url), "utf8");
const step = workflow.split("      - name: Request npmmirror sync\n")[1]?.split("      - name: Summarize the publish")[0];
const body = step?.match(/<<'NODE'\n([\s\S]*?)          NODE/)?.[1];
const code = body?.split("\n").map((line) => line.slice(10)).join("\n");

test("mirror request follows successful npm publication and observes the publish gate", () => {
  assert.ok(code, "The npmmirror request script must exist");
  assert.match(step, /if: steps\.gate\.outputs\.should_publish == 'true'/);
  assert.doesNotMatch(step, /always\(\)|failure\(\)|npm publish/);
  const publish = workflow.indexOf("      - name: Publish with trusted publishing (OIDC)");
  const confirm = workflow.indexOf("      - name: Confirm the version is served (read-only)");
  const mirror = workflow.indexOf("      - name: Request npmmirror sync");
  assert.ok(publish !== -1 && publish < confirm && confirm < mirror);
  assert.match(workflow, /steps\.mirror\.outputs\.status/);
});

for (const [name, mock, expected] of [
  ["accepted task", 'return Response.json({ok:true,id:"task-1",state:"waiting"},{status:201});', "requested"],
  ["HTTP failure", 'return new Response("rate limited",{status:429});', "failed"],
  ["network failure", 'throw new Error("network unavailable");', "failed"],
  ["timeout", 'throw new DOMException("timed out","TimeoutError");', "failed"],
  ["rejected task", 'return Response.json({error:"rejected"});', "failed"],
  ["failed task", 'return Response.json({ok:true,id:"task-2",state:"error"});', "failed"],
  ["invalid JSON", 'return new Response("<html>unavailable</html>");', "failed"],
]) {
  test(`mirror sync: ${name} does not change the npm publish result`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "tsgw-mirror-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const output = join(directory, "outputs");
    const stub = `import assert from "node:assert/strict";
      globalThis.fetch = async (url, options) => {
        assert.equal(url, "https://registry-direct.npmmirror.com/-/package/tsgw-agent/syncs");
        assert.equal(options.method, "PUT");
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.body, "{}");
        assert.equal(options.redirect, "error");
        assert.ok(options.signal instanceof AbortSignal);
        ${mock}
      };\n`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
      input: stub + code, encoding: "utf8", timeout: 5_000,
      env: { ...process.env, PKG_NAME: "tsgw-agent", GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, "utf8"), `status=${expected}\n`);
    assert.equal(result.stdout.includes("::warning::"), expected === "failed");
    if (expected === "requested") assert.match(result.stdout, /"taskId":"task-1"/);
  });
}
