import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { QuotaRead } from "@/hooks/use-subscription-quota"
import { SessionQuotaChip } from "./session-quota-chip"

const state = vi.hoisted(() => ({ data: null as QuotaRead | null }))
vi.mock("@/hooks/use-subscription-quota", () => ({
  useSubscriptionQuota: () => ({
    data: state.data,
    loading: false,
    refresh: async () => {},
  }),
}))
vi.mock("@/lib/platform", () => ({ openUrl: vi.fn() }))
beforeEach(() => {
  state.data = null
})

it("does not label a failed named-account read as Default", async () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SessionQuotaChip agentType="claude_code" agentAccountId="work" />
    </NextIntlClientProvider>
  )
  await userEvent.click(screen.getByRole("button", { name: "Usage remaining" }))
  expect(screen.getByText("Usage unavailable")).toBeVisible()
  expect(screen.queryByText("Default")).not.toBeInTheDocument()
})

it("labels a confirmed Default read and shows its remaining percentage", async () => {
  state.data = {
    agentType: "claude_code",
    agentAccountId: null,
    family: "claude",
    name: null,
    checkedAt: 1780000000,
    payload: { five_hour: { utilization: 20 } },
  }
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SessionQuotaChip agentType="claude_code" />
    </NextIntlClientProvider>
  )
  await userEvent.click(screen.getByRole("button", { name: "80% left" }))
  expect(screen.getByText("Default")).toBeVisible()
})
