const MAX_ELEMENT_WIDTH = 800;
const MAX_ELEMENT_HEIGHT = 320;
const MAX_ELEMENT_AREA = 160_000;
const MAX_ELEMENT_VIEWPORT_FRACTION = 0.3;

export interface LogoElementInspection {
  stableDescription: string;
  identityEvidence: string;
  contextEvidence: string;
  tagName: string;
  role: string | null;
  visibleText: string;
  imageCount: number;
  loadedImageCount: number;
  svgCount: number;
  backgroundImageCount: number;
  canvasCount: number;
  videoCount: number;
  iframeCount: number;
}

interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function validateLogoElementEvidence(
  expectedIdentity: string,
  inspection: LogoElementInspection,
  boundingBox: ElementBounds,
  viewport: { width: number; height: number },
): string | null {
  const area = boundingBox.width * boundingBox.height;
  const viewportArea = viewport.width * viewport.height;
  if (
    boundingBox.x < 0 ||
    boundingBox.y < 0 ||
    boundingBox.width < 24 ||
    boundingBox.height < 12 ||
    boundingBox.width > MAX_ELEMENT_WIDTH ||
    boundingBox.height > MAX_ELEMENT_HEIGHT ||
    area > MAX_ELEMENT_AREA ||
    area > viewportArea * MAX_ELEMENT_VIEWPORT_FRACTION ||
    boundingBox.x + boundingBox.width > viewport.width + 1 ||
    boundingBox.y + boundingBox.height > viewport.height + 1
  ) {
    return 'evidence_element_bounds_refused';
  }
  const primitiveCount =
    inspection.imageCount + inspection.svgCount + inspection.backgroundImageCount;
  if (
    !inspection.visibleText ||
    primitiveCount !== 1 ||
    inspection.loadedImageCount !== inspection.imageCount ||
    inspection.canvasCount > 0 ||
    inspection.videoCount > 0 ||
    inspection.iframeCount > 0 ||
    !/(?:^|[^a-z])(logo|wordmark|brand)(?:[^a-z]|$)/i.test(inspection.contextEvidence) ||
    /(?:^|[^a-z])(sponsors?|partners?|clients?|customers?|products?|gallery|carousel|hero|banner|promo|awards?|badges?|certifications?|photos?|portraits?|social|share|team|staff)(?:[^a-z]|$)/i.test(
      inspection.contextEvidence,
    ) ||
    !identityMatches(expectedIdentity, inspection.identityEvidence)
  ) {
    return 'evidence_element_identity_refused';
  }
  return null;
}

function identityMatches(expected: string, evidence: string): boolean {
  const ignored = new Set([
    'and',
    'company',
    'corp',
    'corporation',
    'co',
    'inc',
    'incorporated',
    'llc',
    'limited',
    'ltd',
    'of',
    'the',
  ]);
  const normalize = (value: string): string[] =>
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((token) => !ignored.has(token)) ?? [];
  const expectedTokens = normalize(expected);
  const evidenceTokens = new Set(normalize(evidence));
  return expectedTokens.length > 0 && expectedTokens.every((token) => evidenceTokens.has(token));
}
