# Changelog

## 1.0.9

- **A model the upstream has retired is no longer offered.** Google keeps a
  retired model in `fetchAvailableModels` for a while, quota reading and all, so
  it looked live in every picker — but generating with it returns the notice
  "Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash"
  in place of an answer. The same response already names the retired ids in
  `deprecatedModelIds`; that field was being parsed and stored and then read by
  nothing. Those ids are now dropped from the quota snapshot, which is the one
  source the model picker, the accounts panel and the quota pools all build
  from, so a dead model disappears from all three at once.

  Deliberately not done: forwarding a request for a retired model onto its
  replacement. The upstream reports what each retirement was replaced by, but
  silently answering from a different model than the one picked would be
  invisible in the reply and would spend the other model's quota.

- **What the upstream retires is logged.** `Models retired upstream` (at debug
  level) lists every id Google reports as deprecated, its replacement, and
  whether it was among the models offered. A model that stops working without
  appearing in that list is one this filter cannot catch, and comparing the two
  is how that gets spotted.

## 1.0.8

- **Requests no longer go to the host that refuses them.** Generate calls were
  sent to `cloudcode-pa.googleapis.com` first. That host meters this traffic far
  more tightly than the two alternatives: on accounts sitting at full quota it
  answers the very first request of a session with `RESOURCE_EXHAUSTED`, and no
  amount of pacing or account rotation gets around it, because the limit is not
  the account's. Every account reading 100% in the panel while every request
  came back 429 was this, and the quota lookups in this same extension had been
  quietly using the sandbox host first all along. Generate calls now follow the
  same order — sandbox, then daily, then production as a last resort.

- **The request identifies itself the way the real client does.** The endpoints
  meter an unrecognised caller much harder than a known one, and several
  fingerprint fields were wrong or missing:

  - `x-client-name`, `x-client-version`, `x-machine-id` and `x-vscode-sessionid`
    were not sent at all. VS Code already keeps the right values — `machineId`
    is stable per install, `sessionId` per window.
  - `requestId` was a bare UUID; the real client sends
    `agent/<epoch-millis>/<8 hex>`.
  - The body's `userAgent` carried the full versioned header string. It is a
    bare product token: `antigravity` for consumer accounts, `jetski` for
    managed ones.
  - The per-account `sessionId` that ties a conversation's turns together
    upstream was absent. It is an FNV-1a hash of the account id, ported here and
    checked against an independent implementation of the same hash.
  - A placeholder project id (`test-project`, `project-id`) is no longer sent as
    `x-goog-user-project`.

- **The request is ordered so the prompt cache can hit.** Upstream caching
  matches on a byte prefix, so `contents` — the part that grows every turn — now
  comes last, after the system instruction, tools and generation config that do
  not change. Only key order changes; nothing about the request's meaning does.

- **A rate limit no longer fails over to the second host.** Both hosts meter the
  same account, so the retry was a guaranteed second 429 that doubled the load
  exactly when there was none left to spend, and it branded a healthy endpoint
  degraded for five minutes over a per-account condition. Failover is now what
  the official client does: request timeouts, 404s and server errors only.

- **One exhausted window is no longer punished several times over.** Parallel
  turns each reported the same rate limit and each counted as a fresh strike, so
  a burst of three backed an account off for four minutes over a sixty-second
  window. Only a limit arriving after the previous cooldown has lapsed now
  counts as a new strike, and a concurrent report can never shorten a wait
  already in force.

- **The escalating backoff now actually escalates.** Reading a lapsed cooldown
  deleted it, so the strike count was gone by the time the account was next
  tried and a genuinely spent account kept backing off by the base thirty
  seconds forever. Lapsed cooldowns are remembered for ten minutes.

- **The wait Google asks for is read.** These endpoints answer with a
  `google.rpc.RetryInfo` detail rather than a `retry-after` header, so every
  rate limit fell back to a blind doubling instead of the delay just supplied.
  The body is now parsed, and that delay is what the cooldown and the client's
  `retry-after` are built from.

