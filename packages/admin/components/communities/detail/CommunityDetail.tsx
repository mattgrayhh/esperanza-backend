'use client';

// =============================================================================
// CommunityDetail — the bespoke community detail screen (client shell).
//
// A single <form action={onSubmit}> wraps the editable sections so that
// saveEntity('communities', id, formData) picks up every field in one pass.
// Image uploaders (CommunityMediaBar / CommunityRemainingFields) carry their own
// hidden inputs and live inside this form — exactly like QmiDetail.
//
// PublishedToggle uses its own dedicated action (setStatus) and lives outside the
// form, in the CommunityHero children slot.
// =============================================================================

import { useState, useTransition } from 'react';
import { saveEntity } from '../../../lib/actions';
import { PublishedToggle } from '../../fields/PublishedToggle';
import { CommunityHero } from './CommunityHero';
import { CommunityStatCards } from './CommunityStatCards';
import { CommunityBasicInfo } from './CommunityBasicInfo';
import { CommunityMap } from './CommunityMap';
import { RecentActivity } from './RecentActivity';
import { CommunityMediaBar } from './CommunityMediaBar';
import { CommunityRemainingFields } from './CommunityRemainingFields';
import type { CommunityDetailView } from '../../../lib/community-detail';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function CommunityDetail({ view }: { view: CommunityDetailView }) {
  const [msg, setMsg] = useState('');
  const [isPending, startTransition] = useTransition();
  const isError = msg.startsWith('Error:');

  function onSubmit(formData: FormData) {
    startTransition(async () => {
      const res = await saveEntity('communities', view.id, formData);
      setMsg(res.ok ? 'Saved' : `Error: ${res.error}`);
    });
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      {/* ── Hero banner with status toggle as children ── */}
      <CommunityHero view={view}>
        <PublishedToggle
          entityKey="communities"
          id={view.id}
          gate="status"
          initialStatus={view.status}
          statusOptions={view.statusOptions}
          onResult={setMsg}
        />
      </CommunityHero>

      {/* ── Read-only stat cards ── */}
      <CommunityStatCards stats={view.stats} />

      {/* ── Editable form ── */}
      <form action={onSubmit} className="space-y-6">
        {/* Two-column: basic info (left) + map + activity (right) */}
        <section className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <CommunityBasicInfo fields={view.basicInfo} />
          <div className="space-y-6">
            <CommunityMap community={view.map.community} />
            <RecentActivity groups={view.activity} />
          </div>
        </section>

        {/* Compact media bar — all image fields + gallery */}
        <CommunityMediaBar id={view.id} media={view.media} />

        {/* Grouped remaining admin/synced fields in accordions */}
        <CommunityRemainingFields groups={view.remaining} id={view.id} />

        {/* ── Save button + status message ── */}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Saving…' : 'Save changes'}
          </Button>
          {msg ? (
            <span className={cn('text-sm', isError ? 'text-destructive' : 'text-muted-foreground')}>
              {msg}
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}
