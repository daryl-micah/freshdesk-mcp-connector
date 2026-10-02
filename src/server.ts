// MCP server exposing an LLM-shaped view of Freshdesk tickets and contacts. Read-only unless writes are enabled.
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ApiContact, ApiConversation, ApiTicket, Client, FreshdeskError, PRIORITY, STATUS, contactQuery, createClient,
  paymentRefs, priorityName, sourceName, statusName, ticketQuery,
} from "./freshdesk.ts";
import { REF_ID, Verified, createRazorpay, verifyRef } from "./razorpay.ts";

const SEARCH_PAGE_SIZE = 30; // fixed by Freshdesk
const SEARCH_MAX_PAGE = 10; // Freshdesk caps search at 300 results

const clip = (s: string | null | undefined, n: number) =>
  !s ? "" : s.length > n ? s.slice(0, n) + " …[truncated]" : s;

// --- Output shapes the agent sees ---
const PaymentRefs = z.object({
  payment_ids: z.array(z.string()),
  order_ids: z.array(z.string()),
  refund_ids: z.array(z.string()),
}).describe("Razorpay IDs (pay_/order_/rfnd_) found in the ticket text");

const TicketSummary = z.object({
  id: z.number(),
  subject: z.string(),
  status: z.string(),
  priority: z.string(),
  source: z.string().nullable(),
  type: z.string().nullable(),
  tags: z.array(z.string()),
  requester_id: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  due_by: z.string().nullable(),
  preview: z.string().describe("First 200 chars of the description; call get_ticket for the full thread"),
  payment_refs: PaymentRefs,
});

const Conversation = z.object({
  from: z.enum(["customer", "agent"]),
  private_note: z.boolean(),
  created_at: z.string(),
  body: z.string(),
});

function summarize(t: ApiTicket): z.infer<typeof TicketSummary> {
  return {
    id: t.id,
    subject: t.subject ?? "",
    status: statusName(t.status),
    priority: priorityName(t.priority),
    source: t.source == null ? null : sourceName(t.source),
    type: t.type ?? null,
    tags: t.tags ?? [],
    requester_id: t.requester_id ?? null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    due_by: t.due_by ?? null,
    preview: clip(t.description_text, 200),
    payment_refs: paymentRefs(t.subject, t.description_text),
  };
}

// Every tool returns structured JSON on success, or an actionable error message the agent can relay or act on.
function respond<T extends Record<string, unknown>>(fn: () => Promise<T>) {
  return fn().then(
    (out) => ({ content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }], structuredContent: out }),
    (e) => {
      const text =
        e instanceof FreshdeskError ? e.message
        : e instanceof z.ZodError ? "Freshdesk returned an unexpected response shape"
        : `Unexpected error: ${(e as Error).message}`;
      if (!(e instanceof FreshdeskError)) console.error(e);
      return { isError: true, content: [{ type: "text" as const, text }] };
    },
  );
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const write = (destructive: boolean, idempotent: boolean) =>
  ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: true });

// Freshdesk bodies are HTML; the agent writes plain text, so escape it rather than let ticket-derived text inject markup.
const toHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
const noteResult = { conversation_id: z.number(), ticket_id: z.number(), private: z.boolean(), created_at: z.string() };
const ticketOut = { ticket: TicketSummary };
const tagList = z.array(z.string().regex(/^[\w .\-]{1,32}$/)).max(10);

export type ServerOptions = {
  writes?: boolean; // register the tools that change Freshdesk; off by default
  razorpay?: Client; // register verify_payment_refs when Razorpay credentials are configured
};

