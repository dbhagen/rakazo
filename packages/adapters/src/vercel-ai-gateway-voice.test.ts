import { VoiceAccountError } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gatewayVoiceList,
  listGatewayModels,
  parseVercelAiGatewayVoiceSecret,
  resolveVercelAiGatewayApiKey,
  serializeVercelAiGatewayVoiceSecret,
  VercelAiGatewayVoiceProvider,
  vercelAiGatewayVoiceServer,
} from "./vercel-ai-gateway-voice.js";

const ctx = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const secret = serializeVercelAiGatewayVoiceSecret({});
const customSecret = serializeVercelAiGatewayVoiceSecret({
  ttsModel: "openai/tts-1",
  sttModel: "openai/whisper-1",
});

/**
 * A minimal `prisma`/`secretStore` pair that resolves the user's `vercel-ai-gateway` model
 * connection to `key`, or to nothing when `key` is undefined (simulating a removed
 * connection). The resolver reads this fresh on every call; nothing here is cached.
 */
function gatewayModelDeps(key: string | undefined) {
  const credential = key
    ? {
        id: "model-cred-1",
        userId: "u",
        provider: "vercel-ai-gateway",
        label: "Gateway",
        secretId: "model-secret-1",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }
    : null;
  const prisma = {
    userModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
    userModelCredential: { findMany: vi.fn().mockResolvedValue(credential ? [credential] : []) },
    secret: {
      findFirst: vi
        .fn()
        .mockResolvedValue(credential ? { id: "model-secret-1", ciphertext: "cipher" } : null),
    },
  };
  const secretStore = {
    load: vi.fn().mockResolvedValue(JSON.stringify({ kind: "api_key", key })),
  };
  return { prisma, secretStore } as unknown as Parameters<typeof resolveVercelAiGatewayApiKey>[0];
}

const NO_KEY = Symbol("no gateway model connection");

function provider(fetchMock: ReturnType<typeof vi.fn>, key: string | typeof NO_KEY = "gw-key") {
  return new VercelAiGatewayVoiceProvider(
    gatewayModelDeps(key === NO_KEY ? undefined : key),
    fetchMock as unknown as typeof fetch,
  );
}

function calledUrl(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return String(fetchMock.mock.calls[call]?.[0]);
}

function calledInit(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return fetchMock.mock.calls[call]?.[1] as RequestInit;
}

afterEach(() => vi.unstubAllGlobals());

describe("serializeVercelAiGatewayVoiceSecret / parseVercelAiGatewayVoiceSecret", () => {
  it("fills the ElevenLabs defaults proven by the bridge, and never stores a key", () => {
    expect(parseVercelAiGatewayVoiceSecret(secret)).toEqual({
      kind: "vercel_ai_gateway",
      ttsModel: "elevenlabs/eleven-flash-v2.5",
      sttModel: "elevenlabs/scribe-v2",
    });
    expect(secret).not.toContain("gw-key");
    expect(JSON.parse(secret)).not.toHaveProperty("apiKey");
  });

  it("tolerates an old saved secret that still has an apiKey field, ignoring it", () => {
    const old = JSON.stringify({
      kind: "vercel_ai_gateway",
      apiKey: "stale-key",
      ttsModel: "openai/tts-1",
      sttModel: "openai/whisper-1",
    });
    expect(parseVercelAiGatewayVoiceSecret(old)).toEqual({
      kind: "vercel_ai_gateway",
      ttsModel: "openai/tts-1",
      sttModel: "openai/whisper-1",
    });
  });

  it("rejects model ids that are not plain identifiers", () => {
    expect(() => serializeVercelAiGatewayVoiceSecret({ ttsModel: "bad\nheader: 1" })).toThrow(
      /Speech model id is not valid/,
    );
  });

  it("keeps the previously saved models when blank", () => {
    const again = parseVercelAiGatewayVoiceSecret(
      serializeVercelAiGatewayVoiceSecret({}, customSecret),
    );
    expect(again).toMatchObject({ ttsModel: "openai/tts-1", sttModel: "openai/whisper-1" });
  });

  it("never exposes a key through the server display", () => {
    expect(vercelAiGatewayVoiceServer(customSecret)).toEqual({
      ttsModel: "openai/tts-1",
      sttModel: "openai/whisper-1",
    });
  });
});

