"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronsUpDown,
  Download,
  ListChecks,
  Loader2,
  Plus,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  useProviderModels,
  type ProviderModelsError,
  type ProviderModelsInput,
  type ProviderModelsState,
} from "@/hooks/use-provider-models"
import { normalizeModelIds, type ListedProviderModel } from "@/lib/types"
import { cn } from "@/lib/utils"

/** A translator scoped to `ProviderModels`, as next-intl hands it out. */
interface ProviderModelsTranslator {
  (key: string, values?: Record<string, string | number>): string
  has: (key: string) => boolean
}

/** The localized text of a failed fetch, the English message for a code
 *  without a translation. */
export function providerModelsErrorText(
  error: ProviderModelsError,
  t: ProviderModelsTranslator
): string {
  const key = `errors.${error.code}`
  if (!t.has(key)) return error.message
  return t(key, { ...error.params, message: error.message })
}

/** [`providerModelsErrorText`] in the page's language. */
export function useProviderModelsErrorText() {
  const t = useTranslations("ProviderModels") as ProviderModelsTranslator
  return useCallback(
    (error: ProviderModelsError) => providerModelsErrorText(error, t),
    [t]
  )
}

function formatContext(tokens: number | undefined): string {
  if (!tokens) return ""
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`
  }
  return `${Math.round(tokens / 1000)}K`
}

/** "Fetch models": asks the provider, disabled until there is a URL and a
 *  key to ask with. */
export function ProviderModelsFetchButton({
  state,
  disabled = false,
  className,
}: {
  state: ProviderModelsState
  disabled?: boolean
  className?: string
}) {
  const t = useTranslations("ProviderModels")
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => void state.fetchNow()}
      disabled={disabled || state.fetching || !state.request}
      className={cn("h-6 shrink-0 gap-1 px-2 text-2xs", className)}
    >
      {state.fetching ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Download className="h-3 w-3" />
      )}
      {t("fetch")}
    </Button>
  )
}

/** The line under a fetch: what is missing, what failed, or how many models
 *  the provider lists. Nothing before the first fetch. */
export function ProviderModelsStatus({
  state,
  quietWhileIncomplete = false,
  className,
}: {
  state: ProviderModelsState
  /** Say nothing about a missing URL or key (a form showing many). */
  quietWhileIncomplete?: boolean
  className?: string
}) {
  const t = useTranslations("ProviderModels") as ProviderModelsTranslator
  let text: string | null = null
  let tone = "text-muted-foreground"
  if (state.missing === "apiKey")
    text = quietWhileIncomplete ? null : t("needKey")
  else if (state.missing === "baseUrl")
    text = quietWhileIncomplete ? null : t("needBaseUrl")
  else if (state.error) {
    text = providerModelsErrorText(state.error, t)
    tone = "text-destructive"
  } else if (state.list) {
    text = t("listed", { count: state.list.models.length })
  }
  if (!text) return null
  return (
    <p className={cn("text-2xs", tone, className)} role="status">
      {text}
    </p>
  )
}

/** A model id field: typed freely, or chosen from the models the provider
 *  listed once they were fetched. */
export function ModelIdInputWithFetch({
  id,
  value,
  onChange,
  models,
  placeholder,
  disabled = false,
  readOnly = false,
  className,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  models: ListedProviderModel[]
  placeholder?: string
  disabled?: boolean
  readOnly?: boolean
  className?: string
  "aria-label"?: string
  "aria-invalid"?: boolean
}) {
  const offer = models.length > 0 && !disabled && !readOnly
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
      />
      {offer && (
        <ModelListDropdown
          models={models}
          current={value}
          onSelect={onChange}
        />
      )}
    </div>
  )
}

function ModelListDropdown({
  models,
  current,
  onSelect,
}: {
  models: ListedProviderModel[]
  current: string
  onSelect: (id: string) => void
}) {
  const t = useTranslations("ProviderModels")
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={t("choose")}
          title={t("choose")}
        >
          <ChevronsUpDown className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <Command>
          <CommandInput placeholder={t("search")} className="h-8 text-xs" />
          <CommandList className="max-h-64">
            <CommandEmpty>{t("noMatch")}</CommandEmpty>
            {models.map((model) => (
              <CommandItem
                key={model.id}
                value={model.id}
                keywords={model.displayName ? [model.displayName] : undefined}
                onSelect={() => {
                  onSelect(model.id)
                  setOpen(false)
                }}
                className={cn(
                  "text-xs",
                  model.id === current && "font-medium text-primary"
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  {model.id}
                </span>
                {model.displayName && (
                  <span className="max-w-[40%] shrink-0 truncate text-2xs text-muted-foreground">
                    {model.displayName}
                  </span>
                )}
                {model.contextWindow ? (
                  <span className="shrink-0 text-3xs text-muted-foreground">
                    {formatContext(model.contextWindow)}
                  </span>
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** One row of [`ModelPickerDialog`]. */
export interface ModelPickerItem {
  id: string
  /** A second line about it. */
  hint?: string
  /** `new`: listed for the first time; `gone`: the provider stopped listing
   *  it; `unlisted`: configured, but not among the provider's models. */
  badge?: "new" | "gone" | "unlisted"
}

/** Pick ids from a provider's list. Rows the provider does not (or no
 *  longer) list come first, so a configured one is not missed; `removals` are
 *  picks about to go, each with an opt-in to keep it (`keepLabel`). */
export function ModelPickerDialog({
  open,
  onOpenChange,
  title,
  description,
  items,
  initial,
  removals = [],
  keepLabel,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  items: ModelPickerItem[]
  initial: string[]
  removals?: string[]
  keepLabel?: string
  onConfirm: (picked: string[], keep: string[]) => void
}) {
  const t = useTranslations("ProviderModels.picker")
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial))
  const [keep, setKeep] = useState<Set<string>>(() => new Set())
  const [filter, setFilter] = useState("")

  useEffect(() => {
    if (!open) return
    setPicked(new Set(initial))
    setKeep(new Set())
    setFilter("")
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q
      ? items.filter((item) => item.id.toLowerCase().includes(q))
      : items
    const apart = (item: ModelPickerItem) =>
      item.badge === "gone" || item.badge === "unlisted"
    return [...list.filter(apart), ...list.filter((item) => !apart(item))]
  }, [items, filter])

  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("filter")}
              className="h-8 text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 text-2xs"
              onClick={() =>
                setPicked(new Set([...picked, ...shown.map((i) => i.id)]))
              }
            >
              {t("all")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 text-2xs"
              onClick={() => {
                const hidden = new Set(shown.map((i) => i.id))
                setPicked(new Set([...picked].filter((id) => !hidden.has(id))))
              }}
            >
              {t("none")}
            </Button>
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
            {shown.map((item) => (
              <label
                key={item.id}
                className="flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5"
              >
                <Checkbox
                  checked={picked.has(item.id)}
                  onCheckedChange={(v) =>
                    setPicked(toggle(picked, item.id, v === true))
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs">{item.id}</p>
                  {item.hint && (
                    <p className="truncate text-2xs text-muted-foreground">
                      {item.hint}
                    </p>
                  )}
                </div>
                {item.badge === "new" && (
                  <span className="shrink-0 rounded bg-primary/10 px-1.5 text-2xs text-primary">
                    {t("badgeNew")}
                  </span>
                )}
                {item.badge === "gone" && (
                  <span className="shrink-0 rounded bg-amber-500/10 px-1.5 text-2xs text-amber-500">
                    {t("badgeGone")}
                  </span>
                )}
                {item.badge === "unlisted" && (
                  <span className="shrink-0 rounded bg-amber-500/10 px-1.5 text-2xs text-amber-500">
                    {t("badgeUnlisted")}
                  </span>
                )}
              </label>
            ))}
            {shown.length === 0 && (
              <p className="py-4 text-center text-2xs text-muted-foreground">
                {t("empty")}
              </p>
            )}
          </div>
          {removals.length > 0 && (
            <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
              <p className="text-2xs text-amber-500">
                {t("removalsTitle", { count: removals.length })}
              </p>
              {removals.map((id) => (
                <label key={id} className="flex items-center gap-2 text-2xs">
                  <Checkbox
                    checked={keep.has(id)}
                    onCheckedChange={(v) =>
                      setKeep(toggle(keep, id, v === true))
                    }
                  />
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {id}
                  </span>
                  <span className="text-muted-foreground">
                    {keepLabel ?? t("keep")}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => {
              // In the list's order.
              onConfirm(
                items.map((i) => i.id).filter((id) => picked.has(id)),
                [...keep]
              )
              onOpenChange(false)
            }}
          >
            {t("confirm", { count: picked.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "Choose models": fetches when there is no list yet, then lets the ids to
 *  keep be picked from it. Configured ids the provider does not list stay
 *  in the dialog, picked, so confirming never drops one unseen. */
export function FetchedModelPicker({
  state,
  configured,
  onConfirm,
  title,
  description,
  disabled = false,
  className,
}: {
  state: ProviderModelsState
  /** The ids the form has now, in its order. */
  configured: string[]
  /** The configured ids still picked, in their order, then the new picks in
   *  the provider's. */
  onConfirm: (ids: string[]) => void
  title?: string
  description?: string
  disabled?: boolean
  className?: string
}) {
  const t = useTranslations("ProviderModels")
  const [open, setOpen] = useState(false)

  const items = useMemo<ModelPickerItem[]>(() => {
    const listed = state.list?.models ?? []
    const known = new Set(listed.map((m) => m.id))
    const unlisted = configured
      .filter((id) => id.trim() && !known.has(id))
      .map((id) => ({ id, badge: "unlisted" as const }))
    return [
      ...unlisted,
      ...listed.map((m) => ({
        id: m.id,
        hint: [m.displayName, formatContext(m.contextWindow)]
          .filter(Boolean)
          .join(" · "),
      })),
    ]
  }, [state.list, configured])

  const openPicker = async () => {
    const list = state.list ?? (await state.fetchNow())
    if (list) setOpen(true)
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void openPicker()}
        disabled={disabled || state.fetching || !state.request}
        className={cn("h-7 gap-1 px-2 text-2xs", className)}
      >
        {state.fetching ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <ListChecks className="h-3 w-3" />
        )}
        {t("pick")}
      </Button>
      <ModelPickerDialog
        open={open}
        onOpenChange={setOpen}
        title={title ?? t("picker.title")}
        description={description}
        items={items}
        initial={configured}
        onConfirm={(picked) => {
          const chosen = new Set(picked)
          const kept = configured.filter((id) => chosen.has(id))
          const had = new Set(kept)
          onConfirm([...kept, ...picked.filter((id) => !had.has(id))])
        }}
      />
    </>
  )
}

/** A list of model ids an agent offers: each removable, more added from the
 *  provider's models (`state`) or typed in — several at once, split on
 *  spaces and commas. */
export function ModelIdListField({
  ids,
  onChange,
  state,
  readOnly = false,
  title,
  hint,
}: {
  ids: string[]
  onChange: (ids: string[]) => void
  /** The provider's models; `null` where they cannot be fetched. */
  state: ProviderModelsState | null
  readOnly?: boolean
  title: string
  hint?: string
}) {
  const t = useTranslations("ProviderModels.list")
  const [typed, setTyped] = useState("")
  const add = () => {
    const next = normalizeModelIds([...ids, ...typed.split(/[\s,]+/)])
    if (next.length !== ids.length) onChange(next)
    setTyped("")
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs text-muted-foreground">{title}</span>
        {!readOnly && state && (
          <FetchedModelPicker
            state={state}
            configured={ids}
            onConfirm={(picked) => onChange(normalizeModelIds(picked))}
          />
        )}
      </div>
      {ids.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {ids.map((id) => (
            <span
              key={id}
              className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-2xs"
            >
              <span className="truncate">{id}</span>
              {!readOnly && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={t("remove", { id })}
                  onClick={() => onChange(ids.filter((other) => other !== id))}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground">{t("empty")}</p>
      )}
      {!readOnly && (
        <div className="flex items-center gap-1">
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault()
                add()
              }
            }}
            placeholder={t("addPlaceholder")}
            aria-label={t("addPlaceholder")}
            className="h-7 text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-2xs"
            onClick={add}
            disabled={!typed.trim()}
          >
            <Plus className="h-3 w-3" />
            {t("add")}
          </Button>
        </div>
      )}
      {hint && <p className="text-2xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** [`FetchedModelPicker`] with a fetch of its own, for a form that shows one
 *  per provider. */
export function ProviderModelsPicker({
  input,
  configured,
  onConfirm,
  disabled = false,
}: {
  input: ProviderModelsInput
  configured: string[]
  onConfirm: (ids: string[]) => void
  disabled?: boolean
}) {
  const state = useProviderModels(input)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FetchedModelPicker
        state={state}
        configured={configured}
        onConfirm={onConfirm}
        disabled={disabled}
      />
      <ProviderModelsStatus state={state} quietWhileIncomplete />
    </div>
  )
}
