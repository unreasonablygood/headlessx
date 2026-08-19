export function selectMainDocumentResponse<T>(
  navigationResponse: T | null,
  observedMainDocumentResponse: T | null,
): T | null {
  return navigationResponse ?? observedMainDocumentResponse;
}
