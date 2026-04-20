import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FloodRiskMap, { type SelectedTract } from "./components/FloodRiskMap";
import "./App.css";

type DashboardStats = {
  highRiskCount: number;
  visibleCount: number;
  topBorough: string;
  topBoroughScore: number;
};

type AnalysisMode = "historic" | "live";

type HistoricPlace = {
  tract_id: string;
  borough: string;
  neighborhood: string | null;
  risk_score: number;
  risk_label: string;
};

type LivePlace = {
  borough: string;
  rank_in_borough: number;
  place_name: string;
  complaint_count: number;
  severity_points: number;
  live_score: number;
  impact_label: string;
  last_seen: string | null;
};

type HistoricGroup = {
  borough: string;
  places: HistoricPlace[];
};

type LiveGroup = {
  borough: string;
  places: LivePlace[];
};

type GuidanceResponse = {
  ok: boolean;
  mode?: AnalysisMode;
  borough?: string | null;
  lookbackHours?: number;
  effectiveLookbackHours?: number;
  refreshedAt?: string;
  historicTop10?: HistoricGroup[];
  liveTop10?: LiveGroup[];
  aiGuidance?: string;
  aiError?: string | null;
  error?: string;
};

const BOROUGH_OPTIONS = [
  "All boroughs",
  "Brooklyn",
  "Queens",
  "Manhattan",
  "Bronx",
  "Staten Island",
];

const DEFAULT_LOOKBACK_HOURS = 48;

const DASHBOARD_GUIDANCE_URL = (
  import.meta.env.VITE_DASHBOARD_GUIDANCE_URL ||
  "https://izikxsgbvpfpkmyhmccv.supabase.co/functions/v1/dashboard-guidance"
).trim();

const FALLBACK_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml6aWt4c2didnBmcGtteWhtY2N2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNjQyMjIsImV4cCI6MjA5MDc0MDIyMn0.jMrPsgJV7TanyqVNaVV_OIPjjk4-f-N9vcc_Fq_Sm7s";

const SUPABASE_ANON_KEY = (
  import.meta.env.VITE_SUPABASE_ANON_KEY || FALLBACK_SUPABASE_ANON_KEY
).trim();

