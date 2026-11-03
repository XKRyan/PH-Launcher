# ManageBac task reminders — 2.0.1

The course workspace shows pending, due-within-24-hours and overdue counts. Click a count to filter the task list. Course cards also show pending work. Submitted and locally hidden tasks are excluded from these pending counts.

Open **My classes → Tasks & deadlines → Reminder settings** to configure:

- Newly discovered tasks (enabled by default).
- Deadline reminders (24 hours and 1 hour by default; 3 hours and 48 hours are optional).

The first successful read of each course establishes a baseline rather than announcing all existing tasks. Due-soon tasks may still receive a deadline reminder. New and urgent notices for the same task are combined. Notifications are grouped; clicking one opens pending assignments. A submitted or hidden task does not produce reminders. Hiding is local and never submits work to ManageBac.

Each deadline stage is recorded locally before notification delivery, so restarting does not repeat it. A changed deadline can produce a new reminder. After sleep, only the closest eligible stage is shown. Missing dates are not used for deadline alerts. Month/day times are normalized in Asia/Shanghai; a date without a time is treated as end of day and labelled accordingly in the task list.

While the launcher runs, including in the tray, background task refresh runs every 10 minutes. It reuses a verified session and does not submit login credentials. Expired sessions require the existing login flow. Background refresh skips grade pages and preserves cached grades; a grade-page failure during a full sync no longer blocks task reading. Reminders are suppressed when the snapshot is older than 30 minutes. Fully quitting the app stops reminders, and operating-system notification settings still apply.

## Validation

- Synthetic tests cover first sync, partial reads, new work, overdue/completed/hidden work, changed deadlines, sleep, restart, account changes, failed persistence and concurrent background reads.
- UI tests cover summary filters, notification navigation, settings persistence and English copy. Electron screenshots and geometry checks cover normal and large-font windows, with school networking blocked.
- Full suite: 1033 passed / 1034. The remaining existing cross-repository test reports different `account-ui.js` files in PHL and the independently installed PHL Lite source tree. Neither file was modified in this change.
- No real school login or assignment submission was used for validation.
- Windows 2.0.1 packaged self-test exited with code 0 and all application checks passed. Packaged source hashes match the modified files. The local update plan replaces only the executable and application archive, preserving the existing dictionary and personal data.

Prepared on branch `feat/managebac-task-reminders` from the verified v2.0.0 main branch. No GitHub release has been published for this update.
