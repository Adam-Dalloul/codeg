"use client"

/**
 * Remembers which slash commands each agent last advertised in each folder, so
 * a transcript can badge a sent `/review` before the agent has advertised
 * anything on its current connection.
 *
 * A bare `/word` in a sent message is a command badge only when the agent
 * offers that command (see `KnownInvocations`), and the live list exists only
 * once a connection's handshake delivers it. Opening a conversation, a restart
 * and every reconnect all show the transcript first and the list a moment
 * later, so without this record a command badge would start out as text and
 * turn into a badge under the reader, or drop to text and come back across a
 * reconnect. With it, the list this agent last advertised in this folder stands
 * in until the live one replaces it.
 *
 * Keyed by agent AND folder: what an agent offers depends on the folder
 * (project commands and skills live in it), so one folder's list says nothing
 * about another's. A folder an agent has never advertised in has no entry, and
 * badges nothing until the agent advertises there.
 *
 * REPLACED, never merged (unlike `model-label-store`): a badge says the agent
 * offers the command now, so a command it stopped advertising should stop
 * being one. Only names are kept, because a badge checks nothing else.
 *
 * Persisted, because a restart is the case that needs it most, and shared by
 * every window of the app through the one localStorage. A write re-reads what
 * is stored first, so one window cannot write a stale copy back over another's
 * newer entry, and a `storage` event brings the other windows up to date. The
 * record is capped in size, dropping the folder advertised least recently
 * first: it shares the origin's quota with every draft.
 *
 * `Map`, not a plain object, for the reason `model-label-store` gives: agent
 * types and folder paths are strings codeg does not choose.
 */

import type { AvailableCommandInfo } from "@/lib/types"

const STORAGE_KEY = "codeg:advertised-commands"

/**
 * At most this many characters of stored JSON: room for the lists of dozens of
 * folders, and a small share of the origin's quota, which every draft also
 * draws on.
 */
export const MAX_STORED_CHARS = 64 * 1024

/** What a badge checks: each command's name, exactly as advertised. */
export type AdvertisedCommands = readonly Pick<AvailableCommandInfo, "name">[]

interface Entry {
  readonly agentType: string
  readonly folder: string
  readonly commands: AdvertisedCommands
}

/** Oldest first: a folder that advertises again moves to the end. */
type Entries = Map<string, Entry>

let entries: Entries | null = null
const listeners = new Set<() => void>()
let windowBound = false

function keyOf(agentType: string, folder: string): string {
  // NUL appears in no agent type and in no path, so no two pairs collide.
  return `${agentType}\u0000${folder}`
}

function newestKey(all: Entries): string | undefined {
  let newest: string | undefined
  for (const key of all.keys()) newest = key
  return newest
}

function sameNames(a: AdvertisedCommands, b: AdvertisedCommands): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((command, index) => command.name === b[index].name)
}

function namesOf(names: readonly unknown[]): AdvertisedCommands {
  const seen = new Set<string>()
  const out: Pick<AvailableCommandInfo, "name">[] = []
  for (const name of names) {
    if (typeof name !== "string" || !name || seen.has(name)) continue
    seen.add(name)
    out.push({ name })
  }
  return out
}

/**
 * Keep only well-formed entries of `[{agentType, folder, commands: [name]}]`.
 *
 * localStorage is shared with every other codeg instance on this machine and
 * survives downgrades, so the stored value is untrusted input: anything else
 * degrades to "nothing remembered" for that entry instead of reaching the
 * parser of a sent message.
 *
 * `previous` lends its lists to entries whose names did not change, so a re-read
 * (another window wrote) hands every unaffected reader the same snapshot and
 * re-renders nothing.
 */
function parse(raw: string | null, previous: Entries | null): Entries {
  const out: Entries = new Map()
  let stored: unknown
  try {
    stored = raw ? JSON.parse(raw) : []
  } catch {
    return out
  }
  if (!Array.isArray(stored)) return out
  for (const item of stored) {
    if (!item || typeof item !== "object") continue
    const { agentType, folder, commands } = item as Record<string, unknown>
    if (typeof agentType !== "string" || !agentType) continue
    if (typeof folder !== "string" || !folder) continue
    if (!Array.isArray(commands)) continue
    const key = keyOf(agentType, folder)
    const names = namesOf(commands)
    const kept = previous?.get(key)?.commands
    // A repeated pair keeps its last list, in the last one's place.
    out.delete(key)
    out.set(key, {
      agentType,
      folder,
      commands: kept && sameNames(kept, names) ? kept : names,
    })
  }
  return out
}

