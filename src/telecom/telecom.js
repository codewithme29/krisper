import express from "express";
import axios from "axios";
import FormData from "form-data";
import { buildBillPdf } from "./billPdf.js";

const router = express.Router();

/* -------------------------------------------------------------------------- */
/*  CONFIG                                                                     */
/* -------------------------------------------------------------------------- */
const GRAPH = "https://graph.facebook.com/v21.0";
const FB_BIZ = "https://api.facebook.com/business/whatsapp"; // thread_control base

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID; // e.g. 1216056534931737
const WA_TOKEN = process.env.WHATSAPP_TOKEN;                   // system-user / permanent token

// take -> send -> release. Set false to send the document WITHOUT thread control.
const USE_THREAD_HANDOFF = true;

/* -------------------------------------------------------------------------- */
/*  MOCK DATA STORE — replace with real BSS / billing API calls in production  */
/* -------------------------------------------------------------------------- */
const ACCOUNTS = {
  "918299576621": {
    accountId: "ACC-100245",
    name: "Priyam Srivastava",
    phone: "918299576621",
    plan: "Unlimited 5G Rs.399",
    status: "Active",
    balance: 12.5,
    dataRemainingGB: 3.2,
    billingCycle: "01 Aug – 31 Aug 2026",
    dueDate: "2026-09-06",
    currentBill: 799,
    averageBill: 399,
    currency: "INR",
    lineItems: [
      { code: "RENTAL",  label: "Monthly plan rental (Unlimited 5G Rs.399)", amount: 399, category: "Fixed",  variance: 0,   note: "Same every month" },
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
// subscriber so the PoC always returns data. In production, return null on no match.
const DEFAULT_PHONE = "918299576621";
function getSubscriber(rawPhone) {
  const p = normalisePhone(rawPhone);
  console.log("[telecom] resolve phone:", JSON.stringify(rawPhone), "->", p || "(empty)");
  return ACCOUNTS[p] || ACCOUNTS[DEFAULT_PHONE] || null;
}

const inr = (n) => `Rs.${Number(n).toLocaleString("en-IN")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Explain a specific amount the user is questioning ("why Rs.280 extra?").
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
/*  THREAD CONTROL                                                             */
/*  Mirrors the manual call that worked: POST body + Bearer token, nothing     */
/*  else. URL path uses YOUR WABA phone number id (constant).                  */
/*  `to` is the CONSUMER's number — always dynamic per conversation.           */
/* -------------------------------------------------------------------------- */
async function threadControl(action, to) {
  const url = `${FB_BIZ}/phone_numbers/${PHONE_NUMBER_ID}/thread_control`;
  const payload = { messaging_product: "whatsapp", action, to };

  console.log(`[telecom] thread_control -> ${action}`, JSON.stringify(payload));
  const { data } = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  console.log(`[telecom] thread_control <- ${action} OK:`, JSON.stringify(data));
  return data;
}
const takeControl = (to) => threadControl("take", to);

// Release with backoff — the send needs a moment to settle before Meta will
// accept the release (an immediate release races and fails; a slightly delayed
// one succeeds, exactly like the manual call did).
async function releaseControl(to) {
  const delays = [800, 1500, 2500]; // ms before each attempt
  let lastErr;
  for (let i = 0; i < delays.length; i++) {
    await sleep(delays[i]);
    try {
      const data = await threadControl("release", to);
      console.log(`[telecom] control released on attempt ${i + 1} for`, to);
      return data;
    } catch (err) {
      lastErr = err.response?.data || err.message;
      console.warn(`[telecom] release attempt ${i + 1} failed:`, JSON.stringify(lastErr));
    }
  }
  console.error("[telecom] CONTROL NOT RETURNED for", to, "-", JSON.stringify(lastErr));
  throw new Error("release_failed");
}

/* -------------------------------------------------------------------------- */
/*  WHATSAPP MEDIA HELPERS                                                     */
/* -------------------------------------------------------------------------- */

/* Step 1 — upload PDF bytes to WhatsApp -> returns media_id (file stays private). */
async function uploadToWhatsApp(pdfBytes, filename) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  form.append("file", Buffer.from(pdfBytes), {
    filename,
    contentType: "application/pdf",
  });

  const { data } = await axios.post(
    `${GRAPH}/${PHONE_NUMBER_ID}/media`,
    form,
    {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${WA_TOKEN}` },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );
  return data.id; // media_id
}

