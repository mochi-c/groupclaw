import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { clearMemoryPluginState, registerMemoryCapability } from "../../plugins/memory-state.js";
import * as bootstrapRuntime from "../bootstrap-files.js";
import { DEFAULT_MEMORY_FILENAME } from "../workspace.js";
import { prepareAgentWorkspaceContext } from "./workspace-context.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearMemoryPluginState();
});

const workspaceDir = path.resolve("workspace-context-fixture");
type BootstrapFile = Awaited<
  ReturnType<typeof bootstrapRuntime.resolveBootstrapFilesForRun>
>[number];
const budget = { agents: { defaults: { bootstrapMaxChars: 300, bootstrapTotalMaxChars: 300 } } };
function prepare(
  files: BootstrapFile[],
  params: Partial<Parameters<typeof prepareAgentWorkspaceContext>[0]> = {},
) {
  vi.spyOn(bootstrapRuntime, "resolveBootstrapFilesForRun").mockResolvedValue(files);
  return prepareAgentWorkspaceContext({ workspaceDir, scope: "full", ...params });
}

it("budgets root instructions independently of turn context", async () => {
  const { instructionSnapshot: snapshot } = await prepare(
    [
      bootstrapFile("SOUL.md", "Persona context.\n".repeat(100)),
      bootstrapFile("AGENTS.md", "Bounded fixture operating rules.\n".repeat(30)),
      bootstrapFile(DEFAULT_MEMORY_FILENAME, "Durable memory.\n".repeat(100)),
    ],
    { scope: "instructions-only", config: budget },
  );
  expect(snapshot.files).toHaveLength(1);
  expect(snapshot.files[0]?.content).toContain("Bounded fixture operating rules.");
  expect(snapshot.files[0]?.content).toContain("truncated");
  expect(snapshot.files[0]?.content.length).toBeLessThanOrEqual(300);
  expect(snapshot.instructions).toContain("OpenClaw Agent Workspace Instructions");
});

it("orders personal instructions in a remapped workspace", async () => {
  const personalFile = (profile: string, root = workspaceDir): BootstrapFile => ({
    ...bootstrapFile("USER.md", `${profile} preferences.`, `users/${profile}/USER.md`, root),
    personalUser: true,
  });
  vi.spyOn(bootstrapRuntime, "resolveBootstrapFilesForRun").mockImplementation(async (params) => [
    bootstrapFile("USER.md", "Shared preferences."),
    ...(params.bootstrapUserProfileId ? [personalFile(params.bootstrapUserProfileId)] : []),
    bootstrapFile("IDENTITY.md", "Agent identity."),
    bootstrapFile("SOUL.md", "Agent voice."),
  ]);
  const projectedWorkspace = path.join(workspaceDir, "task");
  for (const profile of ["alice", "bob", undefined]) {
    const context = await prepareAgentWorkspaceContext({
      workspaceDir,
      scope: "full",
      bootstrapUserProfileId: profile,
      projectPath: (filePath) =>
        path.join(projectedWorkspace, path.relative(workspaceDir, filePath)),
    });
    const shared = context.sharedPersonaInstructions ?? "";
    for (const text of ["Shared preferences.", "Agent identity.", "Agent voice."]) {
      expect(shared).toContain(text);
    }
  }
});

it("routes curated scoped memory before budgeting and retains nested project memory", async () => {
  const rootMemory = bootstrapFile(DEFAULT_MEMORY_FILENAME, "Large durable memory.\n".repeat(100));
  const nestedMemory = bootstrapFile(
    DEFAULT_MEMORY_FILENAME,
    "Package-local memory remains project context.",
    path.join(workspaceDir, "packages", "pkg", "MEMORY.md"),
  );
  const threadMemory = bootstrapFile(
    DEFAULT_MEMORY_FILENAME,
    "Current thread summary.",
    path.join(
      workspaceDir,
      "memory",
      "Channel",
      `id-${"a".repeat(64)}`,
      "Thread",
      `id-${"b".repeat(64)}`,
      "MEMORY.md",
    ),
  );
  const instructions = bootstrapFile("AGENTS.md", "Keep the bounded operating rules.");
  vi.spyOn(bootstrapRuntime, "resolveBootstrapFilesForRun").mockResolvedValue([
    rootMemory,
    threadMemory,
    nestedMemory,
    instructions,
  ]);
  const context = await prepareAgentWorkspaceContext({
    workspaceDir,
    scope: "full",
    memoryToolRouted: true,
    config: { agents: { defaults: { bootstrapMaxChars: 300, bootstrapTotalMaxChars: 300 } } },
  });
  expect(context.memoryReferenceFiles).toEqual([
    contextFile(threadMemory),
    contextFile(rootMemory),
  ]);
  expect(context.memoryToolRoutedBootstrapFiles).toEqual([threadMemory, rootMemory]);
  expect(context.promptContextFiles).toEqual([contextFile(nestedMemory)]);
  expect(context.instructionSnapshot.files).toEqual([contextFile(instructions)]);
  expect(context.instructionSnapshot.instructions).toContain("Keep the bounded operating rules.");
});

it("passes agent context to memory guidance without MEMORY.md", async () => {
  const promptBuilder = (context: {
    agentId?: string;
    agentSessionKey?: string;
    sandboxed?: boolean;
  }) => [
    `agent=${context.agentId} session=${context.agentSessionKey} sandboxed=${context.sandboxed}`,
  ];
  registerMemoryCapability("memory-core", { promptBuilder });
  const context = await prepare([], {
    agentId: "marketing-agent",
    sessionKey: "agent:marketing-agent:session-1",
    memoryToolRouted: true,
    memoryTools: { toolNames: ["memory_search", "memory_get"], sandboxed: true },
  });
  expect(context.memoryRecallInstructions).toContain(
    "agent=marketing-agent session=agent:marketing-agent:session-1 sandboxed=true",
  );
});

it("preserves project ordering for whitespace-prefixed hook filenames", async () => {
  const paddedSoul = bootstrapFile("SOUL.md", "Hook project context.", "pkg/ SOUL.md");
  const bootstrap = bootstrapFile("BOOTSTRAP.md", "Setup guidance.", "pkg/BOOTSTRAP.md");
  const context = await prepare([paddedSoul, bootstrap], {
    contextFileOrder: new Map([
      ["soul.md", 10],
      ["bootstrap.md", 50],
    ]),
  });
  expect(context.promptContextFiles).toEqual([contextFile(bootstrap), contextFile(paddedSoul)]);
});

function bootstrapFile(
  name: BootstrapFile["name"],
  content: string,
  relativePath: string = name,
  root = workspaceDir,
): BootstrapFile {
  return {
    name,
    path: path.isAbsolute(relativePath) ? relativePath : path.join(root, relativePath),
    content,
    missing: false,
  };
}

function contextFile(file: ReturnType<typeof bootstrapFile>) {
  return {
    path: file.path,
    content: file.content,
    ...(file.personalUser ? { personalUser: file.personalUser } : {}),
  };
}
