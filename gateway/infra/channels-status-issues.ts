import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "../entrypoints/channels/plugins/types.js";
import { listChannelPlugins } from "../entrypoints/channels/plugins/index.js";

export function collectChannelStatusIssues(payload: Record<string, unknown>): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  const accountsByChannel = payload.channelAccounts as Record<string, unknown> | undefined;
  for (const plugin of listChannelPlugins()) {
    const collect = plugin.status?.collectStatusIssues;
    if (!collect) {
      continue;
    }
    const raw = accountsByChannel?.[plugin.id];
    if (!Array.isArray(raw)) {
      continue;
    }

    issues.push(...collect(raw as ChannelAccountSnapshot[]));
  }
  return issues;
}
