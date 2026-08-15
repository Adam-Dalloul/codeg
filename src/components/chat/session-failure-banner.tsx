"use client"

/**
 * JetBrains AIR typed session-failure strips, docked under the composer next
 * to the Claude API-retry line (`conversation-shell`). One strip per record:
 *
 * - ACTIVE severity-"error" records use the destructive palette (matching the
 *   shell's error strip) and carry the record's suggested action buttons
 *   (`retry` / `login` / `new_session` — the vocabulary the adapters emit;
 *   unknown actions are simply not rendered). Terminal errors stay until the
 *   user acts: sending a new prompt settles them (reducer), and a recurrence
 *   re-arms via a higher revision.
 * - ACTIVE severity-"warning" records use the amber palette (matching the
 *   config-stale banner) with no buttons — they represent in-flight retry
 *   incidents that settle at the turn boundary; on advertising connections
 *   codex routes what used to be the `turn_retrying` channel here.
 * - Of the RESOLVED records only the most recent recovered WARNING renders,
 *   as one muted "recovered" line — evidence of what happened mid-turn
 *   without stacking history under the composer. Resolved records still live
 *   in the reducer table as revision watermarks; resolved errors (settled by
 *   the user acting) render nothing.
 *
 * Adapter-authored `title`/`details` are shown verbatim (already user-facing
 * prose); a blank title falls back to the localized category label.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Gauge,
  KeyRound,
  LogIn,
  Plus,
  RefreshCw,
  ServerCrash,
  WifiOff,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SessionFailureRecord } from "@/lib/types"
import {
  activeSessionFailures,
  knownSessionFailureActions,
  resolvedSessionFailures,
  type SessionFailureAction,
} from "@/lib/session-failures"

const CATEGORY_ICONS: Record<string, typeof AlertCircle> = {
  connection: WifiOff,
  access: KeyRound,
  limit: Gauge,
  request: Ban,
  service: ServerCrash,
  unknown: AlertCircle,
}

const ACTION_ICONS: Record<SessionFailureAction, typeof RefreshCw> = {
  retry: RefreshCw,
  login: LogIn,
  new_session: Plus,
}

/** i18n key per action (the wire vocabulary is snake_case). */
const ACTION_LABEL_KEYS = {
  retry: "action.retry",
  login: "action.login",
  new_session: "action.newSession",
} as const

/** i18n label key per rendered category (title fallback). */
const CATEGORY_LABEL_KEYS = {
  connection: "category.connection",
  access: "category.access",
  limit: "category.limit",
  request: "category.request",
  service: "category.service",
  unknown: "category.unknown",
} as const

type KnownCategory = keyof typeof CATEGORY_LABEL_KEYS

/** Fold an arbitrary wire category onto the rendered vocabulary. */
function knownCategory(category: string): KnownCategory {
  return category in CATEGORY_LABEL_KEYS
    ? (category as KnownCategory)
    : "unknown"
}

interface Props {
  failures: SessionFailureRecord[]
  /** Wires the suggested actions; when omitted the buttons are hidden (e.g.
   *  viewers, who don't own the session). */
  onAction?: (
    action: SessionFailureAction,
    failure: SessionFailureRecord
  ) => void
}

export function SessionFailureBanner({ failures, onAction }: Props) {
  const active = activeSessionFailures(failures)
  const recoveredWarnings = resolvedSessionFailures(failures).filter(
    (f) => f.severity === "warning"
  )
  const recovered = recoveredWarnings[recoveredWarnings.length - 1]
  if (active.length === 0 && !recovered) return null
  return (
    <>
      {active.map((failure) => (
        <ActiveFailureStrip
          key={failure.id}
          failure={failure}
          onAction={onAction}
        />
      ))}
      {active.length === 0 && recovered && (
        <RecoveredStrip failure={recovered} />
      )}
    </>
  )
}

function ActiveFailureStrip({
  failure,
  onAction,
}: {
  failure: SessionFailureRecord
  onAction?: Props["onAction"]
}) {
  const t = useTranslations("Folder.chat.sessionFailure")
  const [expanded, setExpanded] = useState(false)
  const warning = failure.severity === "warning"
  const category = knownCategory(failure.category)
  const Icon = CATEGORY_ICONS[category]
  const title = failure.title.trim() || t(CATEGORY_LABEL_KEYS[category])
  const details = failure.details?.trim() || null
  // Warnings are in-flight retry incidents the adapter is already handling —
  // offering `retry` there would enqueue a second prompt mid-recovery, so
  // buttons render for terminal (non-warning) records only.
  const actions =
    onAction && !warning ? knownSessionFailureActions(failure) : []
  const DetailsChevron = expanded ? ChevronDown : ChevronRight
  return (
    <div
      role="alert"
      className={cn(
        "border-t px-4 py-2 text-xs",
        warning
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "border-destructive/20 bg-destructive/5 text-destructive"
      )}
    >
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span
          className="min-w-0 flex-1 truncate font-medium"
          title={details ?? title}
        >
          {title}
        </span>
        {actions.map((action) => {
          const ActionIcon = ACTION_ICONS[action]
          return (
            <Button
              key={action}
              size="sm"
              variant="outline"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={() => onAction?.(action, failure)}
            >
              <ActionIcon aria-hidden="true" className="me-1 h-3 w-3" />
              {t(ACTION_LABEL_KEYS[action])}
            </Button>
          )
        })}
        {details && (
          <button
            type="button"
            aria-label={t("toggleDetails")}
            aria-expanded={expanded}
            className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
            onClick={() => setExpanded((v) => !v)}
          >
            <DetailsChevron aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {expanded && details && (
        <p className="mt-1.5 ps-[22px] text-[11px] whitespace-pre-wrap break-words opacity-80">
          {details}
        </p>
      )}
    </div>
  )
}

function RecoveredStrip({ failure }: { failure: SessionFailureRecord }) {
  const t = useTranslations("Folder.chat.sessionFailure")
  const title =
    failure.title.trim() ||
    t(CATEGORY_LABEL_KEYS[knownCategory(failure.category)])
  return (
    <div className="border-t border-border/50 bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-2">
        <CheckCircle2 aria-hidden="true" className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate">
          {t("recovered")} · {title}
        </span>
      </div>
    </div>
  )
}
