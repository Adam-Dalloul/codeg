"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CircleCheck,
  CircleDot,
  CircleMinus,
  CirclePlay,
  CircleX,
  ExternalLink,
  GitPullRequestClosed,
  Link2,
  ListTodo,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Send,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"
import { MessageResponse } from "@/components/ai-elements/message"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import {
  CHIP_FILL,
  ForgeLabelChip,
  ROW_ACTION,
  ROW_ACTION_GLYPH,
  stateGlyph,
} from "@/components/forge/forge-issue-row"
import { statusLabelKey } from "@/components/tasks/task-card"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { BrowserLink } from "@/components/ui/browser-link"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  SIDE_PANEL_CONTENT_CLASS,
} from "@/components/ui/drawer"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import {
  forgeChangeDetail,
  forgeChangeFiles,
  forgeCreateComment,
  forgeListComments,
  forgeSetItemState,
} from "@/lib/api"
import {
  type AppErrorTranslator,
  toLocalizedErrorMessage,
} from "@/lib/app-error"
import { mergeForgeRowUpdate } from "@/lib/forge-row-update"
import { chipStateForLink } from "@/lib/forge-task-chip"
import { cn } from "@/lib/utils"
import type {
  ForgeChangeDetail,
  ForgeChangedFile,
  ForgeCheck,
  ForgeCheckState,
  ForgeComment,
  ForgeIssueRow,
  ForgeStateAction,
  ForgeTaskLink,
} from "@/lib/types"

/**
 * Typography for the item's Markdown body at the panel's scale.
 *
 * Streamdown sizes its own elements for the full-width chat column — `h1` at
 * `text-3xl`, 24px above every heading — which in a 32rem panel turns a
 * three-heading issue into a page of titles. A descendant selector outranks the
 * class Streamdown puts on the element itself, so these win without
 * `!important`. Lists and the first/last block's collapsed margin already come
 * from `MessageResponse`; `prose` is deliberately absent, as the repo has no
 * typography plugin and those classes would generate nothing.
 *
 * Deliberately NOT the task sheet's `RESULT_MARKDOWN`, which is tuned a notch
 * smaller: there the Markdown is a summary sitting among other sections, here it
 * is the whole reason the panel opened and has to stay comfortable to read at
 * length. Images are capped because an issue body is full of screenshots and
 * the forge writes them at their natural width.
 */
const BODY_MARKDOWN =
  "[&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-[0.8125rem] [&_h4]:text-[0.8125rem] " +
  "[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold " +
  "[&_h1]:mt-4 [&_h2]:mt-4 [&_h3]:mt-3 [&_h4]:mt-3 " +
  "[&_h1]:mb-1.5 [&_h2]:mb-1.5 [&_h3]:mb-1 [&_h4]:mb-1 " +
  "[&_p]:mt-0 [&_p]:mb-2.5 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 " +
  "[&_blockquote]:my-2.5 [&_hr]:my-4 [&_table]:my-2.5 " +
  "[&_img]:max-w-full [&_img]:rounded-lg"

/** Render-time "now", as on the row: the panel re-renders with its list. */
function relative(iso: string): string {
  return formatRelative(iso, Date.now())
}

/**
 * Append a page, skipping anything already held.
 *
 * Offset pagination over a live collection: someone commenting between two
 * page requests shifts every later comment down one, which serves the last of
 * page 1 again at the top of page 2. Without this the thread would show it
 * twice — and React would warn about the duplicate key on the way.
 */
function appendUnseen(
  held: ForgeComment[],
  incoming: ForgeComment[]
): ForgeComment[] {
  const seen = new Set(held.map((c) => c.id))
  return [...held, ...incoming.filter((c) => !seen.has(c.id))]
}

/**
 * The full date behind a relative one. The list says "3 days ago" because that
 * is what a triage scan wants; the panel is where someone asks "three days from
 * WHEN", and a title attribute answers it without spending a line.
 */
function absolute(iso: string): string | undefined {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? undefined : at.toLocaleString()
}

/**
 * The item's discussion, under its description.
 *
 * One request per item, fired when the panel opens on it. That is the whole
 * reason this is not part of the list payload: a list page holds thirty items
 * and its reader opens at most one, so thirty thread fetches would be
 * twenty-nine wasted. It is asked for unconditionally rather than gated on the
 * row's `comments` count — the row is a snapshot, and a count of zero taken
 * five minutes ago is not evidence that nobody has replied since.
 *
 * Everything here is scoped to ONE item by the caller's `key`, so the state
 * below needs no reset logic of its own.
 */
