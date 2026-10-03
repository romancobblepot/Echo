const ALG = "AES-GCM";
const IV_LENGTH = 12;

function getKey(): ArrayBuffer {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error("ENCRYPTION_SECRET is not set");
  const buf = Buffer.from(secret.padEnd(32, "0").slice(0, 32), "utf-8");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export async function encrypt(plaintext: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", getKey(), ALG, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: ALG, iv }, key, encoded);
  const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_LENGTH);
  return Buffer.from(combined).toString("base64");
}

export async function decrypt(encoded: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", getKey(), ALG, false, ["decrypt"]);
  const combined = new Uint8Array(Buffer.from(encoded, "base64"));
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt({ name: ALG, iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