/** The stored JSON, or `undefined` when storage cannot be read at all. */
function readStored(): string | null | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return undefined
  }
}

function notify() {
  for (const listener of listeners) listener()
}

function bindWindow(): void {
  if (windowBound || typeof window === "undefined") return
  windowBound = true
  window.addEventListener("storage", (event) => {
    // Another window wrote this record (a null key: it cleared storage). Only a
    // window that has read the record holds a copy to bring up to date.
    if (event.key !== null && event.key !== STORAGE_KEY) return
    if (!entries) return
    entries = parse(readStored() ?? null, entries)
    notify()
  })
}

function load(): Entries {
  if (typeof window === "undefined") {
    // Deliberately NOT cached: this module outlives a server render, and
    // caching an empty record here would make the first client read skip
    // localStorage.
    return new Map()
  }
  bindWindow()
  entries ??= parse(readStored() ?? null, null)
  return entries
}

function storedForm({ agentType, folder, commands }: Entry) {
  return {
    agentType,
    folder,
    commands: commands.map((command) => command.name),
  }
}

/** Whether this one entry would fit the record even with nothing else in it. */
function fitsAlone(entry: Entry): boolean {
  return JSON.stringify([storedForm(entry)]).length <= MAX_STORED_CHARS
}

function persist(next: Entries): void {
  const stored = [...next.values()].map(storedForm)
  let json = JSON.stringify(stored)
  // Oldest first, so this drops the folder advertised least recently. Never
  // the newest, which `rememberAdvertisedCommands` only adds when it fits.
  while (json.length > MAX_STORED_CHARS && stored.length > 1) {
    const dropped = stored.shift()
    if (!dropped) break
    next.delete(keyOf(dropped.agentType, dropped.folder))
    json = JSON.stringify(stored)
  }
  entries = next
  try {
    localStorage.setItem(STORAGE_KEY, json)
  } catch {
    /* quota / private mode — the in-memory record still serves this window */
  }
  notify()
}

/**
 * Record the list an agent just advertised in a folder, replacing what it
 * advertised there before. A connection with no folder (a delegation child)
 * has nothing to file it under, and no transcript would look it up there.
 */
export function rememberAdvertisedCommands(
  agentType: string,
  folder: string | null | undefined,
  commands: readonly Pick<AvailableCommandInfo, "name">[]
): void {
  if (!folder || typeof window === "undefined") return
  bindWindow()
  // Built on what is stored NOW, not on this window's copy, which another
  // window may have written past since it was read.
  const raw = readStored()
  const current = raw === undefined ? load() : parse(raw, entries)
  const key = keyOf(agentType, folder)
  const names = namesOf(commands.map((command) => command.name))
  const existing = current.get(key)?.commands
  const unchanged = existing !== undefined && sameNames(existing, names)
  // Already the newest entry, with exactly this list: the usual reconnect,
  // which should neither write nor wake a reader. (Whatever else another
  // window changed reaches this one through its `storage` event.)
  if (unchanged && newestKey(current) === key) return
  const next = new Map(current)
  next.delete(key)
  const entry: Entry = {
    agentType,
    folder,
    commands: unchanged ? existing : names,
  }
  // A list too long to keep even on its own is forgotten rather than kept in
  // its stale form, and does not push every other folder out on its way.
  if (fitsAlone(entry)) next.set(key, entry)
  else if (existing === undefined) return
  persist(next)
}

/**
 * The list this agent last advertised in this folder, or `null` when it never
 * has (or no folder is known). A `useSyncExternalStore`-safe snapshot: the
 * reference changes only when this pair's names do.
 */
export function getLastAdvertisedCommands(
  agentType: string,
  folder: string | null | undefined
): AdvertisedCommands | null {
  if (!folder) return null
  return load().get(keyOf(agentType, folder))?.commands ?? null
}

export function subscribeLastAdvertisedCommands(
  listener: () => void
): () => void {
  bindWindow()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
