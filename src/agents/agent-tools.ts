import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type { SkillSnapshot } from "../skills/types.js";
import { assembleOpenClawCodingTools } from "./agent-tools.assembly.js";
import { captureLocalBrowserLoopbackConfig } from "./agent-tools.execution-policy.js";
import type {
  InternalCodingToolsOptions,
  PluginCodingToolsOptions,
} from "./agent-tools.options.js";
import {
  prepareCodingToolAssembly,
  prepareCodingToolAssemblyAsync,
} from "./agent-tools.preparation.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { prepareConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { resolveSessionToolListingClientCaps } from "./openclaw-tools.client-caps.js";
import type { prepareCoreToolPolicy } from "./prepared-tool-surface.js";
import { withLegacySessionCapabilityRead } from "./subagents/spawn/subagent-session-store-legacy.js";
import { withPreparedSessionCapabilityRead } from "./subagents/spawn/subagent-session-store.js";
import {
  withPreparedToolConstruction,
  type ToolConstructionPreparationOptions,
} from "./tool-construction-preparation.js";
import type { ToolPolicyFilterEvent } from "./tool-policy-pipeline.js";

export { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";

/** @deprecated Use createOpenClawCodingToolsInternalAsync for runtime construction. */
export function createOpenClawCodingToolsInternal(
  ...args: Parameters<typeof assembleOpenClawCodingTools>
): AnyAgentTool[] {
  return withLegacySessionCapabilityRead(() =>
    prepareCodingToolAssembly(assembleOpenClawCodingTools(...args)),
  );
}

/** Internal preparation data stays outside the public harness factory options. */
export async function createOpenClawCodingToolsInternalAsync(
  options?: InternalCodingToolsOptions,
  skillReadResources?: SkillSnapshot["resolvedSkills"],
  onPolicyFilter?: (event: ToolPolicyFilterEvent) => void,
  preparedSurface?: { tools: AnyAgentTool[]; policy: ReturnType<typeof prepareCoreToolPolicy> },
  preparation: ToolConstructionPreparationOptions = {},
): Promise<AnyAgentTool[]> {
  const assertLoopbackConfigCurrent = captureLocalBrowserLoopbackConfig(options?.config);
  return withPreparedToolConstruction(
    options?.config,
    {
      ...preparation,
      signal:
        options?.abortSignal && preparation.signal
          ? AbortSignal.any([options.abortSignal, preparation.signal])
          : (options?.abortSignal ?? preparation.signal),
    },
    async (shared) => {
      const conversationCapabilityProfile =
        options?.conversationCapabilityProfile ??
        (await prepareConversationCapabilityProfile({
          ...options,
          config: shared.config,
          agentId: options?.policyAgentId ?? options?.agentId,
          sandboxToolPolicy: options?.sandbox?.enabled ? options.sandbox.tools : undefined,
          isolatedWorkspace: options?.sandbox?.enabled
            ? options.sandbox.isolatedWorkspace
            : undefined,
          pluginMetadataSnapshot: options?.preparedModelRuntime?.metadataSnapshot,
        }));
      const listingClientCaps =
        options?.listingClientCaps ??
        (await withPreparedSessionCapabilityRead(() =>
          resolveSessionToolListingClientCaps({ ...options, config: shared.config }),
        ));
      const assembly = assembleOpenClawCodingTools(
        { ...options, config: shared.config, conversationCapabilityProfile, listingClientCaps },
        skillReadResources,
        onPolicyFilter,
        preparedSurface,
        assertLoopbackConfigCurrent,
      );
      return prepareCodingToolAssemblyAsync(assembly, shared);
    },
  );
}

/** @deprecated Use createOpenClawCodingToolsAsync to prepare policy through the worker. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
export function createOpenClawCodingTools(options?: PluginCodingToolsOptions): AnyAgentTool[] {
  warnPluginSdkDeprecation({
    family: "tool-surface",
    method: "createOpenClawCodingTools",
    replacement: "await createOpenClawCodingToolsAsync()",
  });
  return createOpenClawCodingToolsInternal(options);
}

/** Build the SDK tool list with a fresh, source-bound exec policy. */
export function createOpenClawCodingToolsAsync(
  options?: PluginCodingToolsOptions,
): Promise<AnyAgentTool[]> {
  return createOpenClawCodingToolsInternalAsync(options);
}
