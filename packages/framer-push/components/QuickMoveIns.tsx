// Quick Move-Ins - 1:1 Visual Match with Esperanza Homes
// Fonts: Bodoni (title/address), Overpass Semibold (price), Overpass Regular (details/specs/monthly)
// Layout: Split-view with list left, sticky map right
// Colors: #295135 dark green, #407e52 light green, #85754e tan, #3c3c3c text gray
// Data: Cached via Cloudflare Worker (worker-only)
// Map: Leaflet + Positron (CartoDB raster tiles) + Leaflet.markercluster

import React, { useEffect, useMemo, useRef, useState } from "react"
import { addPropertyControls, ControlType } from "framer"

const STAT_ICONS = {
    garage: "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/stats/garage.svg",
    stairs: "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/stats/stairs.svg",
    livingSqft: "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/stats/livingsqft.svg",
    bed: "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/stats/bedroom.svg",
    bath: "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/stats/bathroom.svg",
    sqft: "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/stats/sqft.svg",
}

const MAP_PIN_SVG =
    "https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/map_pin.svg"

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


// Framer-specific import for render target detection
declare const RenderTarget: {
    current: () => string
    thumbnail: string
    canvas: string
    preview: string
}

// ── Type Definitions ──

interface WorkerHomeRecord {
    id: string
    fields: {
        address?: string
        slug?: string
        "viewer slug"?: string
        City?: string
        postal_code?: string
        latitude?: number
        longitude?: number
        Community?: string
        "Floor Plan"?: string
        Collection?: string
        Price?: number
        estimated_monthly_price?: number
        bedroom_count?: number
        bathroom_count?: number
        half_bathroom_count?: number
        car_garage_count?: number
        stories_count?: number
        living_square_footage?: number
        total_square_footage?: number
        "Living Sq Ft"?: number[] | number
        "Total Sq Ft"?: number[] | number
        "Self Tour Available?"?: boolean
        // NterNow self-tour link. At Esperanza "self-touring available" === the home
        // has a NterNow lockbox link, so any of these (if the feed exposes them)
        // also flags the home as self-tourable.
        nter_now?: string
        NterNow?: string
        "Enter Now"?: string
        "Available Now"?: boolean
        available_now?: boolean
        availability_text?: string
        promo_text?: string
        card_badge_text?: string
        cardBadgeText?: string
        promo_badge_text?: string
        promoBadgeText?: string
        badge_text?: string
        "Lot Number"?: string
        lot_number?: string
        lot_number_short?: string
        move_in_date?: string
        community?: string
        city?: string
        price?: number
        self_tour_available?: boolean
        image_url?: string
        "FP: Starting Price"?: number[] | number
        "FP: Living SqFt"?: number[] | number
        "FP: Total SqFt"?: number[] | number
        "FP: Bedrooms (Max)"?: number[] | number
        "FP: Bathrooms (Max)"?: number[] | number
        "FP: Garage"?: number[] | number
        "FP: Image"?: any
        "FP: Collection"?: string[] | string
    }
}

interface QMIHome {
    id: string
    address: string
    city: string
    state: string
    zip: string
    price: number
    estimatedMonthly?: number
    originalEstimatedMonthly?: number
    lifetimeSavings?: number
    bedrooms?: number
    bathrooms?: number
    garage?: number
    stories?: number
    sqft?: number
    totalSqft?: number
    community?: string
    communityUrl?: string
    floorPlan?: string
    floorPlanUrl?: string
    collection?: string
    homeType?: string
    status?: string
    dateAvailable?: string
    // Canonical "available now" flag, derived from the SAME signal as the card badge
    // (availability_text is authoritative). The Date-Available filter keys off this so a
    // home's bucket always matches its displayed tag.
    availableNow?: boolean
    lotNumber?: string
    cardBadgeText?: string
    promoText?: string
    availabilityLabel?: string
    image?: string
    url?: string
    coordinates: [number, number]
    openHouse?: boolean
    touringAvailable?: boolean
    nterNow?: string
    armRate?: string
}

interface QMIFilterState {
    communities: string[]
    cities: string[]
    priceRange: string
    dateAvailable: string
    collections: string[]
    floorPlans: string[]
    bathrooms: string
    bedrooms: string
    squareFeet: string
    homeTypes: string[]
    touringAvailable: boolean
}

