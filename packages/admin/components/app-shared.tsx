import { cn } from "@/lib/utils";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { LayoutGridIcon, RocketIcon, BarChart3Icon, DatabaseIcon, LayersIcon, PlugIcon, KeyRoundIcon, TerminalIcon, HelpCircleIcon, SettingsIcon } from "lucide-react";

export type SidebarNavItem = {
	title: string;
	path?: string;
	icon?: React.ReactNode;
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
				"text-muted-foreground data-active:text-sidebar-accent-foreground data-active:[&>span]:font-medium",
				className
			)}
			{...props}
		/>
	);
}

export const mainNavLinks: SidebarNavGroup[] = [
	{
		label: "Platform",
		items: [
			{
				title: "Overview",
				path: "#/overview",
				icon: (
					<LayoutGridIcon
					/>
				),
			},
			{
				title: "Deployments",
				path: "#/deployments",
				icon: (
					<RocketIcon
					/>
				),
			},
			{
				title: "Analytics",
				path: "#/analytics",
				icon: (
					<BarChart3Icon
					/>
				),
			},
			{
				title: "Storage",
				path: "#/storage",
				icon: (
					<DatabaseIcon
					/>
				),
			},
			{
				title: "Resources",
				icon: (
					<LayersIcon
					/>
				),
				items: [
					{
						title: "Compute",
						path: "#/resources/compute",
					},
					{ title: "Databases", path: "#/resources/databases" },
					{ title: "Queues", path: "#/resources/queues" },
					{ title: "Cron Jobs", path: "#/resources/cron-jobs" },
					{ title: "Secrets", path: "#/resources/secrets" },
				],
			},
		],
	},
	{
		label: "Developer",
		items: [
			{
				title: "Integrations",
				path: "#/integrations",
				icon: (
					<PlugIcon
					/>
				),
			},
			{
				title: "API Keys",
				path: "#/api-keys",
				icon: (
					<KeyRoundIcon
					/>
				),
			},
			{
				title: "Logs",
				path: "#/logs",
				icon: (
					<TerminalIcon
					/>
				),
			},
		],
	},
];

export const footerNavGroup: SidebarNavGroup = {
	label: "General",
	items: [
		{
			title: "Support",
			path: "#/support",
			icon: (
				<HelpCircleIcon
				/>
			),
		},
		{
			title: "Settings",
			path: "#/settings",
			icon: (
				<SettingsIcon
				/>
			),
		},
	],
};

export const navLinks = [...mainNavLinks, footerNavGroup];

const ACTIVE_PATH = "#/overview";

export function isActive(path?: string) {
	if (!path) {
		return false;
	}
	return ACTIVE_PATH === path;
}
