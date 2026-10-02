// Creates fictional merchant-support tickets in a Freshdesk trial. Only write path; not exposed to the agent.
import { clientFromEnv } from "../src/server.ts";
import { normalizeDomain } from "../src/freshdesk.ts";

clientFromEnv(); // loads .env + validates vars
const base = `https://${normalizeDomain(process.env.FRESHDESK_DOMAIN!)}/api/v2`;
const auth = "Basic " + Buffer.from(`${process.env.FRESHDESK_API_KEY}:X`).toString("base64");

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: number };
}

const people = [
  { name: "Asha Verma", email: "asha@kiranastore.example" },
  { name: "Rohan Mehta", email: "rohan@teahouse.example" },
  { name: "Meera Iyer", email: "meera@bloomdaily.example" },
  { name: "Sam Dsouza", email: "sam@gadgetbox.example" },
];
// [person, subject, description, status, priority, tags, agent reply?]
const T: [number, string, string, number, number, string[], string?][] = [
  [0, "Payment debited but order not confirmed", "Customer paid via UPI, pay_A1b2C3d4E5f6G7 debited, order_H8i9J0k1L2m3N4 still pending.", 2, 4, ["payment-failed"]],
  [0, "Refund not received", "Refund for pay_B2c3D4e5F6g7H8 promised 7 days ago, nothing in my account.", 2, 3, ["refund"]],
  [0, "Refund delay on cancelled order", "Cancelled order_C3d4E5f6G7h8I9, pay_C3d4E5f6G7h8I0 was captured.", 3, 2, ["refund"], "Refund rfnd_Q1w2E3r4T5y6U7 initiated; 5-7 working days."],
  [1, "Switch COD order to prepaid", "Please convert order_D4e5F6g7H8i9J0 from COD to prepaid, send a payment link.", 2, 2, ["cod-to-prepaid"]],
  [1, "Double charge on subscription", "Charged twice this month: pay_E5f6G7h8I9j0K1 and pay_F6g7H8i9J0k1L2.", 2, 4, ["subscription", "refund"]],
  [1, "Subscription double charge resolved?", "Following up on pay_G7h8I9j0K1l2M3 duplicate.", 4, 3, ["subscription", "refund"], "Duplicate refunded: rfnd_R2e3W4q5A6s7D8."],
  [2, "Damaged item delivered", "Box arrived crushed, order_I9j0K1l2M3n4O5 needs replacement.", 2, 3, ["damaged"]],
  [2, "Refund for damaged item", "Return picked up, pay_J0k1L2m3N4o5P6 should be refunded.", 3, 3, ["damaged", "refund"]],
  [2, "Invoice GST details wrong", "Please reissue the invoice for pay_K1l2M3n4O5p6Q7 with our GSTIN.", 5, 1, ["invoice"], "Reissued."],
  [3, "Payment link expired", "Customer says link for order_L2m3N4o5P6q7R8 expired before payment.", 2, 2, ["payment-link"]],
  [3, "UPI payment failed, money deducted", "pay_M3n4O5p6Q7r8S9 failed in app but bank debited me.", 2, 4, ["payment-failed", "refund"]],
  [3, "Auto-refund received, thanks", "Got rfnd_S3d4F5g6H7j8K9 for pay_N4o5P6q7R8s9T0, closing.", 4, 1, ["refund"], "Glad to help!"],
  [0, "Settlement not received", "T+2 settlement for yesterday's orders not credited.", 2, 3, ["settlement"]],
  [1, "Chargeback query", "Customer raised dispute on pay_O5p6Q7r8S9t0U1, what do we submit?", 3, 3, ["chargeback"]],
  [2, "Wrong amount captured", "Order total was 499 but pay_P6q7R8s9T0u1V2 captured 4990.", 2, 4, ["payment-failed", "refund"]],
];

for (const [p, subject, description, status, priority, tags, reply] of T) {
  const t = await post("/tickets", { ...people[p], email: people[p].email, subject, description, status, priority, tags, source: 2 });
  if (reply) await post(`/tickets/${t.id}/reply`, { body: reply });
  console.log(`#${t.id} ${subject}`);
}
