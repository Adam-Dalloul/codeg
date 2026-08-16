"use client"

import type { UIMessage } from "ai"
import type { ComponentProps, HTMLAttributes, ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
} from "streamdown"
import { markdownLinkComponents } from "./markdown-link"
import { rehypePluginsAllowingCodeg } from "./rehype-allow-codeg"
import { remarkTrimCjkAutolinkTail } from "./remark-cjk-autolink-tail"
import { remarkRewriteFileUriLinks } from "./remark-file-uri-links"
import { useStreamdownPlugins } from "./streamdown-plugins"

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"]
}

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex flex-col gap-2",
      from === "user"
        ? // Outer user capsule hugs its content (`w-fit`) instead of always
          // reserving the full `max-w-[88%]` box — the inner bubble
          // (`MessageContent`) is already `w-fit`, so this just drops the
          // phantom full-width wrapper. Assistant keeps `w-full`.
          "is-user ml-auto justify-end w-fit max-w-[88%]"
        : "is-assistant w-full",
      className
    )}
    {...props}
  />
)

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex min-w-0 flex-col gap-2 overflow-hidden text-sm",
      // `ws-msg-secondary` pairs with the user bubble's `bg-secondary`: with
      // a workspace background image on it turns the bubble translucent + frosted
      // with a hairline ring (fixed `--ws-msg-alpha` + backdrop blur — see
      // globals.css, scoped to `.is-user`) so it stays legible over a busy
      // background. Off / assistant messages: inert (no base rule, no `.is-user`
      // ancestor).
      "group-[.is-user]:ml-auto group-[.is-user]:w-fit group-[.is-user]:max-w-full group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground ws-msg-secondary",
      "group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
)

export type MessageActionsProps = ComponentProps<"div">

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
)

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string
  label?: string
}

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  )

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return button
}

interface MessageBranchContextType {
  currentBranch: number
  totalBranches: number
  goToPrevious: () => void
  goToNext: () => void
  branches: ReactElement[]
  setBranches: (branches: ReactElement[]) => void
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
)

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext)

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch"
    )
  }

  return context
}

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number
  onBranchChange?: (branchIndex: number) => void
}

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch)
  const [branches, setBranches] = useState<ReactElement[]>([])

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch)
      onBranchChange?.(newBranch)
    },
    [onBranchChange]
  )

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1
    handleBranchChange(newBranch)
  }, [currentBranch, branches.length, handleBranchChange])

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0
    handleBranchChange(newBranch)
  }, [currentBranch, branches.length, handleBranchChange])

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious]
  )

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  )
}

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch()
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children]
  )

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray)
    }
  }, [childrenArray, branches, setBranches])

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ))
}

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>

export const MessageBranchSelector = ({
  className,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch()

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className
      )}
      orientation="horizontal"
      {...props}
    />
  )
}

export type MessageBranchPreviousProps = ComponentProps<typeof Button>

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const t = useTranslations("Folder.chat.messageBranch")
  const { goToPrevious, totalBranches } = useMessageBranch()

  return (
    <Button
      aria-label={t("previousBranchAria")}
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  )
}

export type MessageBranchNextProps = ComponentProps<typeof Button>

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const t = useTranslations("Folder.chat.messageBranch")
  const { goToNext, totalBranches } = useMessageBranch()

  return (
    <Button
      aria-label={t("nextBranchAria")}
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  )
}

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const t = useTranslations("Folder.chat.messageBranch")
  const { currentBranch, totalBranches } = useMessageBranch()

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className
      )}
      {...props}
    >
      {t("pageOf", { current: currentBranch + 1, total: totalBranches })}
    </ButtonGroupText>
  )
}

// MessageResponse renders ASSISTANT / agent Markdown. User messages no longer
// use it — they render as plain text + reference badges via PlainTextWithBadges
// (see message/plain-text-with-badges.tsx) — so the former user-only `softBreaks`
// / `/slash`-badging hooks were removed.
export type MessageResponseProps = ComponentProps<typeof Streamdown>

