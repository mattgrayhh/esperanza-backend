import { cn } from "@/lib/utils";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { ContentBorder } from "@/components/content-border";

export function AppShell({ children }: { children: React.ReactNode }) {
	return (
		<SidebarProvider
			className={cn(
				"[--sidebar-animation-duration:250ms]",
				"[--app-header-height:3.5rem]",
				"[--app-wrapper-max-width:64rem]",
				"[--sidebar-animation-ease:ease-[cubic-bezier(0.32,0.72,0,1)]]",
				"**:data-[slot=sidebar-gap]:duration-(--sidebar-animation-duration) **:data-[slot=sidebar-gap]:ease-(--sidebar-animation-ease)"
			)}
		>
			<AppSidebar />
			<SidebarInset>
				<AppHeader />
				<div className="mx-auto flex w-full max-w-(--app-wrapper-max-width) flex-1 flex-col gap-4">
					{children}
				</div>
				<ContentBorder />
			</SidebarInset>
		</SidebarProvider>
	);
}
