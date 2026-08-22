import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function fireMouse(target: Element, type: string) {
  fireEvent(
    target,
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
  )
}

function click(target: Element) {
  fireMouse(target, "pointerdown")
  fireMouse(target, "mousedown")
  fireMouse(target, "mouseup")
  fireMouse(target, "click")
}

function popup() {
  return document.querySelector("[data-slot=drawer-popup]")
}

describe("drawer with nested/sibling Radix layers", () => {
  it("stays open when a press lands in a sibling Dialog", async () => {
    const onOpenChange = vi.fn()
    render(
      <>
        <Drawer open onOpenChange={onOpenChange} swipeDirection="right">
          <DrawerContent>
            <DrawerTitle>Task</DrawerTitle>
            <div>drawer body</div>
          </DrawerContent>
        </Drawer>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Diff</DialogTitle>
            <button type="button">inside dialog</button>
          </DialogContent>
        </Dialog>
      </>
    )
    await settle()

    click(screen.getByText("inside dialog"))
    await settle()

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(popup()).toBeTruthy()
  })

  it("stays open when a press lands in a sibling AlertDialog", async () => {
    const onOpenChange = vi.fn()
    render(
      <>
        <Drawer open onOpenChange={onOpenChange} swipeDirection="right">
          <DrawerContent>
            <DrawerTitle>Task</DrawerTitle>
          </DrawerContent>
        </Drawer>
        <AlertDialog open>
          <AlertDialogContent>
            <AlertDialogTitle>Delete?</AlertDialogTitle>
            <button type="button">inside alert</button>
          </AlertDialogContent>
        </AlertDialog>
      </>
    )
    await settle()

    click(screen.getByText("inside alert"))
    await settle()

    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("lets Escape close only the topmost layer", async () => {
    const onOpenChange = vi.fn()
    render(
      <Drawer open onOpenChange={onOpenChange} swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Task</DrawerTitle>
          <Select defaultValue="one">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="one">One</SelectItem>
              <SelectItem value="two">Two</SelectItem>
            </SelectContent>
          </Select>
        </DrawerContent>
      </Drawer>
    )
    await settle()

    fireEvent.click(screen.getByRole("combobox"))
    await settle()
    expect(screen.queryByText("Two")).toBeInTheDocument()

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    })
    await settle()

    // First Escape dismisses the select only.
    expect(screen.queryByText("Two")).not.toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()

    // Second Escape reaches the drawer.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    })
    await settle()
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything())
  })

  /**
   * The naive version of the test above passes even with a broken guard,
   * because jsdom batches the state update that tears the Radix layer down. In
   * a real engine a keydown is discrete, so React flushes synchronously between
   * Radix's capture-phase handler and Base UI's bubble-phase one and the
   * `pointer-events` shield is already gone by the time the drawer is asked.
   *
   * This reproduces that ordering directly: a capture listener registered after
   * the drawer's own probe (as a later-mounting Radix layer always is) which
   * drops the shield synchronously. Only a guard that sampled during capture
   * survives it.
   */
  it("survives an Escape whose Radix layer tears the shield down synchronously", async () => {
    const onOpenChange = vi.fn()
    render(
      <Drawer open onOpenChange={onOpenChange} swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Task</DrawerTitle>
        </DrawerContent>
      </Drawer>
    )
    await settle()

    document.body.style.pointerEvents = "none"
    const teardown = () => {
      document.body.style.pointerEvents = ""
    }
    document.addEventListener("keydown", teardown, true)
    try {
      fireEvent.keyDown(document.body, { key: "Escape" })
      await settle()
    } finally {
      document.removeEventListener("keydown", teardown, true)
      document.body.style.pointerEvents = ""
    }

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(popup()).toBeTruthy()
  })

  it("still closes on a plain outside press and a plain Escape", async () => {
    const onOutside = vi.fn()
    const { unmount } = render(
      <Drawer open onOpenChange={onOutside} swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Task</DrawerTitle>
        </DrawerContent>
      </Drawer>
    )
    await settle()
    click(document.body)
    await settle()
    expect(onOutside).toHaveBeenCalledWith(false, expect.anything())
    unmount()

    const onEscape = vi.fn()
    render(
      <Drawer open onOpenChange={onEscape} swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Task</DrawerTitle>
        </DrawerContent>
      </Drawer>
    )
    await settle()
    fireEvent.keyDown(document.body, { key: "Escape" })
    await settle()
    expect(onEscape).toHaveBeenCalledWith(false, expect.anything())
  })
})
