# Rust Rewrite Plan — pi / pi-tui / pi-sdk / pi-web

**Status:** research + plan (no implementation yet)
**Goal:** a line-by-line, 100% feature- and bug-parity port of the pi coding-agent
stack from TypeScript to Rust.
**Date:** 2026-07-02

---

## 0. What "pi", "pi-tui", "pi-sdk", "pi-web" actually are

The four names map onto **five** TypeScript packages that live behind the single
npm dependency `@earendil-works/pi-coding-agent@0.80.2` (plus the local `pi-web`
repo). Confirmed by reading each package's `dist/*.d.ts` and `package.json`:

| Requested name | Real package(s)                   | Role                                                        | JS LOC¹      | d.ts LOC |
| -------------- | --------------------------------- | ----------------------------------------------------------- | ------------ | -------- |
| **pi**         | `@earendil-works/pi-coding-agent` | CLI, tools, extensions, interactive/rpc/print modes, themes | ~41,600      | 8,577    |
| **pi-sdk**     | `@earendil-works/pi-agent-core`   | Agent loop, harness, session tree, compaction, FS/shell env | ~5,400       | 1,920    |
| (also pi-sdk)  | `@earendil-works/pi-ai`           | Providers, model registry, streaming, auth/OAuth, images    | ~30,600      | 43,600   |
| **pi-tui**     | `@earendil-works/pi-tui`          | Differential terminal renderer, components, keys, overlays  | ~9,800       | 1,806    |
| **pi-web**     | `pi-web` (this repo)              | Bun host + browser UI wrapping the SDK in-process           | ~10,846 (TS) | —        |

¹ Compiled `dist` JS line counts. Original TS source is available (public MIT repo +
full sourcemaps): ~106k lines of TS across the four packages (pi-coding-agent 50.8k /
pi-ai 34.9k / pi-tui 12.1k / pi-agent-core 8.1k) + ~10.8k of pi-web TS ≈ **~117k lines
to port**.

> **Source of truth.** Port from original TypeScript, available two ways:
>
> 1. **Public MIT monorepo `github.com/earendil-works/pi`** — each package's
>    `package.json` `repository.directory` points at `packages/{ai,agent,tui,coding-agent}`.
>    Ships the real source **and the upstream `vitest` test suites**.
> 2. **Embedded sourcemaps** — every shipped `dist/*.js.map` has `sourcesContent`
>    populated (355/355 maps; `sources: ["../src/agent.ts"]` etc.), ~106k lines of TS.
>
> **Directives:**
>
> - Vendor `earendil-works/pi` at tag **v0.80.2** (the version this repo depends on)
>   into `pi-rs/reference-src/`. Port every crate from this checkout, not from `dist`.
> - Port the upstream `vitest` suites as the primary per-crate parity gate (§8).
> - Vendor the upstream LICENSE + copyright at workspace root (MIT).
> - Define parity against the pinned v0.80.2 tag only. Upstream ships multiple
>   releases/week; to advance the baseline, `git diff v0.80.2..<newtag>` + changelog
>   triage, then port deltas. Never target `main`.

### 0.1 Dependency graph (what depends on what)

```
pi-web (Bun host + browser)
   └── @earendil-works/pi-coding-agent      (createAgentSession, ExtensionAPI, tools, TUI components, themes)
          ├── @earendil-works/pi-agent-core (Agent, AgentHarness, Session, compaction, ExecutionEnv)
          │      └── @earendil-works/pi-ai  (Models, Provider, stream, Context/Message, auth)
          ├── @earendil-works/pi-ai
          └── @earendil-works/pi-tui        (TUI, Component, Editor, Markdown, keys, overlays)
```

Rust must preserve this layering so each crate stays independently testable, exactly
as the TS packages are.

---

## 1. Target Rust workspace

A single Cargo workspace mirroring the package boundaries 1:1, so parity can be
verified crate-by-crate against each npm package.

```
pi-rs/
├── Cargo.toml                # [workspace]
├── crates/
│   ├── pi-ai/                # ← @earendil-works/pi-ai
│   ├── pi-agent-core/        # ← @earendil-works/pi-agent-core   (the "SDK")
│   ├── pi-tui/               # ← @earendil-works/pi-tui
│   ├── pi-coding-agent/      # ← @earendil-works/pi-coding-agent (the "pi" CLI + lib)
│   │   └── src/bin/pi.rs     #   the `pi` binary
│   ├── pi-web-host/          # ← pi-web/src/host  (Axum/Hyper server, in-process agent)
│   ├── pi-web-sdk/           # ← pi-web/src/sdk   (piweb surface, wasm-facing)
│   └── pi-web-frontend/      # ← pi-web/src/web   (WASM browser UI, Leptos/Yew or wasm-bindgen)
└── xtask/                    # build/bundle/golden-test orchestration
```

### 1.1 Language/runtime mapping decisions

| TS / Bun / Node concept                      | Rust choice                                                    | Notes                                            |
| -------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `async`/`await`, Promises, event loop        | `tokio` (multi-thread) + `async-trait`                         | Single runtime across host + agent               |
| `AbortSignal`                                | `tokio_util::sync::CancellationToken`                          | Thread it through every `execute`/`stream`       |
| `EventStream<T,R>` (async iterable + result) | `futures::Stream<Item=T>` + a final `R` (custom stream struct) | §2.4                                             |
| `typebox` `TSchema` / `Static<T>`            | `serde` + `schemars` (JSON Schema) or `garde`/`jsonschema`     | Tool params validate against emitted JSON Schema |
| `TSchema` structural validation              | `jsonschema` crate at the tool boundary                        | Keep runtime validation identical                |
| `node:http` server + SSE                     | `hyper`/`axum` + `tokio` SSE (`text/event-stream`)             | pi-web host                                      |
| Bun `Bun.build` bundling browser TS          | `trunk` / `wasm-pack` build of `pi-web-frontend`               | Frontend is WASM, not transpiled TS              |
| `happy-dom` DOM in unit tests                | `wasm-bindgen-test` in headless Chrome                         | DOM tests run in real browser                    |
| Playwright e2e                               | keep Playwright (drives the built WASM app) OR `fantoccini`    | Reuse existing `.e2e.ts` where possible          |
| `chalk` ANSI                                 | `owo-colors` / manual SGR (parity needs exact codes)           | TUI needs byte-exact escapes                     |
| `Intl.Segmenter` (grapheme clustering)       | `unicode-segmentation`                                         | Editor word-wrap parity                          |
| `diff` (Myers)                               | `similar`                                                      | edit/write tool diffs                            |
| `highlight.js` (transcript highlight)        | `syntect` (host) / `syntect`-to-CSS (frontend)                 | Must match token classes for parity              |
| `web-tree-sitter` (project ext highlight)    | `tree-sitter` native crate                                     | Only used by `.pi/extensions`                    |
| `@silvia-odwyer/photon-node` (image resize)  | `image` + `fast_image_resize`, or keep photon via wasm         | Image tool + clipboard images                    |
| `proper-lockfile`                            | `fs4`/`fd-lock`                                                | Session file locks                               |
| `undici` HTTP client                         | `reqwest` (HTTP/2, streaming)                                  | Provider requests                                |
| `jiti` (runtime TS extension loading)        | embedded JS engine (`rquickjs`) — see §7                       | Extensions are user `.ts` files                  |

