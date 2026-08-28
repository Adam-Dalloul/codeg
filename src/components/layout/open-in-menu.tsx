"use client"

import { FolderClosed, SquareTerminal } from "lucide-react"

import { VSCodeIcon } from "@/components/vscode-icon"
import {
  ContextMenuItem,
  ContextMenuSubContent,
} from "@/components/ui/context-menu"

const itemClassName = "gap-1.5 px-3"

export function OpenInSubContent({
  explorerLabel,
  terminalLabel,
  codeLabel,
  onOpenExplorer,
  onOpenTerminal,
  onOpenCode,
  explorerDisabled,
}: {
  explorerLabel: string
  terminalLabel: string
  codeLabel: string
  onOpenExplorer: () => void
  onOpenTerminal: () => void
  onOpenCode: () => void
  explorerDisabled?: boolean
}) {
  return (
    <ContextMenuSubContent className="min-w-0 w-max">
      <ContextMenuItem
        className={itemClassName}
        disabled={explorerDisabled}
        onSelect={onOpenExplorer}
      >
        <FolderClosed />
        {explorerLabel}
      </ContextMenuItem>
      <ContextMenuItem className={itemClassName} onSelect={onOpenTerminal}>
        <SquareTerminal />
        {terminalLabel}
      </ContextMenuItem>
      <ContextMenuItem className={itemClassName} onSelect={onOpenCode}>
        <VSCodeIcon />
        {codeLabel}
      </ContextMenuItem>
    </ContextMenuSubContent>
  )
}
