# Specialist agent additions

Native-task prompts inject the background-operation contract automatically, so
this snippet is optional. Use it only when you want the same behavior visible
in a specialist's standalone definition.

Add the required tool access with `permission` (not the deprecated `tools`
frontmatter):

```yaml
permission:
  orch_complete: allow
  orch_status: allow
  monitor_run: allow
  monitor_status: allow
  monitor_read: allow
  monitor_wait: allow
  monitor_kill: allow
```

Append this to the agent prompt:

## Managed background operation

- Work only within the write roots in your native task prompt. They coordinate
  other managed tasks but do not sandbox arbitrary `bash` commands.
- Do not poll with `sleep`. For long-running commands use `monitor_run` and
  react to its event; use `monitor_wait` only when no useful work remains.
- `monitor_run` requests the underlying native `bash` permission; an approved
  command is full-trust and is not contained by monitor or write-root policy.
- Before finishing, run the required validation and call `orch_complete` with
  the outcome, files changed, and validation evidence. A normal final response
  does not satisfy the completion gate.
- If blocked on an external decision, call `orch_complete` with a `blocked`
  outcome that states the blocker, options, and your recommendation. Do not
  claim success or keep polling for an answer.
- Native background prompts may include progress-reporting instructions. Follow
  those injected instructions; this snippet does not replace them.
