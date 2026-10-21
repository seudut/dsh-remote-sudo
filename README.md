# dsh-sudo-askpass

在 DSH 的**输入框位置**弹出 sudo 密码面板，把密码通过 stdin 交给远端 `sudo`。密码不进入对话记录、工具参数、环境变量或磁盘。

> 面向 DSH 0.2.x（在 0.2.1-rc.2 上验证）；宿主 macOS / Linux，远端需 POSIX + sudo。

## 为什么

DSH 的 `bash` 工具没有 TTY、也没有 stdin，`ssh host 'sudo ...'` 无法输入密码。常见替代只有两种：

- 给远端开 `NOPASSWD`（等于常驻 root）；
- 把密码贴进聊天或脚本（进转录、进日志、进磁盘）。

这个插件补上第三种：**每次需要时，由人在 DSH 界面里输入一次**，密码只走 stdin。

## 功能

- **composer 审批式面板**：和 approval 一样接管输入框，显示主机、命令、密码框、取消/执行；支持 Enter 提交、Esc 取消。
- **`sudo -n` 预检**：执行前先探测 sudo 时间戳。ticket 有效时**不弹框、不发密码**，行为和终端里的 sudo 一致。
- **三种缓存策略**（`cacheMode`）：
  - `sudo`（默认）：完全交给 sudo 的时间戳；
  - `password`：额外在宿主内存缓存密码（TTL），适合无 TTY 时 ticket 不共享的主机；
  - `none`：每次强制弹框，执行后 `sudo -k` 失效远端 ticket。
- **stdin 硬化**：root 命令的 stdin 固定重定向到 `/dev/null`。即使 sudo 因 ticket 有效而没有读取密码，残留的密码行也不会被命令读到。
- **绝对路径 sudo**：默认 `/usr/bin/sudo`，减少远端 PATH 劫持面。
- **中英文**：跟随 DSH 的语言设置（`ctx.locale`）。
- **可配超时**：提示超时、密码 TTL、命令超时都可调。

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

- sudo 已有有效 ticket：直接执行，不弹框；
- 需要密码：面板出现，输入后执行；
- 取消或超时：本次工具调用失败，不会挂起后续对话。

前置条件：`ssh <host>` 必须能**密钥登录**（插件传 `BatchMode=yes`，不会询问 SSH 密码）。

## 配置

```yaml
- insert:
    - id: sudo-askpass
      name: 'dsh-sudo-askpass'
      config:
        cacheMode: sudo          # sudo | password | none
        promptTimeoutMs: 120000  # 5s - 10min
        passwordTtlMs: 300000    # 仅 password 模式，0 关闭缓存
        commandTimeoutMs: 600000
        sudoPath: /usr/bin/sudo  # 必须是绝对路径
```

| 键 | 默认 | 说明 |
|---|---|---|
| `cacheMode` | `sudo` | `sudo` 用 sudo 时间戳；`password` 额外缓存密码；`none` 每次强制 |
| `promptTimeoutMs` | `120000` | 面板等待时间，超时后工具失败 |
| `passwordTtlMs` | `300000` | `password` 模式的宿主内存 TTL；`0` 关闭 |
| `commandTimeoutMs` | `600000` | 远端命令超时 |
| `sudoPath` | `/usr/bin/sudo` | 远端 sudo 绝对路径 |

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

**更强替代**：宿主侧原生 askpass（`osascript` hidden answer / `SSH_ASKPASS`）、Touch ID（`pam_tid`）、scoped `NOPASSWD` + DSH 审批。密码建议专用、不与登录密码复用。

## 限制

- 只支持 SSH 远端 sudo，**不支持本机 root**。
- 每次调用新建一条 ssh，没有持久 TTY；sudo ticket 能否跨调用复用取决于远端 `sudoers`（`timestamp_type`、`tty_tickets`、`timestamp_timeout`）。`sudo` 模式在 ticket 有效时不弹框；如果远端不共享无 TTY 的 ticket，可改用 `password` 模式。
- 同时只展示一个 prompt。
- 远端需 POSIX shell + sudo；Windows 远端未验证。

## 开发

```bash
npm test                          # 宿主集成测试 + 客户端渲染测试
node test/real-host-probe.mjs     # 手动：对真实主机用错误密码验证链路
```

宿主测试用 PATH 上的假 `ssh` 模拟 probe / ticket / 密码 / `-k`，不需要真实 sudo。

## English

`dsh-sudo-askpass` adds a `remote_sudo` tool and a composer-hosted password panel to DSH. It runs `ssh <host> sudo ...` and writes the password to ssh's stdin only. A preflight `sudo -n true` reuses sudo's own timestamp, so the panel appears only when a password is actually required. The command's stdin is `/dev/null`, so a leftover password can never reach the root command. The password is never stored in the transcript, tool arguments, environment, argv, or disk. It is an exposure-reduction tool, not a sandbox: the browser/plugin realm, the host process, and a compromised remote remain inside the trust boundary.

## 发布

```bash
npm test
npm pack --dry-run
npm publish --access public
```

`dsh-sudo-askpass` 在 npm 上当前未被占用（2026-10-21 检查）。

## License

MIT