---

## 2. `pi-ai` crate (provider + streaming layer)

The foundation: model catalog, provider auth, and the streaming protocol every
higher layer consumes. Public d.ts surface is huge (43k lines) but mostly
per-provider option structs; the **core contracts** are small.

### 2.1 Core value types (`types.rs`)

```rust
pub type Api = String;         // "anthropic-messages" | "openai-responses" | ... | (other)
pub type ProviderId = String;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Content {
    Text { text: String, #[serde(skip_serializing_if="Option::is_none")] text_signature: Option<String> },
    Thinking { thinking: String, thinking_signature: Option<String>, #[serde(default)] redacted: bool },
    Image { data: String, mime_type: String },
    ToolCall { id: String, name: String, arguments: serde_json::Value, thought_signature: Option<String> },
}

#[derive(Clone)]
pub struct Usage {
    pub input: u64, pub output: u64, pub cache_read: u64, pub cache_write: u64,
    pub cache_write_1h: Option<u64>, pub total_tokens: u64, pub cost: Cost,
}
pub enum StopReason { Stop, Length, ToolUse, Error, Aborted }

pub enum Message {                      // tagged by `role` in JSON
    User(UserMessage),
    Assistant(AssistantMessage),
    ToolResult(ToolResultMessage),
}
pub struct Context { pub system_prompt: Option<String>, pub messages: Vec<Message>, pub tools: Option<Vec<Tool>> }

pub struct Tool { pub name: String, pub description: String, pub parameters: serde_json::Value /* JSON Schema */ }

pub enum ThinkingLevel { Off, Minimal, Low, Medium, High, XHigh }
pub enum Transport { Sse, Websocket, WebsocketCached, Auto }
```

### 2.2 Streaming event protocol (`event_stream.rs`)

Direct port of the `AssistantMessageEvent` union. Each variant carries the running
`partial: AssistantMessage`, exactly as TS.

```rust
pub enum AssistantMessageEvent {
    Start        { partial: AssistantMessage },
    TextStart    { content_index: usize, partial: AssistantMessage },
    TextDelta    { content_index: usize, delta: String, partial: AssistantMessage },
    TextEnd      { content_index: usize, content: String, partial: AssistantMessage },
    ThinkingStart{ content_index: usize, partial: AssistantMessage },
    ThinkingDelta{ content_index: usize, delta: String, partial: AssistantMessage },
    ThinkingEnd  { content_index: usize, content: String, partial: AssistantMessage },
    ToolCallStart{ content_index: usize, partial: AssistantMessage },
    ToolCallDelta{ content_index: usize, delta: String, partial: AssistantMessage },
    ToolCallEnd  { content_index: usize, partial: AssistantMessage },
    Done         { message: AssistantMessage },
    Error        { message: AssistantMessage },
}

/// Port of `EventStream<T, R>`: an async stream of events that also yields a
/// terminal result once drained (the final AssistantMessage).
pub struct EventStream<T, R> { /* inner mpsc + JoinHandle producing R */ }
impl<T, R> EventStream<T, R> {
    pub fn stream(&mut self) -> impl Stream<Item = T> + '_;
    pub async fn result(self) -> Result<R, StreamError>;
}
pub type AssistantMessageEventStream = EventStream<AssistantMessageEvent, AssistantMessage>;
```

### 2.3 Model + Provider + Models (`models.rs`)

```rust
pub struct Model {
    pub id: String, pub name: String, pub api: Api, pub provider: ProviderId,
    pub reasoning: bool, pub thinking_level_map: Option<ThinkingLevelMap>,
    pub input: Vec<InputKind>,          // Text | Image
    pub cost: ModelCost, pub context_window: u64, pub max_tokens: u64,
    pub base_url: Option<String>, pub headers: Option<HashMap<String,String>>,
    pub compat: Option<OpenAICompat>,
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn base_url(&self) -> Option<&str>;
    fn auth(&self) -> &dyn ProviderAuth;
    fn get_models(&self) -> Vec<Model>;
    async fn refresh_models(&self) -> Result<(), ModelsError> { Ok(()) }
    fn stream(&self, model: &Model, ctx: Context, opts: Option<StreamOptions>) -> AssistantMessageEventStream;
    fn stream_simple(&self, model: &Model, ctx: Context, opts: Option<SimpleStreamOptions>) -> AssistantMessageEventStream;
}

#[async_trait]
pub trait Models: Send + Sync {
    fn get_providers(&self) -> Vec<Arc<dyn Provider>>;
    fn get_provider(&self, id: &str) -> Option<Arc<dyn Provider>>;
    fn get_models(&self, provider: Option<&str>) -> Vec<Model>;
    fn get_model(&self, provider: &str, id: &str) -> Option<Model>;
    async fn refresh(&self, provider: Option<&str>) -> Result<(), ModelsError>;
    async fn get_auth(&self, model: &Model) -> Option<RequestAuth>;
    fn stream_simple(&self, model: &Model, ctx: Context, opts: Option<SimpleStreamOptions>) -> AssistantMessageEventStream;
}
```