- **Only one request pays to discover the project header verdict.** The memo
  that remembers a rejected `x-goog-user-project` was only written once the 403
  came back, so every turn that started before that answer arrived spent its own
  doomed round trip. The first request to touch a project now probes it and the
  rest wait for its answer.

- **Parallel turns are paced per account.** At most three requests wait for
  upstream acceptance on one account at a time
  (`antigravityMaestro.maxConcurrentRequestsPerAccount`, 0 to disable). The slot
  is held only until the request is accepted, so parallel answers still stream
  concurrently.

- **A short cooldown is waited out instead of failed.** When every account is
  cooling down and the shortest wait is under fifteen seconds
  (`antigravityMaestro.rotation.maxWaitSeconds`), the request holds — with a
  little jitter so queued turns do not resume in lockstep — rather than
  reporting a brief pause back as an error the client answers with an immediate
  retry.

- **Claude Code's background model is picked in the apply flow.** Claude Code
  runs its haiku-class calls in parallel with the main turn, and every slot was
  wired to the same model. Splitting it off was already possible through
  `antigravityMaestro.claudeCode.smallFastModel` but only by typing a model id
  into a settings string. Applying Claude Code now offers the choice directly,
  with the current one marked and "same as the main model" as the first row.

## 1.0.6

- **Empty or whitespace display names correctly fall back to the model id.** When
  an upstream model object reported an empty or whitespace-only `displayName` and
  no derived name was recognised, nullish coalescing stopped at the empty string
  instead of falling back to the authoritative `modelId`. Empty display names are
  now treated as undefined, allowing the fallback chain to complete properly.

## 1.0.5

- **The model id is no longer appended to the name.** 1.0.3 added it where the
  upstream label disagreed with the id, and 1.0.4 stopped it repeating — but the
  premise was wrong. Every surface that shows a model name already shows its id
  beside it: the model pickers list both, and the panel prints the id under each
  card. So the name carried a second copy of what was on screen already, which
  read as a stutter. A unique label is now kept as it is; the id speaks for
  itself. Resolving a label that several ids share, which is what made the list
  readable in the first place, is unchanged.

## 1.0.4

- **The appended model id is no longer repeated.** 1.0.3 started showing the id
  next to a label that disagrees with it, but naming runs three times over the
  same data — the quota service stores the name it produced back onto the model,
  and the catalog and the panel each name that stored list again. Every pass
  appended the id afresh, so the model picker read
  `Gemini 3.5 Flash (High) · gemini-3-flash-agent · gemini-3-flash-agent`.
  Naming is now idempotent: an id already appended is recognised and left alone.

## 1.0.3

- **A rate limited endpoint is not retried on every request.** The primary Cloud
  Code host can be exhausted while the fallback still serves, and the failover
  worked — but nothing remembered it, so every single request paid a doomed
  round trip to the dead host before succeeding on the second one. Logs filled
  with `failed (HTTP 429), trying the next endpoint` for requests that were
  actually completing. A host that fails while a later one succeeds is now
  demoted for five minutes; it is reordered rather than dropped, so it still
  serves when everything else is down, and the lapsing TTL doubles as a probe
  that picks it back up once it recovers.
- **The per-model limits table matches the ids the upstream serves.** It had
  drifted: four entries named models that are never sent (`gemini-3.5-flash-high`,
  `gemini-3.5-flash-medium`, `gemini-3-pro-image`, `claude-sonnet-4-6-thinking`),
  while fourteen ids that are sent had none — `gemini-3-flash-agent`, the whole
  3.6/3.7 Flash family, `claude-sonnet-4-6` and the 2.5 models all fell back to
  the generic default. These limits are a fallback (the upstream reports its own
  `thinkingBudget` per model, and that still wins), but the fallback is what
  applies whenever it does not.
- **A model name that disagrees with its id shows the id too.** The upstream
  offers `gemini-3-flash-agent` under the label "Gemini 3.5 Flash (High)", so the
  list claimed a version the request would never ask for. The label is kept — it
  is what the model is findable by — and the id is appended where the two name
  different models. A differing effort alone is left alone, since the id already
  spells that out.

