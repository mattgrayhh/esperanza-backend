// =============================================================================
// Settings → Framer Field Types (Phase C). FULL-ADMIN gated.
//
// Server component: gates on the Auth.js session role === 'admin' (403 otherwise),
// loads every entity's field_definitions into per-entity sections (build-framer-types),
// and hands them to the client tab. Edits stage CLIENT-SIDE; the sticky "Apply N
// changes to Framer" button commits the batch via the applyFramerTypes server action
// (which is ALSO Full-Admin gated).
// =============================================================================

import { isAdmin } from '@/lib/auth';
import { buildFramerTypesModel } from '@/lib/build-framer-types';
import { FRAMER_TYPES } from '@/lib/framer-types';
import { FramerFieldTypes } from '@/components/framer-types/FramerFieldTypes';
import { ShieldAlertIcon } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function FramerTypesSettingsPage() {
  if (!(await isAdmin())) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-3 py-24 text-center">
        <ShieldAlertIcon className="size-10 text-muted-foreground" />
        <h1 className="font-heading text-xl font-bold text-foreground">403 — Full Admin only</h1>
        <p className="text-sm text-muted-foreground">
          Framer Field Types re-shapes the live Framer CMS schema, so it&apos;s restricted to
          Full Admins. Ask an administrator if you need access.
        </p>
      </div>
    );
  }

  const sections = await buildFramerTypesModel();
  // Only the SETTABLE Framer types are offered as targets (enum is display-only).
  const framerTypes = FRAMER_TYPES.filter((t) => t.settable).map((t) => ({
    value: t.value,
    label: t.label,
  }));

  return <FramerFieldTypes sections={sections} framerTypes={framerTypes} />;
}
