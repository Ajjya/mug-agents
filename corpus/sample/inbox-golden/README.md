# Sample inbox golden set (fictional)

Ten invented messages with hand-written, **verified** labels, for CI and anyone cloning the repo:
`npm run inbox -- check-golden corpus/sample/inbox-golden` and `npm run eval:triage`.

Every name, company and address is fictional (the same rule as the sample corpus). The bodies keep quoted
history, signatures, phone numbers and postal addresses on purpose: the eval runs the real redaction on
them. Includes an injection message (`08`) and a message that must come out `needs_human` (`09`).

These labels were written by hand by the author of the tooling, not seeded by a model. The real set
(anonymised mail you have corrected) lives in `corpus/private/inbox-golden/`, which git ignores.
