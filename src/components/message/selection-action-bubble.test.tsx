import { useRef } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SelectionActionBubble } from "./selection-action-bubble"
import enMessages from "@/i18n/messages/en.json"

// The container's box. jsdom does no layout, so every rect the component reads
// is stubbed: the container via Element.prototype, the selection via the fake
// Range below.
const BOX = {
  top: 100,
  bottom: 600,
  left: 0,
  right: 400,
  width: 400,
  height: 500,
  x: 0,
  y: 100,
} as DOMRect

/** A selection rect 100px down from the container top — room for the bubble above. */
const SELECTION_RECT = {
  top: 200,
  bottom: 220,
  left: 100,
  right: 180,
  width: 80,
  height: 20,
  x: 100,
  y: 200,
} as DOMRect

const removeAllRanges = vi.fn()

function mockSelection(
  container: Node | null,
  text: string,
  rect: DOMRect = SELECTION_RECT
) {
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: text.length === 0,
    rangeCount: container ? 1 : 0,
    getRangeAt: () => ({
      commonAncestorContainer: container,
      getBoundingClientRect: () => rect,
    }),
    toString: () => text,
    removeAllRanges,
  } as unknown as Selection)
}

/** Fire the browser event the component listens on, inside `act`. */
function selectionChanged() {
  act(() => {
    fireEvent(document, new Event("selectionchange"))
  })
}

/**
 * Dispatch a pointer event carrying a real `button`. jsdom has no
 * `PointerEvent`, so RTL's `fireEvent.pointerDown` falls back to a bare `Event`
 * with no `button` property at all — which can't distinguish a left-click from
 * a right-click. `MouseEvent` implements `button` properly, and Blink dispatches
 * pointer events as a `PointerEvent` (a `MouseEvent` subclass), so this is the
 * faithful shape for the button-sensitive cases.
 */
function firePointer(
  type: "pointerdown" | "pointerup" | "pointercancel",
  target: Element,
  init: MouseEventInit = {}
) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
    )
  })
}

function Harness({ onQuote }: { onQuote?: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div ref={ref} data-testid="box">
        <p data-testid="para">hello world</p>
        <SelectionActionBubble containerRef={ref} onQuote={onQuote} />
      </div>
    </NextIntlClientProvider>
  )
}

let rectSpy: ReturnType<typeof vi.spyOn>

/**
 * jsdom lays nothing out, so the toolbar's own width — which the edge clamp
 * depends on — reads 0. Stub it, and return a restore fn.
 */
function mockToolbarWidth(width: number) {
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth"
  )
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => width,
  })
  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", original)
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)
        .offsetWidth
    }
  }
}

beforeEach(() => {
  removeAllRanges.mockClear()
  rectSpy = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue(BOX)
})

afterEach(() => {
  rectSpy.mockRestore()
  vi.restoreAllMocks()
})

