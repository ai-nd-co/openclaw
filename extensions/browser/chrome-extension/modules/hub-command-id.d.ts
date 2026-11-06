export const HUB_COMMAND_COUNTER_MAX: number;
export function hubCommandId(sessionId: string, counter: number): string;
export function parseHubCommandCounter(sessionId: string, commandId: string): number;