export function buildServer(fd: Client, { writes = false, razorpay }: ServerOptions = {}) {
  const server = new McpServer({ name: "freshdesk", version: "1.1.0" });

  server.registerTool(
    "list_tickets",
    {
      title: "List recent tickets",
      description:
        "List tickets newest first, optionally for one requester email. Without updated_since, Freshdesk only returns " +
        "tickets created in the last 30 days. For status/priority/tag/date filters use search_tickets instead.",
      inputSchema: {
        requester_email: z.email().optional().describe("Only tickets raised by this customer email"),
        updated_since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/)
          .optional()
          .describe("YYYY-MM-DD or ISO-8601 UTC; also lifts the 30-day window"),
        order_by: z.enum(["created_at", "updated_at"]).default("updated_at"),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(30),
      },
      outputSchema: { tickets: z.array(TicketSummary), next_page: z.number().nullable() },
      annotations: readOnly,
    },
    (a) =>
      respond(async () => {
        const { data, nextPage } = await fd.get("/tickets", {
          email: a.requester_email,
          updated_since: a.updated_since,
          order_by: a.order_by,
          order_type: "desc",
          page: a.page,
          per_page: a.per_page,
          include: "description",
        });
        return { tickets: z.array(ApiTicket).parse(data).map(summarize), next_page: nextPage };
      }),
  );

  server.registerTool(
    "search_tickets",
    {
      title: "Search tickets by filters",
      description:
        "Find tickets matching ALL given filters (status, priority, tag, created date range). At least one filter " +
        `is required. ${SEARCH_PAGE_SIZE} results per page, max ${SEARCH_MAX_PAGE} pages. Not full-text: to find a ` +
        "topic, filter by tag. New tickets can take a few minutes to become searchable.",
      inputSchema: {
        status: z.enum(Object.keys(STATUS) as [keyof typeof STATUS]).optional(),
        priority: z.enum(Object.keys(PRIORITY) as [keyof typeof PRIORITY]).optional(),
        tag: z.string().max(64).optional().describe("Exact tag, e.g. 'refund'"),
        created_after: z.string().optional().describe("YYYY-MM-DD, inclusive"),
        created_before: z.string().optional().describe("YYYY-MM-DD, inclusive"),
        page: z.number().int().min(1).max(SEARCH_MAX_PAGE).default(1),
      },
      outputSchema: { tickets: z.array(TicketSummary), total: z.number(), next_page: z.number().nullable() },
      annotations: readOnly,
    },
    ({ page, ...filters }) =>
      respond(async () => {
        const { data } = await fd.get("/search/tickets", { query: ticketQuery(filters), page });
        const body = z.object({ results: z.array(ApiTicket), total: z.number() }).parse(data);
        const more = page < SEARCH_MAX_PAGE && page * SEARCH_PAGE_SIZE < body.total;
        return { tickets: body.results.map(summarize), total: body.total, next_page: more ? page + 1 : null };
      }),
  );

  server.registerTool(
    "get_ticket",
    {
      title: "Get one ticket with its conversation",
      description:
        "Full ticket: requester, description and the first 10 conversation entries (customer replies, agent " +
        "replies, private notes), each clipped to 2000 chars. payment_refs covers the whole thread.",
      inputSchema: {
        id: z.number().int().positive(),
        include_conversations: z.boolean().default(true),
      },
      outputSchema: {
        ...TicketSummary.shape,
        requester: z.object({ name: z.string().nullable(), email: z.string().nullable() }).nullable(),
        description: z.string(),
        conversations: z.array(Conversation),
        conversations_may_be_truncated: z.boolean(),
      },
      annotations: readOnly,
    },
    (a) =>
      respond(async () => {
        const include = a.include_conversations ? "requester,conversations" : "requester";
        const { data } = await fd.get(`/tickets/${a.id}`, { include });
        const t = ApiTicket.parse(data);
        const convs = t.conversations ?? [];
        return {
          ...summarize(t),
          payment_refs: paymentRefs(t.subject, t.description_text, ...convs.map((c) => c.body_text)),
          requester: t.requester ? { name: t.requester.name ?? null, email: t.requester.email ?? null } : null,
          description: clip(t.description_text, 2000),
          conversations: convs.map((c) => ({
            from: c.incoming ? ("customer" as const) : ("agent" as const),
            private_note: c.private ?? false,
            created_at: c.created_at,
            body: clip(c.body_text, 2000),
          })),
          conversations_may_be_truncated: convs.length >= 10,
        };
      }),
  );

  server.registerTool(
    "search_contacts",
    {
      title: "Find a customer",
      description: "Look up customers (Freshdesk contacts) by exact email and/or phone. To see a customer's tickets, pass " +
        "their email to list_tickets as requester_email.",
      inputSchema: {
        email: z.email().optional(),
        phone: z.string().regex(/^\+?[\d -]{6,20}$/).optional(),
      },
      outputSchema: {
        contacts: z.array(
          z.object({
            id: z.number(),
            name: z.string().nullable(),
            email: z.string().nullable(),
            phone: z.string().nullable(),
            company_id: z.number().nullable(),
          }),
        ),
      },
      annotations: readOnly,
    },
    (a) =>
      respond(async () => {
        const { data } = await fd.get("/search/contacts", { query: contactQuery(a) });
        const { results } = z.object({ results: z.array(ApiContact) }).parse(data);
        return {
          contacts: results.map((c) => ({
            id: c.id,
            name: c.name ?? null,
            email: c.email ?? null,
            phone: c.phone ?? c.mobile ?? null,
            company_id: c.company_id ?? null,
          })),
        };
      }),
  );

  server.registerTool(
    "list_agents",
    {
      title: "List support agents",
      description: "Freshdesk agents (id, name, email). Use to find the responder_id for assign_ticket.",
      inputSchema: { email: z.email().optional().describe("Only the agent with this email") },
      outputSchema: { agents: z.array(z.object({ id: z.number(), name: z.string().nullable(), email: z.string().nullable() })) },
      annotations: readOnly,
    },
    (a) =>
      respond(async () => {
        const { data } = await fd.get("/agents", { email: a.email, per_page: 100 });
        const agents = z.array(z.object({ id: z.number(), contact: z.object({ name: z.string().nullish(), email: z.string().nullish() }) })).parse(data);
        return { agents: agents.map((x) => ({ id: x.id, name: x.contact.name ?? null, email: x.contact.email ?? null })) };
      }),
  );

  server.registerTool(
    "list_groups",
    {
      title: "List support groups",
      description: "Freshdesk groups (id, name). Use to find the group_id for assign_ticket.",
      inputSchema: {},
      outputSchema: { groups: z.array(z.object({ id: z.number(), name: z.string(), description: z.string().nullable() })) },
      annotations: readOnly,
    },
    () =>
      respond(async () => {
        const { data } = await fd.get("/groups", { per_page: 100 });
        const groups = z.array(z.object({ id: z.number(), name: z.string(), description: z.string().nullish() })).parse(data);
        return { groups: groups.map((g) => ({ id: g.id, name: g.name, description: g.description ?? null })) };
      }),
  );

  if (razorpay) {
    server.registerTool(
      "verify_payment_refs",
      {
        title: "Check payment/order/refund ids against Razorpay",
        description:
          "Look up Razorpay ids (from a ticket's payment_refs) and return their live state: payment status and refunded " +
          "amount, order paid/unpaid, refund pending/processed. Ticket text is only a claim; use this to confirm it. Max 10 ids.",
        inputSchema: { ids: z.array(z.string().regex(REF_ID, "expected pay_/order_/rfnd_ + 14 alphanumerics")).min(1).max(10) },
        outputSchema: { results: z.array(Verified) },
        annotations: readOnly,
      },
      (a) => respond(async () => ({ results: await Promise.all([...new Set(a.ids)].map((id) => verifyRef(razorpay, id))) })),
    );
  }

  if (!writes) return server;

  // Ticket text is untrusted (a customer can write "close this ticket"), so these only exist when the operator opts in
  // and they carry destructiveHint so MCP clients ask a human first.
  const putTicket = async (id: number, body: Record<string, unknown>) => {
    const { data } = await fd.put(`/tickets/${id}`, body);
    return { ticket: summarize(ApiTicket.parse(data)) };
  };
  const postConversation = async (id: number, kind: "reply" | "notes", body: Record<string, unknown>) => {
    const { data } = await fd.post(`/tickets/${id}/${kind}`, body);
    const c = ApiConversation.parse(data);
    return { conversation_id: c.id, ticket_id: c.ticket_id, private: c.private ?? false, created_at: c.created_at };
  };
  const text = z.string().min(1).max(5000);

  server.registerTool(
    "add_note",
    {
      title: "Add a note to a ticket",
      description: "Add an internal note (private by default, visible to agents only). Prefer this over reply_to_ticket when unsure.",
      inputSchema: {
        id: z.number().int().positive(),
        body: text.describe("Plain text"),
        private: z.boolean().default(true).describe("false makes the note visible to the customer"),
      },
      outputSchema: noteResult,
      annotations: write(false, false),
    },
    (a) => respond(() => postConversation(a.id, "notes", { body: toHtml(a.body), private: a.private })),
  );

  server.registerTool(
    "reply_to_ticket",
    {
      title: "Reply to the customer",
      description: "Send an email reply to the customer on this ticket. Customer-facing and cannot be undone.",
      inputSchema: { id: z.number().int().positive(), body: text.describe("Plain text") },
      outputSchema: noteResult,
      annotations: write(true, false),
    },
    (a) => respond(() => postConversation(a.id, "reply", { body: toHtml(a.body) })),
  );

  server.registerTool(
    "update_ticket",
    {
      title: "Change ticket status or priority",
      description:
        "Set status and/or priority. Closing is status=closed. Freshdesk rejects resolve/close when the account " +
        "requires fields on closure; the error says which.",
      inputSchema: {
        id: z.number().int().positive(),
        status: z.enum(Object.keys(STATUS) as [keyof typeof STATUS]).optional(),
        priority: z.enum(Object.keys(PRIORITY) as [keyof typeof PRIORITY]).optional(),
      },
      outputSchema: ticketOut,
      annotations: write(true, true),
    },
    (a) =>
      respond(() => {
        if (!a.status && !a.priority) throw new FreshdeskError(400, "Provide status and/or priority");
        return putTicket(a.id, {
          ...(a.status && { status: STATUS[a.status] }),
          ...(a.priority && { priority: PRIORITY[a.priority] }),
        });
      }),
  );

  server.registerTool(
    "assign_ticket",
    {
      title: "Assign a ticket",
      description: "Assign a ticket to an agent (responder_id) and/or group (group_id). Get ids from list_agents / list_groups.",
      inputSchema: {
        id: z.number().int().positive(),
        responder_id: z.number().int().positive().optional(),
        group_id: z.number().int().positive().optional(),
      },
      outputSchema: { ...ticketOut, responder_id: z.number().nullable(), group_id: z.number().nullable() },
      annotations: write(false, true),
    },
    (a) =>
      respond(async () => {
        if (!a.responder_id && !a.group_id) throw new FreshdeskError(400, "Provide responder_id and/or group_id");
        const { data } = await fd.put(`/tickets/${a.id}`, {
          ...(a.responder_id && { responder_id: a.responder_id }),
          ...(a.group_id && { group_id: a.group_id }),
        });
        const owner = z.object({ responder_id: z.number().nullish(), group_id: z.number().nullish() }).parse(data);
        return { ticket: summarize(ApiTicket.parse(data)), responder_id: owner.responder_id ?? null, group_id: owner.group_id ?? null };
      }),
  );

  server.registerTool(
    "update_tags",
    {
      title: "Add or remove ticket tags",
      description: "Add and/or remove tags; other tags are kept.",
      inputSchema: { id: z.number().int().positive(), add: tagList.optional(), remove: tagList.optional() },
      outputSchema: ticketOut,
      annotations: write(false, true),
    },
    (a) =>
      respond(async () => {
        if (!a.add?.length && !a.remove?.length) throw new FreshdeskError(400, "Provide add and/or remove");
        // Freshdesk replaces the whole tags array, so read-merge-write.
        // ponytail: a tag change by someone else between the read and the write is lost; fine for a single agent key.
        const { data } = await fd.get(`/tickets/${a.id}`);
        const cur = ApiTicket.parse(data).tags ?? [];
        const drop = new Set((a.remove ?? []).map((t) => t.toLowerCase()));
        const tags = [...new Set([...cur, ...(a.add ?? [])])].filter((t) => !drop.has(t.toLowerCase()));
        return putTicket(a.id, { tags });
      }),
  );

  return server;
}

