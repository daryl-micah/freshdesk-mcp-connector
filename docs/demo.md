# Agent demo

Claude Code as the MCP client, registered with
`claude mcp add freshdesk -- npx tsx /abs/path/to/razorpay/src/server.ts`,
against a Freshdesk trial seeded by `npm run seed` (fictional data only).

Condensed from a live session: the answers are summarised, not verbatim. Claude Code showed each step only as "Called freshdesk".

## 1. "Which urgent tickets are still open?"
The agent found 4 urgent open tickets (#3, #7, #13, #17), all due 2026-10-05. It listed each one's subject, tags and `payment_refs`, for example #17: "Wrong amount captured" (499 expected, 4990 captured, `pay_P6q7R8s9T0u1V2`).
It added two caveats on its own: the payment IDs are only mentions in ticket text and aren't verified against Razorpay, and because search is slow to index new tickets the list could be incomplete.

**Why it shows the design:** a typed `status` + `priority` filter replaces raw query syntax, and the agent has the Razorpay IDs in the result without opening each ticket. The caveats come from the tool descriptions.

## 2. "Summarise everything asha@kiranastore.example has raised."
The agent found Asha's 4 tickets: #3 (open, urgent, payment debited but order not confirmed), #4 (open, high, refund not received), #15 (open, high, settlement not received, no payment IDs) and #5 (pending, medium, refund delay on a cancelled order). It grouped them into themes and noted that #5 looked already answered by an agent.
It said it had worked from ticket previews and offered to call `get_ticket` for the full threads.

**Why it shows the design:** `list_tickets` by `requester_email` gives a per-customer view in one call. The `preview` field keeps results small, and `get_ticket` is the drill-down.

## 3. "Which open tickets mention a payment that hasn't been refunded yet?"
The agent named five tickets with a payment ID and no refund ID: #4, #7, #17, #13 and #3. It explained what the customer says in each, such as #7 likely needing one of two charges refunded.
It stated the limits itself: it can't see real refund status because it can't call Razorpay, and since it only read previews, a refund ID that appears in a later reply could be missed. It flagged #5 as a refund-delay ticket that is pending rather than open.

**Why it shows the design:** this is the `payment_refs` showcase. The agent answers a cross-ticket question using `pay_`/`rfnd_` IDs extracted by the server, and its caveats match the documented limit: list/search extract IDs from the subject and description only, while `get_ticket` also scans conversations.

## 4. "Show me ticket 999999"
The agent reported that ticket 999999 doesn't exist, that Freshdesk returned "not found", and that it was probably a typo or an ID from another account. It offered to look up a different ID, or search by requester email or tag.

**Why it shows the design:** the missing ticket arrives as an `isError` result with a readable message, and the agent recovers with a next step instead of failing.

---

Sections 5 and 6 cover the write and Razorpay tools. They are not agent sessions: section 5 is a script acting as the MCP client, so the tool calls and results are real but no agent chose them. The server was started with `FRESHDESK_ALLOW_WRITES=1`.

## 5. Working a refund ticket with the write tools
Scratch ticket #20 ("Refund not received for cancelled order", requester `rohan@teahouse.example`, tagged `refund`, containing `order_Z9y8X7w6V5u4T3` and `pay_Z9y8X7w6V5u4T4`). Calls made, in order, with the key results:

1. `list_agents {}` → one agent, id `1120013340829`.
2. `assign_ticket {id: 20, responder_id: 1120013340829}` → `responder_id: 1120013340829`, `group_id: null`.
3. `add_note {id: 20, body: "Payment pay_Z9y8X7w6V5u4T4 captured, order cancelled. Raising refund with finance."}` → `private: true`.
4. `update_tags {id: 20, add: ["refund-initiated"]}` → tags `["refund", "refund-initiated"]` (the existing `refund` tag is kept).
5. `reply_to_ticket {id: 20, body: "Hi Rohan,\nWe have started the refund…"}` → `private: false`, sent as an email to the customer.
6. `update_ticket {id: 20, status: "resolved"}` → `status: "resolved"`.
7. `get_ticket {id: 20}` → status `resolved`, the new tags, and the note and reply in `conversations`.

**Why it shows the design:** every write is a typed tool call (no raw API bodies), ids come from `list_agents` rather than being guessed, tags are merged instead of replaced, and the note defaults to private. Agent text is HTML-escaped before it is sent. The write tools only exist because the operator set `FRESHDESK_ALLOW_WRITES=1`; without it `listTools` returns the read tools only.

## 6. Verifying a payment against Razorpay
Not run live yet. `verify_payment_refs` needs `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` (test-mode keys are fine), and none were available when this demo was recorded. The tool is covered by offline tests against mocked Razorpay responses (a found payment, a processed refund, an unknown id returning `found: false`, and a 401 surfacing as an error).

To capture a live run: put the keys in `.env`, optionally set `RAZORPAY_TEST_PAYMENT_ID` to a real test payment, and run `npm run smoke`. Then ask the agent "Which open tickets mention a payment that hasn't been refunded yet, and which of those payments actually exist in Razorpay?" and paste the answer here.
