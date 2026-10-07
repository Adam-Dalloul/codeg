import { describe, expect, it, vi } from "vitest"
import { deliverQueuedSteer } from "./queued-steer"

describe("queued native insert", () => {
  it("does not send the message again after native delivery", async () => {
    const steer = vi.fn(async () => {})
    const send = vi.fn(async () => {})
    expect(await deliverQueuedSteer(steer, send)).toBe(true)
    expect(steer).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
  })

  it("prioritizes the queued row without sending when the turn ended before insertion", async () => {
    const steer = vi.fn(async () => {
      throw new Error("no active turn for feedback")
    })
    const prioritize = vi.fn()
    expect(await deliverQueuedSteer(steer, prioritize)).toBe(false)
    expect(prioritize).toHaveBeenCalledOnce()
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

  it("does not prioritize or report delivery when the turn is busy", async () => {
    const failure = new Error("turn already in progress")
    const prioritize = vi.fn()
    await expect(
      deliverQueuedSteer(async () => {
        throw failure
      }, prioritize)
    ).rejects.toBe(failure)
    expect(prioritize).not.toHaveBeenCalled()
  })
})
