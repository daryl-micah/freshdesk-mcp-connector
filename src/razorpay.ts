// Read-only Razorpay lookups for ids mentioned in tickets (pay_/order_/rfnd_). Reuses the Freshdesk HTTP core.
import { z } from "zod";
import { Client, FreshdeskError, HttpOptions, createHttp } from "./freshdesk.ts";

export const REF_ID = /^(pay|order|rfnd)_[A-Za-z0-9]{14}$/;
// Fixed host: the key pair can only ever be sent to Razorpay.
export function createRazorpay(opts: { keyId: string; keySecret: string } & HttpOptions) {
  return createHttp({
    ...opts,
    name: "Razorpay",
    base: "https://api.razorpay.com/v1",
    auth: "Basic " + Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString("base64"),
    credsVar: "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET",
  });
}

const Entity = z.object({
  status: z.string().nullish(),
  amount: z.number().nullish(),
  currency: z.string().nullish(),
  order_id: z.string().nullish(),
  payment_id: z.string().nullish(),
  amount_refunded: z.number().nullish(),
  refund_status: z.string().nullish(),
  amount_paid: z.number().nullish(),
  error_description: z.string().nullish(),
});

const PATH = { pay: "payments", order: "orders", rfnd: "refunds" } as const;

export const Verified = z.object({
  id: z.string(),
  kind: z.enum(["payment", "order", "refund"]),
  found: z.boolean(),
  status: z.string().nullable().describe("payment: created/authorized/captured/refunded/failed; order: created/attempted/paid; refund: pending/processed/failed"),
  amount_minor: z.number().nullable().describe("Amount in the smallest currency unit (paise for INR)"),
  currency: z.string().nullable(),
  order_id: z.string().nullable(),
  payment_id: z.string().nullable().describe("For refunds: the payment that was refunded"),
  amount_refunded_minor: z.number().nullable(),
  refund_status: z.string().nullable().describe("Payments only: null (none), partial or full"),
  amount_paid_minor: z.number().nullable().describe("Orders only"),
  note: z.string().nullable().describe("Why not found, or the failure reason Razorpay reports"),
});

export async function verifyRef(rz: Client, id: string): Promise<z.infer<typeof Verified>> {
  const prefix = id.split("_")[0] as keyof typeof PATH;
  const kind = ({ pay: "payment", order: "order", rfnd: "refund" } as const)[prefix];
  const empty = { id, kind, found: false, status: null, amount_minor: null, currency: null, order_id: null, payment_id: null,
    amount_refunded_minor: null, refund_status: null, amount_paid_minor: null, note: null };
  try {
    const { data } = await rz.get(`/${PATH[prefix]}/${id}`);
    const e = Entity.parse(data);
    return {
      ...empty, found: true, status: e.status ?? null, amount_minor: e.amount ?? null, currency: e.currency ?? null,
      order_id: e.order_id ?? null, payment_id: e.payment_id ?? null, amount_refunded_minor: e.amount_refunded ?? null,
      refund_status: e.refund_status ?? null, amount_paid_minor: e.amount_paid ?? null, note: e.error_description ?? null,
    };
  } catch (e) {
    // Razorpay answers an unknown id with 400 "The id provided does not exist"; treat 400/404 as "not found".
    if (e instanceof FreshdeskError && (e.status === 400 || e.status === 404)) return { ...empty, note: e.message };
    throw e;
  }
}
