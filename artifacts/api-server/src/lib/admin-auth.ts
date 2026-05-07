import { createHmac } from "crypto";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function getSecret(): string {
  return createHmac("sha256", "lifesim-v1").update(ADMIN_PASSWORD).digest("hex");
}

export function verifyPassword(password: string): boolean {
  return password === ADMIN_PASSWORD;
}

export function createAdminToken(): string {
  const expires = Date.now() + TOKEN_TTL_MS;
  const payload = String(expires);
  const sig = createHmac("sha256", getSecret()).update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

export function verifyAdminToken(token: string): boolean {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep === -1) return false;
    const expires = decoded.slice(0, sep);
    const sig = decoded.slice(sep + 1);
    if (Date.now() > parseInt(expires, 10)) return false;
    const expected = createHmac("sha256", getSecret()).update(expires).digest("hex");
    return sig === expected;
  } catch {
    return false;
  }
}