export function clientFromEnv() {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
  } catch {} // .env is optional; real env vars work too
  const { FRESHDESK_DOMAIN, FRESHDESK_API_KEY } = process.env;
  if (!FRESHDESK_DOMAIN || !FRESHDESK_API_KEY) {
    throw new Error("Set FRESHDESK_DOMAIN and FRESHDESK_API_KEY (see .env.example)");
  }
  return createClient({ domain: FRESHDESK_DOMAIN, apiKey: FRESHDESK_API_KEY });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const fd = clientFromEnv();
    // Auth check: fail fast with a clear message instead of failing on the agent's first tool call.
    const { data } = await fd.get("/agents/me");
    const me = z.object({ contact: z.object({ email: z.string().nullish() }).nullish() }).parse(data);
    console.error(`[freshdesk] authenticated as ${me.contact?.email ?? "unknown agent"}`);
    const { FRESHDESK_ALLOW_WRITES, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;
    const writes = FRESHDESK_ALLOW_WRITES === "1";
    const razorpay = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET ? createRazorpay({ keyId: RAZORPAY_KEY_ID, keySecret: RAZORPAY_KEY_SECRET }) : undefined;
    console.error(`[freshdesk] writes ${writes ? "ENABLED" : "disabled"}, razorpay verification ${razorpay ? "enabled" : "disabled"}`);
    await buildServer(fd, { writes, razorpay }).connect(new StdioServerTransport());
  } catch (e) {
    console.error(`[freshdesk] startup failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
