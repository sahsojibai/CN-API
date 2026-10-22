"use strict";
// Store API keys are encrypted at rest (AES-256-GCM). The master secret comes from
// CHATTRN_SECRET, or is generated once into data/.secret with mode 0600.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function loadSecretKey(dataDir) {
  let secret = process.env.CHATTRN_SECRET;
  if (!secret || secret.length < 16) {
    const file = path.join(dataDir, ".secret");
    if (fs.existsSync(file)) {
      secret = fs.readFileSync(file, "utf8").trim();
    } else {
      fs.mkdirSync(dataDir, { recursive: true });
      secret = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  return crypto.scryptSync(secret, "chattrn-store-keys", 32);
}

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

function decrypt(blob, key) {
  const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

module.exports = { loadSecretKey, encrypt, decrypt };
