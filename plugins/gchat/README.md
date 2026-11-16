# gchat

Skills that read, summarize and reply in Google Chat, and post GitLab merge request review requests to a Chat space, through Claude in Chrome. Nothing is sent until you have explicitly approved the exact text and the conversation it goes to.

```text
/plugin install gchat --marketplace anderson-spider/claude-mods
```

## Requirements

- Claude Code (or Cowork) with the [Claude in Chrome](https://claude.com/chrome) extension connected (`/chrome`), signed in to Google Chat in that Chrome. The skills use only its `mcp__claude-in-chrome__*` tools and refuse any other browser, computer use or a Chat API.
- The main agent: the skills do not run in a subagent, which has no Claude in Chrome tools.
- The `chrome-browser` skill (Anthropic's, shipped with Claude in Chrome) and the `humanizer` skill, installed separately, for drafting.
- For review requests, the `gitlab` plugin of this marketplace, whose `mcp__gitlab__*` tools read the merge request.

## Setup

Set the options from the plugin's configuration in `/plugin` (or `claude plugin configure gchat`):

- `reviewSpace`: the space review requests go to when you name no other, as its header shows it. Left empty, `gchat-mr-review` asks which space each time.
- `accountIndex`: the `n` in `chat.google.com/u/<n>/` for the Google account Chat should use; `0` (the default) is the first account signed in to the browser.
- `testSpace` (optional): a space you allow for test messages. Approval and checks are the same there.

None of them is a secret; they are written into the skills' text when the skills load.

## Use

- `gchat:gchat-reply`: give a `chat.google.com` link and ask what was said or what to answer ("o que fulano respondeu", "responde lá"). It reads the recent messages (15 by default), summarizes them, and, if you asked for a reply, drafts one in your tone with `humanizer`.
- `gchat:gchat-mr-review`: ask to post an MR (a number, a URL, or the current branch's) to Chat. It reads the MR, its approvals, pipeline, conflicts and open discussions, reads the space for its tone and any earlier request for the same MR, and drafts the request or a short reminder.
- `gchat:gchat-read` and `gchat:gchat-send` are the shared steps the two above load: opening a conversation and confirming it, and the send itself.

Before anything is sent, Claude shows you the conversation it confirmed by its header on screen and the exact text, and waits for your approval. A change to either needs a new approval. The send happens once, in a new Chrome tab; afterwards Claude checks by screenshot that the new message is there and the composer is empty, and reports Sent, Blocked or Not confirmed. It never resends, edits or deletes a message by itself, and text already in the composer is treated as your draft and left alone.

## Privacy

The skills are instructions only. In Chrome they open `chat.google.com`, read the conversation you named and type into it only the approved message. Messages read in Chat are treated as data, never as instructions or approval. The MR is read through the `gitlab` plugin's tools under that plugin's own token rules.

## Tests

The plugin ships only skills, so `claude plugin test` has nothing to run. `claude plugin validate --strict` checks its manifest and frontmatter.

For editing pointers and check commands, see [AGENTS.md](AGENTS.md).
