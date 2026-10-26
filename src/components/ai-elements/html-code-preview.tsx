"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { buildChatHtmlDocument } from "@/lib/chat-html-document"
import {
  HTML_PREVIEW_SIZE_MESSAGE_TYPE,
  readHtmlPreviewTheme,
} from "@/lib/html-preview-frame"

export function HtmlCodePending() {
  const t = useTranslations("HtmlCodePreview")
  return (
    <div
      role="status"
      className="my-2 rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground"
    >
      {t("generating")}
    </div>
  )
}

export function HtmlCodePreview({
  source,
  children,
}: {
  source: string
  children: ReactNode
}) {
  const t = useTranslations("HtmlCodePreview")
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  const [preview, setPreview] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const key = `${source}\0${dark}`
  const [loaded, setLoaded] = useState<{
    key: string
    doc: string | null
  } | null>(null)
  const [measured, setMeasured] = useState<{
    key: string
    height: number
  } | null>(null)

  useEffect(() => {
    let active = true
    buildChatHtmlDocument(source, {
      nonce: crypto.randomUUID(),
      dark,
      theme: readHtmlPreviewTheme(),
    }).then(
      (doc) => {
        if (active) setLoaded({ key, doc })
      },
      () => {
        if (active) setLoaded({ key, doc: null })
      }
    )
    return () => {
      active = false
    }
  }, [source, dark, key])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow)
        return
      const data = event.data as { type?: unknown; height?: unknown } | null
      if (
        !data ||
        data.type !== HTML_PREVIEW_SIZE_MESSAGE_TYPE ||
        typeof data.height !== "number" ||
        !Number.isFinite(data.height)
      )
        return
      const height = Math.min(12000, Math.max(96, Math.ceil(data.height)))
      setMeasured((prev) =>
        prev?.key === key && prev.height === height ? prev : { key, height }
      )
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [key])

  const current = loaded?.key === key ? loaded : null
  const height = measured?.key === key ? measured.height : 160
  const overflows = height > 640

  return (
    <section
      className="not-prose group/html relative my-2 min-w-0"
      dir="ltr"
      data-chat-html
    >
      <div className="absolute end-1 top-1 z-10 flex items-center gap-1 rounded-lg border bg-background/90 px-1 py-0.5 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover/html:opacity-100 group-focus-within/html:opacity-100 max-sm:opacity-100">
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
      {preview && current?.doc ? (
        <iframe
          ref={frameRef}
          title={t("title")}
          className="block w-full border-0 bg-transparent transition-[height] duration-150"
          style={{ height: expanded || !overflows ? height : 640 }}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={current.doc}
        />
      ) : preview && current === null ? (
        <HtmlCodePending />
      ) : (
        children
      )}
      {preview && current?.doc && overflows ? (
        <button
          type="button"
          className="w-full py-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("collapse") : t("expand")}
        </button>
      ) : null}
    </section>
  )
}
