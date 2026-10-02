// Live end-to-end check against a real Freshdesk account (run `npm run seed` first).
import assert from "node:assert/strict";
import { createClient } from "../src/freshdesk.ts";
import { clientFromEnv } from "../src/server.ts";

const fd = clientFromEnv();
const step = async (name: string, fn: () => Promise<void>) => { await fn(); console.log("ok  ", name); };

await step("auth ok", async () => void (await fd.get("/agents/me")));
await step("bad key -> clean 401", async () => {
  const bad = createClient({ domain: process.env.FRESHDESK_DOMAIN!, apiKey: "nope", log: () => {} });
  await assert.rejects(bad.get("/agents/me"), /Authentication failed/);
});
let firstId = 0;
await step("list + pagination", async () => {
  const p1 = await fd.get("/tickets", { per_page: 5, updated_since: "2020-01-01" });
  const rows = p1.data as { id: number }[];
  assert.ok(rows.length > 0); firstId = rows[0].id;
  assert.equal(p1.nextPage, 2);
  assert.ok(((await fd.get("/tickets", { per_page: 5, page: 2, updated_since: "2020-01-01" })).data as unknown[]).length > 0);
});
await step("get with conversations", async () => {
  const t = (await fd.get(`/tickets/${firstId}`, { include: "requester,conversations" })).data as { requester: unknown };
  assert.ok(t.requester);
});
await step("missing id -> 404", async () => { await assert.rejects(fd.get("/tickets/999999999"), /Not found/); });
await step("search by status/priority/tag", async () => {
  for (const q of [`"status:2"`, `"priority:4"`, `"tag:'refund'"`]) {
    const r = (await fd.get("/search/tickets", { query: q })).data as { total: number };
    assert.ok(r.total >= 0);
  }
});
await step("contact search", async () => {
  const r = (await fd.get("/search/contacts", { query: `"email:'asha@kiranastore.example'"` })).data as { results: unknown[] };
  assert.ok(r.results.length >= 1);
});
await step("burst tracks rate-limit headers", async () => {
  for (let i = 0; i < 10; i++) await fd.get("/agents/me");
  console.log("     X-Ratelimit-Remaining =", fd.rateLimit());
  assert.ok(fd.rateLimit() !== undefined);
});
