import type { ModelCatalogEntry } from "@rakazo/contracts";

type DecisionModelEntry = {
  provider: string;
  providerName: string;
  id: string;
  label: string;
  inputUsdPerMillion: number;
};

/** Protocol/pricing belongs to the adapter catalog, never approval policy. */
const openrouterModels: DecisionModelEntry[] = [
  {
    provider: "openrouter",
    providerName: "OpenRouter",
    id: "typesafe/jev-1.14",
    label: "Jev 1.14",
    inputUsdPerMillion: 0.042,
  },
];

const GATEWAY_PROVIDER = "vercel-ai-gateway";
const GATEWAY_PROVIDER_NAME = "Vercel AI Gateway";
const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const GATEWAY_CACHE_TTL_MS = 60 * 60 * 1000;
const GATEWAY_FETCH_TIMEOUT_MS = 2_000;
const DEFAULT_GATEWAY_INPUT_USD_PER_MILLION = 0.042;

/** Seed list used until the first successful catalog fetch, and whenever it fails. */
const GATEWAY_SEED_MODELS: DecisionModelEntry[] = [
  {
    provider: GATEWAY_PROVIDER,
    providerName: GATEWAY_PROVIDER_NAME,
    id: "typesafe-ai/jev",
    label: "Jev (Vercel AI Gateway)",
    inputUsdPerMillion: DEFAULT_GATEWAY_INPUT_USD_PER_MILLION,
  },
  {
    provider: GATEWAY_PROVIDER,
    providerName: GATEWAY_PROVIDER_NAME,
    id: "typesafe-ai/jev-1.14.0",
    label: "Jev 1.14.0 (Vercel AI Gateway)",
    inputUsdPerMillion: DEFAULT_GATEWAY_INPUT_USD_PER_MILLION,
  },
];

let gatewayCache: DecisionModelEntry[] = GATEWAY_SEED_MODELS;
let gatewayCacheExpiresAt = 0;
let gatewayFetchInFlight: Promise<DecisionModelEntry[]> | null = null;

function gatewayModelLabel(record: Record<string, unknown>, id: string): string {
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
  return `${name} (${GATEWAY_PROVIDER_NAME})`;
}

function gatewayModelInputPrice(record: Record<string, unknown>): number {
  const pricing = record.pricing;
  if (pricing && typeof pricing === "object") {
    const input = (pricing as Record<string, unknown>).input;
    const perToken = typeof input === "string" ? Number(input) : undefined;
    if (perToken !== undefined && Number.isFinite(perToken)) return perToken * 1_000_000;
  }
  return DEFAULT_GATEWAY_INPUT_USD_PER_MILLION;
}

async function fetchGatewayDecisionModels(fetchImpl: typeof fetch): Promise<DecisionModelEntry[]> {
  try {
    const response = await fetchImpl(GATEWAY_MODELS_URL, {
      signal: AbortSignal.timeout(GATEWAY_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return GATEWAY_SEED_MODELS;
    const payload = (await response.json()) as { data?: unknown };
    const entries = Array.isArray(payload.data) ? payload.data : [];
    const models: DecisionModelEntry[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (record.type !== "evaluation") continue;
      const id = typeof record.id === "string" ? record.id : undefined;
      if (!id) continue;
      models.push({
        provider: GATEWAY_PROVIDER,
        providerName: GATEWAY_PROVIDER_NAME,
        id,
        label: gatewayModelLabel(record, id),
        inputUsdPerMillion: gatewayModelInputPrice(record),
      });
    }
    return models.length > 0 ? models : GATEWAY_SEED_MODELS;
  } catch {
    return GATEWAY_SEED_MODELS;
  }
}

/**
 * Gateway's decision models, cached for an hour; a failed or slow (>2s) fetch falls back
 * to the current cache (the seed list on a cold start).
 */
async function gatewayDecisionModels(
  fetchImpl: typeof fetch = fetch,
): Promise<DecisionModelEntry[]> {
  if (Date.now() < gatewayCacheExpiresAt) return gatewayCache;
  if (!gatewayFetchInFlight) {
    gatewayFetchInFlight = fetchGatewayDecisionModels(fetchImpl).then((models) => {
      gatewayCache = models;
      gatewayCacheExpiresAt = Date.now() + GATEWAY_CACHE_TTL_MS;
      gatewayFetchInFlight = null;
      return models;
    });
  }
  return gatewayFetchInFlight;
}

export function decisionModel(provider: string, id: string): DecisionModelEntry | undefined {
  if (provider === GATEWAY_PROVIDER) return gatewayCache.find((model) => model.id === id);
  return openrouterModels.find((model) => model.provider === provider && model.id === id);
}

export async function decisionModelCatalog(fetchImpl?: typeof fetch): Promise<ModelCatalogEntry[]> {
  const gatewayModels = await gatewayDecisionModels(fetchImpl);
  return [...openrouterModels, ...gatewayModels].map((model) => ({
    provider: model.provider,
    providerName: model.providerName,
    id: model.id,
    label: model.label,
    protocol: "decisions",
    billing: "Uses your API key",
    auth: "api-key",
  }));
}

/** Test-only: resets the in-memory Gateway catalog cache. */
export function resetGatewayDecisionModelCacheForTests(): void {
  gatewayCache = GATEWAY_SEED_MODELS;
  gatewayCacheExpiresAt = 0;
  gatewayFetchInFlight = null;
}

export { GATEWAY_PROVIDER as VERCEL_AI_GATEWAY_DECISION_PROVIDER, GATEWAY_SEED_MODELS };