### 2.4 API codecs (the real work) + provider configs (data)

The effort is **~12 shared API codecs**. From `pi-ai/src/api/*`: `anthropic-messages`,
`openai-responses`,
`openai-completions`, `openai-codex-responses`, `azure-openai-responses`,
`bedrock-converse-stream`, `google-generative-ai`, `google-vertex`,
`openai-completions`, `openai-codex-responses`, `azure-openai-responses`,
`bedrock-converse-stream`, `google-generative-ai`, `google-vertex`,
`mistral-conversations`, `cloudflare`, `faux` (test provider), plus `images/*`. Each
becomes a `Provider`-facing request/response codec. **Byte-level parity of request
payloads and SSE parsing is required.**

The `src/providers/*` layer is then **~33 provider configs that are mostly data**
(base URL, headers, model tables, which codec + auth to use): anthropic, openai,
azure, deepseek, google, google-vertex, bedrock, mistral, groq, cerebras,
cloudflare-ai-gateway, cloudflare-workers-ai, xai, openrouter, vercel-ai-gateway,
zai (×2), opencode(-go), huggingface, fireworks, together, kimi-coding, minimax(-cn),
xiaomi + xiaomi-token-plan (×3 regions), github-copilot, nvidia, ant-ling, … Port
these as declarative tables over the codecs, not bespoke modules. Enumerate the set
from `src/providers/*` at the pinned v0.80.2 tag (§0).

### 2.5 Auth / OAuth (`auth/*`)

Port `ProviderAuth`, `CredentialStore`, `AuthContext`, and the OAuth device/PKCE
flows (`utils/oauth/*`). Trait:

```rust
#[async_trait]
pub trait ProviderAuth: Send + Sync {
    async fn resolve(&self, cx: &AuthContext) -> Result<AuthResult, ModelsError>;
    fn source_label(&self) -> Option<String>;
}
#[async_trait]
pub trait CredentialStore: Send + Sync {
    async fn get(&self, key: &str) -> Option<AuthCredential>;
    async fn set(&self, key: &str, cred: AuthCredential) -> Result<(), StoreError>;
    async fn delete(&self, key: &str) -> Result<(), StoreError>;
}
```

---

## 3. `pi-agent-core` crate (the "SDK": agent loop + harness + sessions)

### 3.1 Agent messages & tools (`types.rs`)

```rust
/// `CustomAgentMessages` declaration-merging becomes an enum extension point.
pub enum AgentMessage { Llm(Message), Custom(CustomMessage) }

pub struct AgentToolResult<T> {
    pub content: Vec<Content>,      // Text | Image only
    pub details: T,
    pub terminate: Option<bool>,
}
pub type AgentToolUpdate<T> = Box<dyn Fn(AgentToolResult<T>) + Send>;

#[async_trait]
pub trait AgentTool: Send + Sync {
    fn name(&self) -> &str;
    fn label(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> &serde_json::Value;              // JSON Schema
    fn execution_mode(&self) -> Option<ToolExecutionMode> { None }
    fn prepare_arguments(&self, args: serde_json::Value) -> serde_json::Value { args }
    async fn execute(&self, call_id: &str, params: serde_json::Value,
                     cancel: CancellationToken,
                     on_update: Option<AgentToolUpdate<serde_json::Value>>)
        -> Result<AgentToolResult<serde_json::Value>, ToolError>;
}

pub enum ToolExecutionMode { Sequential, Parallel }
pub enum QueueMode { All, OneAtATime }
```

### 3.2 Agent state + events (`agent.rs`)

Port the `Agent` class and `AgentEvent` union verbatim. State uses interior
mutability behind an `Arc<Mutex<…>>`; the copy-on-assign semantics of
`state.tools`/`state.messages` become explicit setters.

```rust
pub enum AgentEvent {
    AgentStart,
    AgentEnd { messages: Vec<AgentMessage> },
    TurnStart,
    TurnEnd { message: AgentMessage, tool_results: Vec<ToolResultMessage> },
    MessageStart { message: AgentMessage },
    MessageUpdate { message: AgentMessage, event: AssistantMessageEvent },
    MessageEnd { message: AgentMessage },
    ToolExecutionStart  { tool_call_id: String, tool_name: String, args: serde_json::Value },
    ToolExecutionUpdate { tool_call_id: String, tool_name: String, args: serde_json::Value, partial: serde_json::Value },
    ToolExecutionEnd    { tool_call_id: String, tool_name: String, result: serde_json::Value, is_error: bool },
}

pub struct Agent { /* state, listeners, steering/followup queues, active run */ }
impl Agent {
    pub fn new(options: AgentOptions) -> Self;
    pub fn subscribe(&self, l: AgentListener) -> Unsubscribe;   // listener: (event, CancellationToken)
    pub fn state(&self) -> AgentStateSnapshot;
    pub fn steer(&self, msg: AgentMessage);
    pub fn follow_up(&self, msg: AgentMessage);
    pub fn clear_all_queues(&self);
    pub fn abort(&self);
    pub async fn wait_for_idle(&self);
    pub fn reset(&self);
    pub async fn prompt(&self, input: PromptInput) -> Result<(), AgentError>;
    pub async fn r#continue(&self) -> Result<(), AgentError>;
}
```

### 3.3 Low-level agent loop (`agent_loop.rs`)

Port `agentLoop`, `agentLoopContinue`, `runAgentLoop`, `runAgentLoopContinue` and the
whole `AgentLoopConfig` hook set (`convert_to_llm`, `transform_context`,
`should_stop_after_turn`, `prepare_next_turn`, `get_steering_messages`,
`get_follow_up_messages`, `before_tool_call`, `after_tool_call`, sequential/parallel
tool execution with completion-order `tool_execution_end` + source-order results).

```rust
pub struct AgentLoopConfig {
    pub model: Model,
    pub convert_to_llm: Box<dyn Fn(Vec<AgentMessage>) -> BoxFuture<Vec<Message>> + Send + Sync>,
    pub transform_context: Option<...>,
    pub should_stop_after_turn: Option<...>,
    pub prepare_next_turn: Option<...>,
    pub get_steering_messages: Option<...>,
    pub get_follow_up_messages: Option<...>,
    pub before_tool_call: Option<...>,
    pub after_tool_call: Option<...>,
    pub tool_execution: ToolExecutionMode,
    // + SimpleStreamOptions fields
}
pub fn agent_loop(prompts: Vec<AgentMessage>, ctx: AgentContext, cfg: AgentLoopConfig,
                  cancel: CancellationToken) -> EventStream<AgentEvent, Vec<AgentMessage>>;
```

