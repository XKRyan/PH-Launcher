# Task workspace 2.0.7

- Fix an out-of-scope `input` reference after successful school synchronization.
- Offer explicit refresh controls, preserve loading feedback and retain cache on failures.
- Default to descending task time (publication/creation time when available, otherwise scheduled/due time); keep a due-first alternative.
- Treat a published numeric grade, including zero, as completed even when an old submission label remains. Explicit resubmission requests remain actionable.
- Preserve task/event text blocks, inline images and file attachments. Load bounded raster images through the authenticated ManageBac session; reject unexpected hosts, media types and oversized responses. Unavailable content retains an original-page action.
- Read ManageBac weekly timetables using each user's authenticated session. Match date/time to course ids; reuse a short-lived, account-scoped snapshot and preserve explicit manual overrides. Conflicting time slots do not auto-select a course.
- Send deduplicated task reminders to Windows system notifications as well as the existing application popup. Finished work clears the current notification.
- Remove the offline dictionary page, public lookup IPC and bundled dictionary resource; remove the AI sidebar badge.

Refresh behavior: visible school pages check every five minutes against a two-minute EduPage / three-minute ManageBac cache TTL. Background task reminder synchronization checks every ten minutes while the application runs. Manual refresh bypasses the cache. None of these checks submits login credentials automatically.

Validation: synthetic parser and task-state tests; actual Electron rendering in Chinese/English and small windows; authenticated timetable parser verification without storing personal fixtures in the repository. The separate PHL/Lite account-UI byte-equality assertion has a pre-existing mismatch; no PHL Lite files are modified by this update.
