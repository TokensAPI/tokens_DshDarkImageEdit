# @tokensapi/dsh-dark-image-edit

私密版的无交互图像编辑插件，面向 DeepSeek Harness / TokensCowork（DSH）。基于 TokensAPI，参考 [`@tokensapi/dsh-media-gen`](https://github.com/TokensAPI/tokens_DshMediaGen_code) 的精简版。

只做一件事：用 `qwen_image` 编辑一张图片，返回编辑后的图片（保存为 DSH 会话附件 + 远程 URL）。**无向导、无问答、无确认卡片**，Agent 直接调用工具即可。

**私密原则**：插件把图片当作**不透明黑盒**——Agent 不读取、不描述、不 OCR、不分析图片内容，也不会要求用户描述图片；只把你的编辑指令原样作为 `prompt`，直接上传 → 生成 → 返回结果。图片比例由插件**本地解析文件头元数据**（非 AI）自动选择。

## 兼容性

- DeepSeek Harness / DSH `0.1.0-rc.8`、`0.1.3-alpha.1` 和 `^0.1.5-rc.2`
- Cordis `>=4.0.1 <5`
- Node.js `^22.19.0 || >=24.0.0`

## 功能

- 图片编辑（仅 `qwen_image`），全程**不读取图片内容**（黑盒流程）；
- 图片输入支持 `dsh-attachment:latest/first/last/index:N/附件id`、HTTPS URL、本地路径与 data URL；
- **最多 3 张输入图**：`image` 用逗号分隔多个来源（如 `dsh-attachment:1,dsh-attachment:2`），按顺序映射为 `reference_1..reference_3`；
- **自动画面比例**：本地解析 PNG/GIF/JPEG/WebP 文件头宽高（仅元数据），自动选择最接近的比例（`16:9`/`9:16`/`1:1`/`4:3`/`3:4`/`21:9`）；也可显式指定覆盖；
- **多图时询问参考尺寸**：输入 2~3 张图且未显式指定比例时，会问「输出图参考哪张输入图的尺寸？」（选项数=图片数）；单图不询问，直接按该图自动测量；
- 结果图片保存为 DSH 会话附件并内联展示，可下载；
- 任务超时后可用 `image_edit_status` 查询并恢复；
- 单图流程无任何交互式问答或确认。

## 工具

- `image_edit`：编辑图片。参数：`prompt`（必填，原样使用不分析内容）、`image`（默认最近一张用户上传图片；可逗号分隔多个来源，最多 3 张）、`aspect_ratio`（可选；多图未传时会询问参考哪一张的尺寸，显式传了则不询问）、`n`（默认 `1`）。
- `image_edit_status`：查询并恢复一个超时的编辑任务。

## 安装（使用方）

安装前先完全退出 TokensHarness，在目标 DSH profile 目录：

```bash
cd ~/.dsh/profiles
npm install <路径>/tokensapi-dsh-dark-image-edit-0.1.4.tgz
```

在 `cordis.patch.yml` 注册：

```yaml
- insert:
    - id: dark-image-edit
      name: '@tokensapi/dsh-dark-image-edit'
```

如需覆盖默认值：

```yaml
- insert:
    - id: dark-image-edit
      name: '@tokensapi/dsh-dark-image-edit'
      config:
        defaultEditModel: qwen_image
        allowLocalImageInput: true
```

## 凭据

在 DSH credentials 中配置：

```text
TOKENSAPI_API_KEY
```

本地图片通过第一方存储上传到 `/v1/assets/images`，不使用第三方临时图床；API Key 不会发送给 S3。

## 故障排查

**上传报 `fetch failed` / `ECONNRESET`**
- TokensAPI 的图片存储使用 Cloudflare R2（`r2.cloudflarestorage.com`），结果图片域名是 `s3.tokensapi.ai`。
- 部分网络环境会拦截「指向 Cloudflare 的 TLS 连接」以及「带 AWS 签名参数（`X-Amz-*`）的上传 URL」，导致真实上传/下载失败。
- 排查：用 Node 访问 `https://s3.tokensapi.ai/`（期望 404）与 `https://www.cloudflare.com/`（期望 200）；若为 `ECONNRESET`，说明当前网络受限，需开启代理/VPN（推荐 TUN/全局模式，让应用内 Node 流量也走代理）或更换网络后再试。

**`must not require sensitive header Host`（0.1.0 及更早）**
- R2 的上传签名包含 `host` 头（`X-Amz-SignedHeaders=content-length;content-type;host`），presign 响应的 `required_headers` 里会出现 `Host`。
- 0.1.0 会把 `Host` 当作敏感头拒绝；**0.1.1 起**放行 `Host`，并在 PUT 前校验「签名的 Host」与上传 URL 主机一致，然后交由 fetch 自动发送，保证签名有效。

## 打包

```bash
npm run check   # 类型检查 + 测试 + 构建
npm pack        # 生成可分发安装包
```

安装包不应包含任何 API Key、账户令牌或个人绝对路径。
