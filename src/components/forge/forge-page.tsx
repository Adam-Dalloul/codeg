"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { GitPullRequestArrow, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import { ForgeIssueRowItem } from "@/components/forge/forge-issue-row"
import { ForgeStartDialog } from "@/components/forge/forge-start-dialog"
import {
  folderForgeRemote,
  forgeListIssues,
  workTaskLookupBySource,
} from "@/lib/api"
import { buildForgeSourceKey } from "@/lib/forge-source-key"
import { fetchNonSparsePage } from "@/lib/forge-pagination"
import { subscribe } from "@/lib/platform"
import type {
  ForgeIssueRow,
  ForgeRemote,
  ForgeTab,
  ForgeTaskLink,
} from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

const WORK_TASK_CHANGED_EVENT = "task://changed"
const FOLDER_STORAGE_KEY = "forge:folderId"

export function ForgePageTitle() {
  const t = useTranslations("Forge")
  return <WorkbenchPageTitle title={t("title")} />
}

function loadStoredFolderId(): number | null {
  if (typeof window === "undefined") return null
  const raw = window.localStorage.getItem(FOLDER_STORAGE_KEY)
  const parsed = raw == null ? NaN : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * The forge workbench: pick a project folder, see its repository's issues and
 * PRs, and turn an issue into a work task with one click. The row chips are a
 * reverse lookup by source key, refreshed on the same `task://changed` nudges
 * the board listens to — the page itself holds no task state.
 */
export function ForgePage() {
  const t = useTranslations("Forge")
  const folders = useAppWorkspaceStore((s) => s.folders)
  const projectFolders = useMemo(
    () => folders.filter((f) => f.parent_id == null && f.kind === "regular"),
    [folders]
  )

  const [folderId, setFolderId] = useState<number | null>(loadStoredFolderId)
  // Fall back to the first project folder once folders arrive.
  const effectiveFolderId = useMemo(() => {
    if (folderId != null && projectFolders.some((f) => f.id === folderId)) {
      return folderId
    }
    return projectFolders[0]?.id ?? null
  }, [folderId, projectFolders])

  const [remote, setRemote] = useState<ForgeRemote | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [tab, setTab] = useState<ForgeTab>("issues")
  const [stateFilter, setStateFilter] = useState<"open" | "closed">("open")
  const [assignedMe, setAssignedMe] = useState(false)
  const [rows, setRows] = useState<ForgeIssueRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [links, setLinks] = useState<Map<string, ForgeTaskLink>>(new Map())
  const [startRow, setStartRow] = useState<ForgeIssueRow | null>(null)
  const reqRef = useRef(0)

  // Folder → remote resolution.
  useEffect(() => {
    if (effectiveFolderId == null) {
      setRemote(null)
      return
    }
    let cancelled = false
    setRemoteLoading(true)
    setRemote(null)
    folderForgeRemote(effectiveFolderId)
      .then((r) => {
        if (!cancelled) setRemote(r)
      })
      .catch(() => {
        if (!cancelled) setRemote(null)
      })
      .finally(() => {
        if (!cancelled) setRemoteLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [effectiveFolderId])

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      if (effectiveFolderId == null || remote == null) return
      const id = ++reqRef.current
      const isMore = cursor != null
      if (isMore) setLoadingMore(true)
      else {
        setLoading(true)
        setError(null)
      }
      try {
        // Sparse-page aware: a mixed /issues page can filter to zero visible
        // rows for this tab while more matches sit behind the cursor.
        const page = await fetchNonSparsePage(
          (c) =>
            forgeListIssues({
              folderId: effectiveFolderId,
              tab,
              state: stateFilter,
              assignedMe,
              cursor: c,
            }),
          cursor
        )
        if (id !== reqRef.current) return
        setRows((prev) => (isMore ? [...prev, ...page.rows] : page.rows))
        setNextCursor(page.nextCursor)
      } catch (e) {
        if (id !== reqRef.current) return
        if (!isMore) setRows([])
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (id === reqRef.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [effectiveFolderId, remote, tab, stateFilter, assignedMe]
  )

  // (Re)load on any filter/remote change.
  useEffect(() => {
    setRows([])
    setNextCursor(null)
    if (remote != null) void fetchPage(null)
  }, [remote, fetchPage])

  // Reverse lookup for visible rows; re-run on board nudges so a chip follows
  // its task through the pipeline without polling.
  const keyFor = useCallback(
    (row: ForgeIssueRow) =>
      remote == null
        ? null
        : buildForgeSourceKey({
            // The backend decided which forge this host is; using anything
            // else here builds keys that match no task's provenance.
            provider: remote.provider,
            serverHost: remote.server_host,
            ownerRepo: remote.owner_repo,
            kind: row.is_pr ? "pr" : "issue",
            number: row.number,
          }),
    [remote]
  )
  const refreshLinks = useCallback(async () => {
    const keys = rows
      .map((r) => keyFor(r))
      .filter((k): k is string => k != null)
    if (keys.length === 0) {
      setLinks(new Map())
      return
    }
    try {
      const found = await workTaskLookupBySource(keys)
      setLinks(new Map(found.map((l) => [l.source_key, l])))
    } catch {
      // Chips are best-effort decoration; the list itself stays useful.
    }
  }, [rows, keyFor])
  useEffect(() => {
    void refreshLinks()
  }, [refreshLinks])
  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | undefined
    void subscribe(WORK_TASK_CHANGED_EVENT, () => {
      void refreshLinks()
    }).then((u: () => void) => {
      if (cancelled) u()
      else unsub = u
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [refreshLinks])

  const pickFolder = useCallback((value: string) => {
    const id = Number.parseInt(value, 10)
    if (!Number.isFinite(id)) return
    setFolderId(id)
    window.localStorage.setItem(FOLDER_STORAGE_KEY, String(id))
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Select
          value={effectiveFolderId != null ? String(effectiveFolderId) : ""}
          onValueChange={pickFolder}
        >
          <SelectTrigger size="sm" className="w-44">
            <SelectValue placeholder={t("pickFolder")} />
          </SelectTrigger>
          <SelectContent>
            {projectFolders.map((f) => (
              <SelectItem key={f.id} value={String(f.id)}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {remote ? (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {remote.server_host}/{remote.owner_repo}
          </span>
        ) : null}
        <Tabs value={tab} onValueChange={(v) => setTab(v as ForgeTab)}>
          <TabsList className="h-8">
            <TabsTrigger value="issues">{t("tabIssues")}</TabsTrigger>
            <TabsTrigger value="prs">
              {t(remote?.provider === "gitlab" ? "tabMrs" : "tabPrs")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          size="sm"
          variant={stateFilter === "open" ? "secondary" : "ghost"}
          className="h-7 rounded-full px-3 text-xs"
          onClick={() =>
            setStateFilter((s) => (s === "open" ? "closed" : "open"))
          }
        >
          {stateFilter === "open" ? t("stateOpen") : t("stateClosed")}
        </Button>
        <Button
          size="sm"
          variant={assignedMe ? "secondary" : "ghost"}
          className="h-7 rounded-full px-3 text-xs"
          onClick={() => setAssignedMe((v) => !v)}
        >
          {t("assignedMe")}
        </Button>
        <div className="ml-auto">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => void fetchPage(null)}
            disabled={loading || remote == null}
            title={t("refresh")}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {effectiveFolderId == null ? (
          <EmptyHint text={t("pickFolder")} />
        ) : remoteLoading ? (
          <ListSkeleton />
        ) : remote == null ? (
          <EmptyHint text={t("noRemote")} />
        ) : error != null ? (
          <EmptyHint text={error} />
        ) : loading && rows.length === 0 ? (
          <ListSkeleton />
        ) : rows.length === 0 ? (
          nextCursor == null ? (
            <EmptyHint text={t("empty")} />
          ) : (
            // Sparse pages exhausted the hop cap: nothing visible YET, but
            // more pages exist — the empty state must keep pagination alive.
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
              <span>{t("empty")}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={loadingMore}
                onClick={() => void fetchPage(nextCursor)}
              >
                {loadingMore ? t("loading") : t("loadMore")}
              </Button>
            </div>
          )
        ) : (
          <div className="flex flex-col divide-y divide-border/40">
            {rows.map((row) => (
              <ForgeIssueRowItem
                key={`${row.is_pr ? "pr" : "issue"}-${row.number}`}
                row={row}
                link={(() => {
                  const key = keyFor(row)
                  return key != null ? (links.get(key) ?? null) : null
                })()}
                onStart={() => setStartRow(row)}
              />
            ))}
            {nextCursor != null ? (
              <div className="flex justify-center py-3">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={loadingMore}
                  onClick={() => void fetchPage(nextCursor)}
                >
                  {loadingMore ? t("loading") : t("loadMore")}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {startRow != null && remote != null && effectiveFolderId != null ? (
        <ForgeStartDialog
          row={startRow}
          remote={remote}
          folderId={effectiveFolderId}
          onClose={() => setStartRow(null)}
          onCreated={() => {
            setStartRow(null)
            void refreshLinks()
          }}
        />
      ) : null}
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
      <GitPullRequestArrow className="h-6 w-6 opacity-40" />
      <span>{text}</span>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-4">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  )
}