describe("resolveVercelAiGatewayApiKey", () => {
  it("reads the key fresh from the model connection on every call", async () => {
    const deps = gatewayModelDeps("gw-key-1");
    expect(await resolveVercelAiGatewayApiKey(deps, ctx)).toBe("gw-key-1");
  });

  it("picks up a rotated key on the next call without caching the old one", async () => {
    const deps = gatewayModelDeps("gw-key-1");
    expect(await resolveVercelAiGatewayApiKey(deps, ctx)).toBe("gw-key-1");
    (deps as unknown as { secretStore: { load: ReturnType<typeof vi.fn> } }).secretStore.load = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ kind: "api_key", key: "gw-key-2" }));
    expect(await resolveVercelAiGatewayApiKey(deps, ctx)).toBe("gw-key-2");
  });

  it("fails clearly when the model connection is gone", async () => {
    const deps = gatewayModelDeps(undefined);
    await expect(resolveVercelAiGatewayApiKey(deps, ctx)).rejects.toThrow(
      "Connect a Vercel AI Gateway model first.",
    );
  });

  it("fails clearly when the model connection is not an api_key connection", async () => {
    const deps = gatewayModelDeps("gw-key-1");
    (deps as unknown as { secretStore: { load: ReturnType<typeof vi.fn> } }).secretStore.load = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ kind: "oauth", reconnectRequired: true }));
    await expect(resolveVercelAiGatewayApiKey(deps, ctx)).rejects.toThrow(
      "Connect a Vercel AI Gateway model first.",
    );
  });
});

describe("gatewayVoiceList", () => {
  it("lists ElevenLabs' built-in voices, George first", () => {
    const voices = gatewayVoiceList("elevenlabs/eleven-flash-v2.5");
    expect(voices[0]).toMatchObject({ id: "JBFqnCBsd6RMkjVDRZzb", label: "George" });
    expect(voices.length).toBeGreaterThan(1);
  });

  it("lists OpenAI's built-in voices for an OpenAI Gateway model", () => {
    const voices = gatewayVoiceList("openai/gpt-4o-mini-tts");
    expect(voices.map((voice) => voice.id)).toContain("alloy");
  });

  it("is empty for a model from a provider with no known voice list", () => {
    expect(gatewayVoiceList("unknown-provider/some-model")).toEqual([]);
  });
});

