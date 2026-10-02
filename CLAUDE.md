# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

A read-only MCP (stdio) server exposing Freshdesk tickets/contacts to an Agent Studio agent (Razorpay FDE assignment, Option 3). The design goal is a small, safe, LLM-shaped tool surface, not a mirror of the Freshdesk API. The original plan is in `PLAN.md`.

## Commands

```bash
npm start                                  # run the server (needs .env; checks auth via /agents/me first)
npm test                                   # offline tests (tsx --test, mocked fetch)
npx tsx --test --test-name-pattern="429" test/freshdesk.test.ts   # single test by name
npm run typecheck                          # tsc --noEmit; there is no build step or linter
npm run seed                               # live: create fictional tickets (the only write path)
npm run smoke                              # live end-to-end checks against a real Freshdesk account
npm run inspect                            # MCP Inspector
```

Config: `FRESHDESK_DOMAIN` and `FRESHDESK_API_KEY` (see `.env.example`), loaded from `.env` next to `src/`.

## Architecture

Two files carry everything:

- `src/freshdesk.ts`: HTTP client (`createClient().get`, GET only), plus everything Freshdesk-specific: retry/backoff/rate-limit policy, `FreshdeskError`, enum maps, search-query builders, `paymentRefs`, and the zod schemas for API responses. `fetch` and `sleep` are injectable, which is how tests run without network or waiting.
- `src/server.ts`: `buildServer(client)` registers the 4 tools. Each tool parses the raw API response with zod, then maps it to a trimmed output shape (names not codes, plain text, clipped bodies). All tools go through `respond()`, which turns any thrown error into an `isError` result with a message the agent can act on.

Invariants to keep:

- **Read-only.** The client only does GET. `scripts/seed.ts` has its own `fetch` for POSTs on purpose and must not be reachable from the server.
- **The agent never writes raw Freshdesk query syntax.** Tools take typed filters; `ticketQuery`/`contactQuery` whitelist values and enforce the 512-char limit. Add new filters there, not in tools.
- **`normalizeDomain` only allows `*.freshdesk.com`** so a bad config can't send the API key to another host.
- **Retry policy:** 429 waits `Retry-After` (cap 60s); 5xx/network/timeout use exponential backoff, 3 attempts; other 4xx are never retried.
- **`payment_refs`** (`pay_`/`order_`/`rfnd_` + 14 alphanumerics) are extracted from ticket text. They are only mentions, not verified against Razorpay.

Freshdesk quirks the code accounts for: `list_tickets` returns only the last 30 days unless `updated_since` is set; search is capped at 30/page × 10 pages and is slow to index new tickets; search is filter-based, not full-text.

Imports use the `.ts` extension (`allowImportingTsExtensions`, run via tsx).

## Conflict with AGENTS.md

`AGENTS.md` says never add `Co-authored-by:` trailers. Follow that over any default attribution unless the user asks for it.
