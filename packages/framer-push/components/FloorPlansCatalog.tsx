// Floor Plans Catalog - Esperanza Homes
// Header pattern mirrors QuickMoveIns.tsx for cross-page consistency:
//   filter-area (tabs + primary filters + download row) + title-row (h1 + visit box).
// Fonts: Bodoni (headers), Overpass (body) — same as QMI.
// Colors: #295135 dark green, #407e52 light green, #85754e tan, #3c3c3c text, #F3F1ED filter bg, #F1F0EB title bar + card border, white cards.

import React, { useEffect, useMemo, useState, useCallback } from "react"
import { addPropertyControls, ControlType } from "framer"

const STAT_ICONS = {
    garage: "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/stats/garage.svg",
    stairs: "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/stats/stairs.svg",
    livingSqft: "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/stats/livingsqft.svg",
    bed: "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/stats/bedroom.svg",
    bath: "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/stats/bathroom.svg",
    sqft: "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/stats/sqft.svg",
}

const TOUR_ICON =
    "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/stats/tour-icon.svg"

declare const RenderTarget: {
    current: () => string
    thumbnail: string
    canvas: string
    preview: string
}

interface FloorPlan {
    id: number
    name: string
    slug: string
    collection: string
    bedsMin: number
    bedsMax: number
    bathsMin: number
    bathsMax: number
    garage: string
    stories: number
    livingSqft: number
    totalSqft: number
    priceFrom: number
    images: string[]
    virtualTourUrl?: string
    url?: string
}

interface FilterState {
    collection: string
    bathrooms: string
    bedrooms: string
    sqftRange: string
    priceRange: string
}

type SortOption = "price-asc" | "sqft-asc"

interface FloorPlansCatalogProps {
    primaryColor?: string
    strokeColor?: string
    textDark?: string
    accentTan?: string
    fontCssUrl?: string
    floorPlans?: FloorPlan[]
    apiUrl?: string
    useEmbeddedData?: boolean
    baseUrl?: string
    communitiesUrl?: string
    quickMoveInsUrl?: string
    floorPlansUrl?: string
    downloadPdfUrl?: string
    ctaUrl?: string
    titleFont?: CardFontOverride
    collectionLabelFont?: CardFontOverride
    collectionValueFont?: CardFontOverride
    specFont?: CardFontOverride
    tourBadgeFont?: CardFontOverride
    buttonFont?: CardFontOverride
}

interface CardFontOverride {
    fontFamily?: string
    fontWeight?: string
    fontSize?: number
    textTransform?: string
}

const CARD_FONT_FAMILY_MAP: Record<string, string> = {
    Overpass: "'Overpass', sans-serif",
    Bodoni: "'Bodoni', 'Arapey', Georgia, serif",
    Arapey: "'Arapey', Georgia, serif",
    Georgia: "Georgia, serif",
    "Times New Roman": "'Times New Roman', serif",
}

function cardFontStyle(o?: CardFontOverride): React.CSSProperties | undefined {
    if (!o) return undefined
    const s: React.CSSProperties = {}
    if (o.fontFamily && o.fontFamily !== "Default")
        s.fontFamily = CARD_FONT_FAMILY_MAP[o.fontFamily] || o.fontFamily
    if (o.fontWeight && o.fontWeight !== "Default")
        s.fontWeight = o.fontWeight as React.CSSProperties["fontWeight"]
    if (o.fontSize && o.fontSize > 0) s.fontSize = o.fontSize
    if (o.textTransform && o.textTransform !== "Default")
        s.textTransform =
            o.textTransform as React.CSSProperties["textTransform"]
    return Object.keys(s).length ? s : undefined
}

function cardFontControl(title: string) {
    return {
        type: ControlType.Object,
        title,
        optional: true,
        controls: {
            fontFamily: {
                type: ControlType.Enum,
                title: "Font",
                options: [
                    "Default",
                    "Overpass",
                    "Bodoni",
                    "Arapey",
                    "Georgia",
                    "Times New Roman",
                ],
                optionTitles: [
                    "Default (reference)",
                    "Overpass",
                    "Bodoni",
                    "Arapey",
                    "Georgia",
                    "Times New Roman",
                ],
                defaultValue: "Default",
            },
            fontWeight: {
                type: ControlType.Enum,
                title: "Weight",
                options: ["Default", "300", "400", "500", "700"],
                optionTitles: ["Default", "Light", "Regular", "Medium", "Bold"],
                defaultValue: "Default",
            },
            fontSize: {
                type: ControlType.Number,
                title: "Size",
                defaultValue: 0,
                min: 0,
                max: 140,
                step: 1,
                displayStepper: true,
                unit: "px",
                description:
                    "0 = auto. Set px to lock size.",
            },
            textTransform: {
                type: ControlType.Enum,
                title: "Case",
                options: [
                    "Default",
                    "none",
                    "uppercase",
                    "lowercase",
                    "capitalize",
                ],
                optionTitles: [
                    "Default",
                    "Normal",
                    "UPPERCASE",
                    "lowercase",
                    "Capitalize",
                ],
                defaultValue: "Default",
            },
        },
    }
}

// Live floor-plan record from the public D1 API (/api/public/floorplans).
interface ApiFloorPlan {
    id?: string
    name?: string
    slug?: string
    collection?: string
    bedroomMin?: number
    bedroomMax?: number
    bathroomMin?: number
    bathroomMax?: number
    carGarageCount?: number
    storiesCount?: number
    livingSquareFootage?: number
    totalSquareFootage?: number
    startingPrice?: number | null
    image?: string
    virtualTourUrl?: string
}

// Collection values on the card/filter carry a " Collection" suffix (matches
// COLLECTION_OPTIONS); the API stores the bare name ("Haven"), so normalize here.
function normalizeCollection(raw?: string): string {
    const c = (raw || "").trim()
    if (!c) return ""
    return /collection$/i.test(c) ? c : `${c} Collection`
}

// Map a live API record onto the component's FloorPlan shape. starting price comes
// from D1's COALESCE(override_starting_price, synced_starting_price), surfaced as
// `startingPrice`; rendered as "From $X" on the card.
function mapApiFloorPlan(raw: ApiFloorPlan, idx: number): FloorPlan {
    return {
        id: idx + 1,
        name: raw.name || "",
        slug: raw.slug || "",
        collection: normalizeCollection(raw.collection),
        bedsMin: raw.bedroomMin ?? 0,
        bedsMax: raw.bedroomMax ?? raw.bedroomMin ?? 0,
        bathsMin: raw.bathroomMin ?? 0,
        bathsMax: raw.bathroomMax ?? raw.bathroomMin ?? 0,
        garage: raw.carGarageCount != null ? String(raw.carGarageCount) : "",
        stories: raw.storiesCount ?? 0,
        livingSqft: raw.livingSquareFootage ?? 0,
        totalSqft: raw.totalSquareFootage ?? 0,
        priceFrom: typeof raw.startingPrice === "number" ? raw.startingPrice : 0,
        images: raw.image ? [raw.image] : [],
        virtualTourUrl: raw.virtualTourUrl?.trim() || undefined,
    }
}

async function fetchFloorPlans(apiUrl: string): Promise<FloorPlan[]> {
    const res = await fetch(apiUrl)
    if (!res.ok) throw new Error(`Floor plans API HTTP ${res.status}`)
    const json = await res.json()
    const records: ApiFloorPlan[] = json.floorplans || json.homes || []
    return records
        .map(mapApiFloorPlan)
        .filter((p) => p.name)
        .sort((a, b) => a.name.localeCompare(b.name))
}

