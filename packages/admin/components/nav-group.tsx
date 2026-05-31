import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { CustomMenuButton, isActive, type SidebarNavGroup } from "@/components/app-shared";
import { ChevronRightIcon } from "lucide-react";

export function NavGroup({ label, items }: SidebarNavGroup) {
	return (
		<SidebarGroup>
			<SidebarGroupLabel>{label}</SidebarGroupLabel>
			<SidebarMenu>
				{items.map((item) => (
					<Collapsible className="group/collapsible" defaultOpen={isActive(item.path) || item.items?.some((i) => isActive(i.path))} key={item.title} render={<SidebarMenuItem />}>{item.items?.length ? (
                    								<>
                    									<CollapsibleTrigger render={<CustomMenuButton isActive={isActive(item.path)} />}>{item.icon}<span>{item.title}</span><ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" /></CollapsibleTrigger>
                    									<CollapsibleContent className="transition-[height] duration-200">
                    										<SidebarMenuSub>
                    											{item.items?.map((subItem) => (
                    												<SidebarMenuSubItem key={subItem.title}>
                    													<SidebarMenuSubButton className="text-muted-foreground data-active:text-sidebar-accent-foreground!" isActive={isActive(subItem.path)} render={<a href={subItem.path} />}>{subItem.icon}<span>{subItem.title}</span></SidebarMenuSubButton>
                    												</SidebarMenuSubItem>
                    											))}
                    										</SidebarMenuSub>
                    									</CollapsibleContent>
                    								</>
                    							) : (
                    								<CustomMenuButton isActive={isActive(item.path)} render={<a href={item.path} />}>{item.icon}<span>{item.title}</span></CustomMenuButton>
                    							)}</Collapsible>
				))}
			</SidebarMenu>
		</SidebarGroup>
	);
}
