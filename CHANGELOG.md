# Changelog

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
