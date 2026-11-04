import type { MessageBlock, RunWebhookSource } from "@rakazo/contracts";
import { RunWebhookSourceSchema } from "@rakazo/contracts";
import type { ActionApprovalRule } from "@rakazo/core";
import {
  connectorKindFromToolName,
  inboundRoutinePrompts,
  SITE_SENDING_TOOLS,
  siteAlwaysAllowed,
} from "@rakazo/core";
import { sitesInText, urlSite } from "@rakazo/core/egress";
import {
  findAutoReviewPreference,
  isWebhookSourceTrusted,
  listApprovalRules,
  storedBatchActions,
} from "@rakazo/db";
import { boundDirectApprovalDetails, catalogApprovalDetails } from "./approval-effect.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { EffectiveModelRole } from "./model-roles.js";
import { effectiveModelRole } from "./model-roles.js";
import { routineTaskInstructions } from "./routine-watch.js";
import { CATALOG_APPROVAL_TOOL, PASSED_EFFECT_STATUSES } from "./run-effects.js";
import { BUILTIN_AGENT_TOOL_NAMES } from "./run-tool-selection.js";

/**
 * The connection a connector call reaches, for read trust. Installed APIs are told apart by their
 * resource, since their tool names share a prefix; other connectors by their tool-name kind.
 */
function connectorTrustKey(
  route: { connectorId?: string; resourceId?: string } | undefined,
  connectorKind: string,
): string {
  return route?.connectorId && route.resourceId
    ? `resource:${route.connectorId}:${route.resourceId}`
    : `kind:${connectorKind}`;
}

/**
 * Read trust for each app a batch reaches, since every batch shares one tool: a Gmail batch must
 * not make a later Slack read trusted, nor one server's batch a batch on another server. An action
 * outside every connected app keys by its own name.
 */
export function connectorTrustKeys(
  batchActions: readonly string[] | undefined,
  route: { connectorId?: string; resourceId?: string } | undefined,
  connectorKind: string,
  providers: string[],
): string[] {
  const connection = connectorTrustKey(route, connectorKind);
  if (!batchActions?.length) return [connection];
  const apps = providers.map((provider) => provider.toLowerCase());
  return batchActions.map((name) => {
    const action = name.toLowerCase();
    const app = apps
      .filter((kind) => action === kind || action.startsWith(`${kind}_`))
      .sort((left, right) => right.length - left.length)[0];
    return `${connection}:${app ?? action}`;
  });
}

