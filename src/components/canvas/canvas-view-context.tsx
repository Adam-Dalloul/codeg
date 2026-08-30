"use client"

import { createContext, useContext } from "react"
import type { CanvasNodePatchInput } from "@/lib/api"
import type { DbConversationSummary } from "@/lib/types"

/**
 * Actions and interaction state the custom ReactFlow node components need from
 * the canvas view. A context (rather than routing through RF `data`) so
 * selection-mirror highlights and expand toggles don't have to rebuild the
 * whole node array to reach one card.
 */
export interface CanvasViewContextValue {
  /** Regions whose "+N" expander is open. */
  expandedRegions: ReadonlySet<number>
  expandRegion: (regionDbId: number) => void
  /**
   * Conversation ids currently selected on the canvas — every card showing one
   * of these lights a mirror ring, which is what makes "the same conversation
   * in several regions" legible at a glance.
   */
  selectedConversationIds: ReadonlySet<number>
  /** Patch a DB node (rename, color, collapse, note text, members). */
  patchNode: (nodeId: number, patch: CanvasNodePatchInput) => Promise<void>
  /**
   * Commit a NodeResizer gesture: persist the final geometry, then clear the
   * transient position/size overlays the resize fed (resizes never get a
   * dragStop, so without this the overlays would pin the node forever).
   */
  endNodeResize: (
    nodeId: number,
    geometry: { x: number; y: number; width: number; height: number }
  ) => void
  deleteNode: (nodeId: number) => Promise<void>
  /** Leave the canvas and open the conversation in the workspace. */
  openConversation: (conversation: DbConversationSummary, pin: boolean) => void
}

const CanvasViewContext = createContext<CanvasViewContextValue | null>(null)

export const CanvasViewProvider = CanvasViewContext.Provider

export function useCanvasView(): CanvasViewContextValue {
  const ctx = useContext(CanvasViewContext)
  if (!ctx) {
    throw new Error("useCanvasView must be used within the canvas view")
  }
  return ctx
}
