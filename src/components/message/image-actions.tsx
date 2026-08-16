"use client"

import { type ReactNode, useCallback } from "react"
import { Copy, Download } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { copyImageToClipboard } from "@/lib/copy-image"
import { downloadImage } from "@/lib/image-download"
import { toErrorMessage } from "@/lib/app-error"
import type { UserImageDisplay } from "@/lib/adapters/ai-elements-adapter"

/**
 * Right-click menu on a transcript image: Copy image / Download image.
 *
 * The conversation panel wraps the whole transcript in its own context
 * menu, so this trigger stops the event from bubbling — same contract as
 * `FileReferenceActions`. Right-clicking the image is about the image;
 * right-clicking anywhere else still gets the conversation menu.
 */
export function ImageActions({
  image,
  children,
}: {
  image: UserImageDisplay
  children: ReactNode
}) {
  const t = useTranslations("Folder.chat.messageList")

  const handleCopy = useCallback(async () => {
    try {
      await copyImageToClipboard({
        data: image.data,
        mime_type: image.mime_type,
      })
      toast.success(t("copiedImage"))
    } catch (err) {
      toast.error(t("copyImageFailed", { message: toErrorMessage(err) }))
    }
  }, [image, t])

  const handleDownload = useCallback(async () => {
    try {
      await downloadImage({
        data: image.data,
        mime_type: image.mime_type,
        suggestedName: image.name,
      })
    } catch (err) {
      window.alert(t("downloadFailed", { message: toErrorMessage(err) }))
    }
  }, [image, t])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-image-actions=""
          // Radix's own handler still runs on this element; only the
          // ancestor conversation-panel trigger is cut off.
          onContextMenu={(event) => event.stopPropagation()}
          onPointerDown={(event) => {
            if (event.pointerType !== "mouse") event.stopPropagation()
          }}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void handleCopy()}>
          <Copy className="h-4 w-4" />
          {t("copyImage")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void handleDownload()}>
          <Download className="h-4 w-4" />
          {t("downloadImage")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
