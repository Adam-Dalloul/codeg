import { act, render } from "@testing-library/react"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserDevice } from "@/lib/browser/browser-device"

import { BrowserDeviceStage, type DeviceStageFit } from "./browser-device-stage"

/** Give every element the stage measures this rect (jsdom has no layout). */
function stageOf(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width,
    height,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  })
}

function renderStage(device: BrowserDevice) {
  const seen: DeviceStageFit[] = []
  const result = render(
    <BrowserDeviceStage device={device}>
      {(fit) => {
        seen.push(fit)
        return <div data-testid="page" />
      }}
    </BrowserDeviceStage>
  )
  return { ...result, seen }
}

function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1]
}

function frameOf(container: HTMLElement): HTMLElement {
  const frame = container.querySelector<HTMLElement>(
    "[data-browser-device-frame]"
  )
  if (!frame) throw new Error("no frame")
  return frame
}

function labelOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-browser-device-label]")
}

describe("BrowserDeviceStage", () => {
  beforeEach(() => {
    vi.stubGlobal("devicePixelRatio", 2)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("lets a desktop page fill the slot, as it always has", () => {
    stageOf(1000, 700)
    const { container, seen } = renderStage("desktop")
    expect(labelOf(container)).toBeNull()
    expect(frameOf(container)).toHaveClass("absolute", "inset-0")
    expect(frameOf(container).style.width).toBe("")
    // The desktop's page zoom is not ours to set.
    expect(last(seen)).toMatchObject({
      viewport: null,
      frame: null,
      zoom: null,
    })
  })

  it("shows a phone that fits at its own size, unzoomed", () => {
    // 16px padding twice, a 20px label and an 8px gap leave 932 × 920.
    stageOf(964, 980)
    const { container, seen } = renderStage("phone")
    expect(frameOf(container).style.width).toBe("390px")
    expect(frameOf(container).style.height).toBe("844px")
    expect(labelOf(container)).toHaveTextContent(/^390 × 844$/)
    expect(last(seen)?.zoom).toBe(1)
  })

  it("shrinks a tablet that does not fit, says by how much, and zooms its page to match", () => {
    stageOf(1200, 700)
    const { container, seen } = renderStage("tablet")
    // 700 - 32 - 28 = 640 of the tablet's 1024.
    const width = Math.floor(768 * (640 / 1024))
    expect(frameOf(container).style.width).toBe(`${width}px`)
    expect(frameOf(container).style.height).toBe("640px")
    expect(labelOf(container)).toHaveTextContent("768 × 1024")
    expect(labelOf(container)).toHaveTextContent(
      `· ${Math.round((width / 768) * 100)}%`
    )
    const fit = last(seen)
    expect(fit?.zoom).toBeLessThan(1)
    // The page inside still lays out at the tablet's width.
    expect((width * 2) / (2 * (fit?.zoom ?? 1))).toBeGreaterThanOrEqual(768)
  })

  it("never hands the page a frame it has not measured", () => {
    stageOf(1200, 700)
    const { seen } = renderStage("phone")
    expect(seen.length).toBeGreaterThan(0)
    // A native surface created from an unmeasured frame would be built at
    // the size of the whole slot, then shrink.
    expect(seen.every((fit) => fit.frame !== null)).toBe(true)
  })

  it("keeps the page mounted while the device changes", () => {
    stageOf(1200, 700)
    let mounts = 0
    function Page() {
      useEffect(() => {
        mounts += 1
      }, [])
      return null
    }
    const stage = (device: BrowserDevice) => (
      <BrowserDeviceStage device={device}>{() => <Page />}</BrowserDeviceStage>
    )
    const { rerender } = render(stage("desktop"))
    rerender(stage("phone"))
    rerender(stage("tablet"))
    rerender(stage("desktop"))
    // Rebuilt, a page's native surface would hide and come back every time.
    expect(mounts).toBe(1)
  })

  it("follows the stage's size, and moves its layout key so a centred frame is placed again", () => {
    // jsdom has no ResizeObserver: a stand-in that the test can fire, for
    // the elements that were actually put under observation.
    const observers: Array<{ notify: () => void; targets: Set<Element> }> = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private entry: { notify: () => void; targets: Set<Element> }
        constructor(callback: () => void) {
          this.entry = { notify: callback, targets: new Set() }
          observers.push(this.entry)
        }
        observe(target: Element) {
          this.entry.targets.add(target)
        }
        disconnect() {
          this.entry.targets.clear()
        }
      }
    )
    const resize = () =>
      act(() =>
        observers
          .filter(({ targets }) => targets.size > 0)
          .forEach(({ notify }) => notify())
      )
    stageOf(1200, 980)
    const { container, seen } = renderStage("phone")
    const before = last(seen)?.layoutKey
    // Wider only: the phone still fits at its own size, so nothing about the
    // frame changes — but it is centred, so it moved.
    stageOf(1400, 980)
    resize()
    expect(frameOf(container).style.width).toBe("390px")
    expect(last(seen)?.layoutKey).not.toBe(before)
    // Shorter: now it has to shrink.
    stageOf(1400, 500)
    resize()
    // 500 - 32 - 28 = 440 to fit into; snapping the width to whole pixels
    // can leave the height a pixel under that, never over.
    const height = parseFloat(frameOf(container).style.height)
    expect(height).toBeLessThanOrEqual(440)
    expect(height).toBeGreaterThan(438)
    expect(last(seen)?.zoom).toBeLessThan(1)
  })
})
