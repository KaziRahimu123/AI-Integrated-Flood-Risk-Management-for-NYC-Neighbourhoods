export type RiskLevel = "Low" | "Medium" | "High";

export type Region = {
  id: string;
  geoid: string;
  tractName: string;
  borough: string;
  neighborhood: string;
  riskScore: number;
  riskLevel: RiskLevel;
  highPct: number;
  mediumPct: number;
  latestComplaints: number | null;
  recommendation: string;
};

export type SearchLocation = {
  query: string;
  label: string;
  shortLabel: string;
  lat: number;
  lon: number;
};

export type FloodRiskMapProps = {
  regions: Region[];
  selectedRegionId: string | null;
  onSelectRegion: (regionId: string) => void;
  analysisRun: number;
  searchText: string;
  selectedBorough: string;
  searchResult: SearchLocation | null;
};