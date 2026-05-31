"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LogoIcon } from "@/components/logo";
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuItem,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import {
	CustomMenuButton,
	isActivePath,
	mainNavLinks,
} from "@/components/app-shared";
import { CustomSidebarRail } from "@/components/custom-sidebar-rail";

// Esperanza admin sidebar. Brand header + the two entity groups (Listings /
// Marketing) built from ENTITY_LIST in app-shared. Active route is highlighted
// via SidebarMenuButton's data-active state (mint surface + brand-green text).
export function AppSidebar() {
	const pathname = usePathname();
	const isActive = (path?: string) => isActivePath(path, pathname);

	return (
		<Sidebar
			className={cn(
				"*:data-[slot=sidebar-inner]:bg-background",
				"duration-(--sidebar-animation-duration) ease-(--sidebar-animation-ease)"
			)}
			variant="sidebar"
		>
			<SidebarHeader className="gap-0 p-0">
				<div className="relative flex h-(--app-header-height,3.5rem) flex-row items-center justify-between border-b px-3">
					<Link
						className="flex w-max items-center gap-2 font-heading font-semibold text-foreground text-sm"
						href="/"
					>
						<LogoIcon className="h-5 w-5 text-primary" />
						<span>Esperanza Admin</span>
					</Link>
					<SidebarTrigger
						className={cn(
							"absolute top-3.5 right-4 z-60! md:hidden lg:flex",
							"transition-[right] duration-(--sidebar-animation-duration) ease-(--sidebar-animation-ease)"
						)}
					/>
				</div>
			</SidebarHeader>
			<SidebarContent>
				{mainNavLinks.map((group) => (
					<SidebarGroup key={group.label}>
						<SidebarGroupLabel>{group.label}</SidebarGroupLabel>
						<SidebarMenu>
							{group.items.map((item) => (
								<SidebarMenuItem key={item.title}>
									<CustomMenuButton
										isActive={isActive(item.path)}
										render={<Link href={item.path ?? "#"} />}
									>
										{item.icon}
										<span>{item.title}</span>
									</CustomMenuButton>
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					</SidebarGroup>
				))}
			</SidebarContent>
			<CustomSidebarRail />
		</Sidebar>
	);
}
