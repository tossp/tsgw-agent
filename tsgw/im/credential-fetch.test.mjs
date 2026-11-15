import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import Sentry from "@sentry/nextjs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { verifyTelegramToken } = await jiti.import("./telegram.ts");
const { weixinRequest } = await jiti.import("./weixin-transport.ts");
const { getAgentTracingOptions } = await jiti.import("../agent-tracing/policy.ts");
const secrets = ["123:private-telegram", "999:private-rejected", "private-qr-ticket", "private-weixin"];

function events(envelopes) {
  return envelopes.flatMap(([, items]) => items.flatMap(([header, payload]) => header.type === "event" ? [payload] : []));
}

test("credential requests leave no Token or QR ticket in real Sentry envelopes while ordinary HTTP breadcrumbs remain", { timeout: 10_000 }, async (t) => {
  const envelopes = [];
  Sentry.init({
    dsn: "https://public@telemetry.invalid/10", ...getAgentTracingOptions(),
    tracePropagationTargets: [], beforeSendLog: () => null, beforeSendMetric: () => null,
    transport: () => ({ send(envelope) { envelopes.push(envelope); return Promise.resolve({ statusCode: 200 }); }, flush: () => Promise.resolve(true) }),
  });
  t.after(() => Sentry.close(1000));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url.startsWith("/bot999:")) { response.writeHead(401); response.end(); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true, result: { id: 123, is_bot: true, username: "test_bot" }, ret: 0 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const localFetch = (input, init) => {
    const original = new URL(String(input));
    return fetch(`${base}${original.pathname}${original.search}`, init);
  };

  // Negative control: the deployed integration does record a token-bearing path without suppression.
  await (await fetch(`${base}/bot111:control-secret/getMe`)).text();
  Sentry.captureMessage("control");
  await Sentry.flush(1000);
  assert.match(JSON.stringify(events(envelopes).find((event) => event.message === "control").breadcrumbs), /control-secret/);
  Sentry.getIsolationScope().clearBreadcrumbs();

  await verifyTelegramToken(secrets[0], localFetch);
  await assert.rejects(verifyTelegramToken(secrets[1], localFetch), /getMe failed/);
  await weixinRequest({
    fetchImpl: localFetch, baseUrl: "https://ilinkai.weixin.qq.com/",
    endpoint: `ilink/bot/get_qrcode_status?qrcode=${secrets[2]}`, token: secrets[3],
  });
  await (await fetch(`${base}/ordinary-request`)).text();
  Sentry.captureMessage("after-credential-requests");
  await Sentry.flush(1000);
  const delivered = JSON.stringify(events(envelopes).find((event) => event.message === "after-credential-requests"));
  assert.match(delivered, /ordinary-request/);
  for (const secret of secrets) assert.ok(!delivered.includes(secret), secret);
  for (const secret of secrets.slice(0, 3)) assert.ok(requests.some((path) => path.includes(secret)));
});
