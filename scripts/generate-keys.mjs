// Run once: node scripts/generate-keys.mjs
// Generates RS256 key pair into ./keys/
import { generateKeyPairSync } from "crypto";
import { writeFileSync, mkdirSync } from "fs";

mkdirSync("./keys", { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

writeFileSync("./keys/private.pem", privateKey, { mode: 0o600 });
writeFileSync("./keys/public.pem", publicKey);

console.log("RS256 key pair generated in ./keys/");
console.log("Add ./keys/ to .gitignore — never commit private keys.");
