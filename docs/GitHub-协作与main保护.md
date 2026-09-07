# 邀请协作者并保护 main

以下步骤由仓库所有者登录 GitHub 后完成。本文是操作说明，不表示设置已经完成。

## 邀请同学

打开 [PH Launcher 协作者设置](https://github.com/XKRyan/PH-Launcher/settings/access)，点击 **Add people**，输入同学的 GitHub 用户名或邮箱。核对账号后发送邀请，请对方在邮件或 GitHub 中接受。

个人仓库的协作者接受邀请后可读写代码，不需要授予仓库所有者权限。[GitHub 邀请说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/inviting-collaborators-to-a-personal-repository)、[个人仓库权限](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/permission-levels-for-a-personal-account-repository)。

## 基础保护，同时允许正常推送

1. 打开 [分支设置](https://github.com/XKRyan/PH-Launcher/settings/branches)，点击 **Add classic branch protection rule**。
2. **Branch name pattern** 填 `main`。
3. 保持 **Allow force pushes**、**Allow deletions** 不勾选。
4. 如果需要直接推送 main，不勾选 **Require a pull request before merging**，也不要勾选 **Lock branch**。
5. 点击 **Create**，返回页面确认 main 的规则存在。

这套基础保护阻止强制覆盖历史和删除分支，但不会审查每次正常提交是否正确。其他现有规则或组织策略仍可能额外限制推送。[GitHub 分支保护说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule)。

## 如果之后希望先互相检查代码

可再启用 **Require a pull request before merging** 和至少一人审批。这样协作者仍能修改软件，但先提交到新分支，经检查后合入 main，不再直接推送 main。
