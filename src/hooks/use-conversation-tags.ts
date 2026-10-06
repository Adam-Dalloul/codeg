import { useShallow } from "zustand/react/shallow"
import { resolveTags } from "@/lib/conversation-tags"
import type { ConversationTagDetail } from "@/lib/types"
import { useConversationTagsStore } from "@/stores/conversation-tags-store"

/**
 * A conversation's `tag_ids` resolved to the tags this window knows, in
 * display order — unknown ids (a tag deleted elsewhere) dropped.
 *
 * Cheap enough for every sidebar row. It reads the tag store only, so a
 * conversation status event never reaches it, and the shallow compare means a
 * change to tag DEFINITIONS re-renders just the rows actually showing the tag
 * that changed: every other row resolves to the very same tag objects (or the
 * shared empty list) and bails out.
 */
export function useResolvedTags(
  tagIds: readonly number[] | undefined
): readonly ConversationTagDetail[] {
  return useConversationTagsStore(
    useShallow((s) => resolveTags(tagIds, s.tagsById))
  )
}
