// The device a browser tab shows its page as. A desktop tab's page fills the
// pane, as it always has; a tablet or phone tab lays its page out in that
// device's viewport, shown in a frame of the device's proportions, so a
// page's responsive layout can be looked at without leaving the workspace.
//
// Only the viewport is emulated: the page keeps the engine's own user agent,
// pointer and touch support. That is what a responsive layout answers to —
// its media queries ask for a width — and it keeps the identity a bot check
// sees matching the engine that sent it (see `profile.rs` on the backend).

export type BrowserDevice = "desktop" | "tablet" | "phone"

/** The devices a tab can emulate; "desktop" is the absence of one. */
export type EmulatedBrowserDevice = Exclude<BrowserDevice, "desktop">

/** In the order the device menu lists them. */
export const BROWSER_DEVICES: readonly BrowserDevice[] = [
  "desktop",
  "tablet",
  "phone",
]

export interface ViewportSize {
  width: number
  height: number
}

/**
 * The CSS viewport each emulated device lays its page out in, portrait.
 *
 * The tablet is the classic iPad / iPad mini: 768 is where every CSS
 * framework's "tablet" breakpoint begins (Tailwind `md`, Bootstrap `md`), so
 * a tablet that is any narrower would show a phone layout. The phone is the
 * iPhone 12–16's, today's most common phone viewport.
 */
export const DEVICE_VIEWPORTS: Readonly<
  Record<EmulatedBrowserDevice, ViewportSize>
> = {
  tablet: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 },
}

export function isBrowserDevice(value: unknown): value is BrowserDevice {
  return value === "desktop" || value === "tablet" || value === "phone"
}

export function isEmulatedBrowserDevice(
  value: unknown
): value is EmulatedBrowserDevice {
  return value === "tablet" || value === "phone"
}

/** The viewport `device` lays a page out in; `null` for the desktop, whose
 *  page simply fills the pane. */
export function deviceViewport(device: BrowserDevice): ViewportSize | null {
  return device === "desktop" ? null : DEVICE_VIEWPORTS[device]
}

/** The device a tab record says it emulates: the desktop when it says none,
 *  which is every tab until someone picks another. */
export function browserTabDevice(seed: {
  device?: EmulatedBrowserDevice
}): BrowserDevice {
  return isEmulatedBrowserDevice(seed.device) ? seed.device : "desktop"
}

/** The least page zoom an engine takes: Chromium (WebView2) holds its zoom to
 *  25%–500%, and the backend holds WebKit to the same. */
export const MIN_PAGE_ZOOM = 0.25

/**
 * How far past the device's width a zoomed page is meant to land, in CSS
 * pixels. Engines keep their zoom in single-precision floats, so a page
 * zoomed to exactly 768 can come out at 767.9999 — and then `min-width:
 * 768px` is false and a tablet shows its phone layout. A sliver over is read
 * as the device's width by everything that rounds (`innerWidth`, layout
 * units) and never trips a `min-width` breakpoint the device itself meets.
 */
const VIEWPORT_WIDTH_SLACK = 0.01

/** A device's frame as fitted into the space a pane has for it. */
export interface DeviceFrame {
  /** The frame's size on screen, in this document's CSS pixels. */
  width: number
  height: number
  /** Frame width over the device's: how far the frame is shrunk (≤ 1). */
  scale: number
  /** The page zoom that makes a native surface of `width` lay its page out
   *  at the device's width (1 while the device fits as it is). */
  zoom: number
}

const NO_FRAME: DeviceFrame = { width: 0, height: 0, scale: 0, zoom: 1 }

/**
 * Fit `viewport` into `available`, never enlarged: at its own size when it
 * fits, otherwise shrunk whole to the largest size that does.
 *
 * A shrunk frame shows its page zoomed out by the same factor, which is what
 * keeps the page laid out at the device's width rather than the frame's. That
 * width has to come out exact, so the frame is snapped to what the engine
 * will really be given: a whole number of CSS pixels (WebKit sizes its view
 * in whole points), and the zoom worked out from the width in device pixels
 * the platform rounds it to (`devicePixelRatio` — a Windows display at 125%
 * turns 309 pixels into 386.25 and draws 386). A frame at the device's own
 * size is no exception: at 140% a 768-pixel tablet is drawn 1075 pixels wide,
 * 767.86 CSS pixels, and needs the same correction to stay a tablet.
 */
export function fitDeviceFrame(
  viewport: ViewportSize,
  available: ViewportSize,
  devicePixelRatio = 1
): DeviceFrame {
  // No room for even one pixel (a pane that is collapsed, or not laid out
  // yet): nothing to show, rather than a frame larger than its room.
  if (!(available.width >= 1) || !(available.height >= 1)) return NO_FRAME
  const fit = Math.min(
    1,
    available.width / viewport.width,
    available.height / viewport.height
  )
  if (!(fit > 0)) return NO_FRAME
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1
  const width =
    fit >= 1 ? viewport.width : Math.max(1, Math.floor(viewport.width * fit))
  const drawnWidth = Math.round(width * dpr) / dpr
  // What the width needs; a device drawn whole at its own size needs nothing.
  const needed =
    fit >= 1 && drawnWidth >= viewport.width
      ? 1
      : Math.min(1, drawnWidth / (viewport.width + VIEWPORT_WIDTH_SLACK))
  const zoom = Math.max(MIN_PAGE_ZOOM, needed)
  let height: number
  if (needed < MIN_PAGE_ZOOM) {
    // Shrunk past what an engine will zoom: the page lays out narrower than
    // the device whatever happens, so the frame at least keeps its shape.
    height = Math.round((viewport.height * width) / viewport.width)
  } else {
    // The height follows from the zoom, the same way round: the fewest whole
    // CSS pixels the platform still draws at least the device's height tall.
    height = Math.ceil(viewport.height * zoom - 1e-9)
    if (laidOut(height, dpr, zoom) < viewport.height) height += 1
  }
  height = Math.max(1, Math.min(height, Math.floor(available.height)))
  return { width, height, scale: width / viewport.width, zoom }
}

/** The CSS pixels a page zoomed by `zoom` gets from `length` CSS pixels of
 *  this document, once the platform has rounded them to device pixels. */
function laidOut(length: number, dpr: number, zoom: number): number {
  return Math.round(length * dpr) / (dpr * zoom)
}
