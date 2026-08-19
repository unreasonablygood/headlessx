import { expect, test } from 'bun:test';

import { selectMainDocumentResponse } from './EvidenceNavigation';

test('waits for a delayed observed response when Headfox goto returns null', async () => {
  const observed = { status: 200 };
  let latest: typeof observed | null = null;

  expect(
    await selectMainDocumentResponse(
      null,
      () => latest,
      async () => {
        latest = observed;
      },
    ),
  ).toBe(observed);
});

test('keeps the direct navigation response when Playwright returns one', async () => {
  const direct = { status: 200 };
  const observed = { status: 302 };

  expect(await selectMainDocumentResponse(direct, () => observed)).toBe(direct);
});