// remark-math uses dollar delimiters. `\[...\]` / `\(...\)` are rewritten
// to `$$...$$`. Single-dollar `$...$` is disabled (`singleDollarTextMath:
// false`) so currency (`$9.99`) and shell vars (`$HOME`, `$1`) stay prose.
// A single-line `$$x$$` inside a paragraph stays *inline* math (mdast tags
// it `math-inline`); `$$` at column 0 of a line is a math FLOW fence.
// Multi-line `\(...\)` that would land `$$` at a fence position is padded
// on the opener. A prefix-only closer line is moved after `$$` (ZWSP on
// the closer either fences or lands inside the formula). Code / inline
// code is masked so delimiters inside them stay literal. CR / CRLF is
// folded to LF first so offset math matches what remark-parse sees on
// Windows files.
export function normalizeMathDelimiters(text: string): string {
  const canonical = text.replace(/\r\n|\r/g, "\n")
  const saved: string[] = []
  const placeholder = (m: string) => {
    saved.push(m)
    return `\0CBLK${saved.length - 1}\0`
  }
  const masked = canonical.replace(
    /`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]+`/g,
    placeholder
  )
  const normalized = masked
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner: string) => `$$${inner}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner: string, offset: number) => {
      // Keep inner newlines (TeX `%` comments, `> \(a\n> b\)`). Only peel
      // trailing newlines off the formula so the closer is not alone on a
      // line (`\(a\nb\n\)` would otherwise become a display fence).
      const trimmed = inner.replace(/\n+$/, "")
      const after = inner.slice(trimmed.length)
      if (!trimmed.includes("\n")) {
        return `$$${trimmed}$$${after}`
      }
      // A closer `$$` on a container continuation (`\n> `, `\n  `) is
      // itself a flow fence. ZWSP before that closer lands *inside* the
      // formula; ZWSP after it still fences. Move a prefix-only last
      // line to after the closer instead.
      const { body, prefixTail } = peelPrefixOnlyLastLine(trimmed)
      // A leading space is not enough — math flow fences allow the same
      // 0-3 spaces as ATX headings. A ZWSP keeps `$$` off column 0
      // without becoming a visible character or indented code.
      //
      // ZWSP is a real character every later matcher sees. Emphasis in
      // the padded shapes is fine. A rare link-reference pair can stop
      // matching if only one of the label / definition is padded.
      const open = wouldStartMathFlowFence(masked, offset) ? MATH_FENCE_PAD : ""
      return `${open}$$${body}$$${prefixTail}${after}`
    })
  return normalized.replace(
    /\0CBLK(\d+)\0/g,
    (_m, i: string) => saved[Number(i)]
  )
}

const MATH_FENCE_PAD = "\u200b"

/** True when a `$$` emitted at `offset` would open a math flow fence. */
function wouldStartMathFlowFence(source: string, offset: number): boolean {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1
  return scanContainerPrefix(source, lineStart, offset)
}

/** Split a prefix-only last line (`> `, list indent) off so `$$` is not there. */
function peelPrefixOnlyLastLine(inner: string): {
  body: string
  prefixTail: string
} {
  const nl = inner.lastIndexOf("\n")
  if (nl < 0) return { body: inner, prefixTail: "" }
  const lastLine = inner.slice(nl + 1)
  if (
    lastLine.length > 0 &&
    scanContainerPrefix(lastLine, 0, lastLine.length)
  ) {
    return { body: inner.slice(0, nl), prefixTail: inner.slice(nl) }
  }
  return { body: inner, prefixTail: "" }
}

/**
 * Linear CommonMark-ish prefix walk. Consumes blockquote markers, list
 * markers (`*`, `-`, `+`, ordered), their following spaces, and 0-3
 * spaces of indent / list-continuation. No backtracking.
 */
function scanContainerPrefix(
  source: string,
  start: number,
  end: number
): boolean {
  let i = start
  while (true) {
    let indent = 0
    while (
      i < end &&
      indent < 3 &&
      (source.charCodeAt(i) === 32 || source.charCodeAt(i) === 9)
    ) {
      indent += 1
      i += 1
    }
    if (i >= end) return true

    const ch = source.charCodeAt(i)
    if (ch === 62 /* > */) {
      i += 1
      while (
        i < end &&
        (source.charCodeAt(i) === 32 || source.charCodeAt(i) === 9)
      ) {
        i += 1
      }
      continue
    }

    if (ch === 42 /* * */ || ch === 45 /* - */ || ch === 43 /* + */) {
      i += 1
      if (
        i < end &&
        (source.charCodeAt(i) === 32 || source.charCodeAt(i) === 9)
      ) {
        while (
          i < end &&
          (source.charCodeAt(i) === 32 || source.charCodeAt(i) === 9)
        ) {
          i += 1
        }
        continue
      }
      return false
    }

    if (ch >= 48 && ch <= 57) {
      let digits = 0
      while (
        i < end &&
        digits < 9 &&
        source.charCodeAt(i) >= 48 &&
        source.charCodeAt(i) <= 57
      ) {
        digits += 1
        i += 1
      }
      const marker = i < end ? source.charCodeAt(i) : 0
      if (digits > 0 && (marker === 46 /* . */ || marker === 41) /* ) */) {
        i += 1
        if (
          i < end &&
          (source.charCodeAt(i) === 32 || source.charCodeAt(i) === 9)
        ) {
          while (
            i < end &&
            (source.charCodeAt(i) === 32 || source.charCodeAt(i) === 9)
          ) {
            i += 1
          }
          continue
        }
      }
      return false
    }

    return false
  }
}

const remarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  remarkRewriteFileUriLinks,
  remarkTrimCjkAutolinkTail,
]

// Streamdown's default rehype pipeline strips `codeg://` reference hrefs in
// sanitization (rendering them as "[blocked]"); re-derive it so they survive to
// MarkdownLink → ReferenceBadge. See rehype-allow-codeg for the full rationale.
const rehypePlugins = rehypePluginsAllowingCodeg(defaultRehypePlugins)

function MessageResponseImpl({
  className,
  children,
  ...props
}: MessageResponseProps) {
  const normalized = useMemo(
    () =>
      typeof children === "string"
        ? normalizeMathDelimiters(children)
        : children,
    [children]
  )
  const plugins = useStreamdownPlugins(
    typeof normalized === "string" ? normalized : undefined
  )

  return (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-3 [&_ol]:pl-3",
        className
      )}
      plugins={plugins}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      {...props}
      // Merge after spreading props so a caller can still override other
      // elements, but the link icon + safety routing on `a` always wins.
      components={{ ...props.components, ...markdownLinkComponents }}
    >
      {normalized}
    </Streamdown>
  )
}

export const MessageResponse = memo(
  MessageResponseImpl,
  (prevProps, nextProps) => prevProps.children === nextProps.children
)

MessageResponse.displayName = "MessageResponse"

export type MessageToolbarProps = ComponentProps<"div">

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
)
