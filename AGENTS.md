# AGENTS.md

This file provides guidance to Code Agent when working with code in this repository.

## 项目概述

Codeg（Code Generation）是一个多智能体编码工作台，它将多个智能体（Claude Code、Codex CLI、OpenCode、Gemini CLI、OpenClaw、Cline 等）统一到一个工作区中，支持会话聚合和多智能体协作，支持桌面安装，服务器/Docker 部署。

## 技术栈

- **桌面运行时**: Tauri 2（Rust 后端 + webview 前端）
- **服务器运行时**: 独立 Rust 二进制（Axum HTTP + WebSocket）
- **前端**: Next.js 16（静态导出模式）+ React 19 + TypeScript（strict）
- **样式**: Tailwind CSS v4 + shadcn/ui（radix-maia 风格）
- **国际化**: next-intl
- **数据库**: SeaORM + SQLite
- **包管理器**: pnpm

## 代码检查与测试（任务完成后进行必要的检查）

### 前端

```bash
pnpm lint .                    # lint
pnpm test                      # vitest 全跑（CI 用同一条命令）
pnpm test:watch                # 开发时增量重跑
pnpm test:coverage             # 覆盖率报告（输出到 coverage/index.html）
pnpm build                     # 静态导出构建
```

### 后端 Rust（在 `src-tauri/` 目录下执行）

```bash
# 桌面模式（默认 feature）
cargo check
cargo test --features test-utils
cargo clippy --all-targets --features test-utils -- -D warnings

# 服务器模式
cargo check --no-default-features --features server-bin --bin codeg-server
cargo test --no-default-features --features server-bin --bin codeg-server --lib
cargo clippy --no-default-features --features server-bin --bin codeg-server --lib -- -D warnings

# codeg-mcp 协作伴生进程（多智能体委托）
cargo check --no-default-features --features mcp-bin --bin codeg-mcp
cargo clippy --no-default-features --features mcp-bin --bin codeg-mcp -- -D warnings

# 解析器快照评审（输出变化时）
cargo insta review
INSTA_UPDATE=auto cargo test --features test-utils     # 自动写新 .snap
```

## 常见构建问题与避坑指南 (Troubleshooting)

### 1. Windows MSVC 4GB `.rlib` 链接器限制 (LNK4003 / LNK2019 / LNK1120)

- **现象**：
  在 Windows MSVC 环境下构建或测试（如 `cargo build --bin codeg`）时报错：
  ```text
  warning: LNK4003: 无效的库格式；已忽略库 '...\\libcodeg_lib-xxx.rlib'
  error: linking with `link.exe` failed: exit code: 1120
  ...
  libcodeg_lib-xxx.rlib : error LNK2019: 无法解析的外部符号 ...
  ```
- **根本原因**：
  Rust 默认开发配置使用 `debug = 2` 生成完整 AST 和变量调试信息。项目依赖较多时，核心库 `libcodeg_lib.rlib` 体积会膨胀超过 4GB（例如 4.27 GB）。MSVC 的 COFF/PE 归档格式使用 32 位偏移寻址，超出 4GB 限制导致归档损坏，`link.exe` 判定格式无效而跳过链接，引发连锁未解析符号错误。
- **解决方案（推荐方案）**：
  将 `debuginfo` 级别设为 1（保留文件名与行号，保持完整 panic 堆栈回溯，但不内嵌庞大的 AST 符号信息）：
  ```powershell
  # 1. 设置环境变量（当前终端生效）
  $env:RUSTFLAGS = "-C debuginfo=1"

  # 2. 删除已经损坏超过 4GB 的产物
  Remove-Item "src-tauri\target\debug\deps\*codeg_lib*" -Force -ErrorAction SilentlyContinue

  # 3. 重新构建
  cargo build --bin codeg
  ```
  设置 `debuginfo=1` 后，`libcodeg_lib.rlib` 体积会从 4.2GB+ 骤降至 200~300MB，链接顺利通过。
  持久化方案亦可在 `src-tauri/.cargo/config.toml` 中配置：
  ```toml
  [profile.dev]
  debug = 1
  ```

### 2. Git Worktree 与多 Agent 工作区隔离规范

- 为避免并行任务互相干扰，在多工作区（如 `worktree`）工作时：
  1. 必须始终在指定的物理工作目录执行文件读写与终端命令（禁止跨越至其他目录）。
  2. 禁止在独立工作区切换共享分支或破坏其他工作区的构建缓存。
  3. 若新建工作区缺少静态资源输出目录，Tauri 构建脚本可能检查 `..\out`，需确保 `out/` 占位目录存在。

### 3. Agent Client Protocol (ACP) 提问工具桥接

