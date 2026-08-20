/**
 * Turn a transcript text selection into a Markdown blockquote for the composer.
 *
 * The composer is a PLAIN-TEXT editor (no blockquote node — see
 * `buildComposerExtensions`), so the quote is literal `> ` markers: what the user
 * sees in the input is exactly what the agent receives, and the transcript
 * renders it back as a blockquote once sent.
 *
 * - CR / CRLF newlines normalize to `\n` (a selection copied out of a code block
 *   can carry either).
 * - Leading and trailing blank lines are dropped — a selection that runs past the
 *   end of a paragraph routinely picks them up, and they'd otherwise become empty
 *   `>` lines around the quote.
 * - Interior blank lines become a bare `>` so the whole selection stays inside
 *   ONE blockquote; a truly empty `` line would terminate it and leave the
 *   remainder as unquoted prose.
 * - Per-line trailing whitespace is dropped so a stray double space can't turn
 *   into a Markdown hard break.
 *
 * Returns "" when the selection has no visible content, so callers can skip the
 * insert entirely. The result carries no trailing newline — separating it from
 * whatever is already in the draft is the caller's decision.
 */
export function buildQuotedMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")

  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === "") start += 1
  while (end > start && lines[end - 1].trim() === "") end -= 1
  if (start === end) return ""

  return lines
    .slice(start, end)
    .map((line) => {
      const trimmed = line.trimEnd()
      return trimmed === "" ? ">" : `> ${trimmed}`
    })
    .join("\n")
}
