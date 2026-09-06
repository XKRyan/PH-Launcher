# Third-party notices

The combined PH Launcher distribution is licensed under GPL-3.0-or-later; see [LICENSE](LICENSE). Original PH Launcher material retains its existing MIT copyright and terms in [LICENSE-MIT-PH-Launcher.txt](LICENSE-MIT-PH-Launcher.txt) where it is used separately. This notice records provenance and does not replace any upstream copyright notice or license.

These notices apply to PH Launcher `0.6.0-beta.4`.

## School authentication provenance

`electron/school-auth.cjs` and `electron/edupage-auth-rpc.cjs` adapt GPL-licensed school-authentication behavior into the Electron application. They include notices for:

- [Hello Pinghe! Launcher](https://github.com/huaziqian40-bot/Hello-Pinghe-Launcher), `hellopinghe/managebac/client.py`, commit `19683149ad5572464d332fbe121c78a2ee5ba359`, GPL-3.0-or-later. Copyright hzq and Hello Pinghe! Launcher contributors.
- [edupage-api](https://github.com/EdupageAPI/edupage-api), version 0.12.5, `edupage_api/login.py` and `edupage_api/compression.py`, GPL-3.0-or-later. The installed 0.12.5 wheel metadata classifies it as “GNU General Public License v3 or later (GPLv3+)” and includes the GPLv3 text. Copyright EdupageAPI/edupage-api contributors.

No Python runtime, wheel, or Python dependency from either project is bundled in this Electron application. The JavaScript port and the combined application remain GPL-3.0-or-later; source distributions must retain the file-level notices and this provenance.

## Mail client provenance

`electron/mail-client.cjs` adapts mailbox connection behavior from [Hello Pinghe! Launcher](https://github.com/huaziqian40-bot/Hello-Pinghe-Launcher), `hellopinghe/app/services.py`, commit `19683149ad5572464d332fbe121c78a2ee5ba359`, GPL-3.0-or-later. Copyright hzq and Hello Pinghe! Launcher contributors. The combined application remains GPL-3.0-or-later; this notice records provenance and does not grant access to any mailbox or service.

## Other components

- ts-fsrs 5.4.2, MIT — FSRS 6 review scheduler. [Upstream](https://github.com/open-spaced-repetition/ts-fsrs).
- linkedom 0.18.13, ISC — inert school-page parser. [Upstream](https://github.com/WebReflection/linkedom).
- imapflow 1.7.7, MIT — IMAP client. [Upstream](https://github.com/postalsys/imapflow).
- mailparser 3.9.20, MIT — mail parser. [Upstream](https://github.com/nodemailer/mailparser).
- nodemailer 10.0.0, MIT-0 — SMTP client. [Upstream](https://github.com/nodemailer/nodemailer).
- [ECDICT](https://github.com/skywind3000/ECDICT), commit `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`, MIT. Its notice is in `assets/dictionary/LICENSE-ECDICT.txt`.
- Electron and other npm dependencies retain their own upstream terms; their resolved versions are listed in `package-lock.json`.

Ollama and Qwen models are optional external downloads and are not redistributed by this repository or application package. Their own terms apply.

## References and external services

PH Launcher is not affiliated with or endorsed by the International Baccalaureate Organization, Shanghai Pinghe School, ManageBac, EduPage, NetEase, IB Docs, or Ollama. IB Docs is only an external link: its files are not embedded, mirrored, downloaded, cached, indexed, proxied, or redistributed by PH Launcher. Users must use school and third-party services only when authorized.
