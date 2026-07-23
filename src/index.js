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
  res.status(200).json(products);
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