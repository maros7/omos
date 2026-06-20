---
name: review-fixer
description: Address, respond to, or resolve PR review comments / review threads. Use when asked to handle reviewer feedback on a pull request.
---

# review-fixer

Two-call workflow using the `review-fixer` tool. `apply` replies to AND resolves
every thread in one call.

Each reviewer comment is a HINT to evaluate, not an order to apply verbatim:
fix it, explain why it doesn't apply, or push back — and let the reply `body`
reflect that judgment.

1. Action `list` (pass `pr` if known; optional `author` to narrow to one
   bot/person). `list` text shows each thread's `path:line` and the FULL comment
   body — every entry is keyed by a `PRRT_…` threadId.
2. Evaluate each comment, then edit the code (or decide it's wrong and say so).
3. Action `apply` with `items: [{ threadId, body }]` — replies and resolves all
   at once, then reports `remaining unresolved: K`.
4. Only if `remaining > 0` (or you deliberately skipped some): action `verify`.

Gotchas:
- Pass the `PRRT_…` threadId from `list` plus your reply text — nothing else (no
  numeric ids).
- Resolve a thread only after you've actually addressed (or rebutted) it.

Example:

```json
{ "action": "apply", "items": [{ "threadId": "PRRT_kwDOExample", "body": "Fixed: extracted the helper and added a nil check." }] }
```
