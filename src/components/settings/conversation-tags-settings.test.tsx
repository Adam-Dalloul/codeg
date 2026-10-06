import type { ReactNode } from "react"
import { act, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ConversationTagDetail, FolderDetail } from "@/lib/types"

const h = vi.hoisted(() => ({
  folders: [] as Partial<FolderDetail>[],
  tags: [] as ConversationTagDetail[],
}))

vi.mock("@/lib/api", () => ({
  listAllFolderDetails: vi.fn(async () => h.folders),
  listConversationTags: vi.fn(async () => h.tags),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async () => () => {}),
  onTransportReconnect: vi.fn(() => null),
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

import { ConversationTagsSettings } from "./conversation-tags-settings"
import {
  resetConversationTagsStore,
  useConversationTagsStore,
} from "@/stores/conversation-tags-store"

const tag = (
  id: number,
  name: string,
  folder_id: number | null
): ConversationTagDetail => ({
  id,
  folder_id,
  name,
  color: "#0969da",
  sort_order: id,
})

const folder = (id: number, name: string): Partial<FolderDetail> => ({
  id,
  name,
  path: `/p/${name}`,
  alias: null,
  parent_id: null,
  kind: "regular",
})

beforeEach(() => {
  resetConversationTagsStore()
  // "alpha" sorts first, but only "beta" has tags yet.
  h.folders = [folder(1, "alpha"), folder(2, "beta")]
  h.tags = [tag(1, "bug", null), tag(2, "beta-only", 2)]
})

describe("ConversationTagsSettings", () => {
  it("lands on the first folder with tags and stays there when another gets one", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ConversationTagsSettings />
      </NextIntlClientProvider>
    )
    expect(await screen.findByText("beta-only")).toBeTruthy()
    expect(screen.getByText("bug")).toBeTruthy()

    // Another window gives "alpha" — earlier in the list — its first tag.
    act(() => {
      useConversationTagsStore
        .getState()
        .applyChange({ kind: "upsert", tag: tag(3, "alpha-first", 1) })
    })
    // Still on beta: the editor was not switched (or remounted) underneath.
    expect(screen.getByText("beta-only")).toBeTruthy()
    expect(screen.queryByText("alpha-first")).toBeNull()
  })
})
