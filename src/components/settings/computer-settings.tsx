"use client"

/**
 * Computer use: how long a shared window stays shared while nobody reads it,
 * and which applications can never be shared. The on/off switch itself sits
 * with the other tool groups in the panel above (and in the status-bar
 * popover); this section edits only the two settings under it, through a
 * writer that leaves the switch alone.
 *
 * The blocklist here only ever adds: the built-in entries — credential
 * managers, the system's password prompts, System Settings — are not shown as
 * editable because they are not.
 *
 * Each field is its own edit. Save sends only the fields this form changed,
 * and another window's save moves every field this form has not touched: a
 * timeout changed here must not carry back a blocklist loaded before another
 * window added to it. Nothing is editable until the stored values have been
 * read — a form showing defaults after a failed read would save them over
 * the real list — or while a save is on its way.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Monitor, RotateCw } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  SettingCard,
  SettingNote,
  SettingRow,
} from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSaveBar,
  SettingsSection,
} from "@/components/shared/settings-section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { toErrorMessage } from "@/lib/app-error"
import {
  getComputerToolsSettings,
  setComputerToolsPreferences,
} from "@/lib/computer/computer-api"
import {
  COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT,
  type ComputerToolsSettings,
} from "@/lib/computer/types"
import { subscribe } from "@/lib/platform"

/** The choices offered, in minutes; 0 is "until I take it back". */
const TTL_CHOICES = [10, 30, 60, 240, 0] as const

interface Values {
  ttl: number
  /** One entry per line, as typed. */
  blocklist: string
}

function fromSettings(settings: ComputerToolsSettings): Values {
  return {
    ttl: settings.grantTtlMinutes,
    blocklist: settings.blocklist.join("\n"),
  }
}

function entries(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function ttlDirty(values: Values, baseline: Values): boolean {
  return values.ttl !== baseline.ttl
}

function blocklistDirty(values: Values, baseline: Values): boolean {
  return (
    entries(values.blocklist).join("\n") !==
    entries(baseline.blocklist).join("\n")
  )
}

export function ComputerSettingsSection() {
  const t = useTranslations("ComputerUse.settings")
  const tComputer = useTranslations("ComputerUse")
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [values, setValues] = useState<Values>({ ttl: 30, blocklist: "" })
  const [baseline, setBaseline] = useState<Values>({ ttl: 30, blocklist: "" })
  // Read by the subscription below, which is set up once.
  const valuesRef = useRef(values)
  const baselineRef = useRef(baseline)
  useEffect(() => {
    valuesRef.current = values
    baselineRef.current = baseline
  }, [values, baseline])
  /** Bumped by every broadcast: a read or a save that started before one is
   *  older than it. */
  const remoteGenRef = useRef(0)
  /** The record as the last broadcast carried it. */
  const remoteRef = useRef<Values | null>(null)

  /** Take in a read that started at broadcast `gen`: unless a broadcast has
   *  landed since (it already set the fields, and is newer), the read is what
   *  is stored. */
  const applyRead = useCallback(
    (settings: ComputerToolsSettings, gen: number) => {
      if (remoteGenRef.current === gen) {
        setValues(fromSettings(settings))
        setBaseline(fromSettings(settings))
      }
      setLoaded(true)
      setLoadError(null)
    },
    []
  )

  const load = useCallback(async () => {
    setLoading(true)
    const gen = remoteGenRef.current
    try {
      applyRead(await getComputerToolsSettings(), gen)
    } catch (e) {
      setLoadError(toErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [applyRead])

  useEffect(() => {
    let cancelled = false
    const gen = remoteGenRef.current
    getComputerToolsSettings()
      .then((settings) => {
        if (!cancelled) applyRead(settings, gen)
      })
      .catch((e) => {
        if (!cancelled) setLoadError(toErrorMessage(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applyRead])

  // Another window saved the record: every field this form has not touched
  // follows it; a touched one keeps its edit (only its baseline moves, so it
  // stays dirty and still wins on save).
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<ComputerToolsSettings>(
      COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT,
      (remote) => {
        remoteGenRef.current += 1
        const next = fromSettings(remote)
        remoteRef.current = next
        const current = valuesRef.current
        const base = baselineRef.current
        setValues((prev) => ({
          ttl: ttlDirty(current, base) ? prev.ttl : next.ttl,
          blocklist: blocklistDirty(current, base)
            ? prev.blocklist
            : next.blocklist,
        }))
        setBaseline(next)
        setLoaded(true)
        setLoadError(null)
      }
    )
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  const dirtyTtl = ttlDirty(values, baseline)
  const dirtyBlocklist = blocklistDirty(values, baseline)
  const dirty = dirtyTtl || dirtyBlocklist
  const editable = loaded && !saving

  const save = useCallback(async () => {
    setSaving(true)
    const gen = remoteGenRef.current
    try {
      const applied = await setComputerToolsPreferences({
        grantTtlMinutes: dirtyTtl ? values.ttl : undefined,
        blocklist: dirtyBlocklist ? entries(values.blocklist) : undefined,
      })
      // The save's own broadcast, or another window's after it, may have
      // landed first; the last broadcast is then the newest record there is.
      const latest =
        remoteGenRef.current !== gen && remoteRef.current
          ? remoteRef.current
          : fromSettings(applied)
      setValues(latest)
      setBaseline(latest)
      toast.success(t("saved"))
    } catch (e) {
      toast.error(t("saveFailed"), { description: toErrorMessage(e) })
    } finally {
      setSaving(false)
    }
  }, [values, dirtyTtl, dirtyBlocklist, t])

  return (
    <SettingsSection
      icon={Monitor}
      title={t("title")}
      description={t("description")}
    >
      {loadError && (
        <SettingsError>
          <span className="flex flex-wrap items-center gap-2">
            {t("loadFailed", { detail: loadError })}
            {!loaded && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void load()}
                disabled={loading}
              >
                <RotateCw className="size-3" />
                {tComputer("refresh")}
              </Button>
            )}
          </span>
        </SettingsError>
      )}

      <SettingCard>
        <SettingRow
          title={t("ttl.label")}
          description={t("ttl.hint")}
          htmlFor="computer-grant-ttl"
          control={
            <Select
              value={String(values.ttl)}
              onValueChange={(v) =>
                setValues((prev) => ({ ...prev, ttl: Number(v) }))
              }
              disabled={!editable}
            >
              <SelectTrigger id="computer-grant-ttl" size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TTL_CHOICES.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {minutes === 0
                      ? t("ttl.never")
                      : t("ttl.minutes", { minutes })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          title={t("blocklist.label")}
          description={t("blocklist.hint")}
          htmlFor="computer-blocklist"
        >
          <Textarea
            id="computer-blocklist"
            value={values.blocklist}
            onChange={(e) =>
              setValues((prev) => ({ ...prev, blocklist: e.target.value }))
            }
            placeholder={t("blocklist.placeholder")}
            disabled={!editable}
            rows={4}
            className="font-mono text-xs"
          />
        </SettingRow>
      </SettingCard>

      <SettingNote icon={Monitor}>{t("boundary")}</SettingNote>

      <SettingsSaveBar
        onSave={() => void save()}
        saving={saving}
        disabled={!editable || !dirty}
        label={t("save")}
        savingLabel={t("saving")}
      />
    </SettingsSection>
  )
}
