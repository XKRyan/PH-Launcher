# Third-party notices

PH Launcher includes or builds upon open-source software. Each component remains subject to its own license.

## Hello Pinghe! Launcher collaboration

[huaziqian40-bot/Hello-Pinghe-Launcher](https://github.com/huaziqian40-bot/Hello-Pinghe-Launcher) informed the student-facing school dashboard and interoperability work. Credit: huaziqian40-bot and its contributors. That project is GPL-3.0-or-later; its Python implementation and edupage-api dependency are not redistributed or linked by this Electron build. PH Launcher's session adapter is separately implemented in JavaScript. Reusing GPL implementation code in future releases would require retaining its notices and complying with the applicable license; this credit does not relicense their project.

## FSRS and HTML parsing

- ts-fsrs 5.4.2, Copyright Open Spaced Repetition, MIT. Provides the actual FSRS 6 review scheduler. [Upstream](https://github.com/open-spaced-repetition/ts-fsrs). Original copyright and license text are retained in the bundled npm package.
- linkedom 0.18.13, ISC. Used only as an inert school-page parser. [Upstream](https://github.com/WebReflection/linkedom). Its license and transitive dependency licenses are retained in bundled packages.

The small vocabulary starter packs use original PH Launcher example sentences and locally enriched ECDICT entries. No exam textbook, copyrighted novel or Bilibili transcript is bundled. Reading materials are supplied locally by users; only import and share material you are authorized to use.

## ECDICT

The offline English-Chinese dictionary is generated from [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT), commit `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`, under the MIT License. The full notice is retained at `assets/dictionary/LICENSE-ECDICT.txt` and is included in packaged applications.

## Electron and npm dependencies

Runtime and build dependencies are listed in `package.json` and locked in `package-lock.json`. Their copyright notices and license terms are available in their upstream packages. Distribution builders should retain all notices required by those licenses.

Ollama and Qwen models are optional external downloads and are not redistributed in the PH Launcher source repository or application package. Their own terms apply when a user chooses to install them.

## International Baccalaureate references

PH Launcher is not affiliated with or endorsed by the International Baccalaureate Organization. The subject and examination-version filters use command-term names and assessment-objective labels as references, with original Chinese study prompts. PH Launcher does not bundle IB subject guides, examination papers, question banks, mark schemes, textbooks, or verbatim official command-term definitions. Students must follow their teacher and the current official subject guide.

IB Docs is an optional third-party external website with no affiliation to or endorsement by the International Baccalaureate Organization. Its files are not embedded, mirrored, downloaded, cached, indexed, proxied, or redistributed by PH Launcher. Users must access and use materials only when authorized by their school or the relevant rights holder.
