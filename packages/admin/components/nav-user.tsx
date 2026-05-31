"use client";

import {
	Avatar,
	AvatarFallback,
} from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOutIcon } from "lucide-react";

/** Server action wired up by the layout — calls the existing Auth.js signOut. */
export type SignOutAction = () => void | Promise<void>;

function initials(email: string): string {
	const local = email.split("@")[0] ?? email;
	const parts = local.split(/[._-]+/).filter(Boolean);
	if (parts.length >= 2 && parts[0] && parts[1]) {
		return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
	}
	return (local.slice(0, 2) || "?").toUpperCase();
}

export function NavUser({
	email,
	signOutAction,
}: {
	email: string | null;
	signOutAction: SignOutAction;
}) {
	const display = email ?? "Not signed in";

	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Avatar className="size-8 cursor-pointer" />}>
				<AvatarFallback>{email ? initials(email) : "?"}</AvatarFallback>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-60">
				<DropdownMenuItem className="flex items-center justify-start gap-2">
					<DropdownMenuLabel className="flex items-center gap-3">
						<Avatar className="size-10">
							<AvatarFallback>{email ? initials(email) : "?"}</AvatarFallback>
						</Avatar>
						<div className="min-w-0">
							<span className="font-medium text-foreground">Signed in</span>
							<br />
							<div className="max-w-full overflow-hidden overflow-ellipsis whitespace-nowrap text-muted-foreground text-xs">
								{display}
							</div>
						</div>
					</DropdownMenuLabel>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					{/* Posts to the Auth.js signOut server action (form so it works
					    without client-side fetch). */}
					<form action={signOutAction} className="w-full">
						<DropdownMenuItem
							className="w-full cursor-pointer"
							render={
								<button className="w-full" type="submit" />
							}
							variant="destructive"
						>
							<LogOutIcon />
							Sign out
						</DropdownMenuItem>
					</form>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
