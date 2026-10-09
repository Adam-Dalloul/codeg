"use client"

import { useMemo } from "react"

import { buildKnownInvocations } from "@/components/chat/composer/invocation-reference"
import { useAgentSkills } from "@/hooks/use-agent-skills"
import type { KnownInvocations } from "@/lib/invocation-token"
import type { AgentType, AvailableCommandInfo } from "@/lib/types"

/**
 * The invocations a transcript's user bubbles may badge: exactly what the
 * composer's `/`·`$` menu offers the same agent, so a sent message badges the
 * tokens its composer could have inserted and nothing else. That is the commands
 * the connection advertises, plus, for Codex, the on-disk skills behind its `$`
 * menu, read from the same folder as the composer's scan (one shared entry).
 * Every other agent advertises its skills as commands already.
 *
 * The reference changes only when one of those lists does, never per render: a
 * new value re-renders every user message on screen.
 */
export function useTranscriptKnownInvocations(
  agentType: AgentType,
  availableCommands: readonly AvailableCommandInfo[] | null | undefined,
  workspacePath: string | null
): KnownInvocations {
  const isCodex = agentType === "codex"
  const skills = useAgentSkills(isCodex ? "codex" : null, workspacePath)
  return useMemo(
    () => buildKnownInvocations(availableCommands, skills, isCodex ? "$" : "/"),
    [availableCommands, skills, isCodex]
  )
}
