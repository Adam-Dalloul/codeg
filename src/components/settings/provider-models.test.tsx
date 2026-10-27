/**
 * The shared "fetch models" pieces: the request a form makes, a result that
 * only ever speaks for the URL and key it was fetched with, the id field's
 * dropdown, and picking several ids without losing configured ones.
 */
import { useState } from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  providerModelsRequest,
  useProviderModels,
  type ProviderModelsInput,
} from "@/hooks/use-provider-models"
import { listProviderModels } from "@/lib/api"
import type { ProviderModelList } from "@/lib/types"

import {
  FetchedModelPicker,
  ModelIdInputWithFetch,
  ProviderModelsFetchButton,
  ProviderModelsStatus,
} from "./provider-models"

vi.mock("@/lib/api", () => ({ listProviderModels: vi.fn() }))

function listed(...ids: string[]): ProviderModelList {
  return {
    url: "https://relay.test/v1/models",
    models: ids.map((id) => ({ id })),
  }
}

describe("providerModelsRequest", () => {
  it("says what is missing, and prefers a typed key over a saved one", () => {
    const base: ProviderModelsInput = {
      protocol: "openai",
      baseUrl: " https://relay.test/v1 ",
      apiKey: " sk-typed ",
    }
    expect(providerModelsRequest({ ...base, baseUrl: " " }).missing).toBe(
      "baseUrl"
    )
    expect(providerModelsRequest({ ...base, apiKey: "" }).missing).toBe(
      "apiKey"
    )
    expect(providerModelsRequest(base).request).toEqual({
      protocol: "openai",
      baseUrl: "https://relay.test/v1",
      keySource: { kind: "inline", apiKey: "sk-typed" },
      keyHeader: null,
    })
    // A saved provider lists with its stored key unless one is typed.
    expect(
      providerModelsRequest({ ...base, apiKey: "", providerId: 4 }).request
        ?.keySource
    ).toEqual({ kind: "provider", providerId: 4, apiKey: "" })
    expect(providerModelsRequest(null)).toEqual({
      request: null,
      missing: null,
    })
  })
})

function Form({ initialKey = "sk-a" }: { initialKey?: string }) {
  const [apiKey, setApiKey] = useState(initialKey)
  const [model, setModel] = useState("")
  const models = useProviderModels({
    protocol: "openai",
    baseUrl: "https://relay.test/v1",
    apiKey,
  })
  return (
    <div>
      <input
        aria-label="key"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <ProviderModelsFetchButton state={models} />
      <ProviderModelsStatus state={models} />
      <ModelIdInputWithFetch
        aria-label="model"
        value={model}
        onChange={setModel}
        models={models.models}
      />
    </div>
  )
}

function renderWithIntl(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("useProviderModels and the id field", () => {
  beforeEach(() => {
    // Braced: a function handed back from beforeEach runs as its teardown.
    vi.mocked(listProviderModels).mockReset()
  })

  it("offers the listed ids, and drops them once the key changes", async () => {
    const user = userEvent.setup()
    vi.mocked(listProviderModels).mockResolvedValue(
      listed("glm-5.2", "kimi-k3")
    )
    renderWithIntl(<Form />)
    await user.click(screen.getByRole("button", { name: "Fetch models" }))
    expect(
      await screen.findByText("The provider lists 2 models.")
    ).toBeVisible()

    await user.click(
      screen.getByRole("button", { name: "Choose from the provider's models" })
    )
    await user.click(await screen.findByRole("option", { name: /kimi-k3/ }))
    expect(screen.getByLabelText("model")).toHaveValue("kimi-k3")

    await user.type(screen.getByLabelText("key"), "x")
    expect(screen.queryByText("The provider lists 2 models.")).toBeNull()
    expect(
      screen.queryByRole("button", {
        name: "Choose from the provider's models",
      })
    ).toBeNull()
  })

  it("ignores an answer to a request the form moved away from", async () => {
    const user = userEvent.setup()
    let answer: (list: ProviderModelList) => void = () => {}
    vi.mocked(listProviderModels).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    renderWithIntl(<Form />)
    await user.click(screen.getByRole("button", { name: "Fetch models" }))
    await user.type(screen.getByLabelText("key"), "b")
    answer(listed("stale"))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText(/The provider lists/)).toBeNull()
  })

  it("needs a key, and says why a fetch failed in the user's language", async () => {
    const user = userEvent.setup()
    renderWithIntl(<Form initialKey="" />)
    expect(screen.getByRole("button", { name: "Fetch models" })).toBeDisabled()
    expect(
      screen.getByText(
        "Enter the API key first: the models are listed with it."
      )
    ).toBeVisible()

    vi.mocked(listProviderModels).mockImplementation(async () => {
      throw {
        code: "network_error",
        message: "no model list",
        i18n_key: "providerModels.not_found",
        i18n_params: { url: "https://relay.test/v1/models", status: "404" },
      }
    })
    await user.type(screen.getByLabelText("key"), "sk")
    await user.click(screen.getByRole("button", { name: "Fetch models" }))
    expect(
      await screen.findByText(
        "No model list at https://relay.test/v1/models (HTTP 404)."
      )
    ).toBeVisible()
  })
})

function Picker({
  configured,
  onConfirm,
}: {
  configured: string[]
  onConfirm: (ids: string[]) => void
}) {
  const models = useProviderModels({
    protocol: "openai",
    baseUrl: "https://relay.test/v1",
    apiKey: "sk",
  })
  return (
    <FetchedModelPicker
      state={models}
      configured={configured}
      onConfirm={onConfirm}
    />
  )
}

describe("FetchedModelPicker", () => {
  beforeEach(() => {
    // Braced: a function handed back from beforeEach runs as its teardown.
    vi.mocked(listProviderModels).mockReset()
  })

  it("fetches on open, keeps configured ids the provider does not list, and keeps their order", async () => {
    const user = userEvent.setup()
    vi.mocked(listProviderModels).mockResolvedValue(
      listed("a-model", "b-model", "c-model")
    )
    const onConfirm = vi.fn()
    renderWithIntl(
      <Picker configured={["c-model", "mine"]} onConfirm={onConfirm} />
    )
    await user.click(screen.getByRole("button", { name: "Choose models…" }))
    const dialog = await screen.findByRole("dialog")
    // Configured but not listed: shown first, picked, marked.
    const mine = within(dialog).getByText("mine").closest("label")!
    expect(within(mine).getByText("Not listed")).toBeVisible()
    expect(within(mine).getByRole("checkbox")).toBeChecked()

    const a = within(dialog).getByText("a-model").closest("label")!
    await user.click(within(a).getByRole("checkbox"))
    await user.click(
      within(dialog).getByRole("button", { name: "Use 3 models" })
    )
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith(["c-model", "mine", "a-model"])
    )
  })
})
