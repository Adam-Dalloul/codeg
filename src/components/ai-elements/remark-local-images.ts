import type { Definition, Image, ImageReference, Root } from "mdast"
import { SKIP, visit } from "unist-util-visit"
import { localImagePath } from "@/lib/markdown-local-image"

/** Preserve local Markdown images as inert spans until React can load them
 * through the workspace-confined reader. Remote images retain the default
 * sanitize/harden pipeline; no file: or data: protocol is allowed through it. */
export function remarkLocalImages() {
  return (tree: Root) => {
    const definitions = new Map<string, Definition>()
    visit(tree, "definition", (node) => {
      const id = node.identifier.toUpperCase()
      if (!definitions.has(id)) definitions.set(id, node)
    })
    const linkedImages = new WeakSet<Image | ImageReference>()
    visit(tree, ["link", "linkReference"], (node) => {
      visit(node, ["image", "imageReference"], (image) => {
        linkedImages.add(image as Image | ImageReference)
      })
      return SKIP
    })
    visit(tree, ["image", "imageReference"], (node) => {
      const image = node as Image | ImageReference
      const source =
        image.type === "image"
          ? image.url
          : definitions.get(image.identifier.toUpperCase())?.url
      if (!source || !localImagePath(source)) return
      image.data = {
        ...image.data,
        hName: "span",
        hProperties: {
          "data-codeg-local-image": source,
          "data-codeg-image-linked": linkedImages.has(image) ? "true" : "false",
        },
        hChildren: [{ type: "text", value: image.alt ?? "" }],
      }
    })
  }
}
