export const normalizeCollectorUrl = (collectorUrl: string): string =>
  collectorUrl.replace(/\/+$/u, "")
