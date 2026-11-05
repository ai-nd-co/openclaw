FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY extensions/browser/relay-container/package.json extensions/browser/relay-container/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY extensions/browser/relay-container/build.mjs ./build.mjs
COPY extensions/browser/src/browser/hub-relay/ /source/extensions/browser/src/browser/hub-relay/
COPY extensions/browser/src/browser/extension-relay/relay-protocol.ts /source/extensions/browser/src/browser/extension-relay/
COPY extensions/browser/chrome-extension/modules/ /source/extensions/browser/chrome-extension/modules/
COPY src/plugin-sdk/websocket-runtime.ts /source/src/plugin-sdk/
COPY packages/gateway-client/src/websocket.ts /source/packages/gateway-client/src/
COPY src/shared/one-time-ticket-store.ts src/shared/websocket-upgrade-reject.ts /source/src/shared/
COPY src/gateway/websocket-keepalive.ts /source/src/gateway/
RUN node build.mjs /source /build/dist && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production HUB_RELAY_HOST=0.0.0.0 HUB_RELAY_PORT=8080
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/ai-nd-co/openclaw"
COPY --chown=node:node LICENSE ./LICENSE
COPY --from=build --chown=node:node /build/package.json /build/package-lock.json ./
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/dist/relay.mjs ./relay.mjs
USER node
EXPOSE 8080
CMD ["node", "relay.mjs"]
