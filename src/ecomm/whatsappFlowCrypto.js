import crypto from "crypto";
import fs from "fs";

const config = {
  flowPrivateKey:
    process.env.WHATSAPP_FLOW_PRIVATE_KEY,

  flowPrivateKeyPath:
    process.env.WHATSAPP_FLOW_PRIVATE_KEY_PATH,

  flowPassphrase:
    process.env.WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE,
};

let _privateKey = null;
let privateKey = null;
/* ------------------------------------------------------------------ */
/* Load PEM                                                           */
/* ------------------------------------------------------------------ */

function loadPrivateKeyPem() {
  if (
    config.flowPrivateKeyPath &&
    fs.existsSync(
      config.flowPrivateKeyPath
    )
  ) {
    return fs.readFileSync(
      config.flowPrivateKeyPath,
      "utf8"
    );
  }

  let pem =
    config.flowPrivateKey || "";

  /*
   * Handle:
   *
   * -----BEGIN...
   * xxxx
   * -----END...
   *
   * stored in .env as "\n"
   */

  if (pem.includes("\\n")) {
    pem = pem.replace(
      /\\n/g,
      "\n"
    );
  }

  /*
   * Handle broken single-line PEMs
   */

  if (
    pem.includes("BEGIN") &&
    !pem.includes("\n")
  ) {
    pem = pem
      .replace(
        /-----BEGIN ([A-Z ]+)-----/,
        "-----BEGIN $1-----\n"
      )
      .replace(
        /-----END ([A-Z ]+)-----/,
        "\n-----END $1-----"
      )
      .replace(
        /(-----BEGIN [A-Z ]+-----\n)([\s\S]+?)(\n-----END)/,
        (_, start, body, end) =>
          start +
          body.replace(
            /\s+/g,
            "\n"
          ) +
          end
      );
  }

  return pem.trim();
}




function getPrivateKey() {
  if (privateKey) {
    return privateKey;
  }

  const pem = fs.readFileSync(
    process.env.WHATSAPP_FLOW_PRIVATE_KEY_PATH,
    "utf8"
  );
  
  console.log(
    "[FLOW] Loaded private key"
  );

  privateKey =
    crypto.createPrivateKey(pem);

  return privateKey;
}

/* ------------------------------------------------------------------ */
/* Decrypt Request                                                    */
/* ------------------------------------------------------------------ */

export function decryptRequest(
  body
) {
  const {
    encrypted_flow_data,
    encrypted_aes_key,
    initial_vector,
  } = body;

  if (
    !encrypted_flow_data ||
    !encrypted_aes_key ||
    !initial_vector
  ) {
    throw new Error(
      "Encrypted fields missing"
    );
  }

  const aesKey =
    crypto.privateDecrypt(
      {
        key: getPrivateKey(),

        padding:
          crypto.constants
            .RSA_PKCS1_OAEP_PADDING,

        oaepHash: "sha256",
      },
      Buffer.from(
        encrypted_aes_key,
        "base64"
      )
    );

  const iv = Buffer.from(
    initial_vector,
    "base64"
  );

  const flowData =
    Buffer.from(
      encrypted_flow_data,
      "base64"
    );

  const authTag =
    flowData.subarray(
      flowData.length - 16
    );

  const cipherText =
    flowData.subarray(
      0,
      flowData.length - 16
    );

  const algo =
    aesKey.length === 32
      ? "aes-256-gcm"
      : "aes-128-gcm";

  const decipher =
    crypto.createDecipheriv(
      algo,
      aesKey,
      iv
    );

  decipher.setAuthTag(
    authTag
  );

  const decrypted =
    Buffer.concat([
      decipher.update(
        cipherText
      ),
      decipher.final(),
    ]);

  return {
    aesKey,
    iv,

    data: JSON.parse(
      decrypted.toString("utf8")
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Encrypt Response                                                   */
/* ------------------------------------------------------------------ */

export function encryptResponse(
  response,
  aesKey,
  iv
) {
  const flippedIv =
    Buffer.from(
      iv.map(
        (b) => ~b & 0xff
      )
    );

  const algo =
    aesKey.length === 32
      ? "aes-256-gcm"
      : "aes-128-gcm";

  const cipher =
    crypto.createCipheriv(
      algo,
      aesKey,
      flippedIv
    );

  const encrypted =
    Buffer.concat([
      cipher.update(
        JSON.stringify(
          response
        ),
        "utf8"
      ),
      cipher.final(),
      cipher.getAuthTag(),
    ]);

  return encrypted.toString(
    "base64"
  );
}