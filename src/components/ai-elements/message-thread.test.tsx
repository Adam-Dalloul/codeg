import type { ReactNode } from "react"
import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A stand-in for the slice of `StickToBottomContext` the viewport sticker and
// the escape listener use, so a test can drive `isAtBottom` / inspect
// `resizeDifference` directly.
const testState = vi.hoisted(() => ({
  scrollRef: { current: null as HTMLDivElement | null },
  scrollToBottom: vi.fn(),
  stopScroll: vi.fn(),
  state: {
    isAtBottom: true,
    escapedFromLock: false,
    resizeDifference: 0,
    animation: undefined as { ignoreEscapes: boolean } | undefined,
  },
}))

vi.mock("use-stick-to-bottom", () => ({
  StickToBottom: ({
    children,
    ...props
  }: {
    children: ((context: unknown) => ReactNode) | ReactNode
  }) => (
    <div {...props}>
      {typeof children === "function" ? children(testState) : children}
    </div>
  ),
  useStickToBottomContext: () => testState,
}))

import { MessageThread } from "@/components/ai-elements/message-thread"

// jsdom has no ResizeObserver; capture the callback so a test can play a
// viewport resize through it, and record what got observed/disconnected.
let roCallback: ResizeObserverCallback | null = null
let observed: Element[] = []
let disconnects = 0

/** One entry shaped like what a viewport resize delivers. */
const resizeTo = (height: number) => {
  act(() => {
    roCallback?.(
      [{ contentRect: { height } } as unknown as ResizeObserverEntry],
      {} as ResizeObserver
    )
  })
}

/** Mount, then settle the observer's first (no-op) delivery at `height`. */
const mountThreadAt = (height: number) => {
  const result = render(
    <MessageThread>
      <span data-testid="thread-child">transcript</span>
    </MessageThread>
  )
  resizeTo(height)
  testState.scrollToBottom.mockClear()
  testState.state.resizeDifference = 0
  return result
}

beforeEach(() => {
  roCallback = null
  observed = []
  disconnects = 0
  testState.scrollRef.current = document.createElement("div")
  testState.scrollToBottom.mockReset()
  testState.stopScroll.mockReset()
  testState.state.isAtBottom = true
  testState.state.escapedFromLock = false
  testState.state.resizeDifference = 0
  testState.state.animation = undefined
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb
      }
      observe(el: Element) {
        observed.push(el)
      }
      unobserve() {}
      disconnect() {
        disconnects += 1
      }
    }
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("MessageThread viewport resize", () => {
  it("observes the scroll viewport and still renders its children", () => {
    mountThreadAt(400)

    expect(observed).toEqual([testState.scrollRef.current])
    expect(screen.getByTestId("thread-child")).toBeDefined()
  })

  it("ignores the observer's first delivery (a size, not a change)", () => {
    render(
      <MessageThread>
        <span />
      </MessageThread>
    )

    resizeTo(400)

    expect(testState.scrollToBottom).not.toHaveBeenCalled()
  })

  // The reported bug: the live-turn stats bar / restored terminal panel takes
  // vertical space away from the thread, which moves the bottom without moving
  // scrollTop — and fires neither a scroll event nor a content resize.
  it("re-pins to the bottom when the viewport shrinks under a pinned thread", () => {
    mountThreadAt(400)

    resizeTo(368)

    expect(testState.scrollToBottom).toHaveBeenCalledWith({
      animation: "instant",
      preserveScrollPosition: true,
    })
  })

  it("leaves a thread the user scrolled away from where it is", () => {
    mountThreadAt(400)
    testState.state.isAtBottom = false

    resizeTo(368)

    expect(testState.scrollToBottom).not.toHaveBeenCalled()
    expect(testState.state.resizeDifference).toBe(0)
  })

  // A growing viewport shrinks the maximum scroll offset, so the browser clamps
  // scrollTop and fires a scroll event that looks exactly like the user
  // scrolling up. `resizeDifference` is what makes the library discount it.
  it("marks the resize so the clamped scroll can't escape the lock", () => {
    mountThreadAt(368)

    resizeTo(400)

    expect(testState.state.resizeDifference).toBe(32)
  })

  // Real timers: the release rides a real `requestAnimationFrame`, which
  // vitest's fake timers leave alone.
  it("releases the resize mark a frame later", async () => {
    mountThreadAt(400)

    resizeTo(368)
    expect(testState.state.resizeDifference).toBe(-32)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    expect(testState.state.resizeDifference).toBe(0)
  })

  it("stops observing when the thread unmounts", () => {
    const { unmount } = mountThreadAt(400)

    unmount()

    expect(disconnects).toBe(1)
  })
})

