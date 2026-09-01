# Third-Party Notices

PH Launcher 本身采用 MIT License。下列主要第三方项目拥有各自的版权与许可。

## ECDICT

离线英汉词典数据来自 [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)，采用 MIT License。

ECDICT 的完整版权与许可文本保存在 [`assets/dictionary/LICENSE-ECDICT.txt`](assets/dictionary/LICENSE-ECDICT.txt)。生成的 `ecdict.db` 不进入 Git 历史，但随正式应用分发时必须同时保留该 notice。

## Electron and build dependencies

- [Electron](https://github.com/electron/electron) — MIT License；Electron 发行包同时包含 Chromium 等组件的 notices。
- [electron-builder](https://github.com/electron-userland/electron-builder) — MIT License。
- [csv-parse](https://github.com/adaltas/node-csv) — MIT License。

锁定的 npm 依赖及其许可证声明见 `package-lock.json` 和安装后各包自带的许可文件。当前锁定依赖使用 MIT、ISC、BSD、Apache-2.0、Python-2.0、BlueOak、0BSD、WTFPL／许可型双重许可等兼容的许可型条款。

## Optional external software and services

Ollama、Qwen 模型、OpenAI-compatible API 服务以及三个学校网站不是本仓库的一部分，也不会作为 Git 源码提交。用户选择安装或连接时，应分别遵守对应提供方的许可、隐私政策与服务条款。

学校、ManageBac、EduPage、网易、Ollama 及其他第三方名称和商标归各自权利人所有；其出现不代表认可、合作或官方关系。