function CommentThread({
  folderId,
  kind,
  number,
  onPosted,
}: {
  folderId: number
  kind: "issue" | "pr"
  number: number
  /** A comment landed on the forge, and here it is. The caller bumps the
   *  item's count so the header stops trailing the thread underneath it. */
  onPosted: (comment: ForgeComment) => void
}) {
  const t = useTranslations("Forge")
  // Root-scoped, like the page's: a forge failure carries a FULL dotted i18n
  // key (`Forge.errors.noAccount`) that the namespaced translator above cannot
  // resolve.
  const tRoot = useTranslations()
  /** The pages the FORGE has served, in the order it served them. */
  const [fetched, setFetched] = useState<ForgeComment[]>([])
  /**
   * Comments posted from the box below, kept out of `fetched` on purpose.
   *
   * Two things go wrong if a posted comment is appended into the paged
   * collection instead. It is the NEWEST comment, so with pages 1–20 loaded it
   * would sit at position 21 and the next "load more" would file comments
   * 21–30 after it — a thread that reads 1…20, 31, 21…30. And a page-1 load
   * still in flight when it was posted REPLACES that collection wholesale,
   * which would make a comment somebody just published vanish from the panel.
   *
   * Held separately it is always rendered last (which is where the newest
   * comment belongs) and always survives a reload — and it disappears from
   * here the moment the page it really lives on arrives, because the render
   * below drops anything `fetched` already holds.
   */
  const [posted, setPosted] = useState<ForgeComment[]>([])
  /** The page "load more" asks for — one past the last one that landed. */
  const [nextPage, setNextPage] = useState(1)
  const [hasNext, setHasNext] = useState(false)
  const [loading, setLoading] = useState(true)
  /** The rejection, with the PAGE that produced it. The page is what "Try
   *  again" re-asks for, and it has to be remembered rather than derived: a
   *  failed refresh and a failed "load more" are both failures, and `nextPage`
   *  describes only the second of them — retrying a refresh through it would
   *  ask for the page AFTER the one on screen and append it to the stale data
   *  the refresh was there to replace.
   *
   *  Boxed so "no failure" stays distinguishable from a falsy one, and the
   *  error kept RAW to be localized at render: a translator is not a stable
   *  value to hang a fetch on — as an effect dependency it would re-fire this
   *  request on every render that produced a new one. */
  const [failure, setFailure] = useState<{
    error: unknown
    page: number
  } | null>(null)
  /** Generation guard. Three things fire a load — the mount, "load more" and
   *  the refresh button — and a refresh sent while a "load more" is still in
   *  the air must not have its wholesale replacement undone by the append that
   *  lands after it. */
  const reqRef = useRef(0)

  const load = useCallback(
    async (page: number) => {
      const id = ++reqRef.current
      setLoading(true)
      setFailure(null)
      try {
        const list = await forgeListComments(folderId, { kind, number, page })
        if (id !== reqRef.current) return
        // Page 1 REPLACES: it is both the first load and what the refresh
        // button asks for, and a refresh that appended would double the thread.
        setFetched((held) =>
          page === 1 ? list.comments : appendUnseen(held, list.comments)
        )
        setHasNext(list.has_next)
        setNextPage(list.page + 1)
      } catch (error) {
        if (id !== reqRef.current) return
        // The pages already on screen stay: a failed "load more" costs the rest
        // of the thread, not the part that was being read.
        setFailure({ error, page })
      } finally {
        if (id === reqRef.current) setLoading(false)
      }
    },
    // Primitives only, so this identity — and the effect below that depends on
    // it — changes exactly when the ITEM does.
    [folderId, kind, number]
  )

  useEffect(() => {
    void load(1)
  }, [load])

  /** What the thread shows: the forge's pages, then anything posted here that
   *  has not turned up in them yet. `appendUnseen` is what retires a posted
   *  comment once its real page arrives, rather than showing it twice. */
  const comments = useMemo(
    () => appendUnseen(fetched, posted),
    [fetched, posted]
  )

  // First load: a skeleton stands in for the thread rather than an empty
  // section that would read as "no comments" for as long as the request takes.
  const firstLoad = loading && comments.length === 0 && failure == null
  const empty = !loading && failure == null && !hasNext && comments.length === 0

  return (
    <section className="flex flex-col gap-3 border-t border-border px-5 py-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
          {t("comments")}
        </h3>
        {/* Back to page 1 wholesale, not "fetch what is new": the thread is
            offset-paginated, so there is no cursor to resume from — and an
            edited or deleted comment is a change no append could show. */}
        <button
          type="button"
          onClick={() => void load(1)}
          disabled={loading}
          title={t("commentsRefresh")}
          aria-label={t("commentsRefresh")}
          className="ms-auto inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {firstLoad ? (
        <CommentSkeleton />
      ) : comments.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {comments.map((comment) => (
            <li key={comment.id}>
              <CommentCard comment={comment} />
            </li>
          ))}
        </ol>
      ) : null}

      {empty ? (
        <p className="py-2 text-center text-xs text-muted-foreground">
          {t("commentsEmpty")}
        </p>
      ) : null}

      {failure != null ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2">
          {/* A rejected `invoke()` hands back the SERIALIZED AppCommandError —
              a plain object whose `toString` is "[object Object]". app-error
              unwraps it and prefers the backend's own i18n key. */}
          <p className="text-xs text-destructive">
            {toLocalizedErrorMessage(
              failure.error,
              tRoot as unknown as AppErrorTranslator
            )}
          </p>
          {/* The page that FAILED, whichever kind of load asked for it. */}
          <button
            type="button"
            onClick={() => void load(failure.page)}
            className="text-[0.6875rem] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("commentsRetry")}
          </button>
        </div>
      ) : null}

      {/* Offered whenever the FORGE says there is more, even with nothing on
          screen: GitLab drops its system events after paginating, so a page of
          nothing but "changed the milestone" arrives empty with the real
          discussion still behind it. */}
      {hasNext && failure == null ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void load(nextPage)}
          className="h-7 self-center rounded-full px-3 text-[0.6875rem] font-medium text-muted-foreground"
        >
          {loading ? t("commentsLoading") : t("commentsMore")}
        </Button>
      ) : null}

      <CommentComposer
        folderId={folderId}
        kind={kind}
        number={number}
        onPosted={(comment) => {
          // Into its own slot, not into the paged collection — see `posted`
          // for why that ordering and that race both matter. Nothing is
          // re-fetched: the comment is already in hand, and a re-read would
          // start at page 1 and throw away everything "load more" has loaded.
          setPosted((held) => appendUnseen(held, [comment]))
          onPosted(comment)
        }}
      />
    </section>
  )
}

