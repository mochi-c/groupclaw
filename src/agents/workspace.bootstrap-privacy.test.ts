/** Tests workspace bootstrap privacy policy and loader source provenance. */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_FILENAME,
  filterBootstrapFilesForSession,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const mockFiles: WorkspaceBootstrapFile[] = [
  { name: "AGENTS.md", path: "/w/AGENTS.md", content: "", missing: false },
  { name: "SOUL.md", path: "/w/SOUL.md", content: "", missing: false },
  { name: "IDENTITY.md", path: "/w/IDENTITY.md", content: "", missing: false },
  { name: "USER.md", path: "/w/USER.md", content: "", missing: false },
  { name: "BOOTSTRAP.md", path: "/w/BOOTSTRAP.md", content: "", missing: false },
  {
    name: DEFAULT_MEMORY_FILENAME,
    path: `/w/${DEFAULT_MEMORY_FILENAME}`,
    content: "",
    missing: false,
  },
];

describe("filterBootstrapFilesForSession scope", () => {
  it("keeps Workspace memory available to direct and group conversations", () => {
    const shared = filterBootstrapFilesForSession(mockFiles, {
      sessionKey: "agent:default:opaque:binding",
      chatType: "group",
    });
    const direct = filterBootstrapFilesForSession(mockFiles, {
      sessionKey: "agent:default:discord:channel:c1",
      chatType: "direct",
    });

    expect(shared).toStrictEqual(mockFiles);
    expect(direct).toStrictEqual(mockFiles);
  });

  it("does not infer memory visibility from path aliases", () => {
    const workspaceMemoryAlias: WorkspaceBootstrapFile = {
      name: "SOUL.md",
      path: "/w/private/../memory/MEMORY.md",
      content: "",
      missing: false,
    };
    const nestedMemory: WorkspaceBootstrapFile = {
      name: DEFAULT_MEMORY_FILENAME,
      path: "/w/packages/core/memory/MEMORY.md",
      content: "",
      missing: false,
    };

    const result = filterBootstrapFilesForSession([workspaceMemoryAlias, nestedMemory], {
      sessionKey: "agent:default:opaque:binding",
      chatType: "channel",
      workspaceDir: "/w",
    });

    expect(result).toStrictEqual([workspaceMemoryAlias, nestedMemory]);
  });

  it.each([
    ["subagent", "agent:default:subagent:task-1", "AGENTS.md"],
    ["cron", "agent:default:cron:daily-check", "SOUL.md"],
  ] as const)("applies only the %s bootstrap allowlist", (_mode, sessionKey, name) => {
    const allowedFile = mockFiles.find((file) => file.name === name)!;
    const disallowedFile: WorkspaceBootstrapFile = {
      name: DEFAULT_MEMORY_FILENAME,
      path: "/w/memory/MEMORY.md",
      content: "",
      missing: false,
    };

    const result = filterBootstrapFilesForSession([allowedFile, disallowedFile], {
      sessionKey,
      workspaceDir: "/w",
    });

    expect(result).toStrictEqual([allowedFile]);
  });
});
