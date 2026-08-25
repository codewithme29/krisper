import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import {
  decryptRequest,
  encryptResponse,
} from "./whatsappFlowCrypto.js";

import {
  getSession,
  setSession,
} from "./flowSession.js";

const router = express.Router();

/* ========================================================================== */
/* Configuration                                                              */
/* ========================================================================== */

const WATOKEN =
  process.env.WHATSAPPTOKEN;

const GRAPH_VERSION =
  process.env.WHATSAPP_GRAPH_VERSION ||
  "v20.0";

const SKIP_MEDIA_DOWNLOAD =
  process.env.SKIP_MEDIA_DOWNLOAD ===
  "true";

const UPLOAD_DIRECTORY =
  path.resolve(
    process.cwd(),
    process.env
      .RETURN_UPLOAD_DIRECTORY ||
      "uploads/returns"
  );

const FLOW_SUBMISSION_DIRECTORY =
  path.resolve(
    process.cwd(),
    process.env
      .FLOW_SUBMISSION_DIRECTORY ||
      "uploads/flow-submissions"
  );

/*
 * Create local storage directories.
 *
 * For production, replace local filesystem storage
 * with object storage such as S3 or Azure Blob Storage.
 */

fs.mkdirSync(
  UPLOAD_DIRECTORY,
  {
    recursive: true,
  }
);

fs.mkdirSync(
  FLOW_SUBMISSION_DIRECTORY,
  {
    recursive: true,
  }
);

/* ========================================================================== */
/* Mock orders                                                                */
/* ========================================================================== */

const ORDERS = [
  {
    orderId: "ORD-1001",
    phone: "918299576621",

    placedAt:
      "2026-08-10T10:15:00Z",

    deliveredAt:
      "2026-08-14T13:40:00Z",

    items: [
      {
        itemId:
          "SKU-BLEND-01",

        name:
          "ProBlend 600 Blender",

        price: 2499,
      },
    ],
  },

  {
    orderId: "ORD-1002",
    phone: "918299576621",

    placedAt:
      "2026-07-28T09:00:00Z",

    deliveredAt:
      "2026-08-01T11:20:00Z",

    items: [
      {
        itemId:
          "SKU-KETTLE-02",

        name:
          "SteamPro Electric Kettle",

        price: 1299,
      },
    ],
  },

  {
    orderId: "ORD-2050",
    phone: "918299576621",

    placedAt:
      "2026-08-15T12:00:00Z",

    deliveredAt:
      "2026-08-18T09:10:00Z",

    items: [
      {
        itemId:
          "SKU-TOAST-05",

        name:
          "CrispToast 4-Slice Toaster",

        price: 1799,
      },
    ],
  },
];

/* ========================================================================== */
/* In-memory demo stores                                                      */
/* ========================================================================== */

/*
 * Replace these Maps with Redis or a database in production.
 */

const RETURNS =
  new Map();

const FLOW_SUBMISSIONS =
  new Map();

/* ========================================================================== */
/* General helpers                                                            */
/* ========================================================================== */

function normalizePhone(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const normalized =
    String(value).replace(
      /\D/g,
      ""
    );

  return normalized || null;
}

function sanitizeFilePart(value) {
  return String(
    value || "unknown"
  )
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    )
    .slice(0, 100);
}

function formatTimestampForFilename() {
  return new Date()
    .toISOString()
    .replace(
      /[:.]/g,
      "-"
    );
}

function writeJsonFile(
  filePath,
  value
) {
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      value,
      null,
      2
    ),
    "utf8"
  );
}

function getExtensionFromMimeType(
  mimeType
) {
  const normalized =
    String(
      mimeType || ""
    ).toLowerCase();

  if (
    normalized.includes(
      "jpeg"
    ) ||
    normalized.includes(
      "jpg"
    )
  ) {
    return ".jpg";
  }

  if (
    normalized.includes(
      "png"
    )
  ) {
    return ".png";
  }

  if (
    normalized.includes(
      "webp"
    )
  ) {
    return ".webp";
  }

  if (
    normalized.includes(
      "gif"
    )
  ) {
    return ".gif";
  }

  if (
    normalized.includes(
      "pdf"
    )
  ) {
    return ".pdf";
  }

  return ".bin";
}

function getExtensionFromFilename(
  filename
) {
  if (!filename) {
    return "";
  }

  const extension =
    path.extname(filename);

  if (
    extension.length > 0 &&
    extension.length <= 10
  ) {
    return extension;
  }

  return "";
}

/* ========================================================================== */
/* Order service                                                              */
/* ========================================================================== */

function getOrdersByPhone(
  phone
) {
  const normalizedPhone =
    normalizePhone(phone);

  return ORDERS
    .filter(
      (order) =>
        normalizePhone(
          order.phone
        ) ===
        normalizedPhone
    )
    .sort(
      (a, b) =>
        new Date(
          b.placedAt
        ).getTime() -
        new Date(
          a.placedAt
        ).getTime()
    );
}

function getOrderForPhone(
  orderId,
  phone
) {
  const normalizedPhone =
    normalizePhone(phone);

  return (
    ORDERS.find(
      (order) =>
        order.orderId ===
          String(orderId) &&
        normalizePhone(
          order.phone
        ) ===
          normalizedPhone
    ) || null
  );
}

