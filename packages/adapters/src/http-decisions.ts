import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentUsage,
  DecisionProvider,
  DecisionProviderOptions,
  DecisionRequest,
  DecisionResult,
} from "@rakazo/adapter-kit";
import { DecisionProviderError } from "@rakazo/adapter-kit";
import { z } from "zod";
import { decisionModel } from "./decision-models.js";
import { readBodyCapped } from "./web-ssrf.js";

const answerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});
const responseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

/**
 * Vercel AI Gateway documents a "choice" question (decision-fallbacks) with the same
 * shape Rakazo's DecisionQuestion already carries: {type, instructions, criteria}. The
 * request passes straight through; only `state` needs stringifying.
 */
function toGatewayRequest(request: DecisionRequest): {
  model: string;
  state: string;
  questions: DecisionRequest["questions"];
} {
  return {
    model: request.model,
    state: JSON.stringify(request.state),
    questions: request.questions,
  };
}

const gatewayAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  // A fallback language model that could not answer reports confidence 0 with no
  // probabilities: a sentinel for "unknown", not a measured zero. It still compares
  // below minConfidence, so callers ask instead of trusting it; it must not throw.
  confidence: z.number().min(0).max(1).optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
});
const gatewayProviderMetadataSchema = z.object({
  gateway: z
    .object({
      cost: z.string().optional(),
      generationId: z.string().optional(),
    })
    .optional(),
});
const gatewayResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  providerMetadata: gatewayProviderMetadataSchema.optional(),
  provider_metadata: gatewayProviderMetadataSchema.optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

function fromGatewayAnswers(
  request: DecisionRequest,
  rawAnswers: Record<string, unknown>,
): DecisionResult["answers"] {
  const answers: DecisionResult["answers"] = {};
  for (const [questionId, question] of Object.entries(request.questions)) {
    const answer = gatewayAnswerSchema.safeParse(rawAnswers[questionId]);
    if (!answer.success || !Object.hasOwn(question.criteria, answer.data.choice))
      throw new DecisionProviderError("invalid_response");
    answers[questionId] = {
      type: "choice",
      choice: answer.data.choice,
      confidence: answer.data.confidence,
    };
  }
  return answers;
}

/** Three implementations of the same decision protocol; endpoint and auth never come from model output. */
export class HttpDecisionProvider implements DecisionProvider {
  constructor(
    private readonly provider: "openrouter" | "typesafe" | "vercel-ai-gateway",
    private readonly options: DecisionProviderOptions,
  ) {
    if (!options.apiKey.trim()) throw new DecisionProviderError("authentication");
  }

  async decide(request: DecisionRequest, context: AdapterContext): Promise<DecisionResult> {
    context.signal.throwIfAborted();
    const isGateway = this.provider === "vercel-ai-gateway";
    const body = JSON.stringify(isGateway ? toGatewayRequest(request) : request);
    const callId = randomUUID();
    const pricing = decisionModel(this.provider, request.model);
    // Byte count plus a generous protocol allowance bounds tokenizer expansion.
    const inputTokensEstimate = Buffer.byteLength(body, "utf8") + 4096;
    const reservation = await this.options.callObserver?.beforeCall({
      callId,
      runId: context.runId,
      provider: this.provider,
      modelId: request.model,
      operationKind: "setup",
      inputTokensEstimate,
      maxOutputTokens: 0,
      maxCostUsd: pricing
        ? (inputTokensEstimate * pricing.inputUsdPerMillion) / 1_000_000
        : undefined,
    });
    let usage: AgentUsage | null = null;
    try {
      const response = await (this.options.fetch ?? fetch)(
        this.provider === "openrouter"
          ? "https://openrouter.ai/api/alpha/decisions"
          : this.provider === "typesafe"
            ? "https://api.typesafe.ai/v1/systemone"
            : "https://ai-gateway.vercel.sh/v1/evaluate",
        {
          method: "POST",
          redirect: "error",
          signal: context.signal,
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body,
        },
      );
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500)
          usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, usageSource: "provider-rejected" };
        void response.body?.cancel().catch(() => undefined);
        throw new DecisionProviderError(
          response.status === 401 || response.status === 403
            ? "authentication"
            : response.status === 422
              ? "invalid"
              : response.status === 429 || response.status === 529
                ? "busy"
                : "unavailable",
        );
      }
      const raw = JSON.parse(
        new TextDecoder().decode(await readBodyCapped(response, 64_000, context.signal)),
      );
      if (isGateway) {
        const parsed = gatewayResponseSchema.parse(raw);
        const metadata = parsed.providerMetadata ?? parsed.provider_metadata;
        const generationId = metadata?.gateway?.generationId;
        if (generationId && reservation)
          await this.options.callObserver?.onRequestId?.(reservation, generationId);
        const cost = metadata?.gateway?.cost;
        usage = {
          inputTokens: parsed.usage?.inputTokens ?? parsed.usage?.input_tokens ?? null,
          outputTokens: parsed.usage?.outputTokens ?? parsed.usage?.output_tokens ?? null,
          costUsd: cost !== undefined ? Number(cost) : null,
          costSource: cost !== undefined ? "provider-reported" : null,
          providerRequestId: generationId ?? null,
          usageSource: "response",
          operationKind: "setup",
        };
        const answers = fromGatewayAnswers(request, parsed.answers);
        return { model: parsed.model ?? request.model, answers, usage };
      }
      const parsed = responseSchema.parse(raw);
      if (parsed.id && reservation)
        await this.options.callObserver?.onRequestId?.(reservation, parsed.id);
      usage = {
        inputTokens: parsed.usage?.input_tokens ?? null,
        outputTokens: parsed.usage?.output_tokens ?? null,
        costUsd: parsed.usage?.cost ?? null,
        costSource: parsed.usage?.cost === undefined ? null : "provider-reported",
        providerRequestId: parsed.id ?? null,
        usageSource: "response",
        operationKind: "setup",
      };
      const answers: DecisionResult["answers"] = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const answer = answerSchema.safeParse(parsed.answers[id]);
        if (!answer.success || !Object.hasOwn(question.criteria, answer.data.choice))
          throw new DecisionProviderError("invalid_response");
        answers[id] = answer.data;
      }
      return { model: parsed.model ?? request.model, answers, usage };
    } catch (error) {
      if (error instanceof DecisionProviderError) throw error;
      // Transport and validation errors can contain credentials or supplied state.
      throw new DecisionProviderError("unavailable");
    } finally {
      try {
        if (usage)
          await this.options.onUsage?.({
            type: "usage",
            ...usage,
            provider: this.provider,
            model: request.model,
            callId,
          });
      } finally {
        if (reservation) await this.options.callObserver?.afterCall(reservation, usage);
      }
    }
  }
}
