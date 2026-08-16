/**
 * Copy an inline base64 image to the system clipboard as a real image
 * (so Paste in another app inserts pixels, not a path).
 *
 * Chrome / Edge / Tauri webview accept `image/png` on `ClipboardItem`.
 * JPEG / webp / gif are rewritten to PNG via a canvas so the write is
 * not rejected. Environments without `clipboard.write` throw a typed
 * error the UI can surface.
 */

export function canCopyImageToClipboard(): boolean {
  return (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  )
}

export class ClipboardImageUnsupportedError extends Error {
  constructor() {
    super("This environment cannot copy images to the clipboard")
    this.name = "ClipboardImageUnsupportedError"
  }
}

export async function copyImageToClipboard(opts: {
  data: string
  mime_type: string
}): Promise<void> {
  if (!canCopyImageToClipboard()) {
    throw new ClipboardImageUnsupportedError()
  }
  const bytes = base64ToUint8Array(opts.data)
  const sourceType = normalizeImageMime(opts.mime_type)
  const png =
    sourceType === "image/png"
      ? new Blob([bytes as BlobPart], { type: "image/png" })
      : await rasterToPngBlob(bytes, sourceType)
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
}

export function normalizeImageMime(mime: string): string {
  const trimmed = mime.trim().toLowerCase()
  if (trimmed === "image/jpg") return "image/jpeg"
  return trimmed || "image/png"
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function rasterToPngBlob(bytes: Uint8Array, mime: string): Promise<Blob> {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    // Node / tests without a DOM: keep the original bytes tagged as PNG
    // only when they already are; otherwise fail closed.
    if (mime === "image/png") {
      return Promise.resolve(new Blob([bytes as BlobPart], { type: "image/png" }))
    }
    return Promise.reject(new ClipboardImageUnsupportedError())
  }
  return new Promise((resolve, reject) => {
    const blob = new Blob([bytes as BlobPart], { type: mime })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = img.naturalWidth || img.width
        canvas.height = img.naturalHeight || img.height
        const ctx = canvas.getContext("2d")
        if (!ctx) {
          reject(new ClipboardImageUnsupportedError())
          return
        }
        ctx.drawImage(img, 0, 0)
        canvas.toBlob((out) => {
          URL.revokeObjectURL(url)
          if (!out) {
            reject(new ClipboardImageUnsupportedError())
            return
          }
          resolve(out)
        }, "image/png")
      } catch (err) {
        URL.revokeObjectURL(url)
        reject(err)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new ClipboardImageUnsupportedError())
    }
    img.src = url
  })
}
