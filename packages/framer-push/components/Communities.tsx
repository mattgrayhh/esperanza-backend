import React, { useEffect, useMemo, useRef, useState } from "react"
import { addPropertyControls, ControlType } from "framer"

declare const RenderTarget: {
    current: () => string
    thumbnail: string
    canvas: string
    preview: string
}


const STAT_ICONS = {
    bed: "https://static.esperanzahomes.com/esperanza_homes/images/stats/bedroom.svg",
    bath: "https://static.esperanzahomes.com/esperanza_homes/images/stats/bathroom.svg",
    sqft: "https://static.esperanzahomes.com/esperanza_homes/images/stats/sqft.svg",
}

const MAP_PIN_SVG =
    "https://static.esperanzahomes.com/esperanza_homes/images/map_pin.svg"

type MapTilePreset =
    | "positron"
    | "positron-nolabels"
    | "voyager"
    | "voyager-nolabels"
    | "custom"

const MAP_TILE_PRESETS: Record<
    Exclude<MapTilePreset, "custom">,
    { url: string; attribution: string }
> = {
    positron: {
        url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
    "positron-nolabels": {
        url: "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png",
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
    voyager: {
        url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
    "voyager-nolabels": {
        url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png",
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
}

function buildMapTileFilter(warmth: number): string {
    if (warmth <= 0) return "none"
    const t = Math.min(100, warmth) / 100
    const sepia = (t * 0.35).toFixed(3)
    const saturate = (1 + t * 0.22).toFixed(3)
    const hue = (t * -14).toFixed(1)
    const brightness = (1 + t * 0.04).toFixed(3)
    return `sepia(${sepia}) saturate(${saturate}) hue-rotate(${hue}deg) brightness(${brightness})`
}

// ── Type Definitions ──

interface WorkerCommunity {
    id: string
    name: string
    slug: string
    town: string
    coordinates: string // "lat,lng"
    active: boolean
    address?: string
    image?: string
    secondaryImage?: string
    priceFrom?: number | null
    sqft?: string
    beds?: string
    baths?: string
    description?: string
    amenities?: string
    comingSoon?: boolean
    promoBannerText?: string
    promoBadgeText?: string
    promoCtaLabel?: string
    promoCtaLink?: string
}

interface Community {
    id: string
    name: string
    slug: string
    address: string
    town: string
    state: string
    priceFrom: number
    bedRange: string
    bathRange: string
    sqftRange: string
    description?: string
    amenities?: string
    image?: string
    secondaryImage?: string
    url: string
    coordinates: [number, number] // [lng, lat]
    active: boolean
    masterPlanned: boolean
    comingSoon?: boolean
    promoBannerText?: string
    promoBadgeText?: string
    promoCtaLabel?: string
    promoCtaLink?: string
}

interface CommunityFilterState {
    towns: string[]
    priceRange: string
    bedrooms: string
    bathrooms: string
    masterPlanned: boolean
}

interface CommunitiesProps {
    cacheWorkerUrl?: string
    tileUrl?: string
    tileAttribution?: string
    mapTilePreset?: MapTilePreset
    mapTileWarmth?: number
    mapCenterLat?: number
    mapCenterLng?: number
    defaultZoom?: number
    mapMinZoom?: number
    mapMaxZoom?: number
    autoFitBounds?: boolean
    fitBoundsMaxZoom?: number
    fitBoundsPadding?: number
    scrollWheelZoom?: boolean
    zoomControlPosition?: "topleft" | "topright" | "bottomleft" | "bottomright"
    maxClusterRadius?: number
    clusterSizeSmall?: number
    clusterSizeMedium?: number
    clusterSizeLarge?: number
    pinWidth?: number
    pinHeight?: number
    mpcPinSize?: number
    popupMaxWidth?: number
    popupMinWidth?: number
    popupOffsetY?: number
    popupShowIncentiveBanner?: boolean
    mapPanelBg?: string
    primaryColor?: string
    strokeColor?: string
    textDark?: string
    accentTan?: string
    fontCssUrl?: string
    communitiesUrl?: string
    quickMoveInsUrl?: string
    floorPlansUrl?: string
    downloadPdfUrl?: string
    filteredPdfBaseUrl?: string
    ctaUrl?: string
    showResultCount?: boolean
    bannerFont?: CardFontOverride
    titleFont?: CardFontOverride
    locationFont?: CardFontOverride
    specFont?: CardFontOverride
    priceLabelFont?: CardFontOverride
    priceFont?: CardFontOverride
    incentiveFont?: CardFontOverride
    buttonFont?: CardFontOverride
}

// Per-element typography overrides, editable on the Framer canvas (see the
// "Card Typography" property controls below). Each defaults to "Default"/0,
// which leaves the built-in responsive reference styling untouched.
interface CardFontOverride {
    fontFamily?: string
    fontWeight?: string
    fontSize?: number
}

const CARD_FONT_FAMILY_MAP: Record<string, string> = {
    Overpass: "'Overpass', sans-serif",
    Bodoni: "'Bodoni', 'Arapey', Georgia, serif",
    Arapey: "'Arapey', Georgia, serif",
    Georgia: "Georgia, serif",
    "Times New Roman": "'Times New Roman', serif",
}

// Build an inline style from a CardFontOverride. Returns undefined when nothing
// is overridden so the element keeps its responsive CSS (the 1:1 reference
// look). A fontSize > 0 locks that element to a fixed px size; 0 = auto-scale.
function cardFontStyle(o?: CardFontOverride): React.CSSProperties | undefined {
    if (!o) return undefined
    const s: React.CSSProperties = {}
    if (o.fontFamily && o.fontFamily !== "Default")
        s.fontFamily = CARD_FONT_FAMILY_MAP[o.fontFamily] || o.fontFamily
    if (o.fontWeight && o.fontWeight !== "Default")
        s.fontWeight = o.fontWeight as any
    if (o.fontSize && o.fontSize > 0) s.fontSize = o.fontSize
    return Object.keys(s).length ? s : undefined
}

// Builds a collapsible "Object" property control (Font + Weight + Size) for one
// card text element. Left disabled, the element keeps its responsive reference
// styling; enable it to override on the canvas.
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
                options: ["Default", "300", "400", "700"],
                optionTitles: ["Default", "Light", "Regular", "Bold"],
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
                    "0 = auto (scales with the card width). Set a px value to lock this element's size.",
            },
        },
    }
}

declare global {
    interface Window {
        L: any
    }
}

let clientCache: { data: Community[]; ts: number } | null = null
const CLIENT_CACHE_TTL = 60_000

// ── Master-Planned Community Icon (3 houses, white) ──
// Matches EsperanzaFindYourHome.tsx — the "Asset 1" 3-house glyph used to
// mark master-planned communities on the homepage map.
const MPC_ICON_PATH = "M845.14,157.27l-40.49-40.48V10.6c0-5.85-4.74-10.6-10.6-10.6h-45.41c-5.85,0-10.59,4.75-10.59,10.6v39.58l-40.4-40.4c-6.31-6.31-14.7-9.78-23.62-9.78s-17.3,3.47-23.61,9.78l-115.99,115.99-16.39,16.39-15.11,15.11c-4.46,4.46-7.39,9.88-8.8,15.6l-33.26-33.26c-8.93-8.93-20.79-13.84-33.42-13.84s-24.49,4.91-33.42,13.84l-33.24,33.24c-1.43-5.85-4.44-11.21-8.81-15.58l-40.48-40.48V10.6c0-5.85-4.75-10.6-10.6-10.6h-45.41c-5.86,0-10.6,4.75-10.6,10.6v39.58l-40.4-40.4c-6.31-6.31-14.69-9.78-23.61-9.78s-17.31,3.47-23.62,9.78L9.77,157.27c-13.02,13.02-13.02,34.21,0,47.23,6.31,6.31,14.7,9.78,23.62,9.78,1.87,0,3.71-.16,5.52-.46v108.97c0,21.49,17.48,38.98,38.98,38.98h68.93c5.85,0,10.6-4.75,10.6-10.6v-80.22h46.92v58.35l-19.05,19.05c-18.42,18.43-18.42,48.41,0,66.84,8.93,8.92,20.8,13.84,33.42,13.84,2.65,0,5.26-.23,7.82-.65v154.22c0,30.42,24.74,55.17,55.16,55.17h97.56c8.29,0,15-6.72,15-15v-113.54h66.4v113.54c0,8.28,6.72,15,15,15h97.56c30.42,0,55.17-24.75,55.17-55.17v-154.22c2.56.42,5.16.65,7.81.65,6.31,0,12.43-1.23,18.09-3.58,5.66-2.34,10.86-5.81,15.33-10.27,8.93-8.92,13.84-20.79,13.84-33.41s-4.91-24.5-13.84-33.42l-19.03-19.03v-58.37h46.91v80.22c0,5.85,4.75,10.6,10.6,10.6h68.94c21.49,0,38.98-17.49,38.98-38.98v-108.97c1.8.3,3.65.46,5.51.46h.01c8.91,0,17.3-3.47,23.61-9.78,6.31-6.31,9.78-14.7,9.78-23.62s-3.47-17.3-9.78-23.61ZM759.23,21.2h24.22v74.39l-24.22-24.21V21.2ZM266.09,21.2h24.21v74.39l-24.21-24.21V21.2ZM42.01,189.51c-1.15,1.15-2.49,2.04-3.95,2.65-1.46.6-3.04.92-4.67.92-3.26,0-6.32-1.27-8.63-3.57-4.75-4.76-4.75-12.49,0-17.25L172.24,24.77c2.31-2.3,5.37-3.57,8.63-3.57s6.32,1.27,8.62,3.57l147.49,147.49c4.76,4.75,4.76,12.49,0,17.25-2.3,2.3-5.37,3.57-8.62,3.57s-6.32-1.27-8.63-3.57L188.37,58.14c-4.14-4.14-10.85-4.14-14.99,0L42.01,189.51ZM214.93,249.75h-68.11c-5.85,0-10.6,4.75-10.6,10.6v80.22h-58.33c-9.81,0-17.79-7.97-17.79-17.78v-121.4l120.78-120.77,120.77,120.77v30.6l-76.12,76.12v-47.76c0-5.85-4.74-10.6-10.6-10.6ZM598.38,582.6c0,13.88-11.29,25.17-25.17,25.17h-82.56v-113.54c0-8.28-6.71-15-15-15h-96.4c-8.28,0-15,6.72-15,15v113.54h-82.56c-13.88,0-25.17-11.29-25.17-25.17v-171.81l170.93-170.92,170.93,170.92v171.81ZM648.4,393.97c-3.26,3.26-7.6,5.06-12.21,5.06s-8.94-1.8-12.2-5.06h-.01l-32.2-32.2-21.21-21.21-17.3-17.3-21.21-21.21-94-94c-5.86-5.86-15.35-5.86-21.21,0l-94,93.99-21.21,21.21-17.31,17.31h0l-12.32,12.32-41.09,41.09c-1.63,1.63-3.53,2.89-5.6,3.75s-4.3,1.31-6.61,1.31c-4.61,0-8.94-1.8-12.2-5.06-6.73-6.73-6.73-17.68,0-24.41l7.81-7.81h0l21.18-21.18,66.15-66.15,21.2-21.2,92.4-92.4c3.26-3.26,7.59-5.05,12.2-5.05s8.95,1.79,12.21,5.05l82.78,82.78,30.82,30.82,66.15,66.15,21.18,21.18h0l7.81,7.81c6.73,6.73,6.73,17.68,0,24.41ZM794.81,322.79c0,9.81-7.98,17.78-17.78,17.78h-58.34v-80.22c0-5.85-4.74-10.6-10.6-10.6h-68.11c-5.86,0-10.6,4.75-10.6,10.6v47.77l-17.07-17.07-30-30-29.05-29.06v-30.6l29.05-29.05h0s30-30,30-30h0s61.72-61.72,61.72-61.72l120.78,120.77v121.4ZM830.15,189.51c-2.3,2.3-5.37,3.57-8.63,3.57s-6.31-1.27-8.62-3.57l-131.37-131.37c-4.14-4.14-10.85-4.14-14.99,0l-67.71,67.71-29.92,29.92-20.86,20.86-12.88,12.88c-1.15,1.15-2.5,2.04-3.96,2.65-1.46.6-3.04.92-4.67.92-3.19,0-6.22-1.23-8.5-3.46-.04-.03-.08-.07-.12-.11-4.76-4.76-4.76-12.49,0-17.25l.12-.12,46.37-46.37,101-101c2.3-2.3,5.37-3.57,8.62-3.57s6.33,1.27,8.63,3.57l147.49,147.49c4.76,4.75,4.76,12.49,0,17.25Z"
const MPC_ICON_VIEWBOX = "0 0 854.92 637.77"

