import { describe, expect, it } from "vitest"

import {
  BROWSER_DEVICES,
  DEVICE_VIEWPORTS,
  MIN_PAGE_ZOOM,
  browserTabDevice,
  deviceViewport,
  fitDeviceFrame,
  isBrowserDevice,
  isEmulatedBrowserDevice,
} from "./browser-device"

/** The CSS width a native surface of `frame.width` lays its page out at, as
 *  the engine works it out: the device pixels the platform rounds the frame
 *  to, over the device pixels one zoomed CSS pixel takes. */
function laidOutWidth(
  frame: { width: number; zoom: number },
  devicePixelRatio: number
): number {
  return (
    Math.round(frame.width * devicePixelRatio) / (devicePixelRatio * frame.zoom)
  )
}

describe("browser devices", () => {
  it("knows the three devices, desktop first", () => {
    expect(BROWSER_DEVICES).toEqual(["desktop", "tablet", "phone"])
    expect(BROWSER_DEVICES.every(isBrowserDevice)).toBe(true)
    expect(isBrowserDevice("watch")).toBe(false)
    expect(isEmulatedBrowserDevice("desktop")).toBe(false)
    expect(isEmulatedBrowserDevice("phone")).toBe(true)
  })

  it("gives the desktop no viewport of its own", () => {
    expect(deviceViewport("desktop")).toBeNull()
    expect(deviceViewport("tablet")).toEqual({ width: 768, height: 1024 })
    expect(deviceViewport("phone")).toEqual({ width: 390, height: 844 })
  })

  it("reads a record without a device as a desktop", () => {
    expect(browserTabDevice({})).toBe("desktop")
    expect(browserTabDevice({ device: "phone" })).toBe("phone")
    // A record from somewhere that wrote nonsense is a desktop too.
    expect(browserTabDevice({ device: "watch" as unknown as "phone" })).toBe(
      "desktop"
    )
  })
})

describe("fitDeviceFrame", () => {
  const phone = DEVICE_VIEWPORTS.phone
  const tablet = DEVICE_VIEWPORTS.tablet

  it("shows a device that fits at its own size, unzoomed", () => {
    expect(fitDeviceFrame(phone, { width: 1200, height: 900 })).toEqual({
      width: 390,
      height: 844,
      scale: 1,
      zoom: 1,
    })
    // Exactly as much room as the device needs is enough.
    expect(fitDeviceFrame(phone, { width: 390, height: 844 }).zoom).toBe(1)
  })

  it("shrinks a device that does not fit, keeping its proportions", () => {
    const frame = fitDeviceFrame(tablet, { width: 900, height: 600 })
    // Height-bound: 600 / 1024 of the tablet.
    expect(frame.width).toBe(450)
    expect(frame.height).toBe(600)
    expect(frame.scale).toBeCloseTo(450 / 768)
    expect(frame.width).toBeLessThanOrEqual(900)
    expect(frame.height).toBeLessThanOrEqual(600)
  })

  it("lays a shrunk page out at the device's width, never a pixel short", () => {
    // The tablet is the one where a pixel matters: at 767 a page's `md`
    // breakpoint is off and the tablet shows the phone layout.
    for (const devicePixelRatio of [1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
      for (let height = 260; height < 1024; height += 7) {
        for (const viewport of [tablet, phone]) {
          const frame = fitDeviceFrame(
            viewport,
            { width: 2000, height },
            devicePixelRatio
          )
          if (frame.zoom === MIN_PAGE_ZOOM) continue
          const width = laidOutWidth(frame, devicePixelRatio)
          expect(width).toBeGreaterThanOrEqual(viewport.width)
          expect(width).toBeLessThan(viewport.width + 0.5)
          // The height too — unless the slot has no more room to give.
          const laidOutHeight =
            Math.round(frame.height * devicePixelRatio) /
            (devicePixelRatio * frame.zoom)
          if (frame.height < Math.floor(height)) {
            expect(laidOutHeight).toBeGreaterThanOrEqual(viewport.height)
            // Over by at most the one frame pixel it was rounded up by,
            // which a small zoom makes several of the page's.
            expect(laidOutHeight).toBeLessThan(
              viewport.height + 1.5 / frame.zoom
            )
          }
          expect(frame.height).toBeLessThanOrEqual(height)
          // Whole CSS pixels, so WebKit's whole-point view is the frame.
          expect(Number.isInteger(frame.width)).toBe(true)
        }
      }
    }
  })

  // A device at its own size is drawn at whatever the display rounds it to:
  // at 140% a 768-pixel tablet is 1075 device pixels, 767.86 CSS pixels —
  // and `min-width: 768px` is off unless the page is zoomed to make it up.
  it("keeps a device drawn at its own size at its width on any display", () => {
    for (const devicePixelRatio of [1, 1.1, 1.25, 1.4, 1.5, 1.75, 2, 2.25]) {
      for (const viewport of [tablet, phone]) {
        const frame = fitDeviceFrame(
          viewport,
          { width: 3000, height: 2000 },
          devicePixelRatio
        )
        expect(frame.width).toBe(viewport.width)
        expect(laidOutWidth(frame, devicePixelRatio)).toBeGreaterThanOrEqual(
          viewport.width
        )
        expect(laidOutWidth(frame, devicePixelRatio)).toBeLessThan(
          viewport.width + 0.5
        )
      }
    }
    // Drawn whole, it needs no zoom at all.
    expect(
      fitDeviceFrame(tablet, { width: 3000, height: 2000 }, 1.25).zoom
    ).toBe(1)
    expect(
      fitDeviceFrame(tablet, { width: 3000, height: 2000 }, 1.4).zoom
    ).toBeLessThan(1)
  })

  it("lays the page out narrower only below the engines' least zoom, and keeps the frame's shape", () => {
    const frame = fitDeviceFrame(tablet, { width: 120, height: 2000 })
    expect(frame.zoom).toBe(MIN_PAGE_ZOOM)
    expect(laidOutWidth(frame, 1)).toBeLessThan(tablet.width)
    // 120 wide is 160 tall in a tablet's proportions.
    expect(frame).toMatchObject({ width: 120, height: 160 })
  })

  it("has nothing to show in a pane with no room", () => {
    for (const available of [
      { width: 0, height: 600 },
      { width: 800, height: 0 },
      { width: -40, height: -40 },
      { width: Number.NaN, height: 600 },
      // Room, but not for one whole pixel: no frame bigger than its room.
      { width: 0.5, height: 0.5 },
    ]) {
      expect(fitDeviceFrame(phone, available)).toEqual({
        width: 0,
        height: 0,
        scale: 0,
        zoom: 1,
      })
    }
  })

  it("treats a nonsense pixel ratio as 1", () => {
    const sane = fitDeviceFrame(tablet, { width: 900, height: 600 }, 1)
    expect(fitDeviceFrame(tablet, { width: 900, height: 600 }, 0)).toEqual(sane)
    expect(
      fitDeviceFrame(tablet, { width: 900, height: 600 }, Number.NaN)
    ).toEqual(sane)
  })
})
