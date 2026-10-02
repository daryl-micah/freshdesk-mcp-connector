// MCP server exposing a read-only, LLM-shaped view of Freshdesk tickets and contacts.
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ApiContact, ApiTicket, Client, FreshdeskError, PRIORITY, STATUS, contactQuery, createClient,
  paymentRefs, priorityName, sourceName, statusName, ticketQuery,
} from "./freshdesk.ts";

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

export function buildServer(fd: Client) {
  const server = new McpServer({ name: "freshdesk-readonly", version: "1.0.0" });

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
        created_after: z.string().optional().describe("YYYY-MM-DD, exclusive"),
        created_before: z.string().optional().describe("YYYY-MM-DD, exclusive"),
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
    await buildServer(fd).connect(new StdioServerTransport());
  } catch (e) {
    console.error(`[freshdesk] startup failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
