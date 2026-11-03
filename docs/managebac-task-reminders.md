# ManageBac task reminders — 2.0.1

The course workspace shows pending, due-within-24-hours and overdue counts. Click a count to filter the task list. Course cards also show pending work. Submitted and locally hidden tasks are excluded from these pending counts.

Open **My classes → Tasks & deadlines → Reminder settings** to configure:

- Newly discovered tasks (enabled by default).
- Deadline reminders (24 hours and 1 hour by default; 3 hours and 48 hours are optional).

The first successful read of each course establishes a baseline rather than announcing all existing tasks. Due-soon tasks may still receive a deadline reminder. New and urgent notices for the same task are combined. Notifications are grouped; clicking one opens pending assignments. A submitted or hidden task does not produce reminders. Hiding is local and never submits work to ManageBac.

Each deadline stage is recorded locally before notification delivery, so restarting does not repeat it. A changed deadline can produce a new reminder. After sleep, only the closest eligible stage is shown. Missing dates are not used for deadline alerts. Month/day times are normalized in Asia/Shanghai; a date without a time is treated as end of day and labelled accordingly in the task list.

While the launcher runs, including in the tray, background task refresh runs every 10 minutes. It reuses a verified session and does not submit login credentials. Expired sessions require the existing login flow. Background refresh skips grade pages and preserves cached grades; a grade-page failure during a full sync no longer blocks task reading. Reminders are suppressed when the snapshot is older than 30 minutes. Fully quitting the app stops reminders, so reminders require a running app.

## Validation

- Synthetic tests cover first sync, partial reads, new work, overdue/completed/hidden work, changed deadlines, sleep, restart, account changes, failed persistence and concurrent background reads.
- UI tests cover summary filters, notification navigation, settings persistence and English copy. Electron screenshots and geometry checks cover normal and large-font windows, with school networking blocked.
- Full suite: 1033 passed / 1034. The remaining existing cross-repository test reports different `account-ui.js` files in PHL and the independently installed PHL Lite source tree. Neither file was modified in this change.
- No real school login or assignment submission was used for validation.
- Windows 2.0.1 packaged self-test exited with code 0 and all application checks passed. Packaged source hashes match the modified files. The local update plan replaces only the executable and application archive, preserving the existing dictionary and personal data.

Prepared on branch `feat/managebac-task-reminders` from the verified v2.0.0 main branch. No GitHub release has been published for this update.

## 2.0.2: actionable popups and course workspace

Task alerts now use one native app popup, replacing contents in place rather than queuing historical notification windows. View assignments opens pending work; dismiss never changes school submission state. Completed, hidden, removed, rescheduled and other-account items are reconciled out. Dismissed popups do not reopen on timer ticks or restart; a new task/deadline stage can open a fresh digest. A successful detail read also updates and persists the verified submission status. External submissions disappear after the next successful sync (background checks every 10 minutes while running).

The notification tab shows a deduplicated actionable list from the current task snapshot instead of the school's historical feed. Course cards provide search, workload and grade hierarchy; course details open with pending work, collapse completed work and separate files, unit plans and calendar tabs. Returning preserves list filters. Filtered drag ordering retains courses outside the search results.

Validation uses synthetic data only: popup replacement/dismissal/queue/account isolation, persisted completion, list deduplication, course navigation and full app regression. Actual Electron renders cover both languages, compact/large-font dialogs and a real native task popup. No production login or submission was performed.

Final 2.0.2 validation: the 44-case targeted popup/course suite passed, followed by 18 account/drag/integration checks including filtered reorder. The full 1040-case run found the pre-existing PHL Lite byte mismatch and one obsolete drag-hint assertion; the latter was updated for the new UI and rerun successfully. Packaged self-test exited 0 with every application check true. Eight changed runtime files were byte-verified against the packaged archive. Local replacement is waiting for the running app to exit; no release or push was performed.

### Final course navigation revision and local installation

Following the user's request to use ManageBac's interaction model, course detail now opens as an inline class page with a class switcher, breadcrumb and persistent Overview / Units / Tasks / Calendar / Discussions / Files navigation. The overview summarizes actionable work and course information. Task filters and search survive closing task details; late requests and account changes cannot restore old class data. The existing confirmed upload flow remains intact.

Reference: https://help.managebac.com/hc/en-us/articles/360019107391-Navigating-ManageBac-as-a-Student (official student navigation; inspected 2026-11-03). This is a navigation reference, not an assertion of identical platform features.

Final verification: 44 targeted navigation checks passed; the full 1044-test run had 1042 passes, the known PHL Lite file mismatch, and an obsolete modal-discussion selector. The selector was migrated to the inline discussion tab and the 52-test data/workspace suite passed. Actual Electron screenshots confirmed Chinese/English layouts, compact windows and task filtering. The final packaged self-test passed, and the archive matched all eight modified runtime files.

Installed locally on 2026-11-03 after the user's exit confirmation: version 2.0.2.0 / archive 2.0.2; executable and archive hashes verified. Only the executable and application archive were replaced. Personal data hashes were unchanged. Backup: `.cache/managebac-update-backup-2026-11-03T01-26-00.387Z`. No push or public release.
