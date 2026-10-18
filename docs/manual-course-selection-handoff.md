# Manual course selection fix (local handoff)

Based on released v1.0.15 / `merge/school-integrations-into-main`, not the older main branch.

`settings-yaml.cjs` treated a YAML sequence item at column zero as a new section. Saving a new `lessons` section left the previous items behind, so reading shared settings restored deselected courses. The section replacement now consumes indentless list items and recognizes CRLF headers. Neighboring settings remain intact.

The vocabulary toolbar also has a VLMReader button opening https://github.com/XKRyan/VLMReader in the default browser. Existing study functions remain available.

Validation on Windows, Electron 44.2.0:

- 17 YAML and selection persistence checks passed, including repeated replacements, clearing all, reloading and CRLF.
- Vocabulary UI checks passed, including clicking the external link.
- Actual Electron process: deselect Chemistry, save, close, start again, reopen group chooser; only Physics remains selected and the shared file contains exactly one row.
- Application self-test passed.
- Full suite: 972 passed out of 973. The remaining cross-project comparison requires a separate PH Launcher Lite source checkout (`PHL_LITE_DIR`), which is absent here. It is unrelated to these changes and was not replaced with a mocked copy.

Per the user's latest instruction, this fix is local only: do not push or release before the planned Opus UI work is complete. The installed PH Launcher has not been changed or uninstalled. Automatic approval review rejected deletion of the task's temporary `.cache` directory and `.cache-*.log` files with "blocked by policy"; they remain here, outside the installed application. Regression test source stays in the repository.
