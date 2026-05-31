// /settings → the Field Builder is the only Settings surface today. Redirect to it.
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function SettingsIndex() {
  redirect('/settings/fields');
}
