# NapCat × DeepSeek Harness 群聊机器人

这个目录里的程序把 QQ 群消息接到 DeepSeek Harness（dsh）。NapCat 负责登录 QQ 和收发群消息，dsh 负责生成回复。每个群各自保留一段对话。

人设在 `persona/default.md`。改完保存即可，这个群的下一条消息会带上新内容。

## 准备

1. 安装 Node.js 22 或更新版本。
2. 先让 dsh 能正常调用模型。本机跑过 `npx @deepseek-ai/dsh web` 并配好 API Key 即可，ACP 会沿用这份登录状态。
3. 启动 NapCat 并扫码登录机器人 QQ。在 NapCat 网络配置里打开正向 WebSocket，地址 `127.0.0.1`，端口 `3001`，消息格式选 `array`。如果设置了 access token，填进 `config.json`。

## 运行

```sh
npm start
```

第一次运行会从 `config.example.json` 生成 `config.json`。终端出现「NapCat 已连接」和「当前 QQ」后，把这个 QQ 拉进群，@ 它即可聊天。

常用指令也要 @ 机器人：

- `/help`：看提示
- `/reset`：清空这个群的对话记忆

`bot.groups` 填群号后，只有这些群会回复。留空则响应所有群。`bot.admins` 填 QQ 号后，只有这些人能 `/reset`。

## 安全

默认 `bot.toolPolicy` 是 `deny`。群聊里 dsh 如果申请读文件、改文件或执行命令，桥接会拒绝。dsh 本身仍是带工具的编程代理，请用小号，并把群限制在你信任的范围内。

`allow` 会放行这些工具调用，群成员的话就有机会影响到运行机器人的这台电脑。
