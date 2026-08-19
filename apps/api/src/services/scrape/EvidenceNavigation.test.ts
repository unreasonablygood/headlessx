import { expect, test } from 'bun:test';

import {
  captureEvidenceStep,
  EvidenceCaptureStepError,
  selectMainDocumentResponse,
  validateRenderedDocumentFallback,
} from './EvidenceNavigation';

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

test('accepts an HTML navigation timing fallback with a real HTTP status', () => {
  expect(validateRenderedDocumentFallback(200, 'text/html')).toEqual({
    status: 200,
    contentType: 'text/html',
  });
});

test('rejects missing status and non-HTML navigation timing fallbacks', () => {
  expect(validateRenderedDocumentFallback(0, 'text/html')).toBeNull();
  expect(validateRenderedDocumentFallback(200, 'image/png')).toBeNull();
});

test('labels a failed browser capture operation without preserving its unsafe error', async () => {
  const failure = captureEvidenceStep('navigation_timing', async () => {
    throw new Error('unsafe browser detail');
  });

  await expect(failure).rejects.toEqual(new EvidenceCaptureStepError('navigation_timing'));
  await expect(failure).rejects.not.toHaveProperty('message', 'unsafe browser detail');
});
