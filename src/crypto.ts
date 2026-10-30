import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Tokens are stored under their hash, so a leaked store does not hand out working tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** AES-256-GCM. Output: base64url(iv | tag | ciphertext). Used for the HubID JWTs we hold for users. */
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function decrypt(key: Buffer, sealed: string): string {
  const raw = Buffer.from(sealed, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/** Reads `iat`/`exp` from a JWT we received directly from HubID. Not a signature check. */
export function jwtClaims(jwt: string): { iat?: number; exp?: number; sub?: string | number } {
  const payload = jwt.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}
