#!/usr/bin/env python3
"""PH-Launcher macOS DMG 一键构建：局域网 Mac 同步源码 -> npm ci -> electron-builder --mac dmg -> 拉回 Windows。

参照 D:/phl-lite-dev/scripts/macos_build.py（PLL 的做法），改成 Electron 项目：
  * PLL 是 PyInstaller，这里跑 `npx electron-builder --mac dmg`；
  * 不同步 node_modules（Mac 上重装，平台相关二进制不能跨系统复用）；
  * 必须带上 assets/dictionary/ecdict.db —— 它在 .gitignore 里但打进 app 包，
    build-mac.sh 会断言它存在（约 126MB，首次传输慢，之后按 mtime 增量跳过）。

用法（Windows 开发机）：
    python scripts/macos_build_phl.py --host 192.168.5.13 --user huazixian
默认用 ~/.ssh/macos_build 私钥免密登录。凭据绝不入库（私钥在本机，不提交）。
"""
import argparse
import io
import os
import sys
import tarfile
import time
from pathlib import Path

HERE = Path(os.path.dirname(os.path.abspath(__file__))).parent  # 仓库根

# 不打进同步包的目录/文件
SKIP_DIRS = {".git", "node_modules", "release", "dist", "deliver", ".cache", "work",
             ".integration-reference", ".diagnostics", "test-env", "Mac发布"}
SKIP_NAMES = {"Thumbs.db", ".DS_Store"}
SKIP_SUFFIX = {".exe", ".dmg", ".pkg", ".zip", ".log", ".blockmap", ".local.json"}


def sh(ssh, cmd, timeout=3600, show=True):
    """在 Mac 上执行命令，实时输出，返回 (code, output)。"""
    _, out, err = ssh.exec_command(cmd, timeout=timeout)
    chan = out.channel
    buf = []
    while True:
        while chan.recv_ready():
            data = chan.recv(4096).decode("utf-8", "replace")
            buf.append(data)
            if show:
                print(data, end="", flush=True)
        if chan.exit_status_ready() and not chan.recv_ready():
            break
        time.sleep(0.1)
    code = chan.recv_exit_status()
    rest = err.read().decode("utf-8", "replace")
    if rest and show:
        print(rest, end="", flush=True)
    return code, "".join(buf) + rest


