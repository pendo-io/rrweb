---
"rrweb-snapshot": patch
"rrweb": patch
---

fix: do not record iframe `srcdoc` as raw html; record the srcdoc document with masking applied, including for sandboxed iframes without `allow-same-origin`
