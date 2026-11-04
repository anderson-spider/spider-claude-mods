# subagent-effort

Sets the reasoning effort of every native subagent call from Jev's rating of its task. The model stays whatever the call or the agent definition says; only the effort is Jev's. The plugin never changes a call: one without Jev's effort is sent back, untouched, naming the effort to come again with, so auto mode reviews the call that runs. Local records let you compare what each effort costs in time and tokens.

```text
/plugin install subagent-effort --marketplace anderson-spider/claude-mods
```

## Setup

Set the `apiKey` plugin option (a sensitive field, kept in secure storage) from the plugin's configuration in `/plugin`, in your user options. When the option is not set, the plugin uses `SPIDER_PLUGIN_OPTION_SUBAGENT_EFFORT_API_KEY` from the environment, else `JEV_API_KEY`: set it where Claude Code inherits it (your shell profile for the terminal, `launchctl setenv` for the macOS desktop app) and restart Claude Code. A malformed option is reported, not replaced by the environment. A key that a repository's `.claude/settings.json` or `.claude/settings.local.json` declares for the source in use (`pluginConfigs` with this plugin's `apiKey`, or `env` with either variable) is refused, so a repository cannot choose the account that receives your tasks. Without a usable key, subagent calls go as they came and a toast says why, once per reason per load.

## How it routes

A hook on the `Agent` tool runs before each dispatch:

- **Any agent type** (built-in, yours or a plugin's): Jev rates how much reasoning the task needs, and the rating is the effort, held to the agent type's cap (below). Jev is the authority: a call without its effort, or with another, is refused before it runs with `Jev rated this task medium. Call Agent again with the same input and effort: "medium"`, and Claude calls again with it; Jev rates the task once. A call is not changed after auto mode reviewed it, since auto mode then refuses it ("a hook changed this call's input after auto mode reviewed it"). A call that comes back twice with another effort goes as it came, so nothing loops.
- **Fork** (`subagent_type: "fork"`) or an empty task: passed untouched. The host ignores a fork's effort anyway.
- **Jev off or failing**: the call goes as it came, its own effort included, or the agent's usual effort when it has none, exactly as without the plugin.

**Caps.** The `caps` option sets the highest effort Jev may pick per agent type, as `type=effort` pairs split by commas. Left empty it is `Explore=medium,web-fetch=medium,claude-code-guide=low,statusline-setup=low`: those agents only read, and the records showed them doing as well at medium for a fraction of the tokens. `none` turns the caps off; a pair that is not an agent type and one of `low`, `medium`, `high` or `xhigh` is dropped with a debug line. A cap only lowers Jev's pick, and never touches a call Jev did not route.

Each Jev call has one 3-second deadline. A dropped connection, or a 429, 500, 502, 503, 504 or 529 response, is retried once while at least a second of the deadline is left. At most four Jev calls are in flight. After three failures in a row (a 400 or 422 rejection and an unreadable reply do not count), Jev is paused for five minutes, then one call goes through as a probe. While Jev is paused or the four slots are taken, a call goes as it came without a toast. The comparison call takes a slot too, after the decision's.

Jev rates the first 800 characters of the task, where a brief states its goal, on their own: ratings followed the brief's length even when the question said to ignore it. For a longer task a second Jev call, in parallel, rates it read up to 4000 characters, and the higher of the two levels decides, so a hard step stated past the head is not lost; the full brief raises the head's level by one at most. When the second call fails, the head decides. The question asks Jev to judge the work itself, not the length of the brief or its breadth: a very thorough survey of many files is longer, not harder. Its four levels are the efforts:

| Effort | Typical task |
| --- | --- |
| `low` | A lookup or mechanical step: find a file or symbol, list usages, read one function, run a known command. |
| `medium` | A bounded investigation or change in one area: trace one call path, summarize a module, map or inventory one area's code however thoroughly, a small edit with its test. |
| `high` | Reasoning across several parts or toward an unknown cause: debug a failure, review a multi-file change, plan a change that keeps contracts. |
| `xhigh` | Architecture, security, concurrency or deep domain reasoning. |

`max` is never picked. Jev answers with a probability per level, and the plugin takes the level with the lowest expected penalty, weighing spare effort 1.5 times missing effort. So a split judgment goes to the cheaper level: the higher of two adjacent levels wins only when the levels at or above it hold more than 60% of the probability. This weighting is a policy choice, not a measurement; the records are there to check it.

A continuation through `SendMessage` is not an `Agent` call, so it keeps the effort it started with and is not recorded again.

## Records

Each decision records the effort the call came with, the one the agent runs with, the cap when one held Jev's pick down, the levels Jev gave the head and the full brief, how many times the call was sent back for Jev's effort and the time from the first refusal until it went, and the Jev call's own latency, the input and output tokens Jev reported and their estimated cost, apart from the subagent's duration and tokens. The cost charges input tokens at US$0.042 per million and output tokens at nothing, the published Jev rate as of October 2026 taken from gateway docs, so it is an estimate until an invoice confirms it. `/subagent-effort-stats` says whether this session has a usable Jev key and from which source it came (it sends no request to Jev), and summarizes the records: decisions by source (Jev, with how many replaced a different effort from the call, and Jev off with its reasons), the Jev calls with their median latency, tokens and estimated cost (both calls of a decision), how often the full brief raised the head's level (and how often the one-level limit held it), left it or rated lower, how many calls were sent back and their median wait until they went, and for each model family and effort (`haiku/low`, `opus/usual` when no effort was set) and each agent type the runs, failures and median duration and tokens. A group with fewer than three runs is left out of the text and counted in one line, since its median says little. The groups hold only runs of the current calibration (the policy's version, bumped with any change to the question, the weighting or how the two levels combine), so a new policy is not judged by the old one's runs; those are counted apart, and so are calls that errored before their agent started, by the kind of error: `rejected` (you rejected or interrupted the call), `cancelled` (the host cancelled it), `unknown-type` (an agent type that does not exist), `invalid-input`, `other`, and `unclassified` for records written before the kind was kept. A call that a hook or the permission check denied never ran, so it adds no run or failure (its decision still counts). The wait of a call sent back covers only calls that came back with the same description and task: one that never came back writes no decision, and one that came back changed is rated again as a new call.

## Evaluation

`/subagent-effort-eval [rounds] [dev|holdout]` sends the fixed briefs in `hooks/eval-briefs.ts` to Jev, one at a time, and compares each decided level with the level a person judged the brief needs. Each line shows a brief's expected level and, per round, the decided level with the head's and the full brief's in brackets (`2(1/2)`), marked `varies` when the rounds disagree; then the hits, levels over and under the expected one, failures and partial ratings (a long brief rated by its head alone) per split, and the estimated Jev cost. Rounds go from 1 to 5 (3 by default). The `dev` briefs are for tuning the question and the `holdout` ones only for confirming a change. Caps do not apply, nothing is recorded, and the evaluation has a breaker of its own, so its failures never pause routing. A full run of 20 briefs and 3 rounds makes 72 Jev calls (one per brief, plus one for each of the 4 long briefs, per round).

## Privacy

- **Sent to Jev** (`api.typesafe.ai`): the task text of each routed call, after paths under your home and the repository, email addresses, the key itself and secret-looking values are masked, cut to 800 characters and, when the task is longer, also to 4000 for the second call. Nothing is sent for a fork, an empty task, or when the key is missing, invalid or refused. `/subagent-effort-eval` sends only its fixed briefs, the same way.
- **Saved locally** in `~/.claude/subagent-effort/routes.jsonl` (one rotated generation past about 2 MB): ids, the agent type, the effort the call came with, the one applied, the cap that held it down, Jev's level for the head and for the full brief, how many times the call was sent back and how long it took to come back, who decided it, Jev's confidence, latency, reported tokens and estimated cost, the brief's length in characters, and for each finished run its resolved model (the model the call named when the host reports none), status, duration and token count, and for a call that returned an error the kind of error from a fixed list, never its text. Never the task, the prompt, the answer, a path or the key.

## Tests

Pure logic tests call the modules directly; host tests run the plugin against a fake host (`tests/host.ts`) with no network and no model calls, so they do not prove that Jev's ratings are good or that the host honors the effort. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
