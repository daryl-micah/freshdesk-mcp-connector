import { test } from "node:test";
import assert from "node:assert/strict";
import { FreshdeskError, createClient, nextPageFromLink, normalizeDomain, paymentRefs, priorityName, statusName, ticketQuery } from "../src/freshdesk.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function client(responses: (Response | Error)[], maxAttempts = 3) {
  const sleeps: number[] = [];
  let calls = 0;
  const c = createClient({
    domain: "acme", apiKey: "k", maxAttempts, log: () => {},
    sleep: async (ms) => void sleeps.push(ms),
    fetch: (async () => {
      const r = responses[calls++];
      if (r instanceof Error) throw r;
      return r;
    }) as typeof fetch,
  });
  return { c, sleeps, calls: () => calls };
}

test("429 waits Retry-After then succeeds", async () => {
  const { c, sleeps } = client([json({}, 429, { "retry-after": "7" }), json({ ok: 1 })]);
  assert.deepEqual((await c.get("/x")).data, { ok: 1 });
  assert.deepEqual(sleeps, [7000]);
});

test("429 Retry-After is capped at 60s", async () => {
  const { c, sleeps } = client([json({}, 429, { "retry-after": "999" }), json({})]);
  await c.get("/x");
  assert.equal(sleeps[0], 60_000);
});

test("5xx backs off then succeeds", async () => {
  const { c, calls } = client([json({}, 503), json({}, 500), json({ ok: 1 })]);
  await c.get("/x");
  assert.equal(calls(), 3);
});

test("5xx gives up after max attempts as retryable error", async () => {
  const { c } = client([json({}, 500), json({}, 500), json({}, 500)]);
  await assert.rejects(c.get("/x"), (e: FreshdeskError) => e.status === 500 && e.retryable);
});

test("404 is not retried and carries detail", async () => {
  const { c, calls } = client([json({ description: "Validation failed", errors: [{ field: "id", message: "nope" }] }, 404)]);
  await assert.rejects(c.get("/tickets/1"), (e: FreshdeskError) => e.status === 404 && /id: nope/.test(e.message));
  assert.equal(calls(), 1);
});

test("timeout is retried, then reported as timed out", async () => {
  const t = () => Object.assign(new Error("aborted"), { name: "TimeoutError" });
  const { c, calls } = client([t(), t(), t()]);
  await assert.rejects(c.get("/x"), (e: FreshdeskError) => e.status === 0 && /timed out/.test(e.message));
  assert.equal(calls(), 3);
});

test("404 on a ticket id names the ticket", async () => {
  const { c } = client([json({}, 404)]);
  await assert.rejects(c.get("/tickets/123"), /Ticket 123 not found/);
});

test("401 gives an actionable message", async () => {
  const { c } = client([json({}, 401)]);
  await assert.rejects(c.get("/x"), /FRESHDESK_API_KEY/);
});

test("network error retried, then surfaced with status 0", async () => {
  const { c } = client([new Error("boom"), new Error("boom"), new Error("boom")]);
  await assert.rejects(c.get("/x"), (e: FreshdeskError) => e.status === 0 && /boom/.test(e.message));
});

test("low rate-limit remaining slows the next call", async () => {
  const { c, sleeps } = client([json({}, 200, { "x-ratelimit-remaining": "2" })]);
  await c.get("/x");
  assert.deepEqual(sleeps, [2000]);
  assert.equal(c.rateLimit(), 2);
});

test("Link header pagination", () => {
  assert.equal(nextPageFromLink('<https://a.freshdesk.com/api/v2/tickets?page=3&per_page=30>; rel="next"'), 3);
  assert.equal(nextPageFromLink(null), null);
});

test("domain only allows *.freshdesk.com", () => {
  assert.equal(normalizeDomain("https://Acme.freshdesk.com/"), "acme.freshdesk.com");
  assert.equal(normalizeDomain("acme"), "acme.freshdesk.com");
  assert.throws(() => normalizeDomain("evil.com"));
});

test("ticketQuery builds and rejects unsafe input", () => {
  assert.equal(ticketQuery({ status: "open", priority: "urgent", tag: "refund" }), `"status:2 AND priority:4 AND tag:'refund'"`);
  assert.equal(ticketQuery({ created_after: "2026-01-01" }), `"created_at:>'2026-01-01'"`);
  assert.throws(() => ticketQuery({ tag: `x' OR status:2 OR tag:'y` }), /Unsupported/);
  assert.throws(() => ticketQuery({ created_after: "yesterday" }), /YYYY-MM-DD/);
  assert.throws(() => ticketQuery({}), /at least one/);
  assert.throws(() => ticketQuery({ tag: "a".repeat(600) }), /512/);
});

test("paymentRefs dedupes and ignores wrong-length ids", () => {
  const r = paymentRefs("pay_ABCDEFGHIJKLMN twice pay_ABCDEFGHIJKLMN", "order_12345678901234 rfnd_ZZZZZZZZZZZZZZ pay_short pay_ABCDEFGHIJKLMNO");
  assert.deepEqual(r, { payment_ids: ["pay_ABCDEFGHIJKLMN"], order_ids: ["order_12345678901234"], refund_ids: ["rfnd_ZZZZZZZZZZZZZZ"] });
});

test("enum maps, with fallback for custom statuses", () => {
  assert.equal(statusName(2), "open");
  assert.equal(statusName(5), "closed");
  assert.equal(priorityName(4), "urgent");
  assert.equal(statusName(99), "custom_99");
});
