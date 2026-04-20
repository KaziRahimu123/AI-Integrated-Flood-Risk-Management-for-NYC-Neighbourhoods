import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as L from "leaflet";
import proj4 from "proj4";
import type { LatLngBoundsExpression, LatLngExpression, Layer } from "leaflet";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import * as turf from "@turf/turf";
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

type PropertiesMap = Record<string, unknown>;

type RawTractFeature = Feature<Geometry | null, PropertiesMap>;
type RawTractCollection = FeatureCollection<Geometry | null, PropertiesMap>;

type TractFeature = Feature<Polygon | MultiPolygon, PropertiesMap>;
type TractCollection = FeatureCollection<Polygon | MultiPolygon, PropertiesMap>;

type SearchResult = {
  lat: string;
  lon: string;
  display_name?: string;
  boundingbox?: string[];
  importance?: number;
  type?: string;
  addresstype?: string;
  class?: string;
  category?: string;
  address?: Record<string, string | number | undefined>;
};

type RankedSearchResult = {
  lat: number;
  lng: number;
  label: string;
  score: number;
  bounds: LatLngBoundsExpression | null;
  area: number;
};

type SearchStatusKind = "idle" | "loading" | "success" | "error";

type SearchInfo = {
  query: string;
  label: string;
  boroughFilter: string;
};

type LocalAlias = {
  lat: number;
  lng: number;
  label: string;
  bounds?: LatLngBoundsExpression;
};

type ParsedStreetLike = {
  original: string;
  normalized: string;
  houseNumber: string | null;
  streetName: string;
  streetSuffix: string | null;
  normalizedStreet: string;
  tokens: string[];
};

type SearchIntent = {
  isAddress: boolean;
  isStreet: boolean;
  isAirport: boolean;
  isTransit: boolean;
  isBridge: boolean;
  isPark: boolean;
  isSchool: boolean;
  isHospital: boolean;
  isLandmark: boolean;
  isMuseum: boolean;
  isNature: boolean;
  isResearch: boolean;
};

type PhotonFeatureProperties = {
  name?: string;
  housenumber?: string;
  street?: string;
  city?: string;
  county?: string;
  state?: string;
  suburb?: string;
  district?: string;
  locality?: string;
  osm_key?: string;
  osm_value?: string;
  type?: string;
  extent?: number[];
};

type PhotonFeature = {
  geometry?: {
    coordinates?: unknown;
  };
  properties?: PhotonFeatureProperties;
};

type PhotonResponse = {
  features?: PhotonFeature[];
};

export type SelectedTract = {
  geoid: string;
  tractLabel: string;
  borough: string;
  neighborhood: string;
  riskScore: number;
  riskLevel: string;
  latitude: number;
  longitude: number;
  addressLabel: string;
};

type FloodRiskMapProps = {
  boroughFilter?: string;
  searchText?: string;
  searchRequestId?: number;
  viewResetKey?: number;
  reloadKey?: number;
  onStatsChange?: (stats: {
    highRiskCount: number;
    visibleCount: number;
    topBorough: string;
    topBoroughScore: number;
  }) => void;
  onTractSelect?: (tract: SelectedTract | null) => void;
};

const NYC_CENTER: LatLngExpression = [40.7128, -74.006];
const DEFAULT_ZOOM = 11;

const NYC_BOUNDS = {
  south: 40.4774,
  west: -74.2591,
  north: 40.9176,
  east: -73.7002,
};

const NYC_VIEWBOX = `${NYC_BOUNDS.west},${NYC_BOUNDS.north},${NYC_BOUNDS.east},${NYC_BOUNDS.south}`;
const NYC_LATLNG_BOUNDS: LatLngBoundsExpression = [
  [NYC_BOUNDS.south, NYC_BOUNDS.west],
  [NYC_BOUNDS.north, NYC_BOUNDS.east],
];

const MIN_ACCEPTABLE_SEARCH_SCORE = 340;

const DATA_URL_CANDIDATES = [
  "/data/nyc-tracts-fema-baseline-fixed.geojson",
  "/data/nyc-tracts-fema-baseline.geojson",
];

const BOROUGH_KEYS = [
  "manhattan",
  "brooklyn",
  "queens",
  "bronx",
  "staten island",
] as const;

const KNOWN_BOROUGHS = new Set(BOROUGH_KEYS);

const BOROUGH_QUERY_SUFFIX: Record<string, string> = {
  brooklyn: "Brooklyn, New York City, NY",
  queens: "Queens, New York City, NY",
  manhattan: "Manhattan, New York City, NY",
  bronx: "Bronx, New York City, NY",
  "staten island": "Staten Island, New York City, NY",
};

const BOROUGH_CITY_HINTS: Record<string, string> = {
  brooklyn: "Brooklyn",
  queens: "Queens",
  manhattan: "Manhattan",
  bronx: "Bronx",
  "staten island": "Staten Island",
};

const BOROUGH_CENTERS: Record<string, [number, number]> = {
  brooklyn: [40.6501, -73.9496],
  queens: [40.7282, -73.7949],
  manhattan: [40.7831, -73.9712],
  bronx: [40.8448, -73.8648],
  "staten island": [40.5795, -74.1502],
};

const BOROUGH_BOUNDS: Record<string, LatLngBoundsExpression> = {
  brooklyn: [
    [40.56, -74.05],
    [40.74, -73.83],
  ],
  queens: [
    [40.54, -73.96],
    [40.81, -73.70],
  ],
  manhattan: [
    [40.68, -74.03],
    [40.88, -73.90],
  ],
  bronx: [
    [40.78, -73.94],
    [40.92, -73.76],
  ],
  "staten island": [
    [40.48, -74.26],
    [40.65, -74.05],
  ],
};

