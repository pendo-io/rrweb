---
"rrweb-snapshot": patch
---

Fix `rebuild()` rejecting a sandboxed iframe's document after the iframe is navigated (e.g. to a service worker scope). The replacement document is now trusted on `load` while the sandbox is still exactly `allow-same-origin`.
