# Contributing

Bug reports and focused pull requests are welcome. Do not submit school credentials, session cookies, student data, copied assignments or proprietary school materials.

Before opening a pull request:

1. Use Node.js 22 and run `npm ci`.
2. If `assets/dictionary/ecdict.db` is absent, run `npm run dictionary:prepare`. The generated database is intentionally ignored by Git.
3. Run `npm test` and the relevant platform smoke/build checks.
4. Keep website CSS restricted to the reviewed school domains and preserve the ability to disable “简洁显示”.
5. Preserve AI confirmation gates: model output must never directly write launcher data, handle passwords, or execute arbitrary page scripts.

macOS release changes must additionally pass Developer ID signing, notarization, Gatekeeper, Universal architecture and real-Mac installation checks. Unsigned packages are development artifacts only.
