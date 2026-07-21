/* community-homes-live — Quick Move-In cards on community and floor-plan detail pages.
 *
 * When the static build omitted the #specs section (or all cards were pruned), fetch
 * published QMIs from the public API and render the section at runtime. When baked
 * [data-qmi-slug] cards exist, reconcile them: drop unpublished homes and refresh promo
 * banner text + color from promo_text / promo_banner_style.
 *
 * Config: window.__ESPERANZA, page context: window.__ESPERANZA_PAGE. */
(function () {
  'use strict';
  var P = window.__ESPERANZA_PAGE;
  if (!P || !P.id || (P.type !== 'community' && P.type !== 'floorplan')) return;

  var CFG = window.__ESPERANZA || {};
  var API = CFG.API_BASE || '/api/public';
  var fetchT = function (u, ms) {
    return fetch(u, AbortSignal.timeout ? { signal: AbortSignal.timeout(ms || 10000) } : {});
  };

  var STAT = '/static/esperanza_homes/images/stats/';
  var ICON = {
    bed: STAT + 'bedroom%EF%B9%96v=7516482.svg',
    bath: STAT + 'bathroom%EF%B9%96v=f390d85.svg',
    garage: STAT + 'garage%EF%B9%96v=f234cc0.svg',
    story: STAT + 'stairs%EF%B9%96v=348b88c.svg',
    living: STAT + 'livingsqft%EF%B9%96v=fc46974.svg',
    total: STAT + 'sqft%EF%B9%96v=64b8d65.svg',
  };

  var un = function (v) { return Array.isArray(v) ? v[0] : v; };
  var IMG_TX = 'format=auto,quality=82,width=1600';
  var fixHost = function (u) {
    if (!u) return u;
    var s = String(u).replace(/^https:\/\/pub-9c9bfee574a54b62b2623e361b3ad305\.r2\.dev/, 'https://img.hazardhouse.ai');
    if (/^https:\/\/img\.hazardhouse\.ai\//.test(s) && s.indexOf('/cdn-cgi/image/') === -1 && /\.(jpe?g|png|webp|avif)($|\?)/i.test(s)) {
      s = s.replace('https://img.hazardhouse.ai/', 'https://img.hazardhouse.ai/cdn-cgi/image/' + IMG_TX + '/');
    }
    return s;
  };
  var money = function (n) { return '$' + Number(n || 0).toLocaleString('en-US'); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var slugify = function (s) {
    return String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  };

  var LINKS = { qmi: {} };
  var FACTS = { rate: null, taxMult: {}, badges: {}, lotFormat: {}, cardFacts: {} };
  var RATE = 6.15;
  var planStories = {};

  function factOf(h) {
    var cf = FACTS.cardFacts || {};
    var hit = cf[slugify(h.address)];
    if (!hit) {
      var hn = String(h.address || '').match(/^(\d+)/);
      if (hn) hit = cf[slugify(h.community) + '/' + hn[1]];
    }
    return hit || {};
  }

  function fmtLot(raw, community) {
    if (!raw) return null;
    if (!/^\d+$/.test(raw)) return raw;
    var n = String(parseInt(raw, 10));
    return ((FACTS.lotFormat || {})[slugify(community)] === 'pad3') ? ('00' + n).slice(-Math.max(3, n.length)) : n;
  }

  function monthlyPayment(price, rate, taxMult) {
    var loan = price * (1 - 0.035);
    var r = rate / 1200;
    var pi = loan * r / (1 - Math.pow(1 + r, -360));
    return Math.round((pi + price * (taxMult / 100) / 12 + price * 0.004 / 12 + loan * 0.0075 / 12) * 100) / 100;
  }

  function normalizeHome(h) {
    var f = h.fields || h;
    return {
      id: h.id,
      price: f.Price,
      beds: f.bedroom_count,
      baths: f.bathroom_count,
      garage: un(f['FP: Garage']),
      stories: f.stories_count,
      lot: (function () {
        var hn = f.housenumber != null ? String(f.housenumber).trim() : '';
        return hn || null;
      })(),
      livingSqft: f.living_square_footage,
      totalSqft: f.total_square_footage,
      community: f.Community,
      communityId: un(f['Community (Link)']),
      communitySlug: slugify(f.Community),
      collection: un(f['FP: Collection']),
      slug: f.slug,
      floorPlan: f['Floor Plan'],
      floorPlanId: un(f['Floor Plan (Link)']),
      city: f.City,
      postal: f.postal_code,
      address: f.address,
      image: fixHost(f.image_url),
      availability: f.availability_text,
      promo: f.promo_text,
      promoBannerStyle: f.promo_banner_style,
    };
  }

  function homeUrl(h) {
    var key = h.communitySlug + '/' + (h.slug || '');
    return LINKS.qmi[key] ||
      (h.slug ? '/new-homes/available/home/?slug=' + encodeURIComponent(h.slug) : '#');
  }

  function promoBannerClass(style, text) {
    if (style === 'green') return 'green';
    if (style === 'gold') return 'tan';
    text = text || '';
    if (/4\.99\s*%?/i.test(text)) return 'green';
    if (/flex/i.test(text)) return 'tan';
    return 'green';
  }

  function patchPromo(card, f) {
    var promoEl = card.querySelector('.banner.overlay-promo');
    if (!f.promo_text) {
      if (promoEl && promoEl.parentNode) promoEl.parentNode.removeChild(promoEl);
      return;
    }
    if (!promoEl) return;
    promoEl.textContent = f.promo_text;
    promoEl.classList.remove('green', 'tan');
    promoEl.classList.add(promoBannerClass(f.promo_banner_style, f.promo_text));
  }

  function commRow(h, vis) {
    var collLine = h.collection
      ? '<div class="text-brown fs-9">' + esc(h.collection) + (/collection/i.test(h.collection) ? '' : ' Collection') + '</div>'
      : '';
    return '<div class="row community-row m-0 p-2 w-100 ' + vis + '">' +
      '<div class="col text-center text-lg-start py-1"><div class="text-brown overpass bold fs-9 text-decoration-underline">COMMUNITY</div><div class="text-gray fs-9">' + esc(h.community) + '</div></div>' +
      '<div class="col text-center text-lg-start py-1 border-start"><div class="row"><div class="col-auto mx-auto"><div class="text-brown overpass bold fs-9 text-decoration-underline">FLOOR PLAN</div><div class="text-gray fs-9">' + esc(h.floorPlan) + '</div>' + collLine + '</div></div></div>' +
      '</div>';
  }

  function cardHTML(h) {
    var url = homeUrl(h);
    var img = h.image || '';
    var fact = factOf(h);
    var badge = fact.badge || FACTS.badges[slugify(h.address)];
    var promoText = h.promo || (badge ? badge.text : '');
    var promoColor = promoBannerClass(h.promoBannerStyle, promoText);
    var banners = '';
    if (promoText) banners += '<div class="banner overlay-promo ' + promoColor + '">' + esc(promoText) + '</div>';
    var availText = (fact.avail && fact.avail.text) || h.availability;
    var availColor = fact.avail ? fact.avail.color : (/available now/i.test(availText || '') ? 'green' : 'gray');
    if (availText) banners += '<div class="banner ' + availColor + '"' + (promoText ? ' style="top:2.5rem"' : '') + '>' + esc(availText) + '</div>';
    if (fact.selfTour) banners += '<div class="banner-self-tour banner"><p>Self-Touring Available</p></div>';
    var lotTxt = fact.lot || fmtLot(h.lot, h.community);
    if (lotTxt) banners += '<div class="badge lot bg-light-gray overpass light text-secondary">Lot #' + esc(lotTxt) + '</div>';

    function stat(icon, txt) {
      return '<div class="item col-12 d-flex align-items-center mb-1"><img class="me-2" src="' + icon + '" aria-hidden="true" loading="lazy" width="18">' + txt + '</div>';
    }

    if (fact.stories != null) h.stories = fact.stories;
    else if (h.floorPlan) {
      var ps = planStories[String(h.floorPlan).toLowerCase()] || planStories[slugify(h.floorPlan)];
      if (ps != null) h.stories = ps;
    }

    var stats = '';
    if (h.beds != null) stats += stat(ICON.bed, esc(h.beds) + ' Bedrooms');
    if (h.garage != null && String(h.garage) !== '0') stats += stat(ICON.garage, esc(h.garage) + ' Car Garage');
    if (h.baths != null) stats += stat(ICON.bath, esc(h.baths) + ' Bathrooms');
    if (h.stories != null) stats += stat(ICON.story, esc(h.stories) + (h.stories == 1 ? ' Story' : ' Stories'));
    if (h.livingSqft != null) stats += stat(ICON.living, Number(h.livingSqft).toLocaleString() + ' <span class="overpass bold ms-1">Living</span>&nbsp;Sq. Ft.');
    if (h.totalSqft != null) stats += stat(ICON.total, Number(h.totalSqft).toLocaleString() + ' <span class="overpass bold ms-1">Total</span>&nbsp;Sq. Ft.');

    var est = '';
    if (h.price) {
      var tax = FACTS.taxMult[slugify(h.community)] || 2.2;
      var m = fact.mStd != null ? fact.mStd : monthlyPayment(h.price, RATE, tax);
      var promoRate = promoText && (promoText.match(/([\d.]+)\s*%/) || [])[1];
      var inner;
      if (promoRate && Number(promoRate) < RATE) {
        var pm = fact.mPromo != null ? fact.mPromo : monthlyPayment(h.price, Number(promoRate), tax);
        var savings = (m - pm) * 360;
        inner = '<span class="fs-9 overpass bold text-green">$' + pm.toFixed(2) + '/mo*</span>' +
          '<span class="text-strikethrough estimated-price fs-9 overpass bold text-green" data-price="' + m.toFixed(2) + '">$' + m.toFixed(2) + '/mo*</span>' +
          '<p class="fs-9 overpass bold text-green mb-1">$' + savings.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Savings Over 30 Years</p>';
      } else {
        inner = '<span class="estimated-price fs-9 overpass bold text-green" data-price="' + m + '">$' + m.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '/mo*</span>';
      }
      est = '<a href="' + esc(url) + '#mortgage-calculator" class="lh-1">' +
        '<span class="fs-9 overpass text-gray">ESTIMATED MONTHLY</span><br>' +
        '<span class="fs-9 overpass text-gray">PRICE: </span>' + inner +
        '</a>';
    }

    return '<div class="col-12 col-md-6 mb-2" data-qmi-slug="' + esc(h.slug) + '">' +
      '<div class="card spec-card spec-card-detail mb-0 border border-gray p-2 h-100">' +
      '<div class="row m-0 h-100">' +
      '<div class="col-12 col-xl-7 px-0 pe-xl-3 d-flex align-content-stretch flex-wrap">' +
      '<div class="oi-aspect sixteen-nine four-three-xl three-two-xxl">' + banners +
      '<a href="' + esc(url) + '">' +
      (img ? '<img src="' + esc(img) + '" loading="lazy" class="oi-aspect-img" alt="' + esc(h.address) + '">' : '') +
      '</a>' +
      '<div class="hover-button d-none d-lg-flex"><div class="m-auto">' +
      '<a href="' + esc(url) + '"><div class="btn card-button d-block my-3">VIEW HOME</div></a>' +
      '<a href="' + esc(url) + '#request-a-tour"><div class="btn card-button green d-block my-3">REQUEST A TOUR</div></a>' +
      '</div></div></div>' +
      commRow(h, 'd-none d-xl-flex') +
      '</div>' +
      '<div class="col-12 col-xl px-0 px-xl-1"><div class="card-body d-flex flex-column lh-2 h-100 px-xl-0 py-xl-1">' +
      '<div class="row"><a href="' + esc(url) + '"><div class="card-title lh-1 mb-1 d-flex justify-content-between align-items-center">' + esc(h.address) + '</div></a>' +
      '<div class="card-location text-green mb-2">' + esc(h.city) + ', TX' + (h.postal ? ' ' + esc(h.postal) : '') + '</div></div>' +
      '<div class="row h-100"><div class="col-6 col-xl-12 d-flex align-content-xl-around flex-wrap">' +
      '<div class="w-100"><div class="spec-price lh-1 mt-2 mb-3">' + money(h.price) + '</div>' + est + '</div></div>' +
      '<div class="col-auto col-xl-12 stat-group mt-xl-2 stat-flex d-flex flex-column mx-auto">' + stats + '</div></div>' +
      '</div></div>' +
      commRow(h, 'd-flex d-xl-none') +
      '</div></div></div>';
  }

  function byPriceAsc(a, b) {
    var pa = a.price > 0 ? a.price : Infinity;
    var pb = b.price > 0 ? b.price : Infinity;
    return pa === pb ? 0 : pa - pb;
  }

  function filterHomes(homes) {
    if (P.type === 'community') {
      return homes.filter(function (h) { return h.communityId === P.id; });
    }
    return homes.filter(function (h) { return h.floorPlanId === P.id; });
  }

  function ensureSpecsSection(homes) {
    var sec = document.getElementById('specs');
    var grid;
    if (sec) {
      grid = sec.querySelector('.oi-listings');
      if (!grid) {
        grid = document.createElement('div');
        grid.className = 'row oi-listings mt-3 g-2';
        var container = sec.querySelector('.container-lg') || sec.querySelector('.container');
        if (container) container.appendChild(grid);
      }
    } else {
      sec = document.createElement('section');
      sec.id = 'specs';
      sec.className = 'py-4 py-lg-5 pagejump';
      sec.innerHTML =
        '<div class="container-lg">' +
        '<div class="row align-items-center">' +
        '<div class="col-12 pb-sm-2 pb-lg-0 col-lg-3">' +
        '<div class="text-gray bodoni ls-sm fs-2 ps-0">Quick Move-Ins</div>' +
        '<div class="green-bar-light my-2 my-lg-3"></div></div>' +
        '<div class="col-12 col-lg-9 text-lg-end">' +
        '<a class="oi-brochure-download btn btn-primary mx-auto px-4 ms-lg-auto me-lg-0" data-bs-toggle="modal" data-bs-target="#location-specs-download-form">' +
        '<i class="fal fa-arrow-to-bottom fs-9 me-1" aria-hidden="true"></i> DOWNLOAD QUICK MOVE-INS</a></div></div>' +
        '<div class="row oi-listings mt-3 g-2"></div></div>';
      var anchor = document.getElementById('plans') || document.getElementById('overview');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(sec, anchor.nextSibling);
      else document.body.appendChild(sec);
      grid = sec.querySelector('.oi-listings');
      addNavLinks();
    }
    homes.sort(byPriceAsc);
    grid.innerHTML = homes.map(cardHTML).join('');
    sec.style.display = '';
  }

  function addNavLinks() {
    var desktop = document.getElementById('desktop-menu');
    if (desktop && !desktop.querySelector('a[href="#specs"]')) {
      var plans = desktop.querySelector('a[href="#plans"]');
      var link = document.createElement('a');
      link.href = '#specs';
      link.className = 'col on-scroll';
      link.textContent = 'Quick Move-ins';
      if (plans) desktop.insertBefore(link, plans);
      else desktop.appendChild(link);
    }
    document.querySelectorAll('.dropdown-menu').forEach(function (menu) {
      if (menu.querySelector('a[href="#specs"]')) return;
      if (!menu.querySelector('a[href="#plans"], a[href="#overview"]')) return;
      var li = document.createElement('li');
      li.innerHTML = '<a href="#specs" class="dropdown-item">Quick Move-Ins</a>';
      var plansItem = menu.querySelector('a[href="#plans"]');
      if (plansItem && plansItem.parentNode) menu.insertBefore(li, plansItem.parentNode);
      else menu.appendChild(li);
    });
  }

  function reconcileCards(cards, bySlug) {
    cards.forEach(function (card) {
      var slug = card.getAttribute('data-qmi-slug');
      if (!slug) return;
      var f = bySlug[slug];
      if (!f) {
        if (card.parentNode) card.parentNode.removeChild(card);
        return;
      }
      patchPromo(card, f);
    });
    var grid = document.querySelector('#specs .oi-listings, .oi-listings');
    if (grid && !grid.querySelector('[data-qmi-slug]')) {
      var sec = document.getElementById('specs');
      if (sec) sec.style.display = 'none';
    }
  }

  function boot() {
    var bakedCards = document.querySelectorAll('[data-qmi-slug]');
    Promise.all([
      fetchT(API + '/qmi').then(function (r) { return r.json(); }),
      fetch('/qmi-links.json').then(function (r) { return r.json(); }).catch(function () { return { qmi: {} }; }),
      fetch('/live-facts.json').then(function (r) { return r.json(); }).catch(function () { return {}; }),
      fetchT(API + '/settings').then(function (r) { return r.json(); }).catch(function () { return {}; }),
      fetchT(API + '/floorplans').then(function (r) { return r.json(); }).catch(function () { return { floorplans: [] }; }),
    ]).then(function (res) {
      if (res[1] && res[1].qmi) LINKS.qmi = res[1].qmi;
      var lf = res[2] || {};
      FACTS = {
        rate: lf.rate,
        taxMult: lf.taxMult || {},
        badges: lf.badges || {},
        lotFormat: lf.lotFormat || {},
        cardFacts: lf.cardFacts || {},
      };
      RATE = FACTS.rate || ((res[3] && res[3].settings) || {}).mortgage_rate || 6.15;
      planStories = {};
      ((res[4] && res[4].floorplans) || []).forEach(function (fp) {
        if (fp.storiesCount != null) {
          planStories[String(fp.name || '').toLowerCase()] = fp.storiesCount;
          planStories[fp.slug] = fp.storiesCount;
        }
      });

      var homes = filterHomes((res[0].homes || []).map(normalizeHome));
      if (!homes.length) {
        if (bakedCards.length) reconcileCards(bakedCards, {});
        return;
      }

      var bySlug = {};
      homes.forEach(function (h) { bySlug[h.slug] = h; });
      // Reconcile path expects raw field objects for patchPromo
      var bySlugFields = {};
      (res[0].homes || []).forEach(function (raw) {
        var f = raw.fields || raw;
        if (f && f.slug) bySlugFields[f.slug] = f;
      });

      if (bakedCards.length) {
        reconcileCards(bakedCards, bySlugFields);
      } else {
        ensureSpecsSection(homes);
      }
    }).catch(function () { /* leave page untouched on error */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