### 3.4 Harness capability traits (`harness/env.rs`)

The `FileSystem` / `Shell` / `ExecutionEnv` interfaces are the clean-room seam the
whole agent runs on. **Every method returns `Result<T, FileError|ExecutionError>`
and must never panic** (mirrors the TS "never throw" contract).

```rust
pub enum FileErrorCode { Aborted, NotFound, PermissionDenied, NotDirectory, IsDirectory, Invalid, NotSupported, Unknown }
pub struct FileError { pub code: FileErrorCode, pub message: String, pub path: Option<String> }

#[async_trait]
pub trait FileSystem: Send + Sync {
    fn cwd(&self) -> &str;
    async fn absolute_path(&self, p: &str, c: Option<CancellationToken>) -> Result<String, FileError>;
    async fn join_path(&self, parts: &[String], c: Option<CancellationToken>) -> Result<String, FileError>;
    async fn read_text_file(&self, p: &str, c: Option<CancellationToken>) -> Result<String, FileError>;
    async fn read_text_lines(&self, p: &str, opts: ReadLinesOpts) -> Result<Vec<String>, FileError>;
    async fn read_binary_file(&self, p: &str, c: Option<CancellationToken>) -> Result<Vec<u8>, FileError>;
    async fn write_file(&self, p: &str, content: Bytes, c: Option<CancellationToken>) -> Result<(), FileError>;
    async fn append_file(&self, p: &str, content: Bytes, c: Option<CancellationToken>) -> Result<(), FileError>;
    async fn file_info(&self, p: &str, c: Option<CancellationToken>) -> Result<FileInfo, FileError>;
    async fn list_dir(&self, p: &str, c: Option<CancellationToken>) -> Result<Vec<FileInfo>, FileError>;
    async fn canonical_path(&self, p: &str, c: Option<CancellationToken>) -> Result<String, FileError>;
    async fn exists(&self, p: &str, c: Option<CancellationToken>) -> Result<bool, FileError>;
    async fn create_dir(&self, p: &str, opts: CreateDirOpts) -> Result<(), FileError>;
    async fn remove(&self, p: &str, opts: RemoveOpts) -> Result<(), FileError>;
    async fn create_temp_dir(&self, prefix: Option<&str>, c: Option<CancellationToken>) -> Result<String, FileError>;
    async fn create_temp_file(&self, opts: TempFileOpts) -> Result<String, FileError>;
    async fn cleanup(&self);
}

#[async_trait]
pub trait Shell: Send + Sync {
    async fn exec(&self, command: &str, opts: ShellExecOptions) -> Result<ExecOutput, ExecutionError>;
    async fn cleanup(&self);
}
pub trait ExecutionEnv: FileSystem + Shell {}
```

`env/nodejs.rs` → a `TokioExecutionEnv` implementing both traits on the real FS +
`tokio::process`.

### 3.5 Session tree (`harness/session/*`)

Port the discriminated `SessionTreeEntry` union, `SessionStorage`, `SessionRepo`,
JSONL + in-memory repos, `uuidv7`, and `buildSessionContext`. The session tree
(fork/navigate/leaf) is subtle — it needs a dedicated golden-test corpus (§8).

```rust
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionTreeEntry {
    Message(MessageEntry), ThinkingLevelChange(..), ModelChange(..), ActiveToolsChange(..),
    Compaction(..), BranchSummary(..), Custom(..), CustomMessage(..), Label(..), SessionInfo(..), Leaf(..),
}
#[async_trait]
pub trait SessionStorage: Send + Sync {
    async fn get_metadata(&self) -> SessionMetadata;
    async fn get_leaf_id(&self) -> Option<String>;
    async fn set_leaf_id(&self, id: Option<String>) -> Result<(), SessionError>;
    async fn create_entry_id(&self) -> Result<String, SessionError>;
    async fn append_entry(&self, e: SessionTreeEntry) -> Result<(), SessionError>;
    async fn get_entry(&self, id: &str) -> Option<SessionTreeEntry>;
    async fn find_entries(&self, ty: &str) -> Vec<SessionTreeEntry>;
    async fn get_label(&self, id: &str) -> Option<String>;
    async fn get_path_to_root(&self, leaf: Option<&str>) -> Vec<SessionTreeEntry>;
    async fn get_entries(&self) -> Vec<SessionTreeEntry>;
}
```

### 3.6 AgentHarness (`harness/agent_harness.rs`)

Port the `AgentHarness` orchestrator and its full typed event/hook system
(`AgentHarnessEvent` own-events, `on(type, handler) -> Result`), compaction,
branch summarization, tree navigation, prompt/steer/followUp/nextTurn, model/tools/
thinking mutation with session persistence. This is the largest single class.

### 3.7 Compaction & prompts

Port `compaction/*` (`estimate_tokens`, `find_cut_point`, `should_compact`,
`generate_summary`, `serialize_conversation`), `branch-summarization`,
`prompt-templates`, `system-prompt`, `skills`. Token estimation must match to keep
compaction trigger points identical (bug parity).

---

## 4. `pi-tui` crate (terminal renderer)

### 4.1 Core rendering model (`tui.rs`)

