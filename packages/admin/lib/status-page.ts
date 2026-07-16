// =============================================================================
// Status page — placeholder component health until Sentry feeds are wired.
// =============================================================================

export type ComponentHealth = "operational" | "degraded" | "outage" | "maintenance";

export type StatusComponent = {
	id: string;
	name: string;
	description?: string;
	status: ComponentHealth;
	/** 0–100 placeholder uptime over the lookback window. */
	uptimePct: number;
	/** One bucket per day in the lookback (true = up that day). */
	uptimeDays: boolean[];
};

export type StatusGroup = {
	id: string;
	name: string;
	description?: string;
	components: StatusComponent[];
};

export type StatusSnapshot = {
	updatedAt: string;
	lookbackDays: number;
	overall: ComponentHealth;
	groups: StatusGroup[];
	/** Website ping cadence — placeholder until a real checker exists. */
	websitePingNote: string;
	/** Data source note shown on the page. */
	sourceNote: string;
};

const LOOKBACK_DAYS = 90;

function days(allUp: boolean, outageDayIndexes: number[] = []): boolean[] {
	const set = new Set(outageDayIndexes);
	return Array.from({ length: LOOKBACK_DAYS }, (_, i) => (allUp ? !set.has(i) : set.has(i)));
}

function pct(buckets: boolean[]): number {
	if (buckets.length === 0) return 100;
	const up = buckets.filter(Boolean).length;
	return Math.round((up / buckets.length) * 10000) / 100;
}

function component(
	id: string,
	name: string,
	opts: {
		description?: string;
		status?: ComponentHealth;
		outageDays?: number[];
	} = {}
): StatusComponent {
	const status = opts.status ?? "operational";
	const uptimeDays = days(true, opts.outageDays);
	return {
		id,
		name,
		description: opts.description,
		status,
		uptimePct: pct(uptimeDays),
		uptimeDays,
	};
}

const HEALTH_RANK: Record<ComponentHealth, number> = {
	operational: 0,
	maintenance: 1,
	degraded: 2,
	outage: 3,
};

export function worstHealth(...statuses: ComponentHealth[]): ComponentHealth {
	return statuses.reduce((worst, next) =>
		HEALTH_RANK[next] > HEALTH_RANK[worst] ? next : worst
	);
}

export function healthLabel(status: ComponentHealth): string {
	switch (status) {
		case "operational":
			return "Operational";
		case "degraded":
			return "Degraded";
		case "outage":
			return "Outage";
		case "maintenance":
			return "Maintenance";
	}
}

export function overallBannerCopy(status: ComponentHealth): string {
	switch (status) {
		case "operational":
			return "All Systems Operational";
		case "degraded":
			return "Partial System Outage";
		case "outage":
			return "Major System Outage";
		case "maintenance":
			return "Scheduled Maintenance";
	}
}

/** Indicator color for StatusIndicator / header pill. */
export function healthIndicatorColor(
	status: ComponentHealth
): "brand" | "emerald" | "amber" | "rose" | "sky" {
	switch (status) {
		case "operational":
			return "brand";
		case "degraded":
			return "amber";
		case "outage":
			return "rose";
		case "maintenance":
			return "sky";
	}
}

/**
 * Placeholder snapshot. Replace group builders with Sentry (and website ping)
 * once those integrations land — keep this shape stable for the UI.
 */
export function getStatusSnapshot(): StatusSnapshot {
	const groups: StatusGroup[] = [
		{
			id: "marksystems",
			name: "Snowflake / MarkSystems",
			description: "Sales & pricing source that feeds ingest into D1.",
			components: [
				component("snowflake", "Snowflake", {
					description: "Warehouse queries used by esperanza-ingest.",
				}),
				component("marksystems", "MarkSystems", {
					description: "Upstream listing / pricing system mirrored into Snowflake.",
				}),
			],
		},
		{
			id: "cloudflare",
			name: "Cloudflare",
			description: "Workers, queues, and edge modules that power the CMS stack.",
			components: [
				component("cf-admin", "esperanza-admin", {
					description: "Next.js CMS (OpenNext Worker).",
				}),
				component("cf-ingest", "esperanza-ingest", {
					description: "Snowflake → D1 cron + queue consumer.",
				}),
				component("cf-api", "esperanza-api", {
					description: "Public read API over v_public_* views.",
				}),
				component("cf-pdf", "esperanza-pdf", {
					description: "Brochure / list PDF renderer.",
				}),
				component("cf-ops", "esperanza-ops", {
					description: "Privileged ops MCP worker.",
				}),
				component("cf-xml-feed", "esperanza-xml-feed", {
					description: "BDX / listing XML feed (separate repo).",
				}),
				component("cf-rhodes", "rhodes-availability", {
					description: "Rhodes Living availability Worker (service binding).",
				}),
				component("cf-d1", "D1 · esperanza", {
					description: "Source-of-truth database.",
				}),
				component("cf-r2", "R2 · esperanza-cms", {
					description: "Image and PDF object storage.",
				}),
			],
		},
		{
			id: "website",
			name: "Website",
			description: "Public site reachability (placeholder ping every few minutes).",
			components: [
				component("site-esperanza", "esperanzahomes.com", {
					description: "Public marketing site (static frontend on Cloudflare).",
				}),
			],
		},
		{
			id: "services",
			name: "Site services",
			description: "Third-party services embedded on the live site.",
			components: [
				component("lotvue", "Lotvue", {
					description: "Interactive community / lot maps.",
				}),
				component("hubspot", "HubSpot", {
					description: "Forms, CRM, and marketing embeds.",
				}),
				component("mapbox", "Mapbox", {
					description: "Maps used on location / community pages.",
				}),
			],
		},
	];

	const overall = worstHealth(
		...groups.flatMap((g) => g.components.map((c) => c.status))
	);

	return {
		updatedAt: new Date().toISOString(),
		lookbackDays: LOOKBACK_DAYS,
		overall,
		groups,
		websitePingNote:
			"Website uptime will ping esperanzahomes.com every few minutes once the checker is live. Showing placeholder history for now.",
		sourceNote:
			"All rows are placeholders. Live health and incident history will come from Sentry once that integration is wired.",
	};
}
