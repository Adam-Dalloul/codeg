"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  Info,
  ListChecks,
  Plus,
  RefreshCw,
  Star,
  Trash2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  CodexCatalogPickerDialog,
  CodexCatalogSourceSection,
  CodexCatalogStatusLine,
  templateHint,
  useCodexProviderList,
  type CodexCatalogEndpoint,
  type CodexPickerItem,
} from "@/components/settings/codex-catalog-source"
import { codexBundledCatalog } from "@/lib/api"
import type { CodexCatalogTranslator } from "@/lib/codex-catalog-error"
import {
  applyCodexCompatOverrides,
  hasCodexCustomization,
  isCodexCompatEntry,
  pruneCodexGhostExclusions,
  type CodexCatalogSource,
  type CodexCustomEntry,
  type CodexEndpointCatalogView,
  type CodexModelConfig,
  type CodexModelInfo,
  type CodexOpenAiIdView,
} from "@/lib/types"
import { cn } from "@/lib/utils"

// The runtime catalog is stable per session; fetch it once and share across
// every mounted editor. A refresh re-runs codex and replaces the cache.
let catalogCache: CodexModelInfo[] | null = null
let catalogPromise: Promise<CodexModelInfo[]> | null = null
const catalogListeners = new Set<(models: CodexModelInfo[]) => void>()

function loadCatalog(force = false): Promise<CodexModelInfo[]> {
  if (force) {
    catalogPromise = codexBundledCatalog(true)
      .then((models) => {
        catalogCache = models
        catalogListeners.forEach((fn) => fn(models))
        return models
      })
      .catch(() => catalogCache ?? [])
    return catalogPromise
  }
  if (!catalogPromise) {
    catalogPromise = codexBundledCatalog()
      .then((models) => {
        catalogCache = models
        catalogListeners.forEach((fn) => fn(models))
        return models
      })
      .catch(() => {
        catalogPromise = null
        return []
      })
  }
  return catalogPromise
}

function useCodexCatalog(): {
  catalog: CodexModelInfo[]
  refreshing: boolean
  refresh: () => void
} {
  const [catalog, setCatalog] = useState<CodexModelInfo[]>(catalogCache ?? [])
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    const listener = (models: CodexModelInfo[]) => setCatalog(models)
    catalogListeners.add(listener)
    let alive = true
    void loadCatalog().then((models) => {
      if (alive && models.length) setCatalog(models)
    })
    return () => {
      alive = false
      catalogListeners.delete(listener)
    }
  }, [])

  const refresh = useCallback(() => {
    setRefreshing(true)
    void loadCatalog(true).finally(() => setRefreshing(false))
  }, [])

  return { catalog, refreshing, refresh }
}

// Sentinel Select value for a nullable enum whose value is `null` (Radix Select
// forbids an empty-string item value).
const NONE_VALUE = "__none__"

/** Enum-valued ModelInfo fields exposed as dropdowns, with the **authoritative**
 *  value sets extracted from the codex binary. A value outside its set makes
 *  codex reject the entire catalog, so the editor only ever offers valid ones
 *  (the backend also sanitizes as a second line of defense). */
type EnumField = {
  key: string
  labelKey: string
  options: string[]
  nullable?: boolean
}
/** `defaultOn` marks a flag codex treats as **true when absent** (it is skipped
 *  during serialization at its default), so the switch must not read as off. */
type BoolField = { key: string; labelKey: string; defaultOn?: boolean }

/** Wire-protocol shape. These decide whether codex speaks plain OpenAI
 *  Responses or its own GPT-only dialect, which is what makes or breaks a
 *  third-party gateway — see `CODEX_COMPAT_OVERRIDES`. */
const PROTOCOL_ENUM_FIELDS: EnumField[] = [
  {
    key: "tool_mode",
    labelKey: "fieldToolMode",
    options: ["direct", "code_mode", "code_mode_only"],
    nullable: true,
  },
  {
    key: "multi_agent_version",
    labelKey: "fieldMultiAgent",
    options: ["v1", "v2"],
    nullable: true,
  },
]

