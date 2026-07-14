// =============================================================================
// THIN Communities "new record" route: /communities/new.
//
// The bespoke static /communities segment (app/communities/[id]/page.tsx) SHADOWS the
// dynamic /[entity] route for `communities`. Without this file, /communities/new falls
// through to /communities/[id] with id="new" → buildCommunityDetailView('new') returns
// null → notFound() → 404. The list "Add" affordance links to /communities/new, so this
// thin wrapper is required so that path does not 404 (same pattern as blogs/new, qmi/new).
//
// It reuses the EXISTING createEntity server action (no new write path), then redirects
// into the /communities/{id} editor.
// =============================================================================

import { redirect } from "next/navigation"
import { createEntity } from "@/lib/actions"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export const dynamic = "force-dynamic"

export default function NewCommunityPage() {
  async function create() {
    "use server"
    const res = await createEntity("communities")
    if (res.ok) redirect(`/communities/${res.id}`)
    throw new Error(res.error)
  }

  return (
    <Card size="default" className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle className="text-xl">New Community</CardTitle>
        <CardDescription>
          Creates a blank community (unpublished draft). Fill in the name, location, description,
          and other fields, then publish it from the editor.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={create} className="flex gap-3">
          <Button type="submit">Create community</Button>
          <Button render={<a href="/communities">Cancel</a>} variant="outline" />
        </form>
      </CardContent>
    </Card>
  )
}
