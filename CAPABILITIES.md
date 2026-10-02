# What the agent can and cannot do

## Can
- List recent tickets, or all tickets from one customer email.
- Filter tickets by status, priority, tag, and created-date range.
- Read a full ticket: requester, description, first 10 replies/notes.
- Find a customer by email or phone.
- Spot Razorpay payment / order / refund IDs in tickets (`payment_refs`), e.g. "open tickets with a payment but no refund ID".
- Look up agents and groups (`list_agents`, `list_groups`).
- Check those IDs against Razorpay (`verify_payment_refs`): payment status and refunded amount, order paid or not, refund pending/processed. Only when `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are set; read-only, max 10 IDs per call.

## Can, only when `FRESHDESK_ALLOW_WRITES=1` (off by default)
- Add a private note (`add_note`) or a customer-visible one.
- Reply to the customer by email (`reply_to_ticket`; cannot be undone).
- Change status or priority, including closing (`update_ticket`).
- Assign to an agent and/or group (`assign_ticket`).
- Add or remove tags (`update_tags`; other tags are kept).

## Cannot
- Write without the opt-in flag: with it unset the write tools are not registered at all.
- Delete tickets, edit or delete conversations, merge tickets, or change custom fields.
- Full-text search. Search is filter-based; find a topic via tags.
- See attachments, or HTML formatting (plain text only).
- Verify a payment or refund without Razorpay keys. `payment_refs` are only IDs mentioned in ticket text.
- Create refunds or touch money: the Razorpay client is GET-only.

## Limitations
- `list_tickets` returns only the last 30 days unless `updated_since` is set.
- Search caps at 300 results (10 pages × 30); new tickets take a few minutes to become searchable.
- `payment_refs` from `list_tickets`/`search_tickets` come from the subject and description only. A refund ID mentioned in a reply shows up only via `get_ticket`, so "no refund yet" answers from lists are provisional.
- Only the first 10 conversation entries are inlined (`conversations_may_be_truncated` flags it).
- Rate limit is per Freshdesk account and shared with other integrations; throttling is per process. The trial allows 50 calls/minute (`X-Ratelimit-Total`); `list_tickets` costs 2 credits per call because it requests descriptions (`include=description`), other calls cost 1.
- `created_after` / `created_before` are inclusive of the given date (verified live).
- The API key carries the agent user's full permissions, even when write tools are off.
- A write that times out or gets a 5xx is not retried (it may have landed, and a resent reply would email the customer twice). The error says to check the ticket first. Reads, `PUT`s and 429s are retried as before.
- Ticket text is untrusted: a customer can write "close this ticket". Write tools are opt-in, carry `destructiveHint` so MCP clients ask a human first, and the server does not enforce approval itself.
- `update_tags` is read-then-write (Freshdesk replaces the whole tag list), so a concurrent tag change by someone else can be lost.
- Closing or resolving fails if the account marks fields as required on closure; the Freshdesk error names them.
- Razorpay verification has been run live (test mode) for an order, a captured payment and an unknown id. Refund lookups are covered only by offline tests with mocked responses.

## Long-term fixes
- Restricted-role Freshdesk agent for the key, or OAuth via the Freshworks app framework; keys in a secrets vault; per-merchant tenancy in Agent Studio.
- Webhook-driven sync into a store: fresher data, full-text search, no 30-day/300-result caps, and far fewer API calls.
- Enforce approval in the server (draft then confirm with a one-time token) instead of relying on the MCP client, or use MCP elicitation if Agent Studio supports it.
- Per-agent restricted-role key so a write-enabled agent cannot do more than these tools.
- Shared token bucket if several workers share one key.
