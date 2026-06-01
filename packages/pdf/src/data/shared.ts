export const money = (n: number | null | undefined): string =>
  n == null ? '' : `$${Math.round(n).toLocaleString('en-US')}`;

export function renditionUrl(originalUrl: string, variant: 'w1200' | 'w2000'): string {
  if (!originalUrl) return '';
  return originalUrl.replace(/(\.[a-z]+)(\?.*)?$/i, `-${variant}$1$2`);
}
