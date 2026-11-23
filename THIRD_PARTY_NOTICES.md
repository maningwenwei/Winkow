# 第三方组件许可声明（Third-Party Notices）

Winkow 自身源码以 [MIT 许可证](LICENSE) 发布。但本项目在开发、构建和运行时使用 / 分发了若干第三方组件，它们各自的许可证与 MIT 相互独立。本文件汇总这些组件及其许可信息，以满足相应许可证的署名与合规要求。

> 本文件为基于公开信息的整理，不构成法律意见。如有疑问请以各组件官方许可证文本为准，或联系相应权利人。

---

## 一、随发布包分发、但与本项目许可证不同的组件

### 1. AirPlay 接收引擎（uxplay-windows / UxPlay 分支）

- **许可**：GNU General Public License v3.0（GPLv3）
- **来源**：https://github.com/FDH2/UxPlay
- **在本项目中的用途**：iPhone 屏幕镜像的接收引擎，负责 AirPlay 协议握手、解密与音视频解码。
- **分发形式**：以独立二进制目录 `airplay/` 随安装包 / 便携版分发；**不包含在本源码仓库中**。
- **重要提示**：该引擎为 GPLv3 软件。若你打包并分发包含该引擎的可执行程序，该分发物须遵守 GPLv3 的义务，包括但不限于：随附完整对应源代码（或提供获取途径的书面报价）、保留版权与许可声明、标明修改。请自行评估并确保合规。

该引擎附带以下组件（信息摘录自其 `airplay/LICENSE.rtf`）：

| 组件 | 许可证 | 来源 |
| :--- | :--- | :--- |
| UxPlay | GPLv3 | https://github.com/FDH2/UxPlay |
| mDNSResponder | 3-Clause BSD / Apache 2.0 | https://github.com/apple-oss-distributions/mDNSResponder |
| GStreamer 及插件（base / bad / good / libav） | LGPL | https://gstreamer.freedesktop.org/ |

### 2. FFmpeg

- **许可**：依构建配置，通常为 LGPL 2.1+ 或 GPL（本项目所附引擎内的 `ffmpeg.exe` 以其自身许可为准）。
- **来源**：https://ffmpeg.org/
- **在本项目中的用途**：由 AirPlay 引擎用于音视频转码 / 图像编码。
- **提示**：随 `airplay/` 引擎目录分发，许可义务随该引擎一并遵守。

---

## 二、开发与构建时使用的开源组件（MIT / Apache 等）

以下组件作为 `devDependencies` 通过 npm 安装，不随最终源码仓库提交，其许可证允许在 MIT 项目中使用；此处列出以示鸣谢。

| 组件 | 许可证 | 用途 |
| :--- | :--- | :--- |
| Electron | MIT | 桌面应用框架（运行时随打包产物分发） |
| electron-builder | MIT | 应用打包（NSIS 安装版 / portable 便携版） |
| koffi | MIT | 调用 Win32 原生 API |
| Node.js | MIT | 脚本运行时 |

完整的间接依赖及其许可证文本见 `package-lock.json` 中各包的声明。

---

## 三、商标与名称

- **AirPlay** 是 Apple Inc. 的商标。本项目与 Apple Inc. 无隶属、授权或背书关系。
- **UxPlay** 为 FDH2 的项目名称，本项目使用的分支与其官方无隶属或背书关系。
- 「Winkow」「摸鱼小窗」及相关狐狸形象为本项目标识，不属于 MIT 授权范围，未经许可请勿用于误导性宣传。

---

## 四、合规提示

1. **源码签出**：本仓库只含 Winkow 自身源码（MIT），不含 GPL 引擎二进制，签出源码本身不受 GPL 约束。
2. **自行打包分发**：若你把第三方 GPL/LGPL 引擎一起打包分发，请确保履行对应许可证义务（见第一节）。
3. **使用发布包**：使用官方发布包的用户，其权利与义务由该发布包整体决定；如需再分发，请同时遵守本项目 MIT 与内嵌第三方组件的许可证。

如有许可相关问题，欢迎通过 Issue 提出；我们会在能力范围内尽快回应。
