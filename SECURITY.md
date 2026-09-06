# Security policy

## 0.6.0-beta.7 additions

- AI inbox access requires separate launcher-control and mail-reading consent. Only explicit mail requests offer the read-only mail tools. Model/provider/endpoint changes revoke mail consent; changing permissions or mailbox identity aborts affected reads before their results are passed to the model. API providers receive the permitted content when used for these requests.
- Mail tool output is bounded and omits attachments and extracted link targets. Account-security subjects are blocked from body access; URL and credential-like text detection is best-effort, not a guarantee that all sensitive content will be recognized. Email and tool results are untrusted data, not authority to perform actions. Writes still require confirmation; AI cannot send mail or submit assignments.
- Email links are shown separately from the inert text body. Opening requires a user gesture, a fresh main-process lookup, URL validation and a default-cancel confirmation. Validation does not establish that a sender or destination is trustworthy. Remote images are not loaded automatically.
- Startup only prepares a saved, enabled local AI configuration. API/off modes do not start or prewarm local AI. Only an already-installed, verified default Ollama runtime can be started; this path cannot install software or download models, and does not terminate shared services.
- Beta.7 is a local Windows test build. It has not been uploaded to GitHub and has no matching new Mac package. Check actual release artifacts rather than inferring availability from a source version.

## 0.6.0-beta.2 security boundaries

- School data integration reuses the signed-in ManageBac or EduPage session and is read-only. It does not submit school-site changes, send mail or submit assignments. Results can be incomplete after a site change or session expiry and must be checked against the original site. Parser and isolation tests use synthetic fixtures; real signed-in student accounts have not yet completed end-to-end verification.
- Optional account memory is off until the user consents. Electron `safeStorage` encrypts the saved credentials with the current operating-system user's protection. Autofill is limited to the login pages on exactly three built-in hosts: `mail.shphschool.com`, `shph.managebac.cn` and `pingheschool.edupage.org`. ManageBac and EduPage automatic re-login is a separate, explicit opt-in and is attempted only after a read operation encounters an expired login; it uses a restricted allowlist, retries the read once, and has a per-site cooldown. It does not handle a verification code or bypass multi-factor authentication.
- Saved school passwords remain local to that computer. They are not included in exports or backups, exposed to AI, supported for custom websites or shown again as plaintext. Anyone able to unlock the same operating-system account may still be able to use autofill, so account memory should not be enabled on a shared computer.
- Vocabulary cards, reading text, contexts, FSRS review logs and self-confirmed reading logs are local data. User-created vocabulary exports and general JSON backups are not additionally encrypted; store and share them accordingly.
- Calendar week, month and year events are local and currently do not generate reminder notifications. This is a product limitation, not a notification failure.

The combined distribution is GPL-3.0-or-later. `electron/school-auth.cjs` carries provenance for the GPL-derived Hello Pinghe! Launcher and edupage-api login behavior; no Python runtime, wheel, or Python dependency is bundled. The transport keeps manual redirects under the site allowlist and does not automatically visit a cross-site destination.

Please report a vulnerability through the repository's **Security → Report a vulnerability** page when available. If private reporting is unavailable, open a short issue asking the maintainer for a private contact channel; do not include exploit code, credentials, school data, cookies, API keys or personal information in a public issue.

Include the affected PH Launcher version, operating system, a minimal reproduction, expected impact and whether the issue requires a school-site login. Replace all real account data with safe placeholders.

Only the latest actually published release is expected to receive security fixes. Repository version `0.6.0-beta.2` does not by itself mean beta artifacts or a Mac build have been uploaded; verify the actual release page, filenames, signing statements and SHA-256. Never work around Windows or macOS security warnings by disabling platform protections; stop and verify the download instead.
