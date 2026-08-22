import { expect, test } from 'bun:test';

import { type LogoElementInspection, validateLogoElementEvidence } from './EvidenceLogoElement';

const viewport = { width: 1_280, height: 720 };

function inspection(overrides: Partial<LogoElementInspection> = {}): LogoElementInspection {
  return {
    stableDescription: 'a.c-logo__link role=link',
    identityEvidence: 'Tradewind Aviation Tradewind',
    contextEvidence: 'c-logo__link c-logo__img /logo__fleet.svg c-logo__label',
    tagName: 'a',
    role: 'link',
    visibleText: 'TRADEWIND',
    imageCount: 1,
    loadedImageCount: 1,
    svgCount: 0,
    backgroundImageCount: 0,
    canvasCount: 0,
    videoCount: 0,
    iframeCount: 0,
    ...overrides,
  };
}

test('admits retained Tradewind and North Florida Council DOM lockups', () => {
  expect(
    validateLogoElementEvidence(
      'Tradewind Aviation',
      inspection(),
      { x: 15, y: 70.5, width: 204.34375, height: 42.984375 },
      viewport,
    ),
  ).toBeNull();
  expect(
    validateLogoElementEvidence(
      'North Florida Council',
      inspection({
        stableDescription: 'a#top.logo-link role=link',
        identityEvidence: 'Boy Scouts of America North Florida Council',
        contextEvidence: 'top logo-link logo /img/logo.jpg',
        visibleText: 'BOY SCOUTS OF AMERICA NORTH FLORIDA COUNCIL',
      }),
      { x: 70, y: 0, width: 500, height: 69 },
      viewport,
    ),
  ).toBeNull();
});

test('refuses body-sized and retained false-case selections', () => {
  expect(
    validateLogoElementEvidence(
      'Tradewind Aviation',
      inspection(),
      { x: 0, y: 0, width: 1_280, height: 720 },
      viewport,
    ),
  ).toBe('evidence_element_bounds_refused');

  for (const hostile of [
    inspection({ contextEvidence: 'logo image01 photo portrait' }), // Andre: photograph
    inspection({ contextEvidence: 'product-gallery logo' }), // Brighton: product composite
    inspection({ identityEvidence: 'CPR First Aid', visibleText: 'CPR FIRST AID' }), // Carolina: wrong entity
    inspection({ visibleText: '' }), // Dwarven: symbol only
    inspection({ identityEvidence: 'Decalnetwork', visibleText: 'DECALNETWORK' }), // RTC: sibling brand
    inspection({ imageCount: 0, loadedImageCount: 0 }), // Travis: text only, no logo primitive
    inspection({ loadedImageCount: 0 }),
    inspection({ imageCount: 0, loadedImageCount: 0, canvasCount: 1 }),
    inspection({ imageCount: 2, loadedImageCount: 2 }),
    inspection({ contextEvidence: 'partner-logos logo' }),
  ]) {
    expect(
      validateLogoElementEvidence(
        'Tradewind Aviation',
        hostile,
        { x: 15, y: 70, width: 204, height: 43 },
        viewport,
      ),
    ).toBe('evidence_element_identity_refused');
  }
});
