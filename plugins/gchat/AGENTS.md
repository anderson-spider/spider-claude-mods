# gchat

Skills only, so `test` and `typecheck` skip it.

- The `<!-- shared: gchat-rules -->` block is byte-identical in all four skills and nothing checks it: after editing one, copy it to the other three and diff them.
- Safety rules not to weaken: the user approves the exact text and the Recipient together, and a change to either needs a new approval; the Recipient is confirmed by the Header on a screenshot, never by the tab title or page text; text already in the Composer is the user's draft and blocks the send; the send is one `Enter`, never repeated after an error or timeout.
- Plugin options substituted as `${user_config.KEY}` in skill text must stay non-sensitive: the host substitutes only non-sensitive options into skill content.
- No real spaces, hosts or projects in the skills; examples use `gitlab.example.com/group/project`.
- The read script's `[data-topic-id]` selector and its noise regex (Portuguese UI strings) follow Chat's current DOM; when Chat changes, the skill falls back to a screenshot.
- Outside dependencies: Anthropic's `chrome-browser` skill, the separately installed `humanizer` skill, and this marketplace's `gitlab` plugin.