const PROTOCOL_BOOL_FIELDS: BoolField[] = [
  { key: "use_responses_lite", labelKey: "fieldResponsesLite" },
]

const ENUM_FIELDS: EnumField[] = [
  {
    key: "default_reasoning_summary",
    labelKey: "fieldReasoningSummary",
    options: ["auto", "concise", "detailed", "none"],
  },
  {
    key: "default_verbosity",
    labelKey: "fieldVerbosity",
    options: ["low", "medium", "high"],
    nullable: true,
  },
  {
    key: "shell_type",
    labelKey: "fieldShellType",
    options: ["default", "local", "unified_exec", "disabled", "shell_command"],
  },
  {
    // codex 0.147 accepts only `freeform` (or none); `function` is not a variant.
    key: "apply_patch_tool_type",
    labelKey: "fieldApplyPatch",
    options: ["freeform"],
    nullable: true,
  },
  {
    key: "web_search_tool_type",
    labelKey: "fieldWebSearchType",
    options: ["text", "text_and_image"],
  },
]

const BOOL_FIELDS: BoolField[] = [
  // Renamed from `supports_reasoning_summaries` in codex 0.147, and omitted from
  // the catalog while it holds its `true` default.
  {
    key: "supports_reasoning_summary_parameter",
    labelKey: "fieldReasoningSummaryParam",
    defaultOn: true,
  },
  { key: "support_verbosity", labelKey: "fieldSupportVerbosity" },
  { key: "supports_parallel_tool_calls", labelKey: "fieldParallelToolCalls" },
  { key: "supports_search_tool", labelKey: "fieldSearchTool" },
  {
    key: "supports_image_detail_original",
    labelKey: "fieldImageDetailOriginal",
  },
  { key: "include_apps_usage_instructions", labelKey: "fieldAppsInstructions" },
  {
    key: "include_plugin_usage_instructions",
    labelKey: "fieldPluginInstructions",
  },
  {
    key: "include_skills_usage_instructions",
    labelKey: "fieldSkillsInstructions",
  },
]

function asRecord(info: CodexModelInfo | undefined): Record<string, unknown> {
  return (info ?? {}) as unknown as Record<string, unknown>
}

/** The reasoning-effort options a model actually supports, read from its
 *  `supported_reasoning_levels` (version-specific — 0.144 adds `max`/`ultra`),
 *  so we never offer an effort the base doesn't declare. */
function reasoningEffortsOf(info: CodexModelInfo | undefined): string[] {
  const levels = (info as { supported_reasoning_levels?: unknown } | undefined)
    ?.supported_reasoning_levels
  if (!Array.isArray(levels)) return []
  return levels
    .map((l) =>
      l && typeof l === "object"
        ? (l as { effort?: unknown }).effort
        : undefined
    )
    .filter((e): e is string => typeof e === "string" && !!e)
}

function isListable(m: CodexModelInfo): boolean {
  return (m.visibility ?? "list") === "list"
}

