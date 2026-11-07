# 第三方说明

本包是 Galatea 的消息渠道，自有代码按 MIT 许可发布（见 LICENSE）；下列参考和改编部分遵循其原始 MIT 许可。

| 本包材料 | 参考来源 | 核对点 |
| --- | --- | --- |
| platforms/weixin.js 的协议请求、无损标识与扫码流程 | Tencent/openclaw-weixin | 874637a0dbc24050f72d1385add4fc6170a2d726 |
| platforms/weixin.js 的纯协议拆分与登录组织 | wangx-wx/dsh-channel-wechat | 0d9ae409e9f51b2c6fb0fd1079c974ed0b80b2ee |
| client.js 的原生插件详情连接卡及组件用法 | wangx-wx/dsh-channel-wechat | 0d9ae409e9f51b2c6fb0fd1079c974ed0b80b2ee |

完整原许可见 licenses/tencent-openclaw-weixin-MIT.txt 与 licenses/dsh-channel-wechat-MIT.txt。

QQ 传输和扫码直接依赖腾讯维护的 @tencent-connect/qqbot-nodejs 与
@tencent-connect/qqbot-connector，QQ 语音消息的 SILK 编码依赖 silk-wasm（MIT，SDK 的可选 peer），
二维码编码依赖 qrcode，多张图拼成一张依赖 sharp，schema 依赖 zod。
这些依赖的许可由各 npm 包保留；安装不运行生命周期脚本。

来源：https://github.com/Tencent/openclaw-weixin 、https://github.com/wangx-wx/dsh-channel-wechat 、
https://registry.npmjs.org/@tencent-connect/qqbot-nodejs 、https://registry.npmjs.org/@tencent-connect/qqbot-connector 、https://registry.npmjs.org/silk-wasm 。