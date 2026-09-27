/**
 * Codex's `visualize` skill puts an inline visualization into a reply as a
 * *content reference* on its own line:
 *
 *     visualize{"path":"/abs/path/chart.html"}
 *     visualize{"path":"/abs/path/app.html","mode":"wide"}
 *
 * The three Private Use Area code points fence the reference so it can never
 * collide with prose. The Codex app swaps the line for a sandboxed iframe that
 * renders the referenced HTML fragment; everything else in the reply is
 * ordinary Markdown. This module finds those references so the transcript can
 * do the same instead of showing the raw marker (`visualize{"path":…}` with
 * tofu boxes around it).
 */

export const CODEX_VISUALIZE_OPEN = "\uE200"
export const CODEX_VISUALIZE_ARGS = "\uE202"
export const CODEX_VISUALIZE_CLOSE = "\uE201"

const MARKER_START = `${CODEX_VISUALIZE_OPEN}visualize${CODEX_VISUALIZE_ARGS}`

export type CodexVisualizeMode = "normal" | "wide"

export interface CodexVisualizeRef {
  /** Absolute path of the HTML fragment on the machine that ran Codex. */
  path: string
  mode: CodexVisualizeMode
}

export type CodexVisualizeSegment =
  | { kind: "markdown"; text: string }
  | { kind: "visualize"; ref: CodexVisualizeRef; raw: string }

/** Cheap pre-check so the common (marker-free) reply never pays for a split. */
export function hasCodexVisualizeRef(text: string): boolean {
  return text.includes(MARKER_START)
}

/**
 * Parse the JSON payload between the ARGS and CLOSE fences. Anything that is
 * not an object with a non-empty string `path` is rejected — the marker then
 * stays visible as text, which is the honest failure mode.
 */
export function parseCodexVisualizeArgs(
  json: string
): CodexVisualizeRef | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  const path = (value as { path?: unknown }).path
  if (typeof path !== "string" || path.trim().length === 0) return null
  const mode = (value as { mode?: unknown }).mode
  return { path: path.trim(), mode: mode === "wide" ? "wide" : "normal" }
}

/**
 * Split a reply into Markdown runs and visualization references, in order.
 *
 * Fenced code blocks are skipped so a reply that *documents* the marker (as
 * the skill's own SKILL.md does) keeps it as literal code. Adjacent Markdown
 * is merged; a reply without any valid marker comes back as one Markdown
 * segment.
 */
export function splitCodexVisualizeRefs(text: string): CodexVisualizeSegment[] {
  if (!hasCodexVisualizeRef(text)) return [{ kind: "markdown", text }]

  const segments: CodexVisualizeSegment[] = []
  let markdown = ""
  const flushMarkdown = () => {
    if (markdown.length > 0) {
      segments.push({ kind: "markdown", text: markdown })
      markdown = ""
    }
  }

  const lines = text.split("\n")
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const eol = i < lines.length - 1 ? "\n" : ""
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const run = fenceMatch[1]
      if (fence === null) fence = run
      else if (run[0] === fence[0] && run.length >= fence.length) fence = null
      markdown += line + eol
      continue
    }
    if (fence !== null) {
      markdown += line + eol
      continue
    }

    let rest = line
    let consumed = false
    for (;;) {
      const start = rest.indexOf(MARKER_START)
      if (start === -1) break
      const argsStart = start + MARKER_START.length
      const end = rest.indexOf(CODEX_VISUALIZE_CLOSE, argsStart)
      if (end === -1) break
      const ref = parseCodexVisualizeArgs(rest.slice(argsStart, end))
      const raw = rest.slice(start, end + CODEX_VISUALIZE_CLOSE.length)
      if (ref === null) {
        // Keep the malformed marker as text and continue scanning after it.
        markdown += rest.slice(0, end + CODEX_VISUALIZE_CLOSE.length)
        rest = rest.slice(end + CODEX_VISUALIZE_CLOSE.length)
        continue
      }
      markdown += rest.slice(0, start)
      flushMarkdown()
      segments.push({ kind: "visualize", ref, raw })
      rest = rest.slice(end + CODEX_VISUALIZE_CLOSE.length)
      consumed = true
    }
    if (consumed) {
      // Drop whitespace-only leftovers so the card is not followed by an
      // empty paragraph; keep anything the model wrote after the marker.
      if (rest.trim().length > 0) markdown += rest + eol
      else if (eol && markdown.length > 0) markdown += eol
    } else {
      markdown += rest + eol
    }
  }
  flushMarkdown()

  if (!segments.some((s) => s.kind === "visualize")) {
    return [{ kind: "markdown", text }]
  }
  return segments
}

/**
 * A fragment vs. a complete document. The skill writes fragments (the Codex
 * app supplies the document around them); an export made with its `render.py`
 * is a complete document and must be shown as-is.
 */
export function isCompleteHtmlDocument(html: string): boolean {
  return /<!doctype\s|<\s*(?:html|head|body)(?:\s|>)/i.test(html)
}
