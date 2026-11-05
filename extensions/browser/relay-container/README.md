# Agent Hub browser relay image

This packages the existing OpenClaw-over-Hub relay. It starts no browser and has
no browser profile, vault, model or Redis dependency. Native payloads stay on the
relay; Hub receives authorization metadata. The image retains signed browser
installation proof, single-use tickets, live Hub authorization and Stop/revoke.
It adds no website-address or Hub-page filtering. Unauthenticated socket traffic
is capped before message reassembly; authorized native frames retain their64MiB
limit.

## Addresses and configuration

Use a separate public relay hostname for the simplest ingress configuration.
These exact paths must reach the relay, without adding a prefix:

- `/browser/hub/device`: browser-initiated WSS, subprotocol `agent-hub.browser.v1`.
- `/browser/hub/agent`: agent-initiated WSS, same subprotocol.
- `/healthz`: process liveness, GET200 with no credentials or browser metadata.
- `/readyz`: GET200 only with current Hub authority; otherwise503.

A shared Hub hostname also works if those two socket paths route to the relay
and `/api` routes to Hub. `/relay/...` is not the current client contract.
Terminate public HTTPS/WSS at the existing ingress with a valid certificate.
The extension obtains the relay URL from Hub tickets; no endpoint constant or
extension update is needed for a new public installation.

| Environment | Meaning |
| --- | --- |
| `HUB_ORIGIN` | Required canonical public HTTPS Hub origin; HTTP only for loopback development. |
| `HUB_CONNECT_ORIGIN` | Optional internal HTTP(S) Hub Service origin, default `HUB_ORIGIN`. Same `/api` paths; no credentials/path/query in the value. |
| `HUB_RELAY_ORIGIN` | Required canonical public HTTPS relay origin, matching the Hub relay registration. |
| `HUB_RELAY_TOKEN` | Required relay credential from operator registration; inject from a Kubernetes Secret, never an image/build argument. |
| `HUB_RELAY_HOST` | Defaults127.0.0.1; the image explicitly sets0.0.0.0 inside the container. |
| `HUB_RELAY_PORT` | Defaults8080. Port0 is available only for isolated test allocation. |

`HUB_CONNECT_ORIGIN` changes server transport only; public identities, tickets
and installation signatures retain their canonical public origins. It permits a
narrow relay-to-Hub Service NetworkPolicy without routing control traffic through
the public ingress. The relay opens `/api/browser/relay/control` WSS/WS and posts
`/api/browser/relay/introspect`. Hub does not initiate another connection to the
relay. Allow relay egress to the Hub Service and cluster DNS, plus ingress from
the ingress controller to8080. Internal HTTP is a deployment choice within that
cluster boundary; public browser/agent connections require TLS.

## Container lifecycle

Run one relay replica and one Hub authority host initially. Redis owns browser
registration and grant persistence; relay sockets and command results are
in-memory and are not restored or replayed after restart. Readiness follows live
Hub authority. Authority loss closes the data plane and exits1 so Kubernetes can
restart the process; SIGTERM/SIGINT drain and close with exit0. Neither path
replays uncertain native actions.

The image runs as `node`, supports a read-only root filesystem, needs no volume,
and can drop all Linux capabilities with `allowPrivilegeEscalation:false`.
The canonical public SDK barrel is bundled from this same source revision;
`ws` is the only runtime package. The Docker context is restricted to that source
closure and excludes `.git`, dependency folders and generated output.

Build and image smoke are intended for the authorized ARC CI lane. The smoke
uses only an internal Docker network and synthetic authority credentials; no host
ports or real browser/Hub credentials are used. It checks non-root/read-only
operation, health/readiness, rejection of invalid device AND agent tickets,
normal SIGTERM exit0 and authority-loss exit1. Synthetic helpers are copied only
into temporary CI containers and are not present in the published image.

```sh
docker build -f extensions/browser/relay-container/Dockerfile -t browser-relay:test .
bash extensions/browser/relay-container/smoke.sh browser-relay:test
```

Public source fork Actions are currently disabled. Do not enable its broad
upstream workflow set merely to build this component. A dedicated existing Hub
CI job can check out a reviewed immutable source SHA, run the commands above,
push the image and report its digest. Kubernetes changes remain Terraform PRs
owned by agent-hub/office-k3s; no public listener is added to office-pc.

## Delivery and browser switch

Register the relay origin through Hub operator auth, store its returned relay
credential in the Kubernetes Secret, then deploy the image by digest. Verify
external TLS/WSS, uncredentialed rejection, and synthetic device/agent pairing,
command, Stop and revoke before migrating the real browser. The working local
fixture and current browser pairing remain untouched during these checks.
The current extension stores one Hub pairing; changing a configured origin is
not a silent endpoint flip. Coordinate the normal settings/re-pair step only
after the public service passes validation. Human web login and Chrome Store
publication remain separate product work.
