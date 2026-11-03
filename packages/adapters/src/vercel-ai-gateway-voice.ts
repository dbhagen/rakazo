import type {
  AdapterContext,
  AdapterDescriptor,
  SecretStore,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import {
  DEFAULT_GATEWAY_STT_MODEL,
  DEFAULT_GATEWAY_TTS_MODEL,
  VERCEL_AI_GATEWAY_VOICE_PROVIDER_ID,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findConnectedModelCredential, loadStoredModelSecret } from "./model-selection.js";
import { parseModelSecret } from "./pi-oauth.js";
import {
  MAX_SYNTHESIZED_AUDIO_BYTES,
  readVoiceJson,
  voiceDeadline,
  voiceRequestError,
} from "./voice-http.js";

export {
  DEFAULT_GATEWAY_STT_MODEL,
  DEFAULT_GATEWAY_TTS_MODEL,
  VERCEL_AI_GATEWAY_VOICE_PROVIDER_ID,
};

const PROVIDER_NAME = "Vercel AI Gateway";
const GATEWAY = "https://ai-gateway.vercel.sh";
const GATEWAY_PROTOCOL_VERSION = "0.0.1";
const MAX_MODEL_ID_LENGTH = 200;
const MODEL_ID_PATTERN = /^[\w.:/@+-]+$/;

const LIST_MODELS_DEADLINE_MS = 15_000;
const SPEAK_DEADLINE_MS = 60_000;
const TRANSCRIBE_DEADLINE_MS = 60_000;

/** The Gateway has no voice list endpoint; these are the providers' built-in voices,
 *  proven in production by the self-hosted bridge this adapter replaces. */
const VOICES: Record<string, [id: string, name: string][]> = {
  elevenlabs: [
    ["JBFqnCBsd6RMkjVDRZzb", "George"],
    ["nPczCjzI2devNBz1zQrb", "Brian"],
    ["Xb7hH8MSUJpSbSDYk0k2", "Alice"],
    ["onwK4e9ZLuTAKqWW03F9", "Daniel"],
    ["XrExE9yKIg1WjnnlVkGX", "Matilda"],
    ["TX3LPaxmHKxFdv7VOQHJ", "Liam"],
    ["pFZP5JQG7iQjIQuC4Bku", "Lily"],
    ["IKne3meq5aSn9XLyUdCD", "Charlie"],
    ["cgSgspJ2msm6clMCkdW9", "Jessica"],
  ],
  openai: ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"].map(
    (id) => [id, id.charAt(0).toUpperCase() + id.slice(1)] as [string, string],
  ),
  google: ["Kore", "Puck", "Zephyr", "Charon", "Fenrir", "Aoede", "Leda", "Orus"].map(
    (id) => [id, id] as [string, string],
  ),
};

/** The model id's provider segment, e.g. "elevenlabs" from "elevenlabs/eleven-flash-v2.5". */
export function gatewayModelProvider(model: string): string {
  return String(model ?? "").split("/")[0] ?? "";
}

export function gatewayVoiceList(ttsModel: string): VoiceInfo[] {
  const list = VOICES[gatewayModelProvider(ttsModel)] ?? [];
  return list.map(([id, name]) => ({ id, label: name }));
}

export function gatewayDefaultVoiceId(ttsModel: string): string {
  return VOICES[gatewayModelProvider(ttsModel)]?.[0]?.[0] ?? "";
}

/**
 * What the encrypted voice secret holds. Never the Gateway key: it is read fresh from the
 * user's `vercel-ai-gateway` model connection on every call, so a rotated or removed
 * connection takes effect immediately, with nothing to leak if this secret is read.
 */
export interface VercelAiGatewayVoiceSecret {
  kind: "vercel_ai_gateway";
  ttsModel: string;
  sttModel: string;
}

function modelIdOrDefault(value: string | undefined, fallback: string, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  if (trimmed.length > MAX_MODEL_ID_LENGTH || !MODEL_ID_PATTERN.test(trimmed)) {
    throw new Error(`${label} model id is not valid.`);
  }
  return trimmed;
}

/**
 * The secret to store: only the chosen speech and transcription model ids, never the
 * Gateway key. Blank model ids keep the previously saved ones, falling back to the
 * proven defaults.
 */