const LOCAL_SEARCH_ALIASES: Record<string, LocalAlias> = {
  jfk: {
    lat: 40.64131,
    lng: -73.77814,
    label:
      "John F. Kennedy International Airport, Queens, New York City, NY, USA",
  },
  "jfk airport": {
    lat: 40.64131,
    lng: -73.77814,
    label:
      "John F. Kennedy International Airport, Queens, New York City, NY, USA",
  },
  "john f kennedy airport": {
    lat: 40.64131,
    lng: -73.77814,
    label:
      "John F. Kennedy International Airport, Queens, New York City, NY, USA",
  },
  "john f kennedy international airport": {
    lat: 40.64131,
    lng: -73.77814,
    label:
      "John F. Kennedy International Airport, Queens, New York City, NY, USA",
  },
  "kennedy airport": {
    lat: 40.64131,
    lng: -73.77814,
    label:
      "John F. Kennedy International Airport, Queens, New York City, NY, USA",
  },
  lga: {
    lat: 40.77693,
    lng: -73.87615,
    label: "LaGuardia Airport, Queens, New York City, NY, USA",
  },
  laguardia: {
    lat: 40.77693,
    lng: -73.87615,
    label: "LaGuardia Airport, Queens, New York City, NY, USA",
  },
  "laguardia airport": {
    lat: 40.77693,
    lng: -73.87615,
    label: "LaGuardia Airport, Queens, New York City, NY, USA",
  },
  "brooklyn bridge": {
    lat: 40.70609,
    lng: -73.99686,
    label: "Brooklyn Bridge, New York City, NY, USA",
  },
  "brooklyn museum": {
    lat: 40.671206,
    lng: -73.963631,
    label: "Brooklyn Museum, Brooklyn, New York City, NY, USA",
  },
  "jamaica bay wildlife": {
    lat: 40.6156,
    lng: -73.8253,
    label: "Jamaica Bay Wildlife Refuge, Queens, New York City, NY, USA",
  },
  "jamaica bay wildlife refuge": {
    lat: 40.6156,
    lng: -73.8253,
    label: "Jamaica Bay Wildlife Refuge, Queens, New York City, NY, USA",
  },
  "jamaica bay refuge": {
    lat: 40.6156,
    lng: -73.8253,
    label: "Jamaica Bay Wildlife Refuge, Queens, New York City, NY, USA",
  },
  "advanced science research center": {
    lat: 40.821,
    lng: -73.949,
    label:
      "CUNY Advanced Science Research Center, Manhattan, New York City, NY, USA",
  },
  "cuny advanced science research center": {
    lat: 40.821,
    lng: -73.949,
    label:
      "CUNY Advanced Science Research Center, Manhattan, New York City, NY, USA",
  },
  "asrc cuny": {
    lat: 40.821,
    lng: -73.949,
    label:
      "CUNY Advanced Science Research Center, Manhattan, New York City, NY, USA",
  },
  "jay street": {
    lat: 40.70138,
    lng: -73.98662,
    label:
      "Jay Street, Dumbo, Brooklyn, Kings County, New York, 11201, United States",
  },
  "jay st": {
    lat: 40.70138,
    lng: -73.98662,
    label:
      "Jay Street, Dumbo, Brooklyn, Kings County, New York, 11201, United States",
  },
  "jay street metrotech": {
    lat: 40.69218,
    lng: -73.98743,
    label:
      "Jay St-MetroTech, Downtown Brooklyn, Brooklyn, New York, United States",
  },
  "jay st metrotech": {
    lat: 40.69218,
    lng: -73.98743,
    label:
      "Jay St-MetroTech, Downtown Brooklyn, Brooklyn, New York, United States",
  },
  "canal street": {
    lat: 40.71902,
    lng: -74.00068,
    label: "Canal Street, Manhattan, New York City, NY, USA",
  },
  "canal st": {
    lat: 40.71902,
    lng: -74.00068,
    label: "Canal Street, Manhattan, New York City, NY, USA",
  },
  "cross bay": {
    lat: 40.60379,
    lng: -73.82011,
    label: "Cross Bay Boulevard, Queens, New York City, NY, USA",
  },
  "cross bay boulevard": {
    lat: 40.60379,
    lng: -73.82011,
    label: "Cross Bay Boulevard, Queens, New York City, NY, USA",
  },
  "church avenue": {
    lat: 40.65091,
    lng: -73.96279,
    label: "Church Avenue, Brooklyn, New York City, NY, USA",
  },
  "church ave": {
    lat: 40.65091,
    lng: -73.96279,
    label: "Church Avenue, Brooklyn, New York City, NY, USA",
  },
};

const STREET_SUFFIX_MAP: Record<string, string> = {
  street: "st",
  st: "st",
  avenue: "ave",
  ave: "ave",
  road: "rd",
  rd: "rd",
  place: "pl",
  pl: "pl",
  boulevard: "blvd",
  blvd: "blvd",
  drive: "dr",
  dr: "dr",
  lane: "ln",
  ln: "ln",
  court: "ct",
  ct: "ct",
  terrace: "ter",
  ter: "ter",
  parkway: "pkwy",
  pkwy: "pkwy",
  highway: "hwy",
  hwy: "hwy",
};

const EPSG2263 =
  "+proj=lcc +lat_1=41.03333333333333 +lat_2=40.66666666666666 +lat_0=40.16666666666666 " +
  "+lon_0=-74 +x_0=300000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs";

function isPolygonFeature(feature: RawTractFeature): feature is TractFeature {
  return (
    !!feature &&
    !!feature.geometry &&
    (feature.geometry.type === "Polygon" ||
      feature.geometry.type === "MultiPolygon")
  );
}

function readString(
  properties: PropertiesMap | undefined,
  keys: string[],
  fallback = "Unknown",
): string {
  if (!properties) return fallback;

  for (const key of keys) {
    const value = properties[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number") {
      return String(value);
    }
  }

  return fallback;
}

function readOptionalNumber(
  properties: PropertiesMap | undefined,
  keys: string[],
): number | null {
  if (!properties) return null;

  for (const key of keys) {
    const value = properties[key];
    const num = Number(value);

    if (Number.isFinite(num)) {
      return num;
    }
  }

  return null;
}

function readNumber(
  properties: PropertiesMap | undefined,
  keys: string[],
  fallback = 0,
): number {
  return readOptionalNumber(properties, keys) ?? fallback;
}

