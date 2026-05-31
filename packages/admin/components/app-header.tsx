"use client";

import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { AppBreadcrumbs } from "@/components/app-breadcrumbs";
import { NavUser, type SignOutAction } from "@/components/nav-user";
import { AppSearch } from "@/components/app-search";
import { isActivePath, navLinks } from "@/components/app-shared";

export function AppHeader({
	email,
	signOutAction,
}: {
	email: string | null;
	signOutAction: SignOutAction;
}) {
	const pathname = usePathname();
	const activeItem = navLinks
		.flatMap((group) => group.items)
		.find((item) => isActivePath(item.path, pathname));

	return (
		<header className="pointer-events-none sticky top-0 z-40 h-(--app-header-height) border-b">
			<div
				className={cn(
					"pointer-events-auto flex items-center justify-between px-4 md:px-6",
					"mx-auto size-full max-w-(--app-wrapper-max-width)",
					"bg-background/95 backdrop-blur-sm supports-backdrop-filter:bg-background/50"
				)}
			>
				<div className="flex items-center gap-3">
					<SidebarTrigger className="lg:hidden" />
					<Separator
						className="mr-2 h-4 data-[orientation=vertical]:self-center lg:hidden"
						orientation="vertical"
					/>
					<AppBreadcrumbs page={activeItem} />
				</div>
				<div className="flex items-center gap-3">
					<AppSearch />
					<Separator
						className="h-4 data-[orientation=vertical]:self-center"
						orientation="vertical"
					/>
					<NavUser email={email} signOutAction={signOutAction} />
				</div>
			</div>
		</header>
	);
}
