/**
 * Tailscale Funnel command builders.
 *
 * Funnel is official Tailscale HTTPS to the internet. Relays do not decrypt.
 * The local target is always loopback so the Codeg token remains the app gate
 * and the service is not bound on LAN.
 */

export class FunnelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FunnelError"
  }
}

export function funnelTarget(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new FunnelError("port must be an integer 1-65535")
  }
  return `http://127.0.0.1:${port}`
}

export function funnelEnableArgs(port: number): string[] {
  return ["funnel", "--bg", "--yes", funnelTarget(port)]
}

export function funnelDisableArgs(): string[] {
  return ["funnel", "reset"]
}

export function funnelStatusArgs(): string[] {
  return ["funnel", "status", "--json"]
}

export function isLoopbackTarget(target: string): boolean {
  try {
    const url = new URL(target)
    return url.hostname === "127.0.0.1" || url.hostname === "localhost"
  } catch {
    return false
  }
}

/** Public Funnel HTTPS first, then local bind addresses. */
export function displayAddresses(
  local: string[],
  funnelUrl?: string | null
): string[] {
  if (funnelUrl && !local.includes(funnelUrl)) {
    return [funnelUrl, ...local]
  }
  return local
}
