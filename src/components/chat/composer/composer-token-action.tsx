"use client"

import { ExternalLink, FileText, Mail } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  parseLocalFileTarget,
  useOpenLinkOrFile,
} from "@/components/ai-elements/link-safety"
import { ContextMenuItem } from "@/components/ui/context-menu"
import type { TextToken } from "@/lib/text-token-at"

/**
 * Where a right-clicked token's "open" action would go, or null when it has
 * nowhere: a plain word, or a path the shared opener cannot resolve on its own
 * (a bare `src/x.ts` needs a folder to sit in — that resolution belongs to the
 * transcript's file badge, not to a half-typed draft).
 *
 * Exported so the menu can decide whether the row exists at all before mounting
 * anything for it.
 */
export function composerTokenOpenTarget(
  token: TextToken | null
): string | null {
  if (!token) return null
  if (token.kind === "path") {
    return parseLocalFileTarget(token.value) ? token.value : null
  }
  return token.href ?? null
}

/**
 * The one row a right-clicked token adds above the composer's ordinary editing
 * items: open a link, write to an address, open a local file.
 *
 * It routes through the same opener the transcript's links use, so the protocol
 * allow-list, the desktop/web/remote routing and the failure toasts are the
 * ones already in place — nothing here opens anything by itself. Cut, Copy and
 * the rest still apply to the token, which the right click has already
 * selected.
 */
export function ComposerTokenAction({ token }: { token: TextToken }) {
  const t = useTranslations("Folder.chat.messageInput")
  const openTarget = useOpenLinkOrFile()
  const target = composerTokenOpenTarget(token)
  if (!target) return null

  const { icon: Icon, label } =
    token.kind === "email"
      ? { icon: Mail, label: t("sendEmail") }
      : token.kind === "path"
        ? { icon: FileText, label: t("openFile") }
        : { icon: ExternalLink, label: t("openLink") }

  return (
    <ContextMenuItem onSelect={() => void openTarget(target)}>
      <Icon className="size-4" />
      {label}
    </ContextMenuItem>
  )
}
