import { createRequire } from "node:module";
import type { PluginRuntime } from "./types.js";
import {
  chunkByNewline,
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../../agent/pipeline/chunk.js";
import {
  hasControlCommand,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
} from "../../../agent/pipeline/command-detection.js";
import { shouldHandleTextCommands } from "../../../agent/pipeline/commands-registry.js";
import {
  formatAgentEnvelope,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../../agent/pipeline/envelope.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../../agent/pipeline/inbound-debounce.js";
import { dispatchReplyFromConfig } from "../../../agent/pipeline/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../../../agent/pipeline/reply/inbound-context.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
} from "../../../agent/pipeline/reply/mentions.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../../agent/pipeline/reply/provider-dispatcher.js";
import { createReplyDispatcherWithTyping } from "../../../agent/pipeline/reply/reply-dispatcher.js";
import {
  removeAckReactionAfterReply,
  shouldAckReaction,
} from "../../../entrypoints/channels/ack-reactions.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../../entrypoints/channels/command-gating.js";
import { discordMessageActions } from "../../../entrypoints/channels/plugins/actions/discord.js";
import { signalMessageActions } from "../../../entrypoints/channels/plugins/actions/signal.js";
import { telegramMessageActions } from "../../../entrypoints/channels/plugins/actions/telegram.js";
import { createWhatsAppLoginTool } from "../../../entrypoints/channels/plugins/agent-tools/whatsapp-login.js";
import { recordInboundSession } from "../../../entrypoints/channels/session.js";
import { monitorWebChannel } from "../../../entrypoints/channels/web/index.js";
import { auditDiscordChannelPermissions } from "../../../entrypoints/discord/audit.js";
import {
  listDiscordDirectoryGroupsLive,
  listDiscordDirectoryPeersLive,
} from "../../../entrypoints/discord/directory-live.js";
import { monitorDiscordProvider } from "../../../entrypoints/discord/monitor.js";
import { probeDiscord } from "../../../entrypoints/discord/probe.js";
import { resolveDiscordChannelAllowlist } from "../../../entrypoints/discord/resolve-channels.js";
import { resolveDiscordUserAllowlist } from "../../../entrypoints/discord/resolve-users.js";
import { sendMessageDiscord, sendPollDiscord } from "../../../entrypoints/discord/send.js";
import { registerMemoryCli } from "../../../entrypoints/entry/cli/memory-cli.js";
import { monitorIMessageProvider } from "../../../entrypoints/imessage/monitor.js";
import { probeIMessage } from "../../../entrypoints/imessage/probe.js";
import { sendMessageIMessage } from "../../../entrypoints/imessage/send.js";
import {
  listLineAccountIds,
  normalizeAccountId as normalizeLineAccountId,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../../entrypoints/line/accounts.js";
import { monitorLineProvider } from "../../../entrypoints/line/monitor.js";
import { probeLineBot } from "../../../entrypoints/line/probe.js";
import {
  createQuickReplyItems,
  pushMessageLine,
  pushMessagesLine,
  pushFlexMessage,
  pushTemplateMessage,
  pushLocationMessage,
  pushTextMessageWithQuickReplies,
  sendMessageLine,
} from "../../../entrypoints/line/send.js";
import { buildTemplateMessageFromPayload } from "../../../entrypoints/line/template-messages.js";
import { monitorSignalProvider } from "../../../entrypoints/signal/index.js";
import { probeSignal } from "../../../entrypoints/signal/probe.js";
import { sendMessageSignal } from "../../../entrypoints/signal/send.js";
import {
  listSlackDirectoryGroupsLive,
  listSlackDirectoryPeersLive,
} from "../../../entrypoints/slack/directory-live.js";
import { monitorSlackProvider } from "../../../entrypoints/slack/index.js";
import { probeSlack } from "../../../entrypoints/slack/probe.js";
import { resolveSlackChannelAllowlist } from "../../../entrypoints/slack/resolve-channels.js";
import { resolveSlackUserAllowlist } from "../../../entrypoints/slack/resolve-users.js";
import { sendMessageSlack } from "../../../entrypoints/slack/send.js";
import {
  auditTelegramGroupMembership,
  collectTelegramUnmentionedGroupIds,
} from "../../../entrypoints/telegram/audit.js";
import { monitorTelegramProvider } from "../../../entrypoints/telegram/monitor.js";
import { probeTelegram } from "../../../entrypoints/telegram/probe.js";
import { sendMessageTelegram } from "../../../entrypoints/telegram/send.js";
import { resolveTelegramToken } from "../../../entrypoints/telegram/token.js";
import { getActiveWebListener } from "../../../entrypoints/web/active-listener.js";
import {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  readWebSelfId,
  webAuthExists,
} from "../../../entrypoints/web/auth-store.js";
import { startWebLoginWithQr, waitForWebLogin } from "../../../entrypoints/web/login-qr.js";
import { loginWeb } from "../../../entrypoints/web/login.js";
import { loadWebMedia } from "../../../entrypoints/web/media.js";
import { sendMessageWhatsApp, sendPollWhatsApp } from "../../../entrypoints/web/outbound.js";
import { shouldLogVerbose } from "../../../globals.js";
import { getChannelActivity, recordChannelActivity } from "../../../infra/channel-activity.js";
import { loadConfig, writeConfigFile } from "../../../infra/config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../../infra/config/group-policy.js";
import { resolveMarkdownTableMode } from "../../../infra/config/markdown-tables.js";
import { resolveStateDir } from "../../../infra/config/paths.js";
import {
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  resolveStorePath,
  updateLastRoute,
} from "../../../infra/config/sessions.js";
import { buildPairingReply } from "../../../infra/pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../../infra/pairing/pairing-store.js";
import { resolveAgentRoute } from "../../../infra/routing/resolve-route.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { getChildLogger } from "../../../logging.js";
import { normalizeLogLevel } from "../../../logging/levels.js";
import { convertMarkdownTables } from "../../../markdown/tables.js";
import { isVoiceCompatibleAudio } from "../../../media/audio.js";
import { mediaKindFromMime } from "../../../media/constants.js";
import { fetchRemoteMedia } from "../../../media/fetch.js";
import { getImageMetadata, resizeToJpeg } from "../../../media/image-ops.js";
import { detectMime } from "../../../media/mime.js";
import { saveMediaBuffer } from "../../../media/store.js";
import { runCommandWithTimeout } from "../../../process/exec.js";
import {
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
} from "../../../runtime/identity.js";
import { createMemoryGetTool, createMemorySearchTool } from "../../../runtime/tools/memory-tool.js";
import { handleSlackAction } from "../../../runtime/tools/slack-actions.js";
import { handleWhatsAppAction } from "../../../runtime/tools/whatsapp-actions.js";
import { textToSpeechTelephony } from "../../../runtime/tts/tts.js";
import { formatNativeDependencyHint } from "./native-deps.js";

let cachedVersion: string | null = null;

function resolveVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    cachedVersion = pkg.version ?? "unknown";
    return cachedVersion;
  } catch {
    cachedVersion = "unknown";
    return cachedVersion;
  }
}

