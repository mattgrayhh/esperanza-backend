import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuItem,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import {
	CustomMenuButton,
	footerNavGroup,
	isActive,
	mainNavLinks,
} from "@/components/app-shared";
import { CustomSidebarRail } from "@/components/custom-sidebar-rail";
import { LatestChange } from "@/components/latest-change";
import { NavGroup } from "@/components/nav-group";
import { Projects, type ProjectType } from "@/components/projects";

export function AppSidebar() {
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
					<a
						className="flex w-max items-center gap-2 text-foreground"
						href="#link"
					>
						<Logo className="h-3.5" />
					</a>
					<SidebarTrigger
						className={cn(
							"absolute top-3.5 right-4 z-60! md:hidden lg:flex",
							"transition-[right] duration-(--sidebar-animation-duration) ease-(--sidebar-animation-ease)",
							"group-data-[collapsible=offExamples]:-right-14"
						)}
					/>
				</div>
				<SidebarGroup className="border-b px-3 py-4">
					<Projects activeProjectId={activeProjectId} projects={projects} />
				</SidebarGroup>
			</SidebarHeader>
			<SidebarContent>
				{mainNavLinks.map((group) => (
					<NavGroup key={group.label} {...group} />
				))}
			</SidebarContent>
			<SidebarFooter className="gap-0 p-0">
				<LatestChange />
				<SidebarMenu className="border-t p-3">
					{footerNavGroup.items.map((item) => (
						<SidebarMenuItem key={item.title}>
							<CustomMenuButton className="h-6 text-muted-foreground text-xs [&>svg]:size-3.5" isActive={isActive(item.path)} render={<a href={item.path} />}>{item.icon}<span>{item.title}</span></CustomMenuButton>
						</SidebarMenuItem>
					))}
				</SidebarMenu>
			</SidebarFooter>
			<CustomSidebarRail />
		</Sidebar>
	);
}

const activeProjectId = "1";
const projects: ProjectType[] = [
	{
		id: "1",
		name: "Efferd",
		slug: "efferd",
		logo: "https://avatar.vercel.sh/efferd.svg",
	},
	{
		id: "2",
		name: "Shadcn",
		slug: "shadcn",
		logo: "https://avatar.vercel.sh/shadcn.svg",
	},
];
