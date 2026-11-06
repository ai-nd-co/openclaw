import { HUB_NATIVE_FRAME_MAX_BYTES } from "./hub-wire-limits.js";
// Explicit development policy shared by the device and relay. Compatibility is
// proven per method; a source-code inventory never automatically expands access.
export const HUB_NATIVE_POLICY_VERSION = "hub-native-development-5";
const METHODS = new Set(["Page.enable", "Page.getFrameTree", "Page.getLayoutMetrics", "Page.bringToFront", "Runtime.enable"]);

const NATIVE_FIELDS = {
  "Browser.setPermission": ["permission", "setting", "origin"],
  "Browser.grantPermissions": ["permissions", "origin"],
  "Browser.resetPermissions": [],
  "Storage.getCookies": [],
  "Storage.clearCookies": [],
  "Storage.setCookies": ["cookies"],
  "Target.getTargetInfo": [],
  "Inspector.enable": [],
  "Accessibility.enable": [],
  "Accessibility.disable": [],
  "Accessibility.getFullAXTree": ["depth", "frameId"],
  "Accessibility.queryAXTree": ["nodeId", "backendNodeId", "objectId", "accessibleName", "role"],
  "Accessibility.getPartialAXTree": ["nodeId", "backendNodeId", "objectId", "fetchRelatives"],
  "DOM.performSearch": ["query", "includeUserAgentShadowDOM"],
  "DOM.getSearchResults": ["searchId", "fromIndex", "toIndex"],
  "DOM.discardSearchResults": ["searchId"],
  "DOM.pushNodesByBackendIdsToFrontend": ["backendNodeIds"],
  "Runtime.terminateExecution": [],
  "Debugger.enable": ["maxScriptsCacheSize"],
  "Debugger.disable": [],
  "Debugger.setSkipAllPauses": ["skip"],
  "Debugger.setPauseOnExceptions": ["state"],
  "Debugger.setAsyncCallStackDepth": ["maxDepth"],
  "Debugger.setBlackboxPatterns": ["patterns", "skipAnonymous"],
  "Debugger.getScriptSource": ["scriptId"],
  "Debugger.resume": ["terminateOnResume"],
  "Profiler.enable": [],
  "Profiler.disable": [],
  "Profiler.startPreciseCoverage": ["callCount", "detailed", "allowTriggeredUpdates"],
  "Profiler.takePreciseCoverage": [],
  "Profiler.stopPreciseCoverage": [],
  "DOMSnapshot.captureSnapshot": ["computedStyles", "includePaintOrder", "includeDOMRects", "includeBlendedBackgroundColors", "includeTextColorOpacities"],
  "CSS.getStyleSheetText": ["styleSheetId"],
  "HeapProfiler.collectGarbage": [],
  "Runtime.disable": [],
  "CSS.startRuleUsageTracking": [],
  "CSS.stopRuleUsageTracking": [],
  "Input.setInterceptDrags": ["enabled"],
  "Input.dispatchDragEvent": ["type", "x", "y", "data", "modifiers"],
  "Input.dispatchTouchEvent": ["type", "touchPoints", "modifiers", "timestamp"],
  "DOM.getFrameOwner": ["frameId"],
  "Page.navigateToHistoryEntry": ["entryId"],
  "Page.close": [],
  "Page.startScreencast": ["format", "quality", "maxWidth", "maxHeight", "everyNthFrame"],
  "Page.stopScreencast": [],
  "Page.screencastFrameAck": ["sessionId"],
  "Page.setFontFamilies": ["fontFamilies", "forScripts"],
  "Page.setBypassCSP": ["enabled"],
  "Network.loadNetworkResource": ["frameId", "url", "options"],
  "Log.enable": [],
  "Log.disable": [],
  "Runtime.runIfWaitingForDebugger": [],
  "Target.setAutoAttach": ["autoAttach", "waitForDebuggerOnStart", "flatten", "filter"],
  "Page.setLifecycleEventsEnabled": ["enabled"],
  "Page.addScriptToEvaluateOnNewDocument": ["source", "worldName", "includeCommandLineAPI", "runImmediately"],
  "Page.removeScriptToEvaluateOnNewDocument": ["identifier"],
  "Page.createIsolatedWorld": ["frameId", "worldName", "grantUniveralAccess"],
  "Runtime.addBinding": ["name", "executionContextId", "executionContextName"],
  "Runtime.removeBinding": ["name"],
  "Page.setInterceptFileChooserDialog": ["enabled", "cancel"],
  "Page.handleJavaScriptDialog": ["accept", "promptText"],
  "Page.printToPDF": ["landscape", "displayHeaderFooter", "printBackground", "scale", "paperWidth", "paperHeight", "marginTop", "marginBottom", "marginLeft", "marginRight", "pageRanges", "headerTemplate", "footerTemplate", "preferCSSPageSize", "transferMode", "generateTaggedPDF", "generateDocumentOutline"],
  "DOM.setFileInputFiles": ["files", "nodeId", "backendNodeId", "objectId"],
  "DOM.getContentQuads": ["nodeId", "backendNodeId", "objectId"],
  "DOM.getBoxModel": ["nodeId", "backendNodeId", "objectId"],
  "DOM.scrollIntoViewIfNeeded": ["nodeId", "backendNodeId", "objectId", "rect"],
  "DOM.getNodeForLocation": ["x", "y", "includeUserAgentShadowDOM", "ignorePointerEventsNone"],
  "DOM.setNodeName": ["nodeId", "name"],
  "DOM.setNodeValue": ["nodeId", "value"],
  "DOM.setAttributeValue": ["nodeId", "name", "value"],
  "DOM.removeAttribute": ["nodeId", "name"],
  "DOM.querySelector": ["nodeId", "selector"],
  "DOM.querySelectorAll": ["nodeId", "selector"],
  "DOM.getOuterHTML": ["nodeId", "backendNodeId", "objectId", "includeShadowDOM"],
  "DOM.requestNode": ["objectId"],
  "DOM.focus": ["nodeId", "backendNodeId", "objectId"],
  "CSS.getComputedStyleForNode": ["nodeId"],
  "Network.enable": ["maxTotalBufferSize", "maxResourceBufferSize", "maxPostDataSize", "reportDirectSocketTraffic", "enableDurableMessages"],
  "Network.disable": [],
  "Network.setExtraHTTPHeaders": ["headers"],
  "Network.setCacheDisabled": ["cacheDisabled"],
  "Network.setBypassServiceWorker": ["bypass"],
  "Network.emulateNetworkConditions": ["offline", "latency", "downloadThroughput", "uploadThroughput", "connectionType", "packetLoss", "packetQueueLength", "packetReordering"],
  "Network.getResponseBody": ["requestId"],
  "Network.getRequestPostData": ["requestId"],
  "Fetch.enable": ["patterns", "handleAuthRequests"],
  "Fetch.disable": [],
  "Fetch.continueRequest": ["requestId", "url", "method", "postData", "headers", "interceptResponse"],
  "Fetch.continueResponse": ["requestId", "responseCode", "responsePhrase", "responseHeaders", "binaryResponseHeaders"],
  "Fetch.fulfillRequest": ["requestId", "responseCode", "responseHeaders", "binaryResponseHeaders", "body", "responsePhrase"],
  "Fetch.failRequest": ["requestId", "errorReason"],
  "Fetch.continueWithAuth": ["requestId", "authChallengeResponse"],
  "Fetch.getResponseBody": ["requestId"],
  "Fetch.takeResponseBodyAsStream": ["requestId"],
  "Emulation.setFocusEmulationEnabled": ["enabled"],
  "Emulation.setDeviceMetricsOverride": ["width", "height", "deviceScaleFactor", "mobile", "scale", "screenWidth", "screenHeight", "positionX", "positionY", "dontSetVisibleSize", "screenOrientation", "viewport", "displayFeature", "devicePosture"],
  "Emulation.clearDeviceMetricsOverride": [],
  "Emulation.setTouchEmulationEnabled": ["enabled", "maxTouchPoints"],
  "Emulation.setEmulatedMedia": ["media", "features"],
  "Emulation.setUserAgentOverride": ["userAgent", "acceptLanguage", "platform", "userAgentMetadata"],
  "Emulation.setLocaleOverride": ["locale"],
  "Emulation.setTimezoneOverride": ["timezoneId"],
  "Emulation.setGeolocationOverride": ["latitude", "longitude", "accuracy", "altitude", "altitudeAccuracy", "heading", "speed"],
  "Emulation.clearGeolocationOverride": [],
  "Emulation.setDefaultBackgroundColorOverride": ["color"],
  "Emulation.setScriptExecutionDisabled": ["value"],
  "IO.read": ["handle", "offset", "size"],
  "IO.close": ["handle"],
};

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value, required, optional = []) => record(value) && required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const finite = (value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000_000;
const boundedText = (value, max = 1024) => typeof value === "string" && value.length <= max;
const optional = (params, key, check) => params[key] === undefined || check(params[key]);
const boolean = (value) => typeof value === "boolean";

// JSON wire data is bounded once at admission, including by-value call arguments.
const boundedJson = (value, depth = 0) => {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= HUB_NATIVE_FRAME_MAX_BYTES;
  if (Array.isArray(value)) return value.length <= 10000 && value.every((item) => boundedJson(item, depth + 1));
  return record(value) && Object.keys(value).length <= 10000 && Object.entries(value).every(([key, item]) => key.length <= 1024 && boundedJson(item, depth + 1));
};
export function isHubNativeFrameWithinByteLimit(frame, maximumBytes = HUB_NATIVE_FRAME_MAX_BYTES) {
  try { return new TextEncoder().encode(JSON.stringify(frame)).byteLength <= maximumBytes; } catch { return false; }
}
export function isHubNativeCommand(frame, { assignedSeq = false } = {}) {
  if (!boundedJson(frame) || !isHubNativeFrameWithinByteLimit(frame)) return false;
  if (!record(frame) || (assignedSeq && (!Number.isSafeInteger(frame.seq) || frame.seq < 1))) return false;
  const seq = assignedSeq ? ["seq"] : [];
  if (frame.type === "createTab") {
    return fields(frame, ["type", "url", ...seq], ["background", "focus"]) && typeof frame.url === "string" && frame.url.length <= 16_384 &&
      (frame.background === undefined || typeof frame.background === "boolean") &&
      (frame.focus === undefined || typeof frame.focus === "boolean");
  }
  if (!Number.isSafeInteger(frame.tabId) || frame.tabId < 0) return false;
  if (["attach", "detach", "activateTab", "closeTab"].includes(frame.type)) {
    return fields(frame, ["type", "tabId", ...seq]);
  }
  if (!fields(frame, ["type", "tabId", "method", ...seq], ["params", "sessionId"]) || frame.type !== "cdp" ||
      (frame.params !== undefined && !record(frame.params)) ||
      (frame.sessionId !== undefined && (typeof frame.sessionId !== "string" || frame.sessionId.length > 256))) return false;
  const params = frame.params ?? {};
  if (frame.method === "Input.dispatchMouseEvent") return fields(params, ["type", "x", "y"],
    ["button", "buttons", "clickCount", "modifiers", "deltaX", "deltaY", "pointerType", "force"]) &&
    ["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"].includes(params.type) && finite(params.x) && finite(params.y) &&
    optional(params, "button", (v) => ["none", "left", "middle", "right", "back", "forward"].includes(v)) &&
    ["buttons", "clickCount", "modifiers"].every((key) => optional(params, key, (v) => Number.isInteger(v) && v >= 0 && v <= 31)) &&
    ["deltaX", "deltaY"].every((key) => optional(params, key, finite)) &&
    optional(params, "pointerType", (v) => ["mouse", "pen"].includes(v)) &&
    optional(params, "force", (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1);
  if (frame.method === "Input.dispatchKeyEvent") return fields(params, ["type"],
    ["key", "code", "text", "unmodifiedText", "windowsVirtualKeyCode", "nativeVirtualKeyCode", "modifiers", "autoRepeat", "isKeypad", "isSystemKey", "location", "commands"]) &&
    ["keyDown", "keyUp", "rawKeyDown", "char"].includes(params.type) &&
    optional(params, "commands", (v) => Array.isArray(v) && v.length <= 100 && v.every((command) => boundedText(command))) &&
    ["key", "code", "text", "unmodifiedText"].every((key) => optional(params, key, boundedText)) &&
    ["windowsVirtualKeyCode", "nativeVirtualKeyCode", "modifiers", "location"].every((key) => optional(params, key, (v) => Number.isInteger(v) && v >= 0 && v <= 65535)) &&
    ["autoRepeat", "isKeypad", "isSystemKey"].every((key) => optional(params, key, boolean));
  if (frame.method === "Input.insertText") return fields(params, ["text"]) && boundedText(params.text, HUB_NATIVE_FRAME_MAX_BYTES);
  if (frame.method === "Page.navigate") return fields(params, ["url"], ["referrer", "transitionType", "frameId", "referrerPolicy"]) &&
    boundedText(params.url, 16384) && ["referrer", "transitionType", "frameId", "referrerPolicy"].every((key) => optional(params, key, boundedText));
  if (frame.method === "Page.reload") return fields(params, [], ["ignoreCache"]) && optional(params, "ignoreCache", boolean);
  if (frame.method === "Page.captureScreenshot") return fields(params, [], ["format", "quality", "clip", "fromSurface", "captureBeyondViewport", "optimizeForSpeed"]) &&
    optional(params, "format", (v) => ["jpeg", "png", "webp"].includes(v)) &&
    optional(params, "quality", (v) => Number.isInteger(v) && v >= 0 && v <= 100) &&
    ["fromSurface", "captureBeyondViewport", "optimizeForSpeed"].every((key) => optional(params, key, boolean)) &&
    optional(params, "clip", (v) => fields(v, ["x", "y", "width", "height", "scale"]) &&
      ["x", "y", "width", "height", "scale"].every((key) => finite(v[key])) && v.width > 0 && v.height > 0 && v.scale > 0 && v.scale <= 4);
  // Validate the original CDP shape; Chrome and the original OpenClaw native
  // session own execution. Hub adds authentication, not a website-origin policy.
  if (frame.method === "Runtime.evaluate") return fields(params, ["expression"],
    ["contextId", "uniqueContextId", "returnByValue", "awaitPromise", "timeout", "silent", "objectGroup", "includeCommandLineAPI", "userGesture", "generatePreview", "replMode", "allowUnsafeEvalBlockedByCSP", "disableBreaks", "throwOnSideEffect", "serializationOptions"]) &&
    typeof params.expression === "string" && params.expression.length <= HUB_NATIVE_FRAME_MAX_BYTES &&
    optional(params, "objectGroup", boundedText) && optional(params, "serializationOptions", record) &&
    ["includeCommandLineAPI", "userGesture", "generatePreview", "replMode", "allowUnsafeEvalBlockedByCSP", "disableBreaks", "throwOnSideEffect"].every((key) => optional(params, key, boolean)) &&
    (params.contextId === undefined || (Number.isSafeInteger(params.contextId) && params.contextId > 0)) &&
    (params.uniqueContextId === undefined || (typeof params.uniqueContextId === "string" && params.uniqueContextId.length <= 256)) &&
    !(params.contextId !== undefined && params.uniqueContextId !== undefined) &&
    optional(params, "returnByValue", boolean) &&
    (params.awaitPromise === undefined || typeof params.awaitPromise === "boolean") &&
    (params.silent === undefined || typeof params.silent === "boolean") &&
    (params.timeout === undefined || (Number.isSafeInteger(params.timeout) && params.timeout > 0 && params.timeout <= 30_000));
  if (["DOM.enable", "DOM.disable", "CSS.enable", "CSS.disable", "Page.getNavigationHistory", "Page.stopLoading"].includes(frame.method)) return fields(params, []);
  if (frame.method === "DOM.getDocument") return fields(params, [], ["depth", "pierce"]) &&
    optional(params, "depth", (v) => Number.isInteger(v) && v >= -1 && v <= 1000) && optional(params, "pierce", boolean);
  if (frame.method === "DOM.resolveNode") return fields(params, [], ["nodeId", "backendNodeId", "objectGroup", "executionContextId"]) &&
    ["nodeId", "backendNodeId", "executionContextId"].every((key) => optional(params, key, (v) => Number.isSafeInteger(v) && v > 0)) && optional(params, "objectGroup", boundedText) &&
    (params.nodeId !== undefined || params.backendNodeId !== undefined);
  if (frame.method === "DOM.describeNode") return fields(params, [], ["nodeId", "backendNodeId", "objectId", "depth", "pierce"]) &&
    ["nodeId", "backendNodeId"].every((key) => optional(params, key, (v) => Number.isSafeInteger(v) && v > 0)) && optional(params, "objectId", boundedText) &&
    optional(params, "depth", (v) => Number.isInteger(v) && v >= -1 && v <= 1000) && optional(params, "pierce", boolean);
  if (frame.method === "Runtime.callFunctionOn") return fields(params, ["functionDeclaration"],
    ["objectId", "executionContextId", "uniqueContextId", "arguments", "silent", "returnByValue", "generatePreview", "userGesture", "awaitPromise", "objectGroup", "throwOnSideEffect", "serializationOptions"]) &&
    boundedText(params.functionDeclaration, HUB_NATIVE_FRAME_MAX_BYTES) &&
    optional(params, "objectId", boundedText) && optional(params, "executionContextId", (v) => Number.isSafeInteger(v) && v > 0) &&
    optional(params, "uniqueContextId", boundedText) && optional(params, "objectGroup", boundedText) && optional(params, "serializationOptions", record) &&
    ["silent", "returnByValue", "generatePreview", "userGesture", "awaitPromise", "throwOnSideEffect"].every((key) => optional(params, key, boolean)) &&
    optional(params, "arguments", (args) => Array.isArray(args) && args.length <= 10000 && args.every((arg) =>
      fields(arg, [], ["value", "unserializableValue", "objectId"]) && optional(arg, "objectId", boundedText) && optional(arg, "unserializableValue", boundedText)));
  if (frame.method === "Runtime.awaitPromise") return fields(params, ["promiseObjectId"], ["returnByValue", "generatePreview"]) &&
    boundedText(params.promiseObjectId) && ["returnByValue", "generatePreview"].every((key) => optional(params, key, boolean));
  if (["Runtime.releaseObject", "Runtime.getProperties"].includes(frame.method)) return fields(params, ["objectId"],
    frame.method === "Runtime.getProperties" ? ["ownProperties", "accessorPropertiesOnly", "generatePreview", "nonIndexedPropertiesOnly"] : []) &&
    boundedText(params.objectId) && Object.keys(params).filter((key) => key !== "objectId").every((key) => boolean(params[key]));
  if (frame.method === "Runtime.releaseObjectGroup") return fields(params, ["objectGroup"]) && boundedText(params.objectGroup);
  if (frame.method === "Target.setAutoAttach") return fields(params, ["autoAttach", "waitForDebuggerOnStart", "flatten"], ["filter"]) &&
    boolean(params.autoAttach) && boolean(params.waitForDebuggerOnStart) && params.flatten === true &&
    optional(params, "filter", (value) => Array.isArray(value) && value.length <= 256 && value.every((entry) =>
      fields(entry, [], ["type", "exclude"]) && optional(entry, "type", boundedText) && optional(entry, "exclude", boolean)));
  if (Object.hasOwn(NATIVE_FIELDS, frame.method)) {
    if (!fields(params, [], NATIVE_FIELDS[frame.method])) return false;
    if (frame.method === "Page.addScriptToEvaluateOnNewDocument" && !boundedText(params.source, HUB_NATIVE_FRAME_MAX_BYTES)) return false;
    if (frame.method === "Page.createIsolatedWorld" && !boundedText(params.frameId)) return false;
    if (frame.method === "Storage.setCookies" && (!Array.isArray(params.cookies) || params.cookies.length>10000)) return false;
    if (frame.method === "DOM.performSearch" && !boundedText(params.query, HUB_NATIVE_FRAME_MAX_BYTES)) return false;
    if (["DOM.getSearchResults","DOM.discardSearchResults"].includes(frame.method) && !boundedText(params.searchId)) return false;
    if (frame.method === "DOM.getSearchResults" && ![params.fromIndex,params.toIndex].every((value)=>Number.isSafeInteger(value)&&value>=0)) return false;
    if (frame.method === "DOM.pushNodesByBackendIdsToFrontend" && (!Array.isArray(params.backendNodeIds) || !params.backendNodeIds.every((id)=>Number.isSafeInteger(id)&&id>0))) return false;
    if (frame.method === "Debugger.getScriptSource" && !boundedText(params.scriptId)) return false;
    if (frame.method === "CSS.getStyleSheetText" && !boundedText(params.styleSheetId)) return false;
    if (frame.method === "Runtime.addBinding" && !boundedText(params.name)) return false;
    if (frame.method.startsWith("Fetch.") && !["Fetch.enable", "Fetch.disable"].includes(frame.method) && !boundedText(params.requestId)) return false;
    if (frame.method === "Network.setExtraHTTPHeaders" && (!record(params.headers) || !Object.values(params.headers).every((value) => boundedText(value, 65536)))) return false;
    return true;
  }
  return METHODS.has(frame.method) && fields(params, []);
}
