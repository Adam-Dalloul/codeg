/**
 * A configured OpenCode provider's model list, picked from the models the
 * provider itself lists: a model that stays keeps its entry, a new one is
 * `{name: id}`, an unpicked one goes.
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  acpListAgents,
  acpUpdateAgentConfig,
  listModelProviders,
  listProviderModels,
} from "@/lib/api"
import type { AcpAgentInfo } from "@/lib/types"

import { AcpAgentSettings } from "./acp-agent-settings"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  // Every function is stubbed so nothing here can reach the real transport;
  // the calls these tests don't need simply never settle.
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function" ? vi.fn(() => new Promise(() => {})) : value,
    ])
  )
})
vi.mock("next/navigation", () => {
  const params = new URLSearchParams()
  return { useSearchParams: () => params }
})

const CONFIG = {
  provider: {
    relay: {
      npm: "@ai-sdk/openai-compatible",
      name: "Relay",
      options: { baseURL: "https://relay.test/v1" },
      models: {
        "glm-5.2": { name: "GLM", limit: { context: 128000, output: 8192 } },
        old: { name: "old" },
      },
    },
  },
}

function openCodeAgent(): AcpAgentInfo {
  return {
    agent_type: "open_code",
    skills_capable: true,
    registry_id: "opencode",
    registry_version: "1.19.3",
    supports_custom_version: false,
    name: "OpenCode",
    description: "",
    available: true,
    distribution_type: "binary",
    is_acp_adapter: false,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: null,
    host_tools_agent_mode: false,
    env: {},
    config_json: JSON.stringify(CONFIG),
    config_file_path: null,
    opencode_auth_json: JSON.stringify({
      relay: { type: "api", key: "sk-relay" },
    }),
    codex_auth_json: null,
    cline_secrets_json: null,
    codex_config_toml: null,
    codex_model_catalog: null,
    codex_sandbox_settings: null,
    grok_config_toml: null,
    grok_settings: null,
    hermes_config_yaml: null,
    cursor_cli_config_json: null,
    cursor_settings: null,
    model_provider_id: null,
    icon_url: null,
  }
}

describe("AcpAgentSettings — an OpenCode provider's models", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
    vi.mocked(listProviderModels).mockResolvedValue({
      url: "https://relay.test/v1/models",
      models: [{ id: "glm-5.2" }, { id: "kimi-k3" }],
    })
  })

  it("picks them from the provider's own list", async () => {
    const user = userEvent.setup()
    vi.mocked(acpListAgents).mockResolvedValue([openCodeAgent()])
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AcpAgentSettings />
      </NextIntlClientProvider>
    )
    // The provider's card, then its models.
    await user.click(await screen.findByRole("button", { name: /^relay/ }))
    await user.click(
      await screen.findByRole("button", { name: /Model Management/ })
    )
    await user.click(screen.getByRole("button", { name: "Choose models…" }))
    await waitFor(() =>
      expect(listProviderModels).toHaveBeenCalledWith({
        protocol: "openai",
        baseUrl: "https://relay.test/v1",
        keySource: { kind: "inline", apiKey: "sk-relay" },
        keyHeader: null,
      })
    )
    const dialog = await screen.findByRole("dialog")
    for (const id of ["kimi-k3", "old"]) {
      const row = within(dialog).getByText(id).closest("label")!
      await user.click(within(row).getByRole("checkbox"))
    }
    await user.click(
      within(dialog).getByRole("button", { name: "Use 2 models" })
    )

    await user.click(
      screen.getByRole("button", { name: "Save OpenCode Config" })
    )
    await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalled())
    const [, patch] = vi.mocked(acpUpdateAgentConfig).mock.calls[0]
    const saved = JSON.parse(patch.config_json ?? "{}")
    expect(saved.provider.relay.models).toEqual({
      "glm-5.2": { name: "GLM", limit: { context: 128000, output: 8192 } },
      "kimi-k3": { name: "kimi-k3" },
    })
  })
})