/* Step 2 — send a document message referencing the uploaded media_id. */
async function sendDocument(to, mediaId, filename, caption) {
  const { data } = await axios.post(
    `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "document",
      document: { id: mediaId, filename, caption },
    },
    {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
  return data; // { messaging_product, contacts, messages:[{id: wamid}] }
}

/* Fallback — plain text service message if the document couldn't be sent. */
async function sendText(to, body) {
  const { data } = await axios.post(
    `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
  return data;
}

/* -------------------------------------------------------------------------- */
/*  ROUTES                                                                     */
/* -------------------------------------------------------------------------- */

// Health check
router.get("/health", (_req, res) => res.json({ ok: true, service: "telecom" }));

// DEBUG: hit this to see exactly what arrives.
router.all("/whoami", (req, res) => {
  res.json({
    method: req.method,
    query: req.query,
    body: req.body || null,
    phoneHeader: req.get("X-WhatsApp-Phone") || null,
    resolvedPhone: normalisePhone(extractPhone(req)) || "(empty)",
  });
});

/* ---- ACCOUNT : GET (?phone=) and POST ({phone}) -------------------------- */
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

/* ---- BILL : GET (?phone=) and POST ({phone}) ----------------------------- */
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

/* ---- EXPLAIN A CHARGE : POST {phone, amount?} ---------------------------- */
router.post("/bill/explain", (req, res) => {
  const acct = getSubscriber(extractPhone(req));
  if (!acct) return res.status(404).json({ error: "account_not_found" });

  const amount = req.body ? req.body.amount : undefined;
  if (amount === undefined || amount === null || amount === "") {
    return res.json({ type: "whole_bill", ...explainWholeBill(acct) });
  }
  return res.json({ type: "single_charge", ...explainAmount(acct, amount) });
});

/* ---- BILL PDF ------------------------------------------------------------ */

// GET: raw bytes — browser / manual download / testing only.
const billPdfRawHandler = async (req, res) => {
  const acct = getSubscriber(extractPhone(req));
  if (!acct) return res.status(404).json({ error: "account_not_found" });

  try {
    const pdfBytes = await buildBillPdf(acct);
    const cycleSlug = acct.billingCycle.replace(/[^\dA-Za-z]+/g, "-");
    const filename = `bill-${acct.accountId}-${cycleSlug}.pdf`;

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": pdfBytes.length,
    });
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("[telecom] bill PDF generation failed:", err);
    res.status(500).json({ error: "pdf_generation_failed" });
  }
};

// POST: connector tool calls this.
// Flow: take control -> upload PDF -> send document -> ALWAYS release (backoff) in finally.
const billPdfSendHandler = async (req, res) => {
  const acct = getSubscriber(extractPhone(req));
  if (!acct) return res.status(404).json({ error: "account_not_found" });

  if (!PHONE_NUMBER_ID || !WA_TOKEN) {
    console.error("[telecom] missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_TOKEN");
    return res.status(500).json({ error: "whatsapp_not_configured" });
  }

  const to = acct.phone; // dynamic consumer number
  let held = false;      // true while the app holds thread control

  try {
    const pdfBytes = await buildBillPdf(acct);
    const cycleSlug = acct.billingCycle.replace(/[^\dA-Za-z]+/g, "-");
    const filename = `bill-${acct.accountId}-${cycleSlug}.pdf`;
    const caption = `Your itemised bill for ${acct.billingCycle}. Total Rs. ${Number(acct.currentBill).toLocaleString("en-IN")}.`;

    // 1) take control from the Meta Business Agent
    if (USE_THREAD_HANDOFF) {
      await takeControl(to);
      held = true;
    }

    // 2) upload bytes -> media_id, then send the document message
    const mediaId = await uploadToWhatsApp(pdfBytes, filename);
    const sendRes = await sendDocument(to, mediaId, filename, caption);
    console.log("[telecom] document sent, wamid:", sendRes?.messages?.[0]?.id);

    // Respond to the connector now; release runs in finally.
    res.json({
      status: "sent",
      delivered: true,
      accountId: acct.accountId,
      billingCycle: acct.billingCycle,
      total: acct.currentBill,
      filename,
      wamid: sendRes?.messages?.[0]?.id ?? null,
      plainText: `I've sent your itemised bill (${filename}) here as a PDF. 📄`,
    });
  } catch (err) {
    console.error("[telecom] bill PDF send failed:", err.response?.data || err.message);

    // If we already took control but couldn't deliver the PDF, send a text
    // fallback so the user isn't left empty-handed. (Release still runs in finally.)
    if (held) {
      try {
        await sendText(
          to,
          `Sorry, I couldn't attach your bill PDF just now. Here's the summary instead:\n\n${explainWholeBill(acct).plainText}`
        );
      } catch (_) {}
    }
    if (!res.headersSent) {
      res.status(500).json({ error: "bill_pdf_failed" });
    }
  } finally {
    // 3) ALWAYS release control back to the Meta Business Agent — with backoff
    //    so the document send has time to settle before the release lands.
    if (held) {
      try {
        await releaseControl(to);
        held = false;
        console.log("[telecom] thread control returned to agent for", to);
      } catch (e) {
        console.error("[telecom] release ultimately failed for", to, "- agent may be muted:", e.message);
      }
    }
  }
};

router.get("/bill/pdf", billPdfRawHandler);   // direct download (browser/testing)
router.post("/bill/pdf", billPdfSendHandler); // take -> send document -> release

export default router;