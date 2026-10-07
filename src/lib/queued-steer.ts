import { isNoActiveTurnRejection } from "@/lib/turn-busy"

export async function deliverQueuedSteer(
  steer: () => Promise<unknown>,
  sendPrompt: () => Promise<void>
): Promise<void> {
  try {
    await steer()
  } catch (error) {
    if (!isNoActiveTurnRejection(error)) throw error
    await sendPrompt()
  }
}