function parseCoords(raw: string): [number, number] | null {
    if (!raw || typeof raw !== "string") return null
    const parts = raw.split(",").map((s) => parseFloat(s.trim()))
    if (parts.length !== 2 || parts.some(isNaN)) return null
    const [lat, lng] = parts
    return [lng, lat]
}

function isMasterPlanned(name: string): boolean {
    return /master[\s-]*planned[\s-]*community/i.test(name)
}

function transformWorkerRecord(c: WorkerCommunity): Community | null {
    const coords = parseCoords(c.coordinates)
    if (!coords) return null

    const name = c.name || "Community"
    return {
        id: c.id,
        name,
        slug: c.slug || "",
        address: c.address || "",
        town: c.town || "",
        state: "TX",
        priceFrom: typeof c.priceFrom === "number" ? c.priceFrom : 0,
        bedRange: c.beds || "",
        bathRange: c.baths || "",
        sqftRange: c.sqft || "",
        description: c.description || "",
        amenities: c.amenities || "",
        image: c.image || "",
        secondaryImage: c.secondaryImage || "",
        url: c.slug ? `/new-homes/${c.slug}/` : "#",
        coordinates: coords,
        active: c.active !== false,
        masterPlanned: isMasterPlanned(name),
        comingSoon: c.comingSoon === true,
        promoBannerText: c.promoBannerText || "",
        promoBadgeText: c.promoBadgeText || "",
        promoCtaLabel: c.promoCtaLabel || "",
        promoCtaLink: c.promoCtaLink || "",
    }
}

async function fetchFromWorker(workerUrl: string): Promise<Community[]> {
    const res = await fetch(`${workerUrl}/communities`)
    if (!res.ok) throw new Error(`Worker HTTP ${res.status}`)
    const json = await res.json()
    const records: WorkerCommunity[] = json.communities || []
    return records
        .map(transformWorkerRecord)
        .filter((c): c is Community => c !== null && c.active)
}

const SAMPLE_COMMUNITIES: Community[] = [
    {
        id: "c-1",
        name: "Las Brisas at Tres Lagos",
        slug: "las-brisas-at-tres-lagos",
        address: "5810 N Catalpa Avenue",
        town: "McAllen",
        state: "TX",
        priceFrom: 226990,
        bedRange: "3 - 4",
        bathRange: "2 - 3",
        sqftRange: "1,249 - 2,442",
        description:
            "A vibrant new community at Tres Lagos featuring modern, energy-efficient homes with resort-style amenities.",
        image: "https://media.esperanzahomes.com/153/2025/11/6/110325_Las_Brisas_Model_Home_33.jpg",
        url: "/new-homes/las-brisas-at-tres-lagos/",
        coordinates: [-98.25, 26.2],
        active: true,
        masterPlanned: false,
        comingSoon: true,
    },
    {
        id: "c-2",
        name: "Anaqua at Tres Lagos",
        slug: "anaqua-at-tres-lagos",
        address: "4008 N Sorgum Circle",
        town: "McAllen",
        state: "TX",
        priceFrom: 313990,
        bedRange: "3 - 5",
        bathRange: "2 - 3.5",
        sqftRange: "1,800 - 3,200",
        description:
            "Signature homes in McAllen's premier master-planned community.",
        image: "https://media.esperanzahomes.com/153/2025/8/19/062225_4008_N_Sorgum_Cir_Pecan_Tuscan_Stucco_01.jpg",
        url: "/new-homes/anaqua-at-tres-lagos/",
        coordinates: [-98.2306, 26.2034],
        active: true,
        masterPlanned: false,
        promoBannerText: "Enjoy $15,000 in a Flex Discount!",
        promoBadgeText: "Unlock Your Flex Discount Now!",
        promoCtaLabel: "Learn More",
        promoCtaLink: "https://www.esperanzahomes.com/incentives/",
    },
    {
        id: "c-3",
        name: "Silos at La Sienna",
        slug: "silos-at-la-sienna",
        address: "1417 Silos Avenue",
        town: "Edinburg",
        state: "TX",
        priceFrom: 268990,
        bedRange: "3 - 4",
        bathRange: "2 - 2.5",
        sqftRange: "1,500 - 2,400",
        description:
            "Heritage-collection homes in one of Edinburg's most desirable master-planned communities.",
        image: "https://media.esperanzahomes.com/153/2025/7/2/121324_Magnolia_Farmhouse_1417_Silos_Ave-01_1.jpg",
        url: "/new-homes/silos-at-la-sienna/",
        coordinates: [-98.13, 26.29],
        active: true,
        masterPlanned: true,
    },
    {
        id: "c-4",
        name: "El Eden",
        slug: "el-eden",
        address: "908 Templo Dorado",
        town: "Laredo",
        state: "TX",
        priceFrom: 224990,
        bedRange: "3 - 4",
        bathRange: "2 - 3",
        sqftRange: "1,233 - 2,100",
        description: "Welcoming homes in a growing Laredo neighborhood.",
        image: "https://media.esperanzahomes.com/153/2025/12/22/Enhanced_Twilight_-_908_Templo_Dorado_1.jpg",
        url: "/new-homes/el-eden/",
        coordinates: [-99.52, 27.48],
        active: true,
        masterPlanned: false,
    },
    {
        id: "c-5",
        name: "Stewart Coves",
        slug: "stewart-coves",
        address: "2301 Stewart Road",
        town: "San Juan",
        state: "TX",
        priceFrom: 248990,
        bedRange: "3 - 4",
        bathRange: "2 - 3",
        sqftRange: "1,400 - 2,300",
        description:
            "Family-friendly homes designed for life in San Juan's growing east side.",
        image: "https://media.esperanzahomes.com/153/2025/7/9/040325-Encino-Model-Home-Exterior-03-1_1.jpg",
        url: "/new-homes/stewart-coves/",
        coordinates: [-98.15, 26.19],
        active: true,
        masterPlanned: false,
    },
    {
        id: "c-6",
        name: "Harvest Coves",
        slug: "harvest-coves",
        address: "5502 Harvest Lane",
        town: "McAllen",
        state: "TX",
        priceFrom: 269990,
        bedRange: "3 - 5",
        bathRange: "2 - 3",
        sqftRange: "1,600 - 2,800",
        description:
            "Signature collection homes with resort-style amenities just minutes from downtown.",
        image: "https://media.esperanzahomes.com/153/2026/1/8/Harvest_Coves_Aerial_Update_11.jpg",
        url: "/new-homes/harvest-coves/",
        coordinates: [-98.22, 26.23],
        active: true,
        masterPlanned: false,
    },
]

/**
 * @framerDisableUnlink
 * @framerIntrinsicWidth 1440
 * @framerIntrinsicHeight 900
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight any
 */
