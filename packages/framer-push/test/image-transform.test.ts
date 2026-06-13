// =============================================================================
// Unit tests for the Cloudflare Images URL transform (image-transform.ts) and
// its integration into the image()/galleryArray() value builders.
//   * passthrough by default (unconfigured) — no behavior change on merge.
//   * once configured: rewrites *.r2.dev image URLs to /cdn-cgi/image/ on the
//     delivery host; leaves external hosts, PDFs/SVGs, and already-transformed
//     URLs untouched; idempotent.
//   * image() and galleryArray() apply it (so all mappers + type-overrides do).
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import {
  transformImageUrl,
  configureImageTransform,
  resetImageTransform,
} from '../src/image-transform.js';
import { image, galleryArray } from '../src/framer-types.js';

const BASE = 'https://ehi.hazardhouse.ai';
const R2 = 'https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev';

afterEach(() => resetImageTransform());

describe('transformImageUrl', () => {
  it('is a no-op when unconfigured (default)', () => {
    expect(transformImageUrl(`${R2}/qmi/rec1/hero.jpg`)).toBe(`${R2}/qmi/rec1/hero.jpg`);
  });

  it('rewrites an r2.dev image URL to a cdn-cgi transform on the delivery host', () => {
    configureImageTransform(BASE);
    expect(transformImageUrl(`${R2}/qmi/rec1/hero.jpg`)).toBe(
      `${BASE}/cdn-cgi/image/format=auto,quality=80,width=1920/qmi/rec1/hero.jpg`
    );
  });

  it('honors a custom options string and trims a trailing slash on base', () => {
    configureImageTransform(`${BASE}/`, 'format=auto,quality=70,width=800');
    expect(transformImageUrl(`${R2}/communities/rec2/a.png`)).toBe(
      `${BASE}/cdn-cgi/image/format=auto,quality=70,width=800/communities/rec2/a.png`
    );
  });

  it('leaves non-r2.dev hosts untouched (framerusercontent, external)', () => {
    configureImageTransform(BASE);
    expect(transformImageUrl('https://framerusercontent.com/images/x.jpg')).toBe(
      'https://framerusercontent.com/images/x.jpg'
    );
    expect(transformImageUrl('https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
  });

  it('does not transform PDFs or SVGs', () => {
    configureImageTransform(BASE);
    expect(transformImageUrl(`${R2}/floor_plans/rec3/plan.pdf`)).toBe(`${R2}/floor_plans/rec3/plan.pdf`);
    expect(transformImageUrl(`${R2}/qmi/rec3/logo.svg`)).toBe(`${R2}/qmi/rec3/logo.svg`);
  });

  it('is idempotent — never double-wraps an existing transform URL', () => {
    configureImageTransform(BASE);
    const once = transformImageUrl(`${R2}/qmi/rec1/hero.jpg`);
    expect(transformImageUrl(once)).toBe(once);
  });

  it('passes through non-URL / empty values', () => {
    configureImageTransform(BASE);
    expect(transformImageUrl('')).toBe('');
    expect(transformImageUrl('not a url')).toBe('not a url');
  });
});

describe('image()/galleryArray() integration', () => {
  it('image() emits the transformed URL when configured', () => {
    configureImageTransform(BASE);
    expect(image(`${R2}/qmi/rec1/hero.jpg`)).toEqual({
      type: 'image',
      value: `${BASE}/cdn-cgi/image/format=auto,quality=80,width=1920/qmi/rec1/hero.jpg`,
    });
  });

  it('galleryArray() transforms each entry', () => {
    configureImageTransform(BASE);
    const out = galleryArray([`${R2}/qmi/rec1/a.jpg`, 'https://framerusercontent.com/b.jpg']);
    expect(out.type).toBe('array');
    expect(out.value[0]!.fieldData.image.value).toBe(
      `${BASE}/cdn-cgi/image/format=auto,quality=80,width=1920/qmi/rec1/a.jpg`
    );
    // non-r2 host left untouched
    expect(out.value[1]!.fieldData.image.value).toBe('https://framerusercontent.com/b.jpg');
  });

  it('image() unchanged when unconfigured (golden-snapshot safety)', () => {
    expect(image(`${R2}/qmi/rec1/hero.jpg`)).toEqual({ type: 'image', value: `${R2}/qmi/rec1/hero.jpg` });
  });
});
