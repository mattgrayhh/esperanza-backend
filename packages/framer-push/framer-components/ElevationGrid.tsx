// =============================================================================
// ElevationGrid — Framer code component for the labeled elevation grid on the
// floor-plan page.
//
// HOW TO USE IN FRAMER
//   1. Floor Plans CMS detail page → add a Code Component → paste this file.
//   2. In the component's properties, bind the **Elevations** text prop to the CMS
//      field `elevations_json` (Floor Plans collection). It's a plain string field
//      holding a JSON array of { url, type }, emitted by framer-push.
//   3. Adjust Columns / Gap / Aspect ratio / Badge color to taste.
//
// The component parses the JSON and renders each elevation rendering as a card with
// its type captioned in a badge (Contemporary Brick, Tuscan Stucco, Farmhouse, …),
// mirroring the legacy site's labeled grid. If the field is empty or malformed it
// renders nothing (no error), so it's safe to drop on every plan page.
// =============================================================================

import { addPropertyControls, ControlType } from "framer"
import type { CSSProperties } from "react"

interface Elevation {
    url: string
    type: string
}

function parseElevations(raw: unknown): Elevation[] {
    if (typeof raw !== "string" || raw.trim() === "") return []
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return []
    }
    if (!Array.isArray(parsed)) return []
    const out: Elevation[] = []
    for (const item of parsed) {
        if (item && typeof item === "object") {
            const rec = item as Record<string, unknown>
            const url = typeof rec.url === "string" ? rec.url.trim() : ""
            if (!url) continue
            const type = typeof rec.type === "string" ? rec.type.trim() : ""
            out.push({ url, type })
        } else if (typeof item === "string" && item.trim()) {
            out.push({ url: item.trim(), type: "" })
        }
    }
    return out
}

/**
 * @framerSupportedLayoutWidth any-prefer-fixed
 * @framerSupportedLayoutHeight auto
 * @framerIntrinsicWidth 800
 */
export default function ElevationGrid(props: {
    elevations: string
    columns: number
    gap: number
    radius: number
    aspectRatio: number
    badgeColor: string
    badgeTextColor: string
    style?: CSSProperties
}) {
    const {
        elevations,
        columns = 2,
        gap = 16,
        radius = 10,
        aspectRatio = 1.5,
        badgeColor = "#2f5d50",
        badgeTextColor = "#ffffff",
        style,
    } = props

    const items = parseElevations(elevations)
    if (items.length === 0) return null

    const gridStyle: CSSProperties = {
        display: "grid",
        gridTemplateColumns: `repeat(${Math.max(1, Math.round(columns))}, 1fr)`,
        gap,
        width: "100%",
        ...style,
    }

    return (
        <div style={gridStyle}>
            {items.map((it, i) => (
                <div
                    key={i}
                    style={{
                        position: "relative",
                        width: "100%",
                        aspectRatio: String(aspectRatio),
                        borderRadius: radius,
                        overflow: "hidden",
                        background: "#f3f1ed",
                    }}
                >
                    <img
                        src={it.url}
                        alt={it.type || `Elevation ${i + 1}`}
                        loading="lazy"
                        style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                            display: "block",
                        }}
                    />
                    {it.type ? (
                        <span
                            style={{
                                position: "absolute",
                                top: 10,
                                left: 10,
                                padding: "4px 10px",
                                borderRadius: 4,
                                background: badgeColor,
                                color: badgeTextColor,
                                fontSize: 12,
                                fontWeight: 600,
                                letterSpacing: "0.04em",
                                textTransform: "uppercase",
                                lineHeight: 1.2,
                            }}
                        >
                            {it.type}
                        </span>
                    ) : null}
                </div>
            ))}
        </div>
    )
}

addPropertyControls(ElevationGrid, {
    elevations: {
        type: ControlType.String,
        title: "Elevations",
        description: "Bind to the CMS `elevations_json` field.",
        defaultValue: "",
    },
    columns: { type: ControlType.Number, title: "Columns", min: 1, max: 4, step: 1, defaultValue: 2, displayStepper: true },
    gap: { type: ControlType.Number, title: "Gap", min: 0, max: 64, step: 2, defaultValue: 16 },
    radius: { type: ControlType.Number, title: "Radius", min: 0, max: 40, step: 1, defaultValue: 10 },
    aspectRatio: { type: ControlType.Number, title: "Aspect", min: 0.5, max: 3, step: 0.1, defaultValue: 1.5 },
    badgeColor: { type: ControlType.Color, title: "Badge", defaultValue: "#2f5d50" },
    badgeTextColor: { type: ControlType.Color, title: "Badge Text", defaultValue: "#ffffff" },
})
