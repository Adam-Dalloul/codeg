"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  listAgentAccounts,
  type AgentAccountsResult,
} from "@/lib/agent-accounts"
import { subscribe } from "@/lib/platform"
import type { AgentType } from "@/lib/types"

export function useAgentAccounts(agentType: AgentType) {
  const request = useRef(0)
  const [result, setResult] = useState<{
    agentType: AgentType
    data: AgentAccountsResult | null
    error: boolean
  } | null>(null)
  const refresh = useCallback(async () => {
    const id = ++request.current
    try {
      const data = await listAgentAccounts(agentType)
      if (request.current === id) setResult({ agentType, data, error: false })
    } catch {
      if (request.current === id)
        setResult({ agentType, data: null, error: true })
    }
  }, [agentType])

  useEffect(() => {
    let active = true
    void Promise.resolve().then(() => {
      if (active) return refresh()
    })
    const unsubscribe = subscribe("app://acp-agents-updated", () => {
      if (active) void refresh()
    }).catch(() => () => {})
    return () => {
      active = false
      request.current += 1
      void unsubscribe.then((stop) => stop()).catch(() => {})
    }
  }, [refresh])

  const current = result?.agentType === agentType ? result : null
  return {
    accounts: current?.data?.accounts ?? [],
    capability: current?.data?.capabilities.find(
      (c) => c.agentType === agentType
    ),
    loading: current === null,
    error: current?.error ?? false,
    refresh,
  }
}
