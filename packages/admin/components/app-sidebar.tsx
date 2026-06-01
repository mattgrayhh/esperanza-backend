"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LogoIcon } from "@/components/logo";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	CustomMenuButton,
	isActivePath,
	mainNavLinks,
} from "@/components/app-shared";
import { CustomSidebarRail } from "@/components/custom-sidebar-rail";
import { NavUser, type SignOutAction } from "@/components/nav-user";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";

// Esperanza admin sidebar. Brand header + the two entity groups (Listings /
// Marketing) built from ENTITY_LIST in app-shared. Active route is highlighted
// via SidebarMenuButton's data-active state (mint surface + brand-green text).
//
// `isAdmin` (Auth.js session role === 'admin') reveals the Full-Admin-only Settings
// group (the Field Builder). Non-admins never see it; the route itself is also gated.
export function AppSidebar({
	isAdmin = false,
	email = null,
	signOutAction,
}: {
	isAdmin?: boolean;
	email?: string | null;
	signOutAction: SignOutAction;
}) {
	const pathname = usePathname();
	const isActive = (path?: string) => isActivePath(path, pathname);

	return (
		<Sidebar
			className={cn(
				"*:data-[slot=sidebar-inner]:bg-background",
				"duration-(--sidebar-animation-duration) ease-(--sidebar-animation-ease)"
			)}
			collapsible="icon"
			variant="sidebar"
		>
			{/* Site selector at the TOP (feedback [20], dashboard-1 pattern). One site today;
			    the dropdown is where additional Rhodes-subsidiary sites would switch in. */}
			<SidebarHeader className="relative gap-0 border-b p-2">
				<SidebarMenu>
					<SidebarMenuItem>
						<DropdownMenu>
							<DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="gap-2" />}>
								<LogoIcon className="size-5 shrink-0 text-primary" />
								<div className="grid flex-1 text-left leading-tight">
									<span className="truncate font-heading font-semibold text-sm">
										Esperanza Homes
									</span>
									<span className="truncate text-muted-foreground text-xs">Admin</span>
								</div>
								<ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
							</DropdownMenuTrigger>
							<DropdownMenuContent
								align="start"
								className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
								sideOffset={4}
							>
								<DropdownMenuGroup>
									<DropdownMenuLabel className="text-muted-foreground text-xs">
										Site
									</DropdownMenuLabel>
									<DropdownMenuItem className="gap-2" render={<Link href="/" />}>
										<LogoIcon className="size-4 text-primary" />
										<span className="flex-1">Esperanza Homes</span>
										<CheckIcon className="size-4" />
									</DropdownMenuItem>
								</DropdownMenuGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					</SidebarMenuItem>
				</SidebarMenu>
				<SidebarTrigger
					className={cn(
						"absolute top-3.5 right-3 z-60! md:hidden lg:flex",
						"transition-[right] duration-(--sidebar-animation-duration) ease-(--sidebar-animation-ease)"
					)}
				/>
			</SidebarHeader>
			<SidebarContent>
				{mainNavLinks.map((group) => (
					<SidebarGroup key={group.label}>
						<SidebarGroupLabel className="uppercase tracking-wider">
							{group.label}
						</SidebarGroupLabel>
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
				{/* Field-Builder settings now live in the account menu (sidebar footer),
				    so the SETTINGS / Fields nav group was removed (feedback). */}
			</SidebarContent>
			{/* Account lives at the BOTTOM of the sidebar (feedback [13][20]). */}
			<SidebarFooter className="border-t">
				<NavUser email={email} signOutAction={signOutAction} isAdmin={isAdmin} />
			</SidebarFooter>
			<CustomSidebarRail />
		</Sidebar>
	);
}
