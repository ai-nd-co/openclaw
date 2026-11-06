/** Fixed diagnostic categories only: never serialize errors, URLs, headers or tokens. */
export type HubRelayDiagnostic = {
  stage: "http" | "hub_socket" | "hub_authority";
  event: "listening" | "open" | "error" | "upgrade_rejected" | "closed" | "lost";
  code?: string;
  status?: number;
  closeCode?: number;
  protocolMatches?: boolean;
};

const SAFE_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH",
  "ETIMEDOUT", "EADDRINUSE", "EACCES", "EPERM", "EROFS", "ERR_INVALID_URL",
  "ERR_INVALID_PROTOCOL", "ERR_ACCESS_DENIED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function safeRelayErrorCode(error: unknown): string {
  if (error instanceof Error) {
    if ("code" in error && typeof error.code === "string" && SAFE_CODES.has(error.code)) return error.code;
    if (error.cause instanceof Error && "code" in error.cause &&
        typeof error.cause.code === "string" && SAFE_CODES.has(error.cause.code)) return error.cause.code;
  }
  return "UNKNOWN";
}