export function serializeVercelAiGatewayVoiceSecret(
  input: { ttsModel?: string; sttModel?: string },
  previousPlaintext?: string,
): string {
  const previous = previousPlaintext ? tryParseSecret(previousPlaintext) : undefined;
  const secret: VercelAiGatewayVoiceSecret = {
    kind: "vercel_ai_gateway",
    ttsModel: modelIdOrDefault(
      input.ttsModel || previous?.ttsModel,
      DEFAULT_GATEWAY_TTS_MODEL,
      "Speech",
    ),
    sttModel: modelIdOrDefault(
      input.sttModel || previous?.sttModel,
      DEFAULT_GATEWAY_STT_MODEL,
      "Transcription",
    ),
  };
  return JSON.stringify(secret);
}

function tryParseSecret(plaintext: string): VercelAiGatewayVoiceSecret | undefined {
  try {
    return parseVercelAiGatewayVoiceSecret(plaintext);
  } catch {
    return undefined;
  }
}

/** Tolerant of an older saved secret that still has an `apiKey` field; it is ignored. */
export function parseVercelAiGatewayVoiceSecret(plaintext: string): VercelAiGatewayVoiceSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("Saved Vercel AI Gateway voice settings are unreadable. Connect it again.");
  }
  const record = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  if (record.kind !== "vercel_ai_gateway") {
    throw new Error("Saved Vercel AI Gateway voice settings are unreadable. Connect it again.");
  }
  return {
    kind: "vercel_ai_gateway",
    ttsModel: typeof record.ttsModel === "string" ? record.ttsModel : DEFAULT_GATEWAY_TTS_MODEL,
    sttModel: typeof record.sttModel === "string" ? record.sttModel : DEFAULT_GATEWAY_STT_MODEL,
  };
}

/** The non-secret part of a saved connection, for settings display. Never includes the key. */
export interface VercelAiGatewayVoiceServer {
  ttsModel: string;
  sttModel: string;
}

export function vercelAiGatewayVoiceServer(
  plaintext: string,
): VercelAiGatewayVoiceServer | undefined {
  const secret = tryParseSecret(plaintext);
  return secret ? { ttsModel: secret.ttsModel, sttModel: secret.sttModel } : undefined;
}

/** A Gateway model list entry, from `GET /v1/models`. */
interface GatewayModelListEntry {
  id: string;
  type?: string;
  owned_by?: string;
}

/** Vercel AI Gateway's live speech or transcription models; the list is public, no key needed. */
export async function listGatewayModels(
  kind: "speech" | "transcription",
  options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
): Promise<VoiceInfo[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const res = await doFetch(`${GATEWAY}/v1/models`, {
    signal: voiceDeadline(options.signal ?? new AbortController().signal, LIST_MODELS_DEADLINE_MS),
  });
  if (!res.ok) {
    throw voiceRequestError(res.status, PROVIDER_NAME, "listing models", await readVoiceJson(res));
  }
  const body = (await readVoiceJson(res, { requireValid: true })) as {
    data?: GatewayModelListEntry[];
  };
  const data = Array.isArray(body?.data) ? body.data : [];
  return data
    .filter((entry) => entry.type === kind)
    .map((entry) => ({ id: entry.id, label: entry.id, description: entry.owned_by }));
}

/** What the provider needs to resolve the Gateway key for a request; never kept past one call. */
export interface VercelAiGatewayVoiceDeps {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
}

const CONNECT_A_GATEWAY_MODEL = "Connect a Vercel AI Gateway model first.";

/**
 * Reads the Gateway key fresh from the owning user's `vercel-ai-gateway` model connection.
 * Called on every request, never cached: a rotated key takes effect on the next call, and
 * a removed connection fails clearly instead of falling back to a stale copy.
 */
export async function resolveVercelAiGatewayApiKey(
  deps: VercelAiGatewayVoiceDeps,
  actor: { userId: string; spaceId: string },
): Promise<string> {
  const credential = await findConnectedModelCredential(
    deps.prisma,
    deps.secretStore,
    actor,
    VERCEL_AI_GATEWAY_VOICE_PROVIDER_ID,
  );
  if (!credential) {
    throw new Error(CONNECT_A_GATEWAY_MODEL);
  }
  const stored = await loadStoredModelSecret(
    deps.prisma,
    deps.secretStore,
    actor.userId,
    credential.secretId,
  );
  if (stored.status !== "loaded") {
    throw new Error(CONNECT_A_GATEWAY_MODEL);
  }
  let secret: ReturnType<typeof parseModelSecret>;
  try {
    secret = parseModelSecret(stored.plaintext);
  } catch {
    throw new Error(CONNECT_A_GATEWAY_MODEL);
  }
  if (secret.kind !== "api_key" || !secret.key) {
    throw new Error(CONNECT_A_GATEWAY_MODEL);
  }
  return secret.key;
}