```rust
pub trait Component {
    fn render(&mut self, width: usize) -> Vec<String>;    // lines, ANSI-inclusive
    fn handle_input(&mut self, _data: &str) {}
    fn wants_key_release(&self) -> bool { false }
    fn invalidate(&mut self);
}
pub trait Focusable: Component { fn set_focused(&mut self, focused: bool); }

pub const CURSOR_MARKER: &str = "\x1b_pi:c\x07";

pub struct Container { pub children: Vec<Box<dyn Component>> }
pub struct TUI { /* terminal, previous_lines, overlay_stack, focus, kitty state, ... */ }
impl TUI {
    pub fn new(terminal: Box<dyn Terminal>, show_hardware_cursor: bool) -> Self;
    pub fn start(&mut self);
    pub fn stop(&mut self);
    pub fn request_render(&mut self, force: bool);
    pub fn set_focus(&mut self, c: Option<ComponentId>);
    pub fn show_overlay(&mut self, c: Box<dyn Component>, opts: OverlayOptions) -> OverlayHandle;
    pub fn hide_overlay(&mut self);
    pub fn add_input_listener(&mut self, l: InputListener) -> Unsubscribe;
    pub async fn query_terminal_background_color(&mut self, timeout: Duration) -> Option<RgbColor>;
    pub async fn query_terminal_color_scheme(&mut self, timeout: Duration) -> Option<TerminalColorScheme>;
}
```

The **differential renderer** (previous-line diff, kitty image reserved rows,
overlay compositing, cursor extraction, min-render-interval throttling) is the
parity-critical core; it must be reproduced algorithm-for-algorithm from `tui.js`.

### 4.2 Terminal abstraction (`terminal.rs`)

```rust
pub trait Terminal: Send {
    fn start(&mut self, on_input: InputCb, on_resize: ResizeCb);
    fn stop(&mut self);
    fn drain_input(&mut self, max: Duration, idle: Duration) -> BoxFuture<()>;
    fn write(&mut self, data: &str);
    fn columns(&self) -> usize;
    fn rows(&self) -> usize;
    fn kitty_protocol_active(&self) -> bool;
    fn move_by(&mut self, lines: i32);
    fn hide_cursor(&mut self); fn show_cursor(&mut self);
    fn clear_line(&mut self); fn clear_from_cursor(&mut self); fn clear_screen(&mut self);
    fn set_title(&mut self, title: &str);
    fn set_progress(&mut self, active: bool);
}
pub struct ProcessTerminal { /* raw mode, Kitty negotiation, StdinBuffer, Windows VT input */ }
```

Use `crossterm` for raw mode / size / Windows VT, but keep the **Kitty keyboard
protocol negotiation and `StdinBuffer` sequence-splitting** as hand-ported logic
(crossterm doesn't cover pi's exact progressive-enhancement handshake).

### 4.3 Keys (`keys.rs`)

Port `parseKey`, `matchesKey`, `KeyId` grammar, Kitty CSI-u decoding
(`decodeKittyPrintable`), release/repeat detection. `KeyId` is a huge TS template-
literal union; in Rust model it as a parsed `KeyChord { base, ctrl, shift, alt, super }`
with `FromStr` and a `matches(&str)` helper (keep the string API for extension parity).

### 4.4 Components (`components/*`)

Port each: `Box`, `Text`, `Spacer`, `TruncatedText`, `Markdown`, `Image`,
`Input`, `Editor`, `Loader`, `CancellableLoader`, `SelectList`, `SettingsList`.
The **`Editor`** is the biggest (paste markers, kill-ring, undo stack, history,
autocomplete, sticky visual-column table, word-wrap via `Intl.Segmenter`) — port its
private methods 1:1 and drive with the same input sequences in tests.

### 4.5 Utilities

`utils.rs` (`visibleWidth`, `truncateToWidth`, `sliceByColumn`, `wrapTextWithAnsi`),
`terminal-colors.rs` (OSC 11 parsing), `terminal-image.rs` (Kitty + iTerm2 encoding,
PNG/JPEG/GIF/WebP dimension probing, capability detection), `fuzzy.rs`,
`keybindings.rs`, `autocomplete.rs`, `kill-ring.rs`, `undo-stack.rs`,
`word-navigation.rs`, `native-modifiers.rs`, `stdin-buffer.rs`.

---

## 5. `pi-coding-agent` crate (the `pi` CLI + library)

The largest crate. Groups:

### 5.1 Tools (`core/tools/*`) — behavior-exact

`read`, `write`, `edit` (+`edit-diff`), `bash` (+`bash-executor`, spawn hooks,
output accumulator/guard, truncation), `grep`, `find`, `ls`, `path-utils`,
`file-mutation-queue`, `render-utils`. Each tool:

```rust
pub struct ToolDefinition<P, D, S> {
    pub name: String, pub description: String, pub parameters: serde_json::Value,
    pub prompt_guidelines: Option<String>,
    pub execute: ExecuteFn<P, D>, pub render_call: Option<RenderFn>, pub render_result: Option<RenderFn>,
}
pub fn create_bash_tool(opts: BashToolOptions) -> ToolDefinition<BashToolInput, BashToolDetails, ()>;
pub fn create_read_tool(opts: ReadToolOptions) -> ToolDefinition<..>;
// ... edit, write, grep, find, ls
pub fn create_coding_tools(opts: ToolsOptions) -> Vec<ToolDefinition<..>>;
```

Diff output (`similar`), truncation (`truncateHead/Tail/Line`, `DEFAULT_MAX_BYTES`/
`DEFAULT_MAX_LINES`) and size formatting must be byte-identical (they appear in the
transcript and thus in parity screenshots).

### 5.2 Extension system (`core/extensions/*`) — the `ExtensionAPI` surface

Port `ExtensionAPI` (the big `on(event, handler)` registry + `registerTool`,
`registerCommand`, `registerShortcut`, `registerProvider`, `sendMessage`,
`setModel`, …), `ExtensionContext`, `ExtensionUIContext`, `ExtensionRunner`,
`loader`, `wrapper`, the full `ExtensionEvent` union, and every `*EventResult` type.

```rust
pub trait ExtensionApi {
    fn on(&mut self, event: ExtensionEventType, handler: ExtensionHandler);
    fn register_tool(&mut self, tool: ToolDefinition<Value, Value, Value>);
    fn register_command(&mut self, name: &str, opts: RegisteredCommandOpts);
    fn register_shortcut(&mut self, chord: &str, opts: ShortcutOpts);
    fn register_flag(&mut self, name: &str, opts: FlagOpts);
    fn register_message_renderer(&mut self, custom_type: &str, r: MessageRenderer);
    fn register_provider(&mut self, name: &str, cfg: ProviderConfig);
    fn send_message(&self, m: CustomMessageInput, opts: SendOpts);
    fn send_user_message(&self, content: MessageContent, opts: SendUserOpts);
    async fn set_model(&self, m: Model) -> bool;
    fn events(&self) -> &EventBus;
    // ... full surface (see docs/extension-points.md)
}
```

