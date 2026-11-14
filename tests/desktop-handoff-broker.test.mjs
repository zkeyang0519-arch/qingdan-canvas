import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopHandoff } from "../scripts/lib/desktop-handoff-broker.mjs";
const context = {
  accountId: "alice",
  roomId: "room-a",
  sessionToken: "a".repeat(64),
};
async function fixture(t, options) {
  const b = await createDesktopHandoff(context, options);
  t.after(() => b.close());
  return b;
}
function call(b, path, body, headers = {}) {
  return fetch(b.descriptor.endpoint + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + b.descriptor.nonce, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
test("handoff has one native-only claim and requires an authenticated applied receipt", async (t) => {
  const b = await fixture(t);
  assert.equal(
    JSON.stringify(b.descriptor).includes(context.sessionToken),
    false,
  );
  assert.equal(
    (await call(b, "/claim", undefined, { Authorization: "Bearer wrong" }))
      .status,
    403,
  );
  assert.equal(
    (await call(b, "/claim", undefined, { Origin: "http://127.0.0.1:8790" }))
      .status,
    403,
  );
  assert.equal((await call(b, "/result", { applied: true })).status, 409);
  assert.equal((await call(b, "/check")).status, 409);
  const claim = await call(b, "/claim");
  assert.equal(claim.status, 200);
  assert.deepEqual(await claim.json(), context);
  assert.deepEqual(await (await call(b, "/check")).json(), { active: true });
  assert.equal((await call(b, "/claim")).status, 409);
  assert.equal(
    (await call(b, "/result", { applied: true, secret: "must-reject" })).status,
    400,
  );
  assert.equal((await call(b, "/result", { applied: true })).status, 200);
  assert.deepEqual(await b.result, { applied: true });
  await b.close();
  await assert.rejects(fetch(b.descriptor.endpoint + "/claim"));
});
test("handoff failure uses fixed messages and clears capability on completion", async (t) => {
  const b = await fixture(t);
  await call(b, "/claim");
  await call(b, "/result", {
    applied: false,
    code: "cancelled",
    error: context.sessionToken,
  });
  const result = await b.result;
  assert.equal(result.applied, false);
  assert.equal(result.code, "cancelled");
  assert.equal(JSON.stringify(result).includes(context.sessionToken), false);
});
test("an old non-responding desktop cannot report handoff success", async (t) => {
  const b = await fixture(t, { claimTimeoutMs: 25, timeoutMs: 1000 });
  const result = await b.result;
  assert.equal(result.applied, false);
  assert.match(result.error, /托盘/);
  await assert.rejects(fetch(b.descriptor.endpoint + "/claim"));
});

test("a claimed handoff expires while waiting for a user decision", async (t) => {
  const b = await fixture(t, { claimTimeoutMs: 1000, timeoutMs: 30 });
  await call(b, "/claim");
  const result = await b.result;
  assert.equal(result.code, "timeout");
  await assert.rejects(call(b, "/check"));
});