function gatewayHeaders(kind: "speech" | "transcription", model: string, apiKey: string) {
  return {
    authorization: `Bearer ${apiKey}`,
    "ai-gateway-protocol-version": GATEWAY_PROTOCOL_VERSION,
    [`ai-${kind}-model-specification-version`]: "4",
    "ai-model-id": model,
    "content-type": "application/json",
  };
}

/**
 * Vercel AI Gateway, called directly for speech and transcription. The `apiKey` argument
 * carries the serialized {@link VercelAiGatewayVoiceSecret} (model ids only); the real
 * Gateway key is resolved fresh on every call from the context's user's
 * `vercel-ai-gateway` model connection, never stored or cached.
 */
export class VercelAiGatewayVoiceProvider implements VoiceProvider {
  constructor(
    private readonly deps: VercelAiGatewayVoiceDeps,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: VERCEL_AI_GATEWAY_VOICE_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  /** Checks the saved voice settings parse and that a Gateway model connection still exists. */
  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    try {
      parseVercelAiGatewayVoiceSecret(apiKey);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    try {
      await resolveVercelAiGatewayApiKey(this.deps, context);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  async listVoices(apiKey: string, _context: AdapterContext): Promise<VoiceInfo[]> {
    const secret = parseVercelAiGatewayVoiceSecret(apiKey);
    return gatewayVoiceList(secret.ttsModel);
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const secret = parseVercelAiGatewayVoiceSecret(request.apiKey);
    const apiKey = await resolveVercelAiGatewayApiKey(this.deps, context);
    const signal = voiceDeadline(request.signal ?? context.signal, SPEAK_DEADLINE_MS);
    const model = request.model || secret.ttsModel;
    const voice = request.voiceId || gatewayDefaultVoiceId(model);
    const res = await this.fetchImpl(`${GATEWAY}/v4/ai/speech-model`, {
      method: "POST",
      headers: gatewayHeaders("speech", model, apiKey),
      body: JSON.stringify({
        text: request.text,
        ...(voice ? { voice } : {}),
        outputFormat: "mp3",
      }),
      signal,
    });
    if (!res.ok) {
      throw voiceRequestError(res.status, PROVIDER_NAME, "speaking", await readVoiceJson(res));
    }
    const body = (await readVoiceJson(res, { requireValid: true })) as { audio?: unknown };
    if (typeof body.audio !== "string") {
      throw new Error(`${PROVIDER_NAME} returned no audio.`);
    }
    const bytes = base64ToBytes(body.audio);
    if (bytes.byteLength > MAX_SYNTHESIZED_AUDIO_BYTES) {
      throw new Error("Voice response is too large.");
    }
    return { bytes, mimeType: "audio/mpeg" };
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    const secret = parseVercelAiGatewayVoiceSecret(request.apiKey);
    const apiKey = await resolveVercelAiGatewayApiKey(this.deps, context);
    const signal = voiceDeadline(request.signal ?? context.signal, TRANSCRIBE_DEADLINE_MS);
    const model = secret.sttModel;
    const mediaType = (request.mimeType || "audio/webm").split(";")[0]?.trim() || "audio/webm";
    const res = await this.fetchImpl(`${GATEWAY}/v4/ai/transcription-model`, {
      method: "POST",
      headers: gatewayHeaders("transcription", model, apiKey),
      body: JSON.stringify({
        audio: Buffer.from(request.audio).toString("base64"),
        mediaType,
      }),
      signal,
    });
    if (!res.ok) {
      throw voiceRequestError(res.status, PROVIDER_NAME, "transcribing", await readVoiceJson(res));
    }
    const body = (await readVoiceJson(res, { requireValid: true })) as { text?: unknown };
    return { text: String(body.text ?? "").trim() };
  }
}

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}