function normalizeText(value?: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeForMatch(value?: string): string {
  return normalizeText(value)
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\broad\b/g, "rd")
    .replace(/\bplace\b/g, "pl")
    .replace(/\bsaint\b/g, "st")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchQuery(rawValue?: string): string {
  return String(rawValue ?? "")
    .trim()
    .replace(/\bcrossbay\b/gi, "cross bay")
    .replace(/\bjfk\b/gi, "John F Kennedy International Airport")
    .replace(
      /\bjohn\s+f\.?\s+kennedy\s+(?:international\s+)?airport\b/gi,
      "John F Kennedy International Airport",
    )
    .replace(/\bkennedy airport\b/gi, "John F Kennedy International Airport")
    .replace(/\blga\b/gi, "LaGuardia Airport")
    .replace(/\bnyc\b/gi, "New York City")
    .replace(/\s+/g, " ")
    .trim();
}

function hasExplicitLocationContext(value?: string): boolean {
  return /\b(new york|new york city|nyc|brooklyn|queens|bronx|manhattan|staten island|ny)\b/i.test(
    String(value ?? ""),
  );
}

function collectSearchResultText(result: SearchResult): string {
  const addressText = result.address
    ? Object.values(result.address)
        .filter((value) => value !== undefined && value !== null)
        .join(" ")
    : "";

  return normalizeForMatch(
    `${String(result.display_name ?? "")} ${String(addressText)}`,
  );
}

function parseStreetLike(value?: string): ParsedStreetLike {
  const original = String(value ?? "").trim();
  const normalized = normalizeForMatch(original);
  let tokens = normalized.split(" ").filter(Boolean);

  let houseNumber: string | null = null;
  if (tokens[0] && /^\d+[a-z0-9-]*$/.test(tokens[0])) {
    houseNumber = tokens[0];
    tokens = tokens.slice(1);
  }

  let streetSuffix: string | null = null;
  if (tokens.length > 0) {
    const lastToken = tokens[tokens.length - 1];
    if (STREET_SUFFIX_MAP[lastToken]) {
      streetSuffix = STREET_SUFFIX_MAP[lastToken];
      tokens = [...tokens.slice(0, -1), STREET_SUFFIX_MAP[lastToken]];
    }
  }

  const streetName =
    streetSuffix && tokens.length > 1
      ? tokens.slice(0, -1).join(" ")
      : streetSuffix
        ? ""
        : tokens.join(" ");

  return {
    original,
    normalized,
    houseNumber,
    streetName,
    streetSuffix,
    normalizedStreet: tokens.join(" "),
    tokens,
  };
}

function analyzeSearchIntent(rawQuery: string): SearchIntent {
  const query = normalizeForMatch(rawQuery);
  const parsed = parseStreetLike(rawQuery);
  const isAddress = Boolean(parsed.houseNumber);
  const isStreet = Boolean(parsed.streetSuffix);

  return {
    isAddress,
    isStreet,
    isAirport: /\b(airport|airtrain|terminal|jfk|laguardia|lga)\b/.test(query),
    isTransit: /\b(subway|station|train|metro|bus|terminal)\b/.test(query),
    isBridge: /\bbridge\b/.test(query),
    isPark: /\bpark|garden|playground\b/.test(query),
    isSchool: /\b(school|college|university|campus|cuny)\b/.test(query),
    isHospital: /\b(hospital|medical|clinic|health center)\b/.test(query),
    isMuseum: /\b(museum|gallery|arts?)\b/.test(query),
    isNature: /\b(refuge|wildlife|bay|marsh|nature|beach)\b/.test(query),
    isResearch:
      /\b(research|science|laboratory|lab|institute|center|centre)\b/.test(
        query,
      ),
    isLandmark:
      !isAddress &&
      !isStreet &&
      !/\b(st|ave|rd|pl|blvd|dr|ln|ct|ter|pkwy|hwy)\b/.test(query),
  };
}

function looksLikeRoadOrAddress(value?: string): boolean {
  const parsed = parseStreetLike(value);
  return Boolean(parsed.houseNumber || parsed.streetSuffix);
}

function isWithinNycBounds(lat: number, lng: number): boolean {
  return lat >= 40.48 && lat <= 40.93 && lng >= -74.30 && lng <= -73.65;
}

function clampBoundsToNyc(
  bounds: LatLngBoundsExpression | null,
): LatLngBoundsExpression | null {
  if (!bounds) return null;

  const castBounds = bounds as [[number, number], [number, number]];
  const south = Math.max(castBounds[0][0], NYC_BOUNDS.south);
  const west = Math.max(castBounds[0][1], NYC_BOUNDS.west);
  const north = Math.min(castBounds[1][0], NYC_BOUNDS.north);
  const east = Math.min(castBounds[1][1], NYC_BOUNDS.east);

  if (
    !Number.isFinite(south) ||
    !Number.isFinite(west) ||
    !Number.isFinite(north) ||
    !Number.isFinite(east)
  ) {
    return null;
  }

  if (south >= north || west >= east) {
    return null;
  }

  return [
    [south, west],
    [north, east],
  ];
}

function shouldFitSearchBounds(bounds: LatLngBoundsExpression | null): boolean {
  const clamped = clampBoundsToNyc(bounds);
  if (!clamped) return false;

  const area = getBoundsArea(clamped);
  return area > 0.00002 && area < 0.08;
}

function isSearchMatchAcceptable(
  result: RankedSearchResult | undefined,
  rawQuery: string,
): boolean {
  if (!result) return false;

  const normalizedQuery = normalizeForMatch(normalizeSearchQuery(rawQuery));
  const label = normalizeForMatch(result.label);
  const tokens = normalizedQuery.split(" ").filter((token) => token.length > 1);
  const parsed = parseStreetLike(normalizedQuery);

  const matchedTokens = tokens.filter((token) => label.includes(token)).length;

  if (tokens.length >= 2 && matchedTokens === 0) return false;
  if (tokens.length >= 3 && matchedTokens < 2) return false;
  if (parsed.houseNumber && matchedTokens < 2) return false;

  return result.score >= MIN_ACCEPTABLE_SEARCH_SCORE;
}

function getBorough(feature: TractFeature): string {
  return readString(feature.properties, [
    "boroname",
    "boro_name",
    "borough",
    "BOROUGH",
    "boro",
    "BoroName",
  ]);
}

function getNeighborhood(feature: TractFeature): string {
  return readString(feature.properties, [
    "ntaname",
    "NTAName",
    "cdtaname",
    "neighborhood",
    "NEIGHBORHOOD",
    "area_name",
    "name",
    "NAME",
  ]);
}

function getGeoid(feature: TractFeature): string {
  return readString(feature.properties, [
    "geoid",
    "GEOID",
    "geoidfips",
    "GEOIDFIPS",
    "tract_id",
    "TRACTID",
    "OBJECTID",
    "ct2020",
    "tract",
    "TRACTCE",
    "tractce",
  ]);
}

function getTractLabel(feature: TractFeature): string {
  return readString(
    feature.properties,
    [
      "ctlabel",
      "CTLABEL",
      "tract_label",
      "label",
      "ct2020",
      "TRACT_LABEL",
      "NAME",
      "name",
      "tract",
      "TRACTCE",
      "tractce",
    ],
    getGeoid(feature),
  );
}

function getRiskScore(feature: TractFeature): number {
  return readNumber(feature.properties, [
    "baseline_risk_score",
    "BASELINE_RISK_SCORE",
    "risk_score",
    "RISK_SCORE",
    "baseline_score",
    "BASELINE_SCORE",
    "baseline_risk",
    "BASELINE_RISK",
    "score",
    "SCORE",
  ]);
}

function getRiskLevel(feature: TractFeature): "Low" | "Medium" | "High" {
  const rawLabel = readString(
    feature.properties,
    [
      "baseline_risk_label",
      "BASELINE_RISK_LABEL",
      "risk_label",
      "RISK_LABEL",
    ],
    "",
  );

  const normalizedLabel = normalizeText(rawLabel);

  if (normalizedLabel === "high") return "High";
  if (normalizedLabel === "medium") return "Medium";
  if (normalizedLabel === "low") return "Low";

  const score = getRiskScore(feature);

  if (score >= 85) return "High";
  if (score >= 45) return "Medium";
  return "Low";
}

function getRiskColor(feature: TractFeature): string {
  const level = getRiskLevel(feature);

  if (level === "High") return "#ef4444";
  if (level === "Medium") return "#f59e0b";
  return "#22c55e";
}

function getRiskBorderColor(feature: TractFeature): string {
  const level = getRiskLevel(feature);

  if (level === "High") return "#b91c1c";
  if (level === "Medium") return "#b45309";
  return "#15803d";
}

function matchesBorough(feature: TractFeature, boroughFilter?: string): boolean {
  const normalizedFilter = normalizeText(boroughFilter);

  if (
    normalizedFilter === "" ||
    normalizedFilter === "all boroughs" ||
    normalizedFilter === "all borough" ||
    normalizedFilter === "all"
  ) {
    return true;
  }

  if (!KNOWN_BOROUGHS.has(normalizedFilter as (typeof BOROUGH_KEYS)[number])) {
    return true;
  }

  return normalizeText(getBorough(feature)) === normalizedFilter;
}

function buildSelectedTract(
  feature: TractFeature | null,
  lat: number,
  lng: number,
  addressLabel: string,
): SelectedTract | null {
  if (!feature) return null;

  return {
    geoid: getGeoid(feature),
    tractLabel: `Tract ${getTractLabel(feature)}`,
    borough: getBorough(feature),
    neighborhood: getNeighborhood(feature),
    riskScore: getRiskScore(feature),
    riskLevel: getRiskLevel(feature),
    latitude: lat,
    longitude: lng,
    addressLabel,
  };
}

function findContainingFeature(
  features: TractFeature[],
  lat: number,
  lng: number,
): TractFeature | null {
  const point = turf.point([lng, lat]);

  for (const feature of features) {
    try {
      if (turf.booleanPointInPolygon(point, feature)) {
        return feature;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function looksLikeProjected2263(position: Position): boolean {
  const [x, y] = position;

  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Math.abs(x) > 1000 &&
    Math.abs(y) > 1000
  );
}

function reprojectPosition2263To4326(position: Position): Position {
  const [x, y, ...rest] = position;
  const [lng, lat] = proj4(EPSG2263, "EPSG:4326", [x, y]);
  return [lng, lat, ...rest];
}

function reprojectPolygonOrMultiPolygonIfNeeded(
  geometry: Polygon | MultiPolygon,
): Polygon | MultiPolygon {
  if (geometry.type === "Polygon") {
    const first = geometry.coordinates[0]?.[0];
    if (!first || !looksLikeProjected2263(first)) return geometry;

    return {
      ...geometry,
      coordinates: geometry.coordinates.map((ring) =>
        ring.map((position) => reprojectPosition2263To4326(position)),
      ),
    };
  }

  const first = geometry.coordinates[0]?.[0]?.[0];
  if (!first || !looksLikeProjected2263(first)) return geometry;

  return {
    ...geometry,
    coordinates: geometry.coordinates.map((polygon) =>
      polygon.map((ring) =>
        ring.map((position) => reprojectPosition2263To4326(position)),
      ),
    ),
  };
}

async function fetchJsonWithTimeout<T>(
  url: string,
  externalSignal?: AbortSignal,
  timeoutMs = 5000,
): Promise<T> {
  const controller = new AbortController();
  const relayAbort = () => controller.abort();

  if (externalSignal) {
    externalSignal.addEventListener("abort", relayAbort);
  }

  const timer = window.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", relayAbort);
    }
  }
}

function getBoundsFromBoundingBox(
  boundingbox?: string[],
): LatLngBoundsExpression | null {
  if (!Array.isArray(boundingbox) || boundingbox.length < 4) return null;

  const south = Number(boundingbox[0]);
  const north = Number(boundingbox[1]);
  const west = Number(boundingbox[2]);
  const east = Number(boundingbox[3]);

  if (
    !Number.isFinite(south) ||
    !Number.isFinite(north) ||
    !Number.isFinite(west) ||
    !Number.isFinite(east)
  ) {
    return null;
  }

  return [
    [south, west],
    [north, east],
  ];
}

function getBoundsArea(bounds: LatLngBoundsExpression | null): number {
  if (!bounds) return Number.POSITIVE_INFINITY;

  const castBounds = bounds as [[number, number], [number, number]];
  const south = castBounds[0][0];
  const west = castBounds[0][1];
  const north = castBounds[1][0];
  const east = castBounds[1][1];

  return Math.abs((north - south) * (east - west));
}

function parseCoordinateQuery(query: string): [number, number] | null {
  const match = query.match(
    /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/,
  );

  if (!match) return null;

  const lat = Number(match[1]);
  const lng = Number(match[2]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!isWithinNycBounds(lat, lng)) return null;

  return [lat, lng];
}

function getBoroughKeyFromQuery(query?: string): string | null {
  const normalized = normalizeForMatch(query);

  for (const borough of BOROUGH_KEYS) {
    if (
      normalized === borough ||
      normalized === `${borough} ny` ||
      normalized === `${borough} new york` ||
      normalized === `${borough} new york city`
    ) {
      return borough;
    }
  }

  return null;
}

function buildCandidateQueries(
  rawQuery: string,
  boroughFilter?: string,
): string[] {
  const normalizedQuery = normalizeSearchQuery(rawQuery);
  const normalizedRaw = normalizeForMatch(normalizedQuery);
  const normalizedBorough = normalizeText(boroughFilter);
  const intent = analyzeSearchIntent(normalizedQuery);
  const queries = new Set<string>();

  queries.add(normalizedQuery);

  if (
    normalizedBorough &&
    normalizedBorough !== "all boroughs" &&
    BOROUGH_QUERY_SUFFIX[normalizedBorough]
  ) {
    queries.add(`${normalizedQuery}, ${BOROUGH_QUERY_SUFFIX[normalizedBorough]}`);
  }

  if (!hasExplicitLocationContext(normalizedQuery)) {
    queries.add(`${normalizedQuery}, New York City`);
    queries.add(`${normalizedQuery}, NYC`);
  }

  if (
    intent.isLandmark ||
    intent.isMuseum ||
    intent.isNature ||
    intent.isResearch
  ) {
    queries.add(`${normalizedQuery}, New York`);
  }

  if (normalizedRaw.includes("jay street")) {
    queries.add("Jay St-MetroTech, Brooklyn");
  }

  if (normalizedRaw.includes("canal street")) {
    queries.add("Canal Street, Manhattan");
  }

  if (normalizedRaw.includes("cross bay")) {
    queries.add("Cross Bay Boulevard, Queens");
  }

  if (normalizedRaw.includes("church avenue")) {
    queries.add("Church Avenue, Brooklyn");
  }

  if (intent.isMuseum && !normalizedRaw.includes("museum")) {
    queries.add(`${normalizedQuery} museum, New York City`);
  }

  if (intent.isNature && !normalizedRaw.includes("refuge")) {
    queries.add(`${normalizedQuery} refuge, New York City`);
  }

  if (intent.isResearch && !normalizedRaw.includes("research")) {
    queries.add(`${normalizedQuery} research center, New York City`);
  }

  return Array.from(queries).filter(Boolean).slice(0, 5);
}

function getSearchBiasCenter(boroughFilter?: string): [number, number] {
  const normalizedBorough = normalizeText(boroughFilter);

  if (
    normalizedBorough &&
    normalizedBorough !== "all boroughs" &&
    normalizedBorough in BOROUGH_CENTERS
  ) {
    return BOROUGH_CENTERS[normalizedBorough];
  }

  return [40.7128, -74.006];
}

function buildPhotonLabel(properties: PhotonFeatureProperties | undefined): string {
  if (!properties) return "";

  const parts: string[] = [];
  const name = String(properties.name ?? "").trim();
  const house = String(properties.housenumber ?? "").trim();
  const street = String(properties.street ?? "").trim();
  const suburb = String(properties.suburb ?? properties.district ?? "").trim();
  const city = String(
    properties.city ?? properties.county ?? properties.locality ?? "",
  ).trim();
  const state = String(properties.state ?? "").trim();

  if (name) parts.push(name);

  const streetLine = [house, street].filter(Boolean).join(" ").trim();
  if (streetLine && streetLine.toLowerCase() !== name.toLowerCase()) {
    parts.push(streetLine);
  }

  if (suburb) parts.push(suburb);
  if (city) parts.push(city);
  if (state) parts.push(state);

  return parts.join(", ");
}

function photonExtentToBoundingBox(extent?: number[]): string[] | undefined {
  if (!Array.isArray(extent) || extent.length < 4) return undefined;

  const minLon = Number(extent[0]);
  const minLat = Number(extent[1]);
  const maxLon = Number(extent[2]);
  const maxLat = Number(extent[3]);

  if (
    !Number.isFinite(minLon) ||
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLon) ||
    !Number.isFinite(maxLat)
  ) {
    return undefined;
  }

  return [String(minLat), String(maxLat), String(minLon), String(maxLon)];
}

function convertPhotonToSearchResults(
  data: PhotonResponse,
  query: string,
): SearchResult[] {
  const features = Array.isArray(data.features) ? data.features : [];
  const results: SearchResult[] = [];

  for (const feature of features) {
    const coordinates = feature.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;

    const lng = Number(coordinates[0]);
    const lat = Number(coordinates[1]);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const properties = feature.properties;

    results.push({
      lat: String(lat),
      lon: String(lng),
      display_name: buildPhotonLabel(properties) || query,
      boundingbox: photonExtentToBoundingBox(properties?.extent),
      class: properties?.osm_key,
      category: properties?.osm_value,
      type: properties?.type,
      addresstype: properties?.type,
      importance: 0.55,
    });
  }

  return results;
}

async function searchNominatim(
  query: string,
  strictToNyc: boolean,
  externalSignal: AbortSignal,
): Promise<SearchResult[]> {
  try {
    const params = new URLSearchParams({
      format: "jsonv2",
      q: query,
      limit: "8",
      countrycodes: "us",
      addressdetails: "1",
      dedupe: "1",
      viewbox: NYC_VIEWBOX,
      "accept-language": "en",
    });

    if (strictToNyc) {
      params.set("bounded", "1");
    }

    const data = await fetchJsonWithTimeout<SearchResult[]>(
      `https://nominatim.openstreetmap.org/search?${params.toString()}`,
      externalSignal,
      3500,
    );

    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function searchPhoton(
  query: string,
  biasLat: number,
  biasLng: number,
  externalSignal: AbortSignal,
): Promise<SearchResult[]> {
  try {
    const params = new URLSearchParams({
      q: query,
      limit: "8",
      lat: String(biasLat),
      lon: String(biasLng),
    });

    const data = await fetchJsonWithTimeout<PhotonResponse>(
      `https://photon.komoot.io/api?${params.toString()}`,
      externalSignal,
      3500,
    );

    return convertPhotonToSearchResults(data, query);
  } catch {
    return [];
  }
}

function buildStructuredStreetQueries(rawQuery: string): string[] {
  const normalizedQuery = normalizeSearchQuery(rawQuery);
  const parsed = parseStreetLike(normalizedQuery);
  if (!looksLikeRoadOrAddress(normalizedQuery)) return [];

  const queries = new Set<string>();
  queries.add(parsed.original);

  if (parsed.houseNumber && parsed.streetName && parsed.streetSuffix) {
    queries.add(
      `${parsed.houseNumber} ${parsed.streetName} ${parsed.streetSuffix}`,
    );
  } else if (parsed.streetName && parsed.streetSuffix) {
    queries.add(`${parsed.streetName} ${parsed.streetSuffix}`);
  }

  return Array.from(queries);
}

function getBoroughHints(boroughFilter?: string): string[] {
  const normalizedBorough = normalizeText(boroughFilter);

  if (
    normalizedBorough &&
    normalizedBorough !== "all boroughs" &&
    BOROUGH_CITY_HINTS[normalizedBorough]
  ) {
    return [BOROUGH_CITY_HINTS[normalizedBorough]];
  }

  return ["Brooklyn", "Manhattan", "Queens", "Bronx", "Staten Island"];
}

async function searchStructuredNominatim(
  rawQuery: string,
  boroughFilter: string | undefined,
  externalSignal: AbortSignal,
): Promise<SearchResult[]> {
  const streetQueries = buildStructuredStreetQueries(rawQuery);
  if (streetQueries.length === 0) return [];

  const boroughHints = getBoroughHints(boroughFilter);
  const tasks: Promise<SearchResult[]>[] = [];

  for (const street of streetQueries.slice(0, 1)) {
    for (const city of boroughHints.slice(0, 2)) {
      const params = new URLSearchParams({
        format: "jsonv2",
        street,
        city,
        state: "New York",
        countrycodes: "us",
        addressdetails: "1",
        limit: "6",
        viewbox: NYC_VIEWBOX,
        bounded: "1",
      });

      tasks.push(
        fetchJsonWithTimeout<SearchResult[]>(
          `https://nominatim.openstreetmap.org/search?${params.toString()}`,
          externalSignal,
          3500,
        ).catch(() => []),
      );
    }
  }

  const settled = await Promise.allSettled(tasks);
  const merged: SearchResult[] = [];

  for (const item of settled) {
    if (item.status === "fulfilled") {
      merged.push(...item.value);
    }
  }

  return merged;
}

function dedupeSearchResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];

  for (const item of results) {
    const lat = Number(item.lat);
    const lng = Number(item.lon);
    const label = normalizeForMatch(item.display_name ?? "");
    const key = `${lat.toFixed(5)}|${lng.toFixed(5)}|${label}`;

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

async function searchOpenDataGeocoders(
  rawQuery: string,
  boroughFilter: string | undefined,
  externalSignal: AbortSignal,
): Promise<SearchResult[]> {
  const [biasLat, biasLng] = getSearchBiasCenter(boroughFilter);
  const queries = buildCandidateQueries(rawQuery, boroughFilter);
  const merged: SearchResult[] = [];

  const structuredResults = await searchStructuredNominatim(
    rawQuery,
    boroughFilter,
    externalSignal,
  );
  merged.push(...structuredResults);

  for (const query of queries.slice(0, 3)) {
    const photonResults = await searchPhoton(
      query,
      biasLat,
      biasLng,
      externalSignal,
    );
    merged.push(...photonResults);
    if (merged.length >= 10) break;
  }

  for (const query of queries.slice(0, 2)) {
    const strictResults = await searchNominatim(query, true, externalSignal);
    merged.push(...strictResults);
    if (merged.length >= 16) break;
  }

  if (merged.length < 8) {
    for (const query of queries.slice(0, 2)) {
      const looseResults = await searchNominatim(query, false, externalSignal);
      merged.push(...looseResults);
      if (merged.length >= 20) break;
    }
  }

  return dedupeSearchResults(merged);
}

async function reverseGeocode(
  lat: number,
  lng: number,
  externalSignal?: AbortSignal,
): Promise<string> {
  try {
    const data = await fetchJsonWithTimeout<{ display_name?: string }>(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      externalSignal,
      2500,
    );

    return data.display_name ?? "";
  } catch {
    return "";
  }
}

async function fetchFirstWorkingGeoJson(
  reloadKey: number,
): Promise<TractCollection> {
  const errors: string[] = [];

  for (const url of DATA_URL_CANDIDATES) {
    try {
      const response = await fetch(`${url}?reload=${reloadKey}&t=${Date.now()}`, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        errors.push(`${url} -> ${response.status}`);
        continue;
      }

      const text = await response.text();
      const trimmed = text.trim();

      if (!trimmed) {
        errors.push(`${url} -> empty file`);
        continue;
      }

      if (trimmed.startsWith("<")) {
        errors.push(`${url} -> returned HTML instead of JSON`);
        continue;
      }

      let raw: RawTractCollection;
      try {
        raw = JSON.parse(trimmed) as RawTractCollection;
      } catch {
        errors.push(`${url} -> invalid JSON`);
        continue;
      }

      const polygonFeatures: TractFeature[] = (raw.features ?? [])
        .filter(isPolygonFeature)
        .map((feature) => ({
          ...feature,
          geometry: reprojectPolygonOrMultiPolygonIfNeeded(feature.geometry),
        }));

      if (polygonFeatures.length === 0) {
        errors.push(`${url} -> 0 polygon features`);
        continue;
      }

      return {
        type: "FeatureCollection",
        features: polygonFeatures,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      errors.push(`${url} -> ${message}`);
    }
  }

  throw new Error(errors.join(" | "));
}

function lookupLocalAlias(rawQuery: string): LocalAlias | null {
  const normalized = normalizeForMatch(normalizeSearchQuery(rawQuery));
  return LOCAL_SEARCH_ALIASES[normalized] ?? null;
}

function rankSearchResults(
  results: SearchResult[],
  rawQuery: string,
  boroughFilter?: string,
): RankedSearchResult[] {
  const normalizedQuery = normalizeSearchQuery(rawQuery);
  const rawMatch = normalizeForMatch(normalizedQuery);
  const rawTokens = rawMatch.split(" ").filter(Boolean);
  const normalizedBorough = normalizeText(boroughFilter);
  const isDirectBoroughSearch = !!getBoroughKeyFromQuery(normalizedQuery);
  const queryParsed = parseStreetLike(normalizedQuery);
  const intent = analyzeSearchIntent(normalizedQuery);

  const deduped = new Map<string, RankedSearchResult>();

  for (const result of results) {
    const lat = Number(result.lat);
    const lng = Number(result.lon);
    const label = String(result.display_name ?? normalizedQuery);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!isWithinNycBounds(lat, lng)) continue;

    const resultText = collectSearchResultText(result);
    const labelMatch = normalizeForMatch(label);
    const labelParsed = parseStreetLike(label);
    const bounds = getBoundsFromBoundingBox(result.boundingbox);
    const area = getBoundsArea(bounds);
    const category = normalizeText(result.category ?? result.class ?? "");
    const addresstype = normalizeText(result.addresstype ?? result.type ?? "");
    const typeText = `${category} ${addresstype}`;

    let score = 0;

    score += 250;

    if (labelMatch === rawMatch) score += 380;
    if (labelMatch.startsWith(rawMatch)) score += 220;
    if (resultText.includes(rawMatch)) score += 180;

    let matchedTokens = 0;
    for (const token of rawTokens) {
      if (token.length >= 2 && resultText.includes(token)) {
        matchedTokens += 1;
        score += token.length >= 5 ? 30 : 16;
      }
    }

    score += matchedTokens * 12;
    score -= Math.max(0, rawTokens.length - matchedTokens) * 18;

    if (
      queryParsed.normalizedStreet &&
      labelParsed.normalizedStreet === queryParsed.normalizedStreet
    ) {
      score += 240;
    }

    if (queryParsed.streetName) {
      if (labelParsed.streetName === queryParsed.streetName) {
        score += 150;
      } else if (
        labelParsed.streetName.includes(queryParsed.streetName) ||
        queryParsed.streetName.includes(labelParsed.streetName)
      ) {
        score += 60;
      }
    }

    if (queryParsed.streetSuffix) {
      if (labelParsed.streetSuffix === queryParsed.streetSuffix) {
        score += 90;
      } else if (labelParsed.streetName === queryParsed.streetName) {
        score -= 100;
      }
    }

    if (queryParsed.houseNumber) {
      if (labelParsed.houseNumber === queryParsed.houseNumber) {
        score += 320;
      } else if (labelParsed.houseNumber) {
        score -= 180;
      }
    }

    if (
      normalizedBorough &&
      normalizedBorough !== "all boroughs" &&
      resultText.includes(normalizedBorough)
    ) {
      score += 100;
    }

    if (intent.isAddress) {
      if (
        ["house", "address", "building", "residential"].some((term) =>
          typeText.includes(term),
        )
      ) {
        score += 130;
      }

      if (["road", "street", "highway"].some((term) => typeText.includes(term))) {
        score += 60;
      }
    }

    if (intent.isStreet) {
      if (
        ["road", "street", "highway", "bus_stop", "station", "subway"].some(
          (term) => typeText.includes(term),
        )
      ) {
        score += 110;
      }
    }

    if (intent.isAirport) {
      if (
        ["airport", "aeroway", "aerodrome", "terminal"].some((term) =>
          typeText.includes(term) || resultText.includes(term),
        )
      ) {
        score += 300;
      } else {
        score -= 180;
      }
    }

    if (intent.isTransit) {
      if (
        ["station", "subway", "railway", "public_transport", "bus", "terminal"].some(
          (term) => typeText.includes(term),
        )
      ) {
        score += 130;
      }
    }

    if (intent.isBridge) {
      if (typeText.includes("bridge") || resultText.includes("bridge")) {
        score += 160;
      } else {
        score -= 100;
      }
    }

    if (intent.isPark) {
      if (
        ["park", "garden", "leisure", "recreation_ground"].some((term) =>
          typeText.includes(term) || resultText.includes(term),
        )
      ) {
        score += 150;
      }
    }

    if (intent.isMuseum) {
      if (
        ["museum", "gallery", "tourism", "attraction", "arts"].some((term) =>
          typeText.includes(term) || resultText.includes(term),
        )
      ) {
        score += 170;
      } else {
        score -= 60;
      }
    }

    if (intent.isNature) {
      if (
        ["refuge", "nature", "reserve", "beach", "wetland", "marsh", "park"].some(
          (term) => typeText.includes(term) || resultText.includes(term),
        )
      ) {
        score += 170;
      }
    }

    if (intent.isSchool) {
      if (
        ["school", "college", "university", "campus"].some((term) =>
          typeText.includes(term) || resultText.includes(term),
        )
      ) {
        score += 160;
      }
    }

    if (intent.isResearch) {
      if (
        [
          "research",
          "science",
          "laboratory",
          "lab",
          "institute",
          "university",
          "college",
          "building",
        ].some((term) => typeText.includes(term) || resultText.includes(term))
      ) {
        score += 170;
      }
    }

    if (intent.isHospital) {
      if (
        ["hospital", "clinic", "medical", "healthcare"].some((term) =>
          typeText.includes(term) || resultText.includes(term),
        )
      ) {
        score += 150;
      }
    }

    if (intent.isLandmark && !intent.isStreet && !intent.isAddress) {
      if (
        [
          "museum",
          "gallery",
          "tourism",
          "attraction",
          "park",
          "garden",
          "university",
          "college",
          "school",
          "research",
          "science",
          "building",
          "hospital",
          "clinic",
          "refuge",
          "nature",
          "reserve",
          "beach",
          "stadium",
          "bridge",
          "library",
        ].some((term) => typeText.includes(term) || resultText.includes(term))
      ) {
        score += 120;
      }

      if (
        ["road", "street", "highway", "administrative", "city", "county", "state"].some(
          (term) => typeText.includes(term),
        )
      ) {
        score -= 120;
      }
    }

    if (
      !isDirectBoroughSearch &&
      ["administrative", "borough", "city", "county", "state"].some((term) =>
        typeText.includes(term),
      )
    ) {
      score -= 80;
    }

    const importance = Number(result.importance ?? 0);
    if (Number.isFinite(importance)) {
      score += importance * 18;
    }

    if (Number.isFinite(area)) {
      score += Math.max(0, 55 - Math.min(55, area * 9000));
    }

    const key = `${lat.toFixed(5)}|${lng.toFixed(5)}|${labelMatch}`;
    const existing = deduped.get(key);

    if (!existing || score > existing.score) {
      deduped.set(key, {
        lat,
        lng,
        label,
        score,
        bounds,
        area,
      });
    }
  }

  return Array.from(deduped.values()).sort((a, b) => b.score - a.score);
}

function EnsureMapSize() {
  const map = useMap();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      map.invalidateSize();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [map]);

  return null;
}

function SearchStatusBadge({
  text,
  kind,
}: {
  text: string;
  kind: SearchStatusKind;
}) {
  if (!text) return null;

  const background =
    kind === "error"
      ? "rgba(254, 226, 226, 0.96)"
      : kind === "loading"
        ? "rgba(219, 234, 254, 0.96)"
        : kind === "success"
          ? "rgba(220, 252, 231, 0.96)"
          : "rgba(255, 255, 255, 0.96)";

  const border =
    kind === "error"
      ? "#fca5a5"
      : kind === "loading"
        ? "#93c5fd"
        : kind === "success"
          ? "#86efac"
          : "#e5e7eb";

  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        right: 16,
        zIndex: 1000,
        background,
        border: `1px solid ${border}`,
        borderRadius: 12,
        padding: "8px 10px",
        boxShadow: "0 8px 20px rgba(15, 23, 42, 0.12)",
        fontSize: 12,
        maxWidth: 280,
      }}
    >
      {text}
    </div>
  );
}