const slugifyCommunity = (s: string) =>
    (s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")

const DEFAULT_QMI_FILTERS: QMIFilterState = {
    communities: [],
    cities: [],
    priceRange: "",
    dateAvailable: "",
    collections: [],
    floorPlans: [],
    bathrooms: "",
    bedrooms: "",
    squareFeet: "",
    homeTypes: [],
    touringAvailable: false,
}

// Seed the filter from the page URL so links can deep-link into a pre-filtered
// view, e.g. /new-homes/available/?community=Las%20Brisas%20at%20Tres%20Lagos.
// Mirrors Communities.tsx's ?city= handling — values are the exact community /
// city NAME (the filter matches by name), URLSearchParams handles decoding.
function parseQMIFiltersFromSearch(search: string): QMIFilterState {
    if (typeof window === "undefined" || !search) return { ...DEFAULT_QMI_FILTERS }
    const params = new URLSearchParams(search)
    if (!params.toString()) return { ...DEFAULT_QMI_FILTERS }
    const community = params.get("community")
    const city = params.get("city")
    return {
        ...DEFAULT_QMI_FILTERS,
        communities: community ? [community] : [],
        cities: city ? [city] : [],
    }
}

interface QuickMoveInsProps {
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
    popupMaxWidth?: number
    popupMinWidth?: number
    popupOffsetY?: number
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
    standardRatePct?: number
    incentiveRatePct?: number
    ratesSettingsUrl?: string
    incentiveBadgeFont?: CardFontOverride
    availabilityFont?: CardFontOverride
    lotFont?: CardFontOverride
    metaLabelFont?: CardFontOverride
    metaValueFont?: CardFontOverride
    titleFont?: CardFontOverride
    locationFont?: CardFontOverride
    priceFont?: CardFontOverride
    monthlyFont?: CardFontOverride
    specFont?: CardFontOverride
    tourBannerFont?: CardFontOverride
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
                    "0 = auto (scales with card width). Set px to lock size.",
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

declare global {
    interface Window {
        L: any
    }
}

let clientCache: { data: QMIHome[]; ts: number } | null = null
const CLIENT_CACHE_TTL = 60_000

const firstNum = (v: number[] | number | undefined): number | undefined => {
    if (typeof v === "number") return v
    if (Array.isArray(v) && typeof v[0] === "number") return v[0]
    return undefined
}
const firstStr = (v: string[] | string | undefined): string | undefined => {
    if (typeof v === "string") return v
    if (Array.isArray(v) && typeof v[0] === "string") return v[0]
    return undefined
}
const firstImage = (v: any): string | undefined => {
    if (!v) return undefined
    if (typeof v === "string") return v
    if (Array.isArray(v) && v.length) {
        const first = v[0]
        if (typeof first === "string") return first
        if (first && typeof first === "object" && typeof first.url === "string")
            return first.url
    }
    return undefined
}

function formatCollectionLabel(collection: string): string {
    const trimmed = collection.trim()
    if (/\bcollection\s*$/i.test(trimmed)) return trimmed
    return `${trimmed} Collection`
}

// PITI monthly payment — parity with the O'Neill listing calculator (verified to the
// cent on real homes): 3.5% down, 30-yr term, 2.08% property tax, 0.4% insurance,
// $180/yr HOA, 0.75% PMI. The card shows the INCENTIVE-rate figure (green); the
// STANDARD-rate figure is the struck-through "original", and the difference over the
// 360-month term is the "Savings Over 30 Years". Returns undefined for bad input.
function pitiMonthly(
    price?: number,
    annualRatePct?: number
): number | undefined {
    if (!price || price <= 0 || !annualRatePct || annualRatePct <= 0)
        return undefined
    const down = Math.round(price * 0.035)
    const principal = price - down
    const r = annualRatePct / 100 / 12
    const pi = (principal * r) / (1 - Math.pow(1 + r, -360))
    const taxes = (price * 0.0208) / 12
    const insurance = (price * 0.004) / 12
    const pmi = (principal * 0.0075) / 12
    return Math.round((pi + taxes + insurance + 15 + pmi) * 100) / 100
}

function transformWorkerRecord(record: WorkerHomeRecord): QMIHome | null {
    const f = record.fields || {}
    const lat =
        typeof f.latitude === "number"
            ? f.latitude
            : typeof (f as any).geo_latitude === "number"
              ? (f as any).geo_latitude
              : NaN
    const lng =
        typeof f.longitude === "number"
            ? f.longitude
            : typeof (f as any).geo_longitude === "number"
              ? (f as any).geo_longitude
              : NaN
    if (typeof lat !== "number" || typeof lng !== "number" || isNaN(lat) || isNaN(lng))
        return null

    const price =
        typeof f.Price === "number"
            ? f.Price
            : typeof f.price === "number"
              ? f.price
              : (firstNum(f["FP: Starting Price"]) ?? 0)
    const sqft =
        f.living_square_footage ??
        firstNum(f["Living Sq Ft"]) ??
        firstNum(f["FP: Living SqFt"])
    const totalSqft =
        f.total_square_footage ??
        firstNum(f["Total Sq Ft"]) ??
        firstNum(f["FP: Total SqFt"])
    const bedrooms = f.bedroom_count ?? firstNum(f["FP: Bedrooms (Max)"])
    // Combine full + half baths (Snowflake provides half_bathroom_count separately;
    // it was previously dropped, so 3.5-bath homes rendered as "3").
    const bathrooms =
        f.bathroom_count != null || f.half_bathroom_count != null
            ? Number(f.bathroom_count || 0) + 0.5 * Number(f.half_bathroom_count || 0)
            : firstNum(f["FP: Bathrooms (Max)"])
    const garage = f.car_garage_count ?? firstNum(f["FP: Garage"])
    const collection = f.Collection ?? firstStr(f["FP: Collection"])
    const image = f.image_url ?? firstImage(f["FP: Image"])
    const nterNow =
        firstStr(f.nter_now ?? f.NterNow ?? f["Enter Now"]) || undefined

    const viewerSlug = f["viewer slug"] || f.slug || ""
    const community = f.Community || f.community
    const city = f.City || f.city || ""
    const lotNumber =
        f["Lot Number"] || f.lot_number || f.lot_number_short || undefined
    const promoText = f.promo_text || undefined
    const cardBadgeText =
        f.card_badge_text ||
        f.cardBadgeText ||
        f.promo_badge_text ||
        f.promoBadgeText ||
        f.badge_text ||
        undefined
    // availability_text is the authoritative DISPLAY signal (e.g. "Available Now",
    // "Available JUL/AUG 2026"); the Available-Now checkbox is a separate flag that can
    // disagree with it. To keep the Date-Available FILTER bucket in sync with the on-card
    // TAG, derive one canonical "available now" boolean from the same text the badge uses,
    // falling back to the flag only when there's no text.
    const rawAvail = (f.availability_text || "").trim()
    const flagAvailableNow =
        f["Available Now"] === true || f.available_now === true
    const isAvailableNow = rawAvail ? /\bnow\b/i.test(rawAvail) : flagAvailableNow

    let status = "Coming Soon"
    if (rawAvail) {
        status = isAvailableNow
            ? "Available Now"
            : rawAvail.replace(/^available\s*/i, "").trim() || "Available Now"
    } else if (flagAvailableNow) {
        status = "Available Now"
    }

    let availabilityLabel: string | undefined
    if (rawAvail) {
        availabilityLabel = /^available/i.test(rawAvail)
            ? rawAvail.toUpperCase()
            : `AVAILABLE ${rawAvail.toUpperCase()}`
    } else if (flagAvailableNow) {
        availabilityLabel = "AVAILABLE NOW"
    } else if (status && status !== "Coming Soon") {
        availabilityLabel = /^available/i.test(status)
            ? status.toUpperCase()
            : `AVAILABLE ${status.toUpperCase()}`
    }

    const communitySlug = community
        ? community.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        : ""
    const citySlug = city
        ? city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        : ""
    const floorPlanSlug = f["Floor Plan"]
        ? f["Floor Plan"].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        : ""

    return {
        id: record.id,
        address: f.address || "Address TBD",
        city,
        state: "TX",
        zip: f.postal_code != null ? String(f.postal_code) : "",
        price,
        estimatedMonthly: f.estimated_monthly_price,
        bedrooms,
        bathrooms,
        garage,
        stories: f.stories_count,
        sqft,
        totalSqft,
        community,
        communityUrl: communitySlug
            ? `/new-homes/${citySlug ? citySlug + "/" : ""}${communitySlug}/`
            : undefined,
        floorPlan: f["Floor Plan"],
        floorPlanUrl: floorPlanSlug ? `/floor-plans/${floorPlanSlug}/` : undefined,
        collection,
        homeType: "Single Family",
        status,
        availableNow: isAvailableNow,
        dateAvailable: f.move_in_date || f["Move-In Date"] || undefined,
        availabilityLabel,
        lotNumber,
        cardBadgeText,
        promoText,
        image,
        url: viewerSlug ? `/new-homes/available/${viewerSlug}/` : "#",
        coordinates: [lng, lat],
        nterNow,
        touringAvailable:
            f["Self Tour Available?"] === true ||
            f.self_tour_available === true ||
            !!nterNow,
    }
}

async function fetchFromWorker(workerUrl: string): Promise<QMIHome[]> {
    const base = workerUrl.replace(/\/$/, "")
    const url = base.endsWith("/qmi") ? base : `${base}/qmi`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Worker HTTP ${res.status}`)
    const json = await res.json()
    const records: WorkerHomeRecord[] = json.homes || []
    return records
        .map(transformWorkerRecord)
        .filter((h): h is QMIHome => h !== null)
}


function escapeHtml(s: string) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

const SAMPLE_QMI_HOMES: QMIHome[] = [
    {
        id: "qmi-1",
        address: "1308 Zurich Avenue",
        city: "McAllen",
        state: "TX",
        zip: "78504",
        price: 236990,
        estimatedMonthly: 1865.82,
        bedrooms: 3,
        bathrooms: 2,
        garage: 2,
        stories: 1,
        sqft: 1249,
        totalSqft: 1652,
        community: "Las Brisas at Tres Lagos",
        communityUrl: "/new-homes/mcallen/las-brisas-at-tres-lagos/",
        floorPlan: "Nikola",
        floorPlanUrl: "/floor-plans/nikola/",
        collection: "Portfolio",
        homeType: "Single Family",
        status: "Available Now",
        lotNumber: "102",
        cardBadgeText: "3.99% ARM*",
        promoText: "3.99% ARM*",
        availabilityLabel: "AVAILABLE NOW",
        image: "https://media.esperanzahomes.com/153/2025/11/6/110325_Las_Brisas_Model_Home_33.jpg",
        url: "/new-homes/available/1308-zurich-avenue/",
        coordinates: [-98.25, 26.2],
        openHouse: false,
        touringAvailable: true,
        armRate: "3.99%",
    },
    {
        id: "qmi-2",
        address: "4008 N Sorgum Circle",
        city: "McAllen",
        state: "TX",
        zip: "78504",
        price: 313990,
        estimatedMonthly: 2472.15,
        bedrooms: 4,
        bathrooms: 3,
        garage: 2,
        stories: 2,
        sqft: 2442,
        totalSqft: 3595,
        community: "Anaqua at Tres Lagos",
        communityUrl: "/new-homes/mcallen/anaqua-at-tres-lagos/",
        floorPlan: "Pecan",
        floorPlanUrl: "/floor-plans/pecan/",
        collection: "Signature",
        homeType: "Single Family",
        status: "Available Now",
        lotNumber: "205",
        image: "https://media.esperanzahomes.com/153/2025/8/19/062225_4008_N_Sorgum_Cir_Pecan_Tuscan_Stucco_01.jpg",
        url: "/new-homes/available/4008-n-sorgum-circle/",
        coordinates: [-98.2306, 26.2034],
        openHouse: true,
        touringAvailable: true,
    },
    {
        id: "qmi-3",
        address: "1417 Silos Avenue",
        city: "Edinburg",
        state: "TX",
        zip: "78541",
        price: 338990,
        estimatedMonthly: 2669.94,
        bedrooms: 4,
        bathrooms: 2.5,
        garage: 2,
        stories: 2,
        sqft: 1848,
        totalSqft: 1948,
        community: "Silos at La Sienna",
        communityUrl: "/new-homes/edinburg/silos-at-la-sienna/",
        floorPlan: "Magnolia",
        floorPlanUrl: "/floor-plans/magnolia/",
        collection: "Heritage",
        homeType: "Single Family",
        status: "Available Now",
        lotNumber: "310",
        cardBadgeText: "AVAILABLE NOW",
        image: "https://media.esperanzahomes.com/153/2025/7/2/121324_Magnolia_Farmhouse_1417_Silos_Ave-01_1.jpg",
        url: "/new-homes/available/1417-silos-avenue/",
        coordinates: [-98.13, 26.29],
        openHouse: false,
        touringAvailable: true,
    },
    {
        id: "qmi-4",
        address: "908 Templo Dorado",
        city: "Laredo",
        state: "TX",
        zip: "78046",
        price: 224990,
        estimatedMonthly: 1771.36,
        bedrooms: 3,
        bathrooms: 2,
        garage: 2,
        stories: 1,
        sqft: 1233,
        totalSqft: 1476,
        community: "El Eden",
        communityUrl: "/new-homes/laredo/el-eden/",
        floorPlan: "Encino",
        floorPlanUrl: "/floor-plans/encino/",
        collection: "Portfolio",
        homeType: "Single Family",
        status: "Available Now",
        lotNumber: "48",
        image: "https://media.esperanzahomes.com/153/2025/12/22/Enhanced_Twilight_-_908_Templo_Dorado_1.jpg",
        url: "/new-homes/available/908-templo-dorado/",
        coordinates: [-99.52, 27.48],
        openHouse: true,
        touringAvailable: true,
    },
    {
        id: "qmi-5",
        address: "2301 Stewart Road",
        city: "San Juan",
        state: "TX",
        zip: "78589",
        price: 248990,
        estimatedMonthly: 1960.23,
        bedrooms: 4,
        bathrooms: 2,
        garage: 2,
        stories: 1,
        sqft: 1703,
        totalSqft: 2094,
        community: "Stewart Coves",
        communityUrl: "/new-homes/san-juan/stewart-coves/",
        floorPlan: "Allegrini",
        floorPlanUrl: "/floor-plans/allegrini/",
        collection: "Heritage",
        homeType: "Single Family",
        status: "Move-In Ready",
        lotNumber: "77",
        cardBadgeText: "3.99% ARM*",
        image: "https://media.esperanzahomes.com/153/2025/7/9/040325-Encino-Model-Home-Exterior-03-1_1.jpg",
        url: "/new-homes/available/2301-stewart-road/",
        coordinates: [-98.15, 26.19],
        openHouse: false,
        touringAvailable: true,
    },
    {
        id: "qmi-6",
        address: "5502 Harvest Lane",
        city: "McAllen",
        state: "TX",
        zip: "78504",
        price: 269990,
        estimatedMonthly: 2125.62,
        bedrooms: 5,
        bathrooms: 3,
        garage: 2,
        stories: 2,
        sqft: 2211,
        totalSqft: 2874,
        community: "Harvest Coves",
        communityUrl: "/new-homes/mcallen/harvest-coves/",
        floorPlan: "Cypress",
        floorPlanUrl: "/floor-plans/cypress/",
        collection: "Signature",
        homeType: "Single Family",
        status: "Available Now",
        lotNumber: "156",
        image: "https://media.esperanzahomes.com/153/2026/1/8/Harvest_Coves_Aerial_Update_11.jpg",
        url: "/new-homes/available/5502-harvest-lane/",
        coordinates: [-98.22, 26.23],
        openHouse: false,
        touringAvailable: false,
    },
    {
        id: "qmi-bella-1806",
        address: "1806 E Bella St",
        city: "Edinburg",
        state: "TX",
        zip: "78542",
        price: 229990,
        estimatedMonthly: 2025.55,
        bedrooms: 2,
        bathrooms: 2,
        garage: 2,
        stories: 1,
        sqft: 960,
        totalSqft: 1433,
        community: "Villas at La Sienna",
        communityUrl: "/new-homes/edinburg/villas-at-la-sienna/",
        floorPlan: "Lunelli",
        floorPlanUrl: "/floor-plans/lunelli/",
        collection: "Villas",
        homeType: "Single Family",
        status: "Available SEP/OCT 2026",
        availabilityLabel: "AVAILABLE SEP/OCT 2026",
        lotNumber: "007",
        cardBadgeText: "Unlock Your $20K Flex Discount Now!",
        promoText: "Unlock Your $20K Flex Discount Now!",
        image: "https://media.esperanzahomes.com/153/2025/5/29/Lunelli_-_Tuscan_Stucco_V04.jpg",
        url: "/new-homes/available/1806-e-bella-st/",
        coordinates: [-98.13, 26.34],
        openHouse: false,
        touringAvailable: true,
    },
]

/**
 * @framerDisableUnlink
 * @framerIntrinsicWidth 1440
 * @framerIntrinsicHeight 900
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight any
 */
export default function QuickMoveIns({
    cacheWorkerUrl = "https://esperanza-api.round-base-ed8c.workers.dev/api/public/qmi",
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
    popupMaxWidth = 320,
    popupMinWidth = 280,
    popupOffsetY = -32,
    mapPanelBg = "#e9edea",
    primaryColor = "#295135",
    strokeColor = "#0c4128",
    textDark = "#3c3c3c",
    accentTan = "#85754e",
    fontCssUrl = "",
    communitiesUrl = "/new-homes",
    quickMoveInsUrl = "/new-homes/available",
    floorPlansUrl = "/floorplan-collections",
    downloadPdfUrl = "/new-homes/available/pdf",
    filteredPdfBaseUrl = "https://esperanza-pdf.round-base-ed8c.workers.dev",
    ctaUrl = "/contact",
    showResultCount = false,
    standardRatePct = 6.15,
    incentiveRatePct = 4.99,
    ratesSettingsUrl = "",
    incentiveBadgeFont,
    availabilityFont,
    lotFont,
    metaLabelFont,
    metaValueFont,
    titleFont,
    locationFont,
    priceFont,
    monthlyFont,
    specFont,
    tourBannerFont,
    buttonFont,
}: QuickMoveInsProps) {
    const mapEl = useRef<HTMLDivElement | null>(null)
    const mapRef = useRef<any>(null)
    const popupRef = useRef<any>(null)
    const listRef = useRef<HTMLDivElement | null>(null)

    const [mapLoaded, setMapLoaded] = useState(false)
    const [mapReady, setMapReady] = useState(false)
    const [homes, setHomes] = useState<QMIHome[]>([])
    const [filtered, setFiltered] = useState<QMIHome[]>([])
    const [loading, setLoading] = useState(true)
    const [showFilters, setShowFilters] = useState(true)
    const [mobileView, setMobileView] = useState<"list" | "map">("list")
    const [sortBy, setSortBy] = useState<string>("sqft-asc")
    const [hoveredCardId, setHoveredCardId] = useState<string | null>(null)
    const [filters, setFilters] = useState<QMIFilterState>(() =>
        typeof window !== "undefined"
            ? parseQMIFiltersFromSearch(window.location.search)
            : { ...DEFAULT_QMI_FILTERS }
    )

    // Mortgage rates driving the card payment figures. Defaults come from the props
    // (standard = market rate / struck-through, incentive = promo rate / green). If
    // ratesSettingsUrl is set, the company-wide values are fetched from the admin
    // settings endpoint (mortgage_rate = standard, incentive_rate = incentive) so the
    // marketing team can change them in admin and every card re-prices on next load.
    const [rates, setRates] = useState({
        standard: standardRatePct,
        incentive: incentiveRatePct,
    })
    useEffect(() => {
        setRates({ standard: standardRatePct, incentive: incentiveRatePct })
        if (!ratesSettingsUrl) return
        let cancelled = false
        fetch(ratesSettingsUrl)
            .then((r) => r.json())
            .then((j) => {
                if (cancelled) return
                const s = (j && j.settings) || j || {}
                const std = Number(s.mortgage_rate)
                const inc = Number(s.incentive_rate)
                setRates({
                    standard: std > 0 ? std : standardRatePct,
                    incentive: inc > 0 ? inc : incentiveRatePct,
                })
            })
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [ratesSettingsUrl, standardRatePct, incentiveRatePct])

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
                "https://fonts.googleapis.com/css2?family=Overpass:wght@300;400;600;700&family=Arapey:ital@0;1&display=swap"
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
            setHomes(clientCache.data)
            setFiltered(clientCache.data)
            setLoading(false)
            return
        }

        setLoading(true)
        try {
            let data: QMIHome[]

            if (cacheWorkerUrl) {
                data = await fetchFromWorker(cacheWorkerUrl)
                if (!data.length) data = SAMPLE_QMI_HOMES
            } else {
                data = SAMPLE_QMI_HOMES
            }

            clientCache = { data, ts: Date.now() }
            setHomes(data)
            setFiltered(data)
        } catch (e) {
            console.warn("[QMI] Fetch failed, using sample data", e)
            setHomes(SAMPLE_QMI_HOMES)
            setFiltered(SAMPLE_QMI_HOMES)
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
            console.warn("[QMI] Map init failed:", e)
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

        const pinIcon = L.divIcon({
            className: "qmi-pin-wrap qmi-pin-wrap--teardrop",
            html: `<img class="qmi-pin-teardrop" src="${MAP_PIN_SVG}" alt="" style="width:${pinWidth}px;height:${pinHeight}px" />`,
            iconSize: [pinWidth, pinHeight],
            iconAnchor: [pinWidth / 2, pinHeight],
        })

        const markers: any[] = []
        let activeHoverCloseTimer: ReturnType<typeof setTimeout> | null = null
        const clearActiveHoverClose = () => {
            if (activeHoverCloseTimer) {
                clearTimeout(activeHoverCloseTimer)
                activeHoverCloseTimer = null
            }
        }

        for (const h of filtered) {
            const [lng, lat] = h.coordinates
            if (
                typeof lat !== "number" ||
                typeof lng !== "number" ||
                isNaN(lat) ||
                isNaN(lng) ||
                (lat === 0 && lng === 0)
            )
                continue
            const m = L.marker([lat, lng], { icon: pinIcon })
            const html = createPopupHTML(h)
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
                    setHoveredCardId(h.id)
                })
                popupEl.addEventListener("mouseleave", () => {
                    m.closePopup()
                    setHoveredCardId((id) => (id === h.id ? null : id))
                })
            }

            m.on("mouseover", () => {
                clearHoverClose()
                map.eachLayer((layer: any) => {
                    if (layer?.closePopup) layer.closePopup()
                })
                m.openPopup()
                bindPopupHover()
                setHoveredCardId(h.id)
            })
            m.on("mouseout", () => {
                clearHoverClose()
                activeHoverCloseTimer = setTimeout(() => {
                    const popupEl = m.getPopup()?.getElement?.()
                    if (popupEl && popupEl.matches(":hover")) return
                    m.closePopup()
                    setHoveredCardId((id) => (id === h.id ? null : id))
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
        popupMaxWidth,
        popupMinWidth,
        popupOffsetY,
        clusterSizeSmall,
        clusterSizeMedium,
        clusterSizeLarge,
    ])

    useEffect(() => {
        let out = homes.filter((h) => {
            if (filters.communities.length && h.community) {
                // Slug-aware: the city map's community links deep-link with the
                // community SLUG (?community=<slug>), while the dropdown selects
                // by exact name — match either form.
                const hcSlug = slugifyCommunity(h.community)
                const match = filters.communities.some(
                    (sel) =>
                        sel === h.community || slugifyCommunity(sel) === hcSlug
                )
                if (!match) return false
            } else if (filters.communities.length) return false

            if (filters.cities.length) {
                if (!h.city || !filters.cities.includes(h.city)) return false
            }

            if (filters.priceRange && h.price) {
                const [min, max] = filters.priceRange.split("-").map(Number)
                if (max) {
                    if (h.price < min || h.price > max) return false
                } else {
                    if (h.price < min) return false
                }
            }

            if (filters.dateAvailable) {
                // Use the same canonical "available now" the card badge shows, so the
                // bucket never disagrees with the on-card tag. (Fallback to status for
                // the sample-data path, which doesn't set availableNow.)
                const homeAvailableNow =
                    h.availableNow ??
                    (h.status === "Available Now" ||
                        h.status === "Move-In Ready")
                if (filters.dateAvailable === "now") {
                    if (!homeAvailableNow) return false
                } else if (
                    ["30", "60", "90"].includes(filters.dateAvailable)
                ) {
                    // Available-now homes satisfy every day-window; future homes are
                    // judged by their move-in date.
                    if (!homeAvailableNow) {
                        if (!h.dateAvailable) return false
                        const d = new Date(h.dateAvailable)
                        const now = new Date()
                        const diff =
                            (d.getTime() - now.getTime()) /
                            (1000 * 60 * 60 * 24)
                        if (
                            isNaN(diff) ||
                            diff > parseInt(filters.dateAvailable)
                        )
                            return false
                    }
                }
            }

            if (filters.collections.length && h.collection) {
                if (!filters.collections.includes(h.collection)) return false
            } else if (filters.collections.length) return false

            if (filters.floorPlans.length && h.floorPlan) {
                if (!filters.floorPlans.includes(h.floorPlan)) return false
            } else if (filters.floorPlans.length) return false

            if (filters.bathrooms && h.bathrooms) {
                const minBath = parseInt(filters.bathrooms)
                if (h.bathrooms < minBath) return false
            }

            if (filters.bedrooms && h.bedrooms != null) {
                const minBed = parseInt(filters.bedrooms)
                if (h.bedrooms < minBed) return false
            }

            if (filters.squareFeet && h.sqft != null) {
                const [minStr, maxStr] = filters.squareFeet.split("-")
                const min = parseInt(minStr)
                const max = parseInt(maxStr)
                if (max) {
                    if (h.sqft < min || h.sqft > max) return false
                } else {
                    if (h.sqft < min) return false
                }
            }

            if (filters.homeTypes.length && h.homeType) {
                if (!filters.homeTypes.includes(h.homeType)) return false
            } else if (filters.homeTypes.length) return false

            if (filters.touringAvailable && !h.touringAvailable) return false

            return true
        })

        out = [...out].sort((a, b) => {
            if (sortBy === "price-asc")
                return (a.price || 999999999) - (b.price || 999999999)
            if (sortBy === "price-desc") return (b.price || 0) - (a.price || 0)
            if (sortBy === "sqft-asc")
                return (a.sqft || 999999) - (b.sqft || 999999)
            if (sortBy === "sqft-desc") return (b.sqft || 0) - (a.sqft || 0)
            if (sortBy === "date-asc") {
                const da = a.dateAvailable
                    ? new Date(a.dateAvailable).getTime()
                    : Infinity
                const db = b.dateAvailable
                    ? new Date(b.dateAvailable).getTime()
                    : Infinity
                return da - db
            }
            return 0
        })

        setFiltered(out)
    }, [filters, homes, sortBy])

    const filteredPdfHref = useMemo(() => {
        if (!filteredPdfBaseUrl) return downloadPdfUrl
        const base = filteredPdfBaseUrl.replace(/\/$/, "")
        // The PDF worker serves pre-rendered list documents by slug (it does NOT support
        // query-param filtering):
        //   master   → /pdf/list/quick-move-in-homes  (all QMIs, grouped by community)
        //   per-city → /pdf/list/<citySlug>-qmis
        // Scope to a single selected city when exactly one is active; else the master list.
        if (filters.cities.length === 1) {
            const citySlug = filters.cities[0]
                .toLowerCase()
                .trim()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "")
            if (citySlug) return `${base}/pdf/list/${citySlug}-qmis`
        }
        return `${base}/pdf/list/quick-move-in-homes`
    }, [filters.cities, filteredPdfBaseUrl, downloadPdfUrl])

    // Compute the payment figures onto each home from list price + the two rates:
    // estimatedMonthly = incentive rate (green), originalEstimatedMonthly = standard
    // rate (struck through), lifetimeSavings = (standard − incentive) × 360 months.
    // Falls back to the feed's estimated_monthly_price when price is unavailable.
    const displayHomes = useMemo(() => {
        return filtered.map((h) => {
            if (!(h.price > 0)) return h
            const inc = pitiMonthly(h.price, rates.incentive)
            const std = pitiMonthly(h.price, rates.standard)
            const showSavings = !!inc && !!std && std > inc
            return {
                ...h,
                estimatedMonthly: inc ?? h.estimatedMonthly,
                originalEstimatedMonthly: showSavings ? std : undefined,
                lifetimeSavings: showSavings
                    ? Math.round((std - inc) * 360 * 100) / 100
                    : undefined,
            }
        })
    }, [filtered, rates])

    const uniqueCommunities = useMemo(
        () =>
            [
                ...new Set(homes.map((h) => h.community).filter(Boolean)),
            ].sort() as string[],
        [homes]
    )
    const uniqueCities = useMemo(
        () =>
            [
                ...new Set(homes.map((h) => h.city).filter(Boolean)),
            ].sort() as string[],
        [homes]
    )
    const uniqueCollections = useMemo(
        () =>
            [
                ...new Set(homes.map((h) => h.collection).filter(Boolean)),
            ].sort() as string[],
        [homes]
    )
    const uniqueFloorPlans = useMemo(
        () =>
            [
                ...new Set(homes.map((h) => h.floorPlan).filter(Boolean)),
            ].sort() as string[],
        [homes]
    )
    const uniqueHomeTypes = useMemo(
        () =>
            [
                ...new Set(homes.map((h) => h.homeType).filter(Boolean)),
            ].sort() as string[],
        [homes]
    )

    function createPopupHTML(h: QMIHome) {
        const priceAmount = h.price ? `$${Number(h.price).toLocaleString()}` : ""
        const cityState = `${h.city || ""}${h.city && h.state ? ", " : ""}${h.state || ""}`
        const href = escapeHtml(h.url || "#")
        return `
            <a class="qmi-popup" href="${href}">
                ${h.image ? `<div class="qmi-popup-imgwrap"><img class="qmi-popup-img" src="${escapeHtml(h.image)}" alt="${escapeHtml(h.address)}" loading="lazy" /></div>` : ""}
                <div class="qmi-popup-body">
                    <div class="qmi-popup-info">
                        <div class="qmi-popup-title">${escapeHtml(h.address ?? "")}</div>
                        <div class="qmi-popup-location">${escapeHtml(cityState)}</div>
                    </div>
                    ${priceAmount ? `<div class="qmi-popup-price-block"><div class="qmi-popup-price-label">Price</div><div class="qmi-popup-price">${priceAmount}</div></div>` : ""}
                </div>
            </a>
        `
    }

    const fmtPrice = (n: number) => "$" + n.toLocaleString()

    const renderFilterSelects = (idPrefix: string) => (
        <>
            {uniqueCommunities.length > 0 && (
                <div className="qmi-dropdown">
                    <select
                        className="qmi-select-pill"
                        value={
                            filters.communities.length === 1
                                ? filters.communities[0]
                                : ""
                        }
                        onChange={(e) => {
                            const val = e.target.value
                            setFilters((prev) => ({
                                ...prev,
                                communities: val ? [val] : [],
                            }))
                        }}
                    >
                        <option value="">Community</option>
                        {uniqueCommunities.map((c) => (
                            <option key={c} value={c}>
                                {c}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            {uniqueCities.length > 0 && (
                <div className="qmi-dropdown">
                    <select
                        className="qmi-select-pill"
                        value={
                            filters.cities.length === 1 ? filters.cities[0] : ""
                        }
                        onChange={(e) => {
                            const val = e.target.value
                            setFilters((prev) => ({
                                ...prev,
                                cities: val ? [val] : [],
                            }))
                        }}
                    >
                        <option value="">Select A City</option>
                        {uniqueCities.map((c) => (
                            <option key={c} value={c}>
                                {c}
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
            <div className="qmi-dropdown">
                <select
                    className="qmi-select-pill"
                    value={filters.dateAvailable}
                    onChange={(e) =>
                        setFilters((prev) => ({
                            ...prev,
                            dateAvailable: e.target.value,
                        }))
                    }
                >
                    <option value="">Date Available</option>
                    <option value="now">Available Now</option>
                    <option value="30">Within 30 Days</option>
                    <option value="60">Within 60 Days</option>
                    <option value="90">Within 90 Days</option>
                </select>
            </div>
        </>
    )

    const renderFilterRowA = () => (
        <>
            <div className="qmi-dropdown">
                <select
                    className="qmi-select-pill"
                    value={
                        filters.collections.length === 1
                            ? filters.collections[0]
                            : ""
                    }
                    onChange={(e) => {
                        const val = e.target.value
                        setFilters((prev) => ({
                            ...prev,
                            collections: val ? [val] : [],
                        }))
                    }}
                >
                    <option value="">Collection</option>
                    {uniqueCollections.map((c) => (
                        <option key={c} value={c}>
                            {c}
                        </option>
                    ))}
                </select>
            </div>
            {uniqueFloorPlans.length > 0 && (
                <div className="qmi-dropdown">
                    <select
                        className="qmi-select-pill"
                        value={
                            filters.floorPlans.length === 1
                                ? filters.floorPlans[0]
                                : ""
                        }
                        onChange={(e) => {
                            const val = e.target.value
                            setFilters((prev) => ({
                                ...prev,
                                floorPlans: val ? [val] : [],
                            }))
                        }}
                    >
                        <option value="">Floor Plan</option>
                        {uniqueFloorPlans.map((c) => (
                            <option key={c} value={c}>
                                {c}
                            </option>
                        ))}
                    </select>
                </div>
            )}
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
                    <option value="1">1+</option>
                    <option value="2">2+</option>
                    <option value="3">3+</option>
                    <option value="4">4+</option>
                    <option value="5">5+</option>
                </select>
            </div>
            <div className="qmi-dropdown">
                <select
                    className="qmi-select-pill"
                    value={filters.squareFeet}
                    onChange={(e) =>
                        setFilters((prev) => ({
                            ...prev,
                            squareFeet: e.target.value,
                        }))
                    }
                >
                    <option value="">Square Feet</option>
                    <option value="0-1500">Under 1,500 Sq.Ft.</option>
                    <option value="1500-2000">1,500 - 2,000 Sq.Ft.</option>
                    <option value="2000-2500">2,000 - 2,500 Sq.Ft.</option>
                    <option value="2500-3000">2,500 - 3,000 Sq.Ft.</option>
                    <option value="3000-0">3,000+ Sq.Ft.</option>
                </select>
            </div>
        </>
    )

    const renderFilterRowB = () => (
        <>
            <div className="qmi-dropdown">
                <select
                    className="qmi-select-pill"
                    value={
                        filters.homeTypes.length === 1
                            ? filters.homeTypes[0]
                            : ""
                    }
                    onChange={(e) => {
                        const val = e.target.value
                        setFilters((prev) => ({
                            ...prev,
                            homeTypes: val ? [val] : [],
                        }))
                    }}
                >
                    <option value="">Home Type</option>
                    {uniqueHomeTypes.map((t) => (
                        <option key={t} value={t}>
                            {t}
                        </option>
                    ))}
                </select>
            </div>
            <div className="qmi-dropdown">
                <select
                    className="qmi-select-pill"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                >
                    <option value="sqft-asc">Sq. Ft. (Lowest First)</option>
                    <option value="sqft-desc">Sq. Ft. (Highest First)</option>
                    <option value="price-asc">Price (Lowest First)</option>
                    <option value="price-desc">Price (Highest First)</option>
                    <option value="date-asc">Available Date (Soonest)</option>
                </select>
            </div>
            <label className="qmi-checkbox-cell">
                <input
                    type="checkbox"
                    checked={filters.touringAvailable}
                    onChange={(e) =>
                        setFilters((prev) => ({
                            ...prev,
                            touringAvailable: e.target.checked,
                        }))
                    }
                />
                <span>Self-Touring Available</span>
            </label>
        </>
    )

    return (
        <div className="qmi-wrap">
            <div className="qmi-filter-area">
                <div className="qmi-filter-top">
                    <nav className="qmi-tabs" aria-label="Find a home">
                        <a href={communitiesUrl} className="qmi-tab">
                            Communities
                        </a>
                        <a href={quickMoveInsUrl} className="qmi-tab active">
                            Quick Move-Ins
                        </a>
                        <a href={floorPlansUrl} className="qmi-tab">
                            Floor Plans
                        </a>
                    </nav>

                    <div className="qmi-primary-filters">
                        {renderFilterSelects("desktop")}
                        <button
                            className="qmi-filter-toggle-block"
                            onClick={() => setShowFilters(!showFilters)}
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
                    <>
                        <div className="qmi-filter-row qmi-filter-row-a">
                            {renderFilterRowA()}
                        </div>
                        <div className="qmi-filter-row qmi-filter-row-b">
                            {renderFilterRowB()}
                        </div>
                        <div className="qmi-filter-download-row">
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
                                Download Quick Move-Ins List
                            </a>
                        </div>
                    </>
                )}
            </div>

            <div className="qmi-title-row">
                <div className="qmi-title-col">
                    <h1>Quick Move-Ins</h1>
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
                        {renderFilterSelects("mobile")}
                        {renderFilterRowA()}
                        {renderFilterRowB()}
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
                                Showing {filtered.length} home
                                {filtered.length !== 1 ? "s" : ""}
                            </span>
                        )}
                    </div>
                    <div className="qmi-list-content">
                        {loading && (
                            <div className="qmi-loading">
                                Loading quick move-in homes...
                            </div>
                        )}
                        {!loading && filtered.length === 0 && (
                            <div className="qmi-empty">
                                No quick move-in homes found matching your
                                criteria.
                            </div>
                        )}
                        {!loading && (
                            <div className="qmi-card-grid">
                                {displayHomes.map((h) => (
                                    <div
                                        key={h.id}
                                        id={`qmi-card-${h.id}`}
                                        className={`qmi-card ${hoveredCardId === h.id ? "is-hovered" : ""}`}
                                        onMouseEnter={() =>
                                            setHoveredCardId(h.id)
                                        }
                                        onMouseLeave={() =>
                                            setHoveredCardId(null)
                                        }
                                    >
                                        <div className="qmi-card-left">
                                            <div className="qmi-card-image">
                                                <div className="qmi-banners-stack">
                                                    {h.cardBadgeText && (
                                                        <div
                                                            className="qmi-banner qmi-banner-tan"
                                                            style={cardFontStyle(
                                                                incentiveBadgeFont
                                                            )}
                                                        >
                                                            {h.cardBadgeText}
                                                        </div>
                                                    )}
                                                    {h.availabilityLabel && (
                                                        <div
                                                            className="qmi-banner qmi-banner-availability"
                                                            style={cardFontStyle(
                                                                availabilityFont
                                                            )}
                                                        >
                                                            {h.availabilityLabel}
                                                        </div>
                                                    )}
                                                </div>
                                                {h.lotNumber && (
                                                    <div
                                                        className="qmi-banner-lot"
                                                        style={cardFontStyle(
                                                            lotFont
                                                        )}
                                                    >
                                                        Lot #{h.lotNumber}
                                                    </div>
                                                )}
                                                <img
                                                    src={
                                                        h.image ||
                                                        "https://via.placeholder.com/400x300?text=Home"
                                                    }
                                                    alt={h.address}
                                                    loading="lazy"
                                                />
                                                {h.touringAvailable && (
                                                    <div
                                                        className="qmi-banner-tour"
                                                        style={cardFontStyle(
                                                            tourBannerFont
                                                        )}
                                                    >
                                                        Self-Touring Available
                                                    </div>
                                                )}
                                                <div className="qmi-hover-overlay">
                                                    <a
                                                        href={h.url || "#"}
                                                        className="qmi-hover-btn"
                                                        style={cardFontStyle(
                                                            buttonFont
                                                        )}
                                                    >
                                                        View Home
                                                    </a>
                                                    <a
                                                        href={
                                                            h.nterNow ||
                                                            h.url ||
                                                            ctaUrl
                                                        }
                                                        {...(h.nterNow
                                                            ? {
                                                                  target: "_blank",
                                                                  rel: "noopener noreferrer",
                                                              }
                                                            : {})}
                                                        className="qmi-hover-btn qmi-hover-btn-tour"
                                                        style={cardFontStyle(
                                                            buttonFont
                                                        )}
                                                    >
                                                        {h.nterNow
                                                            ? "Request Your Time"
                                                            : "Request a Tour"}
                                                    </a>
                                                </div>
                                            </div>
                                            {(h.community || h.floorPlan) && (
                                                <div className="qmi-card-meta">
                                                    {h.community && (
                                                        <a
                                                            href={
                                                                h.communityUrl ||
                                                                "#"
                                                            }
                                                            className="qmi-meta-col"
                                                        >
                                                            <div
                                                                className="qmi-meta-label"
                                                                style={cardFontStyle(
                                                                    metaLabelFont
                                                                )}
                                                            >
                                                                Community
                                                            </div>
                                                            <div
                                                                className="qmi-meta-value"
                                                                style={cardFontStyle(
                                                                    metaValueFont
                                                                )}
                                                            >
                                                                {h.community}
                                                            </div>
                                                        </a>
                                                    )}
                                                    {h.floorPlan && (
                                                        <a
                                                            href={
                                                                h.floorPlanUrl ||
                                                                "#"
                                                            }
                                                            className="qmi-meta-col"
                                                        >
                                                            <div
                                                                className="qmi-meta-label"
                                                                style={cardFontStyle(
                                                                    metaLabelFont
                                                                )}
                                                            >
                                                                Floor Plan
                                                            </div>
                                                            <div
                                                                className="qmi-meta-value"
                                                                style={cardFontStyle(
                                                                    metaValueFont
                                                                )}
                                                            >
                                                                {h.floorPlan}
                                                            </div>
                                                            {h.collection && (
                                                                <div
                                                                    className="qmi-meta-sub"
                                                                    style={cardFontStyle(
                                                                        metaValueFont
                                                                    )}
                                                                >
                                                                    {formatCollectionLabel(
                                                                        h.collection
                                                                    )}
                                                                </div>
                                                            )}
                                                        </a>
                                                    )}
                                                </div>
                                            )}
                                        </div>

                                        <div className="qmi-card-body">
                                            <a
                                                href={h.url || "#"}
                                                className="qmi-card-address"
                                                style={cardFontStyle(titleFont)}
                                            >
                                                {h.address}
                                            </a>
                                            <div
                                                className="qmi-card-location"
                                                style={cardFontStyle(
                                                    locationFont
                                                )}
                                            >
                                                {h.city}
                                                {h.city && h.state ? ", " : ""}
                                                {h.state} {h.zip}
                                            </div>

                                            {h.price > 0 && (
                                                <div
                                                    className="qmi-card-price"
                                                    style={cardFontStyle(
                                                        priceFont
                                                    )}
                                                >
                                                    {fmtPrice(h.price)}
                                                </div>
                                            )}

                                            {h.estimatedMonthly && (
                                                <div className="qmi-monthly-block">
                                                    <div
                                                        className="qmi-monthly-heading"
                                                        style={cardFontStyle(
                                                            monthlyFont
                                                        )}
                                                    >
                                                        Estimated Monthly
                                                    </div>
                                                    <div className="qmi-monthly-prices">
                                                        <span
                                                            className="qmi-monthly-label"
                                                            style={cardFontStyle(
                                                                monthlyFont
                                                            )}
                                                        >
                                                            Price:
                                                        </span>{" "}
                                                        <span
                                                            className="qmi-monthly-current"
                                                            style={cardFontStyle(
                                                                monthlyFont
                                                            )}
                                                        >
                                                            $
                                                            {Number(
                                                                h.estimatedMonthly
                                                            ).toLocaleString(
                                                                undefined,
                                                                {
                                                                    minimumFractionDigits: 2,
                                                                    maximumFractionDigits: 2,
                                                                }
                                                            )}
                                                            /mo*
                                                        </span>
                                                        {h.originalEstimatedMonthly && (
                                                            <>
                                                                {" "}
                                                                <span
                                                                    className="qmi-monthly-original"
                                                                    style={cardFontStyle(
                                                                        monthlyFont
                                                                    )}
                                                                >
                                                                    $
                                                                    {Number(
                                                                        h.originalEstimatedMonthly
                                                                    ).toLocaleString(
                                                                        undefined,
                                                                        {
                                                                            minimumFractionDigits: 2,
                                                                            maximumFractionDigits: 2,
                                                                        }
                                                                    )}
                                                                    /mo*
                                                                </span>
                                                            </>
                                                        )}
                                                    </div>
                                                    {h.lifetimeSavings && (
                                                        <div
                                                            className="qmi-monthly-savings"
                                                            style={cardFontStyle(
                                                                monthlyFont
                                                            )}
                                                        >
                                                            $
                                                            {h.lifetimeSavings.toLocaleString(
                                                                undefined,
                                                                {
                                                                    minimumFractionDigits: 2,
                                                                    maximumFractionDigits: 2,
                                                                }
                                                            )}{" "}
                                                            Savings Over 30
                                                            Years
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            <div className="qmi-specs">
                                                {h.bedrooms != null && (
                                                    <div
                                                        className="qmi-spec-item"
                                                        style={cardFontStyle(
                                                            specFont
                                                        )}
                                                    >
                                                        <img className="qmi-spec-icon" src={STAT_ICONS.bed} alt="" />
                                                        {h.bedrooms} Bedroom
                                                        {h.bedrooms !== 1
                                                            ? "s"
                                                            : ""}
                                                    </div>
                                                )}
                                                {h.garage != null &&
                                                    h.garage > 0 && (
                                                        <div
                                                            className="qmi-spec-item"
                                                            style={cardFontStyle(
                                                                specFont
                                                            )}
                                                        >
                                                            <img className="qmi-spec-icon" src={STAT_ICONS.garage} alt="" />
                                                            {h.garage} Car
                                                            Garage
                                                        </div>
                                                    )}
                                                {h.bathrooms != null && (
                                                    <div
                                                        className="qmi-spec-item"
                                                        style={cardFontStyle(
                                                            specFont
                                                        )}
                                                    >
                                                        <img className="qmi-spec-icon" src={STAT_ICONS.bath} alt="" />
                                                        {h.bathrooms} Bathroom
                                                        {h.bathrooms !== 1
                                                            ? "s"
                                                            : ""}
                                                    </div>
                                                )}
                                                {h.stories != null && (
                                                    <div
                                                        className="qmi-spec-item"
                                                        style={cardFontStyle(
                                                            specFont
                                                        )}
                                                    >
                                                        <img className="qmi-spec-icon" src={STAT_ICONS.stairs} alt="" />
                                                        {h.stories} Stor
                                                        {h.stories !== 1
                                                            ? "ies"
                                                            : "y"}
                                                    </div>
                                                )}
                                                {h.sqft != null && (
                                                    <div
                                                        className="qmi-spec-item"
                                                        style={cardFontStyle(
                                                            specFont
                                                        )}
                                                    >
                                                        <img className="qmi-spec-icon" src={STAT_ICONS.livingSqft} alt="" />
                                                        {h.sqft.toLocaleString()}{" "}
                                                        <strong>Living</strong>{" "}
                                                        Sq. Ft.
                                                    </div>
                                                )}
                                                {h.totalSqft != null && (
                                                    <div
                                                        className="qmi-spec-item"
                                                        style={cardFontStyle(
                                                            specFont
                                                        )}
                                                    >
                                                        <img className="qmi-spec-icon" src={STAT_ICONS.sqft} alt="" />
                                                        {h.totalSqft.toLocaleString()}{" "}
                                                        <strong>Total</strong>{" "}
                                                        Sq. Ft.
                                                    </div>
                                                )}
                                            </div>
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
                    --qmi-tan-promo: #C1B694;
                    --qmi-lot-badge: #E9E8ED;
                    --qmi-bg: #f2f0ec;
                    --qmi-popup-width: ${popupMinWidth}px;
                    --qmi-map-tile-filter: ${mapTileFilter};
                    --qmi-font-bodoni: 'Bodoni', 'Arapey', Georgia, serif;
                    --qmi-font-overpass: 'Overpass', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }

                .qmi-wrap {
                    width: 100%;
                    background: var(--qmi-bg);
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
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

                .qmi-tab:first-child { border-radius: 800px 0 0 800px; }
                .qmi-tab:last-child  { border-right: 0; border-radius: 0 800px 800px 0; }

                .qmi-tab.active,
                .qmi-tab:hover {
                    color: #fff;
                    background: var(--qmi-dark-green);
                }

                .qmi-primary-filters {
                    display: grid;
                    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) 72px;
                    align-items: center;
                    gap: 12px;
                    padding: 16px 0 16px 12px;
                    min-width: 0;
                }

                .qmi-primary-filters > * { min-width: 0; }
                .qmi-dropdown { min-width: 0; }

                /* Secondary filter rows — two 4-col grids stacked, matching live site */
                .qmi-filter-row {
                    display: grid;
                    grid-template-columns: repeat(4, minmax(0, 1fr));
                    gap: 14px;
                    padding: 10px 22px;
                    align-items: center;
                    min-width: 0;
                }

                .qmi-filter-row-a {
                    padding-top: 14px;
                    border-top: 1px solid rgba(0, 0, 0, 0.03);
                    box-shadow: 0 0.125rem 0.25rem rgba(0, 0, 0, 0.075);
                }

                .qmi-filter-download-row {
                    display: flex;
                    justify-content: flex-start;
                    padding: 10px 22px 18px;
                }

                .qmi-checkbox-cell {
                    display: inline-flex;
                    align-items: center;
                    gap: 10px;
                    height: 40px;
                    padding: 0 4px;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: 14px;
                    color: var(--qmi-text);
                    cursor: pointer;
                    white-space: nowrap;
                }

                .qmi-checkbox-cell input {
                    accent-color: var(--qmi-green);
                    width: 16px;
                    height: 16px;
                    margin: 0;
                    flex-shrink: 0;
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

                .qmi-select-pill {
                    appearance: none;
                    -webkit-appearance: none;
                    background-color: var(--qmi-white);
                    background-image: url("https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/assets/images/green-down-arrow.svg");
                    background-position: right 15px center;
                    background-repeat: no-repeat;
                    background-size: 16px;
                    border: 1px solid var(--qmi-border);
                    border-radius: 50rem;
                    color: var(--qmi-text);
                    cursor: pointer;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: 14px;
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
                    font-size: 14px;
                    line-height: 39px;
                    letter-spacing: 0.4px;
                    text-decoration: none;
                    text-transform: uppercase;
                    white-space: nowrap;
                    flex-shrink: 0;
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

                .qmi-checkbox-filter {
                    display: inline-flex;
                    align-items: center;
                    gap: 10px;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: 14px;
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

                .qmi-title-col { min-width: 0; }

                .qmi-title-col h1 {
                    margin: 0;
                    color: rgb(60, 60, 60);
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
                    grid-template-columns: 1fr 1fr;
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
                    font-weight: 300;
                    font-size: 13px;
                    color: var(--qmi-text-light);
                }

                .qmi-list-content { padding: 0; }

                .qmi-card-grid {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }

                .qmi-card {
                    display: grid;
                    grid-template-columns: 58.333% 41.667%;
                    border: 1px solid var(--qmi-border);
                    border-radius: 0;
                    padding: 8px;
                    background: var(--qmi-white);
                    transition: background-color 0.3s ease;
                    color: inherit;
                    container-type: inline-size;
                }

                .qmi-card:hover, .qmi-card.is-hovered {
                    background-color: rgba(60, 60, 60, 0.04);
                }

                .qmi-card-image {
                    position: relative;
                    overflow: hidden;
                    aspect-ratio: 4 / 3;
                }

                .qmi-card-image img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }

                .qmi-card-left {
                    display: flex;
                    flex-direction: column;
                }

                .qmi-banners-stack {
                    position: absolute;
                    top: 10px;
                    left: 0;
                    z-index: 2;
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    gap: 6px;
                    max-width: calc(100% - 90px);
                }

                .qmi-banner {
                    color: var(--qmi-white);
                    padding: 7px 18px 6px;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: clamp(0.55rem, 1.4vw, 0.78rem);
                    text-transform: uppercase;
                    letter-spacing: 0.3px;
                    line-height: 1.15;
                }

                .qmi-banner-rate { padding-right: 22px; }

                .qmi-banner-tan {
                    background-color: var(--qmi-tan-promo);
                    color: var(--qmi-black);
                    font-weight: 300;
                }
                .qmi-banner-availability { background-color: var(--qmi-gray-banner); color: var(--qmi-white); }

                .qmi-card-meta {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    background: var(--qmi-bg);
                    padding: 16px 18px 18px;
                    gap: 12px;
                    flex: 1;
                }

                .qmi-meta-col {
                    text-decoration: none;
                    color: inherit;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    border-left: 1px solid rgba(0,0,0,0.08);
                    padding-left: 12px;
                }

                .qmi-meta-col:first-child {
                    border-left: 0;
                    padding-left: 0;
                }

                .qmi-meta-label {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: 12px;
                    letter-spacing: 0.6px;
                    text-transform: uppercase;
                    color: var(--qmi-tan);
                    text-decoration: underline;
                    text-underline-offset: 3px;
                }

                .qmi-meta-value {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: 14px;
                    color: var(--qmi-text);
                    line-height: 1.3;
                }

                .qmi-meta-sub {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: 13px;
                    color: var(--qmi-tan);
                    line-height: 1.3;
                }

                .qmi-banner-lot {
                    position: absolute;
                    top: 10px;
                    right: 0;
                    color: var(--qmi-text);
                    padding: 6px 14px 5px;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: clamp(9px, 0.9cqw, 12px);
                    text-transform: uppercase;
                    letter-spacing: 0.3px;
                    z-index: 2;
                    background-color: var(--qmi-lot-badge);
                    border: 1px solid rgba(0,0,0,0.08);
                }

                .qmi-hover-overlay {
                    position: absolute;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.5);
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 12px;
                    opacity: 0;
                    transition: opacity 0.4s ease;
                    z-index: 1;
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
                    text-decoration: none;
                    min-width: 160px;
                }

                .qmi-hover-btn-tour {
                    background-color: var(--qmi-green-cta);
                    color: var(--qmi-text);
                }

                .qmi-card-body {
                    font-size: clamp(12px, 1.293cqw, 22px);
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                }

                .qmi-card-address {
                    font-family: var(--qmi-font-bodoni);
                    color: var(--qmi-text);
                    font-size: 2.41em;
                    line-height: 1.02;
                    margin-bottom: 0;
                    text-decoration: none;
                    transition: color 0.2s;
                }

                .qmi-card-address:hover { color: var(--qmi-green); }

                .qmi-card-location {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    color: var(--qmi-green);
                    font-size: 0.91em;
                    letter-spacing: 0.3px;
                    margin-top: 0.64em;
                    margin-bottom: 0.5em;
                }

                .qmi-card-price {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 600;
                    font-size: 2.045em;
                    color: var(--qmi-text);
                    line-height: 1.1;
                    margin-bottom: 0.5em;
                }

                .qmi-monthly-block {
                    margin-bottom: 14px;
                }

                .qmi-monthly-heading {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 400;
                    font-size: 12px;
                    color: var(--qmi-text);
                    text-transform: uppercase;
                    letter-spacing: 0.6px;
                    margin-bottom: 4px;
                }

                .qmi-monthly-prices {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 400;
                    font-size: 13px;
                    line-height: 1.4;
                    color: var(--qmi-text);
                }

                .qmi-monthly-label {
                    font-weight: 400;
                    text-transform: uppercase;
                    letter-spacing: 0.4px;
                    color: var(--qmi-text);
                }

                .qmi-monthly-current {
                    font-weight: 400;
                    color: var(--qmi-green);
                }

                .qmi-monthly-original {
                    color: #b94a3b;
                    text-decoration: line-through;
                    font-weight: 400;
                }

                .qmi-monthly-savings {
                    margin-top: 2px;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 400;
                    font-size: 13px;
                    color: var(--qmi-green);
                    line-height: 1.4;
                }

                .qmi-specs {
                    display: flex;
                    flex-direction: column;
                    flex: 0 0 58%;
                    gap: 0;
                    margin-top: auto;
                    margin-bottom: 0.5em;
                }

                .qmi-spec-item {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: 1em;
                    color: #000;
                    line-height: 1;
                    letter-spacing: 0.4px;
                    text-transform: uppercase;
                    display: flex;
                    align-items: center;
                    gap: 0.82em;
                    padding: 0.5em 0;
                }

                .qmi-spec-item strong {
                    font-weight: 700;
                }

                .qmi-spec-icon {
                    width: 1.15em;
                    height: 1.15em;
                    flex-shrink: 0;
                }

                .qmi-card-links {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                    margin-bottom: 10px;
                }

                .qmi-link {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: 12px;
                    color: var(--qmi-green);
                    text-decoration: none;
                    transition: color 0.2s;
                }

                .qmi-link:hover {
                    color: var(--qmi-dark-green);
                    text-decoration: underline;
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

                .qmi-map { width: 100%; height: 100%; }

                .qmi-map .leaflet-tile-pane { filter: var(--qmi-map-tile-filter); }

                .qmi-map-placeholder {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: var(--qmi-green-light);
                    color: #999;
                    font: 300 14px var(--qmi-font-overpass);
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
                    font: 300 14px var(--qmi-font-overpass);
                }

                /* Self-touring available — black banner, bottom-left of the image */
                .qmi-banner-tour {
                    position: absolute;
                    bottom: 10px;
                    left: 0;
                    top: auto;
                    right: auto;
                    z-index: 2;
                    color: var(--qmi-white);
                    background-color: var(--qmi-black);
                    padding: 7px 18px 6px;
                    font-family: var(--qmi-font-overpass);
                    font-weight: 300;
                    font-size: clamp(9px, 0.9cqw, 12px);
                    text-transform: uppercase;
                    letter-spacing: 0.3px;
                }

                .qmi-mobile-bottom-bar { display: none; }

                .leaflet-popup-content-wrapper {
                    padding: 0 !important;
                    border-radius: 4px !important;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.15) !important;
                    overflow: hidden;
                }

                .leaflet-popup-content {
                    margin: 0 !important;
                    width: 280px !important;
                }

                .leaflet-popup-tip { background: var(--qmi-white) !important; }

                .qmi-pin-wrap { background: transparent !important; border: none !important; }

                .qmi-pin-teardrop {
                    display: block;
                    pointer-events: none;
                }

                .qmi-pin {
                    width: 26px;
                    height: 26px;
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
                .qmi-pin-dot {
                    width: 8px;
                    height: 8px;
                    background: #fff;
                    border-radius: 50%;
                    pointer-events: none;
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
                    width: 280px;
                    background: var(--qmi-white);
                    text-decoration: none;
                    color: inherit;
                    cursor: pointer;
                }
                .qmi-popup:hover .qmi-popup-title { color: var(--qmi-green); }

                .qmi-popup-img {
                    width: 100%;
                    height: 140px;
                    object-fit: cover;
                    display: block;
                }

                .qmi-popup-body { padding: 12px 14px; }

                .qmi-popup-title {
                    font-family: var(--qmi-font-bodoni);
                    font-size: 16px;
                    color: var(--qmi-text);
                    line-height: 1.25;
                    margin-bottom: 2px;
                }

                .qmi-popup-location {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    color: var(--qmi-tan);
                    font-size: 13px;
                    margin-bottom: 4px;
                }

                .qmi-popup-price {
                    font-family: var(--qmi-font-overpass);
                    font-weight: 700;
                    font-size: 18px;
                    color: var(--qmi-dark-green);
                    margin-bottom: 4px;
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

                .leaflet-container { font-family: var(--qmi-font-overpass) !important; }

                @media (max-width: 1199px) {
                    .qmi-filter-top { grid-template-columns: 45% 55%; }

                    .qmi-tab {
                        min-width: 0;
                        padding: 0 16px;
                        font-size: 12px;
                    }

                    .qmi-primary-filters {
                        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) 64px;
                        gap: 10px;
                    }

                    .qmi-filter-toggle-block {
                        width: 64px;
                        min-height: 64px;
                    }

                    .qmi-filter-row {
                        gap: 10px 12px;
                        padding: 8px 16px;
                    }

                    .qmi-filter-download-row {
                        padding: 8px 16px 14px;
                    }

                    .qmi-download {
                        padding: 0 18px;
                        font-size: 12px;
                    }

                    .qmi-visit-box {
                        gap: 10px;
                        padding: 8px 8px 8px 16px;
                    }

                    .qmi-visit-box span { font-size: 12px; }

                    .qmi-title-col h1 { font-size: 32px; }
                }

                @media (max-width: 991px) {
                    .qmi-filter-top { grid-template-columns: 1fr; }

                    .qmi-tabs {
                        justify-content: flex-start;
                        margin: 12px 16px 4px;
                    }

                    .qmi-primary-filters {
                        grid-template-columns: 1fr 1fr 1fr 1fr 56px;
                        padding: 0 16px 12px;
                        gap: 10px;
                    }

                    .qmi-filter-toggle-block {
                        width: 56px;
                        min-height: 56px;
                    }

                    .qmi-filter-row {
                        grid-template-columns: 1fr 1fr;
                        padding: 10px 16px;
                        gap: 10px;
                    }

                    .qmi-filter-download-row {
                        padding: 8px 16px 14px;
                    }

                    .qmi-download {
                        width: 100%;
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

                    .qmi-split-view {
                        grid-template-columns: 1fr;
                        height: auto;
                    }

                    .qmi-list-panel { max-height: none; }

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

                    .qmi-card-body { padding: 14px 6px 14px 6px; }

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
                    .qmi-filter-row,
                    .qmi-filter-download-row { display: none; }

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

                    .qmi-mobile-filters-inner .qmi-checkbox-cell {
                        grid-column: span 1;
                    }

                    .qmi-title-row {
                        grid-template-columns: 1fr;
                        gap: 10px;
                        padding: 12px 16px;
                    }

                    .qmi-title-col h1 {
                        font-size: 26px;
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

                    .qmi-card-body { padding: 14px 16px 16px; }

                    .qmi-banner,
                    .qmi-banner-lot {
                        padding: 4px 12px 2px;
                        font-size: 0.65rem !important;
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

addPropertyControls(QuickMoveIns, {
    cacheWorkerUrl: {
        type: ControlType.String,
        title: "QMI API URL",
        defaultValue: "https://esperanza-api.round-base-ed8c.workers.dev/api/public/qmi",
        description: "Live D1 QMI endpoint returning {homes: [{id, fields: {...}}]} (source of truth — replaces the legacy Airtable cache worker).",
    },
    mapCenterLat: { type: ControlType.Number, title: "Map · Center Lat", defaultValue: 26.19, min: 24, max: 30, step: 0.01, displayStepper: true },
    mapCenterLng: { type: ControlType.Number, title: "Map · Center Lng", defaultValue: -98.23, min: -100, max: -96, step: 0.01, displayStepper: true },
    defaultZoom: { type: ControlType.Number, title: "Map · Default Zoom", defaultValue: 8, min: 3, max: 16, step: 0.5, displayStepper: true },
    mapMinZoom: { type: ControlType.Number, title: "Map · Min Zoom", defaultValue: 3, min: 1, max: 12, step: 1, displayStepper: true },
    mapMaxZoom: { type: ControlType.Number, title: "Map · Max Zoom", defaultValue: 16, min: 8, max: 20, step: 1, displayStepper: true },
    autoFitBounds: { type: ControlType.Boolean, title: "Map · Auto Fit Bounds", defaultValue: true },
    fitBoundsMaxZoom: { type: ControlType.Number, title: "Map · Fit Max Zoom", defaultValue: 11, min: 5, max: 16, step: 1, displayStepper: true, hidden: (props: QuickMoveInsProps) => !props.autoFitBounds },
    fitBoundsPadding: { type: ControlType.Number, title: "Map · Fit Padding", defaultValue: 40, min: 0, max: 120, step: 4, displayStepper: true, unit: "px", hidden: (props: QuickMoveInsProps) => !props.autoFitBounds },
    scrollWheelZoom: { type: ControlType.Boolean, title: "Map · Scroll Zoom", defaultValue: true },
    zoomControlPosition: { type: ControlType.Enum, title: "Map · Zoom Position", options: ["topleft", "topright", "bottomleft", "bottomright"], optionTitles: ["Top Left", "Top Right", "Bottom Left", "Bottom Right"], defaultValue: "topleft" },
    mapTilePreset: { type: ControlType.Enum, title: "Map · Tile Style", options: ["positron", "positron-nolabels", "voyager", "voyager-nolabels", "custom"], optionTitles: ["Positron (light)", "Positron (no labels)", "Voyager (warm roads)", "Voyager (no labels)", "Custom URL"], defaultValue: "positron" },
    mapTileWarmth: { type: ControlType.Number, title: "Map · Tile Warmth", defaultValue: 0, min: 0, max: 100, step: 5, displayStepper: true },
    mapPanelBg: { type: ControlType.Color, title: "Map · Panel Background", defaultValue: "#e9edea" },
    maxClusterRadius: { type: ControlType.Number, title: "Map · Cluster Radius", defaultValue: 50, min: 20, max: 120, step: 5, displayStepper: true, unit: "px" },
    clusterSizeSmall: { type: ControlType.Number, title: "Map · Cluster Size (<10)", defaultValue: 36, min: 16, max: 64, step: 2, displayStepper: true, unit: "px" },
    clusterSizeMedium: { type: ControlType.Number, title: "Map · Cluster Size (<20)", defaultValue: 42, min: 16, max: 64, step: 2, displayStepper: true, unit: "px" },
    clusterSizeLarge: { type: ControlType.Number, title: "Map · Cluster Size (20+)", defaultValue: 48, min: 16, max: 64, step: 2, displayStepper: true, unit: "px" },
    pinWidth: { type: ControlType.Number, title: "Map · Pin Width", defaultValue: 20, min: 12, max: 40, step: 1, displayStepper: true, unit: "px" },
    pinHeight: { type: ControlType.Number, title: "Map · Pin Height", defaultValue: 32, min: 16, max: 56, step: 1, displayStepper: true, unit: "px" },
    popupMinWidth: { type: ControlType.Number, title: "Map · Popup Width", defaultValue: 280, min: 200, max: 400, step: 10, displayStepper: true, unit: "px" },
    popupMaxWidth: { type: ControlType.Number, title: "Map · Popup Max Width", defaultValue: 320, min: 200, max: 480, step: 10, displayStepper: true, unit: "px" },
    popupOffsetY: { type: ControlType.Number, title: "Map · Popup Offset Y", defaultValue: -32, min: -80, max: 0, step: 2, displayStepper: true, unit: "px" },
    tileUrl: {
        type: ControlType.String,
        title: "Map · Tile URL",
        defaultValue:
            "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        description:
            "Leaflet raster tile template. Default is CARTO Positron (same look as openmaptiles/positron-gl-style)",
    },
    tileAttribution: {
        type: ControlType.String,
        title: "Map · Tile Attribution",
        defaultValue:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
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
        defaultValue: "/new-homes/available/pdf",
        description:
            "Fallback static URL (used when Filtered PDF Base URL is empty)",
    },
    filteredPdfBaseUrl: {
        type: ControlType.String,
        title: "QMI List PDF Base URL",
        defaultValue: "https://esperanza-pdf.round-base-ed8c.workers.dev",
        description:
            "PDF worker origin. The download button links to /pdf/list/quick-move-in-homes (master), or /pdf/list/<city>-qmis when a single city is filtered.",
    },
    ctaUrl: {
        type: ControlType.String,
        title: "CTA URL",
        defaultValue: "/contact",
        description: "Destination for the global 'Request Your Time' / questions CTAs. Per-home self-tour buttons use the home's own NterNow link when available.",
    },
    showResultCount: {
        type: ControlType.Boolean,
        title: "Show Result Count",
        defaultValue: false,
        description:
            "Internal: shows 'Showing N homes' above the list. Off in production.",
    },
    standardRatePct: {
        type: ControlType.Number,
        title: "Rate · Standard %",
        defaultValue: 6.15,
        min: 0,
        max: 15,
        step: 0.01,
        displayStepper: true,
        unit: "%",
        description:
            "Market rate (struck-through monthly). Overridden by mortgage_rate from Rates Settings URL if set.",
    },
    incentiveRatePct: {
        type: ControlType.Number,
        title: "Rate · Incentive %",
        defaultValue: 4.99,
        min: 0,
        max: 15,
        step: 0.01,
        displayStepper: true,
        unit: "%",
        description:
            "Promo rate (green monthly + savings). Overridden by incentive_rate from Rates Settings URL if set.",
    },
    ratesSettingsUrl: {
        type: ControlType.String,
        title: "Rates Settings URL",
        defaultValue: "",
        description:
            "Optional: /api/public/settings endpoint. When set, mortgage_rate + incentive_rate drive the card payments so marketing can adjust them in admin.",
    },
    incentiveBadgeFont: cardFontControl("Card · Incentive Badge"),
    availabilityFont: cardFontControl("Card · Availability"),
    lotFont: cardFontControl("Card · Lot #"),
    metaLabelFont: cardFontControl("Card · Meta Label"),
    metaValueFont: cardFontControl("Card · Meta Value"),
    titleFont: cardFontControl("Card · Address"),
    locationFont: cardFontControl("Card · City/State"),
    priceFont: cardFontControl("Card · Price"),
    monthlyFont: cardFontControl("Card · Monthly Estimate"),
    specFont: cardFontControl("Card · Specs"),
    tourBannerFont: cardFontControl("Card · Self-Tour"),
    buttonFont: cardFontControl("Card · Hover Buttons"),
})