/**
 * The box a comment is written in.
 *
 * Its own component so the thread's fetch state and the draft's submit state
 * cannot be mistaken for one another: a "load more" in flight must not disable
 * the box someone is typing in, and a post in flight must not make the thread
 * above it look like it is reloading.
 *
 * There is deliberately no optimistic insert. A comment is published where
 * other people read it, and the row the thread appends is the one the FORGE
 * stored — it carries the id the list keys and de-duplicates by, the author as
 * the token resolved it, and the permalink. Showing the draft first and
 * reconciling later would put a comment on screen that does not exist yet, in
 * the one place where "it looked like it worked" is worst.
 */
function CommentComposer({
  folderId,
  kind,
  number,
  onPosted,
}: {
  folderId: number
  kind: "issue" | "pr"
  number: number
  onPosted: (comment: ForgeComment) => void
}) {
  const t = useTranslations("Forge")
  const tRoot = useTranslations()
  const [body, setBody] = useState("")
  const [posting, setPosting] = useState(false)
  const [failure, setFailure] = useState<{ error: unknown } | null>(null)
  const trimmed = body.trim()

  const submit = useCallback(async () => {
    // Guarded here as well as by the disabled button: Ctrl+Enter reaches this
    // without going through the button at all.
    if (trimmed === "" || posting) return
    setPosting(true)
    setFailure(null)
    try {
      const comment = await forgeCreateComment(folderId, {
        kind,
        number,
        body: trimmed,
      })
      // Only now — a draft cleared before the answer would lose what somebody
      // wrote to a network failure they cannot retry from.
      setBody("")
      onPosted(comment)
    } catch (error) {
      setFailure({ error })
    } finally {
      setPosting(false)
    }
  }, [folderId, kind, number, onPosted, posting, trimmed])

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // The shortcut both forges use. Plain Enter stays a newline: a
          // comment is a paragraph, not a chat line.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault()
            void submit()
          }
        }}
        disabled={posting}
        placeholder={t("commentPlaceholder")}
        aria-label={t("commentPlaceholder")}
        className="min-h-20 rounded-xl text-[0.8125rem]"
      />
      {failure != null ? (
        <p className="text-xs text-destructive">
          {toLocalizedErrorMessage(
            failure.error,
            tRoot as unknown as AppErrorTranslator
          )}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        disabled={trimmed === "" || posting}
        onClick={() => void submit()}
        className={cn(ROW_ACTION, "self-end")}
      >
        <Send className={ROW_ACTION_GLYPH} aria-hidden />
        {posting ? t("commentSubmitting") : t("commentSubmit")}
      </Button>
    </div>
  )
}

/** The five check states, each with its own SHAPE as well as its own colour —
 *  a strip that separated "passing" from "failing" by hue alone says nothing
 *  at all to a colour-blind reader, and nothing to a screen reader either
 *  (hence the translated label that rides with every glyph). */
const CHECK_GLYPH: Record<
  ForgeCheckState,
  { Icon: LucideIcon; className: string; labelKey: CheckLabelKey }
> = {
  success: {
    Icon: CircleCheck,
    className: "text-emerald-600",
    labelKey: "checkSuccess",
  },
  failure: {
    Icon: CircleX,
    className: "text-rose-600",
    labelKey: "checkFailure",
  },
  running: {
    Icon: LoaderCircle,
    className: "animate-spin text-amber-500",
    labelKey: "checkRunning",
  },
  queued: {
    Icon: CircleDot,
    className: "text-muted-foreground",
    labelKey: "checkQueued",
  },
  neutral: {
    Icon: CircleMinus,
    className: "text-muted-foreground",
    labelKey: "checkNeutral",
  },
}

type CheckLabelKey =
  | "checkSuccess"
  | "checkFailure"
  | "checkRunning"
  | "checkQueued"
  | "checkNeutral"

/** How a file was touched, as one character in the forge's own colours. The
 *  letter is what survives at this size; the colour is the second signal, and
 *  the translated label under it is the third — a column of coloured letters
 *  says nothing to a screen reader. */
const FILE_STATUS: Record<
  ForgeChangedFile["status"],
  { mark: string; className: string; labelKey: FileStatusLabelKey }
> = {
  added: { mark: "A", className: "text-emerald-600", labelKey: "fileAdded" },
  removed: { mark: "D", className: "text-rose-600", labelKey: "fileRemoved" },
  renamed: { mark: "R", className: "text-sky-600", labelKey: "fileRenamed" },
  modified: {
    mark: "M",
    className: "text-amber-600",
    labelKey: "fileModified",
  },
}

type FileStatusLabelKey =
  | "fileAdded"
  | "fileRemoved"
  | "fileRenamed"
  | "fileModified"

