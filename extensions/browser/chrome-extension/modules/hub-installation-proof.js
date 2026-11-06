// Hub mode is separate from the existing local relay's HMAC authentication.
// These functions handle installation identity only, never grants or admission.
import { hasExactKeys } from "./strict-json.js";

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function nonceBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error("invalid Hub challenge nonce");
  }
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "="),
    (char) => char.charCodeAt(0));
  if (bytes.length !== 32 || encode(bytes) !== value) {
    throw new Error("noncanonical Hub challenge nonce");
  }
  return bytes;
}

export function canonicalHubOrigin(value) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) {
    throw new Error("Hub origin must be HTTPS, or loopback HTTP for development");
  }
  return url.origin;
}

/** Private CryptoKey is nonextractable; IndexedDB can persist its structured clone. */
export async function createHubInstallationIdentity(cryptoApi = globalThis.crypto) {
  const keyPair = await cryptoApi.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"],
  );
  const spki = new Uint8Array(await cryptoApi.subtle.exportKey("spki", keyPair.publicKey));
  const fingerprintBytes = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", spki));
  return {
    privateKey: keyPair.privateKey,
    publicKeySpki: encode(spki),
    fingerprint: Array.from(fingerprintBytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

/** Caller creates one signer per challenge exchange, tied to its current socket/request. */
export function createHubInstallationProof({
  kind, origin, browserId, privateKey, cryptoApi = globalThis.crypto, now = Date.now,
}) {
  if (!["device", "relay"].includes(kind)) {
    throw new Error("unknown Hub proof audience");
  }
  const audienceOrigin = canonicalHubOrigin(origin);
  if (typeof browserId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(browserId)) {
    throw new Error("invalid Hub browser identifier");
  }
  if (privateKey?.type !== "private" || privateKey.extractable ||
      privateKey.algorithm?.name !== "ECDSA" || privateKey.algorithm.namedCurve !== "P-256" ||
      !privateKey.usages.includes("sign")) {
    throw new Error("Hub installation requires a nonextractable P-256 signing key");
  }
  let used = false;
  return async (challenge) => {
    if (used) {
      throw new Error("Hub challenge exchange already consumed");
    }
    used = true;
    const expected = kind === "device" ? ["nonce", "expiresAt"] : ["v", "type", "nonce", "expiresAt"];
    if (!hasExactKeys(challenge, expected) ||
        (kind === "relay" && (challenge.v !== 1 || challenge.type !== "challenge"))) {
      throw new Error("invalid Hub challenge shape");
    }
    nonceBytes(challenge.nonce);
    const currentTime = now();
    if (!Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= currentTime ||
        challenge.expiresAt > currentTime + 30_000) {
      throw new Error("Hub challenge expired or exceeds its lifetime");
    }
    const bytes = new TextEncoder().encode(
      `agent-hub.${kind}.v1\n${audienceOrigin}\n${browserId}\n${challenge.nonce}`,
    );
    const signature = new Uint8Array(await cryptoApi.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, privateKey, bytes,
    ));
    if (now() >= challenge.expiresAt) {
      throw new Error("Hub challenge expired while signing");
    }
    if (signature.length !== 64) {
      throw new Error("Hub proof requires IEEE-P1363 ECDSA signatures");
    }
    return encode(signature);
  };
}
