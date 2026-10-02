// Read-only Freshdesk v2 API client: auth, timeouts, retries, rate limits, typed errors.
import { z } from "zod";

export const STATUS = { open: 2, pending: 3, resolved: 4, closed: 5 } as const;
export const PRIORITY = { low: 1, medium: 2, high: 3, urgent: 4 } as const;
const SOURCE: Record<number, string> = {
  1: "email", 2: "portal", 3: "phone", 7: "chat", 9: "feedback_widget", 10: "outbound_email",
};
const nameOf = (map: Record<string, number>, code: number) =>
  Object.keys(map).find((k) => map[k] === code) ?? `custom_${code}`;
export const statusName = (code: number) => nameOf(STATUS, code);
export const priorityName = (code: number) => nameOf(PRIORITY, code);
export const sourceName = (code: number) => SOURCE[code] ?? `custom_${code}`;

export class FreshdeskError extends Error {
  constructor(
    public status: number, // 0 = network/timeout
    message: string,
    public retryable = false,
    public retryAfterSec?: number,
  ) {
    super(message);
  }
}

export type ClientOptions = {
  domain: string;
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
  log?: (msg: string) => void;
};

// Accepts "acme", "acme.freshdesk.com" or "https://acme.freshdesk.com/"; only *.freshdesk.com is allowed
// so a misconfigured value can never send the API key to another host.
export function normalizeDomain(input: string): string {
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const full = host.includes(".") ? host : `${host}.freshdesk.com`;
  if (!/^[a-z0-9-]+\.freshdesk\.com$/.test(full)) {
    throw new Error(`FRESHDESK_DOMAIN must look like "acme.freshdesk.com", got "${input}"`);
  }
  return full;
}

const RETRY_AFTER_CAP_SEC = 60;
const LOW_REMAINING = 5;

export function createClient(opts: ClientOptions) {
  const base = `https://${normalizeDomain(opts.domain)}/api/v2`;
  const auth = "Basic " + Buffer.from(`${opts.apiKey}:X`).toString("base64");
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const log = opts.log ?? ((m) => console.error(`[freshdesk] ${m}`));
  const backoffMs = (attempt: number) => 500 * 2 ** (attempt - 1) + Math.random() * 250;
  let rateLimitRemaining: number | undefined;

  async function get(path: string, params: Record<string, string | number | undefined> = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          headers: { Authorization: auth, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const msg = (e as Error).name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : (e as Error).message;
        if (attempt >= maxAttempts) throw new FreshdeskError(0, `Freshdesk unreachable: ${msg}`, true);
        log(`network error (${msg}), retry ${attempt}/${maxAttempts - 1}`);
        await sleep(backoffMs(attempt));
        continue;
      }

      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining !== null) rateLimitRemaining = Number(remaining);

      if (res.status === 429) {
        const header = Number(res.headers.get("retry-after"));
        const wait = Math.min(res.headers.has("retry-after") && !Number.isNaN(header) ? header : RETRY_AFTER_CAP_SEC, RETRY_AFTER_CAP_SEC);
        if (attempt >= maxAttempts) {
          throw new FreshdeskError(429, `Freshdesk rate limit hit; try again in ${wait}s`, true, wait);
        }
        log(`429 rate limited, waiting ${wait}s (Retry-After), retry ${attempt}/${maxAttempts - 1}`);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status >= 500) {
        if (attempt >= maxAttempts) throw new FreshdeskError(res.status, `Freshdesk server error ${res.status}`, true);
        log(`${res.status} from Freshdesk, retry ${attempt}/${maxAttempts - 1}`);
        await sleep(backoffMs(attempt));
        continue;
      }
      if (!res.ok) throw new FreshdeskError(res.status, await describeError(res, url.pathname));

      // ponytail: per-process throttle; a shared token bucket is needed once several workers share one key.
      if (rateLimitRemaining !== undefined && rateLimitRemaining < LOW_REMAINING) {
        log(`only ${rateLimitRemaining} API calls left this minute, slowing down`);
        await sleep(2000);
      }
      return { data: (await res.json()) as unknown, nextPage: nextPageFromLink(res.headers.get("link")) };
    }
  }

  return { get, rateLimit: () => rateLimitRemaining };
}
export type Client = ReturnType<typeof createClient>;

