import type { Request } from 'express';
import { matchesFixedSecret, readFixedSecret } from './FixedSecretFiles';

const DIRECT_TRUSTED_SEATS: Readonly<Record<string, true>> = {
  '100.122.151.60': true,
  '100.66.252.122': true,
};
const WEB_DOCUMENT_SERVICE = '100.92.188.36';
const ADMITTED_PATHS: Readonly<Record<string, true>> = {
  '/scrape/html': true,
  '/scrape/html-js': true,
  '/scrape/content': true,
  '/scrape/screenshot': true,
  '/evidence': true,
};

export type TrustedWebsiteAdmission =
  | { kind: 'direct-seat'; identity: string }
  | { kind: 'web-document-service'; identity: string }
  | { kind: 'not-applicable' }
  | { kind: 'refused' };

function normalizeRemoteAddress(address: string | undefined): string | null {
  if (!address) return null;
  if (address.startsWith('::ffff:')) return address.slice('::ffff:'.length);
  return address;
}

function isTailscaleAddress(address: string): boolean {
  const octets = address.split('.').map(Number);
  return (
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    octets[0] === 100 &&
    octets[1] >= 64 &&
    octets[1] <= 127
  );
}

export function loadEvidenceApiKey(): void {
  readFixedSecret('evidence-api-key');
}

export function admitTrustedWebsiteRequest(
  req: Request,
  suppliedApiKey: string | undefined,
): TrustedWebsiteAdmission {
  if (!req.baseUrl.startsWith('/api/operators/website') || !ADMITTED_PATHS[req.path]) {
    return { kind: 'not-applicable' };
  }
  const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress);
  if (!remoteAddress) return { kind: 'refused' };
  if (DIRECT_TRUSTED_SEATS[remoteAddress]) {
    return { kind: 'direct-seat', identity: remoteAddress };
  }
  if (remoteAddress === WEB_DOCUMENT_SERVICE) {
    return matchesFixedSecret(suppliedApiKey, 'evidence-api-key')
      ? { kind: 'web-document-service', identity: remoteAddress }
      : { kind: 'refused' };
  }
  if (isTailscaleAddress(remoteAddress)) {
    return { kind: 'refused' };
  }
  return { kind: 'not-applicable' };
}
