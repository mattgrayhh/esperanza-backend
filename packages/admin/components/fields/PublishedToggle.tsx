'use client';

// =============================================================================
// PublishedToggle — the publish-gate control. The admin toggle is the ONLY path that
// sets a record live (published=1 / active=1 / status≠'Draft'); ingest's force-0-on-
// sold is separate and enforced server-side.
//
// Three gate kinds:
//   published (qmi/communities/floor_plans/blogs) → boolean, via togglePublished.
//   active    (promotions)                        → boolean, via toggleActive.
//   status    (testimonials)                      → select,  via setTestimonialStatus
//                                                     ('Draft' hides; else live).
// Each calls its dedicated server action so the publish/unpublish audit row is written
// in exactly one place.
// =============================================================================

import { useState, useTransition } from 'react';
import {
  togglePublished,
  toggleActive,
  setTestimonialStatus,
} from '../../lib/actions';

type Result = { ok: true } | { ok: false; error: string };

export function PublishedToggle({
  entityKey,
  id,
  gate,
  initialPublished,
  initialStatus,
  statusOptions,
  onResult,
}: {
  entityKey: string;
  id: string;
  /** which gate column drives this control. */
  gate: 'published' | 'active' | 'status';
  /** boolean gates: current value. */
  initialPublished?: boolean;
  /** status gate: current status string. */
  initialStatus?: string;
  /** status gate: select options. */
  statusOptions?: string[];
  /** bubble the action result up to the form for a status message. */
  onResult?: (msg: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [pub, setPub] = useState(Boolean(initialPublished));
  const [status, setStatus] = useState(initialStatus ?? '');

  function report(res: Result, okMsg: string) {
    if (res.ok) onResult?.(okMsg);
    else onResult?.(`Error: ${res.error}`);
  }

  function onToggleBoolean() {
    startTransition(async () => {
      const next = !pub;
      const res = gate === 'active' ? await toggleActive(id, next) : await togglePublished(entityKey, id, next);
      if (res.ok) setPub(next);
      report(res, next ? 'Published' : 'Unpublished');
    });
  }

  function onChangeStatus(next: string) {
    setStatus(next);
    startTransition(async () => {
      const res = await setTestimonialStatus(id, next);
      report(res, next === 'Draft' ? 'Set to Draft (hidden)' : 'Live');
    });
  }

  if (gate === 'status') {
    const opts = statusOptions ?? ['', 'Live', 'Draft'];
    const live = status !== 'Draft';
    return (
      <span className="inline-flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${live ? 'bg-[#2f5d4a]' : 'bg-gray-300'}`}
          aria-hidden
        />
        <select
          value={status}
          disabled={pending}
          onChange={(e) => onChangeStatus(e.target.value)}
          className="rounded border border-[#2f5d4a] bg-white px-2 py-1 text-sm"
          aria-label="Status"
        >
          {opts.map((o) => (
            <option key={o} value={o}>
              {o === '' ? '(unset → live)' : o}
            </option>
          ))}
        </select>
      </span>
    );
  }

  const label = gate === 'active' ? 'Active' : 'Published';
  return (
    <button
      type="button"
      onClick={onToggleBoolean}
      disabled={pending}
      className={`rounded-md border border-[#2f5d4a] px-3 py-1.5 text-sm ${
        pub ? 'bg-[#2f5d4a] text-white' : 'bg-white text-[#2f5d4a]'
      }`}
    >
      {pub ? label : `Draft — click to ${gate === 'active' ? 'activate' : 'publish'}`}
    </button>
  );
}
