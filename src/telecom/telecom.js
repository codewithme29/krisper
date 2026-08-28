import express from "express";
import { buildBillPdf } from "./billPdf.js";
const router = express.Router();

/* -------------------------------------------------------------------------- */
/*  MOCK DATA STORE — replace with real BSS / billing API calls in production  */
/* -------------------------------------------------------------------------- */

const ACCOUNTS = {
  "918299576621": {
    accountId: "ACC-100245",
    name: "Priyam Srivastava",
    phone: "918299576621",
    plan: "Unlimited 5G ₹399",
    status: "Active",
    balance: 12.5,
    dataRemainingGB: 3.2,
    billingCycle: "01 Aug – 31 Aug 2026",
    dueDate: "2026-09-06",
    currentBill: 799,
    averageBill: 399,
    currency: "INR",
    lineItems: [
      { code: "RENTAL",  label: "Monthly plan rental (Unlimited 5G ₹399)", amount: 399, category: "Fixed",  variance: 0,   note: "Same every month" },
      { code: "ROAMING", label: "International roaming usage",              amount: 280, category: "Usage",  variance: 280, note: "Roaming in UAE from 3–5 Aug (2 days)" },
      { code: "DATAOVR", label: "Extra data beyond plan limit",            amount: 60,  category: "Usage",  variance: 60,  note: "1.2 GB used after fair-usage limit on 22 Aug" },
      { code: "VAS",     label: "Caller tune subscription",                amount: 30,  category: "Add-on", variance: 30,  note: "Auto-renewed on 05 Aug" },
      { code: "TAX",     label: "GST (18%)",                               amount: 30,  category: "Tax",    variance: 30,  note: "Tax on the extra usage above" },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/*  HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

const normalisePhone = (raw) => String(raw || "").replace(/[^\d]/g, "");

// Read phone from query, body, or header — whichever the connector uses.
function extractPhone(req) {
  return (
    req.query.phone ||
    (req.body && req.body.phone) ||
    req.get("X-WhatsApp-Phone") ||
    req.get("x-whatsapp-phone") ||
    ""
  );
}

// Demo-friendly resolver: exact match first, else fall back to the default
// subscriber so the PoC always returns data even if the bound number differs
// or the binding didn't resolve. In production, return null on no match.
const DEFAULT_PHONE = "918299576621";
function getSubscriber(rawPhone) {
  const p = normalisePhone(rawPhone);
  console.log("[telecom] resolve phone:", JSON.stringify(rawPhone), "->", p || "(empty)");
  return ACCOUNTS[p] || ACCOUNTS[DEFAULT_PHONE] || null;
}

const inr = (n) => `₹${Number(n).toLocaleString("en-IN")}`;

// Plain-language explanation of the whole bill (anomaly-first).
function explainWholeBill(acct) {
  const extra = acct.currentBill - acct.averageBill;
  const drivers = acct.lineItems
    .filter((li) => li.variance > 0)
    .sort((a, b) => b.variance - a.variance);

  const lines = [
    `Your bill this cycle is ${inr(acct.currentBill)}, which is ${inr(extra)} higher than your usual ${inr(acct.averageBill)}.`,
    "Here's what pushed it up:",
    ...drivers.map((d) => `• ${inr(d.amount)} — ${d.label}. ${d.note}.`),
    `The rest (${inr(acct.currentBill - extra)}) is your normal monthly plan rental.`,
  ];

  return {
    headline: `Your bill is ${inr(acct.currentBill)} — ${inr(extra)} more than usual.`,
    extraAmount: extra,
    topDriver: drivers[0]
      ? { label: drivers[0].label, amount: drivers[0].amount, note: drivers[0].note }
      : null,
    plainText: lines.join("\n"),
    breakdown: acct.lineItems,
  };
}

// Explain a specific amount the user is questioning ("why ₹280 extra?").
function explainAmount(acct, queriedAmount) {
  const amt = Number(queriedAmount);

  let match = acct.lineItems.find((li) => li.amount === amt);

  const extra = acct.currentBill - acct.averageBill;
  if (!match && amt === extra) {
    const drivers = acct.lineItems
      .filter((li) => li.variance > 0)
      .sort((a, b) => b.variance - a.variance);
    return {
      matched: true,
      amount: amt,
      plainText:
        `The ${inr(amt)} extra this month is made up of:\n` +
        drivers.map((d) => `• ${inr(d.amount)} — ${d.label} (${d.note})`).join("\n"),
      items: drivers,
    };
  }

  if (!match) {
    match = acct.lineItems
      .map((li) => ({ li, diff: Math.abs(li.amount - amt) }))
      .sort((a, b) => a.diff - b.diff)
      .filter((x) => x.diff <= 5)
      .map((x) => x.li)[0];
  }

  if (match) {
    return {
      matched: true,
      amount: match.amount,
      plainText:
        `The ${inr(match.amount)} is for "${match.label}". ${match.note}. ` +
        `It's a ${match.category.toLowerCase()} charge.`,
      item: match,
    };
  }

  return {
    matched: false,
    amount: amt,
    plainText:
      `I couldn't find a single charge of exactly ${inr(amt)} on this bill. ` +
      `Here are all the charges so you can see where it fits:`,
    items: acct.lineItems,
  };
}

/* -------------------------------------------------------------------------- */
/*  ROUTES                                                                     */
/* -------------------------------------------------------------------------- */

// Health check
router.get("/health", (_req, res) => res.json({ ok: true, service: "telecom" }));

// DEBUG: hit this from the agent (or browser) to see exactly what arrives.
router.all("/whoami", (req, res) => {
  res.json({
    method: req.method,
    query: req.query,
    body: req.body || null,
    phoneHeader: req.get("X-WhatsApp-Phone") || null,
    resolvedPhone: normalisePhone(extractPhone(req)) || "(empty)",
  });
});

/* ---- ACCOUNT : answers BOTH GET (?phone=) and POST ({phone}) -------------- */
const accountHandler = (req, res) => {
  const acct = getSubscriber(extractPhone(req));
  if (!acct) return res.status(404).json({ error: "account_not_found" });

  res.json({
    accountId: acct.accountId,
    name: acct.name,
    plan: acct.plan,
    status: acct.status,
    balance: acct.balance,
    dataRemainingGB: acct.dataRemainingGB,
    billingCycle: acct.billingCycle,
    dueDate: acct.dueDate,
    currentBill: acct.currentBill,
    currency: acct.currency,
  });
};
router.get("/account", accountHandler);
router.post("/account", accountHandler);

/* ---- BILL : answers BOTH GET (?phone=) and POST ({phone}) ----------------- */
const billHandler = (req, res) => {
  const acct = getSubscriber(extractPhone(req));
  if (!acct) return res.status(404).json({ error: "account_not_found" });

  res.json({
    accountId: acct.accountId,
    billingCycle: acct.billingCycle,
    dueDate: acct.dueDate,
    total: acct.currentBill,
    averageBill: acct.averageBill,
    currency: acct.currency,
    lineItems: acct.lineItems.map(({ code, label, amount, category, note }) => ({
      code, label, amount, category, note,
    })),
    explanation: explainWholeBill(acct),
  });
};
router.get("/bill", billHandler);
router.post("/bill", billHandler);

/* ---- EXPLAIN A CHARGE : POST {phone, amount?} ----------------------------- */
router.post("/bill/explain", (req, res) => {
  const acct = getSubscriber(extractPhone(req));
  if (!acct) return res.status(404).json({ error: "account_not_found" });

  const amount = req.body ? req.body.amount : undefined;
  if (amount === undefined || amount === null || amount === "") {
    return res.json({ type: "whole_bill", ...explainWholeBill(acct) });
  }
  return res.json({ type: "single_charge", ...explainAmount(acct, amount) });
});
/* ---- BILL PDF : answers BOTH GET (?phone=) and POST ({phone}) ------------- */
const billPdfHandler = async (req, res) => {
  const acct = getSubscriber(extractPhone(req));
  if (!acct) return res.status(404).json({ error: "account_not_found" });
 
  try {
    const pdfBytes = await buildBillPdf(acct);
    const cycleSlug = acct.billingCycle.replace(/[^\dA-Za-z]+/g, "-");
    const filename = `bill-${acct.accountId}-${cycleSlug}.pdf`;
 
    res.set({
      "Content-Type": "application/pdf",
      // "attachment" forces download; swap to "inline" if you want it to
      // open in-browser instead (e.g. when sent as a WhatsApp link preview).
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": pdfBytes.length,
    });
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("[telecom] bill PDF generation failed:", err);
    res.status(500).json({ error: "pdf_generation_failed" });
  }
};
router.get("/bill/pdf", billPdfHandler);
router.post("/bill/pdf", billPdfHandler);

export default router;