import puppeteer, { type Browser } from '@cloudflare/puppeteer';
import type { Env } from './env';

const KEEP_ALIVE_MS = 60_000; // keep the browser warm ~60s after the last render, then close

interface RenderReq { html: string; marginsMm?: { top: number; right: number; bottom: number; left: number } }

/** Durable Object that owns a single reused browser. Renders go through newPage() on the
 *  warm browser → no per-render launch → no new-instance rate limit. Closes on idle via alarm. */
export class BrowserRenderer {
  private browser?: Browser;
  private keepAliveUntil = 0;
  constructor(private state: DurableObjectState, private env: Env) {}

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await puppeteer.launch(this.env.BROWSER);
    }
    return this.browser;
  }

  async fetch(req: Request): Promise<Response> {
    const { html, marginsMm }: RenderReq = await req.json();
    const m = marginsMm ?? { top: 12, right: 12, bottom: 12, left: 12 };
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });
      await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
      const pdf = await page.pdf({
        format: 'Letter', printBackground: true,
        margin: { top: `${m.top}mm`, right: `${m.right}mm`, bottom: `${m.bottom}mm`, left: `${m.left}mm` },
      });
      // keep warm + ensure an alarm is scheduled to eventually close on idle
      this.keepAliveUntil = Date.now() + KEEP_ALIVE_MS;
      if ((await this.state.storage.getAlarm()) == null) {
        await this.state.storage.setAlarm(Date.now() + KEEP_ALIVE_MS);
      }
      return new Response(pdf as unknown as BodyInit, { headers: { 'content-type': 'application/pdf' } });
    } finally {
      await page.close().catch(() => {});
    }
  }

  async alarm(): Promise<void> {
    if (Date.now() < this.keepAliveUntil) {
      await this.state.storage.setAlarm(this.keepAliveUntil + 1000); // still active → reschedule
      return;
    }
    if (this.browser) { try { await this.browser.close(); } catch {} this.browser = undefined; }
  }
}
