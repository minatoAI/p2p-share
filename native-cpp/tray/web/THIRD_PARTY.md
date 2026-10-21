# 第三方脚本

托盘小窗里用到的两个二维码库，都是单文件、无外部依赖，随 exe 一起编进资源。

| 文件 | 库 | 版本 | 许可证 | 来源 |
| --- | --- | --- | --- | --- |
| `qrcode.js` | qrcode-generator | 2.0.4 | MIT | https://github.com/kazuhikoarase/qrcode-generator |
| `jsqr.js` | jsQR | 1.4.0 | Apache-2.0 | https://github.com/cozmo/jsQR |

`qrcode.js` 负责把配对链接画成二维码；`jsqr.js` 负责从摄像头帧或图片里解码。
两个文件的许可证声明都保留在文件头部，`jsqr.js` 的 Apache-2.0 全文见
https://www.apache.org/licenses/LICENSE-2.0 。
