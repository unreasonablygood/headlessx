import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

export type FixedSecretName =
  | 'credential-encryption-key'
  | 'dashboard-internal-api-key'
  | 'evidence-api-key';

const SECRET_PATHS: Readonly<Record<FixedSecretName, string>> = {
  'credential-encryption-key': '/run/secrets/headlessx-credential-encryption-key',
  'dashboard-internal-api-key': '/run/secrets/headlessx-dashboard-internal-api-key',
  'evidence-api-key': '/run/secrets/headlessx-evidence-api-key',
};
const MAX_SECRET_BYTES = 16 * 1024;
const cachedSecrets: Partial<Record<FixedSecretName, Buffer>> = {};

export function readFixedSecret(name: FixedSecretName): Buffer {
  const cached = cachedSecrets[name];
  if (cached) return cached;

  let fd: number | null = null;
  try {
    fd = openSync(SECRET_PATHS[name], constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.gid !== 0 ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o400
    ) {
      throw new Error(`HeadlessX ${name} metadata is invalid`);
    }
    if (stat.size < 32 || stat.size > MAX_SECRET_BYTES) {
      throw new Error(`HeadlessX ${name} length is invalid`);
    }
    const value = readFileSync(fd);
    if (value.some((byte) => byte <= 0x20 || byte === 0x7f)) {
      value.fill(0);
      throw new Error(`HeadlessX ${name} contains whitespace or control bytes`);
    }
    cachedSecrets[name] = value;
    return value;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function matchesFixedSecret(candidate: string | undefined, name: FixedSecretName): boolean {
  if (!candidate) return false;
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  const configuredDigest = createHash('sha256').update(readFixedSecret(name)).digest();
  return timingSafeEqual(candidateDigest, configuredDigest);
}