export function createPluginRuntime(): PluginRuntime {
  return {
    version: resolveVersion(),
    config: {
      loadConfig,
      writeConfigFile,
    },
    system: {
      enqueueSystemEvent,
      runCommandWithTimeout,
      formatNativeDependencyHint,
    },
    media: {
      loadWebMedia,
      detectMime,
      mediaKindFromMime,
      isVoiceCompatibleAudio,
      getImageMetadata,
      resizeToJpeg,
    },
    tts: {
      textToSpeechTelephony,
    },
    tools: {
      createMemoryGetTool,
      createMemorySearchTool,
      registerMemoryCli,
    },
    channel: {
      text: {
        chunkByNewline,
        chunkMarkdownText,
        chunkMarkdownTextWithMode,
        chunkText,
        chunkTextWithMode,
        resolveChunkMode,
        resolveTextChunkLimit,
        hasControlCommand,
        resolveMarkdownTableMode,
        convertMarkdownTables,
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
        createReplyDispatcherWithTyping,
        resolveEffectiveMessagesConfig,
        resolveHumanDelayConfig,
        dispatchReplyFromConfig,
        finalizeInboundContext,
        formatAgentEnvelope,
        /** @deprecated Prefer `BodyForAgent` + structured user-context blocks (do not build plaintext envelopes for prompts). */
        formatInboundEnvelope,
        resolveEnvelopeFormatOptions,
      },
      routing: {
        resolveAgentRoute,
      },
      pairing: {
        buildPairingReply,
        readAllowFromStore: readChannelAllowFromStore,
        upsertPairingRequest: upsertChannelPairingRequest,
      },
      media: {
        fetchRemoteMedia,
        saveMediaBuffer,
      },
      activity: {
        record: recordChannelActivity,
        get: getChannelActivity,
      },
      session: {
        resolveStorePath,
        readSessionUpdatedAt,
        recordSessionMetaFromInbound,
        recordInboundSession,
        updateLastRoute,
      },
      mentions: {
        buildMentionRegexes,
        matchesMentionPatterns,
        matchesMentionWithExplicit,
      },
      reactions: {
        shouldAckReaction,
        removeAckReactionAfterReply,
      },
      groups: {
        resolveGroupPolicy: resolveChannelGroupPolicy,
        resolveRequireMention: resolveChannelGroupRequireMention,
      },
      debounce: {
        createInboundDebouncer,
        resolveInboundDebounceMs,
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers,
        isControlCommandMessage,
        shouldComputeCommandAuthorized,
        shouldHandleTextCommands,
      },
      discord: {
        messageActions: discordMessageActions,
        auditChannelPermissions: auditDiscordChannelPermissions,
        listDirectoryGroupsLive: listDiscordDirectoryGroupsLive,
        listDirectoryPeersLive: listDiscordDirectoryPeersLive,
        probeDiscord,
        resolveChannelAllowlist: resolveDiscordChannelAllowlist,
        resolveUserAllowlist: resolveDiscordUserAllowlist,
        sendMessageDiscord,
        sendPollDiscord,
        monitorDiscordProvider,
      },
      slack: {
        listDirectoryGroupsLive: listSlackDirectoryGroupsLive,
        listDirectoryPeersLive: listSlackDirectoryPeersLive,
        probeSlack,
        resolveChannelAllowlist: resolveSlackChannelAllowlist,
        resolveUserAllowlist: resolveSlackUserAllowlist,
        sendMessageSlack,
        monitorSlackProvider,
        handleSlackAction,
      },
      telegram: {
        auditGroupMembership: auditTelegramGroupMembership,
        collectUnmentionedGroupIds: collectTelegramUnmentionedGroupIds,
        probeTelegram,
        resolveTelegramToken,
        sendMessageTelegram,
        monitorTelegramProvider,
        messageActions: telegramMessageActions,
      },
      signal: {
        probeSignal,
        sendMessageSignal,
        monitorSignalProvider,
        messageActions: signalMessageActions,
      },
      imessage: {
        monitorIMessageProvider,
        probeIMessage,
        sendMessageIMessage,
      },
      whatsapp: {
        getActiveWebListener,
        getWebAuthAgeMs,
        logoutWeb,
        logWebSelfId,
        readWebSelfId,
        webAuthExists,
        sendMessageWhatsApp,
        sendPollWhatsApp,
        loginWeb,
        startWebLoginWithQr,
        waitForWebLogin,
        monitorWebChannel,
        handleWhatsAppAction,
        createLoginTool: createWhatsAppLoginTool,
      },
      line: {
        listLineAccountIds,
        resolveDefaultLineAccountId,
        resolveLineAccount,
        normalizeAccountId: normalizeLineAccountId,
        probeLineBot,
        sendMessageLine,
        pushMessageLine,
        pushMessagesLine,
        pushFlexMessage,
        pushTemplateMessage,
        pushLocationMessage,
        pushTextMessageWithQuickReplies,
        createQuickReplyItems,
        buildTemplateMessageFromPayload,
        monitorLineProvider,
      },
    },
    logging: {
      shouldLogVerbose,
      getChildLogger: (bindings, opts) => {
        const logger = getChildLogger(bindings, {
          level: opts?.level ? normalizeLogLevel(opts.level) : undefined,
        });
        return {
          debug: (message) => logger.debug?.(message),
          info: (message) => logger.info(message),
          warn: (message) => logger.warn(message),
          error: (message) => logger.error(message),
        };
      },
    },
    state: {
      resolveStateDir,
    },
  };
}

export type { PluginRuntime } from "./types.js";
