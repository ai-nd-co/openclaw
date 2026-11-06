const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export const HUB_COMMAND_COUNTER_MAX = 0xffffffffffff;

/** Session-bound UUID shape agreed with Hub authority; gaps are valid, replay is not. */
export function hubCommandId(sessionId, counter) {
  if (typeof sessionId !== "string" || !UUID_V4.test(sessionId) || !Number.isSafeInteger(counter) || counter < 1 || counter > HUB_COMMAND_COUNTER_MAX) {
    throw new Error("Invalid or exhausted Hub command counter");
  }
  return sessionId.slice(0, 24) + counter.toString(16).padStart(12, "0");
}
export function parseHubCommandCounter(sessionId, commandId) {
  if (typeof sessionId !== "string" || typeof commandId !== "string" || !UUID_V4.test(sessionId) ||
      !UUID_V4.test(commandId) || commandId.slice(0, 24) !== sessionId.slice(0, 24)) {
    throw new Error("Invalid Hub command identity");
  }
  const counter = Number.parseInt(commandId.slice(24), 16);
  if (counter === 0) throw new Error("Invalid Hub command counter");
  return counter;
}
