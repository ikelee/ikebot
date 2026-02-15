import type { LogLevel } from "../../../logging/levels.js";

type ShouldLogVerbose = typeof import("../../../globals.js").shouldLogVerbose;
type DispatchReplyWithBufferedBlockDispatcher =
  typeof import("../../../agent/pipeline/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;
type CreateReplyDispatcherWithTyping =
  typeof import("../../../agent/pipeline/reply/reply-dispatcher.js").createReplyDispatcherWithTyping;
type ResolveEffectiveMessagesConfig =
  typeof import("../../../runtime/identity.js").resolveEffectiveMessagesConfig;
type ResolveHumanDelayConfig =
  typeof import("../../../runtime/identity.js").resolveHumanDelayConfig;
type ResolveAgentRoute = typeof import("../../../infra/routing/resolve-route.js").resolveAgentRoute;
type BuildPairingReply =
  typeof import("../../../infra/pairing/pairing-messages.js").buildPairingReply;
type ReadChannelAllowFromStore =
  typeof import("../../../infra/pairing/pairing-store.js").readChannelAllowFromStore;
type UpsertChannelPairingRequest =
  typeof import("../../../infra/pairing/pairing-store.js").upsertChannelPairingRequest;
type FetchRemoteMedia = typeof import("../../../media/fetch.js").fetchRemoteMedia;
type SaveMediaBuffer = typeof import("../../../media/store.js").saveMediaBuffer;
type TextToSpeechTelephony = typeof import("../../../runtime/tts/tts.js").textToSpeechTelephony;
type BuildMentionRegexes =
  typeof import("../../../agent/pipeline/reply/mentions.js").buildMentionRegexes;
type MatchesMentionPatterns =
  typeof import("../../../agent/pipeline/reply/mentions.js").matchesMentionPatterns;
type MatchesMentionWithExplicit =
  typeof import("../../../agent/pipeline/reply/mentions.js").matchesMentionWithExplicit;
type ShouldAckReaction =
  typeof import("../../../entrypoints/channels/ack-reactions.js").shouldAckReaction;
type RemoveAckReactionAfterReply =
  typeof import("../../../entrypoints/channels/ack-reactions.js").removeAckReactionAfterReply;
type ResolveChannelGroupPolicy =
  typeof import("../../../infra/config/group-policy.js").resolveChannelGroupPolicy;
type ResolveChannelGroupRequireMention =
  typeof import("../../../infra/config/group-policy.js").resolveChannelGroupRequireMention;
type CreateInboundDebouncer =
  typeof import("../../../agent/pipeline/inbound-debounce.js").createInboundDebouncer;
type ResolveInboundDebounceMs =
  typeof import("../../../agent/pipeline/inbound-debounce.js").resolveInboundDebounceMs;
type ResolveCommandAuthorizedFromAuthorizers =
  typeof import("../../../entrypoints/channels/command-gating.js").resolveCommandAuthorizedFromAuthorizers;
type ResolveTextChunkLimit =
  typeof import("../../../agent/pipeline/chunk.js").resolveTextChunkLimit;
type ResolveChunkMode = typeof import("../../../agent/pipeline/chunk.js").resolveChunkMode;
type ChunkMarkdownText = typeof import("../../../agent/pipeline/chunk.js").chunkMarkdownText;
type ChunkMarkdownTextWithMode =
  typeof import("../../../agent/pipeline/chunk.js").chunkMarkdownTextWithMode;
type ChunkText = typeof import("../../../agent/pipeline/chunk.js").chunkText;
type ChunkTextWithMode = typeof import("../../../agent/pipeline/chunk.js").chunkTextWithMode;
type ChunkByNewline = typeof import("../../../agent/pipeline/chunk.js").chunkByNewline;
type ResolveMarkdownTableMode =
  typeof import("../../../infra/config/markdown-tables.js").resolveMarkdownTableMode;
type ConvertMarkdownTables = typeof import("../../../markdown/tables.js").convertMarkdownTables;
type HasControlCommand =
  typeof import("../../../agent/pipeline/command-detection.js").hasControlCommand;
type IsControlCommandMessage =
  typeof import("../../../agent/pipeline/command-detection.js").isControlCommandMessage;
type ShouldComputeCommandAuthorized =
  typeof import("../../../agent/pipeline/command-detection.js").shouldComputeCommandAuthorized;
type ShouldHandleTextCommands =
  typeof import("../../../agent/pipeline/commands-registry.js").shouldHandleTextCommands;
type DispatchReplyFromConfig =
  typeof import("../../../agent/pipeline/reply/dispatch-from-config.js").dispatchReplyFromConfig;
type FinalizeInboundContext =
  typeof import("../../../agent/pipeline/reply/inbound-context.js").finalizeInboundContext;
type FormatAgentEnvelope = typeof import("../../../agent/pipeline/envelope.js").formatAgentEnvelope;
type FormatInboundEnvelope =
  typeof import("../../../agent/pipeline/envelope.js").formatInboundEnvelope;
type ResolveEnvelopeFormatOptions =
  typeof import("../../../agent/pipeline/envelope.js").resolveEnvelopeFormatOptions;
type ResolveStateDir = typeof import("../../../infra/config/paths.js").resolveStateDir;
type RecordInboundSession =
  typeof import("../../../entrypoints/channels/session.js").recordInboundSession;
type RecordSessionMetaFromInbound =
  typeof import("../../../infra/config/sessions.js").recordSessionMetaFromInbound;
type ResolveStorePath = typeof import("../../../infra/config/sessions.js").resolveStorePath;
type ReadSessionUpdatedAt = typeof import("../../../infra/config/sessions.js").readSessionUpdatedAt;
type UpdateLastRoute = typeof import("../../../infra/config/sessions.js").updateLastRoute;
type LoadConfig = typeof import("../../../infra/config/config.js").loadConfig;
type WriteConfigFile = typeof import("../../../infra/config/config.js").writeConfigFile;
type RecordChannelActivity =
  typeof import("../../../infra/channel-activity.js").recordChannelActivity;
type GetChannelActivity = typeof import("../../../infra/channel-activity.js").getChannelActivity;
type EnqueueSystemEvent = typeof import("../../../infra/system-events.js").enqueueSystemEvent;
type RunCommandWithTimeout = typeof import("../../../process/exec.js").runCommandWithTimeout;
type FormatNativeDependencyHint = typeof import("./native-deps.js").formatNativeDependencyHint;
type LoadWebMedia = typeof import("../../../entrypoints/web/media.js").loadWebMedia;
type DetectMime = typeof import("../../../media/mime.js").detectMime;
type MediaKindFromMime = typeof import("../../../media/constants.js").mediaKindFromMime;
type IsVoiceCompatibleAudio = typeof import("../../../media/audio.js").isVoiceCompatibleAudio;
type GetImageMetadata = typeof import("../../../media/image-ops.js").getImageMetadata;
type ResizeToJpeg = typeof import("../../../media/image-ops.js").resizeToJpeg;
type CreateMemoryGetTool =
  typeof import("../../../runtime/tools/memory-tool.js").createMemoryGetTool;
type CreateMemorySearchTool =
  typeof import("../../../runtime/tools/memory-tool.js").createMemorySearchTool;
type RegisterMemoryCli =
  typeof import("../../../entrypoints/entry/cli/memory-cli.js").registerMemoryCli;
type DiscordMessageActions =
  typeof import("../../../entrypoints/channels/plugins/actions/discord.js").discordMessageActions;
type AuditDiscordChannelPermissions =
  typeof import("../../../entrypoints/discord/audit.js").auditDiscordChannelPermissions;
type ListDiscordDirectoryGroupsLive =
  typeof import("../../../entrypoints/discord/directory-live.js").listDiscordDirectoryGroupsLive;
type ListDiscordDirectoryPeersLive =
  typeof import("../../../entrypoints/discord/directory-live.js").listDiscordDirectoryPeersLive;
type ProbeDiscord = typeof import("../../../entrypoints/discord/probe.js").probeDiscord;
type ResolveDiscordChannelAllowlist =
  typeof import("../../../entrypoints/discord/resolve-channels.js").resolveDiscordChannelAllowlist;
type ResolveDiscordUserAllowlist =
  typeof import("../../../entrypoints/discord/resolve-users.js").resolveDiscordUserAllowlist;
type SendMessageDiscord = typeof import("../../../entrypoints/discord/send.js").sendMessageDiscord;
type SendPollDiscord = typeof import("../../../entrypoints/discord/send.js").sendPollDiscord;
type MonitorDiscordProvider =
  typeof import("../../../entrypoints/discord/monitor.js").monitorDiscordProvider;
type ListSlackDirectoryGroupsLive =
  typeof import("../../../entrypoints/slack/directory-live.js").listSlackDirectoryGroupsLive;
type ListSlackDirectoryPeersLive =
  typeof import("../../../entrypoints/slack/directory-live.js").listSlackDirectoryPeersLive;
type ProbeSlack = typeof import("../../../entrypoints/slack/probe.js").probeSlack;
type ResolveSlackChannelAllowlist =
  typeof import("../../../entrypoints/slack/resolve-channels.js").resolveSlackChannelAllowlist;
type ResolveSlackUserAllowlist =
  typeof import("../../../entrypoints/slack/resolve-users.js").resolveSlackUserAllowlist;
type SendMessageSlack = typeof import("../../../entrypoints/slack/send.js").sendMessageSlack;
type MonitorSlackProvider =
  typeof import("../../../entrypoints/slack/index.js").monitorSlackProvider;
type HandleSlackAction = typeof import("../../../runtime/tools/slack-actions.js").handleSlackAction;
type AuditTelegramGroupMembership =
  typeof import("../../../entrypoints/telegram/audit.js").auditTelegramGroupMembership;
type CollectTelegramUnmentionedGroupIds =
  typeof import("../../../entrypoints/telegram/audit.js").collectTelegramUnmentionedGroupIds;
type ProbeTelegram = typeof import("../../../entrypoints/telegram/probe.js").probeTelegram;
type ResolveTelegramToken =
  typeof import("../../../entrypoints/telegram/token.js").resolveTelegramToken;
type SendMessageTelegram =
  typeof import("../../../entrypoints/telegram/send.js").sendMessageTelegram;
type MonitorTelegramProvider =
  typeof import("../../../entrypoints/telegram/monitor.js").monitorTelegramProvider;
type TelegramMessageActions =
  typeof import("../../../entrypoints/channels/plugins/actions/telegram.js").telegramMessageActions;
type ProbeSignal = typeof import("../../../entrypoints/signal/probe.js").probeSignal;
type SendMessageSignal = typeof import("../../../entrypoints/signal/send.js").sendMessageSignal;
type MonitorSignalProvider =
  typeof import("../../../entrypoints/signal/index.js").monitorSignalProvider;
type SignalMessageActions =
  typeof import("../../../entrypoints/channels/plugins/actions/signal.js").signalMessageActions;
type MonitorIMessageProvider =
  typeof import("../../../entrypoints/imessage/monitor.js").monitorIMessageProvider;
type ProbeIMessage = typeof import("../../../entrypoints/imessage/probe.js").probeIMessage;
type SendMessageIMessage =
  typeof import("../../../entrypoints/imessage/send.js").sendMessageIMessage;
type GetActiveWebListener =
  typeof import("../../../entrypoints/web/active-listener.js").getActiveWebListener;
type GetWebAuthAgeMs = typeof import("../../../entrypoints/web/auth-store.js").getWebAuthAgeMs;
type LogoutWeb = typeof import("../../../entrypoints/web/auth-store.js").logoutWeb;
type LogWebSelfId = typeof import("../../../entrypoints/web/auth-store.js").logWebSelfId;
type ReadWebSelfId = typeof import("../../../entrypoints/web/auth-store.js").readWebSelfId;
type WebAuthExists = typeof import("../../../entrypoints/web/auth-store.js").webAuthExists;
type SendMessageWhatsApp =
  typeof import("../../../entrypoints/web/outbound.js").sendMessageWhatsApp;
type SendPollWhatsApp = typeof import("../../../entrypoints/web/outbound.js").sendPollWhatsApp;
type LoginWeb = typeof import("../../../entrypoints/web/login.js").loginWeb;
type StartWebLoginWithQr =
  typeof import("../../../entrypoints/web/login-qr.js").startWebLoginWithQr;
type WaitForWebLogin = typeof import("../../../entrypoints/web/login-qr.js").waitForWebLogin;
type MonitorWebChannel =
  typeof import("../../../entrypoints/channels/web/index.js").monitorWebChannel;
type HandleWhatsAppAction =
  typeof import("../../../runtime/tools/whatsapp-actions.js").handleWhatsAppAction;
type CreateWhatsAppLoginTool =
  typeof import("../../../entrypoints/channels/plugins/agent-tools/whatsapp-login.js").createWhatsAppLoginTool;

// LINE channel types
type ListLineAccountIds = typeof import("../../../entrypoints/line/accounts.js").listLineAccountIds;
type ResolveDefaultLineAccountId =
  typeof import("../../../entrypoints/line/accounts.js").resolveDefaultLineAccountId;
type ResolveLineAccount = typeof import("../../../entrypoints/line/accounts.js").resolveLineAccount;
type NormalizeLineAccountId =
  typeof import("../../../entrypoints/line/accounts.js").normalizeAccountId;
type ProbeLineBot = typeof import("../../../entrypoints/line/probe.js").probeLineBot;
type SendMessageLine = typeof import("../../../entrypoints/line/send.js").sendMessageLine;
type PushMessageLine = typeof import("../../../entrypoints/line/send.js").pushMessageLine;
type PushMessagesLine = typeof import("../../../entrypoints/line/send.js").pushMessagesLine;
type PushFlexMessage = typeof import("../../../entrypoints/line/send.js").pushFlexMessage;
type PushTemplateMessage = typeof import("../../../entrypoints/line/send.js").pushTemplateMessage;
type PushLocationMessage = typeof import("../../../entrypoints/line/send.js").pushLocationMessage;
type PushTextMessageWithQuickReplies =
  typeof import("../../../entrypoints/line/send.js").pushTextMessageWithQuickReplies;
type CreateQuickReplyItems =
  typeof import("../../../entrypoints/line/send.js").createQuickReplyItems;
type BuildTemplateMessageFromPayload =
  typeof import("../../../entrypoints/line/template-messages.js").buildTemplateMessageFromPayload;
type MonitorLineProvider =
  typeof import("../../../entrypoints/line/monitor.js").monitorLineProvider;

export type RuntimeLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

export type PluginRuntime = {
  version: string;
  config: {
    loadConfig: LoadConfig;
    writeConfigFile: WriteConfigFile;
  };
  system: {
    enqueueSystemEvent: EnqueueSystemEvent;
    runCommandWithTimeout: RunCommandWithTimeout;
    formatNativeDependencyHint: FormatNativeDependencyHint;
  };
  media: {
    loadWebMedia: LoadWebMedia;
    detectMime: DetectMime;
    mediaKindFromMime: MediaKindFromMime;
    isVoiceCompatibleAudio: IsVoiceCompatibleAudio;
    getImageMetadata: GetImageMetadata;
    resizeToJpeg: ResizeToJpeg;
  };
  tts: {
    textToSpeechTelephony: TextToSpeechTelephony;
  };
  tools: {
    createMemoryGetTool: CreateMemoryGetTool;
    createMemorySearchTool: CreateMemorySearchTool;
    registerMemoryCli: RegisterMemoryCli;
  };
  channel: {
    text: {
      chunkByNewline: ChunkByNewline;
      chunkMarkdownText: ChunkMarkdownText;
      chunkMarkdownTextWithMode: ChunkMarkdownTextWithMode;
      chunkText: ChunkText;
      chunkTextWithMode: ChunkTextWithMode;
      resolveChunkMode: ResolveChunkMode;
      resolveTextChunkLimit: ResolveTextChunkLimit;
      hasControlCommand: HasControlCommand;
      resolveMarkdownTableMode: ResolveMarkdownTableMode;
      convertMarkdownTables: ConvertMarkdownTables;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
      createReplyDispatcherWithTyping: CreateReplyDispatcherWithTyping;
      resolveEffectiveMessagesConfig: ResolveEffectiveMessagesConfig;
      resolveHumanDelayConfig: ResolveHumanDelayConfig;
      dispatchReplyFromConfig: DispatchReplyFromConfig;
      finalizeInboundContext: FinalizeInboundContext;
      formatAgentEnvelope: FormatAgentEnvelope;
      /** @deprecated Prefer `BodyForAgent` + structured user-context blocks (do not build plaintext envelopes for prompts). */
      formatInboundEnvelope: FormatInboundEnvelope;
      resolveEnvelopeFormatOptions: ResolveEnvelopeFormatOptions;
    };
    routing: {
      resolveAgentRoute: ResolveAgentRoute;
    };
    pairing: {
      buildPairingReply: BuildPairingReply;
      readAllowFromStore: ReadChannelAllowFromStore;
      upsertPairingRequest: UpsertChannelPairingRequest;
    };
    media: {
      fetchRemoteMedia: FetchRemoteMedia;
      saveMediaBuffer: SaveMediaBuffer;
    };
    activity: {
      record: RecordChannelActivity;
      get: GetChannelActivity;
    };
    session: {
      resolveStorePath: ResolveStorePath;
      readSessionUpdatedAt: ReadSessionUpdatedAt;
      recordSessionMetaFromInbound: RecordSessionMetaFromInbound;
      recordInboundSession: RecordInboundSession;
      updateLastRoute: UpdateLastRoute;
    };
    mentions: {
      buildMentionRegexes: BuildMentionRegexes;
      matchesMentionPatterns: MatchesMentionPatterns;
      matchesMentionWithExplicit: MatchesMentionWithExplicit;
    };
    reactions: {
      shouldAckReaction: ShouldAckReaction;
      removeAckReactionAfterReply: RemoveAckReactionAfterReply;
    };
    groups: {
      resolveGroupPolicy: ResolveChannelGroupPolicy;
      resolveRequireMention: ResolveChannelGroupRequireMention;
    };
    debounce: {
      createInboundDebouncer: CreateInboundDebouncer;
      resolveInboundDebounceMs: ResolveInboundDebounceMs;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers: ResolveCommandAuthorizedFromAuthorizers;
      isControlCommandMessage: IsControlCommandMessage;
      shouldComputeCommandAuthorized: ShouldComputeCommandAuthorized;
      shouldHandleTextCommands: ShouldHandleTextCommands;
    };
    discord: {
      messageActions: DiscordMessageActions;
      auditChannelPermissions: AuditDiscordChannelPermissions;
      listDirectoryGroupsLive: ListDiscordDirectoryGroupsLive;
      listDirectoryPeersLive: ListDiscordDirectoryPeersLive;
      probeDiscord: ProbeDiscord;
      resolveChannelAllowlist: ResolveDiscordChannelAllowlist;
      resolveUserAllowlist: ResolveDiscordUserAllowlist;
      sendMessageDiscord: SendMessageDiscord;
      sendPollDiscord: SendPollDiscord;
      monitorDiscordProvider: MonitorDiscordProvider;
    };
    slack: {
      listDirectoryGroupsLive: ListSlackDirectoryGroupsLive;
      listDirectoryPeersLive: ListSlackDirectoryPeersLive;
      probeSlack: ProbeSlack;
      resolveChannelAllowlist: ResolveSlackChannelAllowlist;
      resolveUserAllowlist: ResolveSlackUserAllowlist;
      sendMessageSlack: SendMessageSlack;
      monitorSlackProvider: MonitorSlackProvider;
      handleSlackAction: HandleSlackAction;
    };
    telegram: {
      auditGroupMembership: AuditTelegramGroupMembership;
      collectUnmentionedGroupIds: CollectTelegramUnmentionedGroupIds;
      probeTelegram: ProbeTelegram;
      resolveTelegramToken: ResolveTelegramToken;
      sendMessageTelegram: SendMessageTelegram;
      monitorTelegramProvider: MonitorTelegramProvider;
      messageActions: TelegramMessageActions;
    };
    signal: {
      probeSignal: ProbeSignal;
      sendMessageSignal: SendMessageSignal;
      monitorSignalProvider: MonitorSignalProvider;
      messageActions: SignalMessageActions;
    };
    imessage: {
      monitorIMessageProvider: MonitorIMessageProvider;
      probeIMessage: ProbeIMessage;
      sendMessageIMessage: SendMessageIMessage;
    };
    whatsapp: {
      getActiveWebListener: GetActiveWebListener;
      getWebAuthAgeMs: GetWebAuthAgeMs;
      logoutWeb: LogoutWeb;
      logWebSelfId: LogWebSelfId;
      readWebSelfId: ReadWebSelfId;
      webAuthExists: WebAuthExists;
      sendMessageWhatsApp: SendMessageWhatsApp;
      sendPollWhatsApp: SendPollWhatsApp;
      loginWeb: LoginWeb;
      startWebLoginWithQr: StartWebLoginWithQr;
      waitForWebLogin: WaitForWebLogin;
      monitorWebChannel: MonitorWebChannel;
      handleWhatsAppAction: HandleWhatsAppAction;
      createLoginTool: CreateWhatsAppLoginTool;
    };
    line: {
      listLineAccountIds: ListLineAccountIds;
      resolveDefaultLineAccountId: ResolveDefaultLineAccountId;
      resolveLineAccount: ResolveLineAccount;
      normalizeAccountId: NormalizeLineAccountId;
      probeLineBot: ProbeLineBot;
      sendMessageLine: SendMessageLine;
      pushMessageLine: PushMessageLine;
      pushMessagesLine: PushMessagesLine;
      pushFlexMessage: PushFlexMessage;
      pushTemplateMessage: PushTemplateMessage;
      pushLocationMessage: PushLocationMessage;
      pushTextMessageWithQuickReplies: PushTextMessageWithQuickReplies;
      createQuickReplyItems: CreateQuickReplyItems;
      buildTemplateMessageFromPayload: BuildTemplateMessageFromPayload;
      monitorLineProvider: MonitorLineProvider;
    };
  };
  logging: {
    shouldLogVerbose: ShouldLogVerbose;
    getChildLogger: (
      bindings?: Record<string, unknown>,
      opts?: { level?: LogLevel },
    ) => RuntimeLogger;
  };
  state: {
    resolveStateDir: ResolveStateDir;
  };
};
