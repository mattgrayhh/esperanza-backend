// Guards the incentive/promotion form's progressive-disclosure config: each surface
// section's fields are gated by that surface's toggle, and the toggles themselves are
// NOT gated (always visible). EntityEditForm reads `gatedBy` to show/hide live.
import { describe, it, expect } from 'vitest';
import { FIELD_CONFIG, type FieldConfig } from '../lib/field-config';

const fields = FIELD_CONFIG.promotions.fields;
const get = (name: string): FieldConfig => {
  const f = fields.find((x) => x.field === name);
  if (!f) throw new Error(`promotions field not found: ${name}`);
  return f;
};

describe('promotion form — surface gating (progressive disclosure)', () => {
  it('Site Banner fields are gated by show_site_banner; the toggle is not', () => {
    expect(get('show_site_banner').gatedBy).toBeUndefined();
    for (const f of ['banner_text', 'cta_label', 'cta_url']) {
      expect(get(f).gatedBy).toBe('show_site_banner');
      expect(get(f).group).toBe('Site Banner');
    }
  });

  it('Card fields (incl. the new card_* columns) are gated by show_card_cta', () => {
    expect(get('show_card_cta').gatedBy).toBeUndefined();
    for (const f of ['badge_text', 'card_button_text', 'card_button_link', 'card_copy']) {
      expect(get(f).gatedBy).toBe('show_card_cta');
      expect(get(f).group).toBe('Card');
    }
  });

  it('Incentive Page fields + the scope picker are gated by show_incentive_page', () => {
    expect(get('show_incentive_page').gatedBy).toBeUndefined();
    for (const f of ['copy', 'image_url', 'pdf_url', 'promotion_targets']) {
      expect(get(f).gatedBy).toBe('show_incentive_page');
    }
  });

  it('every gatedBy points at a real boolean toggle field on the form', () => {
    for (const f of fields) {
      if (!f.gatedBy) continue;
      const toggle = get(f.gatedBy);
      expect(toggle.widget, `gate ${f.gatedBy} for ${f.field}`).toBe('boolean');
    }
  });

  it('retired show_banner_button is hidden from the form', () => {
    expect(get('show_banner_button').visibleInForm).toBe(false);
  });
});
