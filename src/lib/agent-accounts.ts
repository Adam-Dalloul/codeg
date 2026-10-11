import type { AgentType } from "@/lib/types"
import type { ExtraSlotLoginResult } from "@/lib/api"
import { getTransport, getActiveRemoteConnectionId } from "@/lib/transport"

export interface AgentAccount {
  id: string
  agentType: AgentType
  name: string
  homeDir: string
  removed: boolean
}

export interface AgentAccountCapability {
  agentType: AgentType
  supported: boolean
  reason: string | null
  loginKind: "terminal" | "browser" | null
  configSubdir?: string | null
  canSwitchConversation?: boolean
}

export interface AgentAccountsResult {
  accounts: AgentAccount[]
  capabilities: AgentAccountCapability[]
}

export function listAgentAccounts(
  agentType: AgentType
): Promise<AgentAccountsResult> {
  return getTransport().call("acp_list_agent_accounts", { agentType })
}

export function createAgentAccount(
  agentType: AgentType,
  name: string,
  homeDir?: string
): Promise<AgentAccount> {
  return getTransport().call("acp_create_agent_account", {
    agentType,
    name,
    homeDir: homeDir?.trim() || null,
  })
}

export function renameAgentAccount(
  accountId: string,
  name: string
): Promise<void> {
  return getTransport().call("acp_rename_agent_account", { accountId, name })
}

export function removeAgentAccount(accountId: string): Promise<void> {
  return getTransport().call("acp_remove_agent_account", { accountId })
}

export function loginAgentAccount(
  accountId: string
): Promise<ExtraSlotLoginResult> {
  return getTransport().call("acp_login_agent_account", { accountId })
}

export function switchConversationAccount(request: {
  conversationId: number
  sourceAccountId: string | null
  targetAccountId: string | null
  preferredModeId?: string
  preferredConfigValues?: Record<string, string>
}): Promise<{
  conversationId: number
  agentAccountId: string | null
  connectionId: string
  externalId: string
}> {
  return getTransport().call(
    "acp_switch_conversation_account",
    { request },
    { timeoutMs: 120_000 }
  )
}

export function agentAccountKey(
  agentType: string,
  accountId?: string | null
): string {
  return accountId ? `${agentType}:account:${accountId}` : agentType
}

function selectionKey(agentType: AgentType) {
  return `codeg:agent-account:${getActiveRemoteConnectionId() ?? "local"}:${agentType}`
}

export function readSelectedAccount(agentType: AgentType): string | null {
  if (typeof window === "undefined") return null
  try {
    return localStorage.getItem(selectionKey(agentType)) || null
  } catch {
    return null
  }
}

export function saveSelectedAccount(agentType: AgentType, id: string | null) {
  try {
    if (id) localStorage.setItem(selectionKey(agentType), id)
    else localStorage.removeItem(selectionKey(agentType))
  } catch {
    /* A blocked preference store must not prevent account selection. */
  }
}
