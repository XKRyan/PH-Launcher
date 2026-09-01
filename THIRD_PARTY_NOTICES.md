# Third-party notices

PH Launcher includes or builds upon open-source software. Each component remains subject to its own license.

## ECDICT

The offline English-Chinese dictionary is generated from [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT), commit `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`, under the MIT License. The full notice is retained at `assets/dictionary/LICENSE-ECDICT.txt` and is included in packaged applications.

## Electron and npm dependencies

Runtime and build dependencies are listed in `package.json` and locked in `package-lock.json`. Their copyright notices and license terms are available in their upstream packages. Distribution builders should retain all notices required by those licenses.

Ollama and Qwen models are optional external downloads and are not redistributed in the PH Launcher source repository or application package. Their own terms apply when a user chooses to install them.
