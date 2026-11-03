export type InjectionHit =
  | "instruction_phrasing"
  | "role_tag"
  | "tool_directive"
  | "secret_request"
  | "pipe_to_shell"
  | "hidden_characters"
  | "encoded_blob"
  | "too_large";

/** Webhook bodies are attacker-influenced text; anything past this is truncated before screening. */
export const WEBHOOK_SCREEN_MAX_BYTES = 16 * 1024;

const HIT_ORDER: InjectionHit[] = [
  "instruction_phrasing",
  "role_tag",
  "tool_directive",
  "secret_request",
  "pipe_to_shell",
  "hidden_characters",
  "encoded_blob",
  "too_large",
];

/** Phrases that try to talk the agent out of its system prompt ("ignore previous instructions", "you are now…"). */
const INSTRUCTION_PHRASING =
  /\b(?:ignore|disregard|forget|override)\b(?:\s+(?:all|any|the|your))?(?:\s+(?:previous|prior|above|earlier|system))?\s+(?:instructions|rules|prompt|directions)\b|\byou\s+are\s+now\b|\bnew\s+instructions\b|\bsystem\s+prompt\b|\bact\s+as\s+(?:an?|the)\s+(?:ai|assistant|agent)\b|\bfrom\s+now\s+on,?\s+you\b/i;

/** Fake chat-role framing (`<system>`, `system:` at line start, delivery-payload tags) used to smuggle a new turn. */
const ROLE_TAG =
  /<\/?system>|<\/?assistant>|^\s*["']?(?:system|assistant|user)\s*:|<\/?untrusted_delivery_payload>|\[Inbound Event/im;

/** Imperative calls to a real tool name, not a bare mention of the word (e.g. a "shell-lint" job). */
const TOOL_NAMES = [
  "shell",
  "message_bot",
  "update_bot",
  "set_child_instructions",
  "web_fetch",
  "remember",
  "create_bot",
  "delete_bot",
];
const TOOL_DIRECTIVE = new RegExp(
  `\\b(?:run|call|use|invoke|execute)\\s+(?:the\\s+)?(?:${TOOL_NAMES.join("|")})\\b|\\b(?:${TOOL_NAMES.join("|")})\\s*\\(`,
  "i",
);

/** A leak verb close to a secret-ish noun ("print the api key", "cat .env"), bounded so it can't scan the whole body. */
const SECRET_REQUEST =
  /\b(?:print|send|reveal|exfiltrate|leak|post|cat|echo|dump|show)\b[\s\S]{0,40}?(?:\b(?:token|api[ _-]?key|secret|password|credential|private key|env vars?|environment variables)\b|\.env\b)/i;

/** A download piped straight into a shell, or an inline shell/eval invocation. */
const PIPE_TO_SHELL =
  /\bcurl\b[^\n|]*\|\s*(?:sh|bash|zsh)\b|\bwget\b[^\n|]*\|\s*(?:sh|bash)\b|\bbash\s+-c\b|\bsh\s+-c\b|\beval\s*\$\(|\bpython\s+-c\b|\|\s*sudo\b/i;

/** Zero-width and bidi-control characters used to hide text from a human reviewer but not from the model. */
const HIDDEN_CHARACTERS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

/** A long unbroken base64 run, the shape of a smuggled payload rather than a short hex SHA. */
const ENCODED_BLOB = /[A-Za-z0-9+/=]{200,}/;

function screenCore(text: string, hits: Set<InjectionHit>): void {
  if (INSTRUCTION_PHRASING.test(text)) hits.add("instruction_phrasing");
  if (ROLE_TAG.test(text)) hits.add("role_tag");
  if (TOOL_DIRECTIVE.test(text)) hits.add("tool_directive");
  if (SECRET_REQUEST.test(text)) hits.add("secret_request");
  if (PIPE_TO_SHELL.test(text)) hits.add("pipe_to_shell");
  if (HIDDEN_CHARACTERS.test(text)) hits.add("hidden_characters");
  if (ENCODED_BLOB.test(text)) hits.add("encoded_blob");
}

/**
 * Screens inbound webhook payload text (PR titles/bodies, CI logs) for prompt-injection
 * signals before an AI agent reads it. Pure and dependency-free: every rule is a bounded,
 * linear-time regex, so this is safe to run on attacker-controlled input.
 */
export function screenWebhookPayload(text: string): { hits: InjectionHit[] } {
  const hits = new Set<InjectionHit>();
  const byteLength = Buffer.byteLength(text, "utf8");
  const tooLarge = byteLength > WEBHOOK_SCREEN_MAX_BYTES;
  if (tooLarge) hits.add("too_large");

  const truncated = tooLarge
    ? Buffer.from(text, "utf8").subarray(0, WEBHOOK_SCREEN_MAX_BYTES).toString("utf8")
    : text;
  screenCore(truncated, hits);

  return { hits: HIT_ORDER.filter((hit) => hits.has(hit)) };
}
