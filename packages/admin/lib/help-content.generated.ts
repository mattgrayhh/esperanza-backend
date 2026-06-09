// =============================================================================
// GENERATED FILE — do not edit. Source: packages/admin/help-content/*.md
// Regenerate: npm run gen:help (packages/admin). Spec:
// docs/specs/2026-06-06-help-wiki-design.md
// =============================================================================

export interface HelpArticle {
  slug: string;
  title: string;
  category: string;
  categorySort: number;
  sort: number;
  summary: string;
  keywords: string[];
  entity: string | null;
  html: string;
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    "slug": "welcome",
    "title": "Welcome — what this admin controls",
    "category": "Getting Started",
    "categorySort": 10,
    "sort": 10,
    "summary": "How the admin, Snowflake, and esperanzahomes.com fit together.",
    "keywords": [
      "overview",
      "intro",
      "start",
      "website",
      "snowflake",
      "framer"
    ],
    "entity": null,
    "html": "<p>This admin is the single place the marketing team manages everything that<br>appears on <strong>esperanzahomes.com</strong>: homes, communities, floor plans, blogs,<br>promotions, testimonials, city pages, and images.</p><h2>The one-minute mental model</h2><ol><li><strong>MarkSystems → Snowflake</strong> is the source of truth for <em>facts</em>: which homes</li></ol><p>   exist, prices, square footage, beds/baths, construction stage, move-in<br>   dates. The admin pulls these automatically every few hours.</p><ol><li><strong>You</strong> own everything else: descriptions, photos, copy blocks, promotions,</li></ol><p>   blogs — and the decision of what's visible on the site.</p><ol><li><strong>The website updates itself.</strong> When you save a change here, it's pushed to</li></ol><p>   the live site within moments. There's nothing extra to publish or deploy.</p><h2>Where things live</h2><ul><li><code>Listings</code> in the sidebar: <code>Quick Move-Ins</code> (individual homes), <code>Communities</code>,</li></ul><p>  <code>Cities</code>, and <code>Floor Plans</code>.</p><ul><li><code>Marketing</code>: <code>Promotions</code>, <code>Collections</code>, <code>Images</code> (the photo library),</li></ul><p>  <code>Blogs</code>, and <code>Testimonials</code>.</p><ul><li><code>Brochures</code>: auto-generated <code>PDFs</code> for homes, communities, and plans.</li></ul><h2>The two ideas worth learning first</h2><ul><li><strong>Synced vs. manual fields</strong> — some fields are filled automatically from</li></ul><p>  Snowflake and are locked by default. See <em>Synced fields and overrides</em>.</p><ul><li><strong>Statuses</strong> — every record is <code>Draft</code>, <code>Coming Soon</code>, or <code>Live</code>. See</li></ul><p>  <em>Statuses: Draft, Coming Soon, Live</em>.</p>"
  },
  {
    "slug": "synced-fields-and-overrides",
    "title": "Synced fields and overrides (the lock)",
    "category": "Getting Started",
    "categorySort": 10,
    "sort": 20,
    "summary": "What the lock means, how to override a synced value, and how to undo it.",
    "keywords": [
      "lock",
      "unlock",
      "override",
      "snowflake",
      "synced",
      "revert",
      "follow"
    ],
    "entity": null,
    "html": "<p>Fields that Snowflake fills automatically show a <code>synced</code> badge and appear<br><strong>locked</strong> — the box shows the current synced value and can't be typed in.<br>That's on purpose: as prices, square footage, or dates change in MarkSystems,<br>these fields keep themselves up to date.</p><h2>Which fields are synced?</h2><ul><li><strong>Homes</strong>: address, price, beds/baths, square footage, elevation and</li></ul><p>  material type, construction stage, lot number, move-in date, model-home<br>  flag, and the city / community / floor-plan assignment.</p><ul><li><strong>Communities</strong>: square-footage range, bed and bath ranges, and</li></ul><p>  <code>Price From</code> (the lowest base plan price in that community).</p><ul><li><strong>Floor Plans</strong>: beds/baths, living and total square footage, and</li></ul><p>  <code>Starting Price</code> (the lowest current base price across communities).</p><h2>Override a synced value</h2><ol><li>Find the field and tick <code>Unlock to override</code>.</li><li>Type your value.</li><li><code>Save</code>.</li></ol><p>The field now shows an <code>override</code> badge. <strong>Your value wins</strong> on the website,<br>and it survives every future sync — only this field is pinned; everything else<br>on the record keeps syncing normally.</p><h2>Go back to following Snowflake</h2><ol><li>Untick the checkbox (re-lock the field).</li><li><code>Save</code>.</li></ol><p>The override is removed and the field shows the live synced value again.</p><h2>When should I override?</h2><p>Sparingly. Overrides are for marketing judgment calls — a promo price, a<br>friendlier address spelling. If a synced value looks <em>wrong</em>, the better fix<br>is usually upstream in MarkSystems, so every system agrees.</p><p>Every override (set or removed) is recorded in the audit log with who and when.</p>"
  },
  {
    "slug": "statuses-explained",
    "title": "\"Statuses: Draft, Coming Soon, Live\"",
    "category": "Getting Started",
    "categorySort": 10,
    "sort": 30,
    "summary": "What each status means and what visitors see in each state.",
    "keywords": [
      "publish",
      "unpublish",
      "draft",
      "coming soon",
      "live",
      "status",
      "visibility"
    ],
    "entity": null,
    "html": "<p>Every home, community, floor plan, and city has a three-way status, set with<br>the <code>Status</code> control at the top of its page.</p><ul><li><code>Draft</code> — not on the website at all. New homes from Snowflake start here.</li><li><code>Coming Soon</code> — the page IS on the website with a \"coming soon\" banner and</li></ul><p>  lead-capture form, but without full details. Use it to build interest before<br>  a community or home is ready.</p><ul><li><code>Live</code> — fully published.</li></ul><h2>Notes</h2><ul><li>Blogs, promotions, testimonials, collections, and images use a simple</li></ul><p>  published/unpublished toggle instead of the three-way status.</p><ul><li>When a home <strong>sells</strong>, the system unpublishes it automatically (back to</li></ul><p>  <code>Draft</code>) on the next sync. You never need to chase sold homes.</p><ul><li>Setting a record back to <code>Draft</code> hides its page from the site within</li></ul><p>  moments. Search engines drop it on their own schedule.</p>"
  },
  {
    "slug": "roles-and-permissions",
    "title": "Roles and permissions",
    "category": "Getting Started",
    "categorySort": 10,
    "sort": 40,
    "summary": "What Full Admin, Marketing Admin, and General Marketing accounts can do.",
    "keywords": [
      "users",
      "access",
      "rbac",
      "permissions",
      "account",
      "invite"
    ],
    "entity": null,
    "html": "<p>There are three account roles:</p><ul><li><strong>Full Admin</strong> — everything: all content, user management, the Field</li></ul><p>  Builder, Framer field types, and data-feed settings.</p><ul><li><strong>Marketing Admin</strong> — all content editing and publishing, plus management of</li></ul><p>  General Marketing users. No data-feed or system settings.</p><ul><li><strong>General Marketing</strong> — day-to-day content work: create and edit homes,</li></ul><p>  communities, blogs, images, promotions, and publish them.</p><p>All three roles can publish and unpublish content.</p><p>User accounts are managed under <code>Settings → Users</code> (Full Admin; Marketing<br>Admins can add General Marketing users).</p>"
  },
  {
    "slug": "how-a-new-home-appears",
    "title": "How a new home appears (and how to publish it)",
    "category": "Homes (Quick Move-Ins)",
    "categorySort": 20,
    "sort": 10,
    "summary": "New homes arrive from Snowflake as Drafts — your job is to review, polish, and publish.",
    "keywords": [
      "create house",
      "new home",
      "qmi",
      "spec",
      "add home",
      "publish home"
    ],
    "entity": "qmi",
    "html": "<p><strong>You don't create homes by hand.</strong> When a new spec home is entered in<br>MarkSystems, it appears in <code>Quick Move-Ins</code> automatically — usually within<br>4 hours — as a <code>Draft</code> with its facts pre-filled: address, price, beds/baths,<br>square footage, community, floor plan, construction stage, and move-in date.</p><h2>Publishing checklist</h2><ol><li>Open <code>Quick Move-Ins</code> and filter the list to <code>Draft</code> to see new arrivals.</li><li>Open the home. Check the pre-filled facts look right (they're synced — see</li></ol><p>   <em>Synced fields and overrides</em> if something needs a manual exception).</p><ol><li>Confirm the right <code>Floor Plan</code> is linked — it supplies the plan</li></ol><p>   description, plan images, and brochure details automatically.</p><ol><li>Add photos: a featured image and gallery shots. See <em>Add photos to a home</em>.</li><li>Add marketing touches as needed: <code>Description</code>, <code>Incentive</code>,</li></ol><p>   <code>Promo Text</code>, <code>Virtual Tour URL</code>.</p><ol><li>Set <code>Status</code> to <code>Live</code> (or <code>Coming Soon</code> to tease it first).</li></ol><h2>What happens next</h2><p>The home's page goes live on esperanzahomes.com within moments, it joins the<br>Quick Move-Ins listings and filters, and its PDF brochure is generated<br>automatically.</p><h2>If a home you expect isn't here</h2><p>It hasn't reached Snowflake as a spec home yet, or its community name doesn't<br>match — check with the team that enters homes in MarkSystems, or ask a Full<br>Admin to check the sync dashboard.</p>"
  },
  {
    "slug": "add-photos-to-a-home",
    "title": "Add photos to a home",
    "category": "Homes (Quick Move-Ins)",
    "categorySort": 20,
    "sort": 20,
    "summary": "Featured image, gallery shots, and how home photos relate to floor-plan photos.",
    "keywords": [
      "images",
      "photos",
      "gallery",
      "featured",
      "upload",
      "pictures"
    ],
    "entity": "qmi",
    "html": "<ol><li>Open the home in <code>Quick Move-Ins</code>.</li><li>In the media panel, use the image controls to upload:</li></ol><ul><li><code>Featured Image</code> — the hero shot used on cards and at the top of the page.</li><li>Gallery images — additional shots in display order.</li></ul><ol><li><code>Save</code>.</li></ol><p>Uploads are stored in the central image library and served from our own CDN —<br>you can reuse any image already in <code>Images</code> instead of re-uploading.</p><h2>Good to know</h2><ul><li>If a home has <strong>no photos of its own</strong>, its page falls back to the linked</li></ul><p>  floor plan's images, so a brand-new home never looks empty. Replace them<br>  with real photos when you have them.</p><ul><li>Use wide (landscape) shots for the featured image — it's cropped to wide</li></ul><p>  cards in several places.</p><ul><li>Plan-level renderings belong on the <strong>Floor Plan</strong>, not the home; they then</li></ul><p>  appear on every home of that plan automatically.</p>"
  },
  {
    "slug": "override-a-price-or-detail",
    "title": "Override a price or detail on a home",
    "category": "Homes (Quick Move-Ins)",
    "categorySort": 20,
    "sort": 30,
    "summary": "Pin a manual value on one field while the rest of the home keeps syncing.",
    "keywords": [
      "price change",
      "override",
      "special price",
      "edit price",
      "manual"
    ],
    "entity": "qmi",
    "html": "<p>Prices and home facts sync from MarkSystems automatically. To show a<br><em>different</em> value on the website without fighting the sync:</p><ol><li>Open the home and find the field (for example <code>Price</code>).</li><li>Tick <code>Unlock to override</code>.</li><li>Enter your value and <code>Save</code>.</li></ol><p>The field shows an <code>override</code> badge. Your value is what visitors see, and it<br>sticks — syncs update everything else but never touch an overridden field.</p><p>To go back to the synced value, untick the checkbox and <code>Save</code>.</p><p>For the full story (which fields sync, when to override vs. fix upstream),<br>see <em>Synced fields and overrides</em>.</p>"
  },
  {
    "slug": "when-a-home-sells",
    "title": "When a home sells",
    "category": "Homes (Quick Move-Ins)",
    "categorySort": 20,
    "sort": 40,
    "summary": "Sold homes leave the site automatically — here's the timeline and the manual option.",
    "keywords": [
      "sold",
      "settlement",
      "remove home",
      "unpublish",
      "off market"
    ],
    "entity": "qmi",
    "html": "<p>When a home completes settlement in MarkSystems, the next sync (within<br>4 hours) <strong>automatically unpublishes it</strong> — its page comes off the website and<br>it drops out of the listings. Nothing for you to do.</p><h2>Take a home down sooner</h2><p>If a home needs to come off the site right now (went under contract, listing<br>issue):</p><ol><li>Open the home in <code>Quick Move-Ins</code>.</li><li>Set <code>Status</code> to <code>Draft</code> and <code>Save</code>.</li></ol><p>It disappears from the site within moments. Note: if the home is still an<br>active spec home in MarkSystems it will NOT re-publish itself — <code>Live</code> is<br>always a human decision.</p>"
  },
  {
    "slug": "floor-plan-layout-image",
    "title": "Add the floor plan layout image",
    "category": "Floor Plans",
    "categorySort": 25,
    "sort": 10,
    "summary": "Upload the top-down floor plan layout that appears on the plan and on every home of that plan.",
    "keywords": [
      "floor plan",
      "layout",
      "image",
      "blueprint",
      "schematic",
      "drawing",
      "upload"
    ],
    "entity": "floor_plans",
    "html": "<p>The <strong>Floor Plan Image</strong> is the top-down layout drawing (rooms, dimensions,<br>first/second floor) for a plan — not an exterior elevation or a photo.</p><ol><li>Open the plan in <code>Floor Plans</code>.</li><li>In the image controls, use <strong>Floor Plan Image</strong> to upload the layout drawing</li></ol><p>   (PNG or JPG). One image per plan.</p><ol><li><code>Save</code>.</li></ol><h2>Good to know</h2><ul><li>This image lives on the <strong>plan</strong>, so it automatically appears on **every</li></ul><p>  Quick Move-In home of that plan** — you only upload it once. You do not set a<br>  floor plan image on individual homes.</p><ul><li>It is a separate field from <code>Main Image</code> and the hero images, which are the</li></ul><p>  exterior/marketing shots. Keep the layout drawing here and the exterior shots<br>  in those fields.</p><ul><li>Uploads are stored in the central image library and served from our own CDN.</li><li>After saving, the image reaches the live site on the next publish (see</li></ul><p>  <em>How changes reach the site</em>). If a plan has no layout image yet, the plan and<br>  its homes simply omit it — nothing breaks.</p>"
  },
  {
    "slug": "add-a-new-community",
    "title": "Add a new community",
    "category": "Communities",
    "categorySort": 30,
    "sort": 10,
    "summary": "Create the record, get the name right so Snowflake recognizes it, then fill content.",
    "keywords": [
      "new community",
      "create community",
      "development",
      "neighborhood"
    ],
    "entity": "communities",
    "html": "<p>Communities ARE created by hand (unlike homes). The one rule that matters:</p><blockquote><p>**The community <code>Name</code> must match the development name used in<br>MarkSystems.** That's how the sync recognizes it and auto-fills the<br>square-footage range, bed/bath ranges, and <code>Price From</code> — and how new homes<br>link themselves to the community automatically.</p></blockquote><h2>Steps</h2><ol><li>Open <code>Communities</code> → <code>New</code>.</li><li>Enter the <code>Name</code> (matching MarkSystems) and the basics: <code>Town</code>, <code>Address</code>,</li></ol><p>   map coordinates, and link the <code>City</code>.</p><ol><li><code>Save</code> — then work through the content checklist (see *Community content</li></ol><p>   checklist*).</p><ol><li>Keep it <code>Draft</code> or set <code>Coming Soon</code> while content is in progress; flip to</li></ol><p>   <code>Live</code> when it's ready.</p><h2>What syncs vs. what you write</h2><p>Once homes for this community exist in Snowflake, the locked fields<br>(<code>Sq Ft Range</code>, <code>Bed Count</code>, <code>Bath Count</code>, <code>Price From</code>) fill and maintain<br>themselves. Everything else — copy, photos, amenities, utilities, office info —<br>is yours.</p><h2>If the name can't match yet</h2><p>If marketing names a community before it exists in MarkSystems (or the names<br>legitimately differ), the synced fields simply stay empty — enter values<br>manually via <code>Unlock to override</code>, and ask a Full Admin to add a name mapping<br>so it links up later.</p>"
  },
  {
    "slug": "community-content-checklist",
    "title": "Community content checklist",
    "category": "Communities",
    "categorySort": 30,
    "sort": 20,
    "summary": "Everything a community page needs before it goes Live.",
    "keywords": [
      "community page",
      "copy blocks",
      "amenities",
      "utilities",
      "office hours"
    ],
    "entity": "communities",
    "html": "<p>A complete community page has:</p><h2>Essentials</h2><ul><li><code>Description</code> — the main marketing copy.</li><li><code>Featured Image</code>, <code>Secondary Image</code>, photo gallery, and the community logo.</li><li>Map coordinates (drives the map pin and <em>Get Directions</em>).</li></ul><h2>Copy blocks (each renders as a titled section)</h2><ul><li><code>Amenities</code></li><li><code>Education</code> — schools and district info.</li><li>Design / construction / energy blocks: exterior &amp; interior construction,</li></ul><p>  energy package, kitchen and bath features, conservation &amp; landscape, and<br>  the Esperanza Difference.</p><h2>Utilities</h2><ul><li><code>Electric Details</code>, <code>Water Details</code>, <code>Internet Details</code>, <code>Gas Details</code>,</li></ul><p>  <code>Security Details</code> — provider, link, phone.</p><h2>Sales info</h2><ul><li><code>Office Phone Number</code>, <code>Office Hours</code>, <code>Schedule Visit</code> link, <code>Lending</code> link.</li></ul><h2>Optional</h2><ul><li><code>Incentive</code> banner text, <code>Community Map Embed</code> (interactive lot map),</li></ul><p>  features/resources PDFs, <code>Featured Video</code>.</p><p>Tip: open an established community (e.g. a Tres Lagos one) side-by-side as a<br>reference for tone and length.</p>"
  },
  {
    "slug": "floor-plans-per-community",
    "title": "Set the floor plans offered in a community",
    "category": "Communities",
    "categorySort": 30,
    "sort": 25,
    "summary": "Pick which floor plans a community offers from the community's edit page.",
    "keywords": [
      "floor plans",
      "community",
      "offered plans",
      "plans available",
      "assign floor plan",
      "floor plans offered"
    ],
    "entity": "communities",
    "html": "<p>Each community shows a list of the floor plans you can build there. You set that<br>list from the community's own edit page.</p><h2>Steps</h2><ol><li>Open <code>Communities</code> → pick the community → scroll to the <strong>Floor Plans Offered</strong></li></ol><p>   panel (below the main form).</p><ol><li>Check every floor plan that's available in this community; uncheck any that</li></ol><p>   aren't. Use the filter box to find a plan quickly.</p><ol><li>Click <strong>Save floor plans</strong>. (This panel saves on its own — separate from the</li></ol><p>   main <em>Save</em> button at the top of the form.)</p><p>That's it. The website updates within moments: each plan you checked now lists<br>this community, and each one you unchecked drops it.</p><h2>How it actually works</h2><p>The relationship is stored <strong>on the floor plan</strong>, not the community — every floor<br>plan carries the list of communities it's offered in (and a count). Editing from<br>the community page just adds or removes <em>this</em> community's name on the plans you<br>changed. So:</p><ul><li>The same plan can belong to several communities (e.g. Marzano in Aquero,</li></ul><p>  Cielo Vista, and Villas at La Sienna).</p><ul><li>You can edit the list from here, and a plan will correctly show up under every</li></ul><p>  community it belongs to.</p><ul><li>Only the plans you actually changed are touched and re-pushed to the site —</li></ul><p>  leaving the others alone keeps things fast and avoids needless churn.</p><h2>Notes</h2><ul><li>A community needs a <strong>Name</strong> before you can link plans (the link is by name).</li><li>New floor plans you just created show up in the list immediately.</li><li>This does <strong>not</strong> publish anything — a plan still has to be Live on its own page</li></ul><p>  to appear on the site. See <em>How a new home appears</em> and <em>Statuses explained</em>.</p>"
  },
  {
    "slug": "create-and-publish-a-blog",
    "title": "Create and publish a blog post",
    "category": "Blogs",
    "categorySort": 40,
    "sort": 10,
    "summary": "From new post to live on the site, including SEO fields.",
    "keywords": [
      "blog",
      "post",
      "article",
      "news",
      "write",
      "seo"
    ],
    "entity": "blogs",
    "html": "<ol><li>Open <code>Blogs</code> → <code>New</code>.</li><li>Fill the essentials:</li></ol><ul><li><code>Title</code> — the headline.</li><li><code>Slug</code> — the URL piece (auto-suggested from the title; keep it short,</li></ul><p>     lowercase, hyphenated). Don't change it after publishing — it breaks<br>     shared links.</p><ul><li><code>Category</code> — used for filtering on the blog index.</li><li><code>Excerpt</code> — 1–2 sentences shown on blog cards.</li></ul><ol><li>Write the <code>Content</code>. Use headings to break up sections; images can be</li></ol><p>   placed inline from the library.</p><ol><li>Upload the <code>Featured Image</code> (wide/landscape — it's the card and hero).</li><li>SEO: write a <code>SEO Description</code> (~155 characters, reads like a search</li></ol><p>   result). If the post is about one community, set <code>Community</code> so the post<br>   cross-links.</p><ol><li>Set the <code>Publish Date</code> and toggle published.</li></ol><h2>What happens next</h2><p>The post appears on the blog index and its own page within moments. Date<br>shown is the <code>Publish Date</code> you set, so backdating or scheduling-by-date works.</p>"
  },
  {
    "slug": "create-a-promotion",
    "title": "Create a promotion or incentive",
    "category": "Promotions & Incentives",
    "categorySort": 50,
    "sort": 10,
    "summary": "Banner, badge, copy, CTA, image, and scheduling — the anatomy of a promotion.",
    "keywords": [
      "incentive",
      "promo",
      "special",
      "offer",
      "banner",
      "badge",
      "deal",
      "campaign"
    ],
    "entity": "promotions",
    "html": "<p>Promotions are reusable offers (\"$15K Your Way\", rate buydowns, closing-cost<br>credits) that render on the website as banners, badges, and detail sections on<br>the pages you target.</p><h2>Steps</h2><ol><li>Open <code>Promotions</code> → <code>New</code>.</li><li>Fill the pieces (each renders in a different place):</li></ol><ul><li><code>Title</code> — internal name and the offer's heading.</li><li><code>Banner Text</code> — the short strip shown across targeted pages.</li><li><code>Badge Text</code> — the small chip on listing cards (keep it ~2–4 words).</li><li><code>Copy</code> — the full offer description and fine print.</li><li><code>CTA Label</code> + <code>CTA URL</code> — the button (\"Get Details\" → a landing page or</li></ul><p>     form).</p><ul><li>Promotion image — used on promo cards/sections.</li></ul><ol><li>Schedule it: set <code>Start Date</code> and <code>End Date</code>. The promotion turns itself on</li></ol><p>   and off on those dates — no midnight edits. Leave them blank for always-on.</p><ol><li>Choose where it appears (see <em>Target a promotion</em> — this is the important</li></ol><p>   part).</p><ol><li>Toggle published and <code>Save</code>.</li></ol><h2>Promotion vs. the Incentive text fields</h2><p>Homes, communities, cities, floor plans, and collections also have a plain<br><code>Incentive</code> text field. Use that for a one-off line on a single record. Use a<br><strong>Promotion</strong> when the offer has dates, a CTA, a badge, or applies to more<br>than one page — and so it can be retired in one place when it ends.</p>"
  },
  {
    "slug": "target-a-promotion",
    "title": "Target a promotion at specific pages",
    "category": "Promotions & Incentives",
    "categorySort": 50,
    "sort": 20,
    "summary": "Global, City, Community, or single Home — and which promotion wins when several apply.",
    "keywords": [
      "targeting",
      "scope",
      "location",
      "where",
      "specific pages",
      "apply",
      "audience"
    ],
    "entity": "promotions",
    "html": "<p>Every promotion has a <strong>Promotion Location</strong> — where on the site it applies:</p><ul><li><code>Global</code> — every page that shows promotions, site-wide.</li><li><code>City</code> — every community and home in that city.</li><li><code>Community</code> — that community's page and all its homes.</li><li><code>Home</code> — one specific Quick Move-In.</li></ul><p>Pick the targets on the promotion's page; a promotion can have several<br>(e.g. two communities).</p><h2>Which promotion shows when several apply?</h2><p>A page shows <strong>one</strong> promotion. The most <em>specific</em> match wins:</p><blockquote><p><code>Home</code> beats <code>Community</code> beats <code>City</code> beats <code>Global</code>.</p></blockquote><p>Ties (two promotions at the same level) go to the one with the lower<br><code>Sort Order</code> number.</p><h2>Worked examples</h2><ul><li>Site-wide \"$10K Your Way\" (<code>Global</code>) + \"Las Brisas Closeout\" targeting</li></ul><p>  <em>Las Brisas</em> (<code>Community</code>): Las Brisas pages and homes show <strong>Closeout</strong>;<br>  everywhere else shows <strong>$10K Your Way</strong>.</p><ul><li>Add \"Final Lot Special\" on one home (<code>Home</code>): that home's page shows the</li></ul><p>  special; the rest of Las Brisas still shows Closeout.</p><h2>Checklist when an offer ends</h2><p>Set an <code>End Date</code> up front and the promotion retires itself everywhere at<br>once. Otherwise, unpublish it — every targeted page updates within moments.</p>"
  },
  {
    "slug": "how-changes-reach-the-site",
    "title": "How changes reach the live site (and what to check when they don't)",
    "category": "Publishing",
    "categorySort": 60,
    "sort": 10,
    "summary": "The publish pipeline, expected timing, and a troubleshooting checklist.",
    "keywords": [
      "not showing",
      "not updating",
      "publish",
      "sync",
      "live site",
      "troubleshoot",
      "cache"
    ],
    "entity": null,
    "html": "<h2>The pipeline</h2><ol><li>You <code>Save</code> in the admin → the change lands in the database instantly.</li><li>The website is pushed the change <strong>immediately</strong> (typically under a</li></ol><p>   minute). A nightly sweep re-pushes everything as a safety net.</p><ol><li>Snowflake-driven changes (prices, new homes, sold homes) arrive on the</li></ol><p>   sync schedule — every 4 hours — then push to the site the same way.</p><ol><li>PDF brochures regenerate automatically after content changes.</li></ol><h2>\"My change isn't showing\" checklist</h2><ol><li><strong>Is the record <code>Live</code>?</strong> A <code>Draft</code> never appears, and <code>Coming Soon</code> shows</li></ol><p>   only the teaser page.</p><ol><li><strong>Hard-refresh</strong> the page (Cmd+Shift+R) — your browser may be showing its</li></ol><p>   own cached copy.</p><ol><li><strong>Wait one minute</strong> and refresh again — pushes are fast but not literally</li></ol><p>   instant.</p><ol><li><strong>Is the field synced (lock badge)?</strong> If you edited upstream in</li></ol><p>   MarkSystems, it appears after the next 4-hour sync. If you need it now,<br>   use <code>Unlock to override</code>.</p><ol><li>Still stuck after ~10 minutes? Tell a Full Admin — they can check the sync</li></ol><p>   dashboard and re-push.</p>"
  }
];
