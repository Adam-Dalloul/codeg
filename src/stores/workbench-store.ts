"use client"

import { create } from "zustand"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import { getActiveRemoteConnectionId } from "@/lib/transport"

export type WorkbenchScope = number | "global"

export function folderScope(folderId?: number | null): WorkbenchScope {
  if (!folderId) return "global"
  return useAppWorkspaceStore
    .getState()
    .allFolders.find((f) => f.id === folderId)?.kind === "chat"
    ? "global"
    : folderId
}

/** Empty scopes are intentional in Workbench mode. */
export function shouldSeedConversation(enabled: boolean, hasNoTabs: boolean) {
  return !enabled && hasNoTabs
}

interface WorkbenchState {
  enabled: boolean
  scope: WorkbenchScope
  // References own view membership; the workspace provider still owns ONE
  // buffer per normalized absolute path, including when several scopes use it.
  fileRefs: Record<string, string[]>
  fileSelection: Record<string, string | null>
  hydratePreference: () => void
  setEnabled: (enabled: boolean) => void
  activateScope: (scope: WorkbenchScope) => void
  addFile: (id: string, scope: WorkbenchScope, select?: boolean) => void
  selectFile: (id: string | null) => void
  removeFile: (id: string, scope: WorkbenchScope) => boolean
  forgetFile: (id: string) => void
  reorderFiles: (ids: string[]) => void
}

function preferenceKey() {
  const remoteId = getActiveRemoteConnectionId()
  return `workspace:workbench:${remoteId ? `remote-${remoteId}` : "local"}`
}

export function openingScope(folderId?: number | null): WorkbenchScope {
  if (folderId != null) return folderScope(folderId)
  const state = useWorkbenchStore.getState()
  return state.enabled
    ? state.scope
    : folderScope(useAppWorkspaceStore.getState().activeFolderId)
}

/** Browser popups inherit their opener's references even after a scope switch. */
export function fileOpeningScope(
  tabId: string,
  fallback = openingScope()
): WorkbenchScope {
  const state = useWorkbenchStore.getState()
  const scopes = Object.entries(state.fileRefs)
    .filter(([, ids]) => ids.includes(tabId))
    .map(([scope]) =>
      scope === "global" ? ("global" as const) : Number(scope)
    )
  return scopes.includes(state.scope) ? state.scope : (scopes[0] ?? fallback)
}

const initialState = () => ({
  enabled: false,
  scope: "global" as WorkbenchScope,
  fileRefs: {} as Record<string, string[]>,
  fileSelection: {} as Record<string, string | null>,
})

export const useWorkbenchStore = create<WorkbenchState>()((set, get) => ({
  ...initialState(),
  hydratePreference: () => {
    try {
      if (localStorage.getItem(preferenceKey()) === "true") {
        get().setEnabled(true)
      }
    } catch {
      // Storage is optional (private windows, SSR, quota failures).
    }
  },
  setEnabled: (enabled) => {
    if (enabled === get().enabled) return
    const scope = enabled
      ? folderScope(useAppWorkspaceStore.getState().activeFolderId)
      : get().scope
    set({ enabled, scope })
    if (enabled) {
      useAppWorkspaceStore
        .getState()
        .setActiveFolderId(scope === "global" ? null : scope)
    }
    try {
      localStorage.setItem(preferenceKey(), String(enabled))
    } catch {
      // The in-memory preference still works when storage is unavailable.
    }
  },
  activateScope: (scope) => {
    if (!get().enabled) return
    set({ scope })
    useAppWorkspaceStore
      .getState()
      .setActiveFolderId(scope === "global" ? null : scope)
  },
  addFile: (id, scope, select = true) => {
    const state = get()
    const refs = state.fileRefs[scope] ?? []
    const selected = select ? id : (state.fileSelection[scope] ?? id)
    if (refs.includes(id) && selected === state.fileSelection[scope]) return
    set({
      fileRefs: {
        ...state.fileRefs,
        [scope]: refs.includes(id) ? refs : [...refs, id],
      },
      fileSelection: { ...state.fileSelection, [scope]: selected },
    })
  },
  selectFile: (id) => {
    const state = get()
    if (id != null && !state.fileRefs[state.scope]?.includes(id)) return
    if (state.fileSelection[state.scope] === id) return
    set({ fileSelection: { ...state.fileSelection, [state.scope]: id } })
  },
  removeFile: (id, scope) => {
    const state = get()
    const refs = state.fileRefs[scope] ?? []
    const next = refs.filter((ref) => ref !== id)
    set({
      fileRefs: { ...state.fileRefs, [scope]: next },
      fileSelection: {
        ...state.fileSelection,
        [scope]:
          state.fileSelection[scope] === id
            ? (next[Math.min(refs.indexOf(id), next.length - 1)] ?? null)
            : state.fileSelection[scope],
      },
    })
    return Object.values(get().fileRefs).some((ids) => ids.includes(id))
  },
  forgetFile: (id) => {
    for (const scope of Object.keys(get().fileRefs)) {
      get().removeFile(id, scope === "global" ? scope : Number(scope))
    }
  },
  reorderFiles: (ids) => {
    const state = get()
    const refs = state.fileRefs[state.scope] ?? []
    const order = ids.filter((id) => refs.includes(id))
    set({
      fileRefs: {
        ...state.fileRefs,
        [state.scope]: [...order, ...refs.filter((id) => !order.includes(id))],
      },
    })
  },
}))

export function resetWorkbenchStore() {
  useWorkbenchStore.setState(initialState())
}
registerBackendScopedStoreReset(resetWorkbenchStore)
