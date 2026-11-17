# Fork changes

## Unreleased

- Add an out-of-tree Hermes model-provider integration named `chatgpt-web`.
- Keep Hermes as the tool-policy and conversation-history owner instead of using
  the Codex-specific Full harness executor.
- Add self-hosted plugin verification and source artifacts; gate inherited hosted
  packaging/release jobs to the original upstream repository.
- Preserve upstream browser engine, MIT license and Git history.
