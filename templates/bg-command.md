---
description: Background agents and monitors dashboard
---
Render the background-agents dashboard.

- If "$ARGUMENTS" is empty: call bg_status and monitor_status (no arguments)
  and render two compact tables — tasks (id, state, agent, title, started) and
  monitors (id, state, exit, title, elapsed). Put any unanswered questions at
  the top, prominent. Suggest the single most obvious next action (bg_answer a
  pending question, bg_read a finished task) if one exists; otherwise stop.
- If "$ARGUMENTS" is a bg_... id: call bg_read on it and render the result.
- If "$ARGUMENTS" is a mon_... id: call monitor_read on it and render the result.
