"use client"

import { useTranslations } from "next-intl"
import { UserRound } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AgentAccount } from "@/lib/agent-accounts"

export function AgentAccountSelector({
  accounts,
  value,
  onChange,
  disabled = false,
  persisted = false,
}: {
  accounts: AgentAccount[]
  value: string | null
  onChange: (value: string | null) => void
  disabled?: boolean
  persisted?: boolean
}) {
  const t = useTranslations("AgentAccounts")
  const available = accounts.filter((account) => !account.removed)
  if (!value && available.length === 0) return null
  const selected = accounts.find((a) => a.id === value)
  if (persisted) {
    if (!value) return null
    return (
      <span
        className="inline-flex max-w-full items-center gap-1.5 text-xs text-muted-foreground"
        title={selected?.name ?? t("unavailable")}
      >
        <UserRound className="size-3.5 shrink-0" />
        <span className="truncate">
          {selected?.name ?? t("unavailable")}
          {selected?.removed ? ` (${t("unavailable")})` : ""}
        </span>
      </span>
    )
  }
  return (
    <Select
      value={value ?? "default"}
      onValueChange={(id) => onChange(id === "default" ? null : id)}
      disabled={disabled}
    >
      <SelectTrigger
        className="h-8 w-auto min-w-28 max-w-full"
        aria-label={t("account")}
      >
        <UserRound className="size-3.5 shrink-0" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">{t("default")}</SelectItem>
        {value && (!selected || selected.removed) && (
          <SelectItem value={value} disabled>
            {t("unavailable")}
          </SelectItem>
        )}
        {available.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {account.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
