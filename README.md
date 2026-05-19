# BOSS Sniffer

BOSS 直聘 HR 候选人筛选自动化 Chrome 扩展。

LLM 自动评估候选人是否符合岗位要求，可选自动招呼 + 求简历闭环，节省 HR 重复筛选时间。

---

## 1. 装扩展（首次 3 步）

### 1.1 下载代码

打开 Git Bash（或 cmd / PowerShell）：

```bash
git clone https://github.com/Yuree000/boss-sniffer.git
```

如果你没装 Git，[去这里下](https://git-scm.com/download/win) 装好后再来。

> 没有 Git 也可以：本仓库右上角 [⬇ Code → Download ZIP](https://github.com/Yuree000/boss-sniffer/archive/refs/heads/main.zip) 也可以下载压缩包。

### 1.2 加载到 Chrome

1. Chrome 地址栏输入 `chrome://extensions` 回车
2. 右上角打开「开发者模式」开关
3. 左上角点「加载已解压的扩展程序」
4. 选刚才 clone 下来的 `boss-sniffer` 文件夹
5. 完成 — 浏览器右上角会出现 BOSS Sniffer 图标

### 1.3 配置 LLM API Key

1. 浏览器右上角点 BOSS Sniffer 图标
2. 侧栏底部点 ⚙️ 设置
3. 在「大模型配置」里填你的 API Key（默认 Anthropic Claude；也可以切到 DeepSeek / 通义千问 等便宜的）
4. 点「测试连接」确保通过

---

## 2. 更新版本（以后 2 步）

### 方式一：git pull（推荐）

```bash
cd boss-sniffer
git pull
```

然后去 `chrome://extensions`，找到 BOSS Sniffer，点底部圆形 ⟳ 刷新按钮。

### 方式二：重新下载 zip

如果用的 zip 方式装的：去仓库主页重新下 zip → 解压覆盖 → chrome://extensions 重新加载。

---

## 3. 怎么用

详见 [`使用指南.md`](使用指南.md) — 含推荐页 / 沟通页 / 看板 / 自动求简历 全功能教程。

---

## 4. 常见问题

| 问题 | 解决 |
|------|------|
| `chrome://extensions` 打不开 | 浏览器地址栏直接输入，不是搜索；或试 `chrome:extensions`（无 //） |
| 加载扩展时报错 | 确认选的是 `boss-sniffer` 文件夹（含 manifest.json 那个），不是它的父目录 |
| 侧栏空白 | 在 BOSS 直聘 (zhipin.com) 页面才能用；其他网站不会触发 |
| LLM 评估超时 | admin → 大模型配置 → 高级配置 → 并发数 调到 3 试试；或换更快的模型（DeepSeek-Chat） |
| 看板数据为空 | 先在推荐页跑一轮筛选（点「开始本轮」），数据才会进看板 |
| 候选人卡片一直「评估中」 | 可能 LLM 重试中，等 1-2 分钟；若超 5 分钟仍未结束自动转「评估失败」 |

---

## 5. 反馈

发现 BUG 或想加功能 → 直接联系 PM 同事。

---

## 6. 许可

私有项目，All rights reserved。仅授权 HR 团队内部使用，不得二次分发或商用。
