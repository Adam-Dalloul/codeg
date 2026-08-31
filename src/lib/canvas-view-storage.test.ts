import { beforeEach, describe, expect, it } from "vitest"
import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  loadCanvasDrafts,
  loadCanvasExpandedCards,
  loadCanvasViewport,
  saveCanvasDrafts,
  saveCanvasExpandedCards,
  saveCanvasViewport,
  type CanvasDraftCard,
} from "./canvas-view-storage"

/**
 * These entries are read at mount and drive what the canvas renders before any
 * backend data lands, so every reader has to degrade to "nothing remembered"
 * rather than throw or hand back a shape the view can't use. A corrupted
 * viewport in particular could strand the board at an unreachable zoom.
 */

const VIEWPORT_KEY = "workspace:canvas-viewport"
const CARDS_KEY = "workspace:canvas-expanded-cards"
const DRAFTS_KEY = "workspace:canvas-drafts"

describe("canvas view storage", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("round-trips a viewport", () => {
    saveCanvasViewport({ x: -320.5, y: 96, zoom: 0.75 })
    expect(loadCanvasViewport()).toEqual({ x: -320.5, y: 96, zoom: 0.75 })
  })

  it("clamps a stored zoom into the flow's own range", () => {
    localStorage.setItem(VIEWPORT_KEY, JSON.stringify({ x: 0, y: 0, zoom: 40 }))
    expect(loadCanvasViewport()?.zoom).toBe(CANVAS_MAX_ZOOM)
    localStorage.setItem(
      VIEWPORT_KEY,
      JSON.stringify({ x: 0, y: 0, zoom: 0.0001 })
    )
    expect(loadCanvasViewport()?.zoom).toBe(CANVAS_MIN_ZOOM)
  })

  it("treats damaged or incomplete entries as nothing remembered", () => {
    localStorage.setItem(VIEWPORT_KEY, "{not json")
    expect(loadCanvasViewport()).toBeNull()
    localStorage.setItem(VIEWPORT_KEY, JSON.stringify({ x: 1, y: 2 }))
    expect(loadCanvasViewport()).toBeNull()
    localStorage.setItem(
      VIEWPORT_KEY,
      JSON.stringify({ x: Number.NaN, y: 0, zoom: 1 })
    )
    expect(loadCanvasViewport()).toBeNull()
  })

  it("keeps only integral ids in the expanded-card set", () => {
    saveCanvasExpandedCards([3, 9])
    expect(loadCanvasExpandedCards()).toEqual([3, 9])
    localStorage.setItem(CARDS_KEY, JSON.stringify([1, "2", null, 3.5, 4]))
    expect(loadCanvasExpandedCards()).toEqual([1, 4])
    localStorage.setItem(CARDS_KEY, JSON.stringify({ nope: true }))
    expect(loadCanvasExpandedCards()).toEqual([])
  })

  it("round-trips drafts and drops the ones it cannot place", () => {
    const draft: CanvasDraftCard = {
      id: "abc",
      target: { folderId: 4 },
      agentType: "claude_code",
      x: 10,
      y: 20,
      width: 520,
      height: 560,
    }
    const chat: CanvasDraftCard = {
      ...draft,
      id: "def",
      target: { chat: true },
    }
    saveCanvasDrafts([draft, chat])
    expect(loadCanvasDrafts()).toEqual([draft, chat])

    localStorage.setItem(
      DRAFTS_KEY,
      JSON.stringify([
        draft,
        // No target at all, a target naming nothing, and no geometry: a card
        // built from any of these would have nowhere to send its first message.
        { ...draft, id: "x", target: undefined },
        { ...draft, id: "y", target: {} },
        { ...draft, id: "z", x: undefined },
        { ...draft, id: "", target: { chat: true } },
      ])
    )
    expect(loadCanvasDrafts().map((d) => d.id)).toEqual(["abc"])
  })

  it("refuses drafts with no area and collapses repeated ids", () => {
    const draft: CanvasDraftCard = {
      id: "abc",
      target: { chat: true },
      agentType: "codex",
      x: 0,
      y: 0,
      width: 520,
      height: 560,
    }
    localStorage.setItem(
      DRAFTS_KEY,
      JSON.stringify([
        // A zero/negative box restores a window too small to read or close.
        { ...draft, id: "flat", height: 0 },
        { ...draft, id: "inverted", width: -520 },
        draft,
        // The id is the connection key too: two cards under one key would be
        // two surfaces fighting over the same agent.
        { ...draft, x: 999 },
      ])
    )
    const loaded = loadCanvasDrafts()
    expect(loaded.map((d) => d.id)).toEqual(["abc"])
    expect(loaded[0].x).toBe(0)
  })

  it("clears the draft entry rather than storing an empty list", () => {
    saveCanvasDrafts([
      {
        id: "abc",
        target: { chat: true },
        agentType: "codex",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    ])
    saveCanvasDrafts([])
    expect(localStorage.getItem(DRAFTS_KEY)).toBeNull()
  })
})
