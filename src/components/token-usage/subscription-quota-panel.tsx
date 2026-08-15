"use client"

import { useEffect, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { ExternalLink } from "lucide-react"
import { subscriptionQuotaCodex } from "@/lib/api"
import { inventory, type IsolatableFamily } from "@/lib/subscription-quota"
import { openUrl } from "@/lib/platform"

export function SubscriptionQuotaPanel() {
  const t = useTranslations("TokenUsage")
  const locale = useLocale()
  const [official, setOfficial] = useState<
    Partial<Record<IsolatableFamily, unknown>>
  >({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void subscriptionQuotaCodex()
      .then((read) => {
        if (cancelled) return
        if (read.payload) {
          setOfficial({ codex: read.payload })
        }
      })
      .catch(() => {
        // Missing CLI or a dead app-server is "unavailable", not a toast.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const rows = inventory(official)

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="text-[0.8125rem] font-semibold">{t("quotaTitle")}</h2>
      <p className="mt-1 text-[0.75rem] text-muted-foreground">
        {t("quotaHint")}
      </p>
      <ul className="mt-3 space-y-1.5">
        {rows.map((row) => (
          <li key={row.family} className="text-[0.75rem]">
            <div className="flex items-center justify-between gap-3">
              <span className="capitalize">{row.family}</span>
              {row.kind === "remaining-subscription" ? (
                <span className="text-right">
                  {t("quotaRemaining", {
                    remaining: Math.round(row.remaining),
                    limit: row.limit,
                  })}
                </span>
              ) : row.family === "codex" && !loaded ? (
                <span className="text-muted-foreground">{t("quotaLoading")}</span>
              ) : (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    if (row.kind === "unavailable") {
                      void openUrl(row.providerUsageUrl)
                    }
                  }}
                >
                  {t("quotaProviderLink")}
                  <ExternalLink className="size-3" />
                </button>
              )}
            </div>
            {row.kind === "remaining-subscription" && row.resetsAt ? (
              <div className="mt-0.5 text-right text-[0.6875rem] text-muted-foreground">
                {t("quotaResets", {
                  when: new Date(row.resetsAt * 1000).toLocaleString(locale, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  }),
                })}
              </div>
            ) : null}
            {row.kind === "remaining-subscription"
              ? row.extras?.map((extra) => (
                  <div
                    key={extra.label ?? extra.usedPercent}
                    className="mt-0.5 text-right text-[0.6875rem] text-muted-foreground"
                  >
                    {t("quotaExtraRemaining", {
                      name: extra.label ?? row.family,
                      remaining: Math.round(extra.remaining),
                    })}
                  </div>
                ))
              : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