describe("VercelAiGatewayVoiceProvider", () => {
  it("verify checks the saved secret parses and that a Gateway model connection exists", async () => {
    const fetchMock = vi.fn();
    const result = await provider(fetchMock, "gw-key").verify(secret, ctx);
    expect(result).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await provider(fetchMock, "gw-key").verify("not json", ctx)).toMatchObject({
      ok: false,
    });
    expect(await provider(fetchMock, NO_KEY).verify(secret, ctx)).toMatchObject({
      ok: false,
      message: "Connect a Vercel AI Gateway model first.",
    });
  });

  it("lists the saved speech model's voices without a network call", async () => {
    const fetchMock = vi.fn();
    const voices = await provider(fetchMock).listVoices(secret, ctx);
    expect(voices.map((voice) => voice.id)).toContain("JBFqnCBsd6RMkjVDRZzb");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the Gateway speech-model request with a key read fresh from the model connection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ audio: Buffer.from([1, 2, 3]).toString("base64") }), {
        status: 200,
      }),
    );
    const clip = await provider(fetchMock, "gw-key").synthesize(
      { apiKey: secret, voiceId: "", text: "Hello" },
      ctx,
    );
    expect(clip).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg" });
    expect(calledUrl(fetchMock)).toBe("https://ai-gateway.vercel.sh/v4/ai/speech-model");
    const init = calledInit(fetchMock);
    expect(init.headers).toMatchObject({
      authorization: "Bearer gw-key",
      "ai-gateway-protocol-version": "0.0.1",
      "ai-speech-model-specification-version": "4",
      "ai-model-id": "elevenlabs/eleven-flash-v2.5",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      text: "Hello",
      voice: "JBFqnCBsd6RMkjVDRZzb",
      outputFormat: "mp3",
    });
  });

  it("uses a rotated model-connection key on the very next synthesize call", async () => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(JSON.stringify({ audio: Buffer.from([1]).toString("base64") }), {
          status: 200,
        }),
    );
    const deps = gatewayModelDeps("gw-key-old");
    const instance = new VercelAiGatewayVoiceProvider(deps, fetchMock as unknown as typeof fetch);
    await instance.synthesize({ apiKey: secret, voiceId: "", text: "hi" }, ctx);
    expect(calledInit(fetchMock, 0).headers).toMatchObject({ authorization: "Bearer gw-key-old" });

    (deps as unknown as { secretStore: { load: ReturnType<typeof vi.fn> } }).secretStore.load = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ kind: "api_key", key: "gw-key-new" }));
    await instance.synthesize({ apiKey: secret, voiceId: "", text: "hi again" }, ctx);
    expect(calledInit(fetchMock, 1).headers).toMatchObject({ authorization: "Bearer gw-key-new" });
  });

  it("fails clearly, without a network call, once the model connection is removed", async () => {
    const fetchMock = vi.fn();
    await expect(
      provider(fetchMock, NO_KEY).synthesize({ apiKey: secret, voiceId: "", text: "hi" }, ctx),
    ).rejects.toThrow("Connect a Vercel AI Gateway model first.");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      provider(fetchMock, NO_KEY).transcribe(
        { apiKey: secret, audio: new Uint8Array([1]), mimeType: "audio/wav" },
        ctx,
      ),
    ).rejects.toThrow("Connect a Vercel AI Gateway model first.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the requested voice id over the provider default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ audio: Buffer.from([1]).toString("base64") }), {
        status: 200,
      }),
    );
    await provider(fetchMock).synthesize(
      { apiKey: secret, voiceId: "nPczCjzI2devNBz1zQrb", text: "Hi" },
      ctx,
    );
    expect(JSON.parse(String(calledInit(fetchMock).body))).toMatchObject({
      voice: "nPczCjzI2devNBz1zQrb",
    });
  });

  it("sends the Gateway transcription-model request with base64 audio and media type", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ text: "hello there" }), { status: 200 }));
    const result = await provider(fetchMock).transcribe(
      { apiKey: secret, audio: new Uint8Array([9, 9]), mimeType: "audio/wav" },
      ctx,
    );
    expect(result).toEqual({ text: "hello there" });
    expect(calledUrl(fetchMock)).toBe("https://ai-gateway.vercel.sh/v4/ai/transcription-model");
    const init = calledInit(fetchMock);
    expect(init.headers).toMatchObject({
      "ai-transcription-model-specification-version": "4",
      "ai-model-id": "elevenlabs/scribe-v2",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      audio: Buffer.from([9, 9]).toString("base64"),
      mediaType: "audio/wav",
    });
  });

  it.each([
    [401, "rejects"],
    [429, "limit"],
    [500, "failed"],
  ])("maps a Gateway %s into a readable error", async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: "nope" } }), { status }));
    await expect(
      provider(fetchMock).synthesize({ apiKey: secret, voiceId: "", text: "hi" }, ctx),
    ).rejects.toThrow();
  });

  it("raises a VoiceAccountError on a rejected key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 }),
      );
    await expect(
      provider(fetchMock).synthesize({ apiKey: secret, voiceId: "", text: "hi" }, ctx),
    ).rejects.toBeInstanceOf(VoiceAccountError);
  });

  it("aborts the request when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
      });
    });
    const result = provider(fetchMock).synthesize(
      { apiKey: secret, voiceId: "", text: "hi", signal: controller.signal },
      ctx,
    );
    // Resolving the Gateway key is now async, so give it a turn before the request
    // starts and the abort listener attaches.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    controller.abort();
    await expect(result).rejects.toThrow();
  });
});

describe("listGatewayModels", () => {
  it("filters the public models list by type, with no authorization header", async () => {
    const body = JSON.stringify({
      data: [
        { id: "elevenlabs/eleven-flash-v2.5", type: "speech", owned_by: "elevenlabs" },
        { id: "elevenlabs/scribe-v2", type: "transcription", owned_by: "elevenlabs" },
        { id: "openai/gpt-4o", type: "language", owned_by: "openai" },
      ],
    });
    const fetchMock = vi.fn().mockImplementation(() => new Response(body, { status: 200 }));
    const speech = await listGatewayModels("speech", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(speech).toEqual([
      {
        id: "elevenlabs/eleven-flash-v2.5",
        label: "elevenlabs/eleven-flash-v2.5",
        description: "elevenlabs",
      },
    ]);
    expect(calledUrl(fetchMock)).toBe("https://ai-gateway.vercel.sh/v1/models");
    expect(calledInit(fetchMock).headers).toBeUndefined();
    const transcription = await listGatewayModels("transcription", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(transcription.map((model) => model.id)).toEqual(["elevenlabs/scribe-v2"]);
  });

  it("fails clearly when the Gateway models list cannot be read", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Service Unavailable", { status: 503 }));
    await expect(
      listGatewayModels("speech", { fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow();
  });
});
