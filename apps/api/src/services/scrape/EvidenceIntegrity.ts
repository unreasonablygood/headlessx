import { createHash } from 'node:crypto';

export function evidenceSha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