`ExtensionUIContext` (select/confirm/input/notify/setStatus/setWidget/setFooter/
setHeader/custom/editor/addAutocompleteProvider/setEditorComponent/theme…) is the
contract `pi-web` mirrors — port it precisely (§6).

**Blocker:** extensions are user-authored `.ts`/`.js` executed at runtime via `jiti`.
See §7 for the strategy (WASM/QuickJS/deno_core). The _type surface_ ports cleanly;
the _execution host_ is the hard part.

### 5.3 Session/config/model management

`agent-session.rs` (the `AgentSession` façade — model cycling, compaction,
bash, tree nav, stats, HTML/JSONL export, retry, extension binding),
`agent-session-runtime`, `agent-session-services`, `sdk.rs`
(`create_agent_session`, `create_coding_tools`, factory fns — the entry point
`pi-web` calls), `session-manager`, `settings-manager`, `model-registry`,
`model-resolver`, `resource-loader`, `package-manager`, `trust-manager`,
`slash-commands`, `keybindings`, `auth-storage`, `event-bus`,
`footer-data-provider`, `system-prompt`, `skills`, `compaction/*`.

```rust
pub async fn create_agent_session(opts: CreateAgentSessionOptions)
    -> Result<CreateAgentSessionResult, SdkError>;
```

### 5.4 Modes (`modes/*`)

- `interactive/` — the full TUI app (footer, model/theme/session/thinking selectors,
  message components, editor, dialogs). ~40 components. Depends on `pi-tui`.
- `rpc/` — JSONL RPC protocol (`rpc-client`, `rpc-mode`, `rpc-types`). **Port first**:
  a stable machine protocol makes cross-language differential testing against the
  TS binary trivial (§8).
- `print/` — non-interactive one-shot.

### 5.5 CLI + utils

`cli/*` (arg parsing → `clap`, config/session/model pickers, startup UI),
`main.rs`, `config.rs`, `migrations.rs`, and `utils/*` (git, clipboard,
image-convert/resize, exif, frontmatter, mime, html, syntax-highlight, paths,
shell, changelog, version-check). `bin/pi.rs` wires it together.

---

## 6. `pi-web` crates (full source available → true line-by-line port)

This is the one layer we can port literally. Split into three crates.

### 6.1 `pi-web-host` (← `src/host/`, ~2,300 LOC of server + adapters)

`server.ts` (2,801 LOC) → `server.rs` on **axum**: SSE bus (`/events?thread=`),
POST command bus, thread runtimes, session index, git-branch watcher, footer/header
frames, welcome, trust prompts, bash runner, theme loading, file/dir listing.

```rust
// router.ts → router.rs (flat method+path table; ids in body/query)
pub struct Router { table: HashMap<(Method, String), RouteHandler>, fallback: Option<RouteHandler> }

// piweb-host.ts (926 LOC) → the `PiWebSurface` registry: docks/overlays, widgets,
// footer/header factories, custom surfaces, action dispatch, autocomplete, dialogs.
pub struct PiWebRegistry { /* per-thread surfaces, state, action ids -> handlers */ }

// component-adapter.ts → adapt a pi-tui `Component` (render(width)->lines) into the
// serializable node vocabulary (AnsiBlock/Box/Spacer/Image). Trait-driven:
pub enum AdaptedNode { AnsiBlock{lines:Vec<String>}, Box{..}, Spacer{lines:usize}, Image{..} }
pub fn component_to_node(c: &mut dyn Component, cols: usize) -> AdaptedNode;
pub fn render_tool_call_to_node(r: &ToolRenderers, p: ToolRenderParams) -> Value;
pub fn render_tool_result_to_node(r: &ToolRenderers, p: ToolRenderParams) -> Value;
```

Because the host runs the agent **in-process**, `pi-web-host` depends directly on
`pi-coding-agent` (no subprocess), exactly like the TS host importing the SDK.

### 6.2 `pi-web-sdk` (← `src/sdk/piweb.ts`, 318 LOC)

Port `PiWebSurface`, `FooterData`, `ThemeVars`, autocomplete types, and the
no-op-when-no-host degradation. In Rust this is the shared type crate used by both
host and (compiled-to-WASM) extensions; the `globalThis.__PIWEB__` Proxy becomes a
host-provided handle.

```rust
pub trait PiWebSurface {
    fn present(&self) -> bool;
    fn set_widget(&self, key: &str, content: Option<WidgetContent>, opts: Option<Value>);
    fn custom(&self, factory: CustomFactory, opts: CustomOptions) -> BoxFuture<Option<Value>>;
    fn notify(&self, message: &str, level: NotifyLevel);
    fn set_status(&self, key: &str, text: Option<&str>);
    fn set_footer(&self, factory: Option<FooterFactory>);
    fn set_header(&self, factory: Option<HeaderFactory>);
    fn register_message_renderer(&self, ty: &str, r: MessageRenderer);
    fn add_autocomplete_provider(&self, f: AutocompleteProviderFactory);
    fn select(&self, title: &str, options: Vec<String>, opts: DialogOptions) -> BoxFuture<Option<String>>;
    fn confirm(&self, title: &str, message: &str, opts: DialogOptions) -> BoxFuture<bool>;
    fn input(&self, title: &str, placeholder: Option<&str>, opts: DialogOptions) -> BoxFuture<Option<String>>;
    fn editor(&self, title: &str, prefill: Option<&str>, opts: DialogOptions) -> BoxFuture<Option<String>>;
    // ... full surface
}
```

### 6.3 `pi-web-frontend` (← `src/web/`, ~7,900 LOC browser TS)

Compile to WASM (**Leptos or Yew**, or raw `wasm-bindgen` + `web-sys` to keep the
imperative DOM code close to the TS). Port every module: `app.ts` (2,773 LOC — the
transcript renderer, node renderer, SSE client, keyboard, composer wiring),
`nodes.ts` (the static node → DOM vocabulary), `pi-composer`, `pi-tool`, `pi-bash`,
`pi-thinking`, `pi-frame`, `markdown`, `ansi` (SGR→HTML), `diff`, `fuzzy`,
`highlight` (→ `syntect`), `tools`, `welcome`.

