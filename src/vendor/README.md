# vendor —— 随程序一起分发的第三方库

这些文件**不是**本项目的代码，是从上游直接下载的原样副本（vendored），
目的是让程序**离线也能用**（不依赖 CDN，校园网/断网时照常工作）。

| 文件 | 版本 | 上游 | 许可 |
|---|---|---|---|
| `marked.min.js` | **12.0.2** | <https://github.com/markedjs/marked> · `https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js` | MIT |
| `purify.min.js` | **3.1.6** | <https://github.com/cure53/DOMPurify> · `https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js` | MIT（或 Apache-2.0，二选一） |

两者都已在根目录 `THIRD_PARTY_NOTICES.md` 里登记。

## 各自做什么

- **marked** —— 把 AI 回复的 Markdown 渲染成 HTML。在此之前回复是按纯文本显示的，
  于是表格（课表/DDL/成绩）、围栏代码块、有序列表、引用、链接全都成了糊在一起的原文。
- **DOMPurify** —— 在 `innerHTML` 之前把结果净化掉。**这一步不能省**：
  AI 回复是外部输入，而本程序的 `window.ph.ai` 能读写工作区文件、发邮件、
  提交作业；回复里若被塞进 `<script>` 或 `<img onerror=...>`，
  等于把这些能力交给它。（提示注入在“读取邮件/网页内容 → 喂给模型”这条链上尤其现实。）

## 怎么升级

```powershell
curl.exe -sL -o src\vendor\marked.min.js  https://cdn.jsdelivr.net/npm/marked@<版本>/marked.min.js
curl.exe -sL -o src\vendor\purify.min.js  https://cdn.jsdelivr.net/npm/dompurify@<版本>/dist/purify.min.js
```

升完跑 `npm test`（`tests/ai-markdown.test.cjs` 有用例盯着"渲染出来了 + 危险标签被清掉"），
并把上表与 `THIRD_PARTY_NOTICES.md` 的版本号改掉。
