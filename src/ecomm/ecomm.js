import express from "express";
import axios from "axios";
import crypto from "crypto";

const router = express.Router();

/* -------------------------------------------------------------------- */
/*  Config                                                               */
/* -------------------------------------------------------------------- */

const WATOKEN = process.env.WHATSAPPTOKEN;
const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v20.0";

/* -------------------------------------------------------------------- */
/*  Mock data — swap for your real order DB                             */
/* -------------------------------------------------------------------- */

const ORDERS = [
  {
    orderId: "ORD-1001",
    phone: "918299576621",
    placedAt: "2026-08-10T10:15:00Z",
    deliveredAt: "2026-08-14T13:40:00Z",
    items: [
      { itemId: "SKU-BLEND-01", name: "ProBlend 600 Blender", price: 2499 },
    ],
  },
  {
    orderId: "ORD-1002",
    phone: "918299576621",
    placedAt: "2026-07-28T09:00:00Z",
    deliveredAt: "2026-08-01T11:20:00Z",
    items: [
      { itemId: "SKU-KETTLE-02", name: "SteamPro Electric Kettle", price: 1299 },
    ],
  },
  {
    orderId: "ORD-2050",
    phone: "918299576621",
    placedAt: "2026-08-15T12:00:00Z",
    deliveredAt: "2026-08-18T09:10:00Z",
    items: [
      { itemId: "SKU-TOAST-05", name: "CrispToast 4-Slice Toaster", price: 1799 },
    ],
  },
];

// In-memory RMA store — swap for Postgres/Mongo/etc. Records disappear on
// restart; that's fine for a demo, not for production.
const RETURNS = new Map();

/* -------------------------------------------------------------------- */
/*  Orders service                                                      */
/* -------------------------------------------------------------------- */

function getOrdersByPhone(phone) {
  return ORDERS
    .filter((o) => o.phone === phone)
    .sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
}

function getOrderForPhone(orderId, phone) {
  return ORDERS.find((o) => o.orderId === orderId && o.phone === phone) || null;
}

/* -------------------------------------------------------------------- */
/*  WhatsApp media download                                             */
/* -------------------------------------------------------------------- */

async function downloadWhatsAppMedia(mediaId) {
  if (!mediaId) throw new Error("mediaId is required");

  // Local/dev convenience — skip the real download so you can curl this
  // end to end without a live WhatsApp token or a real media id.
  if (process.env.SKIP_MEDIA_DOWNLOAD === "true") {
    return {
      buffer: Buffer.from(`fake-image-bytes-for-${mediaId}`),
      mimeType: "image/jpeg",
    };
  }

  if (!WATOKEN) throw new Error("WHATSAPPTOKEN is not configured");

  const metaRes = await axios.get(
    `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${WATOKEN}` } }
  );

  const { url, mime_type: mimeType } = metaRes.data;
  if (!url) throw new Error("Media metadata did not include a download URL");

  const fileRes = await axios.get(url, {
    headers: { Authorization: `Bearer ${WATOKEN}` },
    responseType: "arraybuffer",
  });

  return { buffer: Buffer.from(fileRes.data), mimeType: mimeType || "image/jpeg" };
}

/* -------------------------------------------------------------------- */
/*  Returns service                                                     */
/* -------------------------------------------------------------------- */

