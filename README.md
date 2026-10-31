# dsh-fetch-image

一个宿主级 DSH 插件，注册模型工具 `fetch_image`：GET 一个 HTTP(S) 地址，并把响应体中的图片作为 image content block 返回给模型。

实现与内置 `read_image` 相同：下载的字节先交给 `ctx.attachments.saveImage()` 解码、规范化和持久化，再在工具结果里返回「文字说明 + 图片」。因此大图会自动缩放，模型下一轮就能直接看到画面。

## 用法

```text
fetch_image(url: "127.0.0.1:3570/")
```

- 地址可以省略协议，`127.0.0.1:3570/` 会按 `http://127.0.0.1:3570/` 请求；也接受 `https://...`。
- 支持 PNG / JPEG / WebP / GIF。类型以字节签名为准，服务端把 PNG 标成 `application/octet-stream` 也能识别。
- 非 2xx、超时（30 秒）、超过部署图片大小上限都会返回可读的错误原因。
- 当前模型路由必须声明 image 输入；否则与 `read_image` 一样直接拒绝，避免下载后 provider 才失败。

典型用途是读取本机 Minecraft 客户端的截图接口：

```text
fetch_image(url: "127.0.0.1:3420/ctl/prtsc")
```

也可以读取任何返回图片的本地或远程服务。

## 安装

插件以 bundle 形式提供。在这个 profile 里可以：

```text
plugin_manager(action: "install_bundle", target: "/home/DSH/Projects/DSHPlugs/dsh-fetch-image")
```

安装后 `fetch_image` 对所有 Agent 可见。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 工具注册与实现 |
| `cordis.patch.yml` | bundle 插入的宿主插件行 |
| `locale/en.json`、`locale/zh.json` | 插件管理器的标题与说明 |
| `icon.svg` | 插件图标 |

## 许可证

本项目采用**代码与文档分离**的双重许可：

| 范围 | 内容 | 许可 |
| --- | --- | --- |
| 代码 | `index.js`、`cordis.patch.yml`、`package.json`、`locale/*.json`、`icon.svg` | [GNU General Public License v3.0 only](LICENSE)（GPL-3.0-only） |
| 文档 | `README.md` 及仓库中的其他说明文字 | [CC BY-NC-SA 4.0](LICENSE.CC-BY-NC-SA-4.0) |
