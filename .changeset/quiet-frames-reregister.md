---
"rrweb": patch
---

fix: keep recording an iframe that navigates from a same-origin document (such as about:blank) to another origin, by registering it again as a cross-origin iframe on its next load
