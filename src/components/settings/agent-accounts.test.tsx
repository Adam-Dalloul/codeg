import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import { AgentAccounts } from "./agent-accounts"
import { useAgentAccounts } from "@/hooks/use-agent-accounts"
import {
  createAgentAccount,
  renameAgentAccount,
  removeAgentAccount,
  loginAgentAccount,
} from "@/lib/agent-accounts"
import { copyTextToClipboard } from "@/lib/utils"

vi.mock("@/hooks/use-agent-accounts", () => ({ useAgentAccounts: vi.fn() }))
vi.mock("@/lib/agent-accounts", () => ({
  createAgentAccount: vi.fn(),
  renameAgentAccount: vi.fn(),
  removeAgentAccount: vi.fn(),
  loginAgentAccount: vi.fn(),
}))
vi.mock("./antigravity-config-panel", () => ({ HeadlessSignIn: () => null }))
vi.mock("@/lib/utils", async (original) => ({
  ...(await original<typeof import("@/lib/utils")>()),
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }))

const account = {
  id: "work-id",
  agentType: "codex" as const,
  name: "Work",
  homeDir: "/profiles/work",
  removed: false,
}
const refresh = vi.fn().mockResolvedValue(undefined)

function panel() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AgentAccounts agentType="codex" />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useAgentAccounts).mockReturnValue({
    accounts: [account],
    capability: {
      agentType: "codex",
      supported: true,
      reason: null,
      loginKind: "terminal",
    },
    loading: false,
    error: false,
    refresh,
  })
})

describe("native account settings", () => {
  it("adopts the selected folder without changing the native agent type", async () => {
    vi.mocked(createAgentAccount).mockResolvedValue(account)
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Add account" }))
    fireEvent.change(screen.getByLabelText("Account name"), {
      target: { value: "Personal" },
    })
    fireEvent.change(
      screen.getByLabelText("Existing account folder (optional)"),
      { target: { value: "/profiles/personal" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(createAgentAccount).toHaveBeenCalledWith(
        "codex",
        "Personal",
        "/profiles/personal"
      )
    )
    await waitFor(() =>
      expect(screen.queryByLabelText("Account name")).not.toBeInTheDocument()
    )
    expect(refresh).toHaveBeenCalled()
  })

  it("renames the existing binding without changing its folder", async () => {
    vi.mocked(renameAgentAccount).mockResolvedValue()
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Rename Work" }))
    expect(
      screen.queryByLabelText("Existing account folder (optional)")
    ).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Account name"), {
      target: { value: "Team" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(renameAgentAccount).toHaveBeenCalledWith("work-id", "Team")
    )
  })

  it("keeps a failed removal visible in its confirmation dialog", async () => {
    vi.mocked(removeAgentAccount).mockRejectedValue(
      new Error("Could not remove account")
    )
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Remove Work" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove account" })
    )
    await waitFor(() =>
      expect(screen.getByRole("alertdialog")).toHaveTextContent(
        "Could not remove account"
      )
    )
    expect(removeAgentAccount).toHaveBeenCalledWith("work-id")
  })

  // Adding the same folder again restores the removed account, and with it the
  // conversations bound to it, so the confirmation names that folder.
  it("names the folder that brings a removed account back", async () => {
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Remove Work" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent(
      "The folder /profiles/work and its conversation history are kept."
    )
    expect(dialog).toHaveTextContent("add this folder again")
  })

  // The server explains an unsupported agent in English, so the card says it
  // in the user's language instead.
  it("says in the user's language that an agent has no accounts", () => {
    vi.mocked(useAgentAccounts).mockReturnValue({
      accounts: [],
      capability: {
        agentType: "kiro",
        supported: false,
        reason: "Named accounts are not yet supported for this agent.",
        loginKind: null,
      },
      loading: false,
      error: false,
      refresh,
    })
    render(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <AgentAccounts agentType="kiro" />
      </NextIntlClientProvider>
    )
    expect(
      screen.getByText(zhMessages.AgentAccounts.notSupported)
    ).toBeVisible()
    expect(screen.queryByText(/Named accounts/)).not.toBeInTheDocument()
  })

  it("copies the server's account-specific sign-in command", async () => {
    const command = "export CODEX_HOME='/profiles/work'; codex login"
    vi.mocked(loginAgentAccount).mockResolvedValue({
      family: "codex",
      isolatorKey: "CODEX_HOME",
      home: account.homeDir,
      command,
      launched: false,
    })
    panel()
    fireEvent.click(screen.getByRole("button", { name: "Sign in: Work" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy login command" })
    )
    expect(loginAgentAccount).toHaveBeenCalledWith("work-id")
    await waitFor(() =>
      expect(copyTextToClipboard).toHaveBeenCalledWith(command)
    )
  })
})
