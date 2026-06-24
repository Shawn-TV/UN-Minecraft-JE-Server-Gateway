# Security Policy

## English

Do not open an issue with private server credentials, SSH keys, IP addresses, player data, logs, or world files.

Never commit:

- `.env`
- SSH private keys
- `server/`
- `logs/`
- `backups/`
- Minecraft world data
- player UUID caches
- allowlists, ban lists, operator lists, or production configs

The web panel is designed to listen on `127.0.0.1` by default. Do not expose it to the public internet unless you add authentication, HTTPS, and network restrictions.

If you accidentally publish a secret, revoke it immediately. Removing it from Git history is not enough.

## 中文

不要在 issue 里发服务器密码、SSH key、真实 IP、玩家数据、日志或世界存档。

永远不要提交：

- `.env`
- SSH 私钥
- `server/`
- `logs/`
- `backups/`
- Minecraft 世界数据
- 玩家 UUID 缓存
- 白名单、封禁列表、OP 列表或生产配置

面板默认只监听 `127.0.0.1`。不要直接暴露到公网，除非你自己加了认证、HTTPS 和网络访问限制。

如果密钥已经公开，立刻吊销并更换。只从 Git 历史里删除不够。
