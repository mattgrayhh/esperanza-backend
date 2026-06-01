import puppeteer from '@cloudflare/puppeteer';
import type { Env } from './env';

const m = (n: number) => `${n}mm`;

export async function renderPdf(env: Env, html: string, marginsMm = { top: 12, right: 12, bottom: 12, left: 12 }): Promise<Uint8Array> {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });
    await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: m(marginsMm.top), right: m(marginsMm.right), bottom: m(marginsMm.bottom), left: m(marginsMm.left) },
    });
    return pdf as Uint8Array;
  } finally {
    await browser.close();
  }
}
