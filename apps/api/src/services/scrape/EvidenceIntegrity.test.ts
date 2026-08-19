import { expect, test } from 'bun:test';

import { evidenceSha256 } from './EvidenceIntegrity';

test('emits the verifier wire contract as bare lowercase sha256 hex', () => {
  const digest = evidenceSha256(Buffer.from('headlessx-evidence'));

  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(digest).toBe('32136474fabe73bc56c80ee1d86cc056c54b9a2a18c21da4eef6f7c00b242079');
  expect(digest).not.toStartWith('sha256:');
});
