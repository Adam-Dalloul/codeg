"use client"

/**
 * Settings → Conversation Tags: the one place both kinds of tag are managed.
 * Global tags (offered on every conversation, chat mode included) on top; below
 * them any folder's own tags, one folder at a time.
 *
 * Runs in the settings window, which has no workspace store, so the folder list
 * is fetched here and the tags come from the tag store alone — kept live by its
 * own sync hook, the same broadcast the workspace window listens to.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FolderTree, Globe, Tags } from "lucide-react"
import { useTranslations } from "next-intl"
import { listAllFolderDetails } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { excludeChatFolders, filterTopLevelFolders } from "@/lib/folder-display"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  FOLDER_CHANGED_EVENT,
  type FolderChange,
  type FolderDetail,
} from "@/lib/types"
import {
  useConversationTagsStore,
  useConversationTagsSync,
} from "@/stores/conversation-tags-store"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  SettingsError,
  SettingsSection,
} from "@/components/shared/settings-section"
import {
  FolderSelect,
  type FolderSelectOption,
} from "@/components/shared/folder-select"
import { ConversationTagListEditor } from "@/components/conversations/conversation-tag-list-editor"

export function ConversationTagsSettings() {
  const t = useTranslations("ConversationTags.settings")
  useConversationTagsSync()
  const tags = useConversationTagsStore((s) => s.tags)
  const tagsError = useConversationTagsStore((s) => s.loadError)
  const tagsHydrated = useConversationTagsStore((s) => s.hydrated)

  const [folders, setFolders] = useState<FolderDetail[] | null>(null)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [pickedFolderId, setPickedFolderId] = useState<number | null>(null)

  // The folder list is this window's own copy (no workspace store here), so it
  // is re-read whenever it may have moved: on mount, on a `folder://changed`
  // broadcast, after a reconnect, and whenever the window regains focus —
  // opening or closing a folder in the workspace window broadcasts nothing, and
  // coming back here is when the list is looked at again. Newest read wins.
  const folderFetchRef = useRef(0)
  const refreshFolders = useCallback(() => {
    const id = ++folderFetchRef.current
    listAllFolderDetails()
      .then((list) => {
        if (id !== folderFetchRef.current) return
        setFolders(list)
        setFolderError(null)
      })
      .catch((err) => {
        if (id === folderFetchRef.current) setFolderError(toErrorMessage(err))
      })
  }, [])

  useEffect(() => {
    refreshFolders()
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<FolderChange>(FOLDER_CHANGED_EVENT, () =>
        refreshFolders()
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()
    const offReconnect = onTransportReconnect(refreshFolders)
    window.addEventListener("focus", refreshFolders)
    return () => {
      disposed = true
      // Invalidate whatever is still in flight.
      folderFetchRef.current += 1
      unlisten?.()
      offReconnect?.()
      window.removeEventListener("focus", refreshFolders)
    }
  }, [refreshFolders])

  // Only folders that can own tags: top-level, user-facing ones. A worktree's
  // conversations use its repo's tags, and chat folders have none of their own.
  const folderOptions = useMemo<FolderSelectOption[]>(() => {
    if (!folders) return []
    return excludeChatFolders(filterTopLevelFolders(folders))
      .map((f) => ({ id: f.id, name: f.name, alias: f.alias, path: f.path }))
      .sort((a, b) => (a.alias ?? a.name).localeCompare(b.alias ?? b.name))
  }, [folders])

  // Where to land when nothing is picked yet: the first folder that already
  // has tags — the likeliest reason to be here — or else the first folder.
  const defaultFolderId = useMemo(() => {
    const owners = new Set(
      tags.map((tag) => tag.folder_id).filter((id) => id != null)
    )
    return (
      folderOptions.find((f) => owners.has(f.id))?.id ??
      folderOptions[0]?.id ??
      null
    )
  }, [folderOptions, tags])

  // The landing spot is chosen ONCE, then held: re-deriving it from live tags
  // would switch folders under the user — and remount the editor, discarding
  // an open edit — the moment another window gave some other folder its first
  // tag. It only moves again if the folder it names leaves the list. Adjusted
  // during render rather than in an effect, so there is no frame showing none.
  const pickedIsListed =
    pickedFolderId != null && folderOptions.some((f) => f.id === pickedFolderId)
  if (
    !pickedIsListed &&
    folders != null &&
    tagsHydrated &&
    pickedFolderId !== defaultFolderId
  ) {
    setPickedFolderId(defaultFolderId)
  }
  const selectedFolderId = pickedIsListed ? pickedFolderId : null

  return (
    <ScrollArea className="h-full">
      <div className="w-full space-y-4 p-3 md:p-4">
        <section className="space-y-1">
          <h1 className="flex items-center gap-2 text-sm font-semibold">
            <Tags className="size-4 text-muted-foreground" aria-hidden />
            {t("title")}
          </h1>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </section>

        {tagsError ? (
          <SettingsError>
            {t("loadFailed")}: {tagsError}
          </SettingsError>
        ) : null}

        <SettingsSection
          icon={Globe}
          title={t("globalTitle")}
          description={t("globalDescription")}
        >
          <ConversationTagListEditor scopeFolderId={null} />
        </SettingsSection>

        <SettingsSection
          icon={FolderTree}
          title={t("folderTitle")}
          description={t("folderDescription")}
          control={
            folderOptions.length > 0 ? (
              <FolderSelect
                variant="field"
                folders={folderOptions}
                value={selectedFolderId}
                onChange={setPickedFolderId}
                placeholder={t("folderPlaceholder")}
              />
            ) : null
          }
        >
          {folderError ? <SettingsError>{folderError}</SettingsError> : null}
          {folders != null && folderOptions.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noFolders")}</p>
          ) : null}
          {selectedFolderId != null ? (
            <ConversationTagListEditor
              key={selectedFolderId}
              scopeFolderId={selectedFolderId}
            />
          ) : null}
        </SettingsSection>
      </div>
    </ScrollArea>
  )
}