/** Approval and trust lookups a run's tool calls share, each loaded at most once. */
export function createRunTrustLoaders(
  deps: ExecutorDeps,
  input: {
    run: { userId: string; spaceId: string; trigger: string; webhookSource?: unknown };
    runId: string;
    botId: string;
    taskPrompt: string;
    ownerStartedRun: boolean;
    messagingChannelRun: boolean;
    sourceMessage: { role: string; blocks: unknown } | null;
    connectedPlugins: readonly { provider: string }[];
    /** Unused by loadTrustedWebhook, which re-reads the bot's toggle fresh on every call (see
     * below): kept so callers' run-start snapshot stays available to the rest of the run. */
    botTrustsWebhookSources: boolean;
  },
) {
  const {
    run,
    runId,
    botId,
    taskPrompt,
    ownerStartedRun,
    messagingChannelRun,
    sourceMessage,
    connectedPlugins,
  } = input;
  // Parsed once: a malformed or missing webhookSource (another piece fills it in, and it may
  // not have run, or a replay may predate it) is never trusted.
  const webhookSource: RunWebhookSource | undefined = (() => {
    const parsed = RunWebhookSourceSchema.safeParse(run.webhookSource);
    return parsed.success ? parsed.data : undefined;
  })();
  let approvalRulesPromise: Promise<ActionApprovalRule[]> | undefined;
  const loadApprovalRules = () => {
    approvalRulesPromise ??= listApprovalRules(deps.prisma, {
      userId: run.userId,
      spaceId: run.spaceId,
    }).then((rules) => rules as ActionApprovalRule[]);
    return approvalRulesPromise;
  };
  let approvalModelPromise: Promise<EffectiveModelRole> | undefined;
  const loadApprovalModel = () =>
    (approvalModelPromise ??= effectiveModelRole(
      deps.prisma,
      { userId: run.userId, spaceId: run.spaceId },
      "approval",
      {},
    ));
  let autoReviewPreferencePromise:
    | Promise<{ enabled: boolean; skipApprovals: boolean }>
    | undefined;
  const loadAutoReviewPreference = () => {
    autoReviewPreferencePromise ??= findAutoReviewPreference(deps.prisma, {
      userId: run.userId,
      spaceId: run.spaceId,
    }).then((row) => ({
      enabled: row?.enabled ?? true,
      skipApprovals: row?.skipApprovals ?? false,
    }));
    return autoReviewPreferencePromise;
  };
  // The owner's own words for this run: the message they sent, or the instructions of the
  // routine that started it. Never a bot, channel or webhook message, or a tool result.
  // These name the sites a run is given, and are all Auto Review sees of a new site's run.
  let ownerWordsPromise: Promise<string> | undefined;
  const loadOwnerWords = () => {
    ownerWordsPromise ??= (async () => {
      if (ownerStartedRun && !messagingChannelRun && sourceMessage?.role === "user") {
        return ((sourceMessage.blocks ?? []) as MessageBlock[])
          .flatMap((block) => (block.kind === "text" ? [block.text] : []))
          .join("\n");
      }
      // Saved when the routine fired, so a later edit cannot change what this run judges.
      if (run.trigger === "routine") return routineTaskInstructions(taskPrompt);
      if (run.trigger === "webhook") {
        const routines = await deps.prisma.routine.findMany({
          where: { botId: botId, spaceId: run.spaceId, userId: run.userId },
          select: { name: true, prompt: true },
        });
        return inboundRoutinePrompts(taskPrompt, routines).join("\n\n");
      }
      return "";
    })();
    return ownerWordsPromise;
  };
  // Whether this run's webhook call may run unattended on the strength of its source alone:
  // the bot opted in, the delivery screened clean, and the owner already trusted this exact
  // source (not merely the route it came in on). Never cached: the toggle and the run's
  // webhookSource can both change mid-run (the owner can flip the toggle, and a later
  // delivery can downgrade the run's screen), and each is a single-row lookup, so every gated
  // call re-reads them fresh. A deny rule or a missing always-allow rule still gates the call
  // beyond this (see planActionGate's trustedWebhook branch).
  const loadTrustedWebhook = async (): Promise<boolean> => {
    if (run.trigger !== "webhook") return false;
    const live = await deps.prisma.bot.findUnique({
      where: { id: botId },
      select: { trustWebhookSources: true },
    });
    if (!live?.trustWebhookSources) return false;
    const liveRun = await deps.prisma.run.findUnique({
      where: { id: runId },
      select: { webhookSource: true },
    });
    const parsed = RunWebhookSourceSchema.safeParse(liveRun?.webhookSource);
    const liveWebhookSource = parsed.success ? parsed.data : undefined;
    if (!liveWebhookSource || liveWebhookSource.screen.verdict !== "clean") return false;
    return isWebhookSourceTrusted(deps.prisma, {
      botId,
      sourceKey: liveWebhookSource.sourceKey,
    });
  };
  let trustedSitesPromise: Promise<Set<string>> | undefined;
  const loadTrustedSites = () => {
    trustedSitesPromise ??= deps.prisma.externalEffect
      .findMany({
        where: {
          runId,
          kind: { in: [...SITE_SENDING_TOOLS] },
          status: { in: PASSED_EFFECT_STATUSES },
        },
        select: { request: true },
      })
      .then(async (rows) => {
        const sites = sitesInText(await loadOwnerWords());
        for (const row of rows) {
          const url = (row.request as { url?: unknown } | null)?.url;
          const site = typeof url === "string" ? urlSite(url) : undefined;
          if (site) sites.add(site);
        }
        return sites;
      });
    return trustedSitesPromise;
  };
  const routineNamesNewSite = async (prompt: string) => {
    const trusted = await loadTrustedSites();
    const rules = await loadApprovalRules();
    return [...sitesInText(prompt)].some(
      (site) => !trusted.has(site) && !siteAlwaysAllowed(rules, site),
    );
  };
  let trustedConnectorsPromise: Promise<Set<string>> | undefined;
  const loadTrustedConnectors = () => {
    const providers = connectedPlugins.map((plugin) => plugin.provider);
    trustedConnectorsPromise ??= deps.prisma.externalEffect
      .findMany({
        where: { runId, status: { in: PASSED_EFFECT_STATUSES } },
        select: { kind: true, request: true, batchActions: true },
      })
      .then(
        (rows) =>
          new Set(
            rows
              .filter((row) => !BUILTIN_AGENT_TOOL_NAMES.has(row.kind))
              .flatMap((row) =>
                connectorTrustKeys(
                  storedBatchActions(row.batchActions),
                  boundDirectApprovalDetails(row.request, CATALOG_APPROVAL_TOOL)?.route ??
                    catalogApprovalDetails(row.request, CATALOG_APPROVAL_TOOL)?.route,
                  connectorKindFromToolName(row.kind, providers),
                  providers,
                ),
              ),
          ),
      );
    return trustedConnectorsPromise;
  };
  // Channel and webhook text this run took in mid-turn is not the owner's. Rows queued
  // before origins were recorded are recognized by their channel message.
  const receivedOutsideMessage = async () =>
    Boolean(
      await deps.prisma.steeringMessage.findFirst({
        where: {
          runId,
          claimedAt: { not: null },
          OR: [
            { originTrigger: { not: null } },
            { message: { blocks: { array_contains: [{ kind: "channel_message" }] } } },
          ],
        },
        select: { id: true },
      }),
    );
  return {
    loadApprovalRules,
    loadApprovalModel,
    loadAutoReviewPreference,
    loadOwnerWords,
    loadTrustedSites,
    routineNamesNewSite,
    loadTrustedConnectors,
    receivedOutsideMessage,
    loadTrustedWebhook,
    /** This run's parsed, validated webhook source, or undefined when there is none or it is
     * malformed. Synchronous: the row was already loaded with the run. */
    webhookSource,
  };
}