function createReturn({ orderId, itemId, phone, customerName, actionType, reason, mediaMeta, classification }) {
  const rmaId = `RMA-${orderId}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const record = {
    rmaId, orderId, itemId, phone, customerName, actionType, reason, classification, mediaMeta,
    status: classification.autoApprove ? "approved" : "pending_review",
    createdAt: new Date().toISOString(),
    pickup: null,
  };
  RETURNS.set(rmaId, record);
  return record;
}

function schedulePickup(rmaId, phone, slot) {
  const record = RETURNS.get(rmaId);
  if (!record) return { error: "not_found" };
  if (record.phone !== phone) return { error: "not_owner" };
  if (record.status === "pending_review") return { error: "pending_review" };

  const updated = { ...record, pickup: { slot, scheduledAt: new Date().toISOString() }, status: "pickup_scheduled" };
  RETURNS.set(rmaId, updated);
  return { record: updated };
}

function getRefundStatus(rmaId, phone) {
  const record = RETURNS.get(rmaId);
  if (!record) return null;
  if (record.phone !== phone) return { error: "not_owner" };

  if (record.status === "pending_review") return { rmaId, refundStatus: "awaiting_review" };
  if (!record.pickup) return { rmaId, refundStatus: "awaiting_pickup" };

  const minutesSincePickup = (Date.now() - new Date(record.pickup.scheduledAt).getTime()) / 60000;
  let refundStatus;
  if (minutesSincePickup < 2) refundStatus = "item_picked_up";
  else if (minutesSincePickup < 5) refundStatus = "refund_initiated";
  else refundStatus = "refunded";

  return { rmaId, refundStatus };
}

/* -------------------------------------------------------------------- */
/*  Routes                                                               */
/* -------------------------------------------------------------------- */

// GET /ecomm/orders?phone=918299576621[&orderId=ORD-1001]  -> getOrders
router.get("/ecomm/orders", (req, res) => {
  const { phone, orderId } = req.query;
  if (!phone) return res.status(400).json({ error: "phone is required" });

  if (orderId) {
    const order = getOrderForPhone(orderId, phone);
    if (!order) return res.status(404).json({ error: "order_not_found" });
    return res.json({ orders: [order] });
  }
  return res.json({ orders: getOrdersByPhone(phone) });
});

// POST /ecomm/returns  { phone, name, orderNumber, actiontype, description, photos, autoApprove?, damageCategory?, notes? }  -> initiateReturn
//
// `phone` is attached automatically from the WhatsApp conversation.
// `photos` is an array of WhatsApp media ids (one or more) — all are
// downloaded as evidence. There's no itemId in the payload; this route
// resolves the item from the order itself and echoes it back in the
// response so the agent can confirm it to the customer.
//
// `autoApprove` / `damageCategory` / `notes` are optional — if the agent
// supplies them, they're used; if not, this fails closed to pending_review
// rather than guessing.
router.post("/ecomm/returns", async (req, res) => {
  const { phone, name, orderNumber, actiontype, description, photos, autoApprove, damageCategory, notes } = req.body || {};

  if (!phone || !name || !orderNumber || !actiontype || !description || !Array.isArray(photos) || photos.length === 0) {
    return res.status(400).json({
      error: "phone, name, orderNumber, actiontype, description and at least one photo are all required",
    });
  }
  if (!["return", "exchange"].includes(actiontype)) {
    return res.status(400).json({ error: "actiontype must be 'return' or 'exchange'" });
  }

  const order = getOrderForPhone(orderNumber, phone);
  if (!order) return res.status(404).json({ error: "order_not_found" });

  if (!order.items || order.items.length === 0) {
    return res.status(422).json({ error: "order_has_no_items" });
  }
  if (order.items.length > 1) {
    return res.status(409).json({
      error: "item_ambiguous",
      message: "This order has more than one item — ask the customer which one they mean, then retry.",
      items: order.items.map((i) => ({ itemId: i.itemId, name: i.name })),
    });
  }
  const item = order.items[0];

  let mediaList;
  try {
    mediaList = await Promise.all(photos.map((mediaId) => downloadWhatsAppMedia(mediaId)));
  } catch (err) {
    return res.status(502).json({ error: "media_download_failed", detail: err.message });
  }

  const classification = {
    autoApprove: typeof autoApprove === "boolean" ? autoApprove : false,
    category: damageCategory || "unspecified",
    notes: notes || "",
  };
  const mediaMeta = mediaList.map((m) => ({ mimeType: m.mimeType, sizeBytes: m.buffer.length }));

  const record = createReturn({
    orderId: order.orderId,
    itemId: item.itemId,
    phone,
    customerName: name,
    actionType: actiontype,
    reason: description,
    mediaMeta,
    classification,
  });

  return res.status(201).json({
    rmaId: record.rmaId,
    status: record.status,
    actionType: record.actionType,
    item: { itemId: item.itemId, name: item.name },
  });
});

// POST /ecomm/returns/:rmaId/pickup  { phone, slot }  -> schedulePickup
router.post("/ecomm/returns/:rmaId/pickup", (req, res) => {
  const { phone, slot } = req.body || {};
  if (!phone || !slot) return res.status(400).json({ error: "phone and slot are required" });

  const { record, error } = schedulePickup(req.params.rmaId, phone, slot);

  if (error === "not_found" || error === "not_owner") {
    return res.status(404).json({ error: "rma_not_found" });
  }
  if (error === "pending_review") {
    return res.status(409).json({ error: "pending_review", message: "This return is still awaiting manual review — nothing to pick up yet." });
  }
  return res.json({ rmaId: record.rmaId, status: record.status, pickup: record.pickup });
});

// GET /ecomm/returns/:rmaId/refund?phone=...  -> getRefundStatus
router.get("/ecomm/returns/:rmaId/refund", (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "phone is required" });

  const result = getRefundStatus(req.params.rmaId, phone);
  if (!result || result.error === "not_owner") {
    return res.status(404).json({ error: "rma_not_found" });
  }
  return res.json(result);
});

export default router;