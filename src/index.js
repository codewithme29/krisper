// // Import Express.js
// import 'dotenv/config';
// import express from 'express';

// // import webhookRouter from './webhook.js';
// // Create an Express app
// const app = express();

// // Middleware to parse JSON bodies
// app.use(express.json());

// // Set port and verify_token
// const port = process.env.PORT;
// const verifyToken = process.env.VERIFY_TOKEN;

// // Route for GET requests
// app.get('/', (req, res) => {
//   const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;
//     console.log("hey",token,verifyToken)
//   if (token === verifyToken) {
//     console.log('WEBHOOK VERIFIED');
//     res.status(200).send(challenge);
//   } else {
//     console.log("Webhook not verified",token,verifyToken)
//     res.status(403).end();
//   }
// });
// app.get('/health', (_req, res) => {
//     res.json({ status: 'ok', uptime: process.uptime() });
// });

// // app.use('/webhook', webhookRouter);

// // Route for POST requests
// app.post('/', (req, res) => {
//   const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
//   console.log(`\n\nWebhook received ${timestamp}\n`);
//   console.log(JSON.stringify(req.body, null, 2));
//   res.status(200).end();
// });

// // Start the server
// app.listen(port, () => {
//   console.log(`\nListening on port ${port}\n`);
//   console.log(`\nHealthCheck endpoint: GET /health \n`);
//   console.log(`\nListening on port ${port}\n`);
// });

import "dotenv/config";
import express from "express";
import products from "./products.json" with { type: "json" };
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WHATSAPP_TOKEN;

// Health Check
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
  });
});

// Home
app.get("/", (req, res) => {
  res.send("Webhook server is running.");
});
app.get("/products", (req, res) => {
  const { id, search } = req.query;

  // Search by ID
  if (id) {
    const product = products.find((p) => p.id === Number(id));

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    return res.json(product);
  }

  // Search by keyword
  if (search) {
    const keyword = search.toLowerCase().trim();

    const results = products.filter((p) =>
      p.title.toLowerCase().includes(keyword) ||
      p.description.toLowerCase().includes(keyword) ||
      p.category.toLowerCase().includes(keyword)
    );

    return res.json({
      total: results.length,
      products: results,
    });
  }

  // Return all products
  return res.json(products);
});

app.post("/checkout", (req, res) => {
  const {
    fullName,
    phoneNumber,
    addressLine1,
    city,
    state,
    postalCode,
    country,
    productName,
    price,
  } = req.body;

  // Basic validation
  const requiredFields = [
    "fullName",
    "phoneNumber",
    "addressLine1",
    "city",
    "state",
    "postalCode",
    "country",
    "productName",
    "price",
  ];

  const missingFields = requiredFields.filter(
    (field) => !req.body[field]
  );

  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields.",
      missingFields,
    });
  }

  // Random delivery between 1 and 7 days
  const randomDays = Math.floor(Math.random() * 7) + 1;

  const arrivalDate = new Date();
  arrivalDate.setDate(arrivalDate.getDate() + randomDays);

  res.status(200).json({
    success: true,
    message: "Order placed successfully.",
    order: {
      customer: fullName,
      productName,
      price,
    },
    estimatedArrivalDate: arrivalDate.toISOString().split("T")[0], // YYYY-MM-DD
  });
});

// Meta Webhook Verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log({
    mode,
    token,
    VERIFY_TOKEN,
  });

  if (mode === "subscribe" && token === WA_TOKEN) {
    console.log("✅ WEBHOOK VERIFIED");
    return res.status(200).send(challenge);
  }

  console.log("❌ WEBHOOK VERIFICATION FAILED");
  return res.sendStatus(403);
});

// Meta Webhook Events
app.post("/webhook", (req, res) => {
  console.log("📩 Webhook Received");

  console.dir(req.body, { depth: null });

  // Acknowledge receipt immediately
  res.sendStatus(200);
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Health : http://localhost:${PORT}/health`);
  console.log(`Webhook: http://localhost:${PORT}/webhook`);
});