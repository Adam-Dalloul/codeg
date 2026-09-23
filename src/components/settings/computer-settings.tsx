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
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Monitor } from "lucide-react"
import { toast } from "sonner"

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

export function ComputerSettingsSection() {
  const t = useTranslations("ComputerUse.settings")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [values, setValues] = useState<Values>({ ttl: 30, blocklist: "" })
  const [baseline, setBaseline] = useState<Values>({ ttl: 30, blocklist: "" })
  const dirtyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    getComputerToolsSettings()
      .then((settings) => {
        if (cancelled) return
        setValues(fromSettings(settings))
        setBaseline(fromSettings(settings))
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
  }, [])

  const dirty =
    values.ttl !== baseline.ttl ||
    entries(values.blocklist).join("\n") !==
      entries(baseline.blocklist).join("\n")
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  // Another window saved the record: follow it, unless this form holds edits
  // of its own — those still win on save.
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<ComputerToolsSettings>(
      COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT,
      (remote) => {
        const next = fromSettings(remote)
        setBaseline(next)
        if (!dirtyRef.current) setValues(next)
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

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const applied = await setComputerToolsPreferences(
        values.ttl,
        entries(values.blocklist)
      )
      setValues(fromSettings(applied))
      setBaseline(fromSettings(applied))
      toast.success(t("saved"))
    } catch (e) {
      toast.error(t("saveFailed"), { description: toErrorMessage(e) })
    } finally {
      setSaving(false)
    }
  }, [values, t])

  return (
    <SettingsSection
      icon={Monitor}
      title={t("title")}
      description={t("description")}
    >
      {loadError && (
        <SettingsError>{t("loadFailed", { detail: loadError })}</SettingsError>
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
              disabled={loading}
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
            disabled={loading}
            rows={4}
            className="font-mono text-xs"
          />
        </SettingRow>
      </SettingCard>

      <SettingNote icon={Monitor}>{t("boundary")}</SettingNote>

      <SettingsSaveBar
        onSave={() => void save()}
        saving={saving}
        disabled={loading || !dirty}
        label={t("save")}
        savingLabel={t("saving")}
      />
    </SettingsSection>
  )
}
