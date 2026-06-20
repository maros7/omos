---
name: review-fixer
description: Address, respond to, or resolve PR review comments / review threads. Use when asked to handle reviewer feedback on a pull request.
---

# review-fixer

Two-call workflow using the `review-fixer` tool. `apply` replies to AND resolves
every thread in one call.

1. Action `list` (pass `pr` if known; optional `author` to narrow to one
   bot/person). Read each thread's `path:line` and feedback — every line shows a
   `PRRT_…` threadId.
2. Edit the code to actually fix each item.
3. Action `apply` with `items: [{ threadId, body }]` — replies and resolves all
   at once, then reports `remaining unresolved: K`.
4. Only if `remaining > 0` (or you deliberately skipped some): action `verify`.

Gotchas:
- Pass the `PRRT_…` threadId from `list` plus your reply text — nothing else (no
  numeric ids).
- Actually fix the code before replying.

Example:

```json
{ "action": "apply", "items": [{ "threadId": "PRRT_kwDOExample", "body": "Fixed: extracted the helper and added a nil check." }] }
```
