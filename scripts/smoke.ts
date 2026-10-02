// Live end-to-end check against a real Freshdesk account (run `npm run seed` first, wait ~5 min for search indexing).
// Drives the real server over stdio, so it exercises tool schemas + output, not just the HTTP client.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createClient } from "../src/freshdesk.ts";
import { clientFromEnv } from "../src/server.ts";

const fd = clientFromEnv(); // also loads .env into process.env
const mcp = new Client({ name: "smoke", version: "0" });
await mcp.connect(
  new StdioClientTransport({
    command: "npx",
    args: ["tsx", fileURLToPath(new URL("../src/server.ts", import.meta.url))],
    env: process.env as Record<string, string>,
  }),
);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  return { isError: r.isError === true, out: r.structuredContent as any, text: (r.content as any)[0]?.text as string };
};
const step = async (name: string, fn: () => Promise<void>) => { await fn(); console.log("ok  ", name); };

await step("bad key -> clean 401", async () => {
  const bad = createClient({ domain: process.env.FRESHDESK_DOMAIN!, apiKey: "nope", log: () => {} });
  await assert.rejects(bad.get("/agents/me"), /Authentication failed/);
});
let firstId = 0;
await step("list_tickets page 1 -> 2", async () => {
  const p1 = await call("list_tickets", { per_page: 5, updated_since: "2020-01-01" });
  assert.ok(!p1.isError, p1.text);
  assert.equal(p1.out.tickets.length, 5);
  assert.equal(p1.out.next_page, 2);
  firstId = p1.out.tickets[0].id;
  const p2 = await call("list_tickets", { per_page: 5, page: 2, updated_since: "2020-01-01" });
  assert.ok(p2.out.tickets.length > 0);
});
await step("search_tickets by status, priority, tag", async () => {
  for (const f of [{ status: "open" }, { priority: "urgent" }, { tag: "refund" }]) {
    const r = await call("search_tickets", f);
    assert.ok(!r.isError, r.text);
    assert.ok(r.out.total > 0, `no results for ${JSON.stringify(f)} (search indexing can take ~5 min)`);
  }
});
await step("get_ticket found + missing", async () => {
  const ok = await call("get_ticket", { id: firstId });
  assert.ok(!ok.isError && ok.out.requester, ok.text);
  const nf = await call("get_ticket", { id: 999999999 });
  assert.ok(nf.isError && /not found/i.test(nf.text), nf.text);
});
await step("search_contacts", async () => {
  const r = await call("search_contacts", { email: "asha@kiranastore.example" });
  assert.ok(!r.isError && r.out.contacts.length >= 1, r.text);
});
await step("payment_refs: a seeded ticket has a payment ID and no refund ID", async () => {
  const r = await call("search_tickets", { tag: "refund" });
  assert.ok(r.out.tickets.some((t: any) => t.payment_refs.payment_ids.length && !t.payment_refs.refund_ids.length));
});
await step("burst tracks rate-limit headers", async () => {
  for (let i = 0; i < 10; i++) await fd.get("/agents/me");
  console.log("     X-Ratelimit-Remaining =", fd.rateLimit());
  assert.ok(fd.rateLimit() !== undefined);
});

await mcp.close();
