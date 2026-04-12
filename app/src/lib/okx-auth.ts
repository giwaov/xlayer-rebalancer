import crypto from "crypto";

/**
 * Generate OKX Developer Portal API headers (HMAC-SHA256 signed).
 * Matches the official okx/dex-api-library format.
 *
 * @param method - HTTP method (GET, POST)
 * @param requestPath - API path without query string, e.g. "/api/v5/dex/aggregator/quote"
 * @param queryString - Query string including "?", e.g. "?chainId=196&..."
 */
export function getOkxHeaders(method: string, requestPath: string, queryString = "") {
  const apiKey = process.env.OKX_API_KEY || "";
  const secretKey = process.env.OKX_SECRET_KEY || "";
  const passphrase = process.env.OKX_PASSPHRASE || "";
  const projectId = process.env.OKX_PROJECT_ID || "";

  const timestamp = new Date().toISOString();
  const stringToSign = timestamp + method + requestPath + queryString;
  const sign = crypto
    .createHmac("sha256", secretKey)
    .update(stringToSign)
    .digest("base64");

  return {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": passphrase,
    "OK-ACCESS-PROJECT": projectId,
  };
}
