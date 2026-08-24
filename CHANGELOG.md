# Changelog

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
