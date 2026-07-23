/* schedule-tour-hubspot-live — replace native "Schedule An Exploratory Visit"
 * forms (detailpagescheduletourform, generalscheduletourform) with a HubSpot embed.
 *
 * Canonical copy lives here; mirror to esperanza-frontend and include on every page
 * that may show a schedule-tour form (global footer is simplest). community-homes-live.js
 * and available-live.js also load this file when those forms are present.
 *
 * HubSpot: portal 8139268, form 97ec81f8-e976-448d-aa61-dc4853b8ac10 */
(function () {
  'use strict';
  var PORTAL_ID = '8139268';
  var FORM_ID = '97ec81f8-e976-448d-aa61-dc4853b8ac10';
  var REGION = 'na1';
  var NATIVE_FORM_IDS = ['detailpagescheduletourform', 'generalscheduletourform'];

  function loadHubSpot(cb) {
    if (window.hbspt && window.hbspt.forms) {
      cb();
      return;
    }
    var existing = document.querySelector('script[src*="js.hsforms.net/forms/embed/v2.js"]');
    if (existing) {
      existing.addEventListener('load', cb);
      return;
    }
    var s = document.createElement('script');
    s.charset = 'utf-8';
    s.type = 'text/javascript';
    s.src = 'https://js.hsforms.net/forms/embed/v2.js';
    s.onload = cb;
    document.head.appendChild(s);
  }

  function replaceNativeForm(formEl) {
    var targetId = formEl.id + '-hubspot';
    var container = document.createElement('div');
    container.id = targetId;
    container.className = 'hubspot-schedule-tour-form';
    formEl.parentNode.replaceChild(container, formEl);
    return targetId;
  }

  function boot() {
    var targets = [];
    NATIVE_FORM_IDS.forEach(function (id) {
      var form = document.getElementById(id);
      if (form) targets.push(replaceNativeForm(form));
    });
    if (!targets.length) return;

    loadHubSpot(function () {
      if (!window.hbspt || !window.hbspt.forms) return;
      targets.forEach(function (targetId) {
        window.hbspt.forms.create({
          portalId: PORTAL_ID,
          formId: FORM_ID,
          region: REGION,
          target: '#' + targetId,
        });
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
