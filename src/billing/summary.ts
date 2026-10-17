import type Stripe from "stripe";
import type { User } from "../db/schema.js";
import { AppError } from "../errors.js";
import { stripe } from "./stripe.js";

export interface BillingPaymentMethod {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface BillingInvoiceRow {
  id: string;
  number: string | null;
  status: string | null;
  totalCents: number;
  currency: string;
  createdAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  pdfUrl: string | null;
  hostedUrl: string | null;
}

export interface BillingUpcoming {
  totalCents: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
}

export interface BillingSummary {
  paymentMethod: BillingPaymentMethod | null;
  invoices: BillingInvoiceRow[];
  upcoming: BillingUpcoming | null;
}

function paymentMethodFromCustomer(
  customer: Stripe.Customer | Stripe.DeletedCustomer,
): BillingPaymentMethod | null {
  if (customer.deleted) return null;
  const pm = customer.invoice_settings?.default_payment_method;
  if (!pm || typeof pm === "string") return null;
  if (pm.type !== "card" || !pm.card) return null;
  return {
    brand: pm.card.brand,
    last4: pm.card.last4,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
  };
}

function mapInvoice(inv: Stripe.Invoice): BillingInvoiceRow {
  return {
    id: inv.id,
    number: inv.number,
    status: inv.status,
    totalCents: inv.total,
    currency: inv.currency,
    createdAt: new Date(inv.created * 1000).toISOString(),
    periodStart: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
    periodEnd: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
    pdfUrl: inv.invoice_pdf ?? null,
    hostedUrl: inv.hosted_invoice_url ?? null,
  };
}

/** Invoices and payment method for the account billing page (Stripe-backed). */
export async function billingSummary(user: User): Promise<BillingSummary> {
  if (!user.stripeCustomerId) {
    return { paymentMethod: null, invoices: [], upcoming: null };
  }

  const s = stripe();
  const customer = await s.customers.retrieve(user.stripeCustomerId, {
    expand: ["invoice_settings.default_payment_method"],
  });

  const invoices = await s.invoices.list({ customer: user.stripeCustomerId, limit: 24 });

  let upcoming: BillingUpcoming | null = null;
  try {
    const next = await s.invoices.retrieveUpcoming({ customer: user.stripeCustomerId });
    upcoming = {
      totalCents: next.total,
      currency: next.currency,
      periodStart: new Date(next.period_start * 1000).toISOString(),
      periodEnd: new Date(next.period_end * 1000).toISOString(),
    };
  } catch {
    // No upcoming invoice (free, canceled, or trial-only).
  }

  return {
    paymentMethod: paymentMethodFromCustomer(customer),
    invoices: invoices.data.map(mapInvoice),
    upcoming,
  };
}

export async function billingSummaryForUser(user: User): Promise<BillingSummary> {
  try {
    return await billingSummary(user);
  } catch (e) {
    console.error("billing summary failed", e);
    throw new AppError(502, "billing_summary_failed", "Couldn't load billing details. Please try again.");
  }
}
