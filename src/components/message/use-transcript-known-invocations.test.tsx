import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { render, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  AgentSkillItem,
  AgentType,
  AvailableCommandInfo,
} from "@/lib/types"

// Codex's on-disk skills for the folder; every other agent scans none.
const CODEX_SKILLS: AgentSkillItem[] = [
  {
    id: "ship",
    name: "ship",
    scope: "project",
    layout: "skill_directory",
    path: "/ws/.codex/skills/ship",
    description: null,
    read_only: false,
  },
]
const NO_SKILLS: AgentSkillItem[] = []

const defaultSkills = (agentType: AgentType | null) =>
  agentType === "codex" ? CODEX_SKILLS : NO_SKILLS
const mockUseAgentSkills =
  vi.fn<
    (
      agentType: AgentType | null,
      workspacePath?: string | null
    ) => AgentSkillItem[]
  >(defaultSkills)
vi.mock("@/hooks/use-agent-skills", () => ({
  useAgentSkills: (
    agentType: AgentType | null,
    workspacePath?: string | null
  ) => mockUseAgentSkills(agentType, workspacePath),
}))

import { KnownInvocationsProvider } from "./known-invocations-context"
import { PlainTextWithBadges } from "./plain-text-with-badges"
import { useTranscriptKnownInvocations } from "./use-transcript-known-invocations"

const command = (name: string): AvailableCommandInfo => ({
  name,
  description: "",
})

const sorted = (known: ReadonlySet<string>) => [...known].sort()

beforeEach(() => {
  mockUseAgentSkills.mockClear()
  mockUseAgentSkills.mockImplementation(defaultSkills)
})

describe("useTranscriptKnownInvocations", () => {
  it("knows an agent's advertised commands without scanning skills from disk", () => {
    const commands = [command("review"), command("init")]
    const { result } = renderHook(() =>
      useTranscriptKnownInvocations("claude_code", commands, "/ws")
    )
    expect(sorted(result.current)).toEqual(["/init", "/review"])
    // Every agent but Codex advertises its skills as commands already.
    expect(mockUseAgentSkills).toHaveBeenCalledWith(null, "/ws")
  })

  it("adds Codex's on-disk skills under `$`, read from the transcript's folder", () => {
    // `$deploy` is a skill Codex advertises as a command named `$deploy`.
    const commands = [command("review"), command("$deploy")]
    const { result } = renderHook(() =>
      useTranscriptKnownInvocations("codex", commands, "/ws")
    )
    expect(sorted(result.current)).toEqual(["$deploy", "$ship", "/review"])
    expect(mockUseAgentSkills).toHaveBeenCalledWith("codex", "/ws")
  })

  it("knows nothing before the agent advertises, beyond Codex's disk skills", () => {
    const none = (agentType: AgentType, list: null | undefined) =>
      renderHook(() => useTranscriptKnownInvocations(agentType, list, "/ws"))
        .result.current
    expect(none("claude_code", null).size).toBe(0)
    expect(none("claude_code", undefined).size).toBe(0)
    expect(sorted(none("codex", null))).toEqual(["$ship"])
  })

  it("keeps its reference until one of its lists changes", () => {
    // A new value re-renders every user message on screen, so a render that
    // changed neither list (a streaming tick) must hand back the same one.
    const commands = [command("review")]
    const { result, rerender } = renderHook(
      ({ list }) => useTranscriptKnownInvocations("claude_code", list, "/ws"),
      { initialProps: { list: commands } }
    )
    const first = result.current
    rerender({ list: commands })
    expect(result.current).toBe(first)

    rerender({ list: [command("review"), command("init")] })
    expect(result.current).not.toBe(first)
    expect(sorted(result.current)).toEqual(["/init", "/review"])
  })

  it("rebuilds when Codex's disk skills change under the same commands", () => {
    const commands = [command("review")]
    const { result, rerender } = renderHook(() =>
      useTranscriptKnownInvocations("codex", commands, "/ws")
    )
    const first = result.current
    rerender()
    expect(result.current).toBe(first)

    // A focus refresh found a new skill in the folder: a new list arrives.
    const refreshed: AgentSkillItem[] = [
      ...CODEX_SKILLS,
      { ...CODEX_SKILLS[0], id: "deploy", name: "deploy" },
    ]
    mockUseAgentSkills.mockImplementation((agentType) =>
      agentType === "codex" ? refreshed : NO_SKILLS
    )
    rerender()
    expect(result.current).not.toBe(first)
    expect(sorted(result.current)).toEqual(["$deploy", "$ship", "/review"])
    // …and then holds still again while nothing changes.
    const refreshedSet = result.current
    rerender()
    expect(result.current).toBe(refreshedSet)
  })

  it("badges in a sent message exactly the tokens it knows", () => {
    function Bubble({ text }: { text: string }) {
      const known = useTranscriptKnownInvocations(
        "codex",
        [command("review")],
        "/ws"
      )
      return (
        <KnownInvocationsProvider value={known}>
          <PlainTextWithBadges text={text} />
        </KnownInvocationsProvider>
      )
    }
    const { container } = render(
      <Bubble text="run /review, then $ship; not /tmp or /ship" />
    )
    const badges = [...container.querySelectorAll("[data-reference-badge]")]
    expect(badges.map((badge) => badge.textContent)).toEqual(["review", "ship"])
    // A path, and a Codex skill written with the wrong prefix, stay text.
    expect(container.textContent).toContain("not /tmp or /ship")
  })
})

describe("MessageListView", () => {
  it("provides this list, for its own agent and folder, around its whole thread", () => {
    // The bubbles read it through context, so dropping the provider (or moving
    // it inside part of the thread) would silently stop every badge there. The
    // folder is the one its images resolve against, the composer's own folder.
    const source = readFileSync(
      resolve(process.cwd(), "src/components/message/message-list-view.tsx"),
      "utf8"
    )
    // Exactly one call, so the match below is the call in use rather than a
    // stray second one beside it.
    expect(source.match(/useTranscriptKnownInvocations\(/g)).toHaveLength(1)
    expect(source).toMatch(
      /const knownInvocations = useTranscriptKnownInvocations\(\s*agentType,\s*availableCommands,\s*resolvedImageRoot\s*\)/
    )
    expect(source).toMatch(
      /<KnownInvocationsProvider value=\{knownInvocations\}>\s*\{thread\}\s*<\/KnownInvocationsProvider>/
    )
  })
})
