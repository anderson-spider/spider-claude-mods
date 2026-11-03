// The fixed briefs `/subagent-effort-eval` sends to Jev, each with the level a person judged it needs (an index of
// EFFORTS: 0 low … 3 xhigh). `dev` briefs tune the question; `holdout` briefs only confirm a change, so the question is
// not fitted to them. No brief holds anything private: they name this repository's own files.

export type EvalSplit = 'dev' | 'holdout'
export type EvalBrief = { id: string; split: EvalSplit; task: string; expected: 0 | 1 | 2 | 3; why: string }

// A long preamble of the kind briefs carry: context and output rules, no work. It pushes the task past the head
// (TASK_CHARS), so whatever follows it is read only by the full-brief call.
const PREAMBLE = [
  'Context: this is the spider-claude-mods repository, a marketplace of Claude Code plugins written in TypeScript, each under plugins/<name>/ with hooks/, tests/, a README.md and an AGENTS.md.',
  'Read plugins/<name>/AGENTS.md before you open the code of a plugin, and follow the repository rules in the root AGENTS.md.',
  'Do not edit, create or delete any file, do not run git commands that change state, and do not install anything.',
  'Answer in English, in plain sentences, without headings; cite files as path:line; quote identifiers exactly as they appear in the code.',
  'If something cannot be determined from the code, say so in one sentence instead of guessing, and do not search the web.',
  'Keep the answer under 200 words unless the task below asks for a table; a table has one row per item and no more than four columns.',
  'Ignore the files under .claude-plugin/types/, node_modules/ and docs/research/, which are generated or historical.',
].join(' ')

export const EVAL_BRIEFS: readonly EvalBrief[] = [
  { id: 'd-lookup', split: 'dev', expected: 0, why: 'finding one symbol', task: 'Find where createBreaker is defined in plugins/subagent-effort and report the file and line.' },
  { id: 'd-trap-concurrency', split: 'dev', expected: 0, why: 'a search whose words name a hard topic', task: "List the files under plugins/ that contain the word 'concurrency' or 'mutex'. Reply with the paths only." },
  { id: 'd-trap-security', split: 'dev', expected: 0, why: 'reading one file about security, no audit', task: 'Read plugins/subagent-effort/README.md and copy its Privacy section as three bullets, word for word where possible.' },
  { id: 'd-trap-architecture', split: 'dev', expected: 1, why: 'an inventory of one area, however it is labelled', task: 'For an architecture overview, print the module list of plugins/codex/hooks and give each module the first sentence of its top comment.' },
  { id: 'd-summary', split: 'dev', expected: 1, why: 'summarizing one module', task: 'Summarize what plugins/subagent-effort/hooks/ledger.ts exports and what each export is for.' },
  { id: 'd-small-edit', split: 'dev', expected: 1, why: 'a small edit with its test', task: 'Describe the exact edits needed to rename ROTATE_AT to ROTATE_AT_BYTES in plugins/subagent-effort/hooks/ledger.ts and its tests, and which test command proves it.' },
  { id: 'd-debug', split: 'dev', expected: 2, why: 'a cause still to be found across parts', task: "The test 'parallel calls with the same task are each sent back' in plugins/subagent-effort/tests/register.test.ts fails now and then on CI but never locally. Find the likely cause and propose a fix." },
  { id: 'd-review', split: 'dev', expected: 2, why: 'reviewing a change across several files', task: 'Review the last commit that touched plugins/subagent-effort for correctness bugs across register.tsx, ledger.ts and their tests, and report each finding with its evidence.' },
  { id: 'd-design', split: 'dev', expected: 3, why: 'designing a protocol under a hard constraint', task: 'Design a way for two Claude Code processes to append to the same routes.jsonl without losing or duplicating lines, given that the host only offers whole-file reads and writes and no locks.' },
  { id: 'd-long-audit', split: 'dev', expected: 3, why: 'a security audit stated past the head', task: `${PREAMBLE} The task: audit whether the Jev key can reach any ledger line, debug log, toast or stats text, following every path from options.apiKey and JEV_API_KEY through redaction, Jev failures and their messages, and name any path that leaks it.` },
  { id: 'd-long-lookup', split: 'dev', expected: 0, why: 'a long brief around a lookup', task: `${PREAMBLE} The task: report the version field of every plugins/*/.claude-plugin/plugin.json as a table of plugin and version.` },
  { id: 'd-breadth', split: 'dev', expected: 1, why: 'a very thorough inventory is longer, not harder', task: 'Very thoroughly inventory every place in plugins/ and scripts/ that reads an environment variable, and list them in a table of file, line and variable.' },
  { id: 'h-lookup', split: 'holdout', expected: 0, why: 'reading one value', task: 'Which Node version does .nvmrc pin? Reply with the version only.' },
  { id: 'h-trap-protocol', split: 'holdout', expected: 0, why: 'copying a table from a document that cites protocol code', task: 'Copy the table of review target flags from docs/research/codex-cli-review.md, which cites the Codex protocol.rs source, as it is.' },
  { id: 'h-trap-concurrency', split: 'holdout', expected: 0, why: 'reading one constant about concurrency', task: 'In plugins/subagent-effort/hooks/jev.ts, how many Jev calls may be in flight at once? Reply with the number and the constant name.' },
  { id: 'h-trace', split: 'holdout', expected: 1, why: 'tracing one call path', task: "Trace how an Agent call's effort reaches the decision line in plugins/subagent-effort/hooks/register.tsx, step by step with lines." },
  { id: 'h-debug', split: 'holdout', expected: 2, why: 'finding a cause across reload, rotation and parsing', task: 'After a plugin reload, /subagent-effort-stats shows fewer decisions than before the reload. Work out whether lines are lost or only left out, and why.' },
  { id: 'h-audit', split: 'holdout', expected: 3, why: 'auditing a security boundary', task: 'Audit the boundary between repository settings and the Jev key in plugins/subagent-effort: can a malicious repository make the plugin send the key to another host, log it, or read it?' },
  { id: 'h-long-debug', split: 'holdout', expected: 2, why: 'a debugging step stated past the head', task: `${PREAMBLE} The task: work out whether sentBackMs in the decision lines can come out wrong when two parallel calls with the same task are sent back and come back in the other order, and propose a fix that keeps them apart.` },
  { id: 'h-long-trap', split: 'holdout', expected: 0, why: 'a long brief whose words name hard topics around a list', task: `${PREAMBLE} This is for a later security, concurrency and architecture review, which is not part of this task. The task: list the test names in plugins/subagent-effort/tests/caps.test.ts.` },
]