def collect_files():
    """返回 [(绝对路径, 相对路径)]，遵循跳过规则。"""
    picked = []
    for root, dirs, files in os.walk(HERE):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            if name in SKIP_NAMES or any(name.endswith(s) for s in SKIP_SUFFIX):
                continue
            ap = Path(root) / name
            rel = ap.relative_to(HERE).as_posix()
            picked.append((ap, rel))
    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("MAC_HOST", "192.168.5.13"))
    ap.add_argument("--user", default=os.environ.get("MAC_USER", "huazixian"))
    ap.add_argument("--key", default=os.environ.get("MAC_KEY", str(Path.home() / ".ssh" / "macos_build")))
    ap.add_argument("--pass", dest="pwd", default=os.environ.get("MAC_PASS", ""))
    ap.add_argument("--skip-upload", action="store_true", help="只构建，不重新传源码")
    ap.add_argument("--arch", default="x64", choices=["x64", "arm64", "universal"],
                    help="目标架构（这台 Mac 是 Intel -> x64）")
    args = ap.parse_args()

    import paramiko

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    connected = False
    keypath = Path(args.key).expanduser()
    if keypath.exists():
        print(f"[1/7] 连接 {args.user}@{args.host}（密钥 {keypath.name}）… ", flush=True)
        try:
            ssh.connect(args.host, username=args.user, key_filename=str(keypath),
                        timeout=12, look_for_keys=False, allow_agent=False)
            connected = True
        except Exception as exc:  # noqa: BLE001
            print(f"\n      密钥认证失败（{type(exc).__name__}: {exc}）")
    if not connected:
        if not args.pwd:
            print("[1/7] 无可用密钥且未提供密码 —— 无法连接。")
            sys.exit(2)
        ssh.connect(args.host, username=args.user, password=args.pwd,
                    timeout=12, look_for_keys=False, allow_agent=False)
    print("OK")

    _, home_out, _ = ssh.exec_command("echo $HOME")
    mac_home = home_out.read().decode().strip()
    _, arch_out, _ = ssh.exec_command("uname -m")
    mac_arch = arch_out.read().decode().strip()
    _, ver_out, _ = ssh.exec_command("sw_vers -productVersion")
    mac_ver = ver_out.read().decode().strip()
    REMOTE_DIR = f"{mac_home}/phl-mac-build"
    print(f"      Mac home={mac_home}  架构={mac_arch}  macOS={mac_ver}  远端目录={REMOTE_DIR}")

    # ---------- Node 环境（免 sudo 装到 ~/opt/node）----------
    print("[2/7] 检查 Node.js …", flush=True)
    code, _ = sh(ssh, "command -v node && node -v", show=False)
    if code != 0:
        print("      未找到 node，尝试免 sudo 安装到 ~/opt/node …")
        sh(ssh, f"mkdir -p {mac_home}/opt")
        # 判断架构选包
        node_ver = "v22.14.0"
        node_arch = "darwin-x64" if mac_arch == "x86_64" else "darwin-arm64"
        url = f"https://npmmirror.com/mirrors/node/{node_ver}/node-{node_ver}-{node_arch}.tar.gz"
        code, _ = sh(ssh, f"curl -fsSL -o /tmp/phl-node.tar.gz '{url}' && "
                          f"tar -xzf /tmp/phl-node.tar.gz -C {mac_home}/opt && "
                          f"ln -sfn {mac_home}/opt/node-{node_ver}-{node_arch} {mac_home}/opt/node")
        if code != 0:
            print("      Node 自动安装失败（多半是 Mac 上没有 curl 出口或镜像不可达）。如实报告，不继续假装。")
            sys.exit(3)
    PATH_PREFIX = f'export PATH="{mac_home}/opt/node/bin:$PATH"; '
    code, out = sh(ssh, PATH_PREFIX + "node -v && npm -v", show=False)
    print("      " + out.strip().replace("\n", " / "))

    # ---------- 上传源码 ----------
    if not args.skip_upload:
        files = collect_files()
        total = sum(p.stat().st_size for p, _ in files)
        print(f"[3/7] 打包源码 {len(files)} 个文件（{total/1024/1024:.1f} MiB）…", flush=True)
        bio = io.BytesIO()
        with tarfile.open(fileobj=bio, mode="w:gz") as tf:
            for ap, rel in files:
                tf.add(ap, arcname=rel, recursive=False)
        blob = bio.getvalue()
        print(f"      tar.gz {len(blob)/1024/1024:.1f} MiB，上传中…", flush=True)
        sftp = ssh.open_sftp()
        sh(ssh, f"mkdir -p {REMOTE_DIR}", show=False)
        t0 = time.time()
        sftp.putfo(io.BytesIO(blob), f"{REMOTE_DIR}/src.tar.gz")
        print(f"      上传耗时 {time.time()-t0:.0f}s，解压…", flush=True)
        code, _ = sh(ssh, f"cd {REMOTE_DIR} && rm -rf src && mkdir src && "
                          f"tar -xzf src.tar.gz -C src && rm src.tar.gz && echo EXTRACT_OK", show=False)
        if code != 0:
            print("      解压失败"); sys.exit(4)
        sftp.close()
    else:
        print("[3/7] 跳过源码上传")

    # ---------- 依赖 ----------
    print("[4/7] npm ci（Mac 侧装依赖，含 electron 二进制）…", flush=True)
    env_exports = (f'export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; '
                   f'export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"; '
                   f'export npm_config_registry="https://registry.npmmirror.com"; ')
    code, _ = sh(ssh, f"{PATH_PREFIX}{env_exports} cd {REMOTE_DIR}/src && npm ci --no-audit --no-fund", timeout=3000)
    if code != 0:
        print("      npm ci 失败 —— 见上方原始输出。")
        sys.exit(5)

    # ---------- 构建 ----------
    # dmg 给用户手动安装；zip（内含 .app）给应用内自动更新用 —— 未签名应用
    # 也能下载 zip、解压、替换自身，用户只需右键打开一次（见 electron/auto-updater.cjs）
    extra = "--universal" if args.arch == "universal" else f"--config.mac.target=dmg"
    print(f"[5/7] electron-builder --mac dmg zip（arch={args.arch}，未签名测试包）…", flush=True)
    build_cmd = (f"{PATH_PREFIX}{env_exports} cd {REMOTE_DIR}/src && "
                 f'npx electron-builder --mac dmg zip --{args.arch} --publish never')
    code, _ = sh(ssh, build_cmd, timeout=3600)
    if code != 0:
        print("      构建失败 —— 见上方原始错误输出。")
        sys.exit(6)

    # ---------- 列产物 ----------
    print("[6/7] 产物清单：", flush=True)
    code, out = sh(ssh, f"cd {REMOTE_DIR}/src/release && ls -la *.dmg *.zip *.yml 2>/dev/null", show=False)
    print(out)
    dmgs = [l.split()[-1] for l in out.splitlines() if l.strip().endswith(".dmg")]
    zips = [l.split()[-1] for l in out.splitlines() if l.strip().endswith(".zip")]
    if not dmgs:
        print("      release/ 里没有 dmg —— 构建没产出目标文件。")
        sys.exit(7)
    if not zips:
        print("      注意：没有产出 .zip（自更新载荷）—— 检查 --mac 是否带上了 zip target。")

    # ---------- 拉回 ----------
    out_dir = HERE / "release"
    out_dir.mkdir(exist_ok=True)
    print(f"[7/7] 拉回到 {out_dir} …", flush=True)
    sftp = ssh.open_sftp()
    for name in dmgs + zips:
        local = out_dir / name
        t0 = time.time()
        remote = f"{REMOTE_DIR}/src/release/{name}"
        size = sftp.stat(remote).st_size
        done = {"n": 0}

        def cb(xfer, tot, _done=done, _name=name, _t0=t0):
            _done["n"] = xfer
            pct = xfer * 100 // tot if tot else 0
            if xfer % (8 * 1024 * 1024) < 32768 or xfer == tot:
                print(f"      {_name}: {pct}% ({xfer/1024/1024:.0f}/{tot/1024/1024:.0f} MiB, {time.time()-_t0:.0f}s)", flush=True)

        sftp.get(remote, str(local), callback=cb)
        got = local.stat().st_size
        print(f"      {local}  {got} 字节  {'OK' if got == size else 'SIZE MISMATCH!'}")
    sftp.close()
    ssh.close()
    print("\n完成。注意：这是**未签名**测试包，只能内部验证，不能当正式分发物"
          "（正式版需 Developer ID 签名 + Apple 公证 + 实机验收）。")


if __name__ == "__main__":
    main()
