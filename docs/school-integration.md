# 学校数据整合说明

PH Launcher 保留 Electron 应用、学校原网页分区和本地学习工具，并加入 ManageBac 与 EduPage 的只读学校工作台。它不是学校、ManageBac 或 EduPage 的官方软件；原网页仍是成绩、作业与课表的准确信息来源。

## 许可证与来源

本组合发行版采用 **GPL-3.0-or-later**，完整文本见 [LICENSE](../LICENSE)。原 PH Launcher 的 MIT 版权与条款保留在 [LICENSE-MIT-PH-Launcher.txt](../LICENSE-MIT-PH-Launcher.txt)，可分离使用的原始文件仍保留其原有版权声明。

学校登录适配层 `electron/school-auth.cjs` 与 `electron/edupage-auth-rpc.cjs` 基于下列 GPL-3.0-or-later 来源改编，并保留文件内署名：

- [Hello Pinghe! Launcher](https://github.com/huaziqian40-bot/Hello-Pinghe-Launcher) 的 `hellopinghe/managebac/client.py`，提交 `19683149ad5572464d332fbe121c78a2ee5ba359`；
- [edupage-api](https://github.com/EdupageAPI/edupage-api) 0.12.5 的 `edupage_api/login.py` 与 `edupage_api/compression.py`。已核对该版本安装 wheel 的 GPLv3+ 元数据及附带 GPLv3 文本。

本应用没有捆绑 Python 运行时、`edupage-api` wheel 或其 Python 依赖；登录行为已移植到 JavaScript。详细第三方声明见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。这些记录是来源与许可证说明，不代表所有上游功能都已整合，也不构成法律审查结论。

## 登录与网络边界

学校网站各自使用已有的持久化 Electron Session。生产请求通过 `net.request` 绑定到对应 Session，使用 Session Cookie、`redirect: 'manual'`，并在网络层取消跳转后先返回合成的 3xx 响应；地址白名单再决定是否允许下一跳。因此不会由传输层盲目访问重定向目的地。浏览器的 SameSite Cookie 规则仍然生效，适配器不会绕过它。

账号框中的“保存并登录”会在用户确认风险后为 ManageBac 或 EduPage 提交本次登录，无需先打开原网页登录。“设置 → 网站 → 账号记忆”中的自动重新登录仍是单独的明确同意项，默认关闭。凭据保存在操作系统保护的凭据库中；开启自动恢复后，认证器只会在读取操作遇到登录失效时尝试一次恢复并重试该读取一次，且同一网站有冷却时间。修改账号后须重新登录；只有验证码、双重验证等学校验证可能要求本人打开学校页面完成。密码只在主进程中用于授权的登录，不回传给界面或 AI；日志不记录密码、Cookie、响应正文或令牌。

允许的学校读取请求仍是受限的只读路径：ManageBac 的课程、总评、作业、文件名称、日历、CAS/EE 页面，以及 EduPage 的当前身份、课表令牌和仅 `action=loadData` 的 `/gcall` 读取。地址、方法、查询参数、带用户名密码的 URL 和跨站重定向均拒绝。学校读取模块不提交作业或表单，也不提供任意班级或跨账号查询。邮箱连接与发信使用独立的受控邮件模块，详见第三方声明。

## 同步、缓存与显示

学校结果仅存于运行中的内存：EduPage 按周保存多个已读取周，ManageBac 保存当前结果；应用退出后不保留学校快照。EduPage 的新鲜期为 120 秒，ManageBac 为 180 秒。临时网络错误会保留同一账号的最近已验证内容并标记为可能过期；登录退出、账户变化或会话失效会清空相关内存结果，避免混用账号数据。

自动刷新默认关闭。用户可在学校页面明确开启；开启后仅当页面可见时每五分钟检查，并且只在结果过期后读取。查看不同周、点击刷新和初次读取均保持可见的用户操作。首次读取前有隐私提示；学校数据不会自动发送给 AI。教学组必须由用户选择，未读取到的日期显示为缺失而不是“无课”。

学校页面以 inert HTML/JSON 解析器处理响应，不执行其中脚本；单次页面和登录响应设有大小上限。字段以纯文本显示。同步不会覆盖手工创建的本地计划；只有用户确认后，指定日期的课程才会加入本地提醒。

## 使用

1. 在“设置 → 网站 → 账号记忆”中输入 ManageBac 或 EduPage 账号并选择“保存并登录”；是否开启自动重新登录由你单独决定，默认关闭。
2. 打开“我的课表”或“我的课程”，手动刷新所需课表周或课程数据，并核对教学组、日期和教室。“班级课表”展示当前账号所属班级的全部可见教学组；“我的日程”管理本地日程；“平和邮箱”使用本地收件箱。
3. 如需自动刷新，开启页面中的选项；它只在页面可见且数据过期时工作。
4. 以原学校网页核对成绩、作业和调课信息，再选择加入本地课程提醒。

EduPage 的授权登录与整周课表读取，以及 ManageBac 的真实授权登录和课程列表读取均已完成验证；验证过程不记录或公开账号、密码、Cookie 或课程信息。这不代表所有 ManageBac 详情、成绩或作业页面均已完成真实验证。其余测试使用合成响应和隔离 Session，不包含学生凭据、成绩或 Cookie。

## 0.6.0-beta.4 登录边界

EduPage 使用与 edupage-api 0.12.5 相同的 getToken／login RPC；登录成功后，需要以不带密码的 GET 消费服务器发放的一次性票据，才能建立会话。票据限于配置的学校 HTTPS 域、受限路径及有界参数；不能跳过票据后只检查 `/user`。RPC 已提交密码后，不再回退到第二种密码登录。最终在固定 `/user` 验证身份。

ManageBac 的学校 `/sessions` 可能跳转到官方中国 Faria 账号服务 `https://accounts.faria.cn/accounts/otsi?token=…`。只允许服务器发放的这个精确端点及单一 token 参数，切换为 GET 并移除密码正文与表单头；回到学校后固定访问 `/student` 验证。外域、额外参数、无效票据及带密码 POST 的 307／308 重放均拒绝。所有流程最多四次跳转，不把票据写入日志。

合成数据测试覆盖带参数的 EduPage 落地链接；真实授权验证确认 EduPage 授权登录与整周课表读取，以及 ManageBac 授权登录和课程列表读取可用。测试结论不包含、保存或公开任何账号、密码或课程内容，也不能推及其他账号、页面或 ManageBac 详情读取情形。
