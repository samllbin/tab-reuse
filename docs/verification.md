# 验证范围

## 已完成

- 核心行为通过 Node.js `node:test` 和模拟 Chrome 扩展 API 验证，运行方式见 README。
- 1.0.0 已在 Ego Lite 0.5.1.11（macOS）安装并实机验证：自动复用、原页不刷新且保留表单状态、前台焦点切换、默认 `chrome://newtab/` 首次导航、面板强制新开并刷新保留、面板优先复用、暂停和恢复。
- 1.1.0 使用通用名称 Tab Reuse，添加 Edge、Brave、Opera、Vivaldi 的已知内部新标签页地址识别；该变更有回归测试。

实机测试通过真实扩展面板、后台与 Chrome tabs API 触发导航，未模拟系统地址栏键盘输入。模拟 API 测试不能替代浏览器端到端测试。

## 仍需各浏览器验收

Chrome、Edge、Brave、Opera、Vivaldi 尚未在本项目中逐一实机验证。右键菜单点击、跨窗口/浏览器工作区、浏览器重启后的恢复行为也尚未实机验收。移动浏览器及禁用扩展的浏览器不在目标范围内。

建议每个浏览器依次检查：

1. 打开测试链接，再新建空白 tab 并输入同一链接，应回到原 tab，原页状态不变。
2. 使用「强制新开」，应保留两个 tab；刷新后仍保留。
3. 通过链接右键菜单分别使用两种打开方式。
4. 暂停后新开重复链接应被保留；重新启用不应清理已经存在的重复 tab。
5. 查询参数、片段或协议不同时不应合并。
6. 在已有内容的 tab 中修改地址，仍应按浏览器正常导航，不自动关闭。
7. 后台打开重复页，不应打断前台窗口；跨窗口复用应优先选择当前窗口。

## 官方 API 与内部新标签页地址依据

- [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)：`storage.session` 为 Chrome 102+ / MV3 功能。
- [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)：标签查询、创建、切换、关闭，以及 `lastAccessed` 的版本限制。旧版本缺少该字段时项目回退到稳定 tab ID 排序。
- [Edge 扩展 API 支持](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)
- [Edge 内部新标签页地址](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/homepagelocation)
- [Brave 官方新标签页 QA](https://github.com/brave/brave-browser/issues/23559)
- [Opera 官方 startpage 地址示例](https://blogs.opera.com/desktop/2019/04/opera-61-0-3296-0-developer-update/)
- [Vivaldi History / Start Page](https://help.vivaldi.com/desktop/navigation/history/)

这些资料支持接口和地址的选用，不代表已在每个浏览器上完成测试。
