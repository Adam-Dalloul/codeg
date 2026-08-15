"use client"

import { useTranslations } from "next-intl"
import { ExternalLink } from "lucide-react"
import { inventory } from "@/lib/subscription-quota"
import { openUrl } from "@/lib/platform"

export function SubscriptionQuotaPanel() {
  const t = useTranslations("TokenUsage")
  const rows = inventory()

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="text-[0.8125rem] font-semibold">{t("quotaTitle")}</h2>
      <p className="mt-1 text-[0.75rem] text-muted-foreground">
        {t("quotaHint")}
      </p>
      <ul className="mt-3 space-y-1.5">
        {rows.map((row) => (
          <li
            key={row.family}
            className="flex items-center justify-between gap-3 text-[0.75rem]"
          >
            <span className="capitalize">{row.family}</span>
            {row.kind === "remaining-subscription" ? (
              <span>
                {t("quotaRemaining", {
                  remaining: row.remaining,
                  limit: row.limit,
                })}
              </span>
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
          </li>
        ))}
      </ul>
    </section>
  )
}