describe("MessageThread escape on user scroll", () => {
  /** Give an element a scrollable box, which jsdom never lays out. */
  const makeScrollable = (
    el: HTMLElement,
    { scrollHeight = 2000, clientHeight = 400, scrollTop = 1600 } = {}
  ) => {
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      value: scrollHeight,
    })
    Object.defineProperty(el, "clientHeight", {
      configurable: true,
      value: clientHeight,
    })
    el.scrollTop = scrollTop
  }

  const viewport = () => testState.scrollRef.current as HTMLDivElement

  /** Mount with a scrollable viewport and a plain row inside it. */
  const mountScrollable = () => {
    makeScrollable(viewport())
    const row = document.createElement("div")
    viewport().appendChild(row)
    mountThreadAt(400)
    return row
  }

  const wheel = (target: Element, deltaY: number) =>
    target.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }))

  const touch = (target: Element, type: string, clientY: number) => {
    const event = new Event(type, { bubbles: true })
    Object.defineProperty(event, "touches", {
      value: type === "touchend" ? [] : [{ clientY }],
    })
    target.dispatchEvent(event)
  }

  // The reported bug, desktop: the library only escapes a wheel whose nearest
  // `overflow: auto` ancestor is the viewport, so wheeling up over a code
  // block (overflow-auto, nothing to scroll vertically) kept the lock.
  it("escapes on an upward wheel over a nested horizontal scroller", () => {
    mountScrollable()
    const code = document.createElement("pre")
    code.style.overflow = "auto"
    viewport().appendChild(code)

    wheel(code, -40)

    expect(testState.stopScroll).toHaveBeenCalledTimes(1)
  })

  it("leaves the lock alone on a downward wheel", () => {
    const row = mountScrollable()

    wheel(row, 40)

    expect(testState.stopScroll).not.toHaveBeenCalled()
  })

  it("lets a nested vertical scroller that can still scroll up take the wheel", () => {
    mountScrollable()
    const output = document.createElement("div")
    output.style.overflowY = "auto"
    makeScrollable(output, {
      scrollHeight: 600,
      clientHeight: 200,
      scrollTop: 50,
    })
    viewport().appendChild(output)

    wheel(output, -40)

    expect(testState.stopScroll).not.toHaveBeenCalled()
  })

  // The reported bug, mobile: touch scrolls only reach the library as scroll
  // events, which it discards while any content resize is in flight.
  it("escapes when a finger drags the transcript down, even mid-resize", () => {
    const row = mountScrollable()
    testState.state.resizeDifference = 24

    touch(row, "touchstart", 300)
    touch(row, "touchmove", 302)
    expect(testState.stopScroll).not.toHaveBeenCalled()

    touch(row, "touchmove", 320)
    expect(testState.stopScroll).toHaveBeenCalledTimes(1)
  })

  it("does not escape when a finger drags the transcript up", () => {
    const row = mountScrollable()

    touch(row, "touchstart", 300)
    touch(row, "touchmove", 200)
    touch(row, "touchend", 200)

    expect(testState.stopScroll).not.toHaveBeenCalled()
  })

  it("escapes on keyboard scrolling up but not from an editable field", () => {
    const row = mountScrollable()
    const input = document.createElement("textarea")
    viewport().appendChild(input)

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })
    )
    expect(testState.stopScroll).not.toHaveBeenCalled()

    row.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })
    )
    expect(testState.stopScroll).toHaveBeenCalledTimes(1)
  })

  it("does nothing once the lock is already released", () => {
    const row = mountScrollable()
    testState.state.isAtBottom = false
    testState.state.escapedFromLock = true

    wheel(row, -40)

    expect(testState.stopScroll).not.toHaveBeenCalled()
  })

  it("keeps the lock during an ignoreEscapes scroll", () => {
    const row = mountScrollable()
    testState.state.animation = { ignoreEscapes: true }

    wheel(row, -40)

    expect(testState.stopScroll).not.toHaveBeenCalled()
  })

  it("does nothing when the transcript fits without scrolling", () => {
    makeScrollable(viewport(), { scrollHeight: 400, clientHeight: 400 })
    const row = document.createElement("div")
    viewport().appendChild(row)
    mountThreadAt(400)

    wheel(row, -40)

    expect(testState.stopScroll).not.toHaveBeenCalled()
  })

  it("stops listening when the thread unmounts", () => {
    makeScrollable(viewport())
    const row = document.createElement("div")
    viewport().appendChild(row)
    const { unmount } = mountThreadAt(400)

    unmount()
    wheel(row, -40)

    expect(testState.stopScroll).not.toHaveBeenCalled()
  })
})