function SearchInfoCard({
  info,
}: {
  info: SearchInfo | null;
}) {
  if (!info) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        left: 52,
        zIndex: 1000,
        background: "rgba(255, 255, 255, 0.96)",
        border: "1px solid #dbeafe",
        borderRadius: 12,
        padding: "10px 12px",
        boxShadow: "0 8px 20px rgba(15, 23, 42, 0.12)",
        fontSize: 12,
        maxWidth: 360,
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Search result</div>
      <div style={{ color: "#475569", marginBottom: 6 }}>
        Borough filter: {info.boroughFilter || "All boroughs"} · Search text:{" "}
        {info.query}
      </div>
      <div>
        <strong>Found:</strong> {info.label}
      </div>
    </div>
  );
}

function SearchFlyTo({
  searchText,
  boroughFilter,
  searchRequestId,
  viewResetKey,
  onLocationFound,
  onStatusChange,
  onInfoChange,
}: {
  searchText: string;
  boroughFilter?: string;
  searchRequestId?: number;
  viewResetKey?: number;
  onLocationFound: (lat: number, lng: number, label: string) => void;
  onStatusChange: (text: string, kind: SearchStatusKind) => void;
  onInfoChange: (info: SearchInfo | null) => void;
}) {
  const map = useMap();
  const handledRequestRef = useRef<number>(-1);

  useEffect(() => {
    map.stop();
    map.fitBounds(NYC_LATLNG_BOUNDS, {
      padding: [24, 24],
      animate: false,
      maxZoom: DEFAULT_ZOOM,
    });
    onStatusChange("", "idle");
    onInfoChange(null);
  }, [map, onInfoChange, onStatusChange, viewResetKey]);

  useEffect(() => {
    const rawQuery = searchText.trim();

    if (!rawQuery) return;
    if (!searchRequestId) return;
    if (handledRequestRef.current === searchRequestId) return;

    handledRequestRef.current = searchRequestId;

    const controller = new AbortController();

    async function runSearch() {
      try {
        const normalizedQuery = normalizeSearchQuery(rawQuery);
        const coordinateMatch = parseCoordinateQuery(normalizedQuery);

        if (coordinateMatch) {
          const [lat, lng] = coordinateMatch;
          map.stop();
          map.setView([lat, lng], 17, { animate: false });
          onLocationFound(lat, lng, `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
          onInfoChange({
            query: rawQuery,
            label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
            boroughFilter: boroughFilter || "All boroughs",
          });
          onStatusChange("Coordinate search worked.", "success");
          return;
        }

        const directBorough = getBoroughKeyFromQuery(normalizedQuery);

        if (directBorough) {
          map.stop();
          map.fitBounds(BOROUGH_BOUNDS[directBorough], {
            padding: [40, 40],
            animate: true,
            maxZoom: 13,
          });

          const [lat, lng] = BOROUGH_CENTERS[directBorough];
          onLocationFound(lat, lng, BOROUGH_QUERY_SUFFIX[directBorough]);
          onInfoChange({
            query: rawQuery,
            label: BOROUGH_QUERY_SUFFIX[directBorough],
            boroughFilter: boroughFilter || "All boroughs",
          });
          onStatusChange("Matched borough.", "success");
          return;
        }

        const alias = lookupLocalAlias(normalizedQuery);

        if (alias) {
          map.stop();

          const aliasBounds = clampBoundsToNyc(alias.bounds ?? null);

          if (aliasBounds) {
            map.fitBounds(aliasBounds, {
              padding: [40, 40],
              animate: true,
              maxZoom: 16,
            });
          } else {
            map.setView([alias.lat, alias.lng], 17, { animate: false });
          }

          onLocationFound(alias.lat, alias.lng, alias.label);
          onInfoChange({
            query: rawQuery,
            label: alias.label,
            boroughFilter: boroughFilter || "All boroughs",
          });
          onStatusChange("Matched local NYC place.", "success");
          return;
        }

        onInfoChange(null);
        onStatusChange(`Searching for "${rawQuery}"...`, "loading");

        const allResults = await searchOpenDataGeocoders(
          normalizedQuery,
          boroughFilter,
          controller.signal,
        );

        const nycOnlyResults = allResults.filter((result) => {
          const lat = Number(result.lat);
          const lng = Number(result.lon);
          return (
            Number.isFinite(lat) &&
            Number.isFinite(lng) &&
            isWithinNycBounds(lat, lng)
          );
        });

        const ranked = rankSearchResults(
          nycOnlyResults.length > 0 ? nycOnlyResults : allResults,
          normalizedQuery,
          boroughFilter,
        );

        if (ranked.length === 0) {
          onStatusChange(
            `No NYC match found for "${rawQuery}". Try adding a borough or ZIP code.`,
            "error",
          );
          onInfoChange(null);
          return;
        }

        const best = ranked[0];

        if (!isSearchMatchAcceptable(best, normalizedQuery)) {
          onStatusChange(`No valid NYC match found for "${rawQuery}".`, "error");
          onInfoChange(null);
          return;
        }

        const clampedBounds = clampBoundsToNyc(best.bounds);

        map.stop();

        if (shouldFitSearchBounds(clampedBounds)) {
          map.fitBounds(clampedBounds as LatLngBoundsExpression, {
            padding: [40, 40],
            animate: true,
            maxZoom: 16,
          });
        } else {
          map.setView([best.lat, best.lng], 17, {
            animate: false,
          });
        }

        onLocationFound(best.lat, best.lng, best.label);
        onInfoChange({
          query: rawQuery,
          label: best.label,
          boroughFilter: boroughFilter || "All boroughs",
        });
        onStatusChange("Search completed.", "success");
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        onStatusChange("Text search failed at runtime.", "error");
        onInfoChange(null);
        console.error("Geocoder error:", error);
      }
    }

    void runSearch();

    return () => controller.abort();
  }, [
    boroughFilter,
    map,
    onInfoChange,
    onLocationFound,
    onStatusChange,
    searchRequestId,
    searchText,
  ]);

  return null;
}

function MapClickPicker({
  features,
  onPicked,
}: {
  features: TractFeature[];
  onPicked: (
    lat: number,
    lng: number,
    addressLabel: string,
    feature: TractFeature | null,
  ) => void;
}) {
  useMapEvents({
    click(event) {
      void (async () => {
        const lat = event.latlng.lat;
        const lng = event.latlng.lng;
        const feature = findContainingFeature(features, lat, lng);
        const addressLabel = await reverseGeocode(lat, lng);

        onPicked(lat, lng, addressLabel, feature);
      })();
    },
  });

  return null;
}

function RiskLegend() {
  return (
    <div
      style={{
        position: "absolute",
        right: 16,
        bottom: 16,
        zIndex: 1000,
        background: "white",
        border: "1px solid #e5e7eb",
        borderRadius: 14,
        padding: "10px 12px",
        boxShadow: "0 10px 24px rgba(15, 23, 42, 0.12)",
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Risk legend</div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: 999,
            background: "#22c55e",
            display: "inline-block",
          }}
        />
        <span>Low risk</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: 999,
            background: "#f59e0b",
            display: "inline-block",
          }}
        />
        <span>Medium risk</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: 999,
            background: "#ef4444",
            display: "inline-block",
          }}
        />
        <span>High risk</span>
      </div>
    </div>
  );
}

export default function FloodRiskMap({
  boroughFilter = "All boroughs",
  searchText = "",
  searchRequestId = 0,
  viewResetKey = 0,
  reloadKey = 0,
  onStatsChange,
  onTractSelect,
}: FloodRiskMapProps) {
  const [allData, setAllData] = useState<TractCollection>({
    type: "FeatureCollection",
    features: [],
  });

  const [mapPoint, setMapPoint] = useState<{
    lat: number;
    lng: number;
    label: string;
  } | null>(null);

  const [selectedTract, setSelectedTract] = useState<SelectedTract | null>(null);
  const [searchStatusText, setSearchStatusText] = useState("");
  const [searchStatusKind, setSearchStatusKind] =
    useState<SearchStatusKind>("idle");
  const [searchInfo, setSearchInfo] = useState<SearchInfo | null>(null);

  const markerRef = useRef<L.CircleMarker | null>(null);

  useEffect(() => {
    async function loadData() {
      try {
        const collection = await fetchFirstWorkingGeoJson(reloadKey);
        setAllData(collection);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load tract GeoJSON.";
        console.error(message);

        setAllData({
          type: "FeatureCollection",
          features: [],
        });
      }
    }

    void loadData();
  }, [reloadKey]);

  useEffect(() => {
    setMapPoint(null);
    setSelectedTract(null);
    setSearchInfo(null);
    setSearchStatusText("");
    setSearchStatusKind("idle");
    onTractSelect?.(null);
  }, [viewResetKey]);

  const visibleFeatures = useMemo(() => {
    return allData.features.filter((feature) =>
      matchesBorough(feature, boroughFilter),
    );
  }, [allData.features, boroughFilter]);

  const visibleCollection = useMemo<TractCollection>(() => {
    return {
      type: "FeatureCollection",
      features: visibleFeatures,
    };
  }, [visibleFeatures]);

  useEffect(() => {
    const highRiskCount = visibleFeatures.filter(
      (feature) => getRiskLevel(feature) === "High",
    ).length;

    const boroughScoreMap = new Map<string, number>();

    for (const feature of visibleFeatures) {
      const borough = getBorough(feature);
      const score = getRiskScore(feature);
      boroughScoreMap.set(borough, (boroughScoreMap.get(borough) ?? 0) + score);
    }

    let topBorough = "N/A";
    let topBoroughScore = 0;

    for (const [borough, score] of boroughScoreMap.entries()) {
      if (score > topBoroughScore) {
        topBorough = borough;
        topBoroughScore = score;
      }
    }

    onStatsChange?.({
      highRiskCount,
      visibleCount: visibleFeatures.length,
      topBorough,
      topBoroughScore,
    });
  }, [visibleFeatures, onStatsChange]);

  useEffect(() => {
    if (!mapPoint) return;

    const timer = window.setTimeout(() => {
      markerRef.current?.openPopup();
    }, 100);

    return () => window.clearTimeout(timer);
  }, [mapPoint, selectedTract]);

  const selectLocation = useCallback(
    (
      lat: number,
      lng: number,
      addressLabel: string,
      feature: TractFeature | null,
    ) => {
      const selected = buildSelectedTract(feature, lat, lng, addressLabel);

      setMapPoint({
        lat,
        lng,
        label:
          addressLabel ||
          (feature ? `Tract ${getTractLabel(feature)}` : "Selected location"),
      });

      setSelectedTract(selected);
      onTractSelect?.(selected);
    },
    [onTractSelect],
  );

  const handleSearchStatusChange = useCallback(
    (text: string, kind: SearchStatusKind) => {
      setSearchStatusText(text);
      setSearchStatusKind(kind);
    },
    [],
  );

  const handleSearchInfoChange = useCallback((info: SearchInfo | null) => {
    setSearchInfo(info);
  }, []);

  const handleSearchLocationFound = useCallback(
    (lat: number, lng: number, label: string) => {
      setMapPoint({
        lat,
        lng,
        label,
      });

      const feature = findContainingFeature(allData.features, lat, lng);
      const selected = buildSelectedTract(feature, lat, lng, label);
      setSelectedTract(selected);
      onTractSelect?.(selected);
    },
    [allData.features, onTractSelect],
  );

  const handleMapPicked = useCallback(
    (
      lat: number,
      lng: number,
      addressLabel: string,
      feature: TractFeature | null,
    ) => {
      setSearchInfo(null);
      setSearchStatusText("");
      setSearchStatusKind("idle");
      selectLocation(lat, lng, addressLabel, feature);
    },
    [selectLocation],
  );

  function onEachFeature(feature: Feature | undefined, layer: Layer) {
    if (!feature) return;

    const tractFeature = feature as TractFeature;

    const leafletLayer = layer as L.Path & {
      bindPopup: (content: string) => void;
      setStyle: (style: {
        weight?: number;
        color?: string;
        fillOpacity?: number;
        opacity?: number;
      }) => void;
      on: (
        event: string,
        handler: (event: L.LeafletMouseEvent) => void,
      ) => void;
    };

    const riskScore = getRiskScore(tractFeature);
    const borough = getBorough(tractFeature);
    const neighborhood = getNeighborhood(tractFeature);
    const tractLabel = getTractLabel(tractFeature);
    const riskLevel = getRiskLevel(tractFeature);

    leafletLayer.bindPopup(`
      <div style="min-width: 190px;">
        <strong>Tract ${tractLabel}</strong><br/>
        Borough: ${borough}<br/>
        Neighborhood: ${neighborhood}<br/>
        Risk score: ${riskScore.toFixed(2)}<br/>
        Risk level: ${riskLevel}
      </div>
    `);

    leafletLayer.on("click", (event: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(event);

      void (async () => {
        const controller = new AbortController();
        const addressLabel = await reverseGeocode(
          event.latlng.lat,
          event.latlng.lng,
          controller.signal,
        );

        setSearchInfo(null);
        setSearchStatusText("");
        setSearchStatusKind("idle");

        selectLocation(
          event.latlng.lat,
          event.latlng.lng,
          addressLabel,
          tractFeature,
        );
      })();
    });

    leafletLayer.on("mouseover", () => {
      leafletLayer.setStyle({
        weight: 1.6,
        opacity: 1,
        color: "#111827",
        fillOpacity: 0.58,
      });
    });

    leafletLayer.on("mouseout", () => {
      leafletLayer.setStyle({
        weight: 1,
        opacity: 1,
        color: getRiskBorderColor(tractFeature),
        fillOpacity: 0.34,
      });
    });
  }

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: "520px",
        borderRadius: "24px",
        overflow: "hidden",
      }}
    >
      <MapContainer
        center={NYC_CENTER}
        zoom={DEFAULT_ZOOM}
        minZoom={10}
        maxBounds={NYC_LATLNG_BOUNDS}
        maxBoundsViscosity={1.0}
        style={{ width: "100%", height: "100%" }}
        scrollWheelZoom
      >
        <EnsureMapSize />

        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <SearchFlyTo
          searchText={searchText}
          boroughFilter={boroughFilter}
          searchRequestId={searchRequestId}
          viewResetKey={viewResetKey}
          onLocationFound={handleSearchLocationFound}
          onStatusChange={handleSearchStatusChange}
          onInfoChange={handleSearchInfoChange}
        />

        <MapClickPicker features={visibleFeatures} onPicked={handleMapPicked} />

        <GeoJSON
          key={`geojson-${reloadKey}-${boroughFilter}-${visibleFeatures.length}`}
          data={visibleCollection as any}
          style={(feature) => {
            const tractFeature = feature as TractFeature | undefined;

            if (!tractFeature) {
              return {
                fillColor: "#94a3b8",
                fillOpacity: 0.34,
                color: "#64748b",
                opacity: 1,
                weight: 1,
              };
            }

            return {
              fillColor: getRiskColor(tractFeature),
              fillOpacity: 0.34,
              color: getRiskBorderColor(tractFeature),
              opacity: 1,
              weight: 1,
            };
          }}
          onEachFeature={onEachFeature}
        />

        {mapPoint ? (
          <CircleMarker
            ref={markerRef}
            center={[mapPoint.lat, mapPoint.lng]}
            radius={8}
            pathOptions={{
              color: "#1d4ed8",
              fillColor: "#2563eb",
              fillOpacity: 0.95,
              weight: 2,
            }}
          >
            <Popup>
              <div>
                <strong>{mapPoint.label}</strong>
                <br />
                Lat: {mapPoint.lat.toFixed(5)}
                <br />
                Lng: {mapPoint.lng.toFixed(5)}
                {selectedTract ? (
                  <>
                    <br />
                    <br />
                    <strong>{selectedTract.tractLabel}</strong>
                    <br />
                    Borough: {selectedTract.borough}
                    <br />
                    Neighborhood: {selectedTract.neighborhood}
                    <br />
                    Risk level: {selectedTract.riskLevel}
                    <br />
                    Risk score: {selectedTract.riskScore.toFixed(2)}
                  </>
                ) : null}
              </div>
            </Popup>
          </CircleMarker>
        ) : null}
      </MapContainer>

      <SearchInfoCard info={searchInfo} />
      <SearchStatusBadge text={searchStatusText} kind={searchStatusKind} />
      <RiskLegend />
    </div>
  );
}