/* ========================================================================== */
/* WhatsApp Flow field parsing                                                */
/* ========================================================================== */

/*
 * The Flow may submit either:
 *
 * 1. Friendly backend field names:
 *
 * {
 *   name,
 *   orderNumber,
 *   actiontype,
 *   description,
 *   photos
 * }
 *
 * 2. Auto-generated component field names:
 *
 * {
 *   screen_0_Name_0,
 *   screen_0_Order_number_1,
 *   screen_0_Choose_a_topic_2,
 *   screen_0_Description_of_issue_3,
 *   screen_0_Photo_4
 * }
 *
 * This parser supports both.
 */

function firstDefined(
  object,
  keys,
  fallback = null
) {
  for (
    const key of keys
  ) {
    const value =
      object?.[key];

    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return fallback;
}

function mapActionType(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const normalized =
    String(value)
      .trim()
      .toLowerCase();

  if (
    normalized === "3_return" ||
    normalized === "return" ||
    normalized ===
      "3-return"
  ) {
    return "return";
  }

  if (
    normalized ===
      "2_exchange" ||
    normalized ===
      "exchange" ||
    normalized ===
      "2-exchange"
  ) {
    return "exchange";
  }

  return normalized;
}

function parseFlowSubmission(
  flowData
) {
  const submittedPhone =
    firstDefined(
      flowData,
      [
        "phone",
        "whatsappNumber",
        "whatsapp_number",
      ]
    );

  const name =
    firstDefined(
      flowData,
      [
        "name",
        "screen_0_Name_0",
        "customerName",
        "customer_name",
      ]
    );

  const orderNumber =
    firstDefined(
      flowData,
      [
        "orderNumber",
        "order_number",
        "orderId",
        "screen_0_Order_number_1",
      ]
    );

  const actionValue =
    firstDefined(
      flowData,
      [
        "actiontype",
        "actionType",
        "action_type",
        "screen_0_Choose_a_topic_2",
      ]
    );

  const description =
    firstDefined(
      flowData,
      [
        "description",
        "reason",
        "issueDescription",
        "issue_description",
        "screen_0_Description_of_issue_3",
      ],
      ""
    );

  const rawPhotos =
    firstDefined(
      flowData,
      [
        "photos",
        "photo",
        "media",
        "screen_0_Photo_4",
      ],
      []
    );

  return {
    submittedPhone:
      normalizePhone(
        submittedPhone
      ),

    name:
      name
        ? String(name).trim()
        : null,

    orderNumber:
      orderNumber
        ? String(
            orderNumber
          ).trim()
        : null,

    actiontype:
      mapActionType(
        actionValue
      ),

    description:
      description
        ? String(
            description
          ).trim()
        : "",

    rawPhotos,
  };
}

/* ========================================================================== */
/* Photo normalization                                                       */
/* ========================================================================== */

/*
 * Normal REST endpoint:
 *
 * photos: [
 *   "WHATSAPP_MEDIA_ID"
 * ]
 *
 * Flow upload possibilities:
 *
 * photos: [
 *   {
 *     media_id: "...",
 *     file_name: "...",
 *     mime_type: "image/jpeg"
 *   }
 * ]
 *
 * or:
 *
 * photos: [
 *   {
 *     id: "...",
 *     filename: "...",
 *     mimeType: "image/jpeg"
 *   }
 * ]
 */

function normalizePhotos(
  rawPhotos
) {
  if (
    rawPhotos === null ||
    rawPhotos === undefined
  ) {
    return [];
  }

  const photoArray =
    Array.isArray(rawPhotos)
      ? rawPhotos
      : [rawPhotos];

  return photoArray
    .map(
      (
        photo,
        index
      ) => {
        if (
          typeof photo ===
          "string"
        ) {
          const value =
            photo.trim();

          if (!value) {
            return null;
          }

          return {
            index,
            mediaId:
              value,

            cdnUrl: null,
            fileName: null,
            mimeType: null,
            fileSize: null,
            sha256: null,

            original:
              photo,
          };
        }

        if (
          !photo ||
          typeof photo !==
            "object"
        ) {
          return null;
        }

        const mediaId =
          photo.media_id ||
          photo.mediaId ||
          photo.id ||
          null;

        const cdnUrl =
          photo.cdn_url ||
          photo.cdnUrl ||
          photo.url ||
          null;

        const fileName =
          photo.file_name ||
          photo.fileName ||
          photo.filename ||
          photo.name ||
          null;

        const mimeType =
          photo.mime_type ||
          photo.mimeType ||
          photo.type ||
          null;

        const fileSize =
          photo.file_size ||
          photo.fileSize ||
          photo.size ||
          null;

        const sha256 =
          photo.sha256 ||
          null;

        if (
          !mediaId &&
          !cdnUrl
        ) {
          return null;
        }

        return {
          index,
          mediaId:
            mediaId
              ? String(
                  mediaId
                )
              : null,

          cdnUrl:
            cdnUrl
              ? String(
                  cdnUrl
                )
              : null,

          fileName:
            fileName
              ? String(
                  fileName
                )
              : null,

          mimeType:
            mimeType
              ? String(
                  mimeType
                )
              : null,

          fileSize,
          sha256,

          original:
            photo,
        };
      }
    )
    .filter(Boolean);
}

/* ========================================================================== */
/* WhatsApp media download                                                    */
/* ========================================================================== */

async function downloadByMediaId(
  photo
) {
  if (!WATOKEN) {
    throw new Error(
      "WHATSAPPTOKEN is not configured"
    );
  }

  const metadataResponse =
    await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/${photo.mediaId}`,
      {
        headers: {
          Authorization:
            `Bearer ${WATOKEN}`,
        },

        timeout: 15000,
      }
    );

  const downloadUrl =
    metadataResponse.data
      ?.url;

  if (!downloadUrl) {
    throw new Error(
      `Media metadata for ${photo.mediaId} did not include a download URL`
    );
  }

  const fileResponse =
    await axios.get(
      downloadUrl,
      {
        headers: {
          Authorization:
            `Bearer ${WATOKEN}`,
        },

        responseType:
          "arraybuffer",

        timeout: 30000,

        maxContentLength:
          20 * 1024 * 1024,

        maxBodyLength:
          20 * 1024 * 1024,
      }
    );

  return {
    buffer:
      Buffer.from(
        fileResponse.data
      ),

    mimeType:
      metadataResponse.data
        ?.mime_type ||
      photo.mimeType ||
      fileResponse.headers[
        "content-type"
      ] ||
      "application/octet-stream",

    fileName:
      photo.fileName,

    source:
      "media_id",

    mediaId:
      photo.mediaId,

    cdnUrl: null,
  };
}

async function downloadByCdnUrl(
  photo
) {
  if (!photo.cdnUrl) {
    throw new Error(
      "CDN URL is missing"
    );
  }

  const headers = {};

  if (WATOKEN) {
    headers.Authorization =
      `Bearer ${WATOKEN}`;
  }

  const fileResponse =
    await axios.get(
      photo.cdnUrl,
      {
        headers,

        responseType:
          "arraybuffer",

        timeout: 30000,

        maxContentLength:
          20 * 1024 * 1024,

        maxBodyLength:
          20 * 1024 * 1024,
      }
    );

  return {
    buffer:
      Buffer.from(
        fileResponse.data
      ),

    mimeType:
      photo.mimeType ||
      fileResponse.headers[
        "content-type"
      ] ||
      "application/octet-stream",

    fileName:
      photo.fileName,

    source:
      "cdn_url",

    mediaId: null,

    cdnUrl:
      photo.cdnUrl,
  };
}

async function downloadWhatsAppMedia(
  photo
) {
  if (!photo) {
    throw new Error(
      "Photo information is required"
    );
  }

  if (
    SKIP_MEDIA_DOWNLOAD
  ) {
    const reference =
      photo.mediaId ||
      photo.fileName ||
      `photo-${photo.index}`;

    return {
      buffer:
        Buffer.from(
          `fake-image-bytes-for-${reference}`
        ),

      mimeType:
        photo.mimeType ||
        "image/jpeg",

      fileName:
        photo.fileName,

      source:
        "mock",

      mediaId:
        photo.mediaId,

      cdnUrl:
        photo.cdnUrl,
    };
  }

  if (photo.mediaId) {
    return downloadByMediaId(
      photo
    );
  }

  if (photo.cdnUrl) {
    return downloadByCdnUrl(
      photo
    );
  }

  throw new Error(
    "Photo does not contain media_id, mediaId, id, cdn_url, cdnUrl or url"
  );
}

/* ========================================================================== */
/* Save downloaded media                                                      */
/* ========================================================================== */

function saveDownloadedMedia({
  media,
  orderNumber,
  phone,
  index,
}) {
  const originalExtension =
    getExtensionFromFilename(
      media.fileName
    );

  const extension =
    originalExtension ||
    getExtensionFromMimeType(
      media.mimeType
    );

  const safeOrder =
    sanitizeFilePart(
      orderNumber
    );

  const safePhone =
    sanitizeFilePart(phone);

  const timestamp =
    formatTimestampForFilename();

  const filename =
    `${safeOrder}_${safePhone}_${timestamp}_${index}${extension}`;

  const absolutePath =
    path.join(
      UPLOAD_DIRECTORY,
      filename
    );

  fs.writeFileSync(
    absolutePath,
    media.buffer
  );

  return {
    filename,

    path:
      absolutePath,

    relativePath:
      path.relative(
        process.cwd(),
        absolutePath
      ),

    mimeType:
      media.mimeType,

    sizeBytes:
      media.buffer.length,

    source:
      media.source,

    mediaId:
      media.mediaId ||
      null,

    originalFileName:
      media.fileName ||
      null,

    savedAt:
      new Date().toISOString(),
  };
}

async function downloadAndSavePhotos({
  rawPhotos,
  orderNumber,
  phone,
}) {
  const normalizedPhotos =
    normalizePhotos(
      rawPhotos
    );

  if (
    normalizedPhotos.length ===
    0
  ) {
    return {
      normalizedPhotos: [],
      savedFiles: [],
    };
  }

  const savedFiles = [];

  /*
   * Process sequentially so logs and saved file indexes
   * remain predictable.
   */

  for (
    let index = 0;
    index <
    normalizedPhotos.length;
    index += 1
  ) {
    const photo =
      normalizedPhotos[index];

    const media =
      await downloadWhatsAppMedia(
        photo
      );

    const saved =
      saveDownloadedMedia({
        media,
        orderNumber,
        phone,
        index,
      });

    savedFiles.push(
      saved
    );

    console.log(
      "[return-media] saved:",
      {
        filename:
          saved.filename,

        mimeType:
          saved.mimeType,

        sizeBytes:
          saved.sizeBytes,

        relativePath:
          saved.relativePath,

        source:
          saved.source,
      }
    );
  }

  return {
    normalizedPhotos,
    savedFiles,
  };
}

/* ========================================================================== */
/* Return service                                                             */
/* ========================================================================== */

function createReturn({
  orderId,
  itemId,
  phone,
  customerName,
  actionType,
  reason,
  mediaMeta,
  flowToken = null,
  source = "rest_api",
}) {
  const rmaId =
    `RMA-${orderId}-${crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase()}`;

  const record = {
    rmaId,
    orderId,
    itemId,

    phone:
      normalizePhone(phone),

    customerName,
    actionType,
    reason,

    mediaMeta:
      mediaMeta || [],

    status:
      "pending_review",

    source,

    flowToken,

    createdAt:
      new Date().toISOString(),

    pickup: null,
  };

  RETURNS.set(
    rmaId,
    record
  );

  return record;
}

function schedulePickup(
  rmaId,
  phone,
  slot
) {
  const record =
    RETURNS.get(rmaId);

  if (!record) {
    return {
      error:
        "not_found",
    };
  }

  if (
    normalizePhone(
      record.phone
    ) !==
    normalizePhone(phone)
  ) {
    return {
      error:
        "not_owner",
    };
  }

  if (
    record.status ===
    "pending_review"
  ) {
    return {
      error:
        "pending_review",
    };
  }

  const updatedRecord = {
    ...record,

    pickup: {
      slot,

      scheduledAt:
        new Date().toISOString(),
    },

    status:
      "pickup_scheduled",
  };

  RETURNS.set(
    rmaId,
    updatedRecord
  );

  return {
    record:
      updatedRecord,
  };
}

function getRefundStatus(
  rmaId,
  phone
) {
  const record =
    RETURNS.get(rmaId);

  if (!record) {
    return null;
  }

  if (
    normalizePhone(
      record.phone
    ) !==
    normalizePhone(phone)
  ) {
    return {
      error:
        "not_owner",
    };
  }

  if (
    record.status ===
    "pending_review"
  ) {
    return {
      rmaId,

      refundStatus:
        "awaiting_review",
    };
  }

  if (!record.pickup) {
    return {
      rmaId,

      refundStatus:
        "awaiting_pickup",
    };
  }

  const minutesSincePickup =
    (Date.now() -
      new Date(
        record.pickup
          .scheduledAt
      ).getTime()) /
    60000;

  let refundStatus;

  if (
    minutesSincePickup < 2
  ) {
    refundStatus =
      "item_picked_up";
  } else if (
    minutesSincePickup < 5
  ) {
    refundStatus =
      "refund_initiated";
  } else {
    refundStatus =
      "refunded";
  }

  return {
    rmaId,
    refundStatus,
  };
}

/* ========================================================================== */
/* Flow submission persistence                                                */
/* ========================================================================== */

function saveReadableFlowSubmission({
  flowToken,
  action,
  screen,
  phone,
  parsedSubmission,
  rawFlowData,
  savedFiles = [],
  rma = null,
}) {
  const submissionId =
    crypto
      .randomBytes(6)
      .toString("hex");

  const readableRecord = {
    submissionId,

    receivedAt:
      new Date().toISOString(),

    flowToken:
      flowToken || null,

    action:
      action || null,

    screen:
      screen || null,

    customer: {
      phone:
        normalizePhone(phone),

      name:
        parsedSubmission
          ?.name ||
        null,
    },

    returnRequest: {
      orderNumber:
        parsedSubmission
          ?.orderNumber ||
        null,

      actiontype:
        parsedSubmission
          ?.actiontype ||
        null,

      description:
        parsedSubmission
          ?.description ||
        "",

      photos:
        savedFiles,
    },

    rma:
      rma
        ? {
            rmaId:
              rma.rmaId,

            status:
              rma.status,

            orderId:
              rma.orderId,

            itemId:
              rma.itemId,

            createdAt:
              rma.createdAt,
          }
        : null,

    /*
     * This helps debug Flow field-name changes.
     *
     * Do not expose rawFlowData to the customer.
     */
    rawFlowData,
  };

  FLOW_SUBMISSIONS.set(
    submissionId,
    readableRecord
  );

  const filename =
    `flow-submission-${formatTimestampForFilename()}-${submissionId}.json`;

  const filePath =
    path.join(
      FLOW_SUBMISSION_DIRECTORY,
      filename
    );

  writeJsonFile(
    filePath,
    readableRecord
  );

  console.log(
    "[return-flow] readable submission saved:",
    path.relative(
      process.cwd(),
      filePath
    )
  );

  return {
    record:
      readableRecord,

    filePath,
  };
}

/* ========================================================================== */
/* Flow response helper                                                       */
/* ========================================================================== */

function sendEncryptedFlowResponse(
  res,
  response,
  aesKey,
  iv
) {
  console.log(
    "[return-flow] outgoing response:",
    JSON.stringify(
      response,
      null,
      2
    )
  );

  const encryptedResponse =
    encryptResponse(
      response,
      aesKey,
      iv
    );

  return res
    .status(200)
    .set({
      "Content-Type":
        "text/plain",

      "Cache-Control":
        "no-store",
    })
    .send(
      encryptedResponse
    );
}

/* ========================================================================== */
/* Reusable return processor                                                  */
/* ========================================================================== */

async function processReturnRequest({
  phone,
  name,
  orderNumber,
  actiontype,
  description,
  rawPhotos,
  flowToken = null,
  source = "rest_api",
}) {
  const normalizedPhone =
    normalizePhone(phone);

  if (
    !normalizedPhone ||
    !name ||
    !orderNumber ||
    !actiontype ||
    !description
  ) {
    return {
      ok: false,
      statusCode: 400,

      error:
        "missing_required_fields",
    };
  }

  if (
    ![
      "return",
      "exchange",
    ].includes(
      actiontype
    )
  ) {
    return {
      ok: false,
      statusCode: 400,

      error:
        "invalid_actiontype",
    };
  }

  const normalizedPhotos =
    normalizePhotos(
      rawPhotos
    );

  if (
    normalizedPhotos.length ===
    0
  ) {
    return {
      ok: false,
      statusCode: 400,

      error:
        "photo_required",
    };
  }

  const order =
    getOrderForPhone(
      orderNumber,
      normalizedPhone
    );

  if (!order) {
    return {
      ok: false,
      statusCode: 404,

      error:
        "order_not_found",
    };
  }

  if (
    !Array.isArray(
      order.items
    ) ||
    order.items.length ===
      0
  ) {
    return {
      ok: false,
      statusCode: 422,

      error:
        "order_has_no_items",
    };
  }

  if (
    order.items.length > 1
  ) {
    return {
      ok: false,
      statusCode: 409,

      error:
        "item_ambiguous",

      items:
        order.items.map(
          (item) => ({
            itemId:
              item.itemId,

            name:
              item.name,
          })
        ),
    };
  }

  let downloadResult;

  try {
    downloadResult =
      await downloadAndSavePhotos({
        rawPhotos,
        orderNumber:
          order.orderId,

        phone:
          normalizedPhone,
      });
  } catch (error) {
    console.error(
      "[return-media] download failed:",
      error.message
    );

    return {
      ok: false,
      statusCode: 502,

      error:
        "media_download_failed",

      detail:
        error.message,
    };
  }

  const item =
    order.items[0];

  const record =
    createReturn({
      orderId:
        order.orderId,

      itemId:
        item.itemId,

      phone:
        normalizedPhone,

      customerName:
        name,

      actionType:
        actiontype,

      reason:
        description,

      mediaMeta:
        downloadResult.savedFiles,

      flowToken,
      source,
    });

  return {
    ok: true,
    statusCode: 201,

    record,
    item,

    savedFiles:
      downloadResult.savedFiles,

    normalizedPhotos:
      downloadResult
        .normalizedPhotos,
  };
}

/* ========================================================================== */
/* Health endpoint                                                            */
/* ========================================================================== */

router.get(
  "/health",
  (_req, res) => {
    return res
      .status(200)
      .json({
        status:
          "active",

        service:
          "ecommerce-return-service",

        uploadDirectory:
          path.relative(
            process.cwd(),
            UPLOAD_DIRECTORY
          ),
      });
  }
);

/* ========================================================================== */
/* GET /orders                                                                */
/* ========================================================================== */

router.get(
  "/orders",
  (req, res) => {
    const {
      phone,
      orderId,
    } = req.query;

    const normalizedPhone =
      normalizePhone(phone);

    if (!normalizedPhone) {
      return res
        .status(400)
        .json({
          error:
            "phone is required",
        });
    }

    if (orderId) {
      const order =
        getOrderForPhone(
          orderId,
          normalizedPhone
        );

      if (!order) {
        return res
          .status(404)
          .json({
            error:
              "order_not_found",
          });
      }

      return res.json({
        orders: [order],
      });
    }

    return res.json({
      orders:
        getOrdersByPhone(
          normalizedPhone
        ),
    });
  }
);

/* ========================================================================== */
/* POST /returns                                                              */
/* Plain JSON fallback API                                                    */
/* ========================================================================== */

/*
 * This endpoint is retained for:
 *
 * - connector fallback
 * - Postman testing
 * - non-Flow clients
 *
 * Do not call this endpoint after /returns/flow has already
 * created the RMA.
 */

router.post(
  "/returns",
  async (req, res) => {
    try {
      const {
        phone,
        name,
        orderNumber,
        actiontype,
        description,
        photos,
      } = req.body || {};

      const result =
        await processReturnRequest({
          phone,
          name,
          orderNumber,

          actiontype:
            mapActionType(
              actiontype
            ),

          description,
          rawPhotos:
            photos,

          source:
            "rest_api",
        });

      if (!result.ok) {
        const body = {
          error:
            result.error,

          ...(result.detail
            ? {
                detail:
                  result.detail,
              }
            : {}),

          ...(result.items
            ? {
                items:
                  result.items,
              }
            : {}),
        };

        return res
          .status(
            result.statusCode
          )
          .json(body);
      }

      return res
        .status(201)
        .json({
          rmaId:
            result.record.rmaId,

          status:
            result.record.status,

          actionType:
            result.record
              .actionType,

          orderId:
            result.record.orderId,

          item: {
            itemId:
              result.item.itemId,

            name:
              result.item.name,
          },

          uploadedFiles:
            result.savedFiles.map(
              (file) => ({
                filename:
                  file.filename,

                mimeType:
                  file.mimeType,

                sizeBytes:
                  file.sizeBytes,
              })
            ),
        });
    } catch (error) {
      console.error(
        "[returns] error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "return_creation_failed",

          detail:
            error.message,
        });
    }
  }
);

/* ========================================================================== */
/* POST /returns/:rmaId/approve                                               */
/* Demo manual approval endpoint                                              */
/* ========================================================================== */

router.post(
  "/returns/:rmaId/approve",
  (req, res) => {
    const phone =
      normalizePhone(
        req.body?.phone
      );

    if (!phone) {
      return res
        .status(400)
        .json({
          error:
            "phone is required",
        });
    }

    const record =
      RETURNS.get(
        req.params.rmaId
      );

    if (
      !record ||
      normalizePhone(
        record.phone
      ) !== phone
    ) {
      return res
        .status(404)
        .json({
          error:
            "rma_not_found",
        });
    }

    const updatedRecord = {
      ...record,

      status:
        "approved",

      reviewedAt:
        new Date().toISOString(),
    };

    RETURNS.set(
      updatedRecord.rmaId,
      updatedRecord
    );

    return res.json({
      rmaId:
        updatedRecord.rmaId,

      status:
        updatedRecord.status,

      reviewedAt:
        updatedRecord.reviewedAt,
    });
  }
);

/* ========================================================================== */
/* POST /returns/:rmaId/pickup                                                */
/* ========================================================================== */

router.post(
  "/returns/:rmaId/pickup",
  (req, res) => {
    const {
      phone,
      slot,
    } = req.body || {};

    if (!phone || !slot) {
      return res
        .status(400)
        .json({
          error:
            "phone and slot are required",
        });
    }

    const result =
      schedulePickup(
        req.params.rmaId,
        phone,
        slot
      );

    if (
      result.error ===
        "not_found" ||
      result.error ===
        "not_owner"
    ) {
      return res
        .status(404)
        .json({
          error:
            "rma_not_found",
        });
    }

    if (
      result.error ===
      "pending_review"
    ) {
      return res
        .status(409)
        .json({
          error:
            "pending_review",

          message:
            "This return is still awaiting manual review.",
        });
    }

    return res.json({
      rmaId:
        result.record.rmaId,

      status:
        result.record.status,

      pickup:
        result.record.pickup,
    });
  }
);

/* ========================================================================== */
/* GET /returns/:rmaId/refund                                                 */
/* ========================================================================== */

router.get(
  "/returns/:rmaId/refund",
  (req, res) => {
    const phone =
      req.query.phone;

    if (!phone) {
      return res
        .status(400)
        .json({
          error:
            "phone is required",
        });
    }

    const result =
      getRefundStatus(
        req.params.rmaId,
        phone
      );

    if (
      !result ||
      result.error ===
        "not_owner"
    ) {
      return res
        .status(404)
        .json({
          error:
            "rma_not_found",
        });
    }

    return res.json(result);
  }
);

/* ========================================================================== */
/* GET /returns/:rmaId                                                        */
/* Debug/read endpoint                                                        */
/* ========================================================================== */

router.get(
  "/returns/:rmaId",
  (req, res) => {
    const phone =
      normalizePhone(
        req.query.phone
      );

    if (!phone) {
      return res
        .status(400)
        .json({
          error:
            "phone is required",
        });
    }

    const record =
      RETURNS.get(
        req.params.rmaId
      );

    if (
      !record ||
      normalizePhone(
        record.phone
      ) !== phone
    ) {
      return res
        .status(404)
        .json({
          error:
            "rma_not_found",
        });
    }

    return res.json({
      return:
        record,
    });
  }
);

/* ========================================================================== */
/* POST /flow/session                                                         */
/* ========================================================================== */

/*
 * Call this before sending the WhatsApp Flow.
 *
 * Request:
 *
 * {
 *   "flowToken": "unique-token",
 *   "phone": "918299576621"
 * }
 *
 * Use the exact same value as flow_token in the
 * outgoing WhatsApp Flow message.
 */

router.post(
  "/flow/session",
  (req, res) => {
    const {
      flowToken,
      phone,
    } = req.body || {};

    const normalizedPhone =
      normalizePhone(phone);

    if (
      !flowToken ||
      !normalizedPhone
    ) {
      return res
        .status(400)
        .json({
          error:
            "flowToken and phone are required",
        });
    }

    const session =
      setSession(
        flowToken,
        {
          to:
            normalizedPhone,

          createdAt:
            Date.now(),
        }
      );

    return res
      .status(201)
      .json({
        flowToken,

        phone:
          session?.to ||
          normalizedPhone,

        status:
          "session_created",
      });
  }
);

/* ========================================================================== */
/* WhatsApp Flow endpoint                                                     */
/* POST /returns/flow                                                         */
/* ========================================================================== */

router.post(
  "/returns/flow",
  async (req, res) => {
    let aesKey;
    let iv;
    let decryptedData;

    try {
      const decrypted =
        decryptRequest(
          req.body
        );

      aesKey =
        decrypted.aesKey;

      iv =
        decrypted.iv;

      decryptedData =
        decrypted.data || {};

      const {
        action,
        screen,

        flow_token:
          flowToken,

        version,
      } = decryptedData;

      /*
       * Log only decrypted business data.
       *
       * Do not log the Express response object, AES key,
       * IV or raw encrypted fields.
       */

      console.log(
        "\n========================================"
      );

      console.log(
        "[return-flow] decrypted request"
      );

      console.log(
        JSON.stringify(
          {
            version:
              version || null,

            action:
              action || null,

            screen:
              screen || null,

            flowToken:
              flowToken || null,

            data:
              decryptedData.data ||
              {},
          },
          null,
          2
        )
      );

      console.log(
        "========================================\n"
      );

      /* -------------------------------------------------------------------- */
      /* Health check                                                         */
      /* -------------------------------------------------------------------- */

      if (
        String(
          action
        ).toLowerCase() ===
        "ping"
      ) {
        return sendEncryptedFlowResponse(
          res,

          {
            data: {
              status:
                "active",
            },
          },

          aesKey,
          iv
        );
      }

      /* -------------------------------------------------------------------- */
      /* Error acknowledgement                                                */
      /* -------------------------------------------------------------------- */

      if (
        String(
          action
        ).toLowerCase() ===
          "error" ||
        decryptedData.data
          ?.error_message ||
        decryptedData.data
          ?.error
      ) {
        console.error(
          "[return-flow] Meta Flow error:",
          decryptedData.data
        );

        return sendEncryptedFlowResponse(
          res,

          {
            data: {
              acknowledged:
                true,
            },
          },

          aesKey,
          iv
        );
      }

      /* -------------------------------------------------------------------- */
      /* Initial screen                                                       */
      /* -------------------------------------------------------------------- */

      if (
        String(
          action
        ).toUpperCase() ===
        "INIT"
      ) {
        return sendEncryptedFlowResponse(
          res,

          {
            screen:
              "RETURN",

            data: {},
          },

          aesKey,
          iv
        );
      }

      /* -------------------------------------------------------------------- */
      /* Ignore unknown actions                                               */
      /* -------------------------------------------------------------------- */

      if (
        action !==
        "data_exchange"
      ) {
        return sendEncryptedFlowResponse(
          res,

          {
            data: {
              acknowledged:
                true,
            },
          },

          aesKey,
          iv
        );
      }

      /* -------------------------------------------------------------------- */
      /* User submitted the Flow                                              */
      /* -------------------------------------------------------------------- */

      const rawFlowData =
        decryptedData.data ||
        {};

      const parsedSubmission =
        parseFlowSubmission(
          rawFlowData
        );

      const session =
        flowToken
          ? getSession(
              flowToken
            )
          : null;

      /*
       * Prefer the phone number stored when the Flow was sent.
       *
       * Use a submitted phone only as a fallback.
       */

      const phone =
        normalizePhone(
          session?.to ||
          parsedSubmission
            .submittedPhone
        );

      console.log(
        "\n========================================"
      );

      console.log(
        "[return-flow] readable user submission"
      );

      console.log(
        JSON.stringify(
          {
            phone,

            name:
              parsedSubmission.name,

            orderNumber:
              parsedSubmission
                .orderNumber,

            actiontype:
              parsedSubmission
                .actiontype,

            description:
              parsedSubmission
                .description,

            photos:
              normalizePhotos(
                parsedSubmission
                  .rawPhotos
              ),
          },
          null,
          2
        )
      );

      console.log(
        "========================================\n"
      );

      /* -------------------------------------------------------------------- */
      /* Validate phone/session                                               */
      /* -------------------------------------------------------------------- */

      if (!phone) {
        saveReadableFlowSubmission({
          flowToken,
          action,
          screen,
          phone: null,
          parsedSubmission,
          rawFlowData,
        });

        return sendEncryptedFlowResponse(
          res,

          {
            screen:
              screen ||
              "RETURN",

            data: {
              error_message:
                "Your WhatsApp number could not be identified. Please restart the return journey.",
            },
          },

          aesKey,
          iv
        );
      }

      /* -------------------------------------------------------------------- */
      /* Process return                                                       */
      /* -------------------------------------------------------------------- */

      const result =
        await processReturnRequest({
          phone,

          name:
            parsedSubmission.name,

          orderNumber:
            parsedSubmission
              .orderNumber,

          actiontype:
            parsedSubmission
              .actiontype,

          description:
            parsedSubmission
              .description,

          rawPhotos:
            parsedSubmission
              .rawPhotos,

          flowToken,

          source:
            "whatsapp_flow",
        });

      /* -------------------------------------------------------------------- */
      /* Handle errors                                                        */
      /* -------------------------------------------------------------------- */

      if (!result.ok) {
        saveReadableFlowSubmission({
          flowToken,
          action,
          screen,
          phone,
          parsedSubmission,
          rawFlowData,
        });

        const flowErrorMessages = {
          missing_required_fields:
            "Please complete the name, order number, action and issue description.",

          invalid_actiontype:
            "Please select either Return or Exchange.",

          photo_required:
            "Please attach at least one product photo.",

          order_not_found:
            "We could not find that order for your WhatsApp number.",

          order_has_no_items:
            "This order does not contain any returnable items.",

          item_ambiguous:
            "This order contains multiple items. Please contact support to select the item.",

          media_download_failed:
            "We could not download the uploaded photo. Please upload it again.",
        };

        return sendEncryptedFlowResponse(
          res,

          {
            screen:
              screen ||
              "RETURN",

            data: {
              error_message:
                flowErrorMessages[
                  result.error
                ] ||
                "Unable to create the return request. Please try again.",
            },
          },

          aesKey,
          iv
        );
      }

      const {
        record,
        item,
        savedFiles,
      } = result;

      /* -------------------------------------------------------------------- */
      /* Save readable submission                                             */
      /* -------------------------------------------------------------------- */

      const savedSubmission =
        saveReadableFlowSubmission({
          flowToken,
          action,
          screen,
          phone,
          parsedSubmission,
          rawFlowData,
          savedFiles,
          rma:
            record,
        });

      console.log(
        "[return-flow] RMA created:",
        {
          rmaId:
            record.rmaId,

          status:
            record.status,

          orderId:
            record.orderId,

          itemId:
            record.itemId,

          itemName:
            item.name,

          uploadedFiles:
            savedFiles.map(
              (file) =>
                file.relativePath
            ),

          submissionFile:
            path.relative(
              process.cwd(),
              savedSubmission.filePath
            ),
        }
      );

      /* -------------------------------------------------------------------- */
      /* Update Flow session                                                  */
      /* -------------------------------------------------------------------- */

      if (flowToken) {
        setSession(
          flowToken,
          {
            to:
              phone,

            rmaId:
              record.rmaId,

            orderId:
              record.orderId,

            itemId:
              record.itemId,

            itemName:
              item.name,

            actionType:
              record.actionType,

            status:
              record.status,

            uploadedFiles:
              savedFiles.map(
                (file) =>
                  file.relativePath
              ),

            returnCreated:
              true,

            returnCreatedAt:
              Date.now(),
          }
        );
      }

      /* -------------------------------------------------------------------- */
      /* Terminal success response                                            */
      /* -------------------------------------------------------------------- */

      /*
       * SUCCESS must be defined as a terminal screen
       * in the Flow JSON.
       *
       * extension_message_response.params is returned with
       * the Flow completion message.
       */

      return sendEncryptedFlowResponse(
        res,

        {
          screen:
            "SUCCESS",

          data: {
            extension_message_response:
              {
                params: {
                  flow_token:
                    flowToken ||
                    "",

                  rma_id:
                    record.rmaId,

                  status:
                    record.status,

                  action_type:
                    record.actionType,

                  order_id:
                    record.orderId,

                  item_id:
                    record.itemId,

                  item_name:
                    item.name,
                },
              },
          },
        },

        aesKey,
        iv
      );
    } catch (error) {
      console.error(
        "[return-flow] error:",
        error
      );

      /*
       * If RSA/AES decryption failed, encryption keys
       * are unavailable and a normal HTTP error is required.
       */

      if (!aesKey || !iv) {
        const isKeyMismatch =
          String(
            error.message
          )
            .toLowerCase()
            .includes(
              "oaep"
            );

        return res
          .status(
            isKeyMismatch
              ? 421
              : 500
          )
          .json({
            error:
              "flow_request_decryption_failed",

            detail:
              process.env
                .NODE_ENV ===
              "production"
                ? "Unable to decrypt Flow request"
                : error.message,
          });
      }

      /*
       * Once the request has been decrypted, return errors
       * as encrypted Flow responses.
       */

      try {
        return sendEncryptedFlowResponse(
          res,

          {
            screen:
              decryptedData?.screen ||
              "RETURN",

            data: {
              error_message:
                "Unable to process the return request. Please try again.",
            },
          },

          aesKey,
          iv
        );
      } catch (
        encryptionError
      ) {
        console.error(
          "[return-flow] response encryption failed:",
          encryptionError
        );

        return res
          .status(500)
          .json({
            error:
              "flow_response_encryption_failed",
          });
      }
    }
  }
);

/* ========================================================================== */
/* Export                                                                     */
/* ========================================================================== */

export default router;