import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  scopeKey,
  type GroupToolPolicyConfig,
  type ScopeTree,
} from "openclaw/plugin-sdk/channel-policy";
import type { DiscordConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeAtHashSlug as normalizeDiscordSlug } from "openclaw/plugin-sdk/string-normalization-runtime";

// Length-prefixed segments keep arbitrary config keys, including slashes, collision-free.
const guildScopeKey = (guildKey: string) => scopeKey(["guild", guildKey]);
const channelScopeKey = (guildKey: string, channelKey: string) =>
  scopeKey(["guild", guildKey], ["channel", channelKey]);

function resolveDiscordGuildKey(
  guilds: DiscordConfig["guilds"],
  groupSpace?: string | null,
): string | undefined {
  if (!guilds || Object.keys(guilds).length === 0) {
    return undefined;
  }
  const space = normalizeOptionalString(groupSpace) ?? "";
  if (space && guilds[space]) {
    return space;
  }
  const normalized = normalizeDiscordSlug(space);
  if (normalized && guilds[normalized]) {
    return normalized;
  }
  if (normalized) {
    const match = Object.entries(guilds).find(
      ([, entry]) => normalizeDiscordSlug(entry?.slug ?? undefined) === normalized,
    );
    if (match) {
      return match[0];
    }
  }
  return guilds["*"] ? "*" : undefined;
}

function resolveDiscordChannelKey(
  channelEntries: NonNullable<DiscordConfig["guilds"]>[string]["channels"],
  params: { groupId?: string | null; groupChannel?: string | null },
): string | undefined {
  if (!channelEntries || Object.keys(channelEntries).length === 0) {
    return undefined;
  }
  const groupChannel = params.groupChannel;
  const channelSlug = normalizeDiscordSlug(groupChannel);
  if (params.groupId && channelEntries[params.groupId]) {
    return params.groupId;
  }
  if (channelSlug && channelEntries[channelSlug]) {
    return channelSlug;
  }
  if (channelSlug && channelEntries[`#${channelSlug}`]) {
    return `#${channelSlug}`;
  }
  const normalizedGroupChannel = groupChannel ? normalizeDiscordSlug(groupChannel) : undefined;
  return normalizedGroupChannel !== undefined && channelEntries[normalizedGroupChannel]
    ? normalizedGroupChannel
    : undefined;
}

function buildDiscordPolicyTree(guilds: DiscordConfig["guilds"]): ScopeTree {
  const scopes: ScopeTree["scopes"] = {};
  for (const [guildKey, guild] of Object.entries(guilds ?? {})) {
    scopes[guildScopeKey(guildKey)] = {
      requireMention: guild.requireMention,
      tools: guild.tools,
      toolsBySender: guild.toolsBySender,
    };
    for (const [channelKey, channel] of Object.entries(guild.channels ?? {})) {
      scopes[channelScopeKey(guildKey, channelKey)] = {
        requireMention: channel.requireMention,
        tools: channel.tools,
        toolsBySender: channel.toolsBySender,
      };
    }
  }
  return { scopes };
}

function resolveDiscordPolicyScope(params: ChannelGroupContext) {
  const guilds =
    (params.accountId
      ? params.cfg.channels?.discord?.accounts?.[params.accountId]?.guilds
      : undefined) ?? params.cfg.channels?.discord?.guilds;
  const tree = buildDiscordPolicyTree(guilds);
  // Guild "*" is selected only after every guild candidate misses; matched guilds hide it.
  // Within the selected guild, channel fields still cascade to guild fields.
  const guildKey = resolveDiscordGuildKey(guilds, params.groupSpace);
  if (!guildKey) {
    return { tree, path: [] };
  }
  const channelKey = resolveDiscordChannelKey(guilds?.[guildKey]?.channels, params);
  return {
    tree,
    path: [
      guildScopeKey(guildKey),
      ...(channelKey !== undefined ? [channelScopeKey(guildKey, channelKey)] : []),
    ],
  };
}

export function resolveDiscordGroupRequireMention(params: ChannelGroupContext): boolean {
  return resolveScopeRequireMention(resolveDiscordPolicyScope(params));
}

export function resolveDiscordGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const scope = resolveDiscordPolicyScope(params);
  // No messageProvider: channel-prefixed sender keys were historically dead here.
  return resolveScopeToolsPolicy({
    ...scope,
    senderPolicyMode: params.senderPolicyMode,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
}

export function resolveDiscordChannelConfigByNativeId(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  channelId?: string;
}) {
  const discord = params.cfg.channels?.discord;
  const account = params.accountId ? discord?.accounts?.[params.accountId] : undefined;
  const guilds = account?.guilds ?? discord?.guilds;
  const matches = Object.values(guilds ?? {}).flatMap((guild) =>
    Object.entries(guild.channels ?? {}).filter(
      ([id]) => /^\d+$/u.test(id) && id === params.channelId,
    ),
  );
  if (matches.length > 1) {
    throw new Error("Discord channel configuration is ambiguous; use one exact channel ID");
  }
  return matches[0]?.[1];
}

export const resolveDiscordMemoryPolicy: NonNullable<
  NonNullable<ChannelPlugin["groups"]>["resolveMemoryPolicy"]
> = ({ cfg, origin }) => {
  const discord = cfg.channels?.discord;
  const account = origin.accountId ? discord?.accounts?.[origin.accountId] : undefined;
  if (discord?.enabled === false || account?.enabled === false) {
    throw new Error("Discord memory is unavailable while the channel account is disabled");
  }
  const channel = resolveDiscordChannelConfigByNativeId({
    cfg,
    accountId: origin.accountId,
    channelId: origin.threadId ? origin.nativeParentChannelId : origin.nativeChannelId,
  });
  if (channel?.enabled === false) {
    throw new Error("Discord memory is unavailable while the source channel is disabled");
  }
  if (!channel) {
    return undefined;
  }
  const channelMemory = channel.threadMode === "always" ? "exclude" : "include";
  // The parent group's roster cannot establish a private or unverified Thread audience.
  if (origin.threadId && origin.nativeThreadVisibility !== "public") {
    return { channelMemory: "exclude" };
  }
  if (!channel.members?.length) {
    return { channelMemory };
  }
  const members = [...new Set(channel.members)].toSorted();
  const allChannels = [discord, ...Object.values(discord?.accounts ?? {})]
    .filter((candidate) => candidate?.enabled !== false)
    .flatMap((candidate) =>
      Object.values(candidate?.guilds ?? {}).flatMap((guild) =>
        Object.values(guild.channels ?? {}),
      ),
    );
  const workspaceShared =
    !Object.entries(cfg.channels ?? {}).some(
      ([id, candidate]) =>
        id !== "discord" &&
        candidate &&
        typeof candidate === "object" &&
        (!("enabled" in candidate) || candidate.enabled !== false),
    ) &&
    allChannels.length > 0 &&
    allChannels.every(
      (candidate) =>
        candidate.enabled === false ||
        (candidate.members?.length &&
          candidate.threadMode &&
          JSON.stringify([...new Set(candidate.members)].toSorted()) === JSON.stringify(members)),
    );
  return {
    channelMemory,
    group: {
      members: members.map((id) => ({
        identity: { type: "remote", pluginId: "discord", domain: "discord", idKind: "user", id },
        label: `Discord user ${id}`,
      })),
      key: JSON.stringify(["discord", origin.accountId ?? "default", members]),
      workspaceShared,
      consolidationAllowed: Boolean(channel.threadMode),
    },
  };
};
