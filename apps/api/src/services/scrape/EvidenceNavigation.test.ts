import { expect, test } from 'bun:test';

import { selectMainDocumentResponse } from './EvidenceNavigation';

test('uses the observed main response when Headfox goto returns null', () => {
  const observed = { status: 200 };

  expect(selectMainDocumentResponse(null, observed)).toBe(observed);
});

test('keeps the direct navigation response when Playwright returns one', () => {
  const direct = { status: 200 };
  const observed = { status: 302 };

  expect(selectMainDocumentResponse(direct, observed)).toBe(direct);
});