## 1.0.2

- **Tool call ids survive the round trip in Copilot Chat too.** 1.0.1 fixed this
  for the gateway the CLI agents talk to, but the in-process provider behind the
  Copilot model picker still dropped the id in both directions: the id the
  upstream sent was replaced with a locally generated one, and the calls sent
  back carried none at all. So the same `tool_use.id: Field required` failure
  survived on the one path most people use, on every turn after the first tool
  call.

## 1.0.1

Fixes a request storm: a single prompt could loop until the account's quota was
gone.

- **Tool call ids survive the round trip.** The Claude models are served by
  translating the request back into the Anthropic format, and that translation
  rejects a `tool_use` block with no id. The id was being dropped, so every turn
  after the first tool call failed with `tool_use.id: Field required` — for good.
  The client retried, resending the whole conversation each time.
- **An account that is out of headroom is left alone.** Once every account was
  cooling down the lease fell back to the active one anyway, so each retry
  earned a fresh rate limit and spent more quota. It now reports the wait
  instead. Without a `retry-after` the backoff starts at 30s and doubles per
  consecutive rate limit rather than jumping straight to the configured maximum,
  and a successful request clears it.
- **Errors say whether they are worth retrying.** The gateway returns
  `invalid_request_error` for a malformed request instead of `api_error`, sets
  `x-should-retry: false` on what cannot succeed twice, and passes `retry-after`
  through on rate limits, so clients back off instead of hammering.
- **The rejected project header is remembered.** It was re-sent on every request,
  costing a doomed 403 round trip each time before the retry without it.

## 1.0.0

First public release. Everything below this line is the development history that
led to it; no version before this one was published.

What the extension does, in one paragraph: sign in with as many Google accounts
as you have, and Antigravity's models become available in GitHub Copilot Chat,
Claude Code and OpenAI Codex at once. The panel tracks each account's remaining
quota per model, serves every request from whichever account can afford it, and
hands off to the next one when a limit is hit. Refresh tokens live in VS Code
SecretStorage. Every config file the extension writes is backed up first, and
**Restore** puts each agent back on its own provider.

Included in this release:

- **Account pool** with automatic rotation, drag-to-reorder fallback order, and
  per-account quota telemetry: remaining percentage per model, reset countdowns,
  subscription tier, and both the 5-hour and weekly rolling windows.
- **Copilot Chat** as a first-class language model provider, in-process, with
  tool calling, vision, thinking content and prompt caching.
- **Claude Code and Codex** through a loopback gateway that speaks the Anthropic
  and OpenAI wire formats, with each agent's own config rewritten to point at it.
- **Commit messages** on a model of your choosing rather than Copilot credits.
- **Usage accounting**: requests and input / thinking / output tokens per account
  and per model, with retained quota history.
- A panel built on the same design system as OpenRouter Maestro, so the two
  extensions read as one family. It is responsive from a 250px docked sidebar up
  to a full editor tab, honours `prefers-reduced-motion`, and follows the
  editor's light or dark theme.

## 0.1.25

- The panel's font stack survives a host that does not define
  `--vscode-font-family`. The fallback list sat outside `var()`, so a missing
  variable invalidated the whole declaration and the panel dropped all the way
  back to the browser's default serif.
- An account card's buttons sit on the header line rather than under it, which
  closes the band of dead space that ran across the middle of every card. On a
  narrow sidebar they still take their own row.
- Quota trend cards fill the row they are given. `auto-fill` kept reserving the
  empty tracks, so two accounts on a wide editor tab were both squeezed to the
  minimum column width and had their addresses cut short.

## 0.1.24

- The panel is rebuilt on the same design system as OpenRouter Maestro, so the
  two extensions read as one family: the same surface ramp and spacing scale,
  the same pill and card shapes, the same agent identity colours. Antigravity's
  own mark supplies the accent, cyan into violet.
- It has a brand header now. The mark and the wordmark sit above a tab bar that
  carries a count on each tab, and the three panel-wide actions moved up there
  as icon buttons, which is a whole row of the old toolbar reclaimed.