/** One comment: who, when, and what they wrote, in the forge's own Markdown. */
function CommentCard({ comment }: { comment: ForgeComment }) {
  const t = useTranslations("Forge")
  const body = comment.body.trim()
  const author = comment.author
  return (
    <article className="flex gap-2.5">
      {/* Fallback in its own right, not a stand-in for a missing URL: GitLab
          hands out gravatar.com URLs for accounts that never uploaded a
          picture, and those can take a long time to fail on a network that
          cannot reach them. Radix swaps the image in only once it has loaded,
          so the initial is what shows until (and unless) it does. */}
      <Avatar size="sm" className="mt-0.5">
        {comment.author_avatar != null ? (
          <AvatarImage src={comment.author_avatar} alt="" />
        ) : null}
        <AvatarFallback className="text-[0.625rem] font-medium uppercase">
          {author?.slice(0, 1) ?? "?"}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border">
        <header className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-3 py-1.5 text-[0.6875rem]">
          <span className="min-w-0 truncate font-medium">
            {author ?? t("commentUnknownAuthor")}
          </span>
          {comment.created_at != null ? (
            <span
              className="shrink-0 text-muted-foreground"
              title={absolute(comment.created_at)}
            >
              {relative(comment.created_at)}
            </span>
          ) : null}
          {/* The backend only sends `updated_at` when it differs from
              `created_at` — both forges stamp one on creation, so its mere
              presence would mark every comment as edited. */}
          {comment.updated_at != null ? (
            <span
              className="shrink-0 text-muted-foreground"
              title={absolute(comment.updated_at)}
            >
              · {t("commentEdited")}
            </span>
          ) : null}
          {comment.html_url != null ? (
            <BrowserLink
              href={comment.html_url}
              title={t("commentPermalink")}
              aria-label={t("commentPermalink")}
              className="ms-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Link2 className="size-3" aria-hidden />
            </BrowserLink>
          ) : null}
        </header>
        {body ? (
          <div
            className={cn(
              "break-words px-3 py-2 text-[0.8125rem] leading-relaxed",
              BODY_MARKDOWN
            )}
          >
            <MessageResponse>{body}</MessageResponse>
          </div>
        ) : (
          <p className="px-3 py-2 text-xs italic text-muted-foreground">
            {t("commentEmptyBody")}
          </p>
        )}
      </div>
    </article>
  )
}

/** Placeholder for the first load — the shape of two comments, so the section
 *  does not jump when they arrive. */
function CommentSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      {[0, 1].map((i) => (
        <div key={i} className="flex gap-2.5">
          <Skeleton className="size-6 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * What a pull request / merge request actually is, above its discussion:
 * which branches it joins, whether it can land, how big it is, and what CI
 * says about its head commit.
 *
 * One request, and only for a PULL REQUEST — the list row carries none of this
 * and could not: it is two or three upstream calls per item, and a list page
 * holds thirty items whose reader opens at most one. All of them land on the
 * forge's cheap quota (GitHub's core 5000/hour rather than search's thirty a
 * minute), so opening item after item cannot starve the list behind it.
 *
 * Scoped to ONE item by the caller's `key`, like the thread, so there is no
 * reset logic here.
 */
function ChangeSection({
  folderId,
  number,
}: {
  folderId: number
  number: number
}) {
  const t = useTranslations("Forge")
  const tRoot = useTranslations()
  const [detail, setDetail] = useState<ForgeChangeDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<{ error: unknown } | null>(null)
  const reqRef = useRef(0)

  const load = useCallback(async () => {
    const id = ++reqRef.current
    setLoading(true)
    setFailure(null)
    try {
      const next = await forgeChangeDetail(folderId, number)
      if (id !== reqRef.current) return
      setDetail(next)
    } catch (error) {
      if (id !== reqRef.current) return
      // What is already on screen stays: a failed refresh costs the update,
      // not the branches somebody was reading.
      setFailure({ error })
    } finally {
      if (id === reqRef.current) setLoading(false)
    }
  }, [folderId, number])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="flex flex-col gap-3 border-t border-border px-5 py-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
          {t("changeSection")}
        </h3>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          title={t("changeRefresh")}
          aria-label={t("changeRefresh")}
          className="ms-auto inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {detail == null && loading ? (
        <div aria-hidden className="flex flex-col gap-2">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : null}

      {failure != null ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2">
          <p className="text-xs text-destructive">
            {toLocalizedErrorMessage(
              failure.error,
              tRoot as unknown as AppErrorTranslator
            )}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="text-[0.6875rem] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("commentsRetry")}
          </button>
        </div>
      ) : null}

      {detail != null ? (
        <>
          <BranchPair detail={detail} />
          <ChangeCounters detail={detail} />
          <ChecksStrip checks={detail.checks} />
          <ChangedFiles folderId={folderId} number={number} />
        </>
      ) : null}
    </section>
  )
}

/** `base ← head`, which is the sentence a proposed change IS. The head carries
 *  its repository only when that is somebody else's — a fork is the fact worth
 *  a second coordinate, and `acme/app:main ← acme/app:fix` would be noise on
 *  every other change. */
function BranchPair({ detail }: { detail: ForgeChangeDetail }) {
  const t = useTranslations("Forge")
  const branch =
    "min-w-0 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.75rem]"
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
      <span className={branch} title={detail.base_ref}>
        {detail.base_ref}
      </span>
      {/* An arrow, not the word "from": it points the way the code moves and
          needs no translating. Labelled for a screen reader, which cannot see
          which end is which. */}
      <span aria-label={t("mergesInto")} className="text-muted-foreground">
        ←
      </span>
      <span
        className={branch}
        title={
          detail.head_repo
            ? `${detail.head_repo}:${detail.head_ref}`
            : detail.head_ref
        }
      >
        {detail.head_repo ? `${detail.head_repo}:` : ""}
        {detail.head_ref}
      </span>
      {detail.draft ? (
        <span className="rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">
          {t("stateDraft")}
        </span>
      ) : null}
    </div>
  )
}

/** Mergeability and size, on one line. Every counter is optional because the
 *  two forges answer different halves of the question — GitLab reports no line
 *  counts and no commit count on a merge request at all — and a zero would
 *  claim the change touches nothing. */
