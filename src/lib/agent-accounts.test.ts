import { beforeEach, expect, it, vi } from "vitest"
import {
  agentAccountKey,
  readSelectedAccount,
  saveSelectedAccount,
} from "./agent-accounts"
import { getActiveRemoteConnectionId } from "./transport"

vi.mock("./transport", () => ({
  getTransport: vi.fn(),
  getActiveRemoteConnectionId: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  vi.mocked(getActiveRemoteConnectionId).mockReturnValue(null)
})

it("keeps model preferences and remembered accounts separate across families and servers", () => {
  expect(agentAccountKey("codex")).toBe("codex")
  expect(agentAccountKey("codex", "a")).not.toBe(agentAccountKey("codex", "b"))
  saveSelectedAccount("codex", "local-account")
  expect(readSelectedAccount("claude_code")).toBeNull()
  vi.mocked(getActiveRemoteConnectionId).mockReturnValue(42)
  expect(readSelectedAccount("codex")).toBeNull()
  saveSelectedAccount("codex", "remote-account")
  expect(readSelectedAccount("codex")).toBe("remote-account")
  vi.mocked(getActiveRemoteConnectionId).mockReturnValue(null)
  expect(readSelectedAccount("codex")).toBe("local-account")
  saveSelectedAccount("codex", null)
  expect(readSelectedAccount("codex")).toBeNull()
})
