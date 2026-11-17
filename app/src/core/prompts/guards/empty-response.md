Loop guard interrupted prior turn: the model returned an empty response — no text, no thinking and no tool call — so the run made no progress.

An empty turn cannot advance the task. Break the stall now:
- Do something concrete: issue ONE normal-format tool call that is the smallest real next step (read a file, list a directory, run a check).
- Or, if the task is genuinely complete, emit a short final answer instead of an empty message.
- Do not answer with nothing and do not repeat the empty response.

Act or answer — an empty response is not progress.