function ChangeCounters({ detail }: { detail: ForgeChangeDetail }) {
  const t = useTranslations("Forge")
  const merged = detail.state === "merged"
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.6875rem] text-muted-foreground">
      {/* A merged change has no mergeability left to report, and both forges
          keep answering the question after the fact — "has conflicts" on
          something that already landed reads as a problem that is not there. */}
      {merged ? null : detail.mergeable === true ? (
        <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
          <CircleCheck className="size-3" aria-hidden />
          {t("mergeableYes")}
        </span>
      ) : detail.mergeable === false ? (
        <span
          title={detail.merge_state ?? undefined}
          className="inline-flex items-center gap-1 font-medium text-rose-600"
        >
          <TriangleAlert className="size-3" aria-hidden />
          {t("mergeableNo")}
        </span>
      ) : (
        // Neither forge has finished working it out. NOT "cannot be merged" —
        // that would send someone hunting a conflict that may not exist.
        <span title={detail.merge_state ?? undefined}>
          {t("mergeableUnknown")}
        </span>
      )}
      {detail.changed_files != null ? (
        <span className="tabular-nums">
          {t("filesChanged", { count: detail.changed_files })}
        </span>
      ) : null}
      {detail.additions != null || detail.deletions != null ? (
        <span className="tabular-nums">
          <span className="text-emerald-600">+{detail.additions ?? 0}</span>{" "}
          <span className="text-rose-600">−{detail.deletions ?? 0}</span>
        </span>
      ) : null}
      {detail.commits != null ? (
        <span className="tabular-nums">
          {t("commitsCount", { count: detail.commits })}
        </span>
      ) : null}
    </div>
  )
}

/**
 * CI on the head commit.
 *
 * "Could not read the checks" and "nothing ran" are drawn as different things
 * on purpose — a token without the scope, or a repository with CI switched
 * off, would otherwise print "no checks" over a build that is red.
 */
