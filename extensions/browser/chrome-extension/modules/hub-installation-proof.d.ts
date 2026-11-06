export type HubInstallationIdentity = {
  privateKey: CryptoKey;
  publicKeySpki: string;
  fingerprint: string;
};
export function canonicalHubOrigin(value: string): string;
export function createHubInstallationIdentity(cryptoApi?: Crypto): Promise<HubInstallationIdentity>;
export function createHubInstallationProof(options: {
  kind: "device" | "relay"; origin: string; browserId: string; privateKey: CryptoKey;
  cryptoApi?: Crypto; now?: () => number;
}): (challenge: unknown) => Promise<string>;
