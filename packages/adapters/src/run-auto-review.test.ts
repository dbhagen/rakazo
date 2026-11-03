import { recordUsage } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionAutoReviewProvider } from "./decision-auto-review.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { HttpDecisionProvider } from "./http-decisions.js";
import { findConnectedModelCredential } from "./model-selection.js";
import { resolveModelKey } from "./run-model.js";

vi.mock("@rakazo/db", () => ({ recordUsage: vi.fn() }));
vi.mock("./model-selection.js", () => ({
  findConnectedModelCredential: vi.fn(),
  hasHostedModelCredits: vi.fn(async () => false),
}));
vi.mock("./run-model.js", () => ({
  resolveModelKey: vi.fn(async () => ({ apiKey: "gateway-key" })),
}));

const { autoReviewCheckerProvider } = await import("./run-auto-review.js");

beforeEach(() => {
  vi.mocked(findConnectedModelCredential).mockReset();
  vi.mocked(resolveModelKey)
    .mockReset()
    .mockResolvedValue({ apiKey: "gateway-key" } as never);
  vi.mocked(recordUsage).mockReset();
});

const deps = { prisma: {}, secretStore: {}, runtime: {} } as unknown as ExecutorDeps;
const scope = { runId: "run", spaceId: "space", userId: "user", botId: "bot", threadId: "thread" };

describe("autoReviewCheckerProvider", () => {
  it("builds a Gateway-backed DecisionAutoReviewProvider for vercel-ai-gateway + a decision model", async () => {
    vi.mocked(findConnectedModelCredential).mockResolvedValue({
      id: "cred",
      secretId: "secret",
    } as never);
    const provider = await autoReviewCheckerProvider(
      deps,
      scope,
      { memberChecker: false, registerSecrets: vi.fn() },
      { provider: "vercel-ai-gateway", model: "typesafe-ai/jev" },
    );
    expect(provider).toBeInstanceOf(DecisionAutoReviewProvider);
    const inner = (provider as unknown as { options: { provider: unknown } }).options.provider;
    expect(inner).toBeInstanceOf(HttpDecisionProvider);
    expect((inner as unknown as { provider: string }).provider).toBe("vercel-ai-gateway");
  });
});
