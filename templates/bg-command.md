---
description: Managed native-task and monitor dashboard
---
Render the background-work dashboard.

- If "$ARGUMENTS" is empty: call `orch_status` and `monitor_status` (no
  arguments), then render compact tables for managed tasks (id, state,
  specialist, title, write roots) and monitors (id, state, exit, title,
  elapsed). Put queued, blocked, and failed work first. Suggest one concrete
  next action (`orch_start`, `orch_continue`, or `orch_cancel`) if needed;
  otherwise stop.
- If "$ARGUMENTS" is an orchestration task id: call `orch_status` for that id
  and render its contract, locks, completion, and validation information.
- If "$ARGUMENTS" is a monitor id: call `monitor_read` and render the log.

Do not turn this command into a polling loop.
