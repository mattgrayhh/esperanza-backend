import { describe, it, expect } from 'vitest';
import { liveSitePath, resolveSlug, buildLiveSitePlacement } from '../lib/live-site';

describe('liveSitePath', () => {
  it('builds QMI paths with underscore slugs', () => {
    expect(
      liveSitePath('qmi', { id: 'rec1', slug: '3926-peggy-dr' }),
    ).toBe('/new-homes/available/3926_peggy_dr');
  });

  it('builds community and blog paths', () => {
    expect(liveSitePath('communities', { slug: 'vista-verde' })).toBe('/new-homes/vista-verde');
    expect(liveSitePath('blogs', { slug: 'my-post' })).toBe('/blog/my-post');
  });

  it('returns incentives path for promotions', () => {
    expect(liveSitePath('promotions', { slug: 'spring' })).toBe('/incentives');
  });

  it('returns null when slug is missing', () => {
    expect(liveSitePath('communities', {})).toBeNull();
  });
});

describe('buildLiveSitePlacement', () => {
  it('includes visitor status for drafts', () => {
    const p = buildLiveSitePlacement('blogs', { title: 'T', slug: 't' }, { published: false });
    expect(p.pageLabel).toBe('Blog post');
    expect(p.fullUrl).toBe('https://www.esperanzahomes.com/blog/t');
    expect(p.visitorStatus).toBe('Draft');
    expect(p.sections.length).toBeGreaterThan(0);
  });
});

describe('resolveSlug', () => {
  it('prefers viewer_slug for QMI', () => {
    expect(resolveSlug('qmi', { id: 'q', viewer_slug: 'my-viewer', slug: 'other' })).toBe('my_viewer');
  });
});
