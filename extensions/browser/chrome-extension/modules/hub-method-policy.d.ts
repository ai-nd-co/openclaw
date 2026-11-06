export function isHubNativeCommand(frame: unknown, options?: { assignedSeq?: boolean }): boolean;
export const HUB_NATIVE_POLICY_VERSION: string;

export function isHubNativeFrameWithinByteLimit(frame: unknown, maximumBytes?: number): boolean;
