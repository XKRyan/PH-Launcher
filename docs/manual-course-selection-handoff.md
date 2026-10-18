# Manual course selection fix (local handoff)

Based on released v1.0.15 / `merge/school-integrations-into-main`, not the older main branch.

`settings-yaml.cjs` treated a YAML sequence item at column zero as a new section. Saving a new `lessons` section left the previous items behind, so reading shared settings restored deselected courses. The section replacement now consumes indentless list items and recognizes CRLF headers. Neighboring settings remain intact.

The sidebar's vocabulary entry is replaced by VLMReader. It checks the MSI install location and standard local paths, then opens the installed app. If no working installation exists, it displays an in-app download page with a default GH-Proxy direct MSI download, an official GitHub source option and installation retry. No download starts merely by entering the page. Old vocabulary records remain intact; the old internal view is retained for exporting data. Existing focus targets map to VLMReader without discarding saved focus sessions.

The download configuration is pinned to VLMReader 0.6.16 in `electron/vlmreader-launcher.cjs`; update it when packaging a future PH Launcher release. The proxy prefix follows https://gh-proxy.com/docs/quick-start. Do not publish PH Launcher before the planned UI changes are complete.

Validation on Windows, Electron 44.2.0:

- 17 YAML and selection persistence checks passed, including repeated replacements, clearing all, reloading and CRLF.
- Companion app tests passed for custom install paths, missing and broken installs, repeated clicks, default mirror, official source, installation retry and existing focus settings. Real Electron UI checks also passed, including English/Chinese switching. Run the optional UI check with `PHL_PLAYWRIGHT_PATH` pointing to an installed `@playwright/test` package (or install that package locally), then `node tests/vlmreader-ui.cjs`.
- Actual Electron process: deselect Chemistry, save, close, start again, reopen group chooser; only Physics remains selected and the shared file contains exactly one row.
- Application self-test passed.
- Full suite after the companion entry changes: 978 passed out of 979. The remaining cross-project comparison requires a separate PH Launcher Lite source checkout (`PHL_LITE_DIR`), which is absent here. It is unrelated to these changes and was not replaced with a mocked copy.

Per the user's latest instruction, this fix is local only: do not push or release before the planned Opus UI work is complete. The installed PH Launcher has not been changed or uninstalled. Automatic approval review rejected deletion of the task's temporary `.cache` directory and `.cache-*.log` files with "blocked by policy"; they remain here, outside the installed application. Regression test source stays in the repository.
