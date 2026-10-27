"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react"
import { useLocale, useTranslations } from "next-intl"
import { AlertTriangle, Download, Info, Loader2, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  ModelPickerDialog,
  type ModelPickerItem,
} from "@/components/settings/provider-models"
import {
  codexCatalogPlanPreview,
  codexEndpointCatalogCached,
  codexEndpointCatalogPublished,
  codexEndpointCatalogStatus,
  codexFetchEndpointCatalog,
  codexRefreshEndpointCatalog,
} from "@/lib/api"
import {
  codexCatalogErrorText,
  parseCodexCatalogError,
  type CodexCatalogTranslator,
} from "@/lib/codex-catalog-error"
import { subscribe } from "@/lib/platform"
import type {
  CodexCatalogError,
  CodexCatalogFormat,
  CodexCatalogRequest,
  CodexCatalogSource,
  CodexCatalogStatus,
  CodexEndpointCatalogView,
  CodexKeySource,
  CodexOpenAiIdView,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/** Mirrors `CODEX_CATALOG_REFRESHED_EVENT` in codex_catalog_refresh.rs. */
const CODEX_CATALOG_REFRESHED_EVENT = "app://codex-catalog-refreshed"

/** What the editor needs to take the model list from a provider. */
export interface CodexCatalogEndpoint {
  /** The provider's base URL as the form has it. */
  baseUrl: string
  /** How the fetch authenticates; `null` while no key is known. */
  keySource: CodexKeySource | null
  /** Show what is published and offer "Refresh now" (a saved panel, a bound
   *  provider). */
  showStatus?: boolean
  /** Show it only while it was published for this binding
   *  (`provider:<id>`): a provider's dialog, while Codex is bound to it. */
  statusBinding?: string
  /** The bound provider's name: the source is shown, not edited. */
  managedBy?: string | null
  /** "Refresh now" / "Apply" published something. */
  onPublished?: () => void
}

/** `base_url + "/models"`, joined on the path the way the backend derives
 *  it (query kept, fragment dropped). `null` for anything but http(s). */
export function deriveCatalogUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim())
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.hash = ""
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`
    return url.toString()
  } catch {
    return null
  }
}

function hostOf(raw: string): string | null {
  try {
    return new URL(raw.trim()).host || null
  } catch {
    return null
  }
}

type ListOrigin = "fetched" | "published" | "cached"

/** The provider's list for the editor's rows: this session's fetch first,
 *  then the published list, then the cache — each only when it answers the
 *  form's own request (URL, key, list URL) and, once one was applied, the
 *  recorded shape. A fetch in the other shape is set aside for re-picking,
 *  never used as rows. */
export function useCodexProviderList(
  endpoint: CodexCatalogEndpoint | null | undefined,
  source: CodexCatalogSource | undefined
) {
  const request = useMemo<CodexCatalogRequest | null>(() => {
    if (!endpoint || !source || !endpoint.keySource) return null
    if (!deriveCatalogUrl(endpoint.baseUrl)) return null
    return {
      baseUrl: endpoint.baseUrl.trim(),
      catalogUrl: source.url?.trim() || null,
      keySource: endpoint.keySource,
    }
  }, [endpoint, source])
  const key = request ? JSON.stringify(request) : ""
  const format = source?.format ?? null

  const [fetched, setFetched] = useState<{
    key: string
    view: CodexEndpointCatalogView
  } | null>(null)
  const [fallback, setFallback] = useState<{
    key: string
    format: CodexCatalogFormat | null
    view: CodexEndpointCatalogView
    origin: ListOrigin
  } | null>(null)
  const [failure, setFailure] = useState<{
    key: string
    error: CodexCatalogError
  } | null>(null)
  const [fetching, setFetching] = useState(false)
  const [reloads, setReloads] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    // A request that changed drops the answer to the old one, late or not.
    seq.current += 1
    setFetching(false)
  }, [key])
  useEffect(
    () => () => {
      // Unmounted (the source or the auth mode changed under it): an answer
      // still on its way must not write into the form any more.
      seq.current += 1
    },
    []
  )

  useEffect(() => {
    if (!request) return
    let alive = true
    const params = { ...request, format }
    void (async () => {
      try {
        const published = await codexEndpointCatalogPublished(params)
        if (!alive) return
        if (published.catalog) {
          setFallback({
            key,
            format,
            view: published.catalog,
            origin: "published",
          })
          return
        }
        const cached = await codexEndpointCatalogCached(params)
        if (!alive) return
        setFallback(
          cached.catalog
            ? { key, format, view: cached.catalog, origin: "cached" }
            : null
        )
      } catch {
        if (alive) setFallback(null)
      }
    })()
    return () => {
      alive = false
    }
    // `key` stands for `request`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, format, reloads])

  const fetchNow =
    useCallback(async (): Promise<CodexEndpointCatalogView | null> => {
      if (!request) return null
      const mine = ++seq.current
      setFetching(true)
      setFailure(null)
      try {
        const view = await codexFetchEndpointCatalog(request)
        if (mine !== seq.current) return null
        setFetched({ key, view })
        return view
      } catch (e) {
        if (mine !== seq.current) return null
        const parsed = parseCodexCatalogError(e)
        setFailure({
          key,
          error: parsed.catalog ?? { code: "unknown", message: parsed.message },
        })
        return null
      } finally {
        if (mine === seq.current) setFetching(false)
      }
    }, [request, key])

  const current = fetched?.key === key && key ? fetched.view : null
  const formatChanged =
    current && format && current.format !== format ? current : null
  const known =
    fallback && fallback.key === key && fallback.format === format
      ? fallback
      : null
  const rows =
    (current && !formatChanged ? current : null) ?? known?.view ?? null
  const origin: ListOrigin | null =
    current && !formatChanged ? "fetched" : (known?.origin ?? null)
  return {
    request,
    rows,
    origin,
    formatChanged,
    fetching,
    error: failure?.key === key ? failure.error : null,
    fetchNow,
    reload: useCallback(() => setReloads((n) => n + 1), []),
  }
}

export type CodexProviderList = ReturnType<typeof useCodexProviderList>

function formatTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatBytes(n: number | undefined): string {
  if (!n) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** "Codex built-in list / From the provider", the list URL, "Fetch models". */
export function CodexCatalogSourceSection({
  endpoint,
  source,
  list,
  readOnly,
  onSourceChange,
  onFetch,
  onRepick,
}: {
  endpoint: CodexCatalogEndpoint
  source: CodexCatalogSource | undefined
  list: CodexProviderList
  readOnly: boolean
  onSourceChange: (next: CodexCatalogSource | undefined) => void
  onFetch: () => void
  onRepick: () => void
}) {
  const t = useTranslations("CodexModelEditor.catalogSource")
  const tt = t as unknown as CodexCatalogTranslator
  const derived = deriveCatalogUrl(endpoint.baseUrl)
  const listUrl = source?.url?.trim() || derived || ""
  const baseHost = hostOf(endpoint.baseUrl)
  const listHost = source?.url?.trim() ? hostOf(source.url) : null
  const managed = !!endpoint.managedBy

  return (
    <section className="space-y-2 rounded-md border bg-muted/10 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold">{t("title")}</p>
        {managed && (
          <span className="truncate text-2xs text-muted-foreground">
            {t("managedBy", { name: endpoint.managedBy ?? "" })}
          </span>
        )}
      </div>
      <RadioGroup
        value={source ? "provider" : "builtin"}
        onValueChange={(next) =>
          onSourceChange(next === "provider" ? (source ?? {}) : undefined)
        }
        disabled={readOnly || managed}
        className="gap-1.5"
      >
        <label className="flex items-center gap-2 text-xs">
          <RadioGroupItem value="builtin" />
          {t("builtin")}
        </label>
        <label className="flex items-center gap-2 text-xs">
          <RadioGroupItem value="provider" />
          {t("provider")}
        </label>
      </RadioGroup>

      {source && (
        <div className="space-y-2">
          {!managed && !readOnly && (
            <div className="space-y-1">
              <label className="text-2xs text-muted-foreground">
                {t("listUrl")}
              </label>
              <Input
                value={source.url ?? ""}
                placeholder={derived ?? t("listUrlPlaceholder")}
                onChange={(e) =>
                  onSourceChange({
                    ...source,
                    url: e.target.value || undefined,
                  })
                }
                className="h-8 font-mono text-2xs"
              />
              {listHost && baseHost && listHost !== baseHost && (
                <p className="flex items-start gap-1 text-2xs text-amber-500">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  {t("keySentTo", { host: listHost })}
                </p>
              )}
            </div>
          )}
          {managed && listUrl && (
            <p className="truncate font-mono text-2xs text-muted-foreground">
              {listUrl}
            </p>
          )}
          {!managed && !readOnly && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={!list.request || list.fetching}
                onClick={onFetch}
              >
                {list.fetching ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1 h-3.5 w-3.5" />
                )}
                {t("fetch")}
              </Button>
              {!endpoint.keySource && (
                <span className="text-2xs text-muted-foreground">
                  {t("needKey")}
                </span>
              )}
              {endpoint.keySource && !derived && (
                <span className="text-2xs text-muted-foreground">
                  {t("needBaseUrl")}
                </span>
              )}
            </div>
          )}
          {list.error && (
            <p className="text-2xs text-destructive">
              {codexCatalogErrorText(list.error, tt)}
            </p>
          )}
          {list.rows && (
            <p className="text-2xs text-muted-foreground">
              {t("listSummary", {
                format: t(
                  list.rows.format === "native"
                    ? "formatNative"
                    : "formatOpenai"
                ),
                usable: list.rows.counts.usable,
                total: list.rows.counts.total,
              })}
              {list.origin !== "fetched" &&
                ` · ${t(list.origin === "published" ? "fromPublished" : "fromCache")}`}
            </p>
          )}
          {list.rows?.warnings.includes("no_usable_models") && (
            <p className="text-2xs text-amber-500">
              {t("codexCatalog.no_usable_models")}
            </p>
          )}
          {list.formatChanged && !readOnly && !managed && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-2xs text-amber-500">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">
                {t("formatChanged", {
                  format: t(
                    list.formatChanged.format === "native"
                      ? "formatNative"
                      : "formatOpenai"
                  ),
                })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-2xs"
                onClick={onRepick}
              >
                {t("repick")}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** What is published under codeg's CODEX_HOME, how its refreshes go, and
 *  "Refresh now". Reloads on its own when a background refresh publishes. */
export function CodexCatalogStatusLine({
  onPublished,
  binding,
}: {
  onPublished?: () => void
  /** Show the status only while what is published was published for this
   *  binding (`provider:<id>`): a provider's dialog says nothing about
   *  another provider's list. */
  binding?: string
}) {
  const t = useTranslations("CodexModelEditor.catalogSource")
  const tt = t as unknown as CodexCatalogTranslator
  const locale = useLocale()
  const [status, setStatus] = useState<CodexCatalogStatus | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<CodexCatalogError | null>(
    null
  )

  // The latest callback, without re-subscribing whenever the parent renders.
  const onPublishedRef = useRef(onPublished)
  useEffect(() => {
    onPublishedRef.current = onPublished
  }, [onPublished])

  // Only the latest read lands: an earlier one answering late must not
  // overwrite a newer status (after "Refresh now", say).
  const loads = useRef(0)
  const load = useCallback(() => {
    const mine = ++loads.current
    void codexEndpointCatalogStatus()
      .then((next) => {
        if (mine === loads.current) setStatus(next)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<unknown>(CODEX_CATALOG_REFRESHED_EVENT, () => {
      load()
      onPublishedRef.current?.()
    })
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [load])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const next = await codexRefreshEndpointCatalog()
      loads.current += 1
      setStatus(next)
      setRefreshError(next.fetchError)
      onPublishedRef.current?.()
    } catch (e) {
      const parsed = parseCodexCatalogError(e)
      setRefreshError(
        parsed.catalog ?? { code: "unknown", message: parsed.message }
      )
    } finally {
      setRefreshing(false)
    }
  }, [])

  const meta = status?.meta ?? null
  if (!status || (!meta && !status.source)) return null
  if (binding && meta?.binding !== binding) return null
  const lastError = refreshError ?? status.refresh.lastError
  const conflict = meta?.conflict ?? []
  const lines: { tone: "muted" | "warn" | "error"; text: string }[] = []
  if (meta?.format && meta.counts.total > 0) {
    const parts = [
      t(meta.format === "native" ? "formatNative" : "formatOpenai"),
      t("countsShort", {
        usable: meta.counts.usable,
        total: meta.counts.total,
      }),
    ]
    if (meta.bytes) parts.push(formatBytes(meta.bytes))
    if (meta.checkedAt)
      parts.push(t("checkedAt", { time: formatTime(meta.checkedAt, locale) }))
    if (status.refresh.nextRefreshAt)
      parts.push(
        t("nextRefresh", {
          time: formatTime(status.refresh.nextRefreshAt, locale),
        })
      )
    lines.push({ tone: "muted", text: parts.join(" · ") })
  }
  const added = meta?.diff.added.length ?? 0
  const removed = meta?.diff.removed.length ?? 0
  if (meta?.format === "native" && (added || removed))
    lines.push({ tone: "muted", text: t("diff", { added, removed }) })
  if (status.newIds.length)
    lines.push({
      tone: "muted",
      text: t("newIds", { count: status.newIds.length }),
    })
  if (status.missingSelected.length)
    lines.push({
      tone: "warn",
      text: t("missingSelected", { count: status.missingSelected.length }),
    })
  if (meta?.stale) lines.push({ tone: "warn", text: t("stale") })
  if (meta?.degraded)
    lines.push({
      tone: "warn",
      text: t("degraded", {
        reason: tt.has(`degradedReason.${meta.degraded}`)
          ? tt(`degradedReason.${meta.degraded}`)
          : meta.degraded,
      }),
    })
  if (meta?.pendingFormat)
    lines.push({
      tone: "warn",
      text: t("formatChanged", {
        format: t(
          meta.pendingFormat === "native" ? "formatNative" : "formatOpenai"
        ),
      }),
    })
  if (conflict.length)
    lines.push({
      tone: "warn",
      text: t("conflict", {
        versions: [
          ...(meta?.validatedBy.map((v) => v.version) ?? []),
          ...conflict.map((v) => v.version),
        ].join(", "),
      }),
    })
  if (lastError) {
    const when = refreshError ? null : status.refresh.lastErrorAt
    const reason = codexCatalogErrorText(lastError, tt)
    lines.push({
      tone: "error",
      text: when
        ? t("refreshFailedAt", { reason, time: formatTime(when, locale) })
        : t("refreshFailed", { reason }),
    })
    if (meta?.checkedAt)
      lines.push({
        tone: "muted",
        text: t("stillUsing", { time: formatTime(meta.checkedAt, locale) }),
      })
  }
  if (status.catalogUrlHint)
    lines.push({ tone: "muted", text: t("catalogUrlHint") })

  return (
    <div className="space-y-1 rounded-md border px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs font-medium text-muted-foreground">
          {t("publishedTitle")}
        </p>
        <div className="flex items-center gap-1.5">
          {status.pendingLocalChanges && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 text-2xs"
              disabled={refreshing}
              onClick={refresh}
            >
              {t("apply")}
            </Button>
          )}
          {status.source && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 text-2xs"
              disabled={refreshing || status.refresh.inProgress}
              onClick={refresh}
            >
              <RefreshCw
                className={cn(
                  "h-3 w-3",
                  (refreshing || status.refresh.inProgress) && "animate-spin"
                )}
              />
              {t("refreshNow")}
            </Button>
          )}
        </div>
      </div>
      {status.pendingLocalChanges && (
        <p className="flex items-start gap-1 text-2xs text-amber-500">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          {t("pendingLocalChanges")}
        </p>
      )}
      {lines.map((line, i) => (
        <p
          key={i}
          className={cn(
            "text-2xs",
            line.tone === "muted" && "text-muted-foreground",
            line.tone === "warn" && "text-amber-500",
            line.tone === "error" && "text-destructive"
          )}
        >
          {line.text}
        </p>
      ))}
    </div>
  )
}

/** What saving the draft would set codeg's managed keys to — root `model`
 *  and `model_catalog_json` — asked of the backend a moment after the draft
 *  stops changing. The raw editor still shows the draft as typed: codeg
 *  writes these two itself, and refuses a hand edit of them. */
export function CodexSavePreview({
  configToml,
  authJson,
  modelList,
}: {
  configToml: string
  authJson: string
  modelList: string
}) {
  const t = useTranslations("CodexModelEditor.catalogSource")
  const tt = t as unknown as CodexCatalogTranslator
  const [preview, setPreview] = useState<{
    managesCatalog: boolean
    defaultModel: string | null
  } | null>(null)
  const [error, setError] = useState<CodexCatalogError | null>(null)

  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      void codexCatalogPlanPreview({ configToml, authJson, modelList })
        .then((next) => {
          if (!alive) return
          setPreview(next)
          setError(null)
        })
        .catch((e) => {
          if (!alive) return
          const parsed = parseCodexCatalogError(e)
          setPreview(null)
          setError(parsed.catalog)
        })
    }, PREVIEW_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [configToml, authJson, modelList])

  if (error) {
    return (
      <p className="text-2xs text-destructive">
        {t("savePreviewError", { message: codexCatalogErrorText(error, tt) })}
      </p>
    )
  }
  if (!preview?.managesCatalog) return null
  return (
    <p className="text-2xs text-muted-foreground">
      {preview.defaultModel
        ? t("savePreviewManaged", { model: preview.defaultModel })
        : t("savePreviewManagedNoModel")}
    </p>
  )
}

const PREVIEW_DELAY_MS = 400

/** One row of the picker. */
export type CodexPickerItem = ModelPickerItem

/** Pick ids from a provider's list (an OpenAI list's allowlist, or the
 *  visible part of a native catalog when its shape changed). Ids that were
 *  chosen and are about to go are listed apart, each with "add as a custom
 *  model" instead. */
export function CodexCatalogPickerDialog(
  props: Omit<ComponentProps<typeof ModelPickerDialog>, "keepLabel">
) {
  const t = useTranslations("CodexModelEditor.catalogSource")
  return <ModelPickerDialog {...props} keepLabel={t("keepAsCustom")} />
}

/** The line under an OpenAI-list id: which metadata it is built from. */
export function templateHint(
  view: CodexOpenAiIdView | undefined,
  t: CodexCatalogTranslator
): string | undefined {
  const template = view?.template
  if (!template) return undefined
  if (template.kind === "official") return t("templateOfficial")
  if (template.kind === "prefix")
    return t("templatePrefix", { slug: template.slug })
  return t("templateCompat")
}