export default function Communities({
    cacheWorkerUrl = "https://esperanza-communities-cache.round-base-ed8c.workers.dev",
    tileUrl = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    tileAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    mapTilePreset = "positron",
    mapTileWarmth = 0,
    mapCenterLat = 26.19,
    mapCenterLng = -98.23,
    defaultZoom = 8,
    mapMinZoom = 3,
    mapMaxZoom = 16,
    autoFitBounds = true,
    fitBoundsMaxZoom = 11,
    fitBoundsPadding = 40,
    scrollWheelZoom = true,
    zoomControlPosition = "topleft",
    maxClusterRadius = 50,
    clusterSizeSmall = 36,
    clusterSizeMedium = 42,
    clusterSizeLarge = 48,
    pinWidth = 20,
    pinHeight = 32,
    mpcPinSize = 34,
    popupMaxWidth = 320,
    popupMinWidth = 280,
    popupOffsetY = -32,
    popupShowIncentiveBanner = false,
    mapPanelBg = "#e9edea",
    primaryColor = "#295135",
    strokeColor = "#0c4128",
    textDark = "#3c3c3c",
    accentTan = "#85754e",
    fontCssUrl = "",
    communitiesUrl = "/new-homes",
    quickMoveInsUrl = "/new-homes/available",
    floorPlansUrl = "/floorplan-collections",
    downloadPdfUrl = "/new-homes/pdf",
    filteredPdfBaseUrl = "",
    ctaUrl = "#request-a-tour",
    showResultCount = false,
    bannerFont,
    titleFont,
    locationFont,
    specFont,
    priceLabelFont,
    priceFont,
    incentiveFont,
    buttonFont,
}: CommunitiesProps) {
    const mapEl = useRef<HTMLDivElement | null>(null)
    const mapRef = useRef<any>(null)
    const popupRef = useRef<any>(null)
    const listRef = useRef<HTMLDivElement | null>(null)

    const [mapLoaded, setMapLoaded] = useState(false)
    const [mapReady, setMapReady] = useState(false)
    const [communities, setCommunities] = useState<Community[]>([])
    const [filtered, setFiltered] = useState<Community[]>([])
    const [loading, setLoading] = useState(true)
    const [showFilters, setShowFilters] = useState(true)
    const [mobileView, setMobileView] = useState<"list" | "map">("list")
    const [sortBy, setSortBy] = useState<string>("name-asc")
    const [hoveredCardId, setHoveredCardId] = useState<string | null>(null)
    const [filters, setFilters] = useState<CommunityFilterState>({
        towns: [],
        priceRange: "",
        bedrooms: "",
        bathrooms: "",
        masterPlanned: false,
    })

    const shouldRenderMap = useMemo(() => {
        try {
            return (
                typeof RenderTarget === "undefined" ||
                RenderTarget.current() !== RenderTarget.thumbnail
            )
        } catch {
            return true
        }
    }, [])

    const resolvedTile = useMemo(
        () =>
            mapTilePreset === "custom"
                ? { url: tileUrl, attribution: tileAttribution }
                : MAP_TILE_PRESETS[mapTilePreset],
        [mapTilePreset, tileUrl, tileAttribution]
    )

    const mapTileFilter = useMemo(
        () => buildMapTileFilter(mapTileWarmth),
        [mapTileWarmth]
    )

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
                    src: url('https://static.esperanzahomes.com/esperanza_homes/fonts/c22464fe-a274-436b-a1ab-4fa958bb6df4.woff2') format('woff2'),
                         url('https://static.esperanzahomes.com/esperanza_homes/fonts/2b19eeea-00ba-42af-b306-77f62dbab741.woff') format('woff');
                    font-display: swap;
                }
            `
            document.head.appendChild(style)
        }
    }, [fontCssUrl])

    const [mapRequested, setMapRequested] = useState(false)

    useEffect(() => {
        if (!shouldRenderMap) return
        const mql = window.matchMedia("(min-width: 992px)")
        if (mql.matches) {
            setMapRequested(true)
        }
    }, [shouldRenderMap])

    useEffect(() => {
        if (mobileView === "map") setMapRequested(true)
    }, [mobileView])

    useEffect(() => {
        if (!mapRequested) return

        const ensureCss = (id: string, href: string) => {
            if (document.querySelector(`#${id}`)) return
            const link = document.createElement("link")
            link.id = id
            link.rel = "stylesheet"
            link.href = href
            document.head.appendChild(link)
        }

        ensureCss(
            "leaflet-css",
            "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
        )
        ensureCss(
            "leaflet-mc-css",
            "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css"
        )
        ensureCss(
            "leaflet-mc-default-css",
            "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css"
        )

        const loadScript = (src: string): Promise<void> =>
            new Promise((resolve, reject) => {
                const existing = document.querySelector(
                    `script[data-src="${src}"]`
                )
                if (existing) {
                    existing.addEventListener("load", () => resolve())
                    return
                }
                const s = document.createElement("script")
                s.src = src
                s.async = true
                s.dataset.src = src
                s.onload = () => resolve()
                s.onerror = () => reject(new Error(`Failed to load ${src}`))
                document.body.appendChild(s)
            })

        const ready = () => setMapLoaded(true)

        if (window.L && (window.L as any).markerClusterGroup) {
            ready()
        } else if (window.L) {
            loadScript(
                "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"
            ).then(ready)
        } else {
            loadScript("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js")
                .then(() =>
                    loadScript(
                        "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"
                    )
                )
                .then(ready)
        }
    }, [mapRequested])

    useEffect(() => {
        loadData()
    }, [cacheWorkerUrl])

    async function loadData() {
        if (clientCache && Date.now() - clientCache.ts < CLIENT_CACHE_TTL) {
            setCommunities(clientCache.data)
            setFiltered(clientCache.data)
            setLoading(false)
            return
        }

        setLoading(true)
        try {
            let data: Community[]
            if (cacheWorkerUrl) {
                data = await fetchFromWorker(cacheWorkerUrl)
                if (!data.length) data = SAMPLE_COMMUNITIES
            } else {
                data = SAMPLE_COMMUNITIES
            }
            clientCache = { data, ts: Date.now() }
            setCommunities(data)
            setFiltered(data)
        } catch (e) {
            console.warn("[Communities] Fetch failed, using sample data", e)
            setCommunities(SAMPLE_COMMUNITIES)
            setFiltered(SAMPLE_COMMUNITIES)
        }
        setLoading(false)
    }

    const clusterRef = useRef<any>(null)

    useEffect(() => {
        if (!mapLoaded || !mapEl.current || mapRef.current || !shouldRenderMap)
            return
        const L = window.L

        let map: any
        try {
            map = L.map(mapEl.current, {
                center: [mapCenterLat, mapCenterLng],
                zoom: defaultZoom,
                minZoom: mapMinZoom,
                maxZoom: mapMaxZoom,
                zoomControl: false,
                scrollWheelZoom,
                fadeAnimation: false,
                markerZoomAnimation: false,
                preferCanvas: true,
            })
        } catch (e) {
            console.warn("[Communities] Map init failed:", e)
            return
        }
        mapRef.current = map

        L.control.zoom({ position: zoomControlPosition }).addTo(map)

        L.tileLayer(resolvedTile.url, {
            attribution: resolvedTile.attribution,
            subdomains: "abcd",
            maxZoom: mapMaxZoom,
            detectRetina: true,
        }).addTo(map)

        const cluster = L.markerClusterGroup({
            showCoverageOnHover: false,
            spiderfyOnMaxZoom: true,
            maxClusterRadius,
            animate: false,
            animateAddingMarkers: false,
            chunkedLoading: true,
            iconCreateFunction: (c: any) => {
                const count = c.getChildCount()
                const size =
                    count < 10
                        ? clusterSizeSmall
                        : count < 20
                          ? clusterSizeMedium
                          : clusterSizeLarge
                return L.divIcon({
                    html: `<div class="qmi-cluster-icon" style="width:${size}px;height:${size}px;background:${primaryColor};border:2px solid ${strokeColor};">${count}</div>`,
                    className: "qmi-cluster-wrap",
                    iconSize: [size, size],
                })
            },
        })
        clusterRef.current = cluster
        map.addLayer(cluster)

        setMapReady(true)

        return () => {
            if (popupRef.current && popupRef.current.remove)
                popupRef.current.remove()
            if (mapRef.current) mapRef.current.remove()
            mapRef.current = null
            clusterRef.current = null
            setMapReady(false)
        }
    }, [
        mapLoaded,
        shouldRenderMap,
        resolvedTile.url,
        resolvedTile.attribution,
        mapCenterLat,
        mapCenterLng,
        defaultZoom,
        mapMinZoom,
        mapMaxZoom,
        scrollWheelZoom,
        zoomControlPosition,
        maxClusterRadius,
        clusterSizeSmall,
        clusterSizeMedium,
        clusterSizeLarge,
        primaryColor,
        strokeColor,
    ])

    useEffect(() => {
        const map = mapRef.current
        const cluster = clusterRef.current
        const L = window.L
        if (!map || !cluster || !mapReady || !L) return

        cluster.clearLayers()

        const standardPinIcon = L.divIcon({
            className: "qmi-pin-wrap qmi-pin-wrap--teardrop",
            html: `<img class="qmi-pin-teardrop" src="${MAP_PIN_SVG}" alt="" style="width:${pinWidth}px;height:${pinHeight}px" />`,
            iconSize: [pinWidth, pinHeight],
            iconAnchor: [pinWidth / 2, pinHeight],
        })

        const mpcPinIcon = L.divIcon({
            className: "qmi-pin-wrap",
            html: `<div class="qmi-pin qmi-pin-mpc" style="background:${primaryColor};width:${mpcPinSize}px;height:${mpcPinSize}px;"><svg class="qmi-pin-house" viewBox="${MPC_ICON_VIEWBOX}" aria-hidden="true"><path d="${MPC_ICON_PATH}" fill="#fff"/></svg></div>`,
            iconSize: [mpcPinSize, mpcPinSize],
            iconAnchor: [mpcPinSize / 2, mpcPinSize / 2],
        })

        const markers: any[] = []
        let activeHoverCloseTimer: ReturnType<typeof setTimeout> | null = null
        const clearActiveHoverClose = () => {
            if (activeHoverCloseTimer) {
                clearTimeout(activeHoverCloseTimer)
                activeHoverCloseTimer = null
            }
        }

        for (const c of filtered) {
            const [lng, lat] = c.coordinates
            if (
                typeof lat !== "number" ||
                typeof lng !== "number" ||
                isNaN(lat) ||
                isNaN(lng)
            )
                continue
            const icon = c.masterPlanned ? mpcPinIcon : standardPinIcon
            const m = L.marker([lat, lng], { icon })
            const html = createPopupHTML(c)
            m.bindPopup(html, {
                closeButton: true,
                maxWidth: popupMaxWidth,
                minWidth: popupMinWidth,
                offset: [0, popupOffsetY],
                className: "qmi-leaflet-popup",
            })

            const clearHoverClose = () => {
                clearActiveHoverClose()
            }
            const bindPopupHover = () => {
                const popupEl = m.getPopup()?.getElement?.()
                if (!popupEl || popupEl.dataset.qmiHoverBound) return
                popupEl.dataset.qmiHoverBound = "1"
                popupEl.addEventListener("mouseenter", () => {
                    clearHoverClose()
                    setHoveredCardId(c.id)
                })
                popupEl.addEventListener("mouseleave", () => {
                    m.closePopup()
                    setHoveredCardId((id) => (id === c.id ? null : id))
                })
            }

            m.on("mouseover", () => {
                clearHoverClose()
                map.eachLayer((layer: any) => {
                    if (layer?.closePopup) layer.closePopup()
                })
                m.openPopup()
                bindPopupHover()
                setHoveredCardId(c.id)
            })
            m.on("mouseout", () => {
                clearHoverClose()
                activeHoverCloseTimer = setTimeout(() => {
                    const popupEl = m.getPopup()?.getElement?.()
                    if (popupEl && popupEl.matches(":hover")) return
                    m.closePopup()
                    setHoveredCardId((id) => (id === c.id ? null : id))
                }, 120)
            })
            m.on("popupopen", bindPopupHover)

            markers.push(m)
        }

        cluster.addLayers(markers)

        if (markers.length > 0 && autoFitBounds) {
            const bounds = cluster.getBounds()
            if (bounds.isValid()) {
                map.fitBounds(bounds, {
                    padding: [fitBoundsPadding, fitBoundsPadding],
                    maxZoom: fitBoundsMaxZoom,
                })
            }
        } else if (!autoFitBounds) {
            map.setView([mapCenterLat, mapCenterLng], defaultZoom)
        }
    }, [
        filtered,
        mapReady,
        primaryColor,
        strokeColor,
        autoFitBounds,
        fitBoundsMaxZoom,
        fitBoundsPadding,
        mapCenterLat,
        mapCenterLng,
        defaultZoom,
        pinWidth,
        pinHeight,
        mpcPinSize,
        popupMaxWidth,
        popupMinWidth,
        popupOffsetY,
        popupShowIncentiveBanner,
        clusterSizeSmall,
        clusterSizeMedium,
        clusterSizeLarge,
    ])

    useEffect(() => {
        let out = communities.filter((c) => {
            if (filters.masterPlanned && !c.masterPlanned) return false

            if (filters.towns.length) {
                if (!c.town || !filters.towns.includes(c.town)) return false
            }

            if (filters.priceRange && c.priceFrom) {
                const [min, max] = filters.priceRange.split("-").map(Number)
                if (max) {
                    if (c.priceFrom < min || c.priceFrom > max) return false
                } else {
                    if (c.priceFrom < min) return false
                }
            }

            if (filters.bedrooms && c.bedRange) {
                const minBed = parseInt(filters.bedrooms)
                const parts = c.bedRange
                    .split("-")
                    .map((s) => parseInt(s.trim()))
                const high = parts[parts.length - 1]
                if (isNaN(high) || high < minBed) return false
            }

            if (filters.bathrooms && c.bathRange) {
                const minBath = parseFloat(filters.bathrooms)
                const parts = c.bathRange
                    .split("-")
                    .map((s) => parseFloat(s.trim()))
                const high = parts[parts.length - 1]
                if (isNaN(high) || high < minBath) return false
            }

            return true
        })

        out = [...out].sort((a, b) => {
            if (sortBy === "name-asc") return a.name.localeCompare(b.name)
            if (sortBy === "name-desc") return b.name.localeCompare(a.name)
            if (sortBy === "price-asc")
                return (a.priceFrom || 999999999) - (b.priceFrom || 999999999)
            if (sortBy === "price-desc")
                return (b.priceFrom || 0) - (a.priceFrom || 0)
            return 0
        })

        setFiltered(out)
    }, [filters, communities, sortBy])

    const filteredPdfHref = useMemo(() => {
        if (!filteredPdfBaseUrl) return downloadPdfUrl
        const base = filteredPdfBaseUrl.replace(/\/$/, "")
        const p = new URLSearchParams()
        if (filters.towns.length === 1) {
            p.set("city", filters.towns[0].toLowerCase().replace(/\s+/g, "-"))
        }
        const qs = p.toString()
        return `${base}/pdf/filtered/communities${qs ? "?" + qs : ""}`
    }, [filters.towns, filteredPdfBaseUrl, downloadPdfUrl])

    const uniqueTowns = useMemo(
        () =>
            [
                ...new Set(communities.map((c) => c.town).filter(Boolean)),
            ].sort() as string[],
        [communities]
    )

    function escapeHtml(s: string) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;")
    }

    function createPopupHTML(c: Community) {
        const priceAmount = c.priceFrom
            ? `$${Number(c.priceFrom).toLocaleString()}`
            : ""
        const cityState = `${c.town || ""}${c.town && c.state ? ", " : ""}${c.state || ""}`
        const href = escapeHtml(c.url || "#")
        const badge = c.comingSoon
            ? `<span class="qmi-popup-badge qmi-popup-badge--soon">Coming Soon</span>`
            : popupShowIncentiveBanner && c.promoBadgeText
              ? `<span class="qmi-popup-badge qmi-popup-badge--promo">${escapeHtml(c.promoBadgeText)}</span>`
              : ""
        return `
            <a class="qmi-popup" href="${href}">
                ${c.image ? `<div class="qmi-popup-imgwrap"><img class="qmi-popup-img" src="${escapeHtml(c.image)}" alt="${escapeHtml(c.name)}" loading="lazy" />${badge}</div>` : ""}
                <div class="qmi-popup-body">
                    <div class="qmi-popup-info">
                        <div class="qmi-popup-title">${escapeHtml(c.name ?? "")}</div>
                        <div class="qmi-popup-location">${escapeHtml(cityState)}</div>
                    </div>
                    ${priceAmount ? `<div class="qmi-popup-price-block"><div class="qmi-popup-price-label">From</div><div class="qmi-popup-price">${priceAmount}</div></div>` : ""}
                </div>
            </a>
        `
    }

    const fmtPrice = (n: number) => "$" + n.toLocaleString()

    const renderFiltersTop = () => (
        <>
            {uniqueTowns.length > 0 && (
                <div className="qmi-dropdown">
                    <select
                        className="qmi-select-pill"
                        value={filters.towns.length === 1 ? filters.towns[0] : ""}
                        onChange={(e) => {
                            const val = e.target.value
                            setFilters((prev) => ({
                                ...prev,
                                towns: val ? [val] : [],
                            }))
                        }}
                    >
                        <option value="">City</option>
                        {uniqueTowns.map((t) => (
                            <option key={t} value={t}>
                                {t}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            <div className="qmi-dropdown">
                <select
                    className="qmi-select-pill"
                    value={filters.priceRange}
                    onChange={(e) =>
                        setFilters((prev) => ({
                            ...prev,
                            priceRange: e.target.value,
                        }))
                    }
                >
                    <option value="">Price Range</option>
                    <option value="0-200000">Under $200K</option>
                    <option value="200000-250000">$200K - $250K</option>
                    <option value="250000-300000">$250K - $300K</option>
                    <option value="300000-350000">$300K - $350K</option>
                    <option value="350000-400000">$350K - $400K</option>
                    <option value="400000-500000">$400K - $500K</option>
                    <option value="500000-0">Over $500K</option>
                </select>
            </div>
            <label className="qmi-checkbox-filter">
                <input
                    type="checkbox"
                    checked={filters.masterPlanned}
                    onChange={(e) =>
                        setFilters((prev) => ({
                            ...prev,
                            masterPlanned: e.target.checked,
                        }))
                    }
                />
                Master Planned Community
            </label>
        </>
    )

    const renderFiltersBottom = () => (
        <>
            <div className="qmi-dropdown">
                <select
                    className="qmi-select-pill"
                    value={filters.bathrooms}
                    onChange={(e) =>
                        setFilters((prev) => ({
                            ...prev,
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
            <div className="qmi-dropdown">
                <select
                    className="qmi-select-pill"
                    value={filters.bedrooms}
                    onChange={(e) =>
                        setFilters((prev) => ({
                            ...prev,
                            bedrooms: e.target.value,
                        }))
                    }
                >
                    <option value="">Bedrooms</option>
                    <option value="2">2+</option>
                    <option value="3">3+</option>
                    <option value="4">4+</option>
                    <option value="5">5+</option>
                </select>
            </div>
            <div className="qmi-dropdown">
                <select
                    className="qmi-select-pill"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                >
                    <option value="name-asc">Sort: Name (A-Z)</option>
                    <option value="name-desc">Sort: Name (Z-A)</option>
                    <option value="price-asc">Sort: Price (Low)</option>
                    <option value="price-desc">Sort: Price (High)</option>
                </select>
            </div>
        </>
    )

    return (
        <div className="qmi-wrap">
            <div className="qmi-filter-area">
                <div className="qmi-filter-top">
                    <nav className="qmi-tabs" aria-label="Find a home">
                        <a
                            href={communitiesUrl}
                            className="qmi-tab active"
                        >
                            Communities
                        </a>
                        <a
                            href={quickMoveInsUrl}
                            className="qmi-tab"
                        >
                            Quick Move-Ins
                        </a>
                        <a
                            href={floorPlansUrl}
                            className="qmi-tab"
                        >
                            Floor Plans
                        </a>
                    </nav>

                    <div className="qmi-primary-filters">
                        {renderFiltersTop()}
                        <button
                            className="qmi-filter-toggle-block"
                            onClick={() => setShowFilters(!showFilters)}
                            aria-expanded={showFilters}
                        >
                            <span>{showFilters ? "Hide" : "Show"}</span>
                            <span>Filters</span>
                            <span className="qmi-filter-chev">
                                {showFilters ? "^" : "v"}
                            </span>
                        </button>
                    </div>
                </div>

                {showFilters && (
                    <div className="qmi-filter-bottom">
                        {renderFiltersBottom()}
                        <a
                            className="qmi-download"
                            href={filteredPdfHref}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <span
                                className="qmi-download-icon"
                                aria-hidden="true"
                            />
                            Download Community List
                        </a>
                    </div>
                )}
            </div>

            <div className="qmi-title-row">
                <div className="qmi-title-col">
                    <h1>Communities</h1>
                </div>
                <div className="qmi-visit-col">
                    <div className="qmi-visit-box">
                        <span>Schedule Your Exploratory Visit</span>
                        <a href={ctaUrl}>Request Your Time</a>
                    </div>
                </div>
            </div>

            <div className="qmi-mobile-view-toggle">
                <button
                    className={`qmi-view-btn ${mobileView === "list" ? "is-active" : ""}`}
                    onClick={() => setMobileView("list")}
                >
                    List
                </button>
                <button
                    className={`qmi-view-btn ${mobileView === "map" ? "is-active" : ""}`}
                    onClick={() => setMobileView("map")}
                >
                    Map
                </button>
            </div>

            <div className="qmi-mobile-filter-toggle-wrap">
                <button
                    className="qmi-filter-toggle"
                    onClick={() => setShowFilters(!showFilters)}
                >
                    {showFilters ? "Hide Filters" : "Show Filters"}
                </button>
            </div>

            {showFilters && (
                <div className="qmi-mobile-filters">
                    <div className="qmi-mobile-filters-inner">
                        {renderFiltersTop()}
                        {renderFiltersBottom()}
                    </div>
                </div>
            )}

            <div
                className={`qmi-split-view ${mobileView === "map" ? "qmi-mobile-map-active" : ""}`}
            >
                <div className="qmi-list-panel" ref={listRef}>
                    <div className="qmi-list-count">
                        {!loading && showResultCount && (
                            <span>
                                Showing {filtered.length} communit
                                {filtered.length !== 1 ? "ies" : "y"}
                            </span>
                        )}
                    </div>
                    <div className="qmi-list-content">
                        {loading && (
                            <div className="qmi-loading">
                                Loading communities...
                            </div>
                        )}
                        {!loading && filtered.length === 0 && (
                            <div className="qmi-empty">
                                No communities found matching your criteria.
                            </div>
                        )}
                        {!loading && (
                            <div className="qmi-card-grid">
                                {filtered.map((c) => (
                                    <div
                                        key={c.id}
                                        id={`qmi-card-${c.id}`}
                                        className={`qmi-card ${hoveredCardId === c.id ? "is-hovered" : ""}`}
                                        onMouseEnter={() =>
                                            setHoveredCardId(c.id)
                                        }
                                        onMouseLeave={() =>
                                            setHoveredCardId(null)
                                        }
                                        role="link"
                                        tabIndex={0}
                                        onClick={() => {
                                            if (c.url && c.url !== "#")
                                                window.location.href = c.url
                                        }}
                                        onKeyDown={(e) => {
                                            if (
                                                (e.key === "Enter" ||
                                                    e.key === " ") &&
                                                c.url &&
                                                c.url !== "#"
                                            ) {
                                                e.preventDefault()
                                                window.location.href = c.url
                                            }
                                        }}
                                    >
                                        <div className="qmi-card-image">
                                            <img
                                                src={
                                                    c.image ||
                                                    "https://via.placeholder.com/400x300?text=Community"
                                                }
                                                alt={c.name}
                                                loading="lazy"
                                            />
                                            {c.comingSoon ? (
                                                <div
                                                    className="qmi-card-banner qmi-card-banner--soon"
                                                    style={cardFontStyle(
                                                        bannerFont
                                                    )}
                                                >
                                                    Coming Soon
                                                </div>
                                            ) : c.promoBadgeText ? (
                                                <div
                                                    className="qmi-card-banner qmi-card-banner--promo"
                                                    style={cardFontStyle(
                                                        bannerFont
                                                    )}
                                                >
                                                    {c.promoBadgeText}
                                                </div>
                                            ) : null}
                                            {c.masterPlanned && (
                                                <div
                                                    className="qmi-card-mpc"
                                                    title="Master Planned Community"
                                                    aria-label="Master Planned Community"
                                                >
                                                    <svg
                                                        viewBox={
                                                            MPC_ICON_VIEWBOX
                                                        }
                                                        aria-hidden="true"
                                                    >
                                                        <path
                                                            d={MPC_ICON_PATH}
                                                            fill="#fff"
                                                        />
                                                    </svg>
                                                </div>
                                            )}
                                            <a
                                                href={c.url || "#"}
                                                className="qmi-hover-overlay"
                                            >
                                                <div className="qmi-hover-btn">
                                                    View Community
                                                </div>
                                            </a>
                                        </div>

                                        <div className="qmi-card-body">
                                            <div className="qmi-card-head">
                                                <a
                                                    href={c.url || "#"}
                                                    className="qmi-card-address"
                                                    style={cardFontStyle(
                                                        titleFont
                                                    )}
                                                >
                                                    {c.name}
                                                </a>
                                                <div
                                                    className="qmi-card-location"
                                                    style={cardFontStyle(
                                                        locationFont
                                                    )}
                                                >
                                                    {c.town}
                                                    {c.town && c.state
                                                        ? ", "
                                                        : ""}
                                                    {c.state}
                                                </div>
                                                {c.masterPlanned && (
                                                    <div className="qmi-card-mpc-label">
                                                        Master Planned Community
                                                    </div>
                                                )}
                                            </div>

                                            <div className="qmi-card-mid">
                                                <div className="qmi-specs">
                                                    {c.bedRange && (
                                                        <div
                                                            className="qmi-spec-item"
                                                            style={cardFontStyle(
                                                                specFont
                                                            )}
                                                        >
                                                            <img
                                                                className="qmi-spec-icon"
                                                                src={STAT_ICONS.bed}
                                                                alt=""
                                                            />
                                                            {c.bedRange} Bed
                                                        </div>
                                                    )}
                                                    {c.bathRange && (
                                                        <div
                                                            className="qmi-spec-item"
                                                            style={cardFontStyle(
                                                                specFont
                                                            )}
                                                        >
                                                            <img
                                                                className="qmi-spec-icon"
                                                                src={STAT_ICONS.bath}
                                                                alt=""
                                                            />
                                                            {c.bathRange} Bath
                                                        </div>
                                                    )}
                                                    {c.sqftRange && (
                                                        <div
                                                            className="qmi-spec-item"
                                                            style={cardFontStyle(
                                                                specFont
                                                            )}
                                                        >
                                                            <img
                                                                className="qmi-spec-icon"
                                                                src={STAT_ICONS.sqft}
                                                                alt=""
                                                            />
                                                            {c.sqftRange} Sq. Ft.
                                                        </div>
                                                    )}
                                                </div>

                                                {c.priceFrom > 0 && (
                                                    <div className="qmi-price-block">
                                                        <div
                                                            className="qmi-price-label"
                                                            style={cardFontStyle(
                                                                priceLabelFont
                                                            )}
                                                        >
                                                            Homes From
                                                        </div>
                                                        <div
                                                            className="qmi-price-amount"
                                                            style={cardFontStyle(
                                                                priceFont
                                                            )}
                                                        >
                                                            {fmtPrice(
                                                                c.priceFrom
                                                            )}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>

                                            {c.promoBannerText && (
                                                <div className="qmi-card-incentive">
                                                    <div
                                                        className="qmi-incentive-text"
                                                        style={cardFontStyle(
                                                            incentiveFont
                                                        )}
                                                    >
                                                        {c.promoBannerText}
                                                    </div>
                                                    {c.promoCtaLink && (
                                                        <a
                                                            className="qmi-incentive-btn"
                                                            href={
                                                                c.promoCtaLink
                                                            }
                                                            style={cardFontStyle(
                                                                buttonFont
                                                            )}
                                                            onClick={(e) =>
                                                                e.stopPropagation()
                                                            }
                                                        >
                                                            {c.promoCtaLabel ||
                                                                "Learn More"}
                                                        </a>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                <div className="qmi-map-panel">
                    <div className="qmi-map-container">
                        {!shouldRenderMap ? (
                            <div className="qmi-map-placeholder">
                                Map preview
                            </div>
                        ) : !mapLoaded ? (
                            <div className="qmi-loading">Loading map...</div>
                        ) : (
                            <div ref={mapEl} className="qmi-map" />
                        )}
                        <a href={ctaUrl} className="qmi-map-questions-btn">
                            Questions?
                        </a>
                    </div>
                </div>
            </div>

            <div className="qmi-mobile-bottom-bar">
                <a href="tel:+1" className="qmi-bottom-action">
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
                    </svg>
                    Call
                </a>
                <a href="sms:+1" className="qmi-bottom-action">
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    Text
                </a>
                <a href={ctaUrl} className="qmi-bottom-action">
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                        <polyline points="22,6 12,13 2,6" />
                    </svg>
                    Message
                </a>
            </div>

            <style>{`
                :root {
                    --qmi-dark-green: ${primaryColor};
                    --qmi-green: #407e52;
                    --qmi-green-light: ${mapPanelBg};
                    --qmi-green-cta: #dfefe4;
                    --qmi-tan: ${accentTan};
                    --qmi-text: ${textDark};
                    --qmi-text-light: #636464;
                    --qmi-black: #000;
                    --qmi-white: #fff;
                    --qmi-border: #dee2e6;
                    --qmi-gray-banner: #3c3c3c;
                    --qmi-bg: #f2f0ec;
                    --qmi-font-bodoni: 'Bodoni', 'Arapey', Georgia, serif;
                    --qmi-font-overpass: 'Overpass', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    --qmi-popup-width: ${popupMinWidth}px;
                    --qmi-map-tile-filter: ${mapTileFilter};
                }

                .qmi-wrap {
                    width: 100%;
                    background: var(--qmi-bg);
                    font-family: var(--qmi-font-overpass);
                    font-weight: 400;
                    color: var(--qmi-text);
                    min-height: 100vh;
                    -webkit-font-smoothing: antialiased;
                }

                .qmi-wrap *, .qmi-wrap *::before, .qmi-wrap *::after {
                    box-sizing: border-box;
                }

                .qmi-filter-area {
                    background: var(--qmi-bg);
                }

                .qmi-filter-top {
                    display: grid;
                    grid-template-columns: 41.65% 58.35%;
                    min-height: 72px;
                    position: relative;
                    z-index: 3;
                    box-shadow: 0 0.25rem 0.5rem rgba(0, 0, 0, 0.1);
                }

                .qmi-tabs {
                    align-self: center;
                    display: inline-flex;
                    align-items: center;
                    height: 40px;
                    margin: 0;
                    padding-left: 20px;
                    width: fit-content;
                    min-width: 0;
                }

                .qmi-tab {
                    display: block;
                    min-width: 148px;
                    height: 40px;
                    padding: 0 25px;
                    color: var(--qmi-text);
                    background: var(--qmi-white);
                    border-right: 1px solid #d0d0d0;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 400;
                    font-size: clamp(11px, 0.7rem + 0.25vw, 14px);
                    line-height: 40px;
                    letter-spacing: 0.4px;
                    text-align: center;
                    text-decoration: none;
                    text-transform: uppercase;
                    white-space: nowrap;
                    transition: color 0.18s ease, background 0.18s ease;
                }

                .qmi-tab:first-child { border-radius: 800px 0 0 800px; }
                .qmi-tab:last-child  { border-right: 0; border-radius: 0 800px 800px 0; }

                .qmi-tab.active,
                .qmi-tab:hover {
                    color: #fff;
                    background: var(--qmi-dark-green);
                }

                .qmi-primary-filters {
                    display: grid;
                    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto 72px;
                    align-items: center;
                    gap: 12px;
                    padding: 16px 0 16px 12px;
                    min-width: 0;
                }

                .qmi-primary-filters > * { min-width: 0; }
                .qmi-dropdown { min-width: 0; }

                .qmi-filter-bottom {
                    display: flex;
                    flex-wrap: nowrap;
                    justify-content: flex-end;
                    align-items: center;
                    gap: 12px;
                    padding: 14px 22px;
                    position: relative;
                    z-index: 2;
                    box-shadow: 0 0.125rem 0.25rem rgba(0, 0, 0, 0.075);
                    min-width: 0;
                }

                .qmi-filter-bottom .qmi-dropdown {
                    flex: 0 0 220px;
                    min-width: 0;
                }

                .qmi-filter-toggle-block {
                    align-self: stretch;
                    width: 72px;
                    min-height: 72px;
                    border: 0;
                    color: #fff;
                    background: var(--qmi-green);
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    font-size: 10px;
                    line-height: 13px;
                    letter-spacing: 0.4px;
                    text-transform: uppercase;
                    cursor: pointer;
                }

                .qmi-filter-toggle-block span { display: block; }

                .qmi-filter-chev {
                    margin-top: 6px;
                    font-family: Arial, sans-serif;
                    font-size: 15px;
                    line-height: 12px;
                }

                .qmi-checkbox-filter {
                    display: inline-flex;
                    align-items: center;
                    gap: 10px;
                    height: 40px;
                    padding: 0 8px;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: clamp(12px, 0.75rem + 0.15vw, 14px);
                    color: var(--qmi-text);
                    cursor: pointer;
                    white-space: nowrap;
                    line-height: 1;
                }

                .qmi-checkbox-filter input {
                    -webkit-appearance: none;
                    appearance: none;
                    width: 15px;
                    height: 15px;
                    margin: 0;
                    flex-shrink: 0;
                    border: 1.5px solid #407e52;
                    border-radius: 0.25em;
                    background-color: #fff;
                    cursor: pointer;
                }

                .qmi-checkbox-filter input:checked {
                    background-color: #295135;
                    border-color: #295135;
                    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath fill='none' stroke='%23fff' stroke-linecap='round' stroke-linejoin='round' stroke-width='3' d='m6 10 3 3 6-6'/%3E%3C/svg%3E");
                    background-position: center;
                    background-repeat: no-repeat;
                    background-size: 12px;
                }

                .qmi-select-pill {
                    appearance: none;
                    -webkit-appearance: none;
                    background-color: var(--qmi-white);
                    background-image: url("https://static.esperanzahomes.com/esperanza_homes/images/green-down-arrow.svg");
                    background-position: right 15px center;
                    background-repeat: no-repeat;
                    background-size: 16px;
                    border: 1px solid var(--qmi-border);
                    border-radius: 50rem;
                    color: var(--qmi-text);
                    cursor: pointer;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: clamp(12px, 0.75rem + 0.15vw, 14px);
                    height: 40px;
                    line-height: 1.95rem;
                    padding: 0.375rem 2.5rem 0.375rem 1rem;
                    min-width: 100px;
                    width: 100%;
                }

                .qmi-select-pill:focus {
                    outline: 2px solid var(--qmi-green);
                    outline-offset: 1px;
                }

                .qmi-download {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 9px;
                    height: 39px;
                    padding: 0 24px;
                    color: #fff;
                    background: var(--qmi-dark-green);
                    border-radius: 800px;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: clamp(11px, 0.7rem + 0.2vw, 14px);
                    line-height: 39px;
                    letter-spacing: 0.4px;
                    text-decoration: none;
                    text-transform: uppercase;
                    white-space: nowrap;
                }

                .qmi-download:hover { background: var(--qmi-green); color: #fff; }

                .qmi-download-icon {
                    position: relative;
                    width: 12px;
                    height: 15px;
                    line-height: 1;
                }

                .qmi-download-icon::before {
                    position: absolute;
                    inset: 0;
                    content: "\\2193";
                    font-size: 16px;
                    line-height: 15px;
                    text-align: center;
                }

                .qmi-title-row {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    align-items: center;
                    min-height: 75px;
                    padding: 12px 20px;
                    background: var(--qmi-bg);
                    position: relative;
                    z-index: 1;
                    box-shadow: 0 0.25rem 0.5rem rgba(0, 0, 0, 0.1);
                    border-bottom: 1px solid var(--qmi-border);
                }

                .qmi-title-col {
                    min-width: 0;
                }

                .qmi-title-col h1 {
                    margin: 0;
                    color: #3c3c3c;
                    font-family: 'Overpass', var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: clamp(1.5rem, 1.1rem + 1.1vw, 2rem);
                    line-height: 1.2;
                    letter-spacing: 0.2px;
                }

                .qmi-visit-col {
                    min-width: 0;
                    justify-self: end;
                }

                .qmi-visit-box {
                    display: flex;
                    align-items: center;
                    gap: 14px;
                    min-height: 56px;
                    padding: 8px 8px 8px 22px;
                    background: var(--qmi-green-cta);
                    color: var(--qmi-text);
                    border: 2px solid #fff;
                }

                .qmi-visit-box span {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: clamp(11px, 0.65rem + 0.25vw, 13px);
                    line-height: 1.3;
                    letter-spacing: 0.5px;
                    text-transform: uppercase;
                    white-space: nowrap;
                }

                .qmi-visit-box a {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    min-height: 39px;
                    padding: 0 22px;
                    color: #fff;
                    background: var(--qmi-dark-green);
                    border-radius: 800px;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 400;
                    font-size: clamp(11px, 0.65rem + 0.25vw, 13px);
                    line-height: 1;
                    letter-spacing: 0.5px;
                    text-decoration: none;
                    text-transform: uppercase;
                    white-space: nowrap;
                    flex-shrink: 0;
                }

                .qmi-visit-box a:hover { background: var(--qmi-green); }

                .qmi-mobile-view-toggle { display: none; }
                .qmi-mobile-filter-toggle-wrap { display: none; }

                .qmi-filter-toggle {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 100%;
                    padding: 14px 16px;
                    background-color: var(--qmi-green);
                    color: var(--qmi-white);
                    border: none;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    font-size: 13px;
                    letter-spacing: 0.5px;
                    text-transform: uppercase;
                    cursor: pointer;
                    transition: background-color 0.3s;
                }

                .qmi-filter-toggle:hover {
                    background-color: var(--qmi-dark-green);
                }

                .qmi-mobile-filters { display: none; }

                .qmi-mobile-filters-inner {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 10px;
                    padding: 12px 20px;
                    background: var(--qmi-white);
                    border-bottom: 1px solid var(--qmi-border);
                }

                .qmi-split-view {
                    display: grid;
                    grid-template-columns: 58.333% 41.667%;
                    height: calc(100vh - 234px);
                }

                .qmi-list-panel {
                    background: var(--qmi-white);
                    overflow-y: auto;
                    max-height: calc(100vh - 234px);
                }

                .qmi-list-count {
                    padding: 10px 20px 4px;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 400;
                    font-size: 13px;
                    color: var(--qmi-text-light);
                }

                .qmi-list-content { padding: 0; }

                .qmi-card-grid {
                    display: flex;
                    flex-direction: column;
                }

                .qmi-card {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    border: 0;
                    border-radius: 0;
                    border-bottom: 1px solid var(--qmi-border);
                    background: var(--qmi-white);
                    transition: background-color 0.3s ease;
                    color: inherit;
                    cursor: pointer;
                    /* Container for the card body so its type scales 1:1 with
                       the card width (matches the Esperanza reference ratios at
                       any rendered size). */
                    container-type: inline-size;
                }

                .qmi-card:hover, .qmi-card.is-hovered {
                    background-color: rgba(60, 60, 60, 0.04);
                }

                .qmi-card-image {
                    position: relative;
                    overflow: hidden;
                    /* Reference card proportion: the half-width image cell is
                       851 x 676 (≈5:4), which sets the card height the
                       bottom-pinned incentive depends on. */
                    aspect-ratio: 4 / 3;
                }

                .qmi-card-image img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }

                .qmi-card-banner {
                    position: absolute;
                    top: 10px;
                    left: 0;
                    z-index: 2;
                    max-width: calc(100% - 24px);
                    padding: 4px 10px 1px;
                    color: #fff;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    font-size: clamp(9px, 0.9cqw, 12px);
                    line-height: 1.2;
                    letter-spacing: 0.6px;
                    text-transform: uppercase;
                    pointer-events: none;
                }

                .qmi-card-banner--soon {
                    background: rgba(60, 60, 60, 0.92);
                }

                .qmi-card-banner--promo {
                    background: var(--qmi-green);
                }

                /* Master-Planned Community badge — same green-circle 3-house
                   glyph used for MPC pins on the map, pinned to the card's
                   top-right corner. */
                .qmi-card-mpc {
                    position: absolute;
                    top: 12px;
                    right: 12px;
                    z-index: 2;
                    width: 46px;
                    height: 46px;
                    border-radius: 50%;
                    background: var(--qmi-dark-green);
                    outline: 2px solid #fff;
                    outline-offset: -2px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    pointer-events: none;
                    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
                }

                .qmi-card-mpc svg {
                    width: 58%;
                    height: 58%;
                    display: block;
                }

                .qmi-hover-overlay {
                    position: absolute;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    opacity: 0;
                    transition: opacity 0.4s ease;
                    z-index: 1;
                    text-decoration: none;
                }

                .qmi-card:hover .qmi-hover-overlay { opacity: 1; }

                .qmi-hover-btn {
                    background-color: var(--qmi-white);
                    color: var(--qmi-text);
                    border-radius: 50rem;
                    padding: 12px 28px;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    font-size: 13px;
                    letter-spacing: 0.5px;
                    text-transform: uppercase;
                    text-align: center;
                }

                /* Card body — 1:1 with the Esperanza reference: title/location
                   at top, an icon spec-list (left) beside a right-aligned
                   "Homes From" price block in the middle, and the promo
                   incentive pinned to the bottom. Type is sized for the
                   half-width desktop card. */
                .qmi-card-body {
                    font-size: clamp(12px, 1.293cqw, 22px);
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                }

                .qmi-card-head { min-width: 0; }

                .qmi-card-address {
                    display: block;
                    font-family: var(--qmi-font-bodoni);
                    color: var(--qmi-text);
                    font-size: 2.41em;
                    line-height: 1.02;
                    text-decoration: none;
                    transition: color 0.2s;
                }

                .qmi-card-address:hover { color: var(--qmi-green); }

                .qmi-card-location {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    color: var(--qmi-tan);
                    font-size: 0.91em;
                    letter-spacing: 0.3px;
                    margin-top: 0.64em;
                }

                .qmi-card-mpc-label {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    color: var(--qmi-green);
                    font-size: 0.73em;
                    text-transform: uppercase;
                    letter-spacing: 0.3px;
                    margin-top: 0.36em;
                }

                .qmi-card-mid {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-end;
                    gap: 0;
                    margin-top: auto;
                }

                .qmi-specs {
                    display: flex;
                    flex-direction: column;
                    flex: 0 0 58%;
                    gap: 0;
                }

                .qmi-spec-item {
                    display: flex;
                    align-items: center;
                    gap: 0.82em;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 400;
                    font-size: 1em;
                    color: #000;
                    line-height: 1;
                    letter-spacing: 0.4px;
                    text-transform: uppercase;
                    padding: 0.5em 0;
                }

                .qmi-spec-icon {
                    width: 1.15em;
                    height: 1.15em;
                    flex-shrink: 0;
                }

                .qmi-price-block {
                    text-align: right;
                    flex: 0 0 auto;
                    flex-shrink: 0;
                    padding: 0.5em 0;
                }

                .qmi-price-label {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 400;
                    font-size: 0.77em;
                    color: #3c3c3c;
                    letter-spacing: 1px;
                    text-transform: uppercase;
                    line-height: 1;
                }

                .qmi-price-amount {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    font-size: 2.045em;
                    color: #295135;
                    line-height: 1.1;
                    margin-top: 0.18em;
                }

                .qmi-card-links {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                    margin-bottom: 10px;
                }

                .qmi-card-meta {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 400;
                    font-size: 12px;
                    color: var(--qmi-text-light);
                    line-height: 1.2;
                }

                .qmi-reserve-btn {
                    display: inline-block;
                    align-self: flex-start;
                    margin-top: auto;
                    padding: 10px 28px 8px;
                    background-color: var(--qmi-dark-green);
                    color: var(--qmi-white);
                    border-radius: 50rem;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    font-size: 12px;
                    letter-spacing: 0.5px;
                    text-transform: uppercase;
                    text-align: center;
                    text-decoration: none;
                    cursor: pointer;
                    transition: background-color 0.3s;
                }

                .qmi-reserve-btn:hover {
                    background-color: var(--qmi-green);
                    color: var(--qmi-white);
                }

                /* In-body incentive block: Banner Text + CTA "Learn More". Only
                   rendered when the community's promo has Banner Text. */
                .qmi-card-incentive {
                    margin-top: 0;
                    padding-top: 0;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.25rem;
                    text-align: center;
                    width: 100%;
                }

                .qmi-incentive-text {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    font-size: 0.955em;
                    letter-spacing: 0.4px;
                    line-height: 1.3;
                    text-transform: uppercase;
                    color: #407e52;
                    padding: 0.5em 0.5em 0;
                    margin-bottom: 0;
                }

                .qmi-incentive-btn {
                    display: inline-block;
                    min-width: 8em;
                    padding: 0.7em 1.8em 0.55em;
                    background-color: var(--qmi-dark-green);
                    color: var(--qmi-white);
                    border-radius: 50rem;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: 0.8em;
                    letter-spacing: 0.3px;
                    text-transform: none;
                    text-decoration: none;
                    cursor: pointer;
                    transition: background-color 0.3s;
                }

                .qmi-incentive-btn:hover {
                    background-color: var(--qmi-green);
                    color: var(--qmi-white);
                }

                .qmi-map-panel {
                    display: flex;
                    flex-direction: column;
                    background: var(--qmi-green-light);
                    position: sticky;
                    top: 0;
                    height: calc(100vh - 234px);
                }

                .qmi-map-container {
                    flex: 1;
                    position: relative;
                }

                .qmi-map {
                    width: 100%;
                    height: 100%;
                }

                .qmi-map .leaflet-tile-pane {
                    filter: var(--qmi-map-tile-filter);
                }

                .qmi-map-placeholder {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: var(--qmi-green-light);
                    color: #999;
                    font: 400 14px var(--qmi-font-overpass);
                }

                .qmi-map-questions-btn {
                    position: absolute;
                    bottom: 20px;
                    right: 20px;
                    padding: 10px 24px 8px;
                    background-color: var(--qmi-dark-green);
                    color: var(--qmi-white);
                    border: none;
                    border-radius: 50rem;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    font-size: 13px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    text-decoration: none;
                    cursor: pointer;
                    z-index: 10;
                    transition: background-color 0.3s;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                }

                .qmi-map-questions-btn:hover {
                    background-color: var(--qmi-green);
                    color: var(--qmi-white);
                }

                .qmi-loading, .qmi-empty {
                    padding: 40px;
                    text-align: center;
                    color: var(--qmi-text-light);
                    font: 400 14px var(--qmi-font-overpass);
                }

                .qmi-mobile-bottom-bar { display: none; }

                .leaflet-popup-content-wrapper {
                    padding: 0 !important;
                    border-radius: 10px !important;
                    box-shadow: 0 3px 14px rgba(0, 0, 0, 0.18) !important;
                    overflow: hidden;
                }

                .leaflet-popup-content {
                    margin: 0 !important;
                    width: var(--qmi-popup-width) !important;
                }

                .leaflet-popup-tip {
                    background: var(--qmi-white) !important;
                }

                .qmi-leaflet-popup .leaflet-popup-close-button {
                    top: 6px !important;
                    right: 6px !important;
                    width: 24px !important;
                    height: 24px !important;
                    font: 300 22px/24px Arial, sans-serif !important;
                    color: #3c3c3c !important;
                    text-align: center;
                    z-index: 3;
                }

                .qmi-leaflet-popup .leaflet-popup-close-button:hover {
                    color: var(--qmi-green) !important;
                    background: transparent !important;
                }

                .qmi-pin-wrap { background: transparent !important; border: none !important; }

                .qmi-pin-teardrop {
                    display: block;
                    pointer-events: none;
                }

                .qmi-pin {
                    width: 34px;
                    height: 34px;
                    border-radius: 50%;
                    background: var(--qmi-dark-green);
                    outline: 2px solid #fff;
                    outline-offset: -2px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    transform: translateZ(0);
                }

                .qmi-pin-mpc {
                    width: 34px;
                    height: 34px;
                }
                .qmi-pin-house {
                    width: 60%;
                    height: 60%;
                    pointer-events: none;
                    display: block;
                }

                .qmi-cluster-wrap { background: transparent !important; border: none !important; }
                .qmi-cluster-icon {
                    border-radius: 50%;
                    color: #fff;
                    font: 700 13px var(--qmi-font-overpass);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .qmi-popup {
                    display: block;
                    width: var(--qmi-popup-width);
                    background: var(--qmi-white);
                    text-decoration: none;
                    color: inherit;
                    cursor: pointer;
                }
                .qmi-popup:hover .qmi-popup-title { color: var(--qmi-green); }

                .qmi-popup-imgwrap {
                    position: relative;
                    aspect-ratio: 2 / 1;
                    overflow: hidden;
                }

                .qmi-popup-img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }

                .qmi-popup-badge {
                    position: absolute;
                    top: 0;
                    left: 0;
                    max-width: calc(100% - 16px);
                    padding: 6px 12px;
                    color: #fff;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    font-size: 11px;
                    line-height: 1.2;
                    letter-spacing: 0.5px;
                    text-transform: uppercase;
                }

                .qmi-popup-badge--soon {
                    background: rgba(60, 60, 60, 0.92);
                }

                .qmi-popup-badge--promo {
                    background: var(--qmi-green);
                }

                .qmi-popup-body {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 12px;
                    padding: 8px 10px 10px;
                }

                .qmi-popup-info {
                    flex: 1;
                    min-width: 0;
                }

                .qmi-popup-title {
                    font-family: var(--qmi-font-bodoni);
                    font-size: 1.125rem;
                    color: var(--qmi-text);
                    line-height: 1.25;
                    margin-bottom: 0.15rem;
                }

                .qmi-popup-location {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    color: var(--qmi-tan);
                    font-size: 0.875rem;
                    line-height: 1.2;
                }

                .qmi-popup-price-block {
                    flex-shrink: 0;
                    text-align: right;
                }

                .qmi-popup-price-label {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 400;
                    font-size: 0.75rem;
                    color: #3c3c3c;
                    text-transform: uppercase;
                    line-height: 1;
                    letter-spacing: 0.4px;
                }

                .qmi-popup-price {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    font-size: 1.125rem;
                    color: var(--qmi-dark-green);
                    line-height: 1.1;
                    margin-top: 0.25rem;
                }

                .qmi-popup-community {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 400;
                    font-size: 12px;
                    color: var(--qmi-text-light);
                }

                .leaflet-control-zoom {
                    box-shadow: 0 2px 8px rgba(0,0,0,0.08) !important;
                    border-radius: 4px !important;
                    border: 1px solid var(--qmi-border) !important;
                    overflow: hidden;
                }

                .leaflet-control-zoom a {
                    width: 36px !important;
                    height: 36px !important;
                    line-height: 36px !important;
                    color: var(--qmi-text) !important;
                }

                .leaflet-container {
                    font-family: var(--qmi-font-overpass) !important;
                }

                @media (min-width: 1400px) {
                    .qmi-split-view {
                        grid-template-columns: 1fr 1fr;
                    }
                }

                @media (max-width: 1199px) {
                    .qmi-filter-top {
                        grid-template-columns: 45% 55%;
                    }

                    .qmi-tab {
                        min-width: 0;
                        padding: 0 16px;
                        font-size: 12px;
                    }

                    .qmi-primary-filters {
                        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto 64px;
                        gap: 10px;
                    }

                    .qmi-filter-toggle-block {
                        width: 64px;
                        min-height: 64px;
                    }

                    .qmi-filter-bottom {
                        gap: 10px;
                        padding: 12px 16px;
                    }

                    .qmi-filter-bottom .qmi-dropdown {
                        flex: 0 0 180px;
                    }

                    .qmi-download {
                        padding: 0 18px;
                        font-size: 12px;
                    }

                    .qmi-visit-box {
                        gap: 10px;
                        padding: 8px 8px 8px 16px;
                    }

                    .qmi-visit-box span { font-size: clamp(11px, 0.65rem + 0.15vw, 12px); }

                    .qmi-title-col h1 { font-size: clamp(1.5rem, 1rem + 1.5vw, 2rem); }
                }

                @media (max-width: 991px) {
                    .qmi-filter-top { grid-template-columns: 1fr; }

                    .qmi-tabs {
                        justify-content: flex-start;
                        margin: 12px 16px 4px;
                    }

                    .qmi-primary-filters {
                        grid-template-columns: 1fr 1fr 56px;
                        padding: 0 16px 12px;
                        gap: 10px;
                        align-items: center;
                    }

                    .qmi-primary-filters .qmi-checkbox-filter {
                        grid-column: 1 / -1;
                    }

                    .qmi-filter-toggle-block {
                        width: 56px;
                        min-height: 56px;
                        grid-row: 1;
                        grid-column: 3;
                    }

                    .qmi-filter-bottom {
                        flex-wrap: wrap;
                        justify-content: stretch;
                        padding: 12px 16px;
                        gap: 10px;
                    }

                    .qmi-filter-bottom .qmi-dropdown {
                        flex: 1 1 calc(50% - 5px);
                    }

                    .qmi-download {
                        flex: 1 1 100%;
                        justify-self: stretch;
                        text-align: center;
                    }

                    .qmi-title-row {
                        grid-template-columns: 1fr;
                        align-items: stretch;
                        gap: 12px;
                        padding: 14px 16px;
                    }

                    .qmi-visit-col { justify-self: stretch; }

                    .qmi-visit-box {
                        justify-content: space-between;
                        padding: 10px 8px 10px 18px;
                    }

                    .qmi-mobile-view-toggle {
                        display: flex;
                        gap: 0;
                        padding: 8px 16px 12px;
                    }

                    .qmi-view-btn {
                        flex: 1;
                        padding: 10px 16px;
                        border: 1px solid var(--qmi-border);
                        background: var(--qmi-white);
                        color: var(--qmi-text);
                        font-family: var(--qmi-font-overpass);
                        font-weight: 700;
                        font-size: 13px;
                        letter-spacing: 0.5px;
                        text-transform: uppercase;
                        cursor: pointer;
                        text-align: center;
                        transition: background-color 0.2s, color 0.2s;
                    }

                    .qmi-view-btn:first-child { border-radius: 50rem 0 0 50rem; }
                    .qmi-view-btn:last-child  { border-radius: 0 50rem 50rem 0; border-left: none; }

                    .qmi-view-btn.is-active {
                        background-color: var(--qmi-green);
                        border-color: var(--qmi-green);
                        color: var(--qmi-white);
                    }

                    /* Mobile = natural document flow. The desktop layout is a
                       100vh app shell (sticky map + internally-scrolling list);
                       on mobile we must release every viewport-lock so the list
                       grows with its content and the PAGE scrolls. Leaving the
                       wrap's min-height:100vh or the list panel's overflow:auto
                       in place makes the component report a viewport-locked
                       height, which is what clips the list after a few cards in
                       Framer regardless of "Fit"/"100vh" frame sizing. */
                    .qmi-wrap { min-height: 0; }

                    .qmi-split-view {
                        grid-template-columns: 1fr;
                        height: auto;
                        overflow: visible;
                    }

                    .qmi-list-panel {
                        max-height: none;
                        overflow: visible;
                    }

                    .qmi-map-panel {
                        display: none;
                        position: relative;
                        height: 60vh;
                    }

                    .qmi-split-view.qmi-mobile-map-active .qmi-list-panel { display: none; }
                    .qmi-split-view.qmi-mobile-map-active .qmi-map-panel  { display: flex; }

                    .qmi-card-grid {
                        display: grid;
                        grid-template-columns: 1fr 1fr;
                        gap: 16px;
                        padding: 16px;
                    }

                    .qmi-card {
                        grid-template-columns: 1fr;
                        border-bottom: none;
                        margin-bottom: 0;
                    }

                    .qmi-card-image { aspect-ratio: 16 / 10; }

                    .qmi-card-body {
                        font-size: clamp(13px, 2.4cqw, 18px);
                        padding: 14px 6px 14px 6px;
                    }

                    .qmi-reserve-btn {
                        align-self: stretch;
                        width: 100%;
                        text-align: center;
                    }
                }

                @media (max-width: 767px) {
                    .qmi-tabs {
                        width: 100%;
                        overflow-x: auto;
                        -webkit-overflow-scrolling: touch;
                        scrollbar-width: none;
                        padding: 12px 12px 4px;
                    }

                    .qmi-tabs::-webkit-scrollbar { display: none; }

                    .qmi-tab {
                        flex-shrink: 0;
                        min-width: 110px;
                        height: 36px;
                        line-height: 36px;
                        font-size: 11px;
                        padding: 0 14px;
                    }

                    .qmi-primary-filters,
                    .qmi-filter-bottom { display: none; }

                    .qmi-mobile-filter-toggle-wrap {
                        display: block;
                        padding: 0 16px 8px;
                    }

                    .qmi-mobile-filters { display: block; }

                    .qmi-mobile-filters-inner {
                        display: grid;
                        grid-template-columns: 1fr 1fr;
                        gap: 10px;
                    }

                    .qmi-title-row {
                        grid-template-columns: 1fr;
                        gap: 10px;
                        padding: 12px 16px;
                    }

                    .qmi-title-col h1 {
                        font-size: clamp(1.35rem, 1rem + 2vw, 1.625rem);
                        line-height: 1.15;
                    }

                    .qmi-visit-col { justify-self: stretch; }

                    .qmi-visit-box {
                        flex-direction: column;
                        align-items: stretch;
                        gap: 10px;
                        padding: 14px;
                        text-align: center;
                    }

                    .qmi-visit-box span {
                        white-space: normal;
                        font-size: 12px;
                    }

                    .qmi-visit-box a {
                        align-self: center;
                        min-width: 200px;
                    }

                    .qmi-card-grid {
                        grid-template-columns: 1fr;
                        gap: 0;
                        padding: 0;
                    }

                    .qmi-card {
                        grid-template-columns: 1fr;
                        margin-bottom: 0;
                        border-bottom: 1px solid var(--qmi-border);
                    }

                    .qmi-card-image { aspect-ratio: 16 / 9; }

                    .qmi-card-body {
                        font-size: clamp(14px, 3.8cqw, 17px);
                        padding: 14px 16px 16px;
                    }

                    .qmi-reserve-btn {
                        align-self: stretch;
                        width: 100%;
                        text-align: center;
                        padding: 12px 20px 10px;
                        margin-top: 12px;
                        font-size: 13px;
                    }

                    .qmi-list-count { padding: 10px 16px 0; }

                    .qmi-mobile-bottom-bar {
                        display: flex;
                        position: fixed;
                        bottom: 0;
                        left: 0;
                        right: 0;
                        z-index: 100;
                        background-color: var(--qmi-dark-green);
                    }

                    .qmi-bottom-action {
                        flex: 1;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        gap: 4px;
                        padding: 10px 8px;
                        color: var(--qmi-white);
                        text-decoration: none;
                        font-family: var(--qmi-font-overpass);
                        font-weight: 700;
                        font-size: 11px;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                        border-right: 1px solid rgba(255,255,255,0.15);
                    }

                    .qmi-bottom-action:last-child { border-right: none; }
                    .qmi-bottom-action svg { stroke: var(--qmi-white); }

                    .qmi-wrap { padding-bottom: 60px; }
                }

                @media (prefers-reduced-motion: reduce) {
                    *, *::before, *::after {
                        animation-duration: 0.01ms !important;
                        animation-iteration-count: 1 !important;
                        transition-duration: 0.01ms !important;
                    }
                }

                @media print {
                    .qmi-map-panel, .qmi-filter-area, .qmi-title-row, .qmi-mobile-bottom-bar,
                    .qmi-mobile-view-toggle, .qmi-mobile-filter-toggle-wrap, .qmi-mobile-filters {
                        display: none !important;
                    }
                    .qmi-list-panel { max-height: none; }
                    .qmi-card { break-inside: avoid; }
                }
            `}</style>
        </div>
    )
}

addPropertyControls(Communities, {
    cacheWorkerUrl: {
        type: ControlType.String,
        title: "Cache Worker URL",
        defaultValue:
            "https://esperanza-communities-cache.round-base-ed8c.workers.dev",
        description:
            "Cloudflare Worker URL for cached Airtable Communities data",
    },
    mapCenterLat: {
        type: ControlType.Number,
        title: "Map · Center Lat",
        defaultValue: 26.19,
        min: 24,
        max: 30,
        step: 0.01,
        displayStepper: true,
    },
    mapCenterLng: {
        type: ControlType.Number,
        title: "Map · Center Lng",
        defaultValue: -98.23,
        min: -100,
        max: -96,
        step: 0.01,
        displayStepper: true,
    },
    defaultZoom: {
        type: ControlType.Number,
        title: "Map · Default Zoom",
        defaultValue: 8,
        min: 3,
        max: 16,
        step: 0.5,
        displayStepper: true,
    },
    mapMinZoom: {
        type: ControlType.Number,
        title: "Map · Min Zoom",
        defaultValue: 3,
        min: 1,
        max: 12,
        step: 1,
        displayStepper: true,
    },
    mapMaxZoom: {
        type: ControlType.Number,
        title: "Map · Max Zoom",
        defaultValue: 16,
        min: 8,
        max: 20,
        step: 1,
        displayStepper: true,
    },
    autoFitBounds: {
        type: ControlType.Boolean,
        title: "Map · Auto Fit Bounds",
        defaultValue: true,
        description:
            "When on, zooms to show all markers. When off, uses center + default zoom.",
    },
    fitBoundsMaxZoom: {
        type: ControlType.Number,
        title: "Map · Fit Max Zoom",
        defaultValue: 11,
        min: 5,
        max: 16,
        step: 1,
        displayStepper: true,
        hidden: (props) => !props.autoFitBounds,
    },
    fitBoundsPadding: {
        type: ControlType.Number,
        title: "Map · Fit Padding",
        defaultValue: 40,
        min: 0,
        max: 120,
        step: 4,
        displayStepper: true,
        unit: "px",
        hidden: (props) => !props.autoFitBounds,
    },
    scrollWheelZoom: {
        type: ControlType.Boolean,
        title: "Map · Scroll Zoom",
        defaultValue: true,
    },
    zoomControlPosition: {
        type: ControlType.Enum,
        title: "Map · Zoom Position",
        options: ["topleft", "topright", "bottomleft", "bottomright"],
        optionTitles: ["Top Left", "Top Right", "Bottom Left", "Bottom Right"],
        defaultValue: "topleft",
    },
    mapTilePreset: {
        type: ControlType.Enum,
        title: "Map · Tile Style",
        options: [
            "positron",
            "positron-nolabels",
            "voyager",
            "voyager-nolabels",
            "custom",
        ],
        optionTitles: [
            "Positron (light)",
            "Positron (no labels)",
            "Voyager (warm roads)",
            "Voyager (no labels)",
            "Custom URL",
        ],
        defaultValue: "positron",
        description:
            "OSM/CARTO raster tiles. Voyager has warmer road colors. Exact #C1B694 needs vector tiles.",
    },
    mapTileWarmth: {
        type: ControlType.Number,
        title: "Map · Tile Warmth",
        defaultValue: 0,
        min: 0,
        max: 100,
        step: 5,
        displayStepper: true,
        description:
            "Tints all tile colors warmer (roads, land, labels). Try 25–45 on Positron.",
    },
    tileUrl: {
        type: ControlType.String,
        title: "Map · Tile URL",
        defaultValue:
            "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        description: "Leaflet raster tile template. Used when Tile Style is Custom.",
        hidden: (props) => props.mapTilePreset !== "custom",
    },
    tileAttribution: {
        type: ControlType.String,
        title: "Map · Tile Attribution",
        defaultValue:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        hidden: (props) => props.mapTilePreset !== "custom",
    },
    mapPanelBg: {
        type: ControlType.Color,
        title: "Map · Panel Background",
        defaultValue: "#e9edea",
    },
    primaryColor: {
        type: ControlType.Color,
        title: "Map · Marker Color",
        defaultValue: "#295135",
    },
    strokeColor: {
        type: ControlType.Color,
        title: "Map · Cluster Border",
        defaultValue: "#0c4128",
    },
    maxClusterRadius: {
        type: ControlType.Number,
        title: "Map · Cluster Radius",
        defaultValue: 50,
        min: 20,
        max: 120,
        step: 5,
        displayStepper: true,
        unit: "px",
    },
    clusterSizeSmall: {
        type: ControlType.Number,
        title: "Map · Cluster Size (<10)",
        defaultValue: 36,
        min: 16,
        max: 64,
        step: 2,
        displayStepper: true,
        unit: "px",
    },
    clusterSizeMedium: {
        type: ControlType.Number,
        title: "Map · Cluster Size (<20)",
        defaultValue: 42,
        min: 16,
        max: 64,
        step: 2,
        displayStepper: true,
        unit: "px",
    },
    clusterSizeLarge: {
        type: ControlType.Number,
        title: "Map · Cluster Size (20+)",
        defaultValue: 48,
        min: 16,
        max: 64,
        step: 2,
        displayStepper: true,
        unit: "px",
    },
    pinWidth: {
        type: ControlType.Number,
        title: "Map · Pin Width",
        defaultValue: 20,
        min: 12,
        max: 40,
        step: 1,
        displayStepper: true,
        unit: "px",
    },
    pinHeight: {
        type: ControlType.Number,
        title: "Map · Pin Height",
        defaultValue: 32,
        min: 16,
        max: 56,
        step: 1,
        displayStepper: true,
        unit: "px",
    },
    mpcPinSize: {
        type: ControlType.Number,
        title: "Map · MPC Pin Size",
        defaultValue: 34,
        min: 20,
        max: 56,
        step: 1,
        displayStepper: true,
        unit: "px",
    },
    popupMinWidth: {
        type: ControlType.Number,
        title: "Map · Popup Width",
        defaultValue: 280,
        min: 200,
        max: 400,
        step: 10,
        displayStepper: true,
        unit: "px",
    },
    popupMaxWidth: {
        type: ControlType.Number,
        title: "Map · Popup Max Width",
        defaultValue: 320,
        min: 200,
        max: 480,
        step: 10,
        displayStepper: true,
        unit: "px",
    },
    popupOffsetY: {
        type: ControlType.Number,
        title: "Map · Popup Offset Y",
        defaultValue: -32,
        min: -80,
        max: 0,
        step: 2,
        displayStepper: true,
        unit: "px",
        description: "Negative lifts popup above pin tip.",
    },
    popupShowIncentiveBanner: {
        type: ControlType.Boolean,
        title: "Map · Popup Incentive",
        defaultValue: false,
        description: "Green promo banner on the map popup image.",
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
        defaultValue: "/floorplan-collections",
    },
    downloadPdfUrl: {
        type: ControlType.String,
        title: "Download PDF URL",
        defaultValue: "/new-homes/pdf",
        description: "Fallback static URL (used when Filtered PDF Base URL is empty)",
    },
    filteredPdfBaseUrl: {
        type: ControlType.String,
        title: "Filtered PDF Base URL",
        defaultValue: "",
        description: "PDF worker origin (e.g. https://esperanza-pdf.round-base-ed8c.workers.dev). When set, the download button builds a filtered URL from the active city filter.",
    },
    ctaUrl: {
        type: ControlType.String,
        title: "CTA URL",
        defaultValue: "#request-a-tour",
    },
    showResultCount: {
        type: ControlType.Boolean,
        title: "Show Result Count",
        defaultValue: false,
        description:
            "Internal: shows 'Showing N communities' above the list. Off in production.",
    },
    bannerFont: cardFontControl("Card · Banner (on image)"),
    titleFont: cardFontControl("Card · Title"),
    locationFont: cardFontControl("Card · City/State"),
    specFont: cardFontControl("Card · Bed/Bath/SqFt"),
    priceLabelFont: cardFontControl("Card · “Homes From”"),
    priceFont: cardFontControl("Card · Price"),
    incentiveFont: cardFontControl("Card · Incentive Text"),
    buttonFont: cardFontControl("Card · Button"),
})