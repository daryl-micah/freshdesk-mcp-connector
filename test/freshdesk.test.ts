import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, ServerOptions } from "../src/server.ts";
import { createRazorpay } from "../src/razorpay.ts";
import { FreshdeskError, createClient, nextPageFromLink, normalizeDomain, paymentRefs, priorityName, statusName, ticketQuery } from "../src/freshdesk.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function client(responses: (Response | Error)[], maxAttempts = 3) {
  const sleeps: number[] = [];
  const reqs: { method?: string; url: string; body?: any }[] = [];
  let calls = 0;
  const c = createClient({
    domain: "acme", apiKey: "k", maxAttempts, log: () => {},
    sleep: async (ms) => void sleeps.push(ms),
    fetch: (async (url: URL, init: RequestInit) => {
      reqs.push({ method: init.method, url: String(url), body: init.body && JSON.parse(String(init.body)) });
      const r = responses[calls++];
      if (r instanceof Error) throw r;
      return r;
    }) as typeof fetch,
  });
  return { c, sleeps, reqs, calls: () => calls };
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

test("MCP tools: names, mapping, payment_refs, errors (SDK validates outputSchema)", async () => {
  const ticket = { id: 7, subject: "Refund", status: 2, priority: 4, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", description_text: "pay_ABCDEFGHIJKLMN" };
  const { c } = client([
    json({ results: [ticket], total: 45 }),
    json({ ...ticket, conversations: [{ body_text: "Done rfnd_ZZZZZZZZZZZZZZ", incoming: false, created_at: "2026-01-03T00:00:00Z" }] }),
    json({}, 404),
  ]);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(c).connect(b);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(a);

  assert.deepEqual((await mcp.listTools()).tools.map((t) => t.name).sort(), ["get_ticket", "list_agents", "list_groups", "list_tickets", "search_contacts", "search_tickets"]);

  const s = (await mcp.callTool({ name: "search_tickets", arguments: { status: "open" } })).structuredContent as any;
  assert.equal(s.tickets[0].status, "open");
  assert.equal(s.tickets[0].priority, "urgent");
  assert.equal(s.next_page, 2);

  const g = (await mcp.callTool({ name: "get_ticket", arguments: { id: 7 } })).structuredContent as any;
  assert.deepEqual(g.payment_refs.refund_ids, ["rfnd_ZZZZZZZZZZZZZZ"]);

  const nf = await mcp.callTool({ name: "get_ticket", arguments: { id: 999 } });
  assert.equal(nf.isError, true);
  assert.match((nf.content as any)[0].text, /Ticket 999 not found/);

  const none = await mcp.callTool({ name: "search_tickets", arguments: {} });
  assert.equal(none.isError, true);
  assert.match((none.content as any)[0].text, /at least one filter/i);
});

test("Retry-After: 0 waits 0s, not the 60s fallback", async () => {
  const { c, sleeps } = client([json({}, 429, { "retry-after": "0" }), json({})]);
  await c.get("/x");
  assert.deepEqual(sleeps, [0]);
});

test("POST is never resent after it may have landed; 429 still retries; PUT retries 5xx", async () => {
  const post5xx = client([json({}, 502), json({ id: 1 })]);
  await assert.rejects(post5xx.c.post("/tickets/1/reply", { body: "hi" }), (e: FreshdeskError) => e.status === 502 && !e.retryable && /may have been applied/.test(e.message));
  assert.equal(post5xx.calls(), 1);

  const postNet = client([new Error("socket hang up"), json({ id: 1 })]);
  await assert.rejects(postNet.c.post("/x", {}), (e: FreshdeskError) => e.status === 0 && /may have been applied/.test(e.message));
  assert.equal(postNet.calls(), 1);

  const post429 = client([json({}, 429, { "retry-after": "2" }), json({ id: 1 })]);
  assert.deepEqual((await post429.c.post("/x", {})).data, { id: 1 });
  assert.deepEqual(post429.sleeps, [2000]);

  const put5xx = client([json({}, 503), json({ ok: 1 })]);
  assert.deepEqual((await put5xx.c.put("/x", {})).data, { ok: 1 });
  assert.equal(put5xx.reqs[0].method, "PUT");
});

async function connect(c: ReturnType<typeof client>["c"], opts: ServerOptions) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(c, opts).connect(b);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(a);
  return mcp;
}
const errText = (r: any) => r.content[0].text as string;

test("write tools are absent unless writes are enabled", async () => {
  const mcp = await connect(client([]).c, {});
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  for (const w of ["add_note", "reply_to_ticket", "update_ticket", "assign_ticket", "update_tags", "verify_payment_refs"]) {
    assert.ok(!names.includes(w), w);
  }
});

