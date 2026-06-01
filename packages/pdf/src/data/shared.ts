export const money = (n: number | null | undefined): string =>
  n == null ? '' : `$${Math.round(n).toLocaleString('en-US')}`;

export function renditionUrl(originalUrl: string, variant: 'w600' | 'w1200' | 'w2000'): string {
  if (!originalUrl) return '';
  // strip query string for extension detection
  const hasExt = /\.[a-z0-9]+(\?.*)?$/i.test(originalUrl);
  if (hasExt) return originalUrl.replace(/(\.[a-z0-9]+)(\?.*)?$/i, `-${variant}$1$2`);
  // extensionless (common for R2 attachment keys): append suffix, preserving query string
  const m = originalUrl.match(/^([^?]*)(\?.*)?$/);
  return `${m![1]}-${variant}${m![2] ?? ''}`;
}
