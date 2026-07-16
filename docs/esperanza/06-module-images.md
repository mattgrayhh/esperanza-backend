# 06 — Module: Image Hosting & Compression

There's no dedicated "image worker" — image hosting is a convention across the stack built
on **R2** (Cloudflare's S3-like object storage). This doc explains where images live, the
URL conventions, the host that was retired, and the (deliberately limited) compression
story.

---

## Where images live: R2 bucket `esperanza-cms`

- **One bucket:** `esperanza-cms`. Every worker that touches images binds it as `IMAGES`.
- **Public URL base:** `https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev`
  (a stable custom domain — e.g. `cdn.esperanzahomes.com` — may front it; both resolve to
  the same bucket).
- **Key/prefix conventions:**

  | Prefix | Contents |
  |---|---|
  | `<entity>/<id>/<filename>` | entity images uploaded from the admin (e.g. `floor_plans/recXXXX/elevation.jpg`) |
  | `floor_plans/<id>/…` | floor-plan galleries, elevation images, harvested brochure layout drawings |
  | `brand/` | logos and brand assets (e.g. the XML feed's logo) |
  | `pdf/<type>/<id>.pdf` | generated PDFs (doc 05) |
  | `images/<id>/<filename>` | digital-asset-library uploads |

Persisted image fields in D1 store the **stable R2 URL** (often as `{url, filename}`
objects in gallery JSON). Uploads happen through the admin's `uploadImage` /
`uploadGalleryImage` / `uploadBlockImage` helpers (doc 03).

---

## ★ The retired host: `media.esperanzahomes.com`

The legacy site served images from `media.esperanzahomes.com`. **That host is dead and
fully retired from D1** (no references remain in the data). All images are now
R2-hosted. If you ever see a `media.esperanzahomes.com` URL, it's a leftover/dead link —
re-host the asset to R2 and update the record.

---

## ★ Never store Airtable URLs

Airtable attachment URLs (`*.airtableusercontent.com`) are **signed and expire**, and the
full attachment objects carry nested signed thumbnail URLs that leak/expire too. The admin
upload code **rejects** these URLs on purpose. When importing/rescuing legacy images,
always **download and re-upload to R2**, then store only the stable R2 `{url, filename}`.
(Transient R2 `object put` 10001 errors happen occasionally — just retry.)

---

## Compression: why it's mostly OFF (and the real plan)

This part surprises people, so here's the honest state:

- **Cloudflare Images / a compression proxy (`img.hazardhouse.ai`) was built but is
  disabled / passthrough** for the public path. It's a no-op.
- **Why disabled:** at the edge it bought little in practice and broke some fetches, so it
  was left as a passthrough.
- **The one place resizing IS used:** inside the **PDF worker** (`/img`, doc 05), purely so
  brochures embed downsized images. That's internal, not the site pipeline.
- **The real win (TODO, not yet built):** **compress at upload time** in the admin using
  `sharp` — shrink images once when marketing uploads them, store the optimized version in
  R2, and let both the site and PDFs consume that. There's a `sharp`-based `derive-renditions`
  script in the PDF package used as a one-off, but no runtime upload-time pipeline yet.

**Bottom line for a new dev:** don't expect an active compression layer. Images are served
from R2 as uploaded, directly to the static frontend and `esperanza-api`. If image weight
becomes a problem, the sanctioned direction is compress-at-upload with `sharp`, not
re-enabling the edge proxy.

---

## Files / where to look

| Goal | Where |
|---|---|
| Admin upload to R2 | `packages/admin/lib/actions.ts` (`uploadImage`, `uploadGalleryImage`, `uploadBlockImage`) |
| PDF image resizing | `packages/pdf/src/index.ts` (`/img`) |
| One-off rendition derivation (sharp) | `packages/pdf` `derive-renditions` script |
| Legacy image rescue (re-host to R2) | `packages/db/scripts/migrate-images.ts` |
| Bucket binding / public URL | each worker's `wrangler.toml` (`IMAGES`, `IMAGES_PUBLIC_BASE_URL`) |

```bash
# Inspect what's in the bucket:
npx wrangler r2 object get esperanza-cms/brand/esperanza-homes-logo.jpg --file=/tmp/logo.jpg
# Upload an asset (retry on transient 10001):
npx wrangler r2 object put esperanza-cms/floor_plans/recXXXX/plan.jpg --file=./plan.jpg
```

---
**Next:** [07 — Module: XML Listing Feed](./07-module-xml-feed.md)
