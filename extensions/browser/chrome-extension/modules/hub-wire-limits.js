// Match the original extension relay's native frame capability. These bounds
// apply only to the direct browser wire; Hub metadata remains independently small.
export const HUB_NATIVE_FRAME_MAX_BYTES = 64 * 1024 * 1024;
export const HUB_WIRE_BUFFER_MAX_BYTES = 128 * 1024 * 1024;