The **node vocabulary** (`Box`/`Container`/`Text`/`Spacer`/`Image`/`Markdown`/
`AnsiBlock`/`Row`/`Divider` + web-only `Frame`/`Button`/`Input`) is the serialization
contract between host and frontend and must round-trip byte-identically — it is the
key to the "render-model parity" the project already documents in
`docs/render-model-parity.md`. Keep that doc as the conformance spec.

---

## 7. Subsystems requiring a dedicated spike before their crate

1. **Runtime extension execution (`jiti`).** pi loads user `.ts`/`.js` extensions at
   runtime and hands them a live `ExtensionAPI`. Embed `rquickjs` (QuickJS) and expose
   `ExtensionAPI`/`ExtensionUIContext` as host bindings so existing JS extension
   bundles run unchanged. Validate against the `.pi/extensions/context-bar` example
   first. (Do not use a WASM/WIT component model — it breaks existing `.ts` extensions.)
2. **`typebox` → schema validation.** Tool params are `TSchema` validated at runtime.
   Port to `serde` structs + JSON-Schema (`schemars`) emission so the LLM sees the same
   schema, and validate incoming tool args with the `jsonschema` crate to reproduce the
   same accept/reject behavior on malformed args.
3. **Provider wire-format parity.** SSE framing, payload shapes, thinking-signature
   passthrough, cache headers, retry/backoff, and error classification differ per
   provider and are load-bearing. Build a **recorded-cassette** corpus (VCR-style)
   captured from the TS implementation at v0.80.2, replayed against the Rust providers.

---

## 8. Oracle & verification (built for coding-agent execution)

The port is executed by coding agents running a red→green loop. The agents optimize
to whatever signal they are given, so **the oracle _is_ the specification** and its
fidelity is the ceiling on the whole port. Phase 0 builds the oracle and the
anti-reward-hacking guardrails before any Rust behavior is written. Correctness is
defined as _byte-identical observable output to the pinned TS `pi` @ v0.80.2_, never
as "reads plausibly correct."

### 8.1 The oracle (`pi-oracle`)

A pinned-v0.80.2 TS harness that exposes every subsystem's observable behavior in a
deterministic, byte-comparable form. Two modes, both authoritative:

- **Live oracle** — a long-lived TS process wrapping `reference-src/` that, given an
  input (JSONL command stream, key sequence, tool call, provider cassette, session
  file, editor op log), returns the exact observable output. Agents query it on demand
  to generate expectations for any unit.
- **Recorded fixtures** — the live oracle's outputs, captured once and checked in as
  immutable golden files (`oracle/<crate>/<unit>/<case>.json|.bytes`). CI replays these
  so the build is hermetic and does not need the TS stack on every run.

Every Rust unit maps to one or more oracle fixtures. A unit with no fixture cannot be
started (no red test to author against).

### 8.2 Determinism seams (must exist before agents touch code)

Without these, every diff is a false positive and agents will "fix" red tests by
weakening assertions. Both stacks inject and identically seed: **clock**, **RNG**,
**uuidv7 generator**, **cwd/env**, **temp-dir names**, **map/set iteration order**,
and the **tool-execution completion scheduler** (§3.3). A shared **normalization**
pass strips or canonicalizes anything still non-deterministic (absolute paths,
timings) identically on both sides. The seam layer is itself oracle-tested.

### 8.3 Comparison layers (the mechanisms the oracle drives)

1. **RPC differential harness (primary integration gate).** Port `modes/rpc` first;
   drive TS and Rust with identical JSONL command streams; assert identical JSONL event
   streams. Covers the whole agent/session/tool surface headlessly.
2. **Provider cassettes.** Recorded provider SSE replayed against both stacks; assert
   identical `AgentMessage` sequences, usage/cost accounting, compaction trigger points.
   Drive agent-core deterministically with the **`faux` provider** where no network
   behavior is under test.
3. **TUI golden frames.** Scripted key sequences into a fake `Terminal`; snapshot
   emitted escape-sequence buffers byte-for-byte (cursor math, differential redraw,
   kitty images). The input corpus must include **astral-plane / grapheme / combining**
   cases to expose UTF-16(TS)↔UTF-8(Rust) column-math divergence.
4. **Editor op-log oracle + property tests.** Replay editor op logs against both; add
   `proptest` fuzzing comparing Rust editor state to the live oracle.
5. **pi-web parity suite.** Reuse `test/*.test.mjs`, `test/e2e/*.e2e.ts`, and
   `docs/render-model-parity.md`: identical serialized node trees for identical agent
   events; Playwright drives the WASM frontend against the same DOM assertions.
6. **Session-tree corpus.** Golden JSONL sessions exercising fork/navigate/compact/
   branch-summary; assert identical `getPathToRoot` / `buildSessionContext` output.
7. **Ported upstream `vitest` suites (primary per-crate gate).** Vendor them at the
   pinned tag; port each package's tests to Rust `#[test]`s. `pi-web` ships ~23 of its
   own test files to reuse.

### 8.4 Coverage regime (the numeric gate)

Per unit, three gates must be simultaneously green:

- **Dual 100% branch coverage** under one shared corpus — TS reference via `c8`,
  Rust via `cargo-llvm-cov`. A branch covered on only one side is a divergence signal.
- **Differential equivalence** — every corpus input byte-matches the oracle (§8.3).
- **0 surviving mutants** — `cargo-mutants` (Rust) + Stryker (TS reference) prove the
  assertions actually bite.

Corpus is grown by: ported vitest suites → coverage-guided differential fuzzing
(libFuzzer/AFL on Rust, every input replayed to the oracle) → coverage-hole triage
from the `c8` report until zero uncovered branches remain. Genuinely unreachable code
(dead branches, `unreachable!()`, platform-gated) goes on a **human-reviewed exclusion
allowlist** with a justification per entry; "100%" means 100% of non-allowlisted code.

### 8.5 Anti-reward-hacking guardrails (load-bearing for agent execution)

