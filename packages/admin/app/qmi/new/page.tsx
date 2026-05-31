// =============================================================================
// BESPOKE QMI "new record" route: /qmi/new.
//
// The bespoke static /qmi segment (app/qmi/page.tsx + app/qmi/[id]/page.tsx) SHADOWS
// the dynamic /[entity] route for `qmi`. Without this file, /qmi/new would fall through
// to /qmi/[id] with id="new" → buildQmiDetailView('new') returns null → 404. The QMI
// list's "New" button links to /qmi/new, so this thin wrapper is required so that path
// does not 404.
//
// It reuses the EXISTING createEntity server action (no new write path) exactly like the
// generic app/[entity]/new/page.tsx, then redirects into the bespoke /qmi/{id} editor.
// =============================================================================
import { redirect } from 'next/navigation';
import { createEntity } from '../../../lib/actions';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default function NewQmiPage() {
  async function create() {
    'use server';
    const res = await createEntity('qmi');
    if (res.ok) redirect(`/qmi/${res.id}`);
    throw new Error(res.error);
  }

  return (
    <Card size="default" className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle className="text-xl">New Quick Move-In</CardTitle>
        <CardDescription>
          Creates a blank QMI record (unpublished draft). You can assign a floor plan, fill in
          fields, and publish it from the editor.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={create} className="flex gap-3">
          <Button type="submit">Create record</Button>
          <Button render={<a href="/qmi">Cancel</a>} variant="outline" />
        </form>
      </CardContent>
    </Card>
  );
}