const EMBEDDED_FLOOR_PLANS: FloorPlan[] = [
    {
        id: 1,
        name: "Acuna II",
        slug: "acuna-ii",
        collection: "Haven Collection",
        bedsMin: 3,
        bedsMax: 4,
        bathsMin: 2.5,
        bathsMax: 3,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 1975,
        totalSqft: 2413,
        priceFrom: 212990,
        images: [
            "https://media.esperanzahomes.com/153/2022/12/19/ACUNA_GAME_ROOM_CONTEMPORARY_BRICK_SE_V01.jpg?width=1920&height=1279&fit=bounds&ois=6f8a874",
            "https://media.esperanzahomes.com/153/2022/12/19/ACUNA_GAME_ROOM_CONTEMPORARY_STUCCO_SC_V02.jpg?width=1920&height=1279&fit=bounds&ois=c386056",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/acuna-ii/",
    },
    {
        id: 2,
        name: "Agave",
        slug: "agave",
        collection: "Homestead Collection",
        bedsMin: 4,
        bedsMax: 5,
        bathsMin: 3,
        bathsMax: 3,
        garage: "3 Car Garage",
        stories: 1,
        livingSqft: 2786,
        totalSqft: 3639,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2024/4/26/Agave_Tuscan_Brick_Color_Render_V03.jpg?width=1920&height=1279&fit=bounds&ois=142c25a",
            "https://media.esperanzahomes.com/153/2024/4/26/Agave_Tuscan_Stucco_Color_Render_V02.jpg?width=1920&height=1279&fit=bounds&ois=1c175a4",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/agave/",
    },
    {
        id: 3,
        name: "Allegrini",
        slug: "allegrini",
        collection: "Villas Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2.5,
        bathsMax: 2.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 1412,
        totalSqft: 1949,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/7/3/Allegrini_Contemporary_Stucco_Color_Render_V03_1.jpg?width=1920&height=1279&fit=bounds&ois=e6c8bac",
            "https://media.esperanzahomes.com/153/2025/7/3/Allegrini_Traditional_Stucco_Color_Render_V02_1.jpg?width=1920&height=1279&fit=bounds&ois=4b613f3",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/allegrini/",
    },
    {
        id: 4,
        name: "Antinori",
        slug: "antinori",
        collection: "Villas Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2.5,
        bathsMax: 2.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 1630,
        totalSqft: 2228,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/22/ANTINORI__CONTEMPORARY_STUCCO_S-C_V03.jpg?width=1920&height=1279&fit=bounds&ois=93f804d",
            "https://media.esperanzahomes.com/153/2022/2/22/ANTINORI__TRADITIONAL_STUCCO_S-K_V02.jpg?width=1920&height=1279&fit=bounds&ois=eab1f70",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/antinori/",
    },
    {
        id: 5,
        name: "Bahia",
        slug: "bahia",
        collection: "Haven Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2,
        bathsMax: 2,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1485,
        totalSqft: 1911,
        priceFrom: 173990,
        images: [
            "https://media.esperanzahomes.com/153/2022/4/12/BAHIA_TUSCAN_STUCCO_S-A-V04.jpg?width=1920&height=1279&fit=bounds&ois=eb3fcf8",
            "https://media.esperanzahomes.com/153/2022/4/12/BAHIA_CONTEMP_STUCCO_S-C-V04.jpg?width=1920&height=1279&fit=bounds&ois=f31504d",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/bahia/",
    },
    {
        id: 6,
        name: "Barbados",
        slug: "barbados",
        collection: "Retama Collection",
        bedsMin: 4,
        bedsMax: 4,
        bathsMin: 3,
        bathsMax: 3,
        garage: "",
        stories: 2,
        livingSqft: 2177,
        totalSqft: 3588,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/18/BARBADOS_TRADITIONAL_STUCCO_S-K_V01.jpg?width=1920&height=1279&fit=bounds&ois=37e71cc",
            "https://media.esperanzahomes.com/153/2022/2/18/BARBADOS_TUSCAN_S_A_V01.jpg?width=1920&height=1279&fit=bounds&ois=01be45b",
        ],
        url: "/floorplans/barbados/",
    },
    {
        id: 7,
        name: "Bear",
        slug: "bear",
        collection: "Harbor Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2,
        bathsMax: 2,
        garage: "",
        stories: 1,
        livingSqft: 1248,
        totalSqft: 1275,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/8/19/Bear_-_Farmhouse_v2.jpg?width=1920&height=1279&fit=bounds&ois=b62592b",
            "https://media.esperanzahomes.com/153/2025/6/30/063025_5740_St_Dominic_Dr_Bear_Traditional_Brick-_04.jpg?width=1920&height=1280&fit=bounds&ois=4b1575e",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/bear/",
    },
    {
        id: 8,
        name: "Benanti",
        slug: "benanti",
        collection: "Villas Collection",
        bedsMin: 4,
        bedsMax: 4,
        bathsMin: 2.5,
        bathsMax: 2.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 1836,
        totalSqft: 2382,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/5/29/Benanti_-_Contemporary_Stucco_V04.jpg?width=1920&height=1279&fit=bounds&ois=2c45b1c",
            "https://media.esperanzahomes.com/153/2025/5/29/Benanti_-_Traditional_Stucco_V04.jpg?width=1920&height=1279&fit=bounds&ois=ba5c648",
        ],
        url: "/floorplans/benanti/",
    },
    {
        id: 9,
        name: "Blanco",
        slug: "blanco",
        collection: "Homestead Collection",
        bedsMin: 4,
        bedsMax: 5,
        bathsMin: 2.5,
        bathsMax: 2.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 3033,
        totalSqft: 4101,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/11/26/Blanco_Traditional_Brick_V01.jpg?width=1920&height=1279&fit=bounds&ois=9b59c5a",
            "https://media.esperanzahomes.com/153/2025/11/26/Blanco_Farmhouse_V01.jpg?width=1920&height=1279&fit=bounds&ois=3b797f9",
        ],
        url: "/floorplans/blanco/",
    },
    {
        id: 10,
        name: "Bluebonnet",
        slug: "bluebonnet",
        collection: "Haven Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2,
        bathsMax: 2,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1593,
        totalSqft: 2015,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/12/23/Plan_31_Bluebonnet_Contemporary_Stucco_V01.jpg?width=1920&height=1279&fit=bounds&ois=592b74c",
            "https://media.esperanzahomes.com/153/2025/12/23/Plan_31_Bluebonnet_Traditional_Brick_V01.jpg?width=1920&height=1279&fit=bounds&ois=3943b85",
        ],
        url: "/floorplans/bluebonnet/",
    },
    {
        id: 11,
        name: "Brazos",
        slug: "brazos",
        collection: "Homestead Collection",
        bedsMin: 4,
        bedsMax: 5,
        bathsMin: 2.5,
        bathsMax: 4,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 3011,
        totalSqft: 3595,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2024/10/1/Plan_12_Brazos_Farmhouse_Color_Render_V01.jpg?width=1920&height=1279&fit=bounds&ois=8f41776",
            "https://media.esperanzahomes.com/153/2024/10/1/Plan_12_Brazos_Contemporary_Stucco_Color_Render_V01.jpg?width=1920&height=1279&fit=bounds&ois=c4f6bbe",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/brazos/",
    },
    {
        id: 12,
        name: "Capistrano",
        slug: "capistrano",
        collection: "Homestead Collection",
        bedsMin: 4,
        bedsMax: 5,
        bathsMin: 4,
        bathsMax: 4,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 2848,
        totalSqft: 3660,
        priceFrom: 350990,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/21/CAPISTRANO_CONTEMPORARY_STUCCO_SD_V03.jpg?width=1920&height=1279&fit=bounds&ois=c851efe",
            "https://media.esperanzahomes.com/153/2022/2/21/CAPISTRANO_FARMHOUSE_HARDIE_SH_V04.jpg?width=1920&height=1279&fit=bounds&ois=88ce9ad",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/capistrano/",
    },
    {
        id: 13,
        name: "Cedar",
        slug: "cedar",
        collection: "Hearth Collection",
        bedsMin: 3,
        bedsMax: 4,
        bathsMin: 2.5,
        bathsMax: 3,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 3330,
        totalSqft: 4174,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/11/17/Plan_27_Cedar_Contemporary_Stucco_V03.jpg?width=1920&height=1279&fit=bounds&ois=4f8ad5d",
            "https://media.esperanzahomes.com/153/2025/11/17/Plan_27_Cedar_Farmhouse_V03.jpg?width=1920&height=1279&fit=bounds&ois=54ae61c",
        ],
        url: "/floorplans/cedar/",
    },
    {
        id: 14,
        name: "Chacon",
        slug: "chacon",
        collection: "Harbor Collection",
        bedsMin: 4,
        bedsMax: 4,
        bathsMin: 2,
        bathsMax: 2,
        garage: "",
        stories: 1,
        livingSqft: 1415,
        totalSqft: 1476,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/8/19/Chacon_-_Traditional_Brick_v2.jpg?width=1920&height=1279&fit=bounds&ois=290f574",
            "https://media.esperanzahomes.com/153/2025/8/19/Chacon_-_Contemporary_Stucco_v2.jpg?width=1920&height=1279&fit=bounds&ois=2513edc",
        ],
        url: "/floorplans/chacon/",
    },
    {
        id: 15,
        name: "Cimarron",
        slug: "cimarron",
        collection: "Homestead Collection",
        bedsMin: 3,
        bedsMax: 4,
        bathsMin: 4.5,
        bathsMax: 4.5,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 3072,
        totalSqft: 4148,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/12/22/Plan_30_Cimarron_Tuscan_Stucco_V02.jpg?width=1920&height=1279&fit=bounds&ois=d73ebd3",
            "https://media.esperanzahomes.com/153/2025/12/22/Plan_30_Cimarron_Traditional_Brick_V02.jpg?width=1920&height=1279&fit=bounds&ois=2c72473",
        ],
        url: "/floorplans/cimarron/",
    },
    {
        id: 16,
        name: "Cortono",
        slug: "cortono",
        collection: "Villas Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2,
        bathsMax: 2,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1414,
        totalSqft: 1963,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2021/9/15/CORTONO_V02_Page_1.jpg?width=1920&height=1279&fit=bounds&ois=f9fc4db",
            "https://media.esperanzahomes.com/153/2021/9/15/CORTONO_V02_Page_2.jpg?width=1920&height=1279&fit=bounds&ois=6f2dac1",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/cortono/",
    },
    {
        id: 17,
        name: "Cottage",
        slug: "cottage",
        collection: "Retama Collection",
        bedsMin: 2,
        bedsMax: 2,
        bathsMin: 2,
        bathsMax: 2,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1261,
        totalSqft: 1731,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/5/20/Cottage_-_Tuscan_-_Stucco.jpg?width=1920&height=1279&fit=bounds&ois=4b4c885",
            "https://media.esperanzahomes.com/153/2025/5/20/Cottage_-_Traditional_-_Stucco.jpg?width=1920&height=1279&fit=bounds&ois=47be4a9",
        ],
        url: "/floorplans/cottage/",
    },
    {
        id: 18,
        name: "Cuervo",
        slug: "cuervo",
        collection: "Harbor Collection",
        bedsMin: 4,
        bedsMax: 4,
        bathsMin: 2,
        bathsMax: 2,
        garage: "",
        stories: 1,
        livingSqft: 1336,
        totalSqft: 1376,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/8/19/Cuervo_-_Contemporary_Stucco_v2.jpg?width=1920&height=1279&fit=bounds&ois=6984e03",
            "https://media.esperanzahomes.com/153/2025/8/19/Cuervo_-_Farmhouse_v2.jpg?width=1920&height=1279&fit=bounds&ois=5fa410c",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/cuervo/",
    },
    {
        id: 19,
        name: "Cypress",
        slug: "cypress",
        collection: "Retama Collection",
        bedsMin: 2,
        bedsMax: 2,
        bathsMin: 2.5,
        bathsMax: 2.5,
        garage: "",
        stories: 2,
        livingSqft: 1561,
        totalSqft: 2513,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/18/CYPRESS_TRADITIONAL_STUCCO_S-L_V01.jpg?width=1920&height=1279&fit=bounds&ois=a1da6ae",
            "https://media.esperanzahomes.com/153/2022/2/18/CYPRESS_TUSCAN_STUCCO_S-B_V01.jpg?width=1920&height=1279&fit=bounds&ois=c73bf04",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/cypress/",
    },
    {
        id: 20,
        name: "Ebony",
        slug: "ebony",
        collection: "Retama Collection",
        bedsMin: 2,
        bedsMax: 2,
        bathsMin: 2,
        bathsMax: 2,
        garage: "",
        stories: 1,
        livingSqft: 1176,
        totalSqft: 2332,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/18/EBONY_TUSCAN_STUCCO_S-B_V02.jpg?width=1920&height=1279&fit=bounds&ois=326c04c",
            "https://media.esperanzahomes.com/153/2022/2/18/EBONY_TRADITIONAL_STUCCO_S-K_V02.jpg?width=1920&height=1279&fit=bounds&ois=583a1c1",
        ],
        url: "/floorplans/ebony/",
    },
    {
        id: 21,
        name: "Elm",
        slug: "elm",
        collection: "Hearth Collection",
        bedsMin: 4,
        bedsMax: 5,
        bathsMin: 2.5,
        bathsMax: 3,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 2571,
        totalSqft: 3208,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/6/5/Elm_Farmhouse_Color_Render_V03.jpg?width=1920&height=1279&fit=bounds&ois=c36c71a",
            "https://media.esperanzahomes.com/153/2025/6/5/Elm_Contemporary_Stucco_Color_Render_V02.jpg?width=1920&height=1279&fit=bounds&ois=ec67dab",
        ],
        url: "/floorplans/elm/",
    },
    {
        id: 22,
        name: "Encino",
        slug: "encino",
        collection: "Haven Collection",
        bedsMin: 3,
        bedsMax: 4,
        bathsMin: 2,
        bathsMax: 3,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1740,
        totalSqft: 2157,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2024/7/3/Encino_-_FHH.jpg?width=1920&height=1279&fit=bounds&ois=9f71e8f",
            "https://media.esperanzahomes.com/153/2024/7/3/Encino_-_TSS.jpg?width=1920&height=1279&fit=bounds&ois=959e35c",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/encino/",
    },
    {
        id: 23,
        name: "Francisco I",
        slug: "francisco-i",
        collection: "Hearth Collection",
        bedsMin: 3,
        bedsMax: 4,
        bathsMin: 2,
        bathsMax: 2,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 2208,
        totalSqft: 2906,
        priceFrom: 249990,
        images: [
            "https://media.esperanzahomes.com/153/2022/11/8/FRANCISCO_FARMHOUSE_V05.jpg?width=1920&height=1279&fit=bounds&ois=0270cb7",
            "https://media.esperanzahomes.com/153/2022/11/8/CONTEMPORARY_STUCCO_V05.jpg?width=1920&height=1279&fit=bounds&ois=2395949",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/francisco-i/",
    },
    {
        id: 24,
        name: "Francisco II",
        slug: "francisco-ii",
        collection: "Hearth Collection",
        bedsMin: 3,
        bedsMax: 6,
        bathsMin: 3,
        bathsMax: 3.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 3044,
        totalSqft: 3675,
        priceFrom: 283990,
        images: [
            "https://media.esperanzahomes.com/153/2022/11/8/FRANCISCO_2_FARMHOUSE_HARDIE.jpg?width=1920&height=1279&fit=bounds&ois=2e74fee",
            "https://media.esperanzahomes.com/153/2022/11/8/FRANCISCO_2_STORY_CONTEMPORARY_BRICK_V2.jpg?width=1920&height=1279&fit=bounds&ois=06b71ef",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/francisco-ii/",
    },
    {
        id: 25,
        name: "Fresno",
        slug: "fresno",
        collection: "Hearth Collection",
        bedsMin: 4,
        bedsMax: 4,
        bathsMin: 3.5,
        bathsMax: 3.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 3317,
        totalSqft: 3940,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2024/9/25/Fresno_-_Color_Render_-_Tuscan_Stucco_-_V03.jpg?width=1920&height=1279&fit=bounds&ois=304c891",
            "https://media.esperanzahomes.com/153/2024/9/25/Fresno_-_Color_Render_-_Traditional_Brick_-_V03.jpg?width=1920&height=1279&fit=bounds&ois=7248ea7",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/fresno/",
    },
    {
        id: 26,
        name: "Grapa",
        slug: "grapa",
        collection: "Villas Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2.5,
        bathsMax: 2.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 2211,
        totalSqft: 2753,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/22/GRAPA_CONTEMPORARY_STUCCO_S-D_V02.jpg?width=1920&height=1279&fit=bounds&ois=8a9de3d",
            "https://media.esperanzahomes.com/153/2022/2/22/GRAPA-TRANSITIONAL-STUCCO-S-L.jpg?width=1920&height=1279&fit=bounds&ois=9669f0b",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/grapa/",
    },
    {
        id: 27,
        name: "Hackberry",
        slug: "hackberry",
        collection: "Hearth Collection",
        bedsMin: 3,
        bedsMax: 5,
        bathsMin: 2.5,
        bathsMax: 3,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 2331,
        totalSqft: 2856,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/5/29/Hackberry_Tuscan_Stucco_Color_Render_V03.jpg?width=1920&height=1279&fit=bounds&ois=e030c47",
            "https://media.esperanzahomes.com/153/2025/5/29/Hackberry_-_Contemporary_-_Stucco.jpg?width=1920&height=1279&fit=bounds&ois=b610b44",
        ],
        url: "/floorplans/hackberry/",
    },
    {
        id: 28,
        name: "Hickory",
        slug: "hickory",
        collection: "Hearth Collection",
        bedsMin: 3,
        bedsMax: 4,
        bathsMin: 2.5,
        bathsMax: 3,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1797,
        totalSqft: 2442,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/5/20/Hickory_-_Farmhouse_-_Hardie.jpg?width=1920&height=1279&fit=bounds&ois=bc6fdd8",
            "https://media.esperanzahomes.com/153/2025/5/20/Hickory_-_Tuscan_-_Stucco.jpg?width=1920&height=1279&fit=bounds&ois=e20dcf6",
        ],
        url: "/floorplans/hickory/",
    },
    {
        id: 29,
        name: "Indigo",
        slug: "indigo",
        collection: "Haven Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2,
        bathsMax: 2,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1234,
        totalSqft: 1652,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/7/1/Indigo_-_Contemporary_Stucco_-_V01.jpg?width=1920&height=1279&fit=bounds&ois=8bd725f",
            "https://media.esperanzahomes.com/153/2025/7/1/Indigo_-_Farmhouse_-_V01.jpg?width=1920&height=1279&fit=bounds&ois=f6709c7",
        ],
        url: "/floorplans/indigo/",
    },
    {
        id: 30,
        name: "Iris",
        slug: "iris",
        collection: "Haven Collection",
        bedsMin: 3,
        bedsMax: 4,
        bathsMin: 2.5,
        bathsMax: 2.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 1821,
        totalSqft: 2303,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/2/7/Iris_-_Tuscan_-_Stucco.jpg?width=1920&height=1279&fit=bounds&ois=4f1a59a",
            "https://media.esperanzahomes.com/153/2025/2/7/Iris_-_Traditional_-_Brick.jpg?width=1920&height=1279&fit=bounds&ois=932fbd2",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/iris/",
    },
    {
        id: 31,
        name: "Jasmine",
        slug: "jasmine",
        collection: "Haven Collection",
        bedsMin: 3,
        bedsMax: 4,
        bathsMin: 2.5,
        bathsMax: 2.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 1784,
        totalSqft: 2292,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/6/5/Jasmine_Farmhouse_Color_Render_V0180.jpg?width=1920&height=1279&fit=bounds&ois=7ed5ca9",
            "https://media.esperanzahomes.com/153/2025/6/5/Jasmine_Tuscan_Stucco_Color_Render_V0122.jpg?width=1920&height=1279&fit=bounds&ois=105c927",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/jasmine/",
    },
    {
        id: 32,
        name: "Juniper",
        slug: "juniper",
        collection: "Haven Collection",
        bedsMin: 3,
        bedsMax: 5,
        bathsMin: 2.5,
        bathsMax: 4,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 2328,
        totalSqft: 2783,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/7/1/Juniper_-_Contemporary_Stucco_-_V01.jpg?width=1920&height=1279&fit=bounds&ois=c110b37",
            "https://media.esperanzahomes.com/153/2025/7/1/Juniper_-_Traditional_Brick_-_V01.jpg?width=1920&height=1279&fit=bounds&ois=7bc2f0e",
        ],
        url: "/floorplans/juniper/",
    },
    {
        id: 33,
        name: "Laurel",
        slug: "laurel",
        collection: "Hearth Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2,
        bathsMax: 2,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1703,
        totalSqft: 2359,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/11/20/Plan_26_Laurel_Traditional_Brick_V03.jpg?width=1920&height=1279&fit=bounds&ois=0794309",
            "https://media.esperanzahomes.com/153/2025/11/20/Plan_26_Laurel_Tuscan_Stucco_V02.jpg?width=1920&height=1279&fit=bounds&ois=325ce92",
        ],
        url: "/floorplans/laurel/",
    },
    {
        id: 34,
        name: "Luna",
        slug: "luna",
        collection: "Hearth Collection",
        bedsMin: 3,
        bedsMax: 4,
        bathsMin: 2.5,
        bathsMax: 3,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 2279,
        totalSqft: 2845,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2024/10/1/Plan_11_Luna_Contemporary_Stucco_Color_Render_V02.jpg?width=1920&height=1279&fit=bounds&ois=5b0474a",
            "https://media.esperanzahomes.com/153/2024/10/1/Plan_11_Luna_Farmhouse_Color_Render_V01.jpg?width=1920&height=1279&fit=bounds&ois=c6a7287",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/luna/",
    },
    {
        id: 35,
        name: "Lunelli",
        slug: "lunelli",
        collection: "Villas Collection",
        bedsMin: 2,
        bedsMax: 2,
        bathsMin: 2,
        bathsMax: 2,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 975,
        totalSqft: 1454,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/5/29/Lunelli_-_Traditional_Stucco_V04.jpg?width=1920&height=1279&fit=bounds&ois=bd61647",
            "https://media.esperanzahomes.com/153/2025/5/29/Lunelli_-_Tuscan_Stucco_V04.jpg?width=1920&height=1279&fit=bounds&ois=fa61610",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/lunelli/",
    },
    {
        id: 36,
        name: "Magnolia",
        slug: "magnolia",
        collection: "Haven Collection",
        bedsMin: 5,
        bedsMax: 6,
        bathsMin: 3.5,
        bathsMax: 3.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 3037,
        totalSqft: 3526,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2024/4/25/Magnolia_Farmhouse_Color_Render_V01.jpg?width=1920&height=1279&fit=bounds&ois=4d0dca6",
            "https://media.esperanzahomes.com/153/2024/4/25/Magnolia_Contemporary_Brick_Color_Render_V01.jpg?width=1920&height=1279&fit=bounds&ois=4c5ac67",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/magnolia/",
    },
    {
        id: 37,
        name: "Manzanita",
        slug: "manzanita",
        collection: "Retama Collection",
        bedsMin: 2,
        bedsMax: 2,
        bathsMin: 2,
        bathsMax: 2,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1537,
        totalSqft: 2948,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/18/MANZANITA_TUSCAN_S-B_R1.jpg?width=1920&height=1279&fit=bounds&ois=bb1a931",
            "https://media.esperanzahomes.com/153/2022/2/18/MANZANITA_TRADITIONAL_S-K_R1.jpg?width=1920&height=1279&fit=bounds&ois=c801db5",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/manzanita/",
    },
    {
        id: 38,
        name: "Marigold",
        slug: "marigold",
        collection: "Haven Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2,
        bathsMax: 2,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1483,
        totalSqft: 1899,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2024/7/3/Marigold_-_TDB.jpg?width=1920&height=1279&fit=bounds&ois=3b37fb9",
            "https://media.esperanzahomes.com/153/2024/7/22/Marigold_-_CTB_-_Contemporary_-_Brick.jpg?width=1920&height=1279&fit=bounds&ois=9a754d2",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/marigold/",
    },
    {
        id: 39,
        name: "Monte",
        slug: "monte",
        collection: "Haven Collection",
        bedsMin: 5,
        bedsMax: 6,
        bathsMin: 2.5,
        bathsMax: 2.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 2515,
        totalSqft: 3009,
        priceFrom: 250990,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/18/MONTE_TRADITIONAL_BRICK_S-J_V01.jpg?width=1920&height=1279&fit=bounds&ois=49be86f",
            "https://media.esperanzahomes.com/153/2022/2/18/MONTE_CONTEMPORY_STUCCO_S-C_V01.jpg?width=1920&height=1279&fit=bounds&ois=8595566",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/monte/",
    },
    {
        id: 40,
        name: "Mulberry",
        slug: "mulberry",
        collection: "Hearth Collection",
        bedsMin: 3,
        bedsMax: 4,
        bathsMin: 2.5,
        bathsMax: 3,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 2049,
        totalSqft: 2574,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/5/29/Mulberry_Contemporary_Stucco_Color_Render_V03.jpg?width=1920&height=1279&fit=bounds&ois=5c85baa",
            "https://media.esperanzahomes.com/153/2025/5/30/Mulberry_Traditional_Brick_Color_Render_V04.jpg?width=1920&height=1279&fit=bounds&ois=fc5c30a",
        ],
        url: "/floorplans/mulberry/",
    },
    {
        id: 41,
        name: "Nikola",
        slug: "nikola",
        collection: "Villas Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2.5,
        bathsMax: 2.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 2006,
        totalSqft: 2592,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2021/9/15/NIKOLA_V02_Page_1.jpg?width=1920&height=1279&fit=bounds&ois=98c101f",
            "https://media.esperanzahomes.com/153/2021/9/15/NIKOLA_V02_Page_2.jpg?width=1920&height=1279&fit=bounds&ois=bb4ba6f",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/nikola/",
    },
    {
        id: 42,
        name: "Nueces",
        slug: "nueces",
        collection: "Homestead Collection",
        bedsMin: 3,
        bedsMax: 4,
        bathsMin: 2.5,
        bathsMax: 3,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 2442,
        totalSqft: 3358,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/12/22/Plan_32_Nueces_Farmhouse_V02.jpg?width=1920&height=1279&fit=bounds&ois=e211844",
            "https://media.esperanzahomes.com/153/2025/12/22/Plan_32_Nueces_Tuscan_Stucco_V02.jpg?width=1920&height=1279&fit=bounds&ois=b5ce31f",
        ],
        url: "/floorplans/nueces/",
    },
    {
        id: 43,
        name: "Oak",
        slug: "oak",
        collection: "Hearth Collection",
        bedsMin: 3,
        bedsMax: 4,
        bathsMin: 2.5,
        bathsMax: 3,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 2254,
        totalSqft: 2874,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2025/5/30/Oak_Tuscan_Stucco_Color_Render_V03.jpg?width=1920&height=1279&fit=bounds&ois=8f21f57",
            "https://media.esperanzahomes.com/153/2025/5/29/Oak_Contemporary_Stucco_Color_Render_V02.jpg?width=1920&height=1279&fit=bounds&ois=f28ef72",
        ],
        url: "/floorplans/oak/",
    },
    {
        id: 44,
        name: "Palm",
        slug: "palm",
        collection: "Retama Collection",
        bedsMin: 2,
        bedsMax: 3,
        bathsMin: 2.5,
        bathsMax: 2.5,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1833,
        totalSqft: 3104,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/21/PALM_TRADITIONALSTUCCO_S-K_R1.jpg?width=1920&height=1279&fit=bounds&ois=3643a35",
            "https://media.esperanzahomes.com/153/2022/2/21/PALM_TUSCAN_STUCCO_S-A_R1.jpg?width=1920&height=1279&fit=bounds&ois=b3b5cdb",
        ],
        url: "/floorplans/palm/",
    },
    {
        id: 45,
        name: "Palmetto",
        slug: "palmetto",
        collection: "Retama Collection",
        bedsMin: 1,
        bedsMax: 1,
        bathsMin: 1,
        bathsMax: 1,
        garage: "",
        stories: 1,
        livingSqft: 823,
        totalSqft: 1804,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/18/PALMETTO_TRADITIONAL_STUCCO_S-L_V02.jpg?width=1920&height=1279&fit=bounds&ois=f05bef9",
            "https://media.esperanzahomes.com/153/2022/2/18/PALMETTO_TUSCAN_STUCCO_S-B_V01.jpg?width=1920&height=1279&fit=bounds&ois=bdedad6",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/palmetto/",
    },
    {
        id: 46,
        name: "Paloma",
        slug: "paloma",
        collection: "Haven Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2,
        bathsMax: 2,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1496,
        totalSqft: 1948,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2024/4/26/Paloma_Tuscan_Stucco_Color_Render_V02.jpg?width=1920&height=1279&fit=bounds&ois=f7932fb",
            "https://media.esperanzahomes.com/153/2024/4/26/Paloma_Traditional_Brick_Color_Render_V02.jpg?width=1920&height=1279&fit=bounds&ois=1d06d83",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/paloma/",
    },
    {
        id: 47,
        name: "Pecan",
        slug: "pecan",
        collection: "Hearth Collection",
        bedsMin: 3,
        bedsMax: 4,
        bathsMin: 2,
        bathsMax: 3.5,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1933,
        totalSqft: 2592,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2024/10/1/Plan_8_Pecan_Traditional_Brick_Color_Render_V01.jpg?width=1920&height=1279&fit=bounds&ois=3eb0e40",
            "https://media.esperanzahomes.com/153/2024/10/1/Plan_8_Pecan_Tuscan_Stucco_Color_Render_V02.jpg?width=1920&height=1279&fit=bounds&ois=7bc8a7f",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/pecan/",
    },
    {
        id: 48,
        name: "Peppoli",
        slug: "peppoli",
        collection: "Villas Collection",
        bedsMin: 2,
        bedsMax: 2,
        bathsMin: 2,
        bathsMax: 2,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1225,
        totalSqft: 1845,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/22/PEPPOLI_CONTEMPORARY_STUCCO-S-D_V02.jpg?width=1920&height=1279&fit=bounds&ois=7d66106",
            "https://media.esperanzahomes.com/153/2022/2/22/PEPPOLI_TRANSITIONAL_STUCCO-S-L.jpg?width=1920&height=1279&fit=bounds&ois=897ef26",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/peppoli/",
    },
    {
        id: 49,
        name: "Presidio",
        slug: "presidio",
        collection: "Haven Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2,
        bathsMax: 2,
        garage: "1 Car Garage",
        stories: 1,
        livingSqft: 1148,
        totalSqft: 1471,
        priceFrom: 144990,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/22/PRESIDIO_CONTEMPORARY_STUCCO-S-C_V02.jpg?width=1920&height=1279&fit=bounds&ois=b433647",
            "https://media.esperanzahomes.com/153/2022/2/22/PRESIDIO_FARMHOUSE_HARDIE-S-G_V02.jpg?width=1920&height=1279&fit=bounds&ois=6d7d74b",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/presidio/",
    },
    {
        id: 50,
        name: "RV Casita",
        slug: "rv-casita",
        collection: "Retama Collection",
        bedsMin: 1,
        bedsMax: 1,
        bathsMin: 1,
        bathsMax: 1,
        garage: "",
        stories: 1,
        livingSqft: 720,
        totalSqft: 720,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/18/RV_CASITA_SCHEME_A_V03.jpg?width=1920&height=1279&fit=bounds&ois=35754f5",
            "https://media.esperanzahomes.com/153/2023/2/24/1-2_5T4On9q.jpg?width=1920&height=1280&fit=bounds&ois=8fe25c5",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/rv-casita/",
    },
    {
        id: 51,
        name: "RV Deluxe Coach House",
        slug: "rv-deluxe-coach-house",
        collection: "Retama Collection",
        bedsMin: 1,
        bedsMax: 1,
        bathsMin: 1,
        bathsMax: 1,
        garage: "",
        stories: 1,
        livingSqft: 480,
        totalSqft: 480,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/18/DELUXE_COACH_HOUSE_SCHEME_A_V01.jpg?width=1920&height=1279&fit=bounds&ois=664621a",
            "https://media.esperanzahomes.com/153/2024/6/19/1-1.jpg?width=1920&height=1280&fit=bounds&ois=e138922",
        ],
        url: "/floorplans/rv-deluxe-coach-house/",
    },
    {
        id: 52,
        name: "Sage",
        slug: "sage",
        collection: "Homestead Collection",
        bedsMin: 5,
        bedsMax: 5,
        bathsMin: 4.5,
        bathsMax: 4.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 4396,
        totalSqft: 4955,
        priceFrom: 0,
        images: [
            "https://media.esperanzahomes.com/153/2024/7/16/Plan_5_-_Color_Render_-_Traditional_Stucco_-_V01.jpg?width=1920&height=1279&fit=bounds&ois=be4fdc2",
            "https://media.esperanzahomes.com/153/2024/7/17/Plan_5_-_Color_Render_-_Contemporary_Stucco_-_V02.jpg?width=1920&height=1279&fit=bounds&ois=1826251",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/sage/",
    },
    {
        id: 53,
        name: "San Lorenzo",
        slug: "san-lorenzo",
        collection: "Homestead Collection",
        bedsMin: 3,
        bedsMax: 5,
        bathsMin: 2.5,
        bathsMax: 2.5,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 2706,
        totalSqft: 3459,
        priceFrom: 278990,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/23/LORENZO_Contemporary_Stucco_SC_V05.jpg?width=1920&height=1279&fit=bounds&ois=6c88177",
            "https://media.esperanzahomes.com/153/2022/2/23/LORENZO_Farmhouse_Hardie_SG_V05.jpg?width=1920&height=1279&fit=bounds&ois=47c444d",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/san-lorenzo/",
    },
    {
        id: 54,
        name: "San Lorenzo II",
        slug: "san-lorenzo-ii",
        collection: "Homestead Collection",
        bedsMin: 3,
        bedsMax: 5,
        bathsMin: 2.5,
        bathsMax: 4,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 3354,
        totalSqft: 4107,
        priceFrom: 328990,
        images: [
            "https://media.esperanzahomes.com/153/2022/4/12/LORENZO_2_Traditional_Brick_SF_V03.jpg?width=1920&height=1279&fit=bounds&ois=d4ba1e7",
            "https://media.esperanzahomes.com/153/2022/4/12/LORENZO_2_Contemporary_Stucco_SC_V03.jpg?width=1920&height=1279&fit=bounds&ois=142aa7c",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/san-lorenzo-ii/",
    },
    {
        id: 55,
        name: "San Luis",
        slug: "san-luis",
        collection: "Haven Collection",
        bedsMin: 3,
        bedsMax: 3,
        bathsMin: 2,
        bathsMax: 2,
        garage: "2 Car Garage",
        stories: 1,
        livingSqft: 1443,
        totalSqft: 1887,
        priceFrom: 171990,
        images: [
            "https://media.esperanzahomes.com/153/2023/2/10/Unknown-5.jpeg?width=1920&height=1279&fit=bounds&ois=a9e13a3",
            "https://media.esperanzahomes.com/153/2023/2/10/Unknown-4.jpeg?width=1920&height=1279&fit=bounds&ois=bd05dc1",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/san-luis/",
    },
    {
        id: 56,
        name: "San Saba",
        slug: "san-saba",
        collection: "Homestead Collection",
        bedsMin: 4,
        bedsMax: 4,
        bathsMin: 3.5,
        bathsMax: 3.5,
        garage: "2 Car Garage",
        stories: 2,
        livingSqft: 3708,
        totalSqft: 4394,
        priceFrom: 337990,
        images: [
            "https://media.esperanzahomes.com/153/2022/2/18/SAN_SABA_Tuscon_Stucco_S-A_V04.jpg?width=1920&height=1279&fit=bounds&ois=5acf2bb",
            "https://media.esperanzahomes.com/153/2022/2/18/SAN_SABA_TRADITIONAL_STUCCO_S-K_V03.jpg?width=1920&height=1279&fit=bounds&ois=b2d0ba1",
        ],
        virtualTourUrl: "https://my.matterport.com/show/?m=placeholder",
        url: "/floorplans/san-saba/",
    },
]

const COLLECTION_OPTIONS = [
    { label: "Harbor", value: "Harbor Collection" },
    { label: "Haven", value: "Haven Collection" },
    { label: "Hearth", value: "Hearth Collection" },
    { label: "Homestead", value: "Homestead Collection" },
    { label: "Retama", value: "Retama Collection" },
    { label: "Villas", value: "Villas Collection" },
]

/**
 * @framerDisableUnlink
 * @framerIntrinsicWidth 1440
 * @framerIntrinsicHeight 900
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight any
 */
export default function FloorPlansCatalog({
    primaryColor = "#295135",
    strokeColor = "#0c4128",
    textDark = "#3c3c3c",
    accentTan = "#85754e",
    fontCssUrl = "",
    floorPlans,
    apiUrl = "https://esperanza-api.round-base-ed8c.workers.dev/api/public/floorplans",
    useEmbeddedData = false,
    baseUrl = "",
    communitiesUrl = "/new-homes",
    quickMoveInsUrl = "/new-homes/available",
    floorPlansUrl = "/new-homes/floorplans",
    downloadPdfUrl = "https://framerusercontent.com/assets/GA34mrNa8XVPidcjF5mU6oFG0.pdf",
    ctaUrl = "#request-a-tour",
    titleFont,
    collectionLabelFont,
    collectionValueFont,
    specFont,
    tourBadgeFont,
    buttonFont,
}: FloorPlansCatalogProps) {
    const [allPlans, setAllPlans] = useState<FloorPlan[]>([])
    const [filtered, setFiltered] = useState<FloorPlan[]>([])
    const [loading, setLoading] = useState(true)
    const [showFilters, setShowFilters] = useState(true)
    const [filters, setFilters] = useState<FilterState>({
        collection: "",
        bathrooms: "",
        bedrooms: "",
        sqftRange: "",
        priceRange: "",
    })
    const [sortBy, setSortBy] = useState<SortOption>("price-asc")
    const [imageIndices, setImageIndices] = useState<Record<number, number>>({})

    const isFramerThumbnail = useMemo(() => {
        try {
            return (
                typeof RenderTarget !== "undefined" &&
                RenderTarget.current() === RenderTarget.thumbnail
            )
        } catch {
            return false
        }
    }, [])

    // Fonts — match QMI font stack exactly (Bodoni + Overpass)
    useEffect(() => {
        if (
            fontCssUrl &&
            !document.querySelector(`link[data-hh-font-kit="${fontCssUrl}"]`)
        ) {
            const link = document.createElement("link")
            link.rel = "stylesheet"
            link.href = fontCssUrl
            link.setAttribute("data-hh-font-kit", fontCssUrl)
            document.head.appendChild(link)
        }
        if (!document.querySelector("#eh-fonts")) {
            const link = document.createElement("link")
            link.id = "eh-fonts"
            link.rel = "stylesheet"
            link.href =
                "https://fonts.googleapis.com/css2?family=Overpass:wght@300;400;700&family=Arapey:ital@0;1&display=swap"
            document.head.appendChild(link)
        }
        if (!document.querySelector("#eh-bodoni-font")) {
            const style = document.createElement("style")
            style.id = "eh-bodoni-font"
            style.textContent = `
                @font-face {
                    font-family: 'Bodoni';
                    src: url('https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/fonts/c22464fe-a274-436b-a1ab-4fa958bb6df4.woff2') format('woff2'),
                         url('https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/fonts/2b19eeea-00ba-42af-b306-77f62dbab741.woff') format('woff');
                    font-display: swap;
                }
            `
            document.head.appendChild(style)
        }
    }, [fontCssUrl])

    // Load data. Priority: explicit floorPlans prop (operator override) → live D1 API
    // (/api/public/floorplans, the source of truth for plan specs + starting price) →
    // embedded sample (canvas/thumbnail and offline fallback).
    useEffect(() => {
        let cancelled = false

        if (floorPlans && floorPlans.length > 0) {
            const normalized = floorPlans.map((plan) => ({
                ...plan,
                virtualTourUrl: plan.virtualTourUrl?.trim() || undefined,
            }))
            setAllPlans(normalized)
            setFiltered(normalized)
            setLoading(false)
            return
        }

        if (useEmbeddedData || isFramerThumbnail || !apiUrl) {
            setAllPlans(EMBEDDED_FLOOR_PLANS)
            setFiltered(EMBEDDED_FLOOR_PLANS)
            setLoading(false)
            return
        }

        setLoading(true)
        fetchFloorPlans(apiUrl)
            .then((plans) => {
                if (cancelled) return
                const data = plans.length ? plans : EMBEDDED_FLOOR_PLANS
                setAllPlans(data)
                setFiltered(data)
            })
            .catch((e) => {
                if (cancelled) return
                console.warn(
                    "[FloorPlans] Fetch failed, using embedded data",
                    e
                )
                setAllPlans(EMBEDDED_FLOOR_PLANS)
                setFiltered(EMBEDDED_FLOOR_PLANS)
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })

        return () => {
            cancelled = true
        }
    }, [floorPlans, apiUrl, useEmbeddedData, isFramerThumbnail])

    // Filter + sort
    useEffect(() => {
        let out = allPlans.filter((plan) => {
            if (filters.collection && plan.collection !== filters.collection)
                return false

            if (filters.bathrooms) {
                const minBaths = parseFloat(filters.bathrooms)
                if (plan.bathsMax < minBaths) return false
            }
            if (filters.bedrooms) {
                const minBeds = parseInt(filters.bedrooms)
                if (plan.bedsMax < minBeds) return false
            }

            if (filters.sqftRange) {
                const sqft = plan.livingSqft
                const [minStr, maxStr] = filters.sqftRange.split("-")
                const min = parseInt(minStr)
                const max = maxStr ? parseInt(maxStr) : Infinity
                if (sqft < min || sqft >= max) return false
            }

            if (filters.priceRange) {
                const price = plan.priceFrom
                if (filters.priceRange === "under-350000" && price >= 350000)
                    return false
                if (filters.priceRange === "over-350000" && price < 350000)
                    return false
            }

            return true
        })

        out = [...out].sort((a, b) => {
            if (sortBy === "price-asc")
                return (a.priceFrom || 999999999) - (b.priceFrom || 999999999)
            if (sortBy === "sqft-asc") return a.livingSqft - b.livingSqft
            return 0
        })

        setFiltered(out)
    }, [filters, sortBy, allPlans])

    const nextImage = useCallback((planId: number, total: number) => {
        setImageIndices((prev) => ({
            ...prev,
            [planId]: ((prev[planId] || 0) + 1) % total,
        }))
    }, [])
    const prevImage = useCallback((planId: number, total: number) => {
        setImageIndices((prev) => ({
            ...prev,
            [planId]: ((prev[planId] || 0) - 1 + total) % total,
        }))
    }, [])
    const getImageIndex = useCallback(
        (planId: number): number => imageIndices[planId] || 0,
        [imageIndices]
    )

    const getFloorPlanUrl = useCallback(
        (plan: FloorPlan): string => {
            if (plan.url) return baseUrl ? `${baseUrl}${plan.url}` : plan.url
            return baseUrl
                ? `${baseUrl}/floorplans/${plan.slug}/`
                : `/floorplans/${plan.slug}/`
        },
        [baseUrl]
    )

    const formatRange = (min: number, max: number): string =>
        min === max ? String(min) : `${min} - ${max}`

    // Icons
    const ChevronLeftIcon = () => (
        <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
    const ChevronRightIcon = () => (
        <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )

    if (isFramerThumbnail) {
        return (
            <div
                style={{
                    width: "100%",
                    height: "100%",
                    minHeight: 400,
                    background: "#F3F1ED",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "system-ui, sans-serif",
                }}
            >
                <div style={{ textAlign: "center", color: "#666" }}>
                    <div style={{ fontSize: 24, marginBottom: 8 }}>
                        Floor Plans Catalog
                    </div>
                    <div style={{ fontSize: 14 }}>Esperanza Homes</div>
                </div>
            </div>
        )
    }

    return (
        <div className="fp-wrap">
            {/* ── Filter Area (mirrors QuickMoveIns) ────────────────────── */}
            <div className="fp-filter-area">
                <div className="fp-filter-top">
                    <nav className="fp-tabs" aria-label="Find a home">
                        <a href={communitiesUrl} className="fp-tab">
                            Communities
                        </a>
                        <a href={quickMoveInsUrl} className="fp-tab">
                            Quick Move-Ins
                        </a>
                        <a href={floorPlansUrl} className="fp-tab active">
                            Floor Plans
                        </a>
                    </nav>

                    <div className="fp-primary-filters">
                        <div className="fp-dropdown">
                            <select
                                className="fp-select-pill"
                                value={filters.collection}
                                onChange={(e) =>
                                    setFilters((p) => ({
                                        ...p,
                                        collection: e.target.value,
                                    }))
                                }
                            >
                                <option value="">Collection</option>
                                {COLLECTION_OPTIONS.map((c) => (
                                    <option key={c.value} value={c.value}>
                                        {c.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="fp-dropdown">
                            <select
                                className="fp-select-pill"
                                value={filters.bedrooms}
                                onChange={(e) =>
                                    setFilters((p) => ({
                                        ...p,
                                        bedrooms: e.target.value,
                                    }))
                                }
                            >
                                <option value="">Bedrooms</option>
                                <option value="1">1+</option>
                                <option value="2">2+</option>
                                <option value="3">3+</option>
                                <option value="4">4+</option>
                                <option value="5">5+</option>
                            </select>
                        </div>

                        <div className="fp-dropdown">
                            <select
                                className="fp-select-pill"
                                value={filters.bathrooms}
                                onChange={(e) =>
                                    setFilters((p) => ({
                                        ...p,
                                        bathrooms: e.target.value,
                                    }))
                                }
                            >
                                <option value="">Bathrooms</option>
                                <option value="1">1+</option>
                                <option value="2">2+</option>
                                <option value="3">3+</option>
                                <option value="4">4+</option>
                            </select>
                        </div>

                        <div className="fp-dropdown">
                            <select
                                className="fp-select-pill"
                                value={filters.sqftRange}
                                onChange={(e) =>
                                    setFilters((p) => ({
                                        ...p,
                                        sqftRange: e.target.value,
                                    }))
                                }
                            >
                                <option value="">Square Feet</option>
                                <option value="0-500">Under 500</option>
                                <option value="500-1000">500 - 1,000</option>
                                <option value="1000-1500">1,000 - 1,500</option>
                                <option value="1500-2000">1,500 - 2,000</option>
                                <option value="2000-2500">2,000 - 2,500</option>
                                <option value="2500-3000">2,500 - 3,000</option>
                                <option value="3000-3500">3,000 - 3,500</option>
                                <option value="3500-4000">3,500 - 4,000</option>
                                <option value="4000-">Over 4,000</option>
                            </select>
                        </div>

                        <button
                            className="fp-filter-toggle-block"
                            onClick={() => setShowFilters(!showFilters)}
                        >
                            <span>{showFilters ? "Hide" : "Show"}</span>
                            <span>Filters</span>
                            <span className="fp-filter-chev">
                                {showFilters ? "^" : "v"}
                            </span>
                        </button>
                    </div>
                </div>

                {showFilters && (
                    <div className="fp-filter-bottom">
                        <div className="fp-dropdown">
                            <select
                                className="fp-select-pill"
                                value={filters.priceRange}
                                onChange={(e) =>
                                    setFilters((p) => ({
                                        ...p,
                                        priceRange: e.target.value,
                                    }))
                                }
                            >
                                <option value="">Price Range</option>
                                <option value="under-350000">
                                    Under $350,000
                                </option>
                                <option value="over-350000">
                                    Over $350,000
                                </option>
                            </select>
                        </div>
                        <div className="fp-dropdown">
                            <select
                                className="fp-select-pill"
                                value={sortBy}
                                onChange={(e) =>
                                    setSortBy(e.target.value as SortOption)
                                }
                            >
                                <option value="price-asc">
                                    Sort: Price (Lowest First)
                                </option>
                                <option value="sqft-asc">
                                    Sort: Sq.Ft. (Lowest First)
                                </option>
                            </select>
                        </div>
                        <a
                            className="fp-download"
                            href={downloadPdfUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <span
                                className="fp-download-icon"
                                aria-hidden="true"
                            />
                            Download Floor Plan List
                        </a>
                    </div>
                )}
            </div>

            {/* ── Title Row (mirrors QuickMoveIns) ───────────────────────── */}
            <div className="fp-title-row">
                <div className="fp-title-col">
                    <h1>Floor Plans</h1>
                </div>
                <div className="fp-visit-col">
                    <div className="fp-visit-box">
                        <span>Schedule Your Exploratory Visit</span>
                        <a href={ctaUrl}>Request Your Time</a>
                    </div>
                </div>
            </div>

            <p className="fp-disclaimer">
                *On Your Lot pricing shown is the base house price only and does
                not include the land or lot finishing fees.
            </p>

            {/* ── Floor Plan Grid ────────────────────────────────────────── */}
            <div className="fp-content">
                <div className="fp-grid">
                    {loading && (
                        <div className="fp-loading">Loading floor plans...</div>
                    )}
                    {!loading && filtered.length === 0 && (
                        <div className="fp-empty">
                            <p>No floor plans found matching your criteria.</p>
                        </div>
                    )}
                    {!loading &&
                        filtered.map((plan) => {
                            const currentImageIndex = getImageIndex(plan.id)
                            const currentImage =
                                plan.images[currentImageIndex] || plan.images[0]
                            const hasMultipleImages = plan.images.length > 1

                            return (
                                <article key={plan.id} className="fp-card">
                                    <div className="fp-card-left">
                                        <div className="fp-card-image">
                                            <img
                                                src={currentImage}
                                                alt={`${plan.name} floor plan`}
                                                loading="lazy"
                                            />
                                            {plan.virtualTourUrl && (
                                                <a
                                                    href={plan.virtualTourUrl}
                                                    className="fp-virtual-badge"
                                                    title="Virtual Tour Available"
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    style={cardFontStyle(
                                                        tourBadgeFont
                                                    )}
                                                >
                                                    <img
                                                        src={TOUR_ICON}
                                                        alt="360° Virtual Tour"
                                                    />
                                                </a>
                                            )}
                                            {hasMultipleImages && (
                                                <div className="fp-carousel-controls">
                                                    <button
                                                        className="fp-carousel-btn fp-carousel-prev"
                                                        onClick={(e) => {
                                                            e.preventDefault()
                                                            prevImage(
                                                                plan.id,
                                                                plan.images.length
                                                            )
                                                        }}
                                                        aria-label="Previous image"
                                                    >
                                                        <ChevronLeftIcon />
                                                    </button>
                                                    <button
                                                        className="fp-carousel-btn fp-carousel-next"
                                                        onClick={(e) => {
                                                            e.preventDefault()
                                                            nextImage(
                                                                plan.id,
                                                                plan.images.length
                                                            )
                                                        }}
                                                        aria-label="Next image"
                                                    >
                                                        <ChevronRightIcon />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div className="fp-card-body">
                                        <a
                                            href={getFloorPlanUrl(plan)}
                                            className="fp-card-name"
                                            style={cardFontStyle(titleFont)}
                                        >
                                            {plan.name}
                                        </a>
                                        <div className="fp-card-meta">
                                            <div
                                                className="fp-meta-label"
                                                style={cardFontStyle(
                                                    collectionLabelFont
                                                )}
                                            >
                                                PLAN COLLECTION
                                            </div>
                                            <div
                                                className="fp-meta-value"
                                                style={cardFontStyle(
                                                    collectionValueFont
                                                )}
                                            >
                                                {plan.collection}
                                            </div>
                                        </div>

                                        {plan.priceFrom > 0 && (
                                            <div
                                                className="fp-card-price"
                                                style={cardFontStyle(
                                                    collectionValueFont
                                                )}
                                            >
                                                From $
                                                {plan.priceFrom.toLocaleString()}
                                            </div>
                                        )}

                                        <div className="fp-card-specs">
                                            <div className="fp-spec-col">
                                                <div
                                                    className="fp-spec"
                                                    style={cardFontStyle(
                                                        specFont
                                                    )}
                                                >
                                                    <img
                                                        className="fp-spec-icon"
                                                        src={STAT_ICONS.bed}
                                                        alt=""
                                                    />
                                                    <span className="fp-spec-text">
                                                        {formatRange(
                                                            plan.bedsMin,
                                                            plan.bedsMax
                                                        )}{" "}
                                                        Bed
                                                    </span>
                                                </div>
                                                <div
                                                    className="fp-spec"
                                                    style={cardFontStyle(
                                                        specFont
                                                    )}
                                                >
                                                    <img
                                                        className="fp-spec-icon"
                                                        src={STAT_ICONS.bath}
                                                        alt=""
                                                    />
                                                    <span className="fp-spec-text">
                                                        {formatRange(
                                                            plan.bathsMin,
                                                            plan.bathsMax
                                                        )}{" "}
                                                        Bath
                                                    </span>
                                                </div>
                                                <div
                                                    className="fp-spec"
                                                    style={cardFontStyle(
                                                        specFont
                                                    )}
                                                >
                                                    <img
                                                        className="fp-spec-icon"
                                                        src={
                                                            STAT_ICONS.livingSqft
                                                        }
                                                        alt=""
                                                    />
                                                    <span className="fp-spec-text">
                                                        {plan.livingSqft.toLocaleString()}{" "}
                                                        <strong>Living</strong> Sq. Ft.
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="fp-spec-col">
                                                {plan.garage && (
                                                    <div
                                                        className="fp-spec"
                                                        style={cardFontStyle(
                                                            specFont
                                                        )}
                                                    >
                                                        <img
                                                            className="fp-spec-icon"
                                                            src={
                                                                STAT_ICONS.garage
                                                            }
                                                            alt=""
                                                        />
                                                        <span className="fp-spec-text">
                                                            {plan.garage}
                                                        </span>
                                                    </div>
                                                )}
                                                <div
                                                    className="fp-spec"
                                                    style={cardFontStyle(
                                                        specFont
                                                    )}
                                                >
                                                    <img
                                                        className="fp-spec-icon"
                                                        src={STAT_ICONS.stairs}
                                                        alt=""
                                                    />
                                                    <span className="fp-spec-text">
                                                        {plan.stories} Stor
                                                        {plan.stories === 1
                                                            ? "y"
                                                            : "ies"}
                                                    </span>
                                                </div>
                                                <div
                                                    className="fp-spec"
                                                    style={cardFontStyle(
                                                        specFont
                                                    )}
                                                >
                                                    <img
                                                        className="fp-spec-icon"
                                                        src={STAT_ICONS.sqft}
                                                        alt=""
                                                    />
                                                    <span className="fp-spec-text">
                                                        {plan.totalSqft.toLocaleString()}{" "}
                                                        <strong>Total</strong> Sq. Ft.
                                                    </span>
                                                </div>
                                            </div>
                                        </div>

                                        <a
                                            href={getFloorPlanUrl(plan)}
                                            className="fp-card-cta"
                                            style={cardFontStyle(buttonFont)}
                                        >
                                            View Details
                                        </a>
                                    </div>
                                </article>
                            )
                        })}
                </div>
            </div>

            <style>{`
                :root {
                    --fp-dark-green: ${primaryColor};
                    --fp-green: #407e52;
                    --fp-green-cta: #dfefe4;
                    --fp-tan: ${accentTan};
                    --fp-brown: #85754e;
                    --fp-text: ${textDark};
                    --fp-text-light: #636464;
                    --fp-white: #fff;
                    --fp-border: #dee2e6;
                    --fp-bg: #F3F1ED;
                    --fp-title-bg: #F1F0EB;
                    --fp-card-border: #F1F0EB;
                    --fp-font-bodoni: 'Bodoni', 'Arapey', Georgia, serif;
                    --fp-font-overpass: 'Overpass', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }

                .fp-wrap {
                    width: 100%;
                    background: var(--fp-white);
                    font-family: var(--fp-font-overpass);
                    font-weight: 300;
                    color: var(--fp-text);
                    min-height: 100vh;
                    -webkit-font-smoothing: antialiased;
                }

                .fp-wrap *, .fp-wrap *::before, .fp-wrap *::after {
                    box-sizing: border-box;
                }

                /* ── Filter Area (1:1 with QuickMoveIns) ───────────────── */
                .fp-filter-area { background: var(--fp-bg); }

                .fp-filter-top {
                    display: grid;
                    grid-template-columns: 41.65% 58.35%;
                    min-height: 72px;
                    position: relative;
                    z-index: 3;
                    box-shadow: 0 0.25rem 0.5rem rgba(0, 0, 0, 0.1);
                }

                .fp-tabs {
                    align-self: center;
                    display: inline-flex;
                    align-items: center;
                    height: 40px;
                    margin: 0;
                    padding-left: 20px;
                    width: fit-content;
                    min-width: 0;
                }

                .fp-tab {
                    display: block;
                    min-width: 148px;
                    height: 40px;
                    padding: 0 25px;
                    color: var(--fp-text);
                    background: var(--fp-white);
                    border-right: 1px solid #d0d0d0;
                    font-family: var(--fp-font-overpass);
                    font-weight: 300;
                    font-size: 14px;
                    line-height: 40px;
                    letter-spacing: 0.4px;
                    text-align: center;
                    text-decoration: none;
                    text-transform: uppercase;
                    white-space: nowrap;
                    transition: color 0.18s ease, background 0.18s ease;
                }

                .fp-tab:first-child { border-radius: 800px 0 0 800px; }
                .fp-tab:last-child  { border-right: 0; border-radius: 0 800px 800px 0; }

                .fp-tab.active, .fp-tab:hover {
                    color: #fff;
                    background: var(--fp-dark-green);
                }

                .fp-primary-filters {
                    display: grid;
                    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) 72px;
                    align-items: center;
                    gap: 12px;
                    padding: 16px 0 16px 12px;
                    min-width: 0;
                }

                .fp-primary-filters > * { min-width: 0; }
                .fp-dropdown { min-width: 0; }

                .fp-filter-bottom {
                    display: flex;
                    flex-wrap: wrap;
                    justify-content: flex-end;
                    align-items: center;
                    gap: 12px 14px;
                    min-height: 72px;
                    padding: 14px 22px;
                    border-top: 1px solid rgba(0, 0, 0, 0.03);
                    box-shadow: 0 0.125rem 0.25rem rgba(0, 0, 0, 0.075);
                    min-width: 0;
                }

                .fp-filter-bottom .fp-dropdown {
                    flex: 0 1 220px;
                    min-width: 160px;
                    max-width: 240px;
                }

                .fp-filter-toggle-block {
                    align-self: stretch;
                    width: 72px;
                    min-height: 72px;
                    border: 0;
                    color: #fff;
                    background: var(--fp-green);
                    font-family: var(--fp-font-overpass);
                    font-weight: 700;
                    font-size: 10px;
                    line-height: 13px;
                    letter-spacing: 0.4px;
                    text-transform: uppercase;
                    cursor: pointer;
                }

                .fp-filter-toggle-block span { display: block; }
                .fp-filter-chev {
                    margin-top: 6px;
                    font-family: Arial, sans-serif;
                    font-size: 15px;
                    line-height: 12px;
                }

                .fp-select-pill {
                    appearance: none;
                    -webkit-appearance: none;
                    background-color: var(--fp-white);
                    background-image: url("https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/green-down-arrow.svg");
                    background-position: right 15px center;
                    background-repeat: no-repeat;
                    background-size: 16px;
                    border: 1px solid var(--fp-border);
                    border-radius: 50rem;
                    color: var(--fp-text);
                    cursor: pointer;
                    font-family: var(--fp-font-overpass);
                    font-weight: 300;
                    font-size: 14px;
                    height: 40px;
                    line-height: 1.95rem;
                    padding: 0.375rem 2.5rem 0.375rem 1rem;
                    min-width: 100px;
                    width: 100%;
                }

                .fp-select-pill:focus {
                    outline: 2px solid var(--fp-green);
                    outline-offset: 1px;
                }

                .fp-download {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 9px;
                    height: 39px;
                    padding: 0 24px;
                    color: #fff;
                    background: var(--fp-dark-green);
                    border-radius: 800px;
                    font-family: var(--fp-font-overpass);
                    font-weight: 300;
                    font-size: 14px;
                    line-height: 39px;
                    letter-spacing: 0.4px;
                    text-decoration: none;
                    text-transform: uppercase;
                    white-space: nowrap;
                    flex-shrink: 0;
                }

                .fp-download:hover { background: var(--fp-green); color: #fff; }

                .fp-download-icon {
                    position: relative;
                    width: 12px;
                    height: 15px;
                    line-height: 1;
                }

                .fp-download-icon::before {
                    position: absolute;
                    inset: 0;
                    content: "\\2193";
                    font-size: 16px;
                    line-height: 15px;
                    text-align: center;
                }

                /* ── Title Row (1:1 with QuickMoveIns) ─────────────────── */
                .fp-title-row {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    align-items: center;
                    min-height: 75px;
                    padding: 12px 20px;
                    background: var(--fp-title-bg);
                    position: relative;
                    z-index: 1;
                    box-shadow: 0 0.25rem 0.5rem rgba(0, 0, 0, 0.1);
                    border-bottom: 1px solid var(--fp-border);
                }

                .fp-title-col { min-width: 0; }

                .fp-title-col h1 {
                    margin: 0;
                    color: rgb(60, 60, 60);
                    font-family: 'Overpass', var(--fp-font-overpass);
                    font-weight: 300;
                    font-size: clamp(1.5rem, 1.1rem + 1.1vw, 2rem);
                    line-height: 1.2;
                    letter-spacing: 0.2px;
                }

                .fp-visit-col {
                    min-width: 0;
                    justify-self: end;
                }

                .fp-visit-box {
                    display: flex;
                    align-items: center;
                    gap: 14px;
                    min-height: 56px;
                    padding: 8px 8px 8px 22px;
                    background: var(--fp-green-cta);
                    color: var(--fp-text);
                    border: 2px solid #fff;
                }

                .fp-visit-box span {
                    font-family: var(--fp-font-overpass);
                    font-weight: 300;
                    font-size: clamp(11px, 0.65rem + 0.25vw, 13px);
                    line-height: 1.3;
                    letter-spacing: 0.5px;
                    text-transform: uppercase;
                    white-space: nowrap;
                }

                .fp-visit-box a {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    min-height: 39px;
                    padding: 0 22px;
                    color: #fff;
                    background: var(--fp-dark-green);
                    border-radius: 800px;
                    font-family: var(--fp-font-overpass);
                    font-weight: 400;
                    font-size: clamp(11px, 0.65rem + 0.25vw, 13px);
                    line-height: 1;
                    letter-spacing: 0.5px;
                    text-decoration: none;
                    text-transform: uppercase;
                    white-space: nowrap;
                    flex-shrink: 0;
                }

                .fp-visit-box a:hover { background: var(--fp-green); }

                .fp-disclaimer {
                    margin: 12px 24px 0;
                    background: var(--fp-white);
                    font: italic 400 12px var(--fp-font-overpass);
                    color: var(--fp-text-light);
                }

                /* ── Content / Grid ───────────────────────────────────── */
                .fp-content {
                    padding: 20px 24px 40px;
                    max-width: 1500px;
                    margin: 0 auto;
                    background: var(--fp-white);
                }

                .fp-grid {
                    display: grid;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    gap: 8px;
                }

                .fp-card {
                    display: grid;
                    grid-template-columns: 58.333% 41.667%;
                    padding: 8px;
                    background: var(--fp-white);
                    border: 1px solid var(--fp-card-border);
                    container-type: inline-size;
                    transition: background-color 0.3s ease;
                    color: inherit;
                }

                .fp-card:hover {
                    background-color: var(--fp-white);
                }

                .fp-card-left {
                    display: flex;
                    flex-direction: column;
                    min-width: 0;
                }

                .fp-card-image {
                    position: relative;
                    aspect-ratio: 4 / 3;
                    overflow: hidden;
                    background: #eee;
                }

                .fp-card-image img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }

                .fp-virtual-badge {
                    position: absolute;
                    bottom: 12px;
                    left: 12px;
                    width: 48px;
                    height: 48px;
                    display: block;
                    z-index: 2;
                    line-height: 0;
                    text-decoration: none;
                }

                .fp-virtual-badge img {
                    width: 100%;
                    height: 100%;
                    display: block;
                }

                .fp-carousel-controls {
                    position: absolute;
                    bottom: 12px;
                    right: 12px;
                    display: flex;
                    gap: 6px;
                    z-index: 2;
                }

                .fp-carousel-btn {
                    width: 32px;
                    height: 32px;
                    background: rgba(255, 255, 255, 0.9);
                    border: none;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    color: var(--fp-text);
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
                }

                .fp-carousel-btn:hover { background: var(--fp-white); }

                .fp-carousel-btn svg {
                    width: 18px;
                    height: 18px;
                }

                .fp-card-body {
                    font-size: clamp(12px, 1.293cqw, 22px);
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    min-width: 0;
                    background: var(--fp-white);
                }

                .fp-card-name {
                    display: block;
                    margin: 0;
                    font-family: var(--fp-font-bodoni);
                    font-weight: 400;
                    font-size: 2.41em;
                    line-height: 1.02;
                    color: var(--fp-text);
                    text-decoration: none;
                    transition: color 0.2s;
                }

                .fp-card-name:hover { color: var(--fp-green); }

                .fp-card-meta {
                    margin-top: 0.64em;
                    margin-bottom: 0.5em;
                }

                .fp-meta-label {
                    display: block;
                    font-family: var(--fp-font-overpass);
                    font-weight: 700;
                    font-size: 0.75rem;
                    letter-spacing: normal;
                    text-transform: uppercase;
                    color: var(--fp-brown);
                    text-decoration: underline;
                    text-decoration-color: var(--fp-brown);
                    text-underline-offset: 3px;
                }

                .fp-meta-value {
                    display: block;
                    font-family: var(--fp-font-overpass);
                    font-weight: 400;
                    font-size: 0.875rem;
                    color: var(--fp-text);
                    line-height: 1.3;
                    margin-top: 4px;
                }

                .fp-card-price {
                    font-family: var(--fp-font-overpass);
                    font-weight: 600;
                    font-size: 1.05rem;
                    color: var(--fp-text);
                    line-height: 1.2;
                    margin-bottom: 0.6em;
                }

                .fp-card-specs {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 0 18px;
                    margin-top: auto;
                    margin-bottom: 0.75em;
                }

                .fp-spec-col {
                    display: flex;
                    flex-direction: column;
                    min-width: 0;
                }

                .fp-spec {
                    font-family: var(--fp-font-overpass);
                    font-weight: 300;
                    font-size: 0.75rem;
                    color: #000;
                    line-height: 1.2;
                    letter-spacing: normal;
                    text-transform: uppercase;
                    display: flex;
                    align-items: center;
                    gap: 0.35rem;
                    padding: 0.5em 0;
                    white-space: nowrap;
                }

                .fp-spec-icon {
                    width: 1.15em;
                    height: 1.15em;
                    flex-shrink: 0;
                }

                .fp-spec-text {
                    min-width: 0;
                }

                .fp-spec-text strong {
                    font-weight: 300;
                }

                .fp-card-cta {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 100%;
                    min-height: 39px;
                    padding: 10px 28px 8px;
                    margin-top: auto;
                    background-color: var(--fp-dark-green);
                    color: var(--fp-white);
                    border-radius: 50rem;
                    font-family: var(--fp-font-overpass);
                    font-weight: 300;
                    font-size: 12px;
                    letter-spacing: normal;
                    text-transform: uppercase;
                    text-align: center;
                    text-decoration: none;
                    cursor: pointer;
                    transition: background-color 0.3s;
                }

                .fp-card-cta:hover {
                    background-color: var(--fp-green);
                    color: var(--fp-white);
                }

                .fp-loading, .fp-empty {
                    grid-column: 1 / -1;
                    padding: 60px 40px;
                    text-align: center;
                    color: var(--fp-text-light);
                    font: 400 14px var(--fp-font-overpass);
                }

                /* ── Responsive (mirrors QuickMoveIns breakpoints) ──────── */
                @media (max-width: 1199px) {
                    .fp-filter-top { grid-template-columns: 45% 55%; }

                    .fp-tab {
                        min-width: 0;
                        padding: 0 16px;
                        font-size: 12px;
                    }

                    .fp-primary-filters {
                        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) 64px;
                        gap: 10px;
                    }

                    .fp-filter-toggle-block {
                        width: 64px;
                        min-height: 64px;
                    }

                    .fp-filter-bottom {
                        gap: 10px 12px;
                        padding: 12px 16px;
                    }

                    .fp-filter-bottom .fp-dropdown {
                        flex: 0 1 200px;
                        min-width: 150px;
                        max-width: 220px;
                    }

                    .fp-download {
                        padding: 0 18px;
                        font-size: 12px;
                    }

                    .fp-visit-box {
                        gap: 10px;
                        padding: 8px 8px 8px 16px;
                    }

                    .fp-visit-box span { font-size: 12px; }

                    .fp-filter-top { grid-template-columns: 1fr; }

                    .fp-tabs {
                        justify-content: flex-start;
                        margin: 12px 16px 4px;
                    }

                    .fp-primary-filters {
                        grid-template-columns: 1fr 1fr 1fr 1fr 56px;
                        padding: 0 16px 12px;
                        gap: 10px;
                    }

                    .fp-filter-toggle-block {
                        width: 56px;
                        min-height: 56px;
                    }

                    .fp-filter-bottom {
                        flex-wrap: wrap;
                        justify-content: stretch;
                        padding: 12px 16px;
                        gap: 10px;
                    }

                    .fp-filter-bottom .fp-dropdown {
                        flex: 1 1 calc(50% - 5px);
                    }

                    .fp-download {
                        flex: 1 1 100%;
                        justify-self: stretch;
                        text-align: center;
                    }

                    .fp-title-row {
                        grid-template-columns: 1fr;
                        align-items: stretch;
                        gap: 12px;
                        padding: 14px 16px;
                    }

                    .fp-visit-col { justify-self: stretch; }

                    .fp-visit-box {
                        justify-content: space-between;
                        padding: 10px 8px 10px 18px;
                    }

                    .fp-content { padding: 16px 16px 32px; }

                    .fp-disclaimer { margin: 8px 16px 0; }
                }

                @media (max-width: 809px) {
                    .fp-tabs {
                        width: 100%;
                        overflow-x: auto;
                        -webkit-overflow-scrolling: touch;
                        scrollbar-width: none;
                        padding: 12px 12px 4px;
                    }

                    .fp-tabs::-webkit-scrollbar { display: none; }

                    .fp-tab {
                        flex-shrink: 0;
                        min-width: 110px;
                        height: 36px;
                        line-height: 36px;
                        font-size: 11px;
                        padding: 0 14px;
                    }

                    .fp-primary-filters {
                        grid-template-columns: 1fr 1fr 56px;
                        gap: 8px;
                    }

                    /* Hide sqft picker (4th item) on mobile to keep one row */
                    .fp-primary-filters > .fp-dropdown:nth-child(4) { display: none; }

                    .fp-filter-bottom .fp-dropdown {
                        flex: 1 1 100%;
                    }

                    .fp-title-row {
                        grid-template-columns: 1fr;
                        gap: 10px;
                        padding: 12px 16px;
                    }

                    .fp-visit-col { justify-self: stretch; }

                    .fp-visit-box {
                        flex-direction: column;
                        align-items: stretch;
                        gap: 10px;
                        padding: 14px;
                        text-align: center;
                    }

                    .fp-visit-box span {
                        white-space: normal;
                        font-size: 12px;
                    }

                    .fp-visit-box a {
                        align-self: center;
                        min-width: 200px;
                    }

                    .fp-grid {
                        grid-template-columns: 1fr;
                        gap: 8px;
                    }

                    .fp-card {
                        grid-template-columns: 1fr;
                    }

                    .fp-card-specs {
                        grid-template-columns: 1fr;
                    }

                    .fp-content { padding: 12px 12px 32px; }
                }

                @media (prefers-reduced-motion: reduce) {
                    *, *::before, *::after {
                        animation-duration: 0.01ms !important;
                        animation-iteration-count: 1 !important;
                        transition-duration: 0.01ms !important;
                    }
                }
            `}</style>
        </div>
    )
}

addPropertyControls(FloorPlansCatalog, {
    primaryColor: {
        type: ControlType.Color,
        title: "Primary Color",
        defaultValue: "#295135",
    },
    strokeColor: {
        type: ControlType.Color,
        title: "Stroke Color",
        defaultValue: "#0c4128",
    },
    textDark: {
        type: ControlType.Color,
        title: "Text Color",
        defaultValue: "#3c3c3c",
    },
    accentTan: {
        type: ControlType.Color,
        title: "Accent Tan",
        defaultValue: "#85754e",
    },
    fontCssUrl: {
        type: ControlType.String,
        title: "Font CSS URL",
        defaultValue: "",
    },
    apiUrl: {
        type: ControlType.String,
        title: "Floor Plans API URL",
        defaultValue:
            "https://esperanza-api.round-base-ed8c.workers.dev/api/public/floorplans",
        description:
            "Live D1 floor-plans endpoint (source of truth for specs + starting price). Leave Use Embedded Data off to fetch live.",
    },
    useEmbeddedData: {
        type: ControlType.Boolean,
        title: "Use Embedded Data",
        defaultValue: false,
        description:
            "On = use built-in sample data (design/preview). Off = fetch live from the Floor Plans API URL.",
    },
    baseUrl: { type: ControlType.String, title: "Base URL", defaultValue: "" },
    communitiesUrl: {
        type: ControlType.String,
        title: "Communities URL",
        defaultValue: "/new-homes",
    },
    quickMoveInsUrl: {
        type: ControlType.String,
        title: "QMI URL",
        defaultValue: "/new-homes/available",
    },
    floorPlansUrl: {
        type: ControlType.String,
        title: "Floor Plans URL",
        defaultValue: "/new-homes/floorplans",
    },
    downloadPdfUrl: {
        type: ControlType.String,
        title: "Download PDF URL",
        defaultValue: "/new-homes/floorplans/pdf",
    },
    ctaUrl: {
        type: ControlType.String,
        title: "CTA URL",
        defaultValue: "#request-a-tour",
    },
    titleFont: cardFontControl("Card · Plan Name"),
    collectionLabelFont: cardFontControl("Card · Collection Label"),
    collectionValueFont: cardFontControl("Card · Collection Value"),
    specFont: cardFontControl("Card · Specs"),
    tourBadgeFont: cardFontControl("Card · Virtual Tour"),
    buttonFont: cardFontControl("Card · View Details"),
})