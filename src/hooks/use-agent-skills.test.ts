import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentSkillItem, AgentSkillsListResult } from "@/lib/types"

const mockListSkills =
  vi.fn<
    (params: {
      agentType: string
      workspacePath?: string | null
    }) => Promise<AgentSkillsListResult>
  >()
vi.mock("@/lib/api", () => ({
  acpListAgentSkills: (params: {
    agentType: string
    workspacePath?: string | null
  }) => mockListSkills(params),
}))

import { invalidateAgentSkillsCache, useAgentSkills } from "./use-agent-skills"

function skill(id: string): AgentSkillItem {
  return {
    id,
    name: id,
    scope: "global",
    layout: "skill_directory",
    path: `/skills/${id}`,
    description: null,
    read_only: false,
  }
}

function listing(...ids: string[]): AgentSkillsListResult {
  return {
    supported: true,
    message: null,
    locations: [],
    skills: ids.map(skill),
  }
}

function focusWindow() {
  act(() => {
    window.dispatchEvent(new Event("focus"))
  })
}

const ids = (skills: AgentSkillItem[]) => skills.map((s) => s.id)

beforeEach(() => {
  invalidateAgentSkillsCache()
  mockListSkills.mockReset()
})

describe("useAgentSkills window-focus refresh", () => {
  it("makes one request per focus for every instance sharing a key", async () => {
    // A Codex tab mounts two instances on the same key: its composer's `$` menu
    // and its transcript's badge check. One focus must not scan the disk twice.
    mockListSkills.mockResolvedValue(listing("deploy"))
    const { result } = renderHook(() => ({
      composer: useAgentSkills("codex", "/ws/a"),
      transcript: useAgentSkills("codex", "/ws/a"),
    }))
    await waitFor(() =>
      expect(ids(result.current.transcript)).toEqual(["deploy"])
    )
    expect(mockListSkills).toHaveBeenCalledTimes(1)

    mockListSkills.mockResolvedValue(listing("deploy", "review"))
    focusWindow()

    expect(mockListSkills).toHaveBeenCalledTimes(2)
    // Both instances still pick up the refreshed list from the shared request.
    await waitFor(() => {
      expect(ids(result.current.composer)).toEqual(["deploy", "review"])
      expect(ids(result.current.transcript)).toEqual(["deploy", "review"])
    })
  })

  it("still refreshes on every focus", async () => {
    mockListSkills.mockResolvedValue(listing("deploy"))
    const { result } = renderHook(() => useAgentSkills("codex", "/ws/b"))
    await waitFor(() => expect(ids(result.current)).toEqual(["deploy"]))

    mockListSkills.mockResolvedValue(listing("review"))
    focusWindow()
    await waitFor(() => expect(ids(result.current)).toEqual(["review"]))

    mockListSkills.mockResolvedValue(listing("ship"))
    focusWindow()
    await waitFor(() => expect(ids(result.current)).toEqual(["ship"]))
    expect(mockListSkills).toHaveBeenCalledTimes(3)
  })

  it("refreshes each distinct key once on the same focus", async () => {
    mockListSkills.mockImplementation(async ({ workspacePath }) =>
      listing(workspacePath === "/ws/c" ? "c" : "d")
    )
    const { result } = renderHook(() => ({
      c: useAgentSkills("codex", "/ws/c"),
      d: useAgentSkills("codex", "/ws/d"),
    }))
    await waitFor(() => {
      expect(ids(result.current.c)).toEqual(["c"])
      expect(ids(result.current.d)).toEqual(["d"])
    })
    expect(mockListSkills).toHaveBeenCalledTimes(2)

    focusWindow()
    expect(mockListSkills).toHaveBeenCalledTimes(4)
    expect(
      mockListSkills.mock.calls.slice(2).map(([p]) => p.workspacePath)
    ).toEqual(["/ws/c", "/ws/d"])
  })
})
