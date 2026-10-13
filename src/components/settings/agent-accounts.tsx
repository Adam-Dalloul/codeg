"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Copy, LogIn, Pencil, Plus, Trash2, Users } from "lucide-react"
import { toast } from "sonner"
import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  HeadlessSignIn,
  type AntigravityAuthMethod,
} from "./antigravity-config-panel"
import { copyTextToClipboard } from "@/lib/utils"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useAgentAccounts } from "@/hooks/use-agent-accounts"
import {
  createAgentAccount,
  renameAgentAccount,
  removeAgentAccount,
  loginAgentAccount,
  type AgentAccount,
} from "@/lib/agent-accounts"
import { toErrorMessage } from "@/lib/app-error"
import type { AgentType } from "@/lib/types"

export function AgentAccounts({ agentType }: { agentType: AgentType }) {
  const t = useTranslations("AgentAccounts")
  const agentText = useTranslations("AcpAgentSettings")
  const {
    accounts,
    capability,
    loading,
    error: loadError,
    refresh,
  } = useAgentAccounts(agentType)
  const [editing, setEditing] = useState<AgentAccount | "new" | null>(null)
  const [name, setName] = useState("")
  const [home, setHome] = useState("")
  const [removing, setRemoving] = useState<AgentAccount | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loginAccount, setLoginAccount] = useState<AgentAccount | null>(null)
  const [loginCommand, setLoginCommand] = useState<string | null>(null)
  const [loginMethod, setLoginMethod] =
    useState<AntigravityAuthMethod>("oauth-personal")

  async function signIn(account: AgentAccount) {
    setLoginAccount(account)
    setLoginCommand(null)
    setError(null)
    if (capability?.loginKind === "browser") return
    setBusy(true)
    try {
      const result = await loginAgentAccount(account.id)
      if (result.launched)
        toast.success(
          agentText("customAgentSignInLaunched", { home: result.home })
        )
      else setLoginCommand(result.command)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      if (editing === "new") await createAgentAccount(agentType, name, home)
      else if (editing) await renameAgentAccount(editing.id, name)
      setEditing(null)
      await refresh()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (loading)
    return (
      <div className="h-20 animate-pulse rounded-xl bg-muted/40" aria-busy />
    )
  if (loadError)
    return (
      <SettingCard>
        <SettingRow
          title={t("loadFailed")}
          control={
            <Button variant="outline" size="sm" onClick={refresh}>
              {t("retry")}
            </Button>
          }
        />
      </SettingCard>
    )
  if (!capability?.supported)
    return capability?.reason ? (
      <SettingCard>
        <SettingRow
          icon={Users}
          title={t("title")}
          description={
            agentType === "openclaw" ? t("gatewayAccount") : capability.reason
          }
        />
      </SettingCard>
    ) : null

  return (
    <>
      <SettingCard>
        <SettingRow
          icon={Users}
          title={t("title")}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busy || editing !== null}
              onClick={() => {
                setEditing("new")
                setName("")
                setHome("")
                setError(null)
              }}
            >
              <Plus className="size-3.5" />
              {t("add")}
            </Button>
          }
        />
        <SettingRow
          title={t("default")}
          description={t("defaultDescription")}
        />
        {capability.isolatesToolSettings && (
          <p className="px-4 pb-3 text-xs text-muted-foreground">
            {t("toolSettingsHint")}
          </p>
        )}
        {accounts
          .filter((account) => !account.removed)
          .map((account) => (
            <SettingRow
              key={account.id}
              title={account.name}
              description={<span className="break-all">{account.homeDir}</span>}
              control={
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    aria-label={`${t("signIn")}: ${account.name}`}
                    onClick={() => void signIn(account)}
                  >
                    <LogIn className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy || editing !== null}
                    aria-label={t("rename", { name: account.name })}
                    onClick={() => {
                      setEditing(account)
                      setName(account.name)
                      setError(null)
                    }}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    aria-label={t("remove", { name: account.name })}
                    onClick={() => setRemoving(account)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              }
            />
          ))}
        {loginAccount &&
          (loginCommand || capability?.loginKind === "browser") && (
            <div className="min-w-0 space-y-3 p-3">
              <p className="text-sm font-medium">{loginAccount.name}</p>
              {capability?.loginKind === "browser" ? (
                <>
                  <Select
                    value={loginMethod}
                    onValueChange={(value) =>
                      setLoginMethod(value as AntigravityAuthMethod)
                    }
                  >
                    <SelectTrigger aria-label={t("signIn")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(["oauth-personal", "oauth-business"] as const).map(
                        (method) => (
                          <SelectItem key={method} value={method}>
                            {agentText(`antigravity.methods.${method}`)}
                          </SelectItem>
                        )
                      )}
                    </SelectContent>
                  </Select>
                  <HeadlessSignIn
                    key={loginAccount.id}
                    method={loginMethod}
                    accountId={loginAccount.id}
                    disabled={busy}
                    needsSave={false}
                  />
                </>
              ) : (
                <>
                  <pre className="whitespace-pre-wrap break-all text-xs">
                    {agentText("customAgentSignInCommand", {
                      command: loginCommand ?? "",
                    })}
                  </pre>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      if (
                        loginCommand &&
                        (await copyTextToClipboard(loginCommand))
                      )
                        toast.success(t("copied"))
                    }}
                  >
                    <Copy className="size-3.5" />
                    {t("copyCommand")}
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLoginAccount(null)
                  setLoginCommand(null)
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          )}
        {editing && (
          <form
            className="space-y-3 p-3"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`account-name-${agentType}`}>{t("name")}</Label>
              <Input
                id={`account-name-${agentType}`}
                value={name}
                maxLength={80}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>
            {editing === "new" && (
              <div className="space-y-1.5">
                <Label htmlFor={`account-home-${agentType}`}>{t("home")}</Label>
                <Input
                  id={`account-home-${agentType}`}
                  value={home}
                  disabled={busy}
                  onChange={(event) => setHome(event.target.value)}
                  aria-describedby={`account-home-hint-${agentType}`}
                />
                <p
                  id={`account-home-hint-${agentType}`}
                  className="text-xs text-muted-foreground"
                >
                  {t("homeHint")}
                  {capability.configSubdir
                    ? ` ${t("homeLayout", { path: capability.configSubdir })}`
                    : ""}
                </p>
              </div>
            )}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy || !name.trim()}>
                {t("save")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                {t("cancel")}
              </Button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="p-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </SettingCard>
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("removeTitle", { name: removing?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              {t("removeDescription", { path: removing?.homeDir ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={async (event) => {
                event.preventDefault()
                if (!removing) return
                setBusy(true)
                setError(null)
                try {
                  await removeAgentAccount(removing.id)
                  setRemoving(null)
                  await refresh()
                } catch (err) {
                  setError(toErrorMessage(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t("removeAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
