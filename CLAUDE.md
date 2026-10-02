# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

An MCP (stdio) server, read-only by default, exposing Freshdesk tickets/contacts to an Agent Studio agent (Razorpay FDE assignment, Option 3). The design goal is a small, safe, LLM-shaped tool surface, not a mirror of the Freshdesk API. The original plan is in `PLAN.md`.

## Commands

```bash
npm start                                  # run the server (needs .env; checks auth via /agents/me first)
npm test                                   # offline tests (tsx --test, mocked fetch)
npx tsx --test --test-name-pattern="429" test/freshdesk.test.ts   # single test by name
npm run typecheck                          # tsc --noEmit; there is no build step or linter
npm run seed                               # live: create fictional tickets (own fetch, not the server)
npm run smoke                              # live end-to-end checks against a real Freshdesk account
npm run inspect                            # MCP Inspector
```

Config: `FRESHDESK_DOMAIN` and `FRESHDESK_API_KEY` (see `.env.example`), loaded from `.env` next to `src/`. Optional: `FRESHDESK_ALLOW_WRITES=1` registers the write tools; `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` register `verify_payment_refs`.

## Architecture

Three files carry everything:

- `src/freshdesk.ts`: the HTTP core (`createHttp`: `get`/`post`/`put`, shared with Razorpay) and the Freshdesk client built on it (`createClient`), plus everything Freshdesk-specific: retry/backoff/rate-limit policy, `FreshdeskError`, enum maps, search-query builders, `paymentRefs`, and the zod schemas for API responses. `fetch` and `sleep` are injectable, which is how tests run without network or waiting.
- `src/razorpay.ts`: `createRazorpay` (same HTTP core, fixed `api.razorpay.com` host, Basic key id/secret) and `verifyRef`, which maps `pay_`/`order_`/`rfnd_` ids to live state. Unknown ids (Razorpay answers 400) become `found: false`.
- `src/server.ts`: `buildServer(client, { writes, razorpay })` registers the read tools always, the write tools only when `writes`, and `verify_payment_refs` only when a Razorpay client is passed. Each tool parses the raw API response with zod, then maps it to a trimmed output shape (names not codes, plain text, clipped bodies). All tools go through `respond()`, which turns any thrown error into an `isError` result with a message the agent can act on.

Invariants to keep:

- **Writes are opt-in.** Write tools (`add_note`, `reply_to_ticket`, `update_ticket`, `assign_ticket`, `update_tags`) are registered only with `FRESHDESK_ALLOW_WRITES=1`, take typed inputs (never raw API bodies), HTML-escape agent text, and carry `destructiveHint`. Ticket text is untrusted, so do not add a tool that writes without that gate. Razorpay stays GET-only. `scripts/seed.ts` has its own `fetch` for POSTs on purpose.
- **The agent never writes raw Freshdesk query syntax.** Tools take typed filters; `ticketQuery`/`contactQuery` whitelist values and enforce the 512-char limit. Add new filters there, not in tools.
- **`normalizeDomain` only allows `*.freshdesk.com`** so a bad config can't send the API key to another host.
- **Retry policy:** 429 waits `Retry-After` (cap 60s) for every method; for GET/PUT, 5xx/network/timeout use exponential backoff, 3 attempts; POST is never resent after it may have landed (it could duplicate a customer reply); other 4xx are never retried.
- **`payment_refs`** (`pay_`/`order_`/`rfnd_` + 14 alphanumerics) are extracted from ticket text. They are only mentions; `verify_payment_refs` is what checks them against Razorpay.

Freshdesk quirks the code accounts for: `list_tickets` returns only the last 30 days unless `updated_since` is set; search is capped at 30/page × 10 pages and is slow to index new tickets; search is filter-based, not full-text.

Imports use the `.ts` extension (`allowImportingTsExtensions`, run via tsx).

## Conflict with AGENTS.md

`AGENTS.md` says never add `Co-authored-by:` trailers. Follow that over any default attribution unless the user asks for it.
