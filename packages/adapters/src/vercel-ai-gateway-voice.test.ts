import { VoiceAccountError } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gatewayVoiceList,
  listGatewayModels,
  parseVercelAiGatewayVoiceSecret,
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

const secret = serializeVercelAiGatewayVoiceSecret({ apiKey: "gw-key" });
const customSecret = serializeVercelAiGatewayVoiceSecret({
  apiKey: "gw-key",
  ttsModel: "openai/tts-1",
  sttModel: "openai/whisper-1",
});

function provider(fetchMock: ReturnType<typeof vi.fn>) {
  return new VercelAiGatewayVoiceProvider(fetchMock as unknown as typeof fetch);
}

function calledUrl(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return String(fetchMock.mock.calls[call]?.[0]);
}

function calledInit(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return fetchMock.mock.calls[call]?.[1] as RequestInit;
}

afterEach(() => vi.unstubAllGlobals());

describe("serializeVercelAiGatewayVoiceSecret / parseVercelAiGatewayVoiceSecret", () => {
  it("fills the ElevenLabs defaults proven by the bridge", () => {
    expect(parseVercelAiGatewayVoiceSecret(secret)).toEqual({
      kind: "vercel_ai_gateway",
      apiKey: "gw-key",
      ttsModel: "elevenlabs/eleven-flash-v2.5",
      sttModel: "elevenlabs/scribe-v2",
    });
  });

  it("requires a key, since there is no separate Gateway voice key field", () => {
    expect(() => serializeVercelAiGatewayVoiceSecret({ apiKey: "" })).toThrow(
      "Connect a Vercel AI Gateway model first.",
    );
  });

  it("rejects model ids that are not plain identifiers", () => {
    expect(() =>
      serializeVercelAiGatewayVoiceSecret({ apiKey: "gw-key", ttsModel: "bad\nheader: 1" }),
    ).toThrow(/Speech model id is not valid/);
  });

  it("keeps the previously saved models when blank", () => {
    const again = parseVercelAiGatewayVoiceSecret(
      serializeVercelAiGatewayVoiceSecret({ apiKey: "gw-key-2" }, customSecret),
    );
    expect(again).toMatchObject({ ttsModel: "openai/tts-1", sttModel: "openai/whisper-1" });
  });

  it("never exposes the key through the server display", () => {
    expect(vercelAiGatewayVoiceServer(customSecret)).toEqual({
      ttsModel: "openai/tts-1",
      sttModel: "openai/whisper-1",
    });
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
  it("verify only checks that the saved secret parses; the key was verified by its model connection", async () => {
    const fetchMock = vi.fn();
    const result = await provider(fetchMock).verify(secret, ctx);
    expect(result).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await provider(fetchMock).verify("not json", ctx)).toMatchObject({ ok: false });
  });

  it("lists the saved speech model's voices without a network call", async () => {
    const fetchMock = vi.fn();
    const voices = await provider(fetchMock).listVoices(secret, ctx);
    expect(voices.map((voice) => voice.id)).toContain("JBFqnCBsd6RMkjVDRZzb");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the Gateway speech-model request and decodes the base64 audio", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ audio: Buffer.from([1, 2, 3]).toString("base64") }), {
        status: 200,
      }),
    );
    const clip = await provider(fetchMock).synthesize(
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
