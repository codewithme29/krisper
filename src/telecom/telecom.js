import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";

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
    balance: 12.5,            // current main balance (₹)
    dataRemainingGB: 3.2,
    billingCycle: "01 Aug – 31 Aug 2026",
    dueDate: "2026-09-06",
    currentBill: 799,         // this month's total (₹)
    averageBill: 399,         // 3-month average (₹) — used for anomaly explain
    currency: "INR",
    // `variance` = extra vs. a normal month (drives the "why is it higher" answer)
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
const getSubscriber = (phone) => ACCOUNTS[normalisePhone(phone)] || null;
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

  // 1) Exact match on a line item.
  let match = acct.lineItems.find((li) => li.amount === amt);

  // 2) Match the total "extra vs usual".
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

  // 3) Closest line item within ₹5 if no exact hit.
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


// GET /telecom/account?phone=…  → getAccount connector tool
router.get("/account", (req, res) => {
  const acct = getSubscriber(req.query.phone);
  if (!acct) return res.status(404).json({ error: "account_not_found", phone: req.query.phone });

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
});

// GET /telecom/bill?phone=…  → getBillBreakdown connector tool
// Returns itemised bill AND a ready-to-send plain-language explanation.
router.get("/bill", (req, res) => {
  const acct = getSubscriber(req.query.phone);
  if (!acct) return res.status(404).json({ error: "account_not_found", phone: req.query.phone });

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
    explanation: explainWholeBill(acct), // headline + plainText the agent sends as-is
  });
});

// POST /telecom/bill/explain
// Body: { phone, amount }  → explain that charge   |  { phone } → explain whole bill
router.post("/bill/explain", (req, res) => {
  const { phone, amount } = req.body || {};
  const acct = getSubscriber(phone);
  if (!acct) return res.status(404).json({ error: "account_not_found", phone });

  if (amount === undefined || amount === null || amount === "") {
    return res.json({ type: "whole_bill", ...explainWholeBill(acct) });
  }
  return res.json({ type: "single_charge", ...explainAmount(acct, amount) });
});

export default router;