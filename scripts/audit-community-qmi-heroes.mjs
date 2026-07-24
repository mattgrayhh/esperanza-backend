#!/usr/bin/env node
/**
 * Compare community-page QMI card heroes on the preview site vs www.esperanzahomes.com.
 * Emits JSON: { match, fixable, needs_review, legacy_missing, errors }
 *
 * Usage: node scripts/audit-community-qmi-heroes.mjs > /tmp/qmi-hero-audit.json
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const PREVIEW = process.env.PREVIEW_ORIGIN ?? 'https://esperanzahomes.hazardhouse.ai';
const LIVE = process.env.LIVE_ORIGIN ?? 'https://www.esperanzahomes.com';

function fetch(url) {
  return execFileSync('curl', ['-sL', '-A', 'Mozilla/5.0', '--max-time', '25', url], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function normUrl(u) {
  if (!u) return '';
  let s = u.replace(/&amp;/g, '&').split('?')[0].toLowerCase();
  s = s.replace(/https:\/\/img\.hazardhouse\.ai\/cdn-cgi\/image\/[^/]+\//, 'https://img.hazardhouse.ai/');
  return s;
}

function basename(u) {
  const n = normUrl(u);
  return n ? n.split('/').pop() : '';
}

function parseGallery(raw) {
  if (!raw) return [];
  let items = raw;
  if (typeof raw === 'string') {
    try {
      items = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(items)) return [];
  return items
    .map((g) => (typeof g === 'object' && g?.url ? g.url : typeof g === 'string' ? g : ''))
    .filter(Boolean);
}

function isFloorPlan(u) {
  return /\/floor_plans\//i.test(u || '');
}

function adminMatchesLegacy(adminUrls, legacyHero) {
  const legacyBase = basename(legacyHero);
  if (!legacyBase) return null;
  const stem = legacyBase.replace(/\.[^.]+$/, '');
  for (const u of adminUrls) {
    const b = basename(u);
    if (!b) continue;
    if (b === legacyBase) return u;
    if (stem.length >= 4 && b.includes(stem)) return u;
  }
  return null;
}

const api = JSON.parse(fetch(`${PREVIEW}/api/public/qmi`));
const homesBySlug = new Map();
for (const h of api.homes ?? []) {
  const f = h.fields ?? h;
  const slug = f.slug ?? h.slug;
  if (slug) homesBySlug.set(slug, h);
}

const homeHtml = fetch(`${PREVIEW}/`);
const commPaths = [...new Set([...homeHtml.matchAll(/href="(new-homes\/tx\/[^"#?]+\/\d+\/)"/g)].map((m) => m[1]))].sort();

const results = {
  match: [],
  fixable: [],
  needs_review: [],
  legacy_missing: [],
  errors: [],
};

for (const rel of commPaths) {
  const path = `/${rel}`;
  const previewHtml = fetch(`${PREVIEW}${path}`);
  const liveHtml = fetch(`${LIVE}${path}`);
  const slugs = [...previewHtml.matchAll(/data-qmi-slug="([^"]+)"/g)].map((m) => m[1]);
  if (!slugs.length) continue;

  for (const slug of slugs) {
    const h = homesBySlug.get(slug);
    if (!h) {
      results.errors.push({ path, slug, reason: 'no api record' });
      continue;
    }
    const f = h.fields ?? h;
    const addr = f.Address ?? slug;
    const comm = f.Community ?? '';
    const d1Image = normUrl(f.image_url ?? '');
    const og = normUrl(f.og_image_url ?? '');
    const gallery = parseGallery(f.photo_gallery_json);

    const cardRe = new RegExp(`data-qmi-slug="${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,5000}?<img[^>]+src="([^"]+)"`);
    const cardM = previewHtml.match(cardRe);
    const previewCard = normUrl(cardM?.[1] ?? d1Image);

    let liveLink = null;
    for (const m of liveHtml.matchAll(new RegExp(`href="([^"]*${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*)"`, 'gi'))) {
      liveLink = m[1];
      break;
    }

    let legacyHero = null;
    if (liveLink) {
      const detail = fetch(liveLink.startsWith('http') ? liveLink : `${LIVE}${liveLink}`);
      const ogm = detail.match(/property="og:image"\s+content="([^"]+)"/);
      if (ogm) legacyHero = normUrl(ogm[1]);
    }
    if (!legacyHero) {
      results.legacy_missing.push({ community: comm, address: addr, slug });
      continue;
    }

    const adminUrls = [...gallery.map(normUrl), ...(og ? [og] : []), ...(d1Image ? [d1Image] : [])];
    const adminMatch = adminMatchesLegacy(adminUrls, legacyHero);

    const legacyBase = basename(legacyHero);
    const previewBase = basename(previewCard);
    const same =
      previewBase === legacyBase ||
      previewCard === legacyHero ||
      (previewBase && legacyBase && previewBase.split('.')[0] === legacyBase.split('.')[0]);

    const entry = {
      community: comm,
      address: addr,
      slug,
      id: h.id,
      legacy_hero: legacyHero,
      preview_card: previewCard,
      d1_image_url: d1Image,
      admin_match: adminMatch,
      gallery_count: gallery.length,
      og_image_url: og,
    };

    if (same) results.match.push(entry);
    else if (adminMatch) results.fixable.push(entry);
    else results.needs_review.push(entry);
  }
}

const outPath = process.argv[2] ?? '/tmp/qmi-hero-audit.json';
writeFileSync(outPath, JSON.stringify(results, null, 2));
console.error(`Wrote ${outPath}`);
console.error(`match=${results.match.length} fixable=${results.fixable.length} needs_review=${results.needs_review.length}`);
