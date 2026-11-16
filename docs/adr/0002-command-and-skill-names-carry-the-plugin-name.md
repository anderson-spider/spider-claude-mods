# Command and skill names carry the plugin's name

Every slash command and skill of every plugin shares one `/` menu. Claude Code puts the plugin's name in front of the names of a plugin's skills and agents (`<plugin>:<skill>`), but `$.command.register` registers the name it is given as it is, with no prefix. Each mod therefore picked its own command names: `antigravity` registers `/agy-review`, `session-hud` registers `/session-panel`, while `codex` registers `/codex-review`. We decided that a name a plugin chooses itself starts with the plugin's full name. The marketplace's name (`spider-claude-mods`) never appears in it.

- **Mod commands** are `<plugin>-<action>`, such as `/antigravity-review` or `/session-hud-panel`. A plugin with one command may name it after the plugin alone, as `/file-explorer` does.
- **Skills** are `skills/<skill>/SKILL.md`, which Claude Code shows as `<plugin>:<skill>`. The skill's own name does not repeat the plugin's name: `antigravity:code-review`, not `antigravity:antigravity-code-review`.
- **Tools** (`mcp__<plugin>__<name>`) and **agents** (`<plugin>:<name>`) need nothing more: Claude Code adds the plugin's name to both.

## Considered Options

- **`<plugin>:<action>` for mod commands too**, so commands would look like skills. `$.command.register` refuses it: a name is "letters, digits, _ or - (up to 64)", and a name with `:` throws `HooksError: ... name is letters, digits, _ or - (up to 64)`. This was checked by hand on Claude Code v2.1.325 with a temporary mod that registered `colontest:review` and `antigravity:review` (both refused) and `colontest-review` (registered).
- **Short prefixes chosen per plugin**, as now (`agy-`). They are quicker to type, but nothing ties them to the plugin, and another plugin can take the same prefix. Registering a name that is already taken replaces it with no warning, so a generic name can silently override another plugin's command.
- **The marketplace's name as a prefix** (`spider-`). It is the same for every plugin, so it says nothing about which plugin a command belongs to. It also makes every name longer, and the marketplace already shows up where a person installs a plugin (`<plugin>@spider-claude-mods`).

## Consequences

- A plugin's name must be short enough to make readable command names. `plugin:new` already caps it at 26 characters, which leaves room under the 64-character limit for `<plugin>-<action>`.
- Commands and skills are separated differently (`-` for a command, `:` for a skill) because the host allows nothing else. Both still start with the plugin's name.
- Two plugins break the rule today: `antigravity` (`/agy-ask`, `/agy-image`, `/agy-review`, `/agy-doctor`) and `session-hud` (`/session-panel`). Renaming a command breaks it for whoever types or scripts it, so each rename goes in that plugin's own pull request with a `!` title and an updated README.
- A plugin's skill keeps a short form: Claude Code also runs a plugin skill by its bare name (`/code-review`) unless another command already uses that name. A skill that shares its name with a built-in or a skill installed elsewhere can only be run by its full `<plugin>:<skill>` name.
