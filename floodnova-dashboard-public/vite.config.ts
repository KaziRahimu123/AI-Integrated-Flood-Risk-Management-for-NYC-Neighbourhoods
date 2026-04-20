import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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

const USER_AGENT = "FloodNova/1.0";

const BOROUGH_QUERY_SUFFIX: Record<string, string> = {
  brooklyn: "Brooklyn, New York City, NY",
  queens: "Queens, New York City, NY",
  manhattan: "Manhattan, New York City, NY",
  bronx: "Bronx, New York City, NY",
  "staten island": "Staten Island, New York City, NY",
};

const BOROUGH_CENTERS: Record<string, [number, number]> = {
  brooklyn: [40.6501, -73.9496],
  queens: [40.7282, -73.7949],
  manhattan: [40.7831, -73.9712],
  bronx: [40.8448, -73.8648],
  "staten island": [40.5795, -74.1502],
};

function normalizeText(value?: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function buildCandidateQueries(rawQuery: string, boroughFilter?: string): string[] {
  const normalizedRaw = normalizeText(rawQuery);
  const normalizedBorough = normalizeText(boroughFilter);
  const queries = new Set<string>();

  queries.add(rawQuery);

  if (!/new york|nyc|brooklyn|queens|bronx|manhattan|staten island/i.test(rawQuery)) {
    queries.add(`${rawQuery}, New York City`);
    queries.add(`${rawQuery}, NYC`);
  }

  if (
    normalizedBorough &&
    normalizedBorough !== "all boroughs" &&
    BOROUGH_QUERY_SUFFIX[normalizedBorough]
  ) {
    queries.add(`${rawQuery}, ${BOROUGH_QUERY_SUFFIX[normalizedBorough]}`);
  }

  if (!normalizedRaw.includes("brooklyn")) queries.add(`${rawQuery}, Brooklyn`);
  if (!normalizedRaw.includes("manhattan")) queries.add(`${rawQuery}, Manhattan`);
  if (!normalizedRaw.includes("queens")) queries.add(`${rawQuery}, Queens`);

  if (normalizedRaw.includes("jay street")) {
    queries.add("Jay St-MetroTech, Brooklyn");
    queries.add("Jay Street MetroTech, Brooklyn");
  }

  if (normalizedRaw.includes("canal street")) {
    queries.add("Canal Street, Manhattan");
    queries.add("Canal St, Manhattan");
  }

  return Array.from(queries).slice(0, 5);
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

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 5000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
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

async function searchNominatim(query: string): Promise<SearchResult[]> {
  try {
    const params = new URLSearchParams({
      format: "jsonv2",
      q: query,
      limit: "8",
      countrycodes: "us",
      addressdetails: "1",
      dedupe: "1",
    });

    const data = await fetchJsonWithTimeout<SearchResult[]>(
      `https://nominatim.openstreetmap.org/search?${params.toString()}`,
      2500,
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
      2500,
    );

    return convertPhotonToSearchResults(data, query);
  } catch {
    return [];
  }
}

async function reversePlace(lat: number, lng: number): Promise<{ display_name?: string }> {
  try {
    return await fetchJsonWithTimeout<{ display_name?: string }>(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      2500,
    );
  } catch {
    return {};
  }
}

function floodNovaGeocoderPlugin(): Plugin {
  return {
    name: "floodnova-geocoder",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const originalUrl = req.url ?? "";

        if (
          !originalUrl.startsWith("/api/search-place") &&
          !originalUrl.startsWith("/api/reverse-place")
        ) {
          next();
          return;
        }

        try {
          const url = new URL(originalUrl, "http://localhost");

          if (url.pathname === "/api/search-place") {
            const q = url.searchParams.get("q")?.trim() ?? "";
            const borough = url.searchParams.get("borough")?.trim() ?? "";

            if (!q) {
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ results: [] }));
              return;
            }

            const queries = buildCandidateQueries(q, borough);
            const [biasLat, biasLng] = getSearchBiasCenter(borough);

            let merged: SearchResult[] = [];

            for (const query of queries) {
              const [photonResults, nominatimResults] = await Promise.all([
                searchPhoton(query, biasLat, biasLng),
                searchNominatim(query),
              ]);

              merged = merged.concat(photonResults, nominatimResults);

              if (merged.length > 0) break;
            }

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ results: merged }));
            return;
          }

          if (url.pathname === "/api/reverse-place") {
            const lat = Number(url.searchParams.get("lat"));
            const lng = Number(url.searchParams.get("lng"));

            const result =
              Number.isFinite(lat) && Number.isFinite(lng)
                ? await reversePlace(lat, lng)
                : { display_name: "" };

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify(result));
            return;
          }

          next();
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              results: [],
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          );
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), floodNovaGeocoderPlugin()],
});