- Integrations are cards with a coloured left edge, one colour per agent, so
  the list is scannable before it is read. The gateway URL sits on its own
  monospace line rather than being appended to the row's title.
- A collapsed account card leads with its tightest quota as a figure, then one
  row per model family with a bar and a percentage. It used to be a wrap of
  long text chips that cost three lines to say what a bar says in one.
- The quota trend sparkline is fixed. At 100% the line sat exactly on the edge
  of its viewBox and half the stroke was clipped, so a full account drew what
  looked like a horizontal rule. The chart has vertical padding and a frame now.
- Token counts are colour-coded per kind and set in the editor's monospace face,
  and a light theme gets a matching surface ramp instead of a black rectangle.

## 0.1.23

- The Input and Thinking columns are visible again. Six columns of a full-width
  table never fit a docked sidebar, and the body hid the overflow rather than
  scrolling it, so the right-hand counts left the panel with no way to reach
  them. The table now sits in its own scroll container, and below 560px it
  stops being a table at all: each record folds into a card with the model on
  top and the four counts as a labelled strip underneath. Counts past five
  figures are shortened, with the exact figure in the cell's tooltip.
- Account cards and integration rows stop colliding with themselves. Both were
  a single non-wrapping row carrying five things, so on a 250px sidebar the
  three buttons squeezed the email down to an ellipsis. Both are grids now, and
  the buttons drop to their own line when there is no room for them beside the
  name. The gateway URL moved onto its own line for the same reason: appended
  to the row's title, it was what pushed the rest of the list out of shape.
- Colour comes from the running theme. The panel had a hardcoded indigo accent
  and a neon quota palette tuned for dark backgrounds; it now reads
  `focusBorder` and the theme's chart colours, so a light theme gets a green it
  can actually show.
- The card list animates in once per session instead of on every render. The
  list is rebuilt whenever a card is expanded, collapsed or dropped, and
  replaying the entrance each time made the panel look like it was reloading
  itself on every click.
- Interaction polish: buttons answer a press, keyboard focus is visible on
  every control, the status dots stopped pulsing, and the outer glows are gone.
  `prefers-reduced-motion` is honoured, and hover effects no longer fire on
  touch input.

## 0.1.22

- The commit-message model is applied for real. Copilot resolves
  `chat.utilitySmallModel` through `lm.selectChatModels`, which asks this
  extension for its model list — and once the models had been withdrawn from
  Copilot that list was empty, so every commit message fell back to Copilot's
  own quota while the panel claimed otherwise. Picking a model now publishes
  them again, and the pick is verified against `lm.selectChatModels` before the
  panel says it took.
- A commit-message model the upstream has stopped offering is moved onto the
  nearest one still available. Model ids come from live quota data and rotate;
  a stale id resolved to nothing and Copilot fell back silently.
- Restoring Copilot clears the commit-message setting as well — with the models
  withdrawn it could only name something Copilot cannot reach.
- The panel's commit-message row separates "in use" from "configured but
  unreachable" instead of showing both as active.

## 0.1.21

- The `antigravityMaestro.toolDriverModel` split from 0.1.20 is removed. Moving
  the tool declarations onto a cheaper model also moved the decision of which
  tool to call, which in agent work is the part worth paying for. Turns go to
  the model you picked, whole, as they did before. Trimming unused tool sets in
  Copilot's Tools picker saves the same tokens without that trade.

## 0.1.19

- Token counters are merged across the response instead of taking the last
  chunk whole. Gemini stops mentioning a counter once it stops moving — thinking
  tokens are reported while the model thinks and absent from the chunks after —
  so the final chunk could erase a figure that had already been reported. The
  highest value seen for each counter is kept, which is the final one.
- What the upstream reported is logged at `debug`, so a zero in the usage table
  can be told apart from a number that never arrived.

## 0.1.18

- The `debug` tool log lists declarations heaviest first, with the size of each.
  Tool declarations are most of what an agent turn costs — 106KB of a 127KB
  prompt in one measured case — and the size order is the order worth switching
  tool sets off in.

