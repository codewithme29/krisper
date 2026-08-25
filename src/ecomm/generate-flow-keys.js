// generate-flow-keys.js — run once: node generate-flow-keys.js
import crypto from "crypto";
import fs from "fs";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

fs.writeFileSync("private.pem", privateKey);
fs.writeFileSync("public.pem", publicKey);
console.log(
fs.readFileSync("./private.pem", "utf8")
.split("\n")[0]
);
console.log("Wrote private.pem and public.pem to the current folder.\n");
console.log("=== public.pem (upload this to Meta) ===\n");
console.log(publicKey);
console.log("=== private.pem (paste this into WHATSAPP_FLOW_PRIVATE_KEY) ===\n");
console.log(privateKey);