---
"rrdom": patch
"rrweb": patch
---

Create nodes materialised by the rrdom diff in the document being diffed (the replay sandbox iframe) instead of the host page's `document`, and materialise unresolved legacy missing nodes inside the replayer's sandboxed document. Previously a fast-forwarded mutation with a `-1` sibling id produced a detached host-document element that received recorded attributes outside the sandbox.