test("write tools: escaping, typed bodies, tag merge, assign, validation, closure error", async () => {
  const t = { id: 5, subject: "S", status: 5, priority: 2, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", tags: ["refund", "vip"], responder_id: 11, group_id: 22 };
  const conv = { id: 9, ticket_id: 5, private: true, created_at: "2026-01-03T00:00:00Z" };
  const { c, reqs } = client([
    json(conv, 201), json({ ...conv, private: false }, 201), json(t), // note, reply, update_ticket
    json(t), json({ ...t, tags: ["refund", "new"] }), // update_tags: GET then PUT
    json(t), // assign_ticket
    json({ description: "Validation failed", errors: [{ field: "status", message: "Has 1 error: custom_field required" }] }, 400),
  ]);
  const mcp = await connect(c, { writes: true });
  const call = (name: string, args: Record<string, unknown>) => mcp.callTool({ name, arguments: args });

  const note = (await call("add_note", { id: 5, body: "a <b>&\nb" })).structuredContent as any;
  assert.equal(note.private, true);
  assert.deepEqual(reqs[0].body, { body: "a &lt;b&gt;&amp;<br>b", private: true });
  assert.match(reqs[0].url, /\/tickets\/5\/notes$/);

  await call("reply_to_ticket", { id: 5, body: "Refund sent" });
  assert.match(reqs[1].url, /\/tickets\/5\/reply$/);
  assert.deepEqual(reqs[1].body, { body: "Refund sent" });

  const up = (await call("update_ticket", { id: 5, status: "closed", priority: "high" })).structuredContent as any;
  assert.deepEqual(reqs[2].body, { status: 5, priority: 3 });
  assert.equal(up.ticket.status, "closed");

  await call("update_tags", { id: 5, add: ["new"], remove: ["VIP"] });
  assert.equal(reqs[3].method, "GET");
  assert.deepEqual(reqs[4].body, { tags: ["refund", "new"] });

  const as = (await call("assign_ticket", { id: 5, responder_id: 11 })).structuredContent as any;
  assert.deepEqual(reqs[5].body, { responder_id: 11 });
  assert.equal(as.responder_id, 11);

  const empty = await call("update_ticket", { id: 5 });
  assert.equal(empty.isError, true);
  assert.match(errText(empty), /status and\/or priority/);
  assert.equal((await call("assign_ticket", { id: 5 })).isError, true);
  assert.equal(reqs.length, 6, "validation errors make no API call");

  const closure = await call("update_ticket", { id: 5, status: "resolved" });
  assert.equal(closure.isError, true);
  assert.match(errText(closure), /status: .*custom_field required/);
});

test("verify_payment_refs: live state, unknown id is found:false, auth errors surface", async () => {
  const rz = (responses: Response[]) => {
    const r = client(responses);
    return { ...r, rz: createRazorpay({ keyId: "rzp_test_x", keySecret: "s", log: () => {}, sleep: async () => {}, fetch: (async (url: URL, init: RequestInit) => {
      r.reqs.push({ method: init.method, url: String(url) });
      return responses.shift()!;
    }) as typeof fetch }) };
  };
  const ok = rz([
    json({ id: "pay_ABCDEFGHIJKLMN", status: "captured", amount: 49900, currency: "INR", amount_refunded: 0, refund_status: null }),
    json({ error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" } }, 400),
    json({ id: "rfnd_ZZZZZZZZZZZZZZ", payment_id: "pay_ABCDEFGHIJKLMN", status: "processed", amount: 49900, currency: "INR" }),
  ]);
  const mcp = await connect(client([]).c, { razorpay: ok.rz });
  const r = (await mcp.callTool({ name: "verify_payment_refs", arguments: { ids: ["pay_ABCDEFGHIJKLMN", "order_ABCDEFGHIJKLMN", "rfnd_ZZZZZZZZZZZZZZ", "pay_ABCDEFGHIJKLMN"] } })).structuredContent as any;
  assert.equal(r.results.length, 3, "duplicates are looked up once");
  assert.equal(r.results[0].status, "captured");
  assert.equal(r.results[1].found, false);
  assert.match(r.results[1].note, /does not exist/);
  assert.equal(r.results[2].payment_id, "pay_ABCDEFGHIJKLMN");
  assert.deepEqual(ok.reqs.map((q) => new URL(q.url).pathname).sort(), ["/v1/orders/order_ABCDEFGHIJKLMN", "/v1/payments/pay_ABCDEFGHIJKLMN", "/v1/refunds/rfnd_ZZZZZZZZZZZZZZ"]);

  const bad = rz([json({ error: { description: "Authentication failed" } }, 401)]);
  const mcp2 = await connect(client([]).c, { razorpay: bad.rz });
  const e = await mcp2.callTool({ name: "verify_payment_refs", arguments: { ids: ["pay_ABCDEFGHIJKLMN"] } });
  assert.equal(e.isError, true);
  assert.match(errText(e), /RAZORPAY_KEY_ID/);

  const invalid = await mcp.callTool({ name: "verify_payment_refs", arguments: { ids: ["../../x"] } });
  assert.equal(invalid.isError, true);
});
