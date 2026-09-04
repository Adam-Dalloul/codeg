import { fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RowMoreButton } from "./row-more-button"

// `next-intl`'s `useTranslations` returns the leaf string for the requested
// key. Stub it to a fixed value so the test only checks button behaviour, not
// translation plumbing.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `tr:${key}`,
}))

interface Fixture {
  row: HTMLElement
  button: HTMLElement
  onContextMenu: ReturnType<typeof vi.fn>
  onRowClick: ReturnType<typeof vi.fn>
}

function renderInRow(): Fixture {
  const onContextMenu = vi.fn()
  const onRowClick = vi.fn()
  const utils = render(
    <div data-testid="row" data-tree-row-path="x" onClick={onRowClick}>
      <RowMoreButton />
    </div>
  )
  // The RowMoreButton needs to find a row ancestor carrying
  // `data-tree-row-path` — wrap the rendered tree in that for the dispatched
  // event to bubble to. jsdom won't bubble a `contextmenu` event from a
  // `div` to its `oncontextmenu` listener unless React registered it, so we
  // wire one on the parent ourselves.
  const row = utils.container.querySelector(
    "[data-tree-row-path]"
  ) as HTMLElement
  row.addEventListener("contextmenu", onContextMenu as EventListener)
  const button = utils.getByLabelText("tr:moreActions")
  return { row, button, onContextMenu, onRowClick }
}

describe("RowMoreButton", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders a button labelled with the moreActions translation key", () => {
    const { button } = renderInRow()
    expect(button.tagName).toBe("BUTTON")
    expect(button.getAttribute("aria-label")).toBe("tr:moreActions")
    // The icon is hidden from AT — only the label announces the control.
    const icon = button.querySelector("svg")
    expect(icon?.getAttribute("aria-hidden")).not.toBeNull()
  })

  it("dispatches a contextmenu MouseEvent on the row when clicked", () => {
    const { button, onContextMenu } = renderInRow()
    fireEvent.click(button, { clientX: 12, clientY: 34 })
    expect(onContextMenu).toHaveBeenCalledTimes(1)
    const event = onContextMenu.mock.calls[0][0] as MouseEvent
    expect(event.type).toBe("contextmenu")
    expect(event.button).toBe(2)
    expect(event.clientX).toBe(12)
    expect(event.clientY).toBe(34)
    expect(event.bubbles).toBe(true)
    expect(event.cancelable).toBe(true)
  })

  it("does not bubble the click up to the row's own onClick", () => {
    const { button, onRowClick } = renderInRow()
    fireEvent.click(button)
    expect(onRowClick).not.toHaveBeenCalled()
  })
})
