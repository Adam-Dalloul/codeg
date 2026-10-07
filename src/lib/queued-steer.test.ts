import { describe, expect, it, vi } from "vitest"
import { deliverQueuedSteer } from "./queued-steer"

describe("queued native insert", () => {
  it("does not send the message again after native delivery", async () => {
    const steer = vi.fn(async () => {})
    const send = vi.fn(async () => {})
    await deliverQueuedSteer(steer, send)
    expect(steer).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
  })

  it("sends a normal prompt when the turn ended before insertion", async () => {
    const steer = vi.fn(async () => {
      throw new Error("no active turn for feedback")
    })
    const send = vi.fn(async () => {})
    await deliverQueuedSteer(steer, send)
    expect(send).toHaveBeenCalledOnce()
  })

  it("keeps a failed insertion available for retry without resending it", async () => {
    const failure = new Error("connection lost")
    const send = vi.fn(async () => {})
    await expect(
      deliverQueuedSteer(async () => {
        throw failure
      }, send)
    ).rejects.toBe(failure)
    expect(send).not.toHaveBeenCalled()
  })

  it("does not report delivery when the normal prompt fails", async () => {
    const failure = new Error("turn already in progress")
    await expect(
      deliverQueuedSteer(
        async () => {
          throw "no active turn"
        },
        async () => {
          throw failure
        }
      )
    ).rejects.toBe(failure)
  })
})
