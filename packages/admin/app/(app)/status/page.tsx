import { getStatusSnapshot } from "@/lib/status-page";
import { StatusPageView } from "@/components/status-page-view";

export const dynamic = "force-dynamic";

export default function StatusPage() {
	const snapshot = getStatusSnapshot();
	return <StatusPageView snapshot={snapshot} />;
}
