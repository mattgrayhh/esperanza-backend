"use client";

import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/ui/sidebar";

export function ContentBorder() {
	const { open } = useSidebar();
	return (
		<div
			className={cn(
				"pointer-events-none absolute inset-0 z-50",
				"mx-auto w-full max-w-[calc(var(--app-wrapper-max-width)+2px)]",
				open ? "xl:border-x" : "lg:border-x"
			)}
		/>
	);
}