function formatRefreshTime(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimestamp(value?: string | null): string {
  if (!value) return "Not available";

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not available";

  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function normalizeBoroughForApi(value: string): string | null {
  if (!value || value === "All boroughs") return null;
  return value;
}

function buildRequestHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

function splitGuidanceText(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseJsonSafely<T>(raw: string): T | null {
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function cleanUserFacingGuidance(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const lower = line.toLowerCase();

      if (lower.includes("max_output_tokens")) return false;
      if (lower.includes("fallback")) return false;
      if (lower.includes("token")) return false;
      if (lower.includes("json")) return false;
      if (lower.includes("schema")) return false;
      if (lower.includes("format")) return false;
      if (lower.includes("output_text")) return false;
      if (lower.includes("input_text")) return false;
      if (lower.includes("openai")) return false;
      if (lower.startsWith("{")) return false;
      if (lower.startsWith("}")) return false;
      if (lower.startsWith("[")) return false;
      if (lower.startsWith("]")) return false;
      if (/^"?[a-z_]+"?:/i.test(line)) return false;

      return true;
    })
    .join("\n")
    .trim();
}

function buildFriendlyGuidanceFallback(mode: AnalysisMode): string {
  if (mode === "live") {
    return [
      "What this means:",
      "There is not enough recent flood-related 311 activity to show a strong real-time hot spot right now.",
      "What people should do:",
      "- Check nearby conditions before heading out during heavy rain.",
      "- Be careful around streets with poor drainage or visible standing water.",
      "- Use the historic view for longer-term flood-risk context.",
    ].join("\n");
  }

  return [
    "What this means:",
    "This view highlights places in the city that have shown stronger flood-risk patterns in past data.",
    "What people should do:",
    "- Treat these places as areas that deserve extra caution during storms.",
    "- Leave extra travel time when rain is heavy.",
    "- Follow weather and emergency updates before traveling there.",
  ].join("\n");
}

export default function App() {
  const [searchInput, setSearchInput] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchRequestId, setSearchRequestId] = useState(0);
  const [viewResetKey, setViewResetKey] = useState(0);

  const [boroughFilter, setBoroughFilter] = useState("All boroughs");
  const [selectedTract, setSelectedTract] = useState<SelectedTract | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState(new Date());

  const [stats, setStats] = useState<DashboardStats>({
    highRiskCount: 0,
    visibleCount: 0,
    topBorough: "N/A",
    topBoroughScore: 0,
  });

  const [activeMode, setActiveMode] = useState<AnalysisMode | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [analysisUpdatedAt, setAnalysisUpdatedAt] = useState("");
  const [aiGuidance, setAiGuidance] = useState("");
  const [historicGroups, setHistoricGroups] = useState<HistoricGroup[]>([]);
  const [liveGroups, setLiveGroups] = useState<LiveGroup[]>([]);
  const [effectiveLookbackHours, setEffectiveLookbackHours] = useState(
    DEFAULT_LOOKBACK_HOURS,
  );

  const analysisAbortRef = useRef<AbortController | null>(null);
  const analysisRequestIdRef = useRef(0);

  useEffect(() => {
    return () => {
      analysisAbortRef.current?.abort();
    };
  }, []);

  const statCards = useMemo(() => {
    return [
      {
        title: "High-risk tracts",
        value: String(stats.highRiskCount),
        note: "Count from the visible baseline tract set",
      },
      {
        title: "Visible tracts",
        value: String(stats.visibleCount),
        note: "Loaded from the FEMA baseline tract file",
      },
      {
        title: "Top borough this view",
        value: stats.topBorough,
        note: `${stats.topBoroughScore.toFixed(2)} summed baseline risk points`,
      },
    ];
  }, [stats]);

  const guidanceLines = useMemo(() => splitGuidanceText(aiGuidance), [aiGuidance]);
  const activeGroups = activeMode === "historic" ? historicGroups : liveGroups;

  const handleStatsChange = useCallback((nextStats: DashboardStats) => {
    setStats(nextStats);
  }, []);

  const handleTractSelect = useCallback((tract: SelectedTract | null) => {
    setSelectedTract(tract);
  }, []);

  const handleSearchPlace = useCallback(() => {
    const nextSearch = searchInput.trim();
    if (!nextSearch) return;

    setSearchInput(nextSearch);
    setSearchText(nextSearch);
    setSelectedTract(null);
    setSearchRequestId((current) => current + 1);
  }, [searchInput]);

  const handleClearSearch = useCallback(() => {
    setSearchInput("");
    setSearchText("");
    setSelectedTract(null);
    setViewResetKey((current) => current + 1);
  }, []);

  const runAnalysis = useCallback(
    async (mode: AnalysisMode) => {
      analysisAbortRef.current?.abort();

      const controller = new AbortController();
      analysisAbortRef.current = controller;

      const requestId = analysisRequestIdRef.current + 1;
      analysisRequestIdRef.current = requestId;

      setActiveMode(mode);
      setAnalysisLoading(true);
      setAnalysisError("");

      try {
        const response = await fetch(DASHBOARD_GUIDANCE_URL, {
          method: "POST",
          headers: buildRequestHeaders(),
          body: JSON.stringify({
            mode,
            borough: normalizeBoroughForApi(boroughFilter),
            lookbackHours: DEFAULT_LOOKBACK_HOURS,
          }),
          signal: controller.signal,
        });

        const raw = await response.text();

        if (requestId !== analysisRequestIdRef.current) return;

        const data = parseJsonSafely<GuidanceResponse>(raw);

        if (!response.ok) {
          console.error("Dashboard analysis failed:", raw);
          throw new Error("analysis_failed");
        }

        if (!data || !data.ok) {
          console.error("Dashboard analysis invalid response:", raw);
          throw new Error("analysis_failed");
        }

        const cleanedGuidance = cleanUserFacingGuidance(data.aiGuidance || "");

        setAiGuidance(cleanedGuidance || buildFriendlyGuidanceFallback(mode));
        setHistoricGroups(Array.isArray(data.historicTop10) ? data.historicTop10 : []);
        setLiveGroups(Array.isArray(data.liveTop10) ? data.liveTop10 : []);
        setAnalysisUpdatedAt(data.refreshedAt || new Date().toISOString());
        setEffectiveLookbackHours(
          data.effectiveLookbackHours || DEFAULT_LOOKBACK_HOURS,
        );
        setLastRefreshed(new Date());
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }

        console.error("runAnalysis error:", error);

        if (requestId !== analysisRequestIdRef.current) return;

        setAiGuidance(buildFriendlyGuidanceFallback(mode));
        setHistoricGroups([]);
        setLiveGroups([]);
        setAnalysisUpdatedAt("");
        setEffectiveLookbackHours(DEFAULT_LOOKBACK_HOURS);

        setAnalysisError(
          mode === "live"
            ? "Could not load the real-time analysis right now."
            : "Could not load the historic analysis right now.",
        );
      } finally {
        if (requestId === analysisRequestIdRef.current) {
          setAnalysisLoading(false);
        }
      }
    },
    [boroughFilter],
  );

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <h1 className="brand-title">FloodNova</h1>
        </div>

        <p className="brand-copy">
          AI flood-risk prioritization dashboard for NYC neighborhoods.
          <br />
          Last refreshed: {formatRefreshTime(lastRefreshed)}
        </p>

        <div className="sidebar-divider" />

        <section className="sidebar-block">
          <h2 className="sidebar-heading">Search place</h2>

          <input
            type="text"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                handleSearchPlace();
              }
            }}
            placeholder="Street, landmark, airport, address"
            className="search-input"
          />

          <div className="sidebar-row">
            <button
              type="button"
              className="primary-btn"
              style={{ flex: 1 }}
              onClick={handleSearchPlace}
              disabled={!searchInput.trim()}
            >
              Search place
            </button>

            <button
              type="button"
              className="secondary-btn"
              onClick={handleClearSearch}
            >
              Clear
            </button>
          </div>
        </section>

        <section className="sidebar-block">
          <h2 className="sidebar-heading">Borough</h2>

          <select
            className="select-control"
            value={boroughFilter}
            onChange={(event) => setBoroughFilter(event.target.value)}
          >
            {BOROUGH_OPTIONS.map((borough) => (
              <option key={borough} value={borough}>
                {borough}
              </option>
            ))}
          </select>
        </section>

        <section className="sidebar-block">
          <h2 className="sidebar-heading">Risk analysis</h2>

          <div className="action-stack">
            <button
              type="button"
              className={`mode-btn ${
                activeMode === "historic" ? "mode-btn--active" : ""
              }`}
              onClick={() => void runAnalysis("historic")}
              disabled={analysisLoading}
            >
              Historic risk spots and guidance
            </button>

            <button
              type="button"
              className={`mode-btn ${
                activeMode === "live" ? "mode-btn--active" : ""
              }`}
              onClick={() => void runAnalysis("live")}
              disabled={analysisLoading}
            >
              Real-time risk spots and guidance
            </button>
          </div>

          <p className="sidebar-note">
            {analysisLoading
              ? "Loading guidance and top risk spots..."
              : activeMode === "historic"
                ? "Historic baseline flood-risk view is selected."
                : activeMode === "live"
                  ? effectiveLookbackHours > DEFAULT_LOOKBACK_HOURS
                    ? "Real-time 311 flood-risk view checked 48 hours first and used a 72-hour fallback because the shorter window returned no live places."
                    : `Real-time 311 flood-risk view is using a ${DEFAULT_LOOKBACK_HOURS}-hour window.`
                  : "Choose one of the two analysis views."}
          </p>
        </section>
      </aside>

      <main className="dashboard-main">
        <section className="stats-grid">
          {statCards.map((item) => (
            <article className="stat-card" key={item.title}>
              <p className="stat-label">{item.title}</p>
              <h3 className="stat-value">{item.value}</h3>
              <p className="stat-subtitle">{item.note}</p>
            </article>
          ))}
        </section>

        <section className="map-card">
          <div className="map-header">
            <h2>NYC Flood Risk Map</h2>
            <p>Zoom, pan, click anywhere, or click a tract to inspect it.</p>
          </div>

          <div className="map-panel" style={{ height: "540px" }}>
            <FloodRiskMap
              boroughFilter={boroughFilter}
              searchText={searchText}
              searchRequestId={searchRequestId}
              viewResetKey={viewResetKey}
              onStatsChange={handleStatsChange}
              onTractSelect={handleTractSelect}
            />
          </div>
        </section>

        <section className="guidance-card" style={{ marginTop: "20px" }}>
          <h3>Selected tract details</h3>
          <p className="guidance-muted">Exact tract data from the baseline file</p>

          {!selectedTract ? (
            <p>No tract is selected right now.</p>
          ) : (
            <div className="tract-detail-list">
              <div>
                <strong>Tract:</strong> {selectedTract.tractLabel}
              </div>
              <div>
                <strong>Borough:</strong> {selectedTract.borough}
              </div>
              <div>
                <strong>Neighborhood:</strong> {selectedTract.neighborhood}
              </div>
              <div>
                <strong>Risk level:</strong> {selectedTract.riskLevel}
              </div>
              <div>
                <strong>Risk score:</strong> {selectedTract.riskScore.toFixed(2)}
              </div>
              <div>
                <strong>Latitude:</strong> {selectedTract.latitude.toFixed(5)}
              </div>
              <div>
                <strong>Longitude:</strong> {selectedTract.longitude.toFixed(5)}
              </div>
              <div>
                <strong>Address label:</strong>{" "}
                {selectedTract.addressLabel || "Not available"}
              </div>
            </div>
          )}
        </section>

        <section className="analysis-shell">
          <article className="analysis-card">
            <div className="analysis-header">
              <div>
                <h3>
                  {activeMode === "historic"
                    ? "Historic AI guidance"
                    : activeMode === "live"
                      ? "Real-time AI guidance"
                      : "AI guidance"}
                </h3>
                <p className="guidance-muted">
                  {activeMode
                    ? `Borough filter: ${boroughFilter}`
                    : "Run one of the analysis buttons from the left panel"}
                </p>
              </div>

              {analysisUpdatedAt ? (
                <span className="analysis-pill">
                  Updated {formatTimestamp(analysisUpdatedAt)}
                </span>
              ) : null}
            </div>

            {analysisError ? (
              <div className="analysis-message analysis-message--error">
                {analysisError}
              </div>
            ) : analysisLoading ? (
              <div className="analysis-message">Loading guidance...</div>
            ) : !activeMode ? (
              <div className="analysis-message">
                Click either analysis button to load guidance and top 10 spots.
              </div>
            ) : (
              <div className="guidance-text">
                {guidanceLines.length === 0 ? (
                  <p>No guidance is available yet.</p>
                ) : (
                  guidanceLines.map((line, index) =>
                    line.startsWith("- ") ? (
                      <div className="guidance-bullet" key={`${line}-${index}`}>
                        {line}
                      </div>
                    ) : (
                      <p key={`${line}-${index}`}>{line}</p>
                    ),
                  )
                )}
              </div>
            )}
          </article>

          <article className="analysis-card">
            <div className="analysis-header">
              <div>
                <h3>
                  {activeMode === "historic"
                    ? "Historic top risk spots"
                    : activeMode === "live"
                      ? "Real-time top risk spots"
                      : "Top risk spots"}
                </h3>
                <p className="guidance-muted">
                  Returned from the selected analysis mode
                </p>
              </div>
            </div>

            {analysisError ? (
              <div className="analysis-message analysis-message--error">
                {activeMode === "live"
                  ? "Could not load live top spots right now."
                  : "Could not load historic top spots right now."}
              </div>
            ) : analysisLoading ? (
              <div className="analysis-message">Loading ranked spots...</div>
            ) : !activeMode ? (
              <div className="analysis-message">
                The top 10 ranked spots will appear here after you run an analysis.
              </div>
            ) : activeGroups.length === 0 ? (
              <div className="analysis-message">
                {activeMode === "live"
                  ? "No recent flood-related 311 hot spots were found for this filter right now."
                  : "No historic hot spots were returned for this filter."}
              </div>
            ) : (
              <div className="spots-grid">
                {activeMode === "historic"
                  ? historicGroups.map((group) => (
                      <div className="borough-spots-card" key={group.borough}>
                        <div className="borough-spots-header">{group.borough}</div>

                        <div className="spot-list">
                          {group.places.map((place, index) => (
                            <div
                              className="spot-row"
                              key={`${group.borough}-${place.tract_id}-${index}`}
                            >
                              <div className="spot-rank">{index + 1}</div>

                              <div className="spot-main">
                                <div className="spot-title">
                                  {place.neighborhood?.trim()
                                    ? place.neighborhood
                                    : `Tract ${place.tract_id}`}
                                </div>

                                <div className="spot-subtitle">
                                  Risk score {place.risk_score.toFixed(2)} ·{" "}
                                  {place.risk_label}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  : liveGroups.map((group) => (
                      <div className="borough-spots-card" key={group.borough}>
                        <div className="borough-spots-header">{group.borough}</div>

                        <div className="spot-list">
                          {group.places.map((place) => (
                            <div
                              className="spot-row"
                              key={`${group.borough}-${place.rank_in_borough}-${place.place_name}`}
                            >
                              <div className="spot-rank">{place.rank_in_borough}</div>

                              <div className="spot-main">
                                <div className="spot-title">{place.place_name}</div>

                                <div className="spot-subtitle">
                                  {place.complaint_count} complaints ·{" "}
                                  {place.impact_label}
                                </div>

                                <div className="spot-meta">
                                  Last seen {formatTimestamp(place.last_seen)}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
              </div>
            )}
          </article>
        </section>
      </main>
    </div>
  );
}