async function describeError(res: Response, path: string): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { description?: string; message?: string; errors?: { field?: string; message: string }[] };
    detail = body.errors?.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join("; ") ?? body.message ?? body.description ?? "";
  } catch {}
  const hint: Record<number, string> = {
    400: "Invalid request",
    401: "Authentication failed; check FRESHDESK_API_KEY",
    403: "The API key's agent lacks permission for this resource",
    404: path.match(/\/tickets\/(\d+)$/) ? `Ticket ${path.split("/").pop()} not found` : `Not found: ${path}`,
  };
  return [hint[res.status] ?? `Freshdesk error ${res.status}`, detail].filter(Boolean).join(" - ");
}

export function nextPageFromLink(link: string | null): number | null {
  const m = link?.match(/<([^>]+)>;\s*rel="next"/);
  return m ? Number(new URL(m[1]).searchParams.get("page")) : null;
}

// --- Search query builder: the agent passes typed filters, never raw query syntax. ---
export type TicketFilters = {
  status?: keyof typeof STATUS;
  priority?: keyof typeof PRIORITY;
  tag?: string;
  created_after?: string; // YYYY-MM-DD
  created_before?: string;
};
const SAFE_VALUE = /^[\w .@+\-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function buildSearchQuery(clauses: string[]): string {
  if (clauses.length === 0) throw new FreshdeskError(400, "Provide at least one filter");
  const q = `"${clauses.join(" AND ")}"`;
  if (q.length > 512) throw new FreshdeskError(400, "Search query exceeds Freshdesk's 512 character limit");
  return q;
}

function quoted(field: string, value: string) {
  if (!SAFE_VALUE.test(value)) throw new FreshdeskError(400, `Unsupported characters in ${field}: "${value}"`);
  return `${field}:'${value}'`;
}

export function ticketQuery(f: TicketFilters): string {
  const c: string[] = [];
  if (f.status) c.push(`status:${STATUS[f.status]}`);
  if (f.priority) c.push(`priority:${PRIORITY[f.priority]}`);
  if (f.tag) c.push(quoted("tag", f.tag));
  for (const [key, op] of [["created_after", ">"], ["created_before", "<"]] as const) {
    const v = f[key];
    if (v === undefined) continue;
    if (!DATE.test(v)) throw new FreshdeskError(400, `${key} must be YYYY-MM-DD`);
    c.push(`created_at:${op}'${v}'`);
  }
  return buildSearchQuery(c);
}

export function contactQuery(f: { email?: string; phone?: string }): string {
  const c: string[] = [];
  if (f.email) c.push(quoted("email", f.email));
  if (f.phone) c.push(quoted("phone", f.phone));
  return buildSearchQuery(c);
}

// --- Razorpay references found in free text (pay_/order_/rfnd_ + 14 alphanumerics). ---
export function paymentRefs(...texts: (string | null | undefined)[]) {
  const found = { payment_ids: new Set<string>(), order_ids: new Set<string>(), refund_ids: new Set<string>() };
  const bucket = { pay: found.payment_ids, order: found.order_ids, rfnd: found.refund_ids } as const;
  for (const m of texts.join("\n").matchAll(/\b(pay|order|rfnd)_[A-Za-z0-9]{14}\b/g)) {
    bucket[m[1] as keyof typeof bucket].add(m[0]);
  }
  return { payment_ids: [...found.payment_ids], order_ids: [...found.order_ids], refund_ids: [...found.refund_ids] };
}

// --- API response shapes (validated at the boundary; extra fields ignored). ---
export const ApiTicket = z.object({
  id: z.number(),
  subject: z.string().nullish(),
  status: z.number(),
  priority: z.number(),
  source: z.number().nullish(),
  type: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  requester_id: z.number().nullish(),
  description_text: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  due_by: z.string().nullish(),
  requester: z.object({ name: z.string().nullish(), email: z.string().nullish() }).nullish(),
  conversations: z
    .array(
      z.object({
        body_text: z.string().nullish(),
        incoming: z.boolean().nullish(),
        private: z.boolean().nullish(),
        created_at: z.string(),
      }),
    )
    .nullish(),
});
export type ApiTicket = z.infer<typeof ApiTicket>;

export const ApiContact = z.object({
  id: z.number(),
  name: z.string().nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  mobile: z.string().nullish(),
  company_id: z.number().nullish(),
});
