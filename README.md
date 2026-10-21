# dsh-sudo-askpass

![CI](https://github.com/seudut/dsh-sudo-askpass/actions/workflows/ci.yml/badge.svg)

在 DSH 的**输入框位置**弹出 sudo 密码面板，把密码通过 stdin 交给远端 `sudo`。密码不进入对话记录、工具参数、环境变量或磁盘。

> 面向 DSH 0.2.x（在 0.2.1-rc.2 上验证）；宿主 macOS / Linux，远端需 POSIX + sudo。

![DSH 输入框位置的 sudo 密码面板](docs/panel.png)

*截图来自真实的 DSH Web 界面：面板接管 composer 位置，替换输入框。*

## 为什么

DSH 的 `bash` 工具没有 TTY、也没有 stdin，`ssh host 'sudo ...'` 无法输入密码。常见替代只有两种：

- 给远端开 `NOPASSWD`（等于常驻 root）；
- 把密码贴进聊天或脚本（进转录、进日志、进磁盘）。

这个插件补上第三种：**按需由人在 DSH 界面里输入一次**（默认每次调用），密码只走 stdin。

## 功能

- **composer 审批式面板**：和 approval 一样接管输入框，显示主机、命令、密码框、取消/执行；支持 Enter 提交、Esc 取消。
- **单一缓存开关（`passwordTtlMs`）**：默认 `0`，每次调用都要输入密码；设为正整数时，密码只在宿主内存保留该时长，期间重复的 root 命令不再弹框。
- **自动探测 sudo 路径**：依次尝试 `/usr/bin/sudo`、`/bin/sudo`、`/usr/local/bin/sudo`、Homebrew/MacPorts、NixOS 的路径，最后用 `command -v sudo` 兜底。
- **不依赖远端 ticket**：执行前不探测 ticket，每次执行后都 `sudo -k` 清理远端时间戳。按“无 TTY 的 ticket 不跨 ssh 复用”设计，因此也不会利用一个本来可复用的 ticket。
- **stdin 硬化**：root 命令的 stdin 固定重定向到 `/dev/null`。即使 sudo 因为已有 ticket 没有读取密码，残留的密码行也不会被命令读到。
- **优先绝对路径 sudo**：先试标准绝对路径，减少远端 PATH 劫持面。
- **中英文**：跟随 DSH 的语言设置（`ctx.locale`）。
- **无内置超时**：密码等待和命令执行都一直阻塞，直到回答/取消或 ssh 结束；插件不替远端命令设时间上限。

## 安装

### 方式一：插件管理器

侧栏 → **插件** → **添加插件** → **安装第三方插件** → **本地目录** → 选择本仓库目录。

### 方式二：手动

```bash
# 1. 安装到 profile（desktop / web 按你的 profile 名替换）
dsh plugin --profile desktop add /absolute/path/to/dsh-sudo-askpass

# 2. 在 profile 的 cordis.patch.yml 末尾加入
cat >> ~/.dsh/profiles/desktop/cordis.patch.yml <<'EOF'

- insert:
    - id: sudo-askpass
      name: 'dsh-sudo-askpass'
EOF

# 3. 重启 DSH
```

宿主半需要重启加载；客户端半支持 HMR，但首次安装建议整体重启一次。

## 使用

让 agent 调用 `remote_sudo`：

> 用 `remote_sudo` 在 aliyun 上执行 `apt-get update`

工具参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `host` | 是 | `~/.ssh/config` 里的别名，例如 `aliyun` |
| `command` | 是 | 远端 root 命令，例如 `apt-get update` |
| `description` | 否 | 面板里显示的短标签，例如“更新 apt 索引” |

- `passwordTtlMs` 内（已缓存）：直接执行，不弹框；
- 否则：面板出现，输入后执行；
- 取消或停止：本次工具调用失败，不会挂起后续对话；默认没有提示超时，会一直等待。

前置条件：`ssh <host>` 必须能**密钥登录**（插件传 `BatchMode=yes`，不会询问 SSH 密码）。

## 配置

```yaml
- insert:
    - id: sudo-askpass
      name: 'dsh-sudo-askpass'
      config:
        passwordTtlMs: 0         # 0 = 每次都要密码；正整数 = 内存缓存毫秒数
```

| 键 | 默认 | 说明 |
|---|---|---|
| `passwordTtlMs` | `0` | `0` = 每次都要密码；正整数 = 密码在宿主内存保留的毫秒数 |

## 安全模型

**能挡住**：argv（`ps`）、环境变量、shell history、工具参数、模型上下文、会话日志、远端磁盘、SSH 明文传输。

**挡不住**（请按自己的威胁模型评估）：

- **浏览器 JS 域**：密码经过输入框、React state 和 `fetch`。DSH 的 Web UI 是插件化的，任何已安装的 client 插件、XSS 或恶意扩展都能读；devtools 也能看到请求体。
- **宿主进程**：密码在 Node 内存中；host 插件可读；宿主进程不受 bash 沙箱约束。
- **本机回环 HTTP**：默认无 TLS；同机进程可观察。通过反向代理暴露时必须 HTTPS + 认证。
- **远端**：sudo 被 PATH 劫持、sudoers 被改或主机被入侵时，stdin 可被截获；密码复用会放大影响。
- **内存残留**：JS 字符串不可擦除，可能留在 GC / swap / crash dump。
- **单因子**：没有 Touch ID 或硬件密钥；人工闸门就是“输入密码”这一下。
- **认证后的范围**：密码只负责认证，认证后命令就是 root，不限制它做什么。

**sudo 路径**：自动探测先试固定绝对路径，只有都不存在时才退回 `command -v sudo`（依赖远端 PATH）。

**更强替代**：宿主侧原生 askpass（`osascript` hidden answer / `SSH_ASKPASS`）、Touch ID（`pam_tid`）、scoped `NOPASSWD` + DSH 审批。密码建议专用、不与登录密码复用。

## 限制

- 只支持 SSH 远端 sudo，**不支持本机 root**。
- 每次调用新建一条 ssh，没有持久 TTY；插件不假设 sudo ticket 能跨 ssh 复用，并在每次执行后 `sudo -k`。即使远端 ticket 本来可复用，本插件也不会利用它；想减少弹框请用 `passwordTtlMs`。
- 同时只展示一个 prompt。
- 没有内置超时：不回答/不取消时该轮会一直保持，直到点取消/停止；远端命令也不会被插件按时间杀掉；取消/停止只杀本地 ssh，远端进程不保证停止。需要硬上限时在远端命令里自己用 `timeout`。
- 远端需 POSIX shell + sudo；Windows 远端未验证。

## 开发

```bash
npm test                          # 宿主集成测试 + 客户端渲染测试
node test/real-host-probe.mjs     # 手动：对真实主机用错误密码验证链路
```

宿主测试用 PATH 上的假 `ssh` 模拟 `sudo -S` 密码校验和 `sudo -k`，不需要真实 sudo。

## English

`dsh-sudo-askpass` adds a `remote_sudo` tool and a composer-hosted password panel to DSH. It runs `ssh <host> sudo -S ...` and writes the password to ssh's stdin only. Every call asks by default; a positive `passwordTtlMs` keeps the password in host memory for that window. The remote sudo timestamp is always invalidated with `sudo -k`; the plugin does not reuse no-TTY tickets. The command's stdin is `/dev/null`, so a leftover password can never reach the root command. The password is never stored in the transcript, tool arguments, environment, argv, or disk. It is an exposure-reduction tool, not a sandbox: the browser/plugin realm, the host process, and a compromised remote remain inside the trust boundary.

## 发布

```bash
npm test
npm pack --dry-run
npm publish --access public
```

`dsh-sudo-askpass` 在 npm 上当前未被占用（2026-10-21 检查）。

## License

MIT
