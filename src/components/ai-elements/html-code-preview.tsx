"use client"

import { useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { withSandboxCsp } from "@/lib/html-preview-inline"

export function HtmlCodePreview({
  source,
  children,
}: {
  source: string
  children: ReactNode
}) {
  const t = useTranslations("HtmlCodePreview")
  const [preview, setPreview] = useState(false)
  const document = useMemo(
    () => (preview ? withSandboxCsp(source, { trusted: true }) : ""),
    [preview, source]
  )

  return (
    <div className="my-4 min-w-0 overflow-hidden rounded-lg border" dir="ltr">
      <div className="flex items-center gap-1 border-b bg-muted/50 px-2 py-1">
        <span className="me-auto px-2 text-xs text-muted-foreground">HTML</span>
        <Button
          size="sm"
          variant={preview ? "ghost" : "secondary"}
          aria-pressed={!preview}
          onClick={() => setPreview(false)}
        >
          {t("code")}
        </Button>
        <Button
          size="sm"
          variant={preview ? "secondary" : "ghost"}
          aria-pressed={preview}
          onClick={() => setPreview(true)}
        >
          {t("preview")}
        </Button>
      </div>
      {preview ? (
        <iframe
          title={t("title")}
          className="block h-96 w-full resize-y bg-white"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={document}
        />
      ) : (
        children
      )}
    </div>
  )
}