The least-effort way to turn a red test green is to weaken the check. These make that
impossible without detection:

- **Immutable oracle.** Fixtures, cassettes, golden frames, and ported assertions are
  write-once. An agent implementing a unit **cannot modify its own oracle**; oracle
  changes are a separate, reviewed change class (human or a distinct oracle-author
  agent), diffed and approved on their own.
- **Mutation gate is not optional** — it is the primary defense proving assertions
  survived the agent's edits.
- **Exclusion allowlist is a human gate** — otherwise agents exclude their way to 100%.
- **Assertion/normalization changes are reviewed diffs** — any weakening of a
  comparison (added tolerance, stripped field) is surfaced explicitly and rejected by
  default.
- **Separation of duties** — the agent that authors an oracle fixture is not the agent
  that implements against it.

### 8.6 The per-unit development loop (red→green)

For every unit, in order, non-negotiable: **(1)** obtain/record the failing oracle
fixture (red); **(2)** transliterate the TS source until the fixture and ported unit
tests pass (green); **(3)** run the coverage + mutation gates; **(4)** refactor with
the differential harness green. A Rust module may not be committed with implementation
ahead of a failing test that pins it. Coverage/mutation/fuzz run in CI and file new
red fixtures back into the same loop.

### 8.7 The agent unit of work

Agent-sized units are one module or function with: a pinned oracle fixture (§8.1), the
relevant determinism seam (§8.2), a coverage+mutation gate (§8.4), and the
immutable-test rule (§8.5). Each unit is independently verifiable and
independently mergeable, so many agents run in parallel without a shared design model
— the source supplies the structure, the oracle supplies the correctness.

### 8.8 Pin everything to v0.80.2

All oracle fixtures, cassettes, golden frames, and ported suites are captured from the
v0.80.2 checkout (§0). To advance the baseline: `git diff v0.80.2..<newtag>` →
regenerate affected fixtures via the live oracle → agents re-close the newly-red units.

---

## 9. Phasing (agent-executed, oracle-gated)

Every deliverable is decomposed into agent-sized units (§8.7). The gate for **every**
unit is uniform: **dual-100% branch coverage + 0 surviving mutants + differential
equivalence to the oracle**. The per-phase gate below names the dominant oracle layer;
it does not relax that bar.

**Phase 0 is the product-defining phase** — it builds the oracle and guardrails that
cap the entire effort's fidelity. Do not start Phase 1 until 0 is complete.

| Phase | Deliverable                                                                                                                                                                                                                                 | Depends on | Oracle / gate                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------ |
| 0     | Vendor `earendil-works/pi` @ **v0.80.2** + LICENSE into `reference-src/`; build **`pi-oracle`** (live + recorded), determinism seams (§8.2), normalization, coverage+mutation+fuzz CI, immutable-oracle guardrails (§8.5), RPC diff harness | —          | oracle reproduces TS output deterministically; guardrails enforced in CI |
| 1     | `pi-ai`: types, EventStream, Models/Provider traits, **anthropic + openai** codecs, auth                                                                                                                                                    | 0          | cassette + vitest parity, gates green                                    |
| 2     | `pi-agent-core`: Agent, agent-loop, ExecutionEnv (tokio), sessions (JSONL), harness, compaction                                                                                                                                             | 1          | RPC diff + `faux`-driven vitest, gates green                             |
| 3     | `pi-coding-agent` tools (read/write/edit/bash/grep/find/ls) + sdk `create_agent_session` + rpc/print modes                                                                                                                                  | 2          | RPC + print diff, gates green                                            |
| 4     | `pi-tui`: renderer, terminal, keys, Text/Box/Spacer/Markdown/Image, Editor                                                                                                                                                                  | 0          | golden frames incl. astral-plane corpus, gates green                     |
| 5     | `pi-coding-agent` interactive mode + selectors + themes + extension **type** surface                                                                                                                                                        | 3,4        | TUI golden frames, gates green                                           |
| 6     | Extension execution host (`rquickjs` + jiti-equivalent TS loader) + remaining provider codecs/configs                                                                                                                                       | 5          | extension-conformance corpus (not one example), gates green              |
| 7     | `pi-web-host` + `pi-web-sdk` (axum, in-process agent, SSE/POST, piweb registry)                                                                                                                                                             | 3,6        | `test/*.test.mjs` + node-tree parity, gates green                        |
| 8     | `pi-web-frontend` (WASM)                                                                                                                                                                                                                    | 7          | Playwright e2e + render-model-parity conformance                         |
| 9     | Remaining utils, image/photon, migrations, windows-self-update, hardening                                                                                                                                                                   | all        | full differential suite green                                            |

**Highest-confidence deliverable (recommended primary target):** Phases 0–3 — the
headless agent (`pi-ai` + `pi-agent-core` + tools + rpc/print). Fully deterministic,
oracle-checked, decomposable; ideal for agent execution. Phases 4–8 are gated on how
completely their behavior can be encoded as deterministic fixtures; Phase 6's
extension-loader semantics are the one target still under-specified and should be
treated as a research spike before commitment.

---

## Appendix A — files inventoried during research

- `pi-tui/dist`: `tui.d.ts`, `terminal.d.ts`, `keys.d.ts`, `components/*.d.ts`,
  `autocomplete/keybindings/fuzzy/terminal-image/utils` — full index read.
- `pi-agent-core/dist`: `index/types/agent/agent-loop/harness(types,agent-harness,
session,compaction,messages,system-prompt,skills,env)` — full type surface read.
- `pi-ai/dist`: `index/types/models/compat/event-stream/auth/*` — core contracts read
  (per-provider option structs skimmed).
- `pi-coding-agent/dist`: `index.d.ts` (full export map), `core/extensions/types.d.ts`
  (ExtensionAPI/events), `core/agent-session.d.ts`, `core/sdk`, `core/tools/*`,
  `modes/*`, `ExtensionUIContext` — read.
- `pi-web/src`: `sdk/piweb.ts`, `host/router.ts`, `host/server.ts` (structure),
  `host/component-adapter.ts` (signatures), `web/nodes.ts` — read; `docs/*.md`
  (`render-model-parity`, `extension-points`, `frontend-extension-runtime`, `widget`)
  are the conformance specs.