function ChecksStrip({ checks }: { checks: ForgeChangeDetail["checks"] }) {
  const t = useTranslations("Forge")
  const tally = useMemo(() => {
    const counts = { passing: 0, failing: 0, pending: 0 }
    for (const check of checks.checks) {
      if (check.state === "success") counts.passing += 1
      else if (check.state === "failure") counts.failing += 1
      else if (check.state === "queued" || check.state === "running") {
        counts.pending += 1
      }
    }
    return counts
  }, [checks])

  if (!checks.available) {
    return (
      <p className="text-[0.6875rem] text-muted-foreground">
        {t("checksUnavailable")}
      </p>
    )
  }
  if (checks.checks.length === 0) {
    // "Nothing ran" is a claim about the repository; "we saw nothing" is a
    // claim about this token. GitHub gates its two check collections behind
    // two permissions, so an empty list from a half-readable pair means the
    // second one — and printing "no checks ran" there would be green over red.
    return (
      <p className="text-[0.6875rem] text-muted-foreground">
        {t(checks.partial ? "checksUnavailable" : "checksEmpty")}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] text-muted-foreground">
        <span className="font-medium uppercase tracking-wide">
          {t("checks")}
        </span>
        {/* Half an answer, said out loud beside the half it did get: the
            numbers below describe what was readable, not what ran. */}
        {checks.partial ? (
          <span className="text-amber-600">{t("checksPartial")}</span>
        ) : null}
        {/* Only the non-zero ones: "0 failing" beside "3 passing" is a line of
            reassurance nobody asked for, and it pushes the number that matters
            off the end on a narrow panel. */}
        {tally.failing > 0 ? (
          <span className="font-medium text-rose-600">
            {t("checksFailing", { count: tally.failing })}
          </span>
        ) : null}
        {tally.pending > 0 ? (
          <span>{t("checksPending", { count: tally.pending })}</span>
        ) : null}
        {tally.passing > 0 ? (
          <span>{t("checksPassing", { count: tally.passing })}</span>
        ) : null}
      </div>
      <ul className="flex flex-col divide-y divide-border/40 overflow-hidden rounded-xl border border-border">
        {checks.checks.map((check) => (
          <li key={check.id}>
            <CheckRow check={check} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function CheckRow({ check }: { check: ForgeCheck }) {
  const t = useTranslations("Forge")
  const { Icon, className, labelKey } = CHECK_GLYPH[check.state]
  return (
    <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[0.75rem]">
      <Icon
        role="img"
        aria-label={t(labelKey)}
        className={cn("size-3.5 shrink-0", className)}
      />
      <span className="min-w-0 truncate font-medium" title={check.name}>
        {check.name}
      </span>
      {check.summary ? (
        <span
          className="min-w-0 truncate text-[0.6875rem] text-muted-foreground"
          title={check.summary}
        >
          {check.summary}
        </span>
      ) : null}
      {/* A red job the pipeline is allowed to fail on is a different fact from
          one that blocks the change; without this they read as the same red. */}
      {check.allow_failure ? (
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
          {t("checkAllowFailure")}
        </span>
      ) : null}
      {check.url ? (
        <BrowserLink
          href={check.url}
          title={t("openCheck")}
          aria-label={t("openCheck")}
          className="ms-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ExternalLink className="size-3" aria-hidden />
        </BrowserLink>
      ) : null}
    </div>
  )
}

/**
 * The paths a change touches — not its diff.
 *
 * Reading the diff is what the task worktree and the app's own diff view are
 * for; this answers "what does this touch", which is the question asked while
 * deciding whether to open it at all. The list is height-bounded and scrolls
 * inside itself: a change touching two hundred files would otherwise push the
 * discussion below it out of reach.
 */
function ChangedFiles({
  folderId,
  number,
}: {
  folderId: number
  number: number
}) {
  const t = useTranslations("Forge")
  const tRoot = useTranslations()
  const [files, setFiles] = useState<ForgeChangedFile[]>([])
  const [nextPage, setNextPage] = useState(1)
  const [hasNext, setHasNext] = useState(false)
  const [loading, setLoading] = useState(true)
  /** The rejection, with the PAGE that produced it — the same rule the comment
   *  thread follows: retrying through `nextPage` would ask for the page AFTER
   *  the one that failed. */
  const [failure, setFailure] = useState<{
    error: unknown
    page: number
  } | null>(null)
  const reqRef = useRef(0)

  const load = useCallback(
    async (page: number) => {
      const id = ++reqRef.current
      setLoading(true)
      setFailure(null)
      try {
        const list = await forgeChangeFiles(folderId, { number, page })
        if (id !== reqRef.current) return
        // Page 1 replaces; later pages append. Same rule as the thread, and
        // for the same reason — page 1 is also what a re-open re-asks for.
        setFiles((held) => (page === 1 ? list.files : [...held, ...list.files]))
        setHasNext(list.has_next)
        setNextPage(list.page + 1)
      } catch (error) {
        if (id !== reqRef.current) return
        setFailure({ error, page })
      } finally {
        if (id === reqRef.current) setLoading(false)
      }
    },
    [folderId, number]
  )

  useEffect(() => {
    void load(1)
  }, [load])

  const firstLoad = loading && files.length === 0 && failure == null

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
        {t("filesTitle")}
      </span>
      {firstLoad ? (
        <div aria-hidden className="flex flex-col gap-1">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : null}
      {failure != null ? (
        <div className="flex flex-col items-start gap-1 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2">
          <p className="text-xs text-destructive">
            {toLocalizedErrorMessage(
              failure.error,
              tRoot as unknown as AppErrorTranslator
            )}
          </p>
          <button
            type="button"
            onClick={() => void load(failure.page)}
            className="text-[0.6875rem] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("commentsRetry")}
          </button>
        </div>
      ) : null}
      {files.length > 0 ? (
        // Bounded and scrolled in place: without this a change touching two
        // hundred files buries the discussion under it.
        <ScrollArea className="max-h-64 rounded-xl border border-border">
          <ul className="flex flex-col divide-y divide-border/40">
            {files.map((file) => (
              <li key={`${file.status}-${file.path}`}>
                <ChangedFileRow file={file} />
              </li>
            ))}
          </ul>
        </ScrollArea>
      ) : null}
      {!loading && failure == null && files.length === 0 ? (
        <p className="text-[0.6875rem] text-muted-foreground">
          {t("filesEmpty")}
        </p>
      ) : null}
      {hasNext && failure == null ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void load(nextPage)}
          className="h-7 self-center rounded-full px-3 text-[0.6875rem] font-medium text-muted-foreground"
        >
          {loading ? t("commentsLoading") : t("filesMore")}
        </Button>
      ) : null}
    </div>
  )
}

function ChangedFileRow({ file }: { file: ForgeChangedFile }) {
  const t = useTranslations("Forge")
  const { mark, className, labelKey } = FILE_STATUS[file.status]
  return (
    <div className="flex min-w-0 items-center gap-2 px-2.5 py-1 text-[0.75rem]">
      <span
        role="img"
        aria-label={t(labelKey)}
        className={cn(
          "w-3 shrink-0 text-center font-mono font-semibold",
          className
        )}
      >
        {mark}
      </span>
      <span
        className="min-w-0 flex-1 truncate font-mono"
        // The whole path, and where a rename came from — a truncated
        // `src/components/forge/…` is not something you can act on.
        title={
          file.previous_path
            ? `${file.path}\n${t("fileRenamedFrom", { path: file.previous_path })}`
            : file.path
        }
      >
        {file.path}
      </span>
      {file.binary ? (
        <span className="shrink-0 text-[0.625rem] text-muted-foreground">
          {t("fileBinary")}
        </span>
      ) : (
        <span className="shrink-0 tabular-nums text-[0.6875rem]">
          <span className="text-emerald-600">+{file.additions ?? 0}</span>{" "}
          <span className="text-rose-600">−{file.deletions ?? 0}</span>
        </span>
      )}
    </div>
  )
}

/**
 * Right-side detail panel for one issue / pull request.
 *
 * It replaces what the row's title used to do — leave the app for the forge's
 * own web page — because everything a triage pass needs is already in the list
 * payload: the body rides along with every row (see `ForgeIssueRow::body`), so
 * the panel draws instantly, and the list underneath keeps its filters, its
 * page and its scroll position. The panel is the same drawer the task board
 * uses, at the same width, for the same reason those all share
 * `SIDE_PANEL_CONTENT_CLASS`: they stack on one another.
 *
 * The discussion is the one thing that does cost a request (see
 * [`CommentThread`]) — it is not in the list payload and could not be, because
 * a list page holds thirty items whose reader opens at most one. A pull
 * request costs one more (see [`ChangeSection`]), for the same reason.
 *
 * It also WRITES: a comment, and the item's open/closed state. Both go through
 * the backend's own account resolution and both adopt the forge's answer
 * rather than a local guess — see `forge_create_comment_core` and
 * `forge_set_item_state_core`.
 */
export function ForgeIssueDetailSheet({
  row,
  link,
  folderId,
  onOpenChange,
  onStart,
  onRowUpdated,
  onCommentPosted,
}: {
  /** The item on show, or `null` when the panel is closed. Held by the page so
   *  a list refresh re-renders the panel with the item's fresh copy. */
  row: ForgeIssueRow | null
  /** Latest task for this item, if any — the footer's action depends on it. */
  link: ForgeTaskLink | null
  /** Which folder's repository the item belongs to — the only coordinate the
   *  comment fetch needs that the row does not carry (the backend derives the
   *  repository from this folder's own remote). `null` while no folder is
   *  resolved, which costs the thread and nothing else. */
  folderId: number | null
  onOpenChange: (open: boolean) => void
  /** Opens the page's trigger dialog on this item. */
  onStart: () => void
  /**
   * This item's state changed on the FORGE, and here is the row it now serves.
   *
   * The AUTHORITATIVE copy — the page adopts it for both the panel and the row
   * in its loaded list, without re-reading the list behind it. That is
   * deliberate: GitHub's search index (which the list is served from) lags a
   * write by seconds, so an immediate re-read would routinely answer with the
   * state that was just changed away from and undo what the user watched
   * succeed. The list catches up on the next refresh, filter change or page
   * turn, which is when the forge has caught up too.
   */
  onRowUpdated: (updated: ForgeIssueRow) => void
  /**
   * A comment landed on this item.
   *
   * The ITEM, not a row: a post can still be in the air when a close resolves,
   * and handing back a row captured at submit time would carry that item's
   * pre-close state over the newer one. A number cannot go stale, so the page
   * counts the comment onto whatever it holds by the time this arrives.
   */
  onCommentPosted: (item: { isPr: boolean; number: number }) => void
}) {
  const t = useTranslations("Forge")
  const tTasks = useTranslations("Tasks")
  // Root-scoped, like the page's: a forge failure carries a FULL dotted i18n
  // key that the namespaced translator above cannot resolve.
  const tRoot = useTranslations()
  const { setRoute } = useWorkbenchRoute()
  /** The state change awaiting confirmation, or `null`. Boxed rather than a
   *  boolean pair: the dialog has to know WHICH way it is going, and an
   *  "open" flag beside a "direction" is two values that can disagree. */
  const [pendingAction, setPendingAction] = useState<ForgeStateAction | null>(
    null
  )
  const [changing, setChanging] = useState(false)

  const applyState = useCallback(
    async (action: ForgeStateAction) => {
      if (row == null || folderId == null) return
      setChanging(true)
      try {
        const updated = await forgeSetItemState(folderId, {
          kind: row.is_pr ? "pr" : "issue",
          number: row.number,
          action,
        })
        setPendingAction(null)
        onRowUpdated(mergeForgeRowUpdate(row, updated))
      } catch (error) {
        // A toast, not an inline strip: the confirmation dialog this was
        // launched from is covering wherever a strip would have gone.
        toast.error(
          toLocalizedErrorMessage(error, tRoot as unknown as AppErrorTranslator)
        )
      } finally {
        setChanging(false)
      }
    },
    [folderId, onRowUpdated, row, tRoot]
  )

  if (row == null) return null

  const chip = chipStateForLink(link)
  const active = chip === "active"
  const terminal = chip === "terminal"
  const { Icon, className: glyphClass, labelKey } = stateGlyph(row)
  const stateLabel = t(labelKey)
  const body = row.body?.trim()
  /** Which way the state button points — and whether there is one at all.
   *
   *  A MERGED change has no state left to set: it is already closed, and
   *  neither forge will reopen it (GitHub refuses outright, GitLab reopens it
   *  as a fresh merge request against a branch that is gone). Offering the
   *  button would be offering a request that cannot succeed. */
  const stateAction: ForgeStateAction | null =
    row.state === "merged" ? null : row.state === "open" ? "close" : "reopen"

  return (
    <Drawer open onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent className={SIDE_PANEL_CONTENT_CLASS}>
        <DrawerHeader className="shrink-0 gap-0 border-b border-border px-5 py-4">
          {/* `pr-8` clears the close button in the corner. */}
          <div className="flex items-start gap-3 pr-8">
            {/* The list's own state glyph, given the framed tile the task
                sheet's agent icon has — at panel scale a bare 14px mark beside
                a two-line title reads as a stray bullet. */}
            <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40">
              {/* Decoration here, unlike on the row: the state is spelled out
                  in the meta line below, and labelling both would read the
                  word twice to a screen reader. */}
              <Icon className={cn("size-[1.125rem]", glyphClass)} aria-hidden />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <DrawerTitle className="min-w-0 break-words text-[0.9375rem] font-semibold leading-5">
                {row.title}
              </DrawerTitle>
              {/* The row's own meta line, with the state spelled out: the list
                  can lean on a column of glyphs to carry the state, a single
                  item on its own cannot. */}
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.6875rem] text-muted-foreground">
                <span className={cn("font-medium", glyphClass)}>
                  {stateLabel}
                </span>
                <span className="font-mono">· #{row.number}</span>
                {row.author ? <span>· {row.author}</span> : null}
                {row.updated_at ? (
                  <span title={absolute(row.updated_at)}>
                    · {t("detailUpdated", { time: relative(row.updated_at) })}
                  </span>
                ) : null}
                {row.comments > 0 ? (
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <span aria-hidden>·</span>
                    <MessageSquare className="size-3" aria-hidden />
                    {t("commentCount", { count: row.comments })}
                  </span>
                ) : null}
              </div>
              {/* EVERY label, unlike the row — the panel is where the ones the
                  row had to drop finally show. */}
              {row.labels.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  {row.labels.map((label) => (
                    <ForgeLabelChip
                      key={label.name}
                      label={label}
                      className="h-5 px-2 text-[0.6875rem]"
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <DrawerDescription className="sr-only">
            {t("detailDescription")}
          </DrawerDescription>
        </DrawerHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="px-5 py-4">
            {body ? (
              // The forge's own Markdown, through the same renderer the chat
              // uses — headings, task lists, tables, fenced code and images all
              // come out as the author wrote them, and link clicks go through
              // the app's link-safety routing rather than the webview.
              <div
                className={cn(
                  "break-words text-[0.8125rem] leading-relaxed",
                  BODY_MARKDOWN
                )}
              >
                <MessageResponse>{body}</MessageResponse>
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-muted-foreground">
                {t("detailNoBody")}
              </p>
            )}
          </div>

          {/* Both sections are keyed by the ITEM, not by the row object: the
              page re-reads the row from the list on every render, so identity
              changes whenever anything behind the panel refreshes — and a
              section that remounted on each of those would re-fetch, lose its
              loaded pages and scroll the reader back to the top. The panel is
              non-modal, though, so clicking a different row swaps the item
              underneath without ever closing; the key is what resets them when
              that happens. */}
          {folderId != null && row.is_pr ? (
            <ChangeSection
              key={`change-${row.number}`}
              folderId={folderId}
              number={row.number}
            />
          ) : null}

          {folderId != null ? (
            <CommentThread
              key={`${row.is_pr ? "pr" : "issue"}-${row.number}`}
              folderId={folderId}
              kind={row.is_pr ? "pr" : "issue"}
              number={row.number}
              // The ITEM, not a row: this fires when the POST resolves, and by
              // then a close or a list load may have produced a newer copy
              // that a snapshot taken at submit time would overwrite.
              onPosted={() =>
                onCommentPosted({ isPr: row.is_pr, number: row.number })
              }
            />
          ) : null}
        </ScrollArea>

        {/* The way out to the forge and the state verb on one side, what to DO
            about the item on the other. Same pills as the row, so an item's
            action does not change shape on the way into the panel — only the
            fill does: here "Start" is the one thing the panel is asking for,
            and gets the filled treatment a column of rows could not afford.
            `flex-wrap` because four controls do not fit a phone-width panel on
            one line, and a footer that clipped one of them would hide it. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          {/* A real anchor wearing the pill, not a button that calls `openUrl`:
              `href` is what gives it "copy link address", the status-bar
              preview and a screen reader that says "link". `BrowserLink` is
              what keeps the click working in the desktop webview. */}
          <BrowserLink
            href={row.html_url}
            className={cn(
              ROW_ACTION,
              "inline-flex items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            )}
          >
            <ExternalLink className={ROW_ACTION_GLYPH} aria-hidden />
            {t("openItem")}
          </BrowserLink>

          {/* The one control here that writes to somebody else's repository —
              and unlike the composer, it takes a single click with nothing
              typed first. So it asks, once, naming the item. Absent entirely on
              a merged change: there is no state left to set (see
              `stateAction`), and a button that can only fail is worse than no
              button. Also absent without a folder — the write needs one. */}
          {stateAction != null && folderId != null ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={changing}
              onClick={() => setPendingAction(stateAction)}
              // The visible word is one the footer can fit; the accessible name
              // is one that can be told apart. The drawer's own dismiss button
              // is also called "Close", and two controls answering to that in
              // one panel is the difference between closing a dialog and
              // closing somebody's issue. (It CONTAINS the visible label, so
              // voice control still reaches it by what is written on it.)
              aria-label={t(
                stateAction === "close" ? "closeItemHint" : "reopenItemHint",
                { number: row.number }
              )}
              title={t(
                stateAction === "close" ? "closeItemHint" : "reopenItemHint",
                { number: row.number }
              )}
              className={cn(
                ROW_ACTION,
                "text-muted-foreground hover:text-foreground"
              )}
            >
              {stateAction === "close" ? (
                <GitPullRequestClosed
                  className={ROW_ACTION_GLYPH}
                  aria-hidden
                />
              ) : (
                <RotateCcw className={ROW_ACTION_GLYPH} aria-hidden />
              )}
              {t(stateAction === "close" ? "closeItem" : "reopenItem")}
            </Button>
          ) : null}

          <div className="ms-auto flex items-center gap-1.5">
            {link == null ? (
              <Button
                type="button"
                size="sm"
                className={ROW_ACTION}
                onClick={onStart}
              >
                <CirclePlay className={ROW_ACTION_GLYPH} aria-hidden />
                {t("start")}
              </Button>
            ) : (
              // Siblings, never nested — same reason as on the row: a button
              // inside a button folds its text into the outer one's accessible
              // name and leaves keyboard activation to the browser.
              <>
                {terminal ? (
                  <button
                    type="button"
                    onClick={onStart}
                    className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    <RotateCcw className="size-3" aria-hidden />
                    {t("retrigger")}
                  </button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRoute("tasks")}
                  title={t("viewTask")}
                  className={cn(
                    ROW_ACTION,
                    active ? CHIP_FILL.active : CHIP_FILL.settled
                  )}
                >
                  <ListTodo className={ROW_ACTION_GLYPH} aria-hidden />
                  {tTasks(statusLabelKey(link.status))}
                </Button>
              </>
            )}
          </div>
        </div>
      </DrawerContent>

      {/* Outside `DrawerContent`, so its portal lands after the panel's and
          covers it — the same stacking the trigger dialog relies on. */}
      <AlertDialog
        open={pendingAction != null}
        onOpenChange={(open) => {
          // Never dismissed out from under a request in flight: the write is
          // already on its way and the dialog is where its failure is
          // reported from.
          if (!open && !changing) setPendingAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                pendingAction === "reopen"
                  ? "reopenConfirmTitle"
                  : "closeConfirmTitle"
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                pendingAction === "reopen"
                  ? "reopenConfirmBody"
                  : "closeConfirmBody",
                { title: row.title }
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={changing}>
              {t("cancel")}
            </AlertDialogCancel>
            {/* NOT `AlertDialogAction`: that one closes the dialog on click,
                which would take the busy state and the failure message with
                it. The dialog closes when the write SUCCEEDS. */}
            <Button
              type="button"
              disabled={changing || pendingAction == null}
              onClick={() => {
                if (pendingAction != null) void applyState(pendingAction)
              }}
            >
              {changing
                ? t("stateChanging")
                : t(pendingAction === "reopen" ? "reopenItem" : "closeItem")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Drawer>
  )
}
