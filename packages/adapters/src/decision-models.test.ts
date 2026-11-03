import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decisionModel,
  decisionModelCatalog,
  resetGatewayDecisionModelCacheForTests,
} from "./decision-models.js";

beforeEach(() => {
  resetGatewayDecisionModelCacheForTests();
});

describe("decisionModelCatalog", () => {
  it("keeps the existing OpenRouter entry", async () => {
    const catalog = await decisionModelCatalog(vi.fn().mockRejectedValue(new Error("offline")));
    expect(catalog).toContainEqual(
      expect.objectContaining({
        provider: "openrouter",
        id: "typesafe/jev-1.14",
        protocol: "decisions",
      }),
    );
  });

  it("filters Gateway's catalog to evaluation-type models on a successful fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "typesafe-ai/jev-1.14.0",
              type: "evaluation",
              name: "Jev 1.14.0",
              pricing: { input: "0.00000042" },
            },
            { id: "openai/gpt-4", type: "language" },
          ],
        }),
      ),
    );
    const catalog = await decisionModelCatalog(fetchMock);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ai-gateway.vercel.sh/v1/models",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(catalog).toContainEqual(
      expect.objectContaining({
        provider: "vercel-ai-gateway",
        id: "typesafe-ai/jev-1.14.0",
        label: "Jev 1.14.0 (Vercel AI Gateway)",
        protocol: "decisions",
      }),
    );
    expect(catalog.some((entry) => entry.id === "openai/gpt-4")).toBe(false);
  });

  it("falls back to the seed list when the fetch fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const catalog = await decisionModelCatalog(fetchMock);
    expect(catalog).toContainEqual(
      expect.objectContaining({ provider: "vercel-ai-gateway", id: "typesafe-ai/jev" }),
    );
    expect(catalog).toContainEqual(
      expect.objectContaining({ provider: "vercel-ai-gateway", id: "typesafe-ai/jev-1.14.0" }),
    );
  });

  it("honors the cache: a second call within the TTL does not refetch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "typesafe-ai/jev", type: "evaluation" }] })),
      );
    await decisionModelCatalog(fetchMock);
    await decisionModelCatalog(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("decisionModel", () => {
  it("looks up pricing for a cached Gateway model synchronously", async () => {
    await decisionModelCatalog(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: "typesafe-ai/jev", type: "evaluation", pricing: { input: "0.00000042" } }],
          }),
        ),
      ),
    );
    expect(decisionModel("vercel-ai-gateway", "typesafe-ai/jev")).toMatchObject({
      provider: "vercel-ai-gateway",
      id: "typesafe-ai/jev",
    });
  });
});
