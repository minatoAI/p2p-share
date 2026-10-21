# Windows 托盘客户端

Win32 + WebView2 外壳，界面是 `web/` 下的本地网页，传输层复用 `native-cpp/src`。
构建命令见根目录 [BUILD.md](../../BUILD.md#windows)。

## 运行

```bat
native-cpp\build\p2p-tray.exe
```

开发构建会从源码目录加载 `web/`，改完页面重启即可看到；加 `--embedded`
强制使用编进 exe 的资源。

## 功能

- 托盘图标、配对、设备名/保存目录/提示音/开机自启设置
- 文件与文字收发、剪贴板同步、公开分享链接
- 断线等待、传输取消、撤销分享
- 配对请求在小窗内确认，不弹系统对话框

## 安装形态

发布安装包是 `p2p-setup.exe`，按用户装到 `%LOCALAPPDATA%\p2p-share`，
不需要管理员权限。默认数据目录是 `%LOCALAPPDATA%\P2PLighthouse`；
卸载默认保留身份和配对记录，只有加 `--purge` 或明确选择才删除。
