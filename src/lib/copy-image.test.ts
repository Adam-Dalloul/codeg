import { afterEach, describe, expect, it, vi } from "vitest"

import {
  canCopyImageToClipboard,
  ClipboardImageUnsupportedError,
  copyImageToClipboard,
  normalizeImageMime,
} from "./copy-image"

describe("normalizeImageMime", () => {
  it("normalizes jpeg aliases and empty", () => {
    expect(normalizeImageMime("image/JPG")).toBe("image/jpeg")
    expect(normalizeImageMime(" image/png ")).toBe("image/png")
    expect(normalizeImageMime("")).toBe("image/png")
  })
})

describe("copyImageToClipboard", () => {
  const writes: ClipboardItem[] = []

  afterEach(() => {
    writes.length = 0
    vi.unstubAllGlobals()
  })

  it("writes a PNG ClipboardItem", async () => {
    // 1x1 PNG
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    vi.stubGlobal(
      "ClipboardItem",
      class FakeItem {
        constructor(public items: Record<string, Blob>) {}
      }
    )
    vi.stubGlobal("navigator", {
      clipboard: {
        write: async (items: ClipboardItem[]) => {
          writes.push(...items)
        },
      },
    })
    await copyImageToClipboard({ data: png, mime_type: "image/png" })
    expect(writes).toHaveLength(1)
    const item = writes[0] as unknown as { items: Record<string, Blob> }
    expect(item.items["image/png"]).toBeInstanceOf(Blob)
    expect(item.items["image/png"].type).toBe("image/png")
  })

  it("throws when the clipboard cannot take images", async () => {
    vi.stubGlobal("navigator", { clipboard: {} })
    await expect(
      copyImageToClipboard({ data: "QQ==", mime_type: "image/png" })
    ).rejects.toBeInstanceOf(ClipboardImageUnsupportedError)
    expect(canCopyImageToClipboard()).toBe(false)
  })
})
