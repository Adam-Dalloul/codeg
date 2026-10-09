import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AvailableCommandInfo } from "@/lib/types"

const STORAGE_KEY = "codeg:advertised-commands"

// The store reads localStorage once and caches at module scope, so every test
// gets a module that has not read it yet.
beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})

async function load() {
  return import("./advertised-commands-store")
}

const command = (name: string, description = ""): AvailableCommandInfo => ({
  name,
  description,
})

const names = (commands: readonly { name: string }[] | null) =>
  commands ? commands.map((c) => c.name) : null

function stored(): unknown {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")
}

/** What another window of the app does: write the record, then the browser
 *  tells every other window through a `storage` event. */
function writeFromAnotherWindow(value: unknown) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }))
}

describe("rememberAdvertisedCommands", () => {
  it("remembers the names an agent advertised in a folder, for that pair only", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [
      command("review", "Review the diff"),
      command("init"),
    ])
    expect(names(store.getLastAdvertisedCommands("claude_code", "/a"))).toEqual(
      ["review", "init"]
    )
    // Another folder's commands, or another agent's, say nothing about this.
    expect(store.getLastAdvertisedCommands("claude_code", "/b")).toBeNull()
    expect(store.getLastAdvertisedCommands("codex", "/a")).toBeNull()
    expect(store.getLastAdvertisedCommands("claude_code", null)).toBeNull()
  })

  it("files nothing for a connection without a folder", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", null, [command("review")])
    store.rememberAdvertisedCommands("claude_code", "", [command("review")])
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it("replaces what the agent advertised there before rather than merging", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [
      command("review"),
      command("deploy"),
    ])
    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    expect(names(store.getLastAdvertisedCommands("claude_code", "/a"))).toEqual(
      ["review"]
    )
    // An empty list is an answer too: the agent offers nothing there now.
    store.rememberAdvertisedCommands("claude_code", "/a", [])
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).toEqual([])
  })

  it("is still there after a restart", async () => {
    const before = await load()
    before.rememberAdvertisedCommands("claude_code", "/a", [command("review")])

    vi.resetModules()
    const after = await load()
    expect(names(after.getLastAdvertisedCommands("claude_code", "/a"))).toEqual(
      ["review"]
    )
  })

  it("hands back the same list until this pair's names change", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    const first = store.getLastAdvertisedCommands("claude_code", "/a")
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).toBe(first)

    // A reconnect re-advertises the same names (descriptions are not kept).
    store.rememberAdvertisedCommands("claude_code", "/a", [
      command("review", "now with a description"),
    ])
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).toBe(first)

    // Another folder's write leaves this one's reference alone.
    store.rememberAdvertisedCommands("claude_code", "/b", [command("init")])
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).toBe(first)

    store.rememberAdvertisedCommands("claude_code", "/a", [command("init")])
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).not.toBe(first)
  })

  it("wakes its readers for a new list, not for a repeat", async () => {
    const store = await load()
    const listener = vi.fn()
    const unsubscribe = store.subscribeLastAdvertisedCommands(listener)

    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    expect(listener).toHaveBeenCalledTimes(1)
    const write = vi.spyOn(Storage.prototype, "setItem")
    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
    write.mockRestore()

    unsubscribe()
    store.rememberAdvertisedCommands("claude_code", "/a", [command("init")])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("drops the folder advertised least recently once the record is full", async () => {
    const store = await load()
    // Three folders whose lists each take a little over a third of the record:
    // every name is 7 characters, stored as `"a000000",`.
    const third = Math.ceil(store.MAX_STORED_CHARS / 3 / 10) + 1
    const big = (prefix: string) =>
      Array.from({ length: third }, (_, i) =>
        command(`${prefix}${String(i).padStart(6, "0")}`)
      )
    store.rememberAdvertisedCommands("claude_code", "/a", big("a"))
    store.rememberAdvertisedCommands("claude_code", "/b", big("b"))
    // `/a` advertises again, so `/b` is now the one advertised least recently.
    store.rememberAdvertisedCommands("claude_code", "/a", big("a"))
    store.rememberAdvertisedCommands("claude_code", "/c", big("c"))

    expect(store.getLastAdvertisedCommands("claude_code", "/b")).toBeNull()
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).not.toBeNull()
    expect(store.getLastAdvertisedCommands("claude_code", "/c")).not.toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)!.length).toBeLessThanOrEqual(
      store.MAX_STORED_CHARS
    )
    expect(
      (stored() as { folder: string }[]).map((entry) => entry.folder)
    ).toEqual(["/a", "/c"])
  })

  it("forgets a list too long to keep at all, without pushing out the others", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    store.rememberAdvertisedCommands("claude_code", "/b", [command("init")])
    const huge = Array.from({ length: store.MAX_STORED_CHARS / 8 }, (_, i) =>
      command(`c${String(i).padStart(7, "0")}`)
    )
    store.rememberAdvertisedCommands("claude_code", "/b", huge)

    expect(names(store.getLastAdvertisedCommands("claude_code", "/a"))).toEqual(
      ["review"]
    )
    // Not kept in its old form either: that list is no longer what /b offers.
    expect(store.getLastAdvertisedCommands("claude_code", "/b")).toBeNull()
    expect(stored()).toEqual([
      { agentType: "claude_code", folder: "/a", commands: ["review"] },
    ])
  })

  it("does not write over a newer entry another window stored meanwhile", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    // Another window records /b, and this window has not heard of it yet.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { agentType: "claude_code", folder: "/a", commands: ["review"] },
        { agentType: "codex", folder: "/b", commands: ["$ship"] },
      ])
    )
    store.rememberAdvertisedCommands("claude_code", "/c", [command("init")])
    expect(stored()).toEqual([
      { agentType: "claude_code", folder: "/a", commands: ["review"] },
      { agentType: "codex", folder: "/b", commands: ["$ship"] },
      { agentType: "claude_code", folder: "/c", commands: ["init"] },
    ])
  })
})

