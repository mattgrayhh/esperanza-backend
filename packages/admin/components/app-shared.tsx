import type { ReactNode } from "react";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { ENTITY_LIST, type EntityKey } from "@/lib/entities";
import {
	CircleHelpIcon,
	HomeIcon,
	BuildingIcon,
	MapPinIcon,
	LayoutTemplateIcon,
	TagIcon,
	LayersIcon,
	ImageIcon,
	FileTextIcon,
	QuoteIcon,
	BookOpenIcon,
	type LucideIcon,
} from "lucide-react";

// =============================================================================
// Shared nav model for the dashboard-10 shell, re-pointed at the 9 Esperanza
// admin entities. The list/labels/segments come from lib/entities.ts
// (ENTITY_LIST) — the entity registry stays the single source of truth; this
// file only adds presentation (group assignment + per-entity icon).
// =============================================================================

export type SidebarNavItem = {
	title: string;
	path?: string;
	icon?: ReactNode;
	items?: SidebarNavItem[];
};

export type SidebarNavGroup = {
	label: string;
	items: SidebarNavItem[];
};

export function CustomMenuButton({
	className,
	...props
}: React.ComponentProps<typeof SidebarMenuButton>) {
	return (
		<SidebarMenuButton
			className={cn(
				"h-9 px-2.75",
				// Labels are regular weight (feedback [14] — not bold); active item adds the
				// mint accent foreground.
				"[&>span]:font-normal text-muted-foreground data-active:text-sidebar-accent-foreground",
				className
			)}
			{...props}
		/>
	);
}

// Which sidebar group each entity belongs to, plus its icon. Keyed by EntityKey
// so the labels/segments themselves are never duplicated here — they're pulled
// from ENTITY_LIST below.
const ENTITY_PRESENTATION: Record<
	EntityKey,
	{ group: "Listings" | "Marketing"; Icon: LucideIcon }
> = {
	qmi: { group: "Listings", Icon: HomeIcon },
	communities: { group: "Listings", Icon: BuildingIcon },
	cities: { group: "Listings", Icon: MapPinIcon },
	floor_plans: { group: "Listings", Icon: LayoutTemplateIcon },
	promotions: { group: "Marketing", Icon: TagIcon },
	collections: { group: "Marketing", Icon: LayersIcon },
	images: { group: "Marketing", Icon: ImageIcon },
	blogs: { group: "Marketing", Icon: FileTextIcon },
	testimonials: { group: "Marketing", Icon: QuoteIcon },
};

function entityItem(key: EntityKey): SidebarNavItem {
	const def = ENTITY_LIST.find((e) => e.key === key);
	if (!def) {
		throw new Error(`Unknown entity key in nav presentation: ${key}`);
	}
	const { Icon } = ENTITY_PRESENTATION[key];
	return {
		title: def.label,
		path: `/${def.segment}`,
		icon: <Icon />,
	};
}

const listingsKeys = ENTITY_LIST.filter(
	(e) => ENTITY_PRESENTATION[e.key].group === "Listings"
).map((e) => e.key);
const marketingKeys = ENTITY_LIST.filter(
	(e) => ENTITY_PRESENTATION[e.key].group === "Marketing"
).map((e) => e.key);

export const mainNavLinks: SidebarNavGroup[] = [
	{ label: "Listings", items: listingsKeys.map(entityItem) },
	{ label: "Marketing", items: marketingKeys.map(entityItem) },
	{
		label: "Brochures",
		items: [
			{
				title: "PDFs",
				path: "/pdfs",
				icon: <BookOpenIcon />,
			},
		],
	},
	{
		label: "Resources",
		items: [
			{
				title: "Help & Docs",
				path: "/help",
				icon: <CircleHelpIcon />,
			},
		],
	},
];

export const navLinks = mainNavLinks;

/**
 * Pure active-route matcher (no hooks — callable from server or client).
 * A nav item is active when the current pathname equals its path or is a
 * descendant of it (so /qmi/123 keeps "Quick Move-Ins" highlighted). The home
 * link ("/") only matches exactly.
 */
export function isActivePath(itemPath: string | undefined, pathname: string): boolean {
	if (!itemPath) {
		return false;
	}
	if (itemPath === "/") {
		return pathname === "/";
	}
	return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}
