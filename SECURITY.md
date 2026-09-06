# Security policy

## 0.6.0-beta.1 security boundaries

- School data integration reuses the signed-in ManageBac or EduPage session and is read-only. It does not submit school-site changes, send mail or submit assignments. Results can be incomplete after a site change or session expiry and must be checked against the original site. Parser and isolation tests use synthetic fixtures; real signed-in student accounts have not yet completed end-to-end verification.
- Optional account memory is off until the user consents. Electron `safeStorage` encrypts the saved credentials with the current operating-system user's protection, and autofill is limited to the login pages on exactly three built-in hosts: `mail.shphschool.com`, `shph.managebac.cn` and `pingheschool.edupage.org`. It never submits a form, handles a verification code or bypasses multi-factor authentication.
- Saved school passwords remain local to that computer. They are not included in exports or backups, exposed to AI, supported for custom websites or shown again as plaintext. Anyone able to unlock the same operating-system account may still be able to use autofill, so account memory should not be enabled on a shared computer.
- Vocabulary cards, reading text, contexts, FSRS review logs and self-confirmed reading logs are local data. User-created vocabulary exports and general JSON backups are not additionally encrypted; store and share them accordingly.
- Calendar week, month and year events are local and currently do not generate reminder notifications. This is a product limitation, not a notification failure.

The school connector was implemented independently in the Electron application using design and interface cooperation with Hello Pinghe! Launcher. Its GPL Python runtime is not bundled in PH Launcher.

Please report a vulnerability through the repository's **Security → Report a vulnerability** page when available. If private reporting is unavailable, open a short issue asking the maintainer for a private contact channel; do not include exploit code, credentials, school data, cookies, API keys or personal information in a public issue.

Include the affected PH Launcher version, operating system, a minimal reproduction, expected impact and whether the issue requires a school-site login. Replace all real account data with safe placeholders.

Only the latest actually published release is expected to receive security fixes. Repository version `0.6.0-beta.1` does not by itself mean beta artifacts or a Mac build have been uploaded; verify the actual release page, filenames, signing statements and SHA-256. Never work around Windows or macOS security warnings by disabling platform protections; stop and verify the download instead.