- Antigravity / Gemini CLI 原生提问工具（`ask_question` / `default_api:ask_question`）与标准 MCP 权限请求不同。
- `src-tauri/src/acp/` 模块中提供了 `try_bridge_antigravity_ask` 机制，将其转化为交互式问题卡片并在前端呈现，而不是误当作普通工具执行权限请求拦截。后续扩展智能体原生交互协议时需遵循此桥接流程。

## 架构

### 双模式运行

项目通过 Cargo feature flags 支持三种二进制：

- **`codeg`**（`tauri-runtime`，默认）：完整桌面应用，包含 Tauri 窗口管理、系统通知、自动更新等
- **`codeg-server`**（`--no-default-features --features server-bin`）：独立服务器模式，仅编译 Axum HTTP API + WebSocket
- **`codeg-mcp`**（`--no-default-features --features mcp-bin`）：per-launch stdio MCP 伴生进程，被注入到代理 CLI 的 MCP 配置中，向 LLM 暴露**异步**子智能体委托工具。

后两个（以及 `codeg-computer-helper` 的 `computer-helper`）各要一个默认不开的 feature：Tauri CLI 会把所有 feature 已开的二进制目标打进桌面安装包，不开就不进包。

### 共享核心

- **`app_state.rs`** — `AppState` 共享状态结构，两种模式通过 `EventEmitter` 枚举区分事件发射方式
- **`web/event_bridge.rs`** — `EventEmitter::Tauri(AppHandle)` 或 `EventEmitter::WebOnly(Arc<WebEventBroadcaster>)`
- **`web/router.rs`** — Axum 路由，接受 `Arc<AppState>`
- **`web/handlers/`** — HTTP API 端点，全部使用 `Extension<Arc<AppState>>`

### Rust 后端（`src-tauri/src/`）

后端负责读取和解析本地文件系统上的代理会话文件：

- **`app_state.rs`** — 共享状态（db、连接管理器、终端管理器、事件广播器）
- **`models/`** — 共享数据结构
- **`parsers/`** — 每个智能体一个解析器
- **`commands/`** — 业务逻辑，`_core` 函数供两种模式共用，`#[tauri::command]` 函数仅桌面模式
- **`web/`** — Axum HTTP API + WebSocket + 静态文件服务 + 认证中间件
- **`acp/`** — Agent Client Protocol 连接管理
- **`db/`** — SeaORM + SQLite

### 前端（`src/`）

#### 核心库（`lib/`）

- **`transport/`** — Transport 抽象层（自动检测 Tauri/Web 环境切换 `invoke()`/`fetch()`）
- **`adapters/`** — AI 响应到组件渲染的适配器
- **`types.ts`** — Rust 模型的 TypeScript 镜像
- **`api.ts`** — 主 API 客户端
- **`tauri.ts`** — Tauri API 封装

#### 国际化（`i18n/`）

- 支持 10 种语言：英语、简体中文、繁体中文、日语、韩语、西班牙语、德语、法语、葡萄牙语、阿拉伯语
- 使用 next-intl 框架，消息文件存放在 `i18n/messages/`

### 数据流

桌面模式：前端 `invoke()` → Tauri 命令 → 业务逻辑 → 返回数据
服务器模式：前端 `fetch()` → Axum HTTP API → 同一业务逻辑 → 返回 JSON
实时通信：后端事件 → EventEmitter（Tauri 事件 / WebSocket 广播）→ 前端

### 条件编译约定

- `#[cfg(feature = "tauri-runtime")]` — 仅桌面模式编译（Tauri 窗口、通知、`tauri::State` 参数等）
- `#[cfg_attr(feature = "tauri-runtime", tauri::command)]` — 函数始终可用，仅在桌面模式标记为 Tauri 命令
- `_core` 后缀函数 — 接受普通引用参数（`&AppDatabase`、`&EventEmitter`），供 Web handlers 和 Tauri 命令共用

## 关键约束

- **仅支持静态导出**：`next.config.ts` 设置 `output: "export"`，不支持动态路由（`[param]`），必须使用查询参数替代
- **路径别名**：`@/*` 映射到 `./src/*`，导入写法为 `@/lib/utils`、`@/components/ui/button`
- **服务器部署**：通过环境变量配置（`CODEG_PORT`、`CODEG_HOST`、`CODEG_TOKEN`、`CODEG_DATA_DIR`、`CODEG_STATIC_DIR`）
- **Docker 支持**：多阶段构建（Node.js + Rust），支持 `docker-compose` 一键部署

## 代码风格

- Prettier：无分号、尾逗号（es5）、2 空格缩进、80 字符宽度
- ESLint：next/core-web-vitals + typescript + prettier
- TypeScript：strict 模式，启用 `noUnusedLocals` 和 `noUnusedParameters`
- Rust：2021 edition，使用 `thiserror` 定义错误类型
