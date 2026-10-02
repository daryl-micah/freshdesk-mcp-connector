# What the agent can and cannot do

## Can
- List recent tickets, or all tickets from one customer email.
- Filter tickets by status, priority, tag, and created-date range.
- Read a full ticket: requester, description, first 10 replies/notes.
- Find a customer by email or phone.
- Spot Razorpay payment / order / refund IDs in tickets (`payment_refs`), e.g. "open tickets with a payment but no refund ID".

## Cannot
- Write anything: no replying, updating, assigning, or closing.
- Full-text search. Search is filter-based; find a topic via tags.
- See attachments, or HTML formatting (plain text only).
- Verify a payment or refund. It only sees IDs mentioned in ticket text; it can't call Razorpay.

## Limitations
- `list_tickets` returns only the last 30 days unless `updated_since` is set.
- Search caps at 300 results (10 pages × 30); new tickets take a few minutes to become searchable.
- `payment_refs` from `list_tickets`/`search_tickets` come from the subject and description only. A refund ID mentioned in a reply shows up only via `get_ticket`, so "no refund yet" answers from lists are provisional.
- Only the first 10 conversation entries are inlined (`conversations_may_be_truncated` flags it).
- Rate limit is per Freshdesk account and shared with other integrations; throttling is per process. The trial allows 50 calls/minute (`X-Ratelimit-Total`); `list_tickets` costs 2 credits per call because it requests descriptions (`include=description`), other calls cost 1.
- `created_after` / `created_before` are inclusive of the given date (verified live).
- The API key carries the agent user's full permissions, even though this server only reads.

## Long-term fixes
- Restricted-role Freshdesk agent for the key, or OAuth via the Freshworks app framework; keys in a secrets vault; per-merchant tenancy in Agent Studio.
- Webhook-driven sync into a store: fresher data, full-text search, no 30-day/300-result caps, and far fewer API calls.
- Join `payment_refs` against the Razorpay API to confirm real payment/refund state.
- Write tools (reply, tag, close) behind human approval.
- Shared token bucket if several workers share one key.