export function CodexModelListEditor({
  value,
  onChange: rawOnChange,
  readOnly = false,
  endpoint = null,
}: {
  value: CodexModelConfig
  onChange: (next: CodexModelConfig) => void
  readOnly?: boolean
  /** Where a provider's own list would come from. `null` offers codex's
   *  built-in list only (no provider to ask, e.g. the ChatGPT subscription). */
  endpoint?: CodexCatalogEndpoint | null
}) {
  const t = useTranslations("CodexModelEditor")
  const ts = useTranslations("CodexModelEditor.catalogSource")
  const tl = ts as unknown as CodexCatalogTranslator
  const { catalog, refreshing, refresh } = useCodexCatalog()
  const source = endpoint ? value.catalog : undefined
  const provider = useCodexProviderList(endpoint, source)
  const valueRef = useRef(value)
  useEffect(() => {
    valueRef.current = value
  }, [value])

  // The shape the provider's rows have: the one recorded when the list was
  // applied, else what the rows at hand say.
  const format = source ? (source.format ?? provider.rows?.format) : undefined
  const providerModels = useMemo(
    () =>
      source && format === "native" && provider.rows?.models
        ? provider.rows.models
        : null,
    [source, format, provider.rows]
  )

  // Heal ghost exclusions (officials codex has since retired to `hide`, or a
  // provider stopped listing) on the way out: they are invisible here yet
  // would keep codeg replacing codex's whole model table. Pruning on emit —
  // not on mount — keeps an untouched form byte-identical to what was stored,
  // so nothing reports a spurious change. Without rows to judge by (a provider
  // list not fetched yet) nothing is pruned.
  const pruneAgainst = useMemo(
    () => (source ? (providerModels ?? []) : catalog),
    [source, providerModels, catalog]
  )
  const onChange = useCallback(
    (next: CodexModelConfig) =>
      rawOnChange(pruneCodexGhostExclusions(next, pruneAgainst)),
    [rawOnChange, pruneAgainst]
  )

  const customs = value.customs ?? []
  const excluded = useMemo(
    () => new Set(value.excludedOfficials ?? []),
    [value.excludedOfficials]
  )
  // Once the user adds a custom or removes an official, codeg writes codex's
  // whole `model_catalog_json` (a full-table replace), so officials codex ships
  // later stop appearing on their own until this list is refreshed + re-saved.
  // Surface that caveat wherever this editor is mounted — but only for removals
  // that still apply, or a long-retired one keeps the warning up forever. A
  // provider's list is refreshed on its own, so it carries no such caveat.
  const hasCustomization = !source && hasCodexCustomization(value, catalog)
  const bySlug = useMemo(() => {
    const map = new Map<string, CodexModelInfo>()
    for (const m of catalog) map.set(m.slug, m)
    return map
  }, [catalog])

  const officials = useMemo(
    () => (source ? (providerModels ?? []) : catalog).filter(isListable),
    [source, providerModels, catalog]
  )
  const shownOfficials = officials.filter((m) => !excluded.has(m.slug))
  const excludedOfficials = officials.filter((m) => excluded.has(m.slug))
  const selected = useMemo(
    () => (format === "openai_list" ? (source?.selected ?? []) : []),
    [format, source]
  )
  const idViews = useMemo(() => {
    const map = new Map<string, CodexOpenAiIdView>()
    for (const v of provider.rows?.missing ?? []) map.set(v.id, v)
    for (const v of provider.rows?.ids ?? []) map.set(v.id, v)
    return map
  }, [provider.rows])
  const returned = useMemo(
    () => new Set((provider.rows?.ids ?? []).map((v) => v.id)),
    [provider.rows]
  )

  // Effective default mirrors the backend: explicit default when it names a
  // shown model, else the first custom, else the first shown official (or
  // picked id).
  const shownSlugs =
    format === "openai_list" ? selected : shownOfficials.map((m) => m.slug)
  const isShown = (slug: string) =>
    customs.some((c) => c.slug === slug) || shownSlugs.includes(slug)
  const effectiveDefault =
    value.default && isShown(value.default)
      ? value.default
      : (customs[0]?.slug ?? shownSlugs[0])

  // ── The provider's list ──
  const [picker, setPicker] = useState<{
    mode: "manage" | "repick"
    view: CodexEndpointCatalogView
  } | null>(null)
  const autoFetch = useRef(false)

  const fetchList = useCallback(async () => {
    const view = await provider.fetchNow()
    const current = valueRef.current
    if (!view || !current.catalog) return
    if (!current.catalog.format) {
      // The first answer fixes the shape, and with it what removing means.
      rawOnChange({
        ...current,
        catalog: { ...current.catalog, format: view.format },
      })
      if (view.format === "openai_list") setPicker({ mode: "manage", view })
    }
  }, [provider, rawOnChange])

  useEffect(() => {
    if (autoFetch.current && provider.request && !provider.fetching) {
      autoFetch.current = false
      void fetchList()
    }
  }, [provider.request, provider.fetching, fetchList])

  const setSource = (next: CodexCatalogSource | undefined) => {
    const current = valueRef.current
    const out: CodexModelConfig = { ...current }
    if (next) out.catalog = next
    else delete out.catalog
    // Switched on: ask the provider at once.
    if (next && !current.catalog) autoFetch.current = true
    rawOnChange(out)
  }

  const unselect = (id: string) =>
    onChange({
      ...value,
      catalog: { ...source, selected: selected.filter((s) => s !== id) },
      default: value.default === id ? undefined : value.default,
    })

  const asCustom = (id: string): CodexCustomEntry => ({
    slug: id,
    base:
      catalog.find((m) => id.startsWith(m.slug))?.slug ??
      catalog[0]?.slug ??
      id,
  })

  const pickerProps = (() => {
    if (!picker) return null
    const view = picker.view
    if (picker.mode === "manage" || view.format === "openai_list") {
      const ids = view.ids ?? []
      const previous =
        picker.mode === "manage" ? selected : shownOfficials.map((m) => m.slug)
      const newIds = new Set(view.diff.added)
      const items: CodexPickerItem[] = ids.map((v) => ({
        id: v.id,
        hint: templateHint(v, tl),
        badge: newIds.has(v.id) && !previous.includes(v.id) ? "new" : undefined,
      }))
      const listed = new Set(ids.map((v) => v.id))
      if (picker.mode === "manage") {
        // Picked ids the provider stopped returning stay picked until the
        // user lets them go.
        for (const id of selected.filter((s) => !listed.has(s))) {
          items.push({
            id,
            hint: templateHint(idViews.get(id), tl),
            badge: "gone",
          })
        }
      }
      return {
        title: ts(picker.mode === "manage" ? "pickerTitle" : "repickTitle"),
        description: ts(
          picker.mode === "manage" ? "pickerHint" : "repickHintOpenai"
        ),
        items,
        initial:
          picker.mode === "manage"
            ? previous
            : previous.filter((id) => listed.has(id)),
        removals:
          picker.mode === "manage"
            ? []
            : previous.filter((id) => !listed.has(id)),
        onConfirm: (picked: string[], keep: string[]) => {
          const current = valueRef.current
          onChange({
            ...current,
            customs: [...(current.customs ?? []), ...keep.map(asCustom)],
            catalog: {
              ...current.catalog,
              format: "openai_list",
              selected: picked,
            },
          })
        },
      }
    }
    // Into a native catalog: what stays unpicked is hidden.
    const models = (view.models ?? []).filter(isListable)
    const slugs = new Set(models.map((m) => m.slug))
    return {
      title: ts("repickTitle"),
      description: ts("repickHintNative"),
      items: models.map((m) => ({
        id: m.slug,
        hint:
          m.display_name && m.display_name !== m.slug
            ? m.display_name
            : undefined,
      })),
      initial: selected.filter((id) => slugs.has(id)),
      removals: selected.filter((id) => !slugs.has(id)),
      onConfirm: (picked: string[], keep: string[]) => {
        const current = valueRef.current
        const kept = new Set(picked)
        const next: CodexModelConfig = {
          ...current,
          customs: [...(current.customs ?? []), ...keep.map(asCustom)],
          catalog: { ...current.catalog, format: "native" },
          excludedOfficials: models
            .map((m) => m.slug)
            .filter((slug) => !kept.has(slug)),
        }
        delete next.catalog?.selected
        if (!next.excludedOfficials?.length) delete next.excludedOfficials
        rawOnChange(next)
      },
    }
  })()

  const setDefault = (slug: string) => onChange({ ...value, default: slug })
  const excludeOfficial = (slug: string) =>
    onChange({
      ...value,
      excludedOfficials: [...excluded, slug],
      default: value.default === slug ? undefined : value.default,
    })
  const readdOfficial = (slug: string) =>
    onChange({
      ...value,
      excludedOfficials: [...excluded].filter((s) => s !== slug),
    })
  const addCustom = (compat: boolean) => {
    const base = catalog[0]?.slug ?? ""
    const entry: CodexCustomEntry = { slug: "", base }
    onChange({
      ...value,
      customs: [
        ...customs,
        {
          ...entry,
          overrides: compat
            ? applyCodexCompatOverrides(entry, asRecord(bySlug.get(base)), true)
            : undefined,
        },
      ],
    })
  }
  const patchCustom = (index: number, patch: Partial<CodexCustomEntry>) =>
    onChange({
      ...value,
      customs: customs.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    })
  const removeCustom = (index: number) => {
    const removed = customs[index]
    onChange({
      ...value,
      customs: customs.filter((_, i) => i !== index),
      default: value.default === removed?.slug ? undefined : value.default,
    })
  }

  const providerRowsMissing = !!source && !provider.rows
  const officialsTitle = source
    ? ts("providerModelsTitle")
    : t("officialsTitle")
  const officialsHint = !source
    ? t("officialsHint")
    : format === "openai_list"
      ? ts("providerModelsHintOpenai")
      : ts("providerModelsHintNative")

  return (
    <div className="space-y-4">
      {endpoint && (
        <CodexCatalogSourceSection
          endpoint={endpoint}
          source={source}
          list={provider}
          readOnly={readOnly}
          onSourceChange={setSource}
          onFetch={() => void fetchList()}
          onRepick={() =>
            provider.formatChanged &&
            setPicker({ mode: "repick", view: provider.formatChanged })
          }
        />
      )}
      {(endpoint?.showStatus || endpoint?.statusBinding) && (
        <CodexCatalogStatusLine
          onPublished={endpoint.onPublished}
          binding={endpoint.statusBinding}
        />
      )}

      {hasCustomization && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-2xs text-amber-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("customizedNotice")}</span>
        </div>
      )}

      {/* Officials: auto-included from the live catalog (or the provider's
          list), deletable. */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold">{officialsTitle}</p>
            <p className="text-2xs text-muted-foreground">{officialsHint}</p>
          </div>
          {!source ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground"
              onClick={refresh}
              disabled={refreshing}
              title={t("refresh")}
              aria-label={t("refresh")}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
              />
            </Button>
          ) : (
            format === "openai_list" &&
            !readOnly &&
            !endpoint?.managedBy && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 text-xs"
                disabled={!provider.rows}
                onClick={() =>
                  provider.rows &&
                  setPicker({ mode: "manage", view: provider.rows })
                }
              >
                <ListChecks className="mr-1 h-3.5 w-3.5" />
                {ts("manage")}
              </Button>
            )
          )}
        </div>

        {format === "openai_list" ? (
          selected.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-3 text-center text-2xs text-muted-foreground">
              {providerRowsMissing ? ts("fetchFirst") : ts("nothingPicked")}
            </p>
          ) : (
            <div className="space-y-1.5">
              {selected.map((id) => (
                <div
                  key={id}
                  className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                >
                  <button
                    type="button"
                    title={
                      id === effectiveDefault
                        ? t("defaultHint")
                        : t("makeDefault")
                    }
                    onClick={() => onChange({ ...value, default: id })}
                    disabled={readOnly}
                    className={cn(
                      "shrink-0 text-muted-foreground transition-colors hover:text-amber-500 disabled:opacity-40",
                      id === effectiveDefault && "text-amber-500"
                    )}
                  >
                    <Star
                      className={cn(
                        "h-4 w-4",
                        id === effectiveDefault && "fill-current"
                      )}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs">{id}</p>
                    <p className="truncate text-2xs text-muted-foreground">
                      {templateHint(idViews.get(id), tl) ?? ""}
                    </p>
                  </div>
                  {provider.rows && !returned.has(id) && (
                    <span className="shrink-0 rounded bg-amber-500/10 px-1.5 text-2xs text-amber-500">
                      {ts("badgeGone")}
                    </span>
                  )}
                  {!readOnly && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-red-500"
                      onClick={() => unselect(id)}
                      aria-label={t("remove")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )
        ) : providerRowsMissing ? (
          <p className="rounded-md border border-dashed px-3 py-3 text-center text-2xs text-muted-foreground">
            {ts("fetchFirst")}
          </p>
        ) : shownOfficials.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-3 text-center text-2xs text-muted-foreground">
            {t("officialsEmpty")}
          </p>
        ) : (
          <div className="space-y-1.5">
            {shownOfficials.map((m) => (
              <div
                key={m.slug}
                className="flex items-center gap-2 rounded-md border px-2 py-1.5"
              >
                <button
                  type="button"
                  title={
                    m.slug === effectiveDefault
                      ? t("defaultHint")
                      : t("makeDefault")
                  }
                  onClick={() => setDefault(m.slug)}
                  disabled={readOnly}
                  className={cn(
                    "shrink-0 text-muted-foreground transition-colors hover:text-amber-500 disabled:opacity-40",
                    m.slug === effectiveDefault && "text-amber-500"
                  )}
                >
                  <Star
                    className={cn(
                      "h-4 w-4",
                      m.slug === effectiveDefault && "fill-current"
                    )}
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs">{m.display_name || m.slug}</p>
                  <p className="truncate text-2xs text-muted-foreground">
                    {m.slug}
                  </p>
                </div>
                {!readOnly && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-red-500"
                    onClick={() => excludeOfficial(m.slug)}
                    aria-label={t("remove")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {!readOnly &&
          format !== "openai_list" &&
          excludedOfficials.length > 0 && (
            <Select value="" onValueChange={readdOfficial}>
              <SelectTrigger className="h-7 w-auto gap-1 text-xs">
                <Plus className="h-3.5 w-3.5" />
                <SelectValue placeholder={t("readdOfficial")} />
              </SelectTrigger>
              <SelectContent>
                {excludedOfficials.map((m) => (
                  <SelectItem key={m.slug} value={m.slug} className="text-xs">
                    {m.display_name || m.slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
      </section>

      {/* Customs: user-defined models cloning an official base. */}
      <section className="space-y-2">
        <p className="text-xs font-semibold">{t("customsTitle")}</p>
        {customs.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-3 text-center text-2xs text-muted-foreground">
            {t("customsEmpty")}
          </p>
        ) : (
          <div className="space-y-2">
            {customs.map((entry, i) => (
              <CodexCustomRow
                key={i}
                entry={entry}
                isDefault={entry.slug === effectiveDefault && !!entry.slug}
                readOnly={readOnly}
                catalog={catalog}
                baseInfo={bySlug.get(entry.base)}
                onPatch={(patch) => patchCustom(i, patch)}
                onRemove={() => removeCustom(i)}
                onMakeDefault={() => entry.slug && setDefault(entry.slug)}
              />
            ))}
          </div>
        )}
        {!readOnly && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t("addCustom")}
                <ChevronDown className="ml-1 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                className="text-xs"
                onSelect={() => addCustom(false)}
              >
                {t("addCustomGpt")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs"
                onSelect={() => addCustom(true)}
              >
                {t("addCustomCompat")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </section>

      {pickerProps && (
        <CodexCatalogPickerDialog
          open={!!picker}
          onOpenChange={(open) => !open && setPicker(null)}
          {...pickerProps}
        />
      )}
    </div>
  )
}

function CodexCustomRow({
  entry,
  isDefault,
  readOnly,
  catalog,
  baseInfo,
  onPatch,
  onRemove,
  onMakeDefault,
}: {
  entry: CodexCustomEntry
  isDefault: boolean
  readOnly: boolean
  catalog: CodexModelInfo[]
  baseInfo: CodexModelInfo | undefined
  onPatch: (patch: Partial<CodexCustomEntry>) => void
  onRemove: () => void
  onMakeDefault: () => void
}) {
  const t = useTranslations("CodexModelEditor")
  const [expanded, setExpanded] = useState(false)

  const overrides = entry.overrides ?? {}
  const base = asRecord(baseInfo)

  const setOverrides = (next: Record<string, unknown>) =>
    onPatch({ overrides: Object.keys(next).length ? next : undefined })

  // Sparse override write: keep only genuine differences from the clone base, so
  // an entry equal to its base carries no overrides and the canonical serialize
  // stays byte-stable (no spurious "dirty").
  const setField = (key: string, next: unknown) => {
    const nextOverrides = { ...overrides }
    if (Object.is(next, base[key])) delete nextOverrides[key]
    else nextOverrides[key] = next
    setOverrides(nextOverrides)
  }
  const effective = (key: string): unknown =>
    key in overrides ? overrides[key] : base[key]

  const reasoningEfforts = reasoningEffortsOf(baseInfo)

  const renderEnum = (f: EnumField, options: string[]) => {
    const raw = effective(f.key)
    const current =
      typeof raw === "string"
        ? raw
        : raw === null && f.nullable
          ? NONE_VALUE
          : ""
    // Keep an unexpected stored value visible/selectable.
    const opts =
      typeof raw === "string" && !options.includes(raw)
        ? [raw, ...options]
        : options
    return (
      <div key={f.key} className="space-y-1">
        <Label className="text-2xs font-medium text-muted-foreground">
          {t(f.labelKey as Parameters<typeof t>[0])}
        </Label>
        <Select
          value={current || undefined}
          disabled={readOnly}
          onValueChange={(v) => setField(f.key, v === NONE_VALUE ? null : v)}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {f.nullable && (
              <SelectItem value={NONE_VALUE} className="text-xs">
                {t("optNone")}
              </SelectItem>
            )}
            {opts.map((o) => (
              <SelectItem key={o} value={o} className="text-xs">
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  const renderBool = (f: BoolField) => {
    const raw = effective(f.key)
    return (
      <div
        key={f.key}
        className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
      >
        <Label className="text-2xs font-medium text-muted-foreground">
          {t(f.labelKey as Parameters<typeof t>[0])}
        </Label>
        <Switch
          checked={typeof raw === "boolean" ? raw : !!f.defaultOn}
          disabled={readOnly}
          onCheckedChange={(v) => setField(f.key, v)}
        />
      </div>
    )
  }

  const isCompat = isCodexCompatEntry(entry, base)
  const setCompat = (enabled: boolean) =>
    onPatch({ overrides: applyCodexCompatOverrides(entry, base, enabled) })

  const descBase = typeof base.description === "string" ? base.description : ""
  const descValue =
    typeof overrides.description === "string" ? overrides.description : descBase
  const biBase =
    typeof base.base_instructions === "string" ? base.base_instructions : ""
  const biValue =
    typeof overrides.base_instructions === "string"
      ? overrides.base_instructions
      : biBase

  return (
    <div className="rounded-md border p-2">
      <div className="flex items-start gap-2">
        <button
          type="button"
          title={isDefault ? t("defaultHint") : t("makeDefault")}
          onClick={onMakeDefault}
          disabled={readOnly || !entry.slug}
          className={cn(
            "mt-1.5 shrink-0 text-muted-foreground transition-colors hover:text-amber-500 disabled:opacity-40",
            isDefault && "text-amber-500"
          )}
        >
          <Star className={cn("h-4 w-4", isDefault && "fill-current")} />
        </button>

        <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_7rem]">
          <Input
            value={entry.slug}
            readOnly={readOnly}
            placeholder={t("slugPlaceholder")}
            onChange={(e) => onPatch({ slug: e.target.value })}
            className="h-8 text-xs"
          />
          <Input
            value={entry.displayName ?? ""}
            readOnly={readOnly}
            placeholder={t("displayNamePlaceholder")}
            onChange={(e) =>
              onPatch({ displayName: e.target.value || undefined })
            }
            className="h-8 text-xs"
          />
          <Input
            type="number"
            value={entry.contextWindow ?? ""}
            readOnly={readOnly}
            placeholder={t("contextWindow")}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10)
              onPatch({ contextWindow: Number.isFinite(n) ? n : undefined })
            }}
            className="h-8 text-xs"
          />
        </div>

        {!readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mt-0.5 h-7 w-7 shrink-0 text-muted-foreground hover:text-red-500"
            onClick={onRemove}
            aria-label={t("remove")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-1.5 flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {t("advanced")}
      </button>

      {expanded && (
        <div className="mt-2 space-y-3 border-t pt-2">
          <div className="space-y-1">
            <Label className="text-2xs font-medium text-muted-foreground">
              {t("presetLabel")}
            </Label>
            <div className="flex gap-1.5">
              <Button
                type="button"
                variant={isCompat ? "outline" : "secondary"}
                size="sm"
                disabled={readOnly}
                className="h-7 flex-1 text-xs"
                onClick={() => setCompat(false)}
              >
                {t("presetGpt")}
              </Button>
              <Button
                type="button"
                variant={isCompat ? "secondary" : "outline"}
                size="sm"
                disabled={readOnly}
                className="h-7 flex-1 text-xs"
                onClick={() => setCompat(true)}
              >
                {t("presetCompat")}
              </Button>
            </div>
            <p className="text-2xs text-muted-foreground">{t("presetHint")}</p>
          </div>

          <div className="space-y-1">
            <Label className="text-2xs font-medium text-muted-foreground">
              {t("baseTemplate")}
            </Label>
            <Select
              value={entry.base}
              disabled={readOnly}
              onValueChange={(base) => onPatch({ base })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={t("baseTemplate")} />
              </SelectTrigger>
              <SelectContent>
                {catalog.map((m) => (
                  <SelectItem key={m.slug} value={m.slug} className="text-xs">
                    {m.display_name || m.slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-2xs text-muted-foreground">
              {t("baseTemplateHint")}
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-2xs font-semibold text-muted-foreground">
              {t("groupProtocol")}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {PROTOCOL_ENUM_FIELDS.map((f) => renderEnum(f, f.options))}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {PROTOCOL_BOOL_FIELDS.map(renderBool)}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-2xs font-semibold text-muted-foreground">
              {t("groupBehavior")}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {reasoningEfforts.length > 0 &&
                renderEnum(
                  {
                    key: "default_reasoning_level",
                    labelKey: "fieldReasoningLevel",
                    options: reasoningEfforts,
                  },
                  reasoningEfforts
                )}
              {ENUM_FIELDS.map((f) => renderEnum(f, f.options))}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {BOOL_FIELDS.map(renderBool)}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-2xs font-semibold text-muted-foreground">
              {t("groupInstructions")}
            </p>
            <div className="space-y-1">
              <Label className="text-2xs font-medium text-muted-foreground">
                {t("fieldDescription")}
              </Label>
              <Textarea
                value={descValue}
                readOnly={readOnly}
                rows={2}
                onChange={(e) => setField("description", e.target.value)}
                className="max-h-20 resize-y text-2xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-2xs font-medium text-muted-foreground">
                {t("baseInstructions")}
              </Label>
              <Textarea
                value={biValue}
                readOnly={readOnly}
                rows={6}
                onChange={(e) => setField("base_instructions", e.target.value)}
                className="max-h-48 resize-y overflow-y-auto font-mono text-2xs"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