## 0.1.17

- The usage table has a Thinking column. Thinking tokens were being recorded but
  never shown, so a thinking model's Output column read far below what the turn
  actually produced — 134 output tokens next to several thousand spent thinking.
  Input and Output are unchanged; the number that was missing is now beside them.

## 0.1.16

- Every request logs what it is made of: `messages=3, tools=20, prompt~51KB
  (tools 9KB, attachments 0KB)`. A one-word question that costs 50,000 tokens is
  usually carrying an attached file, and the totals say which part to trim
  before the next turn.

## 0.1.15

- Choosing a model for commit messages now writes both `chat.utilityModel` and
  `chat.utilitySmallModel`. VS Code has two utility model settings — one for
  small/fast background flows, one for the rest — and which of them a flow uses
  is decided inside Copilot. Only the small one was being set, so
  "Generate Commit Message" kept running on Copilot's own model and spending
  Copilot credits. Restore clears each of them, and still only when it holds the
  value this extension wrote.
- The picker says what that model is for: it also answers Copilot's other
  background flows, chat titles included, so a cheap model belongs there.

## 0.1.14

- The model picker shows the quota of the account the request will run on, and
  nothing else. Printing a second account's percentage and email beside it read
  as the quota of the model being picked; a model the active account cannot
  serve now says so instead of borrowing a number.
- Names follow the Antigravity client again where they can. 0.1.12 derived every
  name from the model id, which renamed models that were labelled correctly. A
  label the upstream uses for exactly one model is now kept as-is — that is the
  name the client shows and the one worth searching for — and only a label
  shared by several ids (three of them came back as "Gemini 3.1 Flash Lite")
  falls back to the name derived from the id.
- Each quota refresh logs, at `debug`, what the upstream offered: model id, the
  label it came with, the name it is shown under and the percentage left. A
  model missing from the list is missing from the account's quota response —
  this is how to tell that apart from one listed under an unexpected name.

## 0.1.13

- The panel no longer looks like it reloads itself every time a card is touched.
  Quota bars grew from zero on every render, so expanding a card or dropping a
  dragged account replayed the whole animation. They animate once, on the first
  paint of a session, and land silently after that.
- The expand indicator is a caret that rotates when a card opens. It was a
  glyph that renders as a small dot in most panel fonts, which read as a stray
  mark next to the drag handle rather than as a control.

## 0.1.12

- Model names are built from the model id instead of the label the upstream
  reports. Those labels had drifted: three different ids all came back as
  "Gemini 3.1 Flash Lite", so the list read as duplicates and a model could not
  be found by name. `gemini-3.5-flash-high` is now **Gemini 3.5 Flash (High)**,
  `gemini-3.7-flash-tiered` is **Gemini 3.7 Flash (Tiered)**, and
  `claude-opus-4-6-thinking` is **Claude Opus 4.6 (Thinking)** — in the panel,
  the status bar and every model picker.
- Picking a model shows what is left on the account the request will actually
  run on. The picker merges every account and keeps the best quota per model,
  and printing that alone read as "100% quota left" while the active account sat
  at 17%. It now reads `17% quota left · 100% on other@gmail.com`, so a model
  about to run out is visible before it is chosen.
- The usage trend is per vendor family. One "lowest model quota" number said 17%
  for an account whose Gemini models were at 98% — the tightest family stood in
  for the whole account. Each card now draws a line per family with a legend
  underneath: Claude 17%, Gemini 98%, GPT-OSS 17%.
- Accounts can be dragged into a new order in the panel. That order is the order
  rotation falls back through, so it decides which account backs up which.

## 0.1.11

