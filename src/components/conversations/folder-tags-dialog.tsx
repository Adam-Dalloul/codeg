"use client"

import { Settings2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { openSettingsWindow } from "@/lib/api"
import { formatFolderLabelWithAlias } from "@/lib/folder-display"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ConversationTagListEditor } from "./conversation-tag-list-editor"

/**
 * A folder's own tags, edited in place from its sidebar menu. Opened on any
 * folder row — a worktree's included — and always edits the ROOT folder's
 * list, because that is the one the worktree's conversations are offered.
 */
export function FolderTagsDialog({
  folderId,
  open,
  onOpenChange,
}: {
  folderId: number
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("ConversationTags.folderDialog")
  const folder = useAppWorkspaceStore((s) =>
    s.allFolders.find((f) => f.id === folderId)
  )
  const rootId = folder?.parent_id ?? folderId
  const root = useAppWorkspaceStore((s) =>
    s.allFolders.find((f) => f.id === rootId)
  )
  const label = root
    ? formatFolderLabelWithAlias(root)
    : folder
      ? formatFolderLabelWithAlias(folder)
      : `#${rootId}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[30rem]">
        <DialogHeader>
          <DialogTitle className="truncate">
            {t("title", { folder: label })}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <ConversationTagListEditor
          scopeFolderId={rootId}
          className="max-h-[50vh] overflow-y-auto"
        />
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              void openSettingsWindow("conversation-tags")
            }}
          >
            <Settings2 className="size-3.5" />
            {t("globalTags")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
