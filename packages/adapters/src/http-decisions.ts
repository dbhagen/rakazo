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
 * Vercel AI Gateway's native decision protocol has no multi-choice question, only
 * booleans. Each Rakazo criteria choice becomes one boolean question (key
 * "<questionId>__<choice>"); the choice with the highest reported probability wins and
 * that probability stands in for confidence. This fan-out trades one round trip for a
 * shape Gateway documents today; swap in a native "choice" question if Gateway adds one.
 */
function gatewayFanoutKey(questionId: string, choice: string): string {
  return `${questionId}__${choice}`;
}

function toGatewayRequest(request: DecisionRequest): {
  model: string;
  state: string;
  questions: Record<string, { type: "boolean"; instructions: string }>;
} {
  const questions: Record<string, { type: "boolean"; instructions: string }> = {};
  for (const [questionId, question] of Object.entries(request.questions)) {
    for (const [choice, description] of Object.entries(question.criteria)) {
      questions[gatewayFanoutKey(questionId, choice)] = {
        type: "boolean",
        instructions: `${question.instructions} Answer true only if "${choice}" is the best choice: ${description}`,
      };
    }
  }
  return { model: request.model, state: JSON.stringify(request.state), questions };
}

const gatewayAnswerSchema = z.object({
  type: z.literal("boolean"),
  probability: z.number().min(0).max(1),
});
const gatewayResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), z.unknown()),
  providerMetadata: z
    .object({
      gateway: z
        .object({
          cost: z.string().optional(),
          generationId: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

function fromGatewayAnswers(
  request: DecisionRequest,
  rawAnswers: Record<string, unknown>,
): DecisionResult["answers"] {
  const answers: DecisionResult["answers"] = {};
  for (const [questionId, question] of Object.entries(request.questions)) {
    let best: { choice: string; probability: number } | undefined;
    for (const choice of Object.keys(question.criteria)) {
      const parsed = gatewayAnswerSchema.safeParse(
        rawAnswers[gatewayFanoutKey(questionId, choice)],
      );
      if (!parsed.success) throw new DecisionProviderError("invalid_response");
      if (!best || parsed.data.probability > best.probability)
        best = { choice, probability: parsed.data.probability };
    }
    if (!best) throw new DecisionProviderError("invalid_response");
    answers[questionId] = { type: "choice", choice: best.choice, confidence: best.probability };
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
        const generationId = parsed.providerMetadata?.gateway?.generationId;
        if (generationId && reservation)
          await this.options.callObserver?.onRequestId?.(reservation, generationId);
        const cost = parsed.providerMetadata?.gateway?.cost;
        usage = {
          inputTokens: parsed.usage?.inputTokens ?? null,
          outputTokens: parsed.usage?.outputTokens ?? null,
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