- Claude models answer again in Copilot Chat. Every request carrying the
  editor's tools failed with `tools.4.custom.input_schema: JSON schema is
  invalid`, and tool 4 was `edit_notebook_file`, whose `newCode` argument is
  declared as a union:

      "newCode": { "anyOf": [ { "type": "string" }, { "type": "array" } ] }

  A union node names no type of its own. Gemini's schema proto defaults an
  absent type to TYPE_UNSPECIFIED and accepts it, but the conversion the Cloud
  Code endpoints run for Claude carries that through to Anthropic, which
  validates the schema and rejects the tool — which is why the same request
  worked on Gemini models and never on Claude.

  A union now collapses onto the node it was declared on: the first member with
  a usable type wins and the node keeps its description. `oneOf` collapses the
  same way instead of being dropped. Nothing untyped is sent any more — a type
  is otherwise recovered from the node's shape (`properties` → object, `items`
  → array, a string `enum` → string), an array without `items` gets string
  elements rather than an open schema, and a node with nothing to recover a
  type from is dropped along with any `required` entry naming it.

## 0.1.10

- The rejected-tool log added in 0.1.9 never printed: an escape in its pattern
  had been written as a literal control character, so the pattern matched
  nothing and a failing request looked exactly like one that sends no tools at
  all. The pattern is fixed and now covered by a test against the real 400 text.
- That log no longer stays quiet when there is nothing to dump. It always
  reports the rejected index, how many declarations went out and their names,
  and adds the offending schema when the index is one of them — if it is not,
  the count alone says the tool came from somewhere upstream.
- The per-request log line carries the tool count: `messages=5, tools=12`.

## 0.1.9

- A tool schema the upstream rejects is now written to the log with the request
  that failed: `Upstream rejected tool 4 (name): {…}`. The 400 names the tool by
  index only, which says nothing on its own, and the full declaration list is
  only logged at `debug` — a level that has to be set before the failure it is
  meant to explain. If the reported index is past the declarations that were
  sent, the log says so, because that would mean the rejected tool is not one of
  this extension's.

## 0.1.8

- Tool calling works again on Claude models in Copilot Chat. A request carrying
  the editor's tools came back as `HTTP 400 ... tools.N.custom.input_schema:
  JSON schema is invalid. It must match JSON Schema draft 2020-12`, which
  killed the whole answer.

  Tool schemas were being filtered into Gemini's dialect, and for Claude the
  upstream converts that same declaration into Anthropic's `input_schema`,
  where it is validated as plain JSON Schema. `nullable` (OpenAPI, emitted for
  a `["string", "null"]` union), `propertyOrdering` (Gemini-only) and anything
  malformed that used to pass through unchecked — a `type` that is not a JSON
  Schema type name, a non-numeric `minimum` — are rejected there. Only a tool
  whose schema happened to contain one was affected, so it failed on some
  conversations and not others.

  The filter now emits the intersection of both dialects: every keyword is
  validated, `type` is normalised against the seven JSON Schema type names,
  `required` is resolved against the properties that survived, and an array
  declaration always carries `items` — which Gemini needed anyway.
- Tool declarations are written to the log at `debug` level, with the index the
  upstream reports on rejection.

## 0.1.7

- **Commit messages** have a row of their own in the panel: pick the model that
  writes them, and **Restore** hands them back to Copilot.

  "Generate Commit Message" runs on Copilot's small utility model, so it was
  spending Copilot credits — and failing outright once they ran out, no matter
  which model was picked for chat. The `chat.byokUtilityModelDefault` that
  **Set up** writes only redirects those tasks after Copilot has seen a BYOK
  model answer in chat, which a commit message asked for before that never
  satisfies. Naming the model outright skips the question entirely.

  Restore only clears the setting if it still holds the value this extension
  wrote, so a choice made by hand since is left alone.

## 0.1.6

- The Accounts panel no longer flickers through a whole answer. Gemini repeats
  its running token totals on nearly every chunk of a stream, and each one was
  being written to the usage history — a disk write and a full panel repaint,
  hundreds of times per reply. Only the final total is recorded now, once the
  response ends, which is the number those chunks were counting towards anyway.
  Cancelled and failed requests still record what they spent.
- Redraws are coalesced, so refreshing several accounts at once paints the
  panel a single time instead of once per account.

## 0.1.5

Restores everything the 0.1.4 merge quietly reverted — it had resolved every
conflict in favour of an older branch.

- Copilot Chat has its row back, with **Set up** and **Restore**. Both commands
  and the publish flag they persist had been dropped outright, so the panel
  could not offer either.
- Codex no longer reports a missing `ANTIGRAVITY_MAESTRO_API_KEY` on every
  request. The key is handed to the extension host on activation again; without
  that call not even a reload could help.
- "Use model" works for Claude Code again. The command name was being built by
  string interpolation from the webview's target id, which spells it
  `claude-code.apply` — not the `claudeCode.apply` that is registered.
- Account cards fold open and shut again, and now **start collapsed**, so
  several accounts read at a glance. A collapsed card keeps one chip per quota
  pool; opening it shows the pool cards, and the full per-model list stays
  behind its link.
- `reloadOnModelChange` is back in settings — `prompt` (default), `auto` or
  `never` — deciding whether applying or restoring a model offers the reload
  that Claude Code and Codex need to see the change.

## 0.1.4

- Applying or restoring a model in Claude Code or Codex offers to reload the
  window. Both read their wiring once at start-up, so until now the change only
  landed when VS Code was next restarted.
- Claude Code can be force-restored from its backup when its settings file has
  been edited out from under the extension.
- Redrawn panel: quota bars animate, rows carry their state as a coloured
  label, and the marks — icon, activity bar glyph, empty-state logo — are one
  family.
- `.vs/` and stray `.vsix` files no longer ship inside the package.

## 0.1.3

- Fixed HTTP 400 "Unknown name $comment / enumDescriptions" on every Copilot
  request with tools. Tool schemas are now filtered through one shared
  allow-list of the keywords the upstream accepts, instead of two drifting
  deny-lists that could not know about annotations invented later.
- Quota pools are keyed by vendor as well as window, so an untouched account —
  every model at 100% on one window — no longer collapses Claude, Gemini and
  GPT-OSS into a single row.
- Copilot Chat has a **Restore** button: the models are withdrawn from the
  picker and the one global setting Set up may have written is put back.
- Removed the account filter box.

## 0.1.2

- Fixed the Copilot Chat model picker never listing any Antigravity models. The
  provider announced its model-list changes under the wrong event name, so
  VS Code only ever read the list once — at activation, before any account had
  loaded its quota.
- The panel now has a Copilot Chat row of its own: how many models are
  published, and a **Set up** button that opens the model picker and lets
  Copilot run its utility tasks on a bring-your-own model.
- The gateway row says what it is for, and its buttons explain themselves.

## 0.1.1

- Fixed "Use model" in the Accounts panel failing for Claude Code with
  `command 'antigravityMaestro.claude-code.apply' not found`.
- Codex no longer needs a full VS Code restart to see its gateway key — the key
  is published to the extension host on activation, so a window reload is
  enough, and applying a model now offers that reload.
- Accounts collapse to a single row with their headline quotas; only the active
  one starts open, and there is a collapse/expand-all toggle.
- Quotas are listed once per pool instead of once per model, with the full
  per-model breakdown behind "show all models".
- Long reset windows read in days ("6d 22h") and switch to hours under a day.
- The status bar names its numbers: "Opus 82% · Gemini 97%" per vendor family
  instead of one unlabelled lowest quota, with every pool in the tooltip.
- New mark: a model held aloft over the field it presses down. Ships as the
  monochrome activity bar icon, the marketplace logo and a panel logo.
- Editor junk under .vs/ no longer ends up inside the packaged extension.

## 0.1.0

Initial release.

- Sign in with multiple Google accounts (loopback OAuth); refresh tokens stored in SecretStorage.
- Per-model quota, reset countdowns, subscription tier and rolling quota windows per account.
- Active account switching from the status bar, the panel and the command palette.
- Automatic rotation to another account on rate limits, with per-model cooldowns.
- Antigravity models exposed to Copilot Chat as a native language model provider.
- Local gateway on 127.0.0.1 speaking Anthropic Messages, OpenAI Responses and Chat Completions.
- Claude Code and Codex integrations that rewrite their config files (with backups) and restore them.
- Token usage and quota history.
