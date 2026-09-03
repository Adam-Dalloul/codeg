/**
 * 终端虚拟键栏（移动端）纯函数：键栏按键 → PTY 字节序列 + CTRL/ALT 闩锁包装。
 *
 * 序列规则对齐服务端 terminals.ts 的 encodeTerminalKey：
 *   · 方向键/Home/End 带修饰符 → xterm 修饰序列 ESC[1;<m>X（Ctrl+↑=ESC[1;5A）
 *   · PgUp/PgDn 带修饰符      → ESC[5;<m>~ / ESC[6;<m>~
 *   · 修饰参数 m = 1 + (alt?2:0) + (ctrl?4:0)
 *
 * 闩锁语义：CTRL/ALT 是一次性粘滞键——点一下 armed（按钮高亮，互斥），下一个
 * 输入（软键盘 onData 或键栏按键）被包装后自动弹起：
 *   · CTRL + 软键盘字母 → 控制码（a→\x01 … z→\x1a，覆盖 Ctrl+C/D/L/R…）
 *   · ALT  + 软键盘输入 → 前缀 ESC（meta）
 */

export type TermKeyBarKey =
  | "esc"
  | "tab"
  | "slash"
  | "dash"
  | "home"
  | "end"
  | "pgup"
  | "pgdn"
  | "up"
  | "down"
  | "left"
  | "right"

/** CTRL/ALT 闩锁状态（键栏按钮高亮与编码共用）。 */
export interface TermMods {
  ctrl: boolean
  alt: boolean
}

/** 无修饰符时的基础序列。 */
export const TERM_KEYBAR_SEQ: Record<TermKeyBarKey, string> = {
  esc: "\x1b",
  tab: "\t",
  slash: "/",
  dash: "-",
  home: "\x1b[H",
  end: "\x1b[F",
  pgup: "\x1b[5~",
  pgdn: "\x1b[6~",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
}

function modParam(mods: TermMods): number {
  return 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
}

/** 键栏按键编码（不消费闩锁——由调用方在发送后复位）。 */
export function termKeySeq(key: TermKeyBarKey, mods: TermMods): string {
  const plain = TERM_KEYBAR_SEQ[key]
  if (!mods.ctrl && !mods.alt) return plain
  // CSI 1;<m>X 族：方向键 + Home/End
  const finals: Partial<Record<TermKeyBarKey, string>> = {
    up: "A",
    down: "B",
    right: "C",
    left: "D",
    home: "H",
    end: "F",
  }
  const final = finals[key]
  if (final) return `\x1b[1;${modParam(mods)}${final}`
  // ~ 族：PgUp/PgDn
  if (key === "pgup") return `\x1b[5;${modParam(mods)}~`
  if (key === "pgdn") return `\x1b[6;${modParam(mods)}~`
  // esc/tab/slash/dash 没有通用 ctrl 形态：alt 仍走 meta 前缀，ctrl 原样
  if (mods.alt) return `\x1b${plain}`
  return plain
}

/**
 * 用闩锁包装一段软键盘输入。只处理首字符，返回要发送的字节与闩锁是否被消费。
 * `consumed=true` 时调用方应复位 mods 状态。
 */
export function applyTermMods(
  data: string,
  mods: TermMods
): { out: string; consumed: boolean } {
  if (!data || (!mods.ctrl && !mods.alt)) {
    return { out: data, consumed: false }
  }
  const { ctrl, alt } = mods
  let out = data
  if (ctrl) {
    const code = data[0].toLowerCase().charCodeAt(0)
    if (code >= 97 && code <= 122) {
      out = String.fromCharCode(code - 96) + data.slice(1)
    }
  } else if (alt) {
    out = `\x1b${data}`
  }
  return { out, consumed: true }
}

/**
 * 软键盘遮挡估算：布局视口高 - 可视视口高 - 可视视口下移量 = 底部被键盘遮住的像素。
 * overlap < minOpen（默认 80px）视为地址栏收起/缩放等抖动，返回 0。
 */
export function kbdLiftPx(
  innerHeight: number,
  vvHeight: number,
  vvOffsetTop: number,
  minOpen = 80
): number {
  const overlap = Math.max(0, Math.round(innerHeight - vvHeight - vvOffsetTop))
  return overlap >= minOpen ? overlap : 0
}