describe("getLastAdvertisedCommands", () => {
  it("follows what another window stores, waking only for a change", async () => {
    const store = await load()
    store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    const kept = store.getLastAdvertisedCommands("claude_code", "/a")
    const listener = vi.fn()
    store.subscribeLastAdvertisedCommands(listener)

    writeFromAnotherWindow([
      { agentType: "claude_code", folder: "/a", commands: ["review"] },
      { agentType: "codex", folder: "/b", commands: ["$ship", "review"] },
    ])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(names(store.getLastAdvertisedCommands("codex", "/b"))).toEqual([
      "$ship",
      "review",
    ])
    // Unchanged entries keep their reference, so their readers do not re-render.
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).toBe(kept)

    // Some other key is none of its business.
    window.dispatchEvent(new StorageEvent("storage", { key: "codeg:other" }))
    expect(listener).toHaveBeenCalledTimes(1)

    // Storage cleared in another window clears this record as well.
    localStorage.clear()
    window.dispatchEvent(new StorageEvent("storage", { key: null }))
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).toBeNull()
  })

  it("reads a damaged record as nothing remembered, keeping what is well-formed", async () => {
    localStorage.setItem(STORAGE_KEY, "{not json")
    expect(
      (await load()).getLastAdvertisedCommands("claude_code", "/a")
    ).toBeNull()

    vi.resetModules()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ "/a": ["review"] }))
    expect(
      (await load()).getLastAdvertisedCommands("claude_code", "/a")
    ).toBeNull()

    vi.resetModules()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        null,
        "claude_code",
        { agentType: "claude_code", folder: "/a", commands: "review" },
        { agentType: 7, folder: "/b", commands: ["review"] },
        { agentType: "claude_code", folder: "", commands: ["review"] },
        {
          agentType: "claude_code",
          folder: "/c",
          commands: ["review", 3, "", { name: "x" }, "review", "init"],
        },
        { agentType: "codex", folder: "/d", commands: ["old"] },
        { agentType: "codex", folder: "/d", commands: ["new"] },
      ])
    )
    const store = await load()
    expect(store.getLastAdvertisedCommands("claude_code", "/a")).toBeNull()
    expect(store.getLastAdvertisedCommands("claude_code", "/b")).toBeNull()
    expect(names(store.getLastAdvertisedCommands("claude_code", "/c"))).toEqual(
      ["review", "init"]
    )
    // A pair stored twice reads as its later list.
    expect(names(store.getLastAdvertisedCommands("codex", "/d"))).toEqual([
      "new",
    ])
  })

  it("is what a transcript badges before its connection advertises", async () => {
    const store = await load()
    const { useTranscriptKnownInvocations } =
      await import("@/components/message/use-transcript-known-invocations")
    const { result } = renderHook(() =>
      useTranscriptKnownInvocations("claude_code", null, "/a")
    )
    expect(result.current.size).toBe(0)

    act(() => {
      store.rememberAdvertisedCommands("claude_code", "/a", [command("review")])
    })
    expect([...result.current]).toEqual(["/review"])
  })
})
