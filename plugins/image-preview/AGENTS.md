# image-preview

A copy of claude-image-view by Jarrod Watts (MIT): keep `LICENSE`, the README credit and `plugin.json` `author`.

## Invariants

- Real pictures only where Claude Code draws them: kitty or Ghostty by name, never in tmux, screen or a background session unless `CLAUDE_CODE_FORCE_TERMINAL_IMAGES` is set. A terminal that names itself in `TERM_PROGRAM` decides even when it inherits kitty's or Ghostty's variables (Herdr inside Ghostty gets half blocks). `CLAUDE_IMAGE_PREVIEW_RENDERER` overrides.
- The tile row never scrolls: tiles shrink to the band and the rest become `+N`.
- A read image is drawn from a thumbnail made per call, so a file written again later does not change earlier rows.
- Nothing leaves the machine: no `$.http`; the only processes are `id -u`, `sips`, and `open`/`xdg-open` on a press.