describe("SelectionActionBubble", () => {
  it("renders nothing without a selection", () => {
    mockSelection(null, "")
    render(<Harness onQuote={vi.fn()} />)
    selectionChanged()
    expect(screen.queryByRole("toolbar")).toBeNull()
  })

  it("renders nothing for a whitespace-only selection", () => {
    const { container } = render(<Harness onQuote={vi.fn()} />)
    mockSelection(container.querySelector("[data-testid=para]"), "  \n ")
    selectionChanged()
    expect(screen.queryByRole("toolbar")).toBeNull()
  })

  it("ignores a selection made outside the container", () => {
    const outside = document.createElement("div")
    document.body.appendChild(outside)
    render(<Harness onQuote={vi.fn()} />)
    mockSelection(outside, "elsewhere")
    selectionChanged()
    expect(screen.queryByRole("toolbar")).toBeNull()
    outside.remove()
  })

  it("shows copy and quote above the selection", () => {
    const { container } = render(<Harness onQuote={vi.fn()} />)
    mockSelection(container.querySelector("[data-testid=para]"), "hello")
    selectionChanged()

    const toolbar = screen.getByRole("toolbar")
    expect(screen.getByRole("button", { name: "Copy Text" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Quote" })).toBeTruthy()
    // Centred on the selection (140 = 100 + 80/2), pinned 8px above its top
    // (92 = 200 - 100 - 8) and pulled fully above by the transform.
    expect(toolbar.style.left).toBe("140px")
    expect(toolbar.style.top).toBe("92px")
    expect(toolbar.style.transform).toBe("translate(-50%, -100%)")
  })

  it("flips below a selection with no room above it", () => {
    const { container } = render(<Harness onQuote={vi.fn()} />)
    mockSelection(container.querySelector("[data-testid=para]"), "hello", {
      ...SELECTION_RECT,
      top: 110,
      bottom: 130,
      y: 110,
    } as DOMRect)
    selectionChanged()

    const toolbar = screen.getByRole("toolbar")
    expect(toolbar.style.top).toBe("38px") // 130 - 100 + 8
    expect(toolbar.style.transform).toBe("translate(-50%, 0)")
  })

  it("hides while the selection is scrolled out of the message area", () => {
    const { container } = render(<Harness onQuote={vi.fn()} />)
    mockSelection(container.querySelector("[data-testid=para]"), "hello", {
      ...SELECTION_RECT,
      top: 20,
      bottom: 40,
      y: 20,
    } as DOMRect)
    selectionChanged()
    expect(screen.queryByRole("toolbar")).toBeNull()
  })

  it("omits the quote action when no quote handler is given", () => {
    const { container } = render(<Harness />)
    mockSelection(container.querySelector("[data-testid=para]"), "hello")
    selectionChanged()

    expect(screen.getByRole("button", { name: "Copy Text" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Quote" })).toBeNull()
  })

  it("quotes the raw selected text, then clears the selection and hides", () => {
    const onQuote = vi.fn()
    const { container } = render(<Harness onQuote={onQuote} />)
    mockSelection(
      container.querySelector("[data-testid=para]"),
      "first line\nsecond line"
    )
    selectionChanged()

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Quote" }))
    })

    // The bubble hands over the selection verbatim — turning it into Markdown is
    // the host's job (buildQuotedMarkdown).
    expect(onQuote).toHaveBeenCalledWith("first line\nsecond line")
    expect(removeAllRanges).toHaveBeenCalled()
    expect(screen.queryByRole("toolbar")).toBeNull()
  })

  it("copies the selected text and confirms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    const { container } = render(<Harness onQuote={vi.fn()} />)
    mockSelection(container.querySelector("[data-testid=para]"), "hello world")
    selectionChanged()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy Text" }))
    })

    expect(writeText).toHaveBeenCalledWith("hello world")
    expect(screen.getByRole("button", { name: "Copy Text" }).textContent).toBe(
      "Copied"
    )
  })

  it("survives a tap that clears the selection before the click lands", () => {
    // The touch path: no mousedown to preventDefault, so the tap itself drops
    // the selection. Tearing the bubble down on that selectionchange would
    // unmount the button before its click is dispatched.
    const onQuote = vi.fn()
    const { container } = render(<Harness onQuote={onQuote} />)
    mockSelection(container.querySelector("[data-testid=para]"), "hello")
    selectionChanged()

    const quote = screen.getByRole("button", { name: "Quote" })
    act(() => {
      fireEvent.pointerDown(quote)
    })
    mockSelection(null, "")
    selectionChanged()
    expect(screen.queryByRole("toolbar")).not.toBeNull()

    act(() => {
      fireEvent.pointerUp(quote)
      fireEvent.click(quote)
    })
    expect(onQuote).toHaveBeenCalledWith("hello")
  })

  it("keeps its whole box inside the container near the edges", () => {
    // The toolbar is centred on `x` by a -50% transform, so clamping the anchor
    // alone lets half of it hang past the edge, where the panel's
    // overflow-hidden shears it off (measured in Chrome: 35px of a button gone
    // in a 300px-wide tiled column).
    const restore = mockToolbarWidth(160) // half = 80, so x must stay in [88, 312]
    try {
      const { container } = render(<Harness onQuote={vi.fn()} />)
      const para = container.querySelector("[data-testid=para]")

      // Hard against the left edge of the 400px-wide container.
      mockSelection(para, "hello", {
        ...SELECTION_RECT,
        left: 0,
        right: 40,
        width: 40,
        x: 0,
      } as DOMRect)
      selectionChanged()
      // The first measure runs before the toolbar exists (offsetWidth 0), so it
      // takes a second pass — the frame loop's — to settle on the clamped value.
      selectionChanged()
      expect(screen.getByRole("toolbar").style.left).toBe("88px")

      // ...and against the right edge.
      mockSelection(para, "hello", {
        ...SELECTION_RECT,
        left: 360,
        right: 400,
        width: 40,
        x: 360,
      } as DOMRect)
      selectionChanged()
      expect(screen.getByRole("toolbar").style.left).toBe("312px")
    } finally {
      restore()
    }
  })

  it("centres a toolbar too wide to fit rather than clamping it off-screen", () => {
    const restore = mockToolbarWidth(900) // wider than the 400px container
    try {
      const { container } = render(<Harness onQuote={vi.fn()} />)
      mockSelection(container.querySelector("[data-testid=para]"), "hello")
      selectionChanged()
      selectionChanged()
      expect(screen.getByRole("toolbar").style.left).toBe("200px")
    } finally {
      restore()
    }
  })

  it.each([
    ["a cancelled press", "pointerCancel" as const, 0],
    ["a right-click", "pointerDown" as const, 2],
  ])("does not freeze tracking after %s inside it", (_label, kind, button) => {
    // Neither a pointercancel nor a right-click is followed by a `click`, so the
    // press-inside guard has nothing to release it unless these paths clear it
    // themselves — the bubble would stay stuck at its old coordinates.
    const { container } = render(<Harness onQuote={vi.fn()} />)
    const para = container.querySelector("[data-testid=para]")
    mockSelection(para, "hello")
    selectionChanged()
    const quote = screen.getByRole("button", { name: "Quote" })
    expect(screen.getByRole("toolbar").style.top).toBe("92px")

    if (kind === "pointerCancel") {
      firePointer("pointerdown", quote)
      firePointer("pointercancel", quote)
    } else {
      firePointer("pointerdown", quote, { button })
      firePointer("pointerup", quote, { button })
    }

    // Same selection, new geometry — as after a scroll.
    mockSelection(para, "hello", {
      ...SELECTION_RECT,
      top: 260,
      bottom: 280,
      y: 260,
    } as DOMRect)
    selectionChanged()
    expect(screen.getByRole("toolbar").style.top).toBe("152px")
  })

  it("keeps tracking the selection after one of its buttons is clicked", async () => {
    // Regression (caught in a real browser): the tap guard above stayed armed
    // once the click had landed, so the bubble stopped following the text —
    // scrolling the thread left it stranded at its original coordinates.
    const { container } = render(<Harness onQuote={vi.fn()} />)
    const para = container.querySelector("[data-testid=para]")
    mockSelection(para, "hello")
    selectionChanged()
    expect(screen.getByRole("toolbar").style.top).toBe("92px")

    const copy = screen.getByRole("button", { name: "Copy Text" })
    await act(async () => {
      fireEvent.pointerDown(copy)
      fireEvent.pointerUp(copy)
      fireEvent.click(copy)
    })

    // Same selection, new geometry — as after a scroll.
    mockSelection(para, "hello", {
      ...SELECTION_RECT,
      top: 260,
      bottom: 280,
      y: 260,
    } as DOMRect)
    selectionChanged()
    expect(screen.getByRole("toolbar").style.top).toBe("152px") // 260 - 100 - 8
  })

  it("stays hidden while a drag is in flight and appears on release", () => {
    const { container } = render(<Harness onQuote={vi.fn()} />)
    const para = container.querySelector("[data-testid=para]")

    act(() => {
      fireEvent.pointerDown(document)
    })
    mockSelection(para, "hello")
    selectionChanged()
    expect(screen.queryByRole("toolbar")).toBeNull()

    // pointerup re-reads the finalised selection on the next task.
    vi.useFakeTimers()
    try {
      act(() => {
        fireEvent.pointerUp(document)
        vi.runAllTimers()
      })
    } finally {
      vi.useRealTimers()
    }
    expect(screen.getByRole("toolbar")).toBeTruthy()
  })
})
