# Freshdesk MCP connector

An MCP (stdio) server that lets an Agent Studio agent read Freshdesk tickets. Read-only by default, with opt-in write tools and optional Razorpay verification, all shaped for an LLM rather than mirroring the Freshdesk API.

## Setup
```bash
npm install
cp .env.example .env     # set FRESHDESK_DOMAIN and FRESHDESK_API_KEY (writes and Razorpay are optional, see below)
npm start                # verifies the key via /agents/me, then serves MCP on stdio
```
Auth: API key sent as HTTP Basic (`base64(key:X)`). A bad key fails at startup with a clear message.

Register with an MCP client, e.g. Claude Code: `claude mcp add freshdesk -- npx tsx /abs/path/to/razorpay/src/server.ts` (absolute path, so it works from any directory).

Generic client config:
```json
{ "mcpServers": { "freshdesk": { "command": "npx", "args": ["tsx", "src/server.ts"], "cwd": "/path/to/razorpay",
  "env": { "FRESHDESK_DOMAIN": "acme.freshdesk.com", "FRESHDESK_API_KEY": "..." } } } }
```

## Assumptions
- Node >= 22 (uses `process.loadEnvFile`, native `fetch`).
- A Freshdesk trial/free account; the API key's agent needs read access to tickets and contacts.
- Default ticket statuses (2-5). Custom statuses appear as `custom_N`.
- Seed data is fictional only.

## Tools
| Tool | Use for |
|---|---|
| `list_tickets` | Recent tickets, or one requester's tickets (`requester_email`) |
| `search_tickets` | Filter by status / priority / tag / created date range |
| `get_ticket` | One ticket with requester + first 10 conversation entries |
| `search_contacts` | Find a customer by exact email / phone |
| `list_agents`, `list_groups` | Find the ids `assign_ticket` needs |
| `verify_payment_refs` | Check `pay_`/`order_`/`rfnd_` ids against Razorpay. Needs `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` (test-mode keys are fine) |

Write tools, registered only when `FRESHDESK_ALLOW_WRITES=1`:

| Tool | Use for |
|---|---|
| `add_note` | Internal note (private by default) |
| `reply_to_ticket` | Email the customer; cannot be undone |
| `update_ticket` | Status and/or priority; closing is `status: closed` |
| `assign_ticket` | `responder_id` and/or `group_id` |
| `update_tags` | Add/remove tags, keeping the rest |

Every ticket carries `payment_refs` (`pay_`, `order_`, `rfnd_` IDs extracted from the text), so an agent can ask "which open tickets mention a payment with no refund yet?".

## Design decisions
- **Read-only unless you opt in.** Without `FRESHDESK_ALLOW_WRITES=1` the write tools are not registered and nothing but GET is reachable. With it, write tools are typed (no raw API bodies), plain text is HTML-escaped before it is sent, and they carry `destructiveHint` so MCP clients ask a human first. Ticket text is untrusted, so the server does not auto-approve anything.
- **Writes are never blindly retried.** A POST that times out or gets a 5xx may have landed, so it is not resent (a resent reply emails the customer twice); the error says to check the ticket. 429s are retried for every method.
- **Razorpay verification is separate and read-only.** Ticket text only claims a payment; `verify_payment_refs` checks the ids against `api.razorpay.com` (fixed host).
- **Typed filters, not raw query syntax.** The agent can't send malformed or injected Freshdesk queries; values are whitelisted and the 512-char limit is enforced.
- **LLM-friendly output.** Names instead of numeric codes, plain text instead of HTML, bodies clipped to 2000 chars, no attachments, `outputSchema` + `structuredContent`.
- **Rate limits.** 429 → wait `Retry-After` (capped 60s) and retry; 5xx/network → exponential backoff + jitter, 3 attempts; 4xx → never retried, with Freshdesk's error detail. Slows down when `X-Ratelimit-Remaining` < 5.
- **Key safety.** Domain must be `*.freshdesk.com`, so a bad config can't send the key elsewhere.
- Minimal deps: MCP SDK + zod, native `fetch`. Razorpay reuses the Freshdesk HTTP core (retry, timeout, typed errors).

## Verify
```bash
npm test          # offline tests, mocked fetch
npm run typecheck
npm run seed      # live: ~15 fictional tickets in your trial account
npm run smoke     # live end-to-end checks, including write tools on one scratch ticket (leaves it closed)
npm run inspect   # MCP Inspector
```

## Demo
[docs/demo.md](docs/demo.md): Claude Code as the MCP client answering four merchant questions against seeded tickets (urgent open tickets, a customer summary, unrefunded payments, a missing ticket), plus a scripted run of the write tools. Razorpay verification is shown against test mode (order, captured payment and unknown-id cases).

## Capabilities
[CAPABILITIES.md](CAPABILITIES.md): what the agent can and cannot do, known limitations, and the long-term fixes.
