# 打包与发布（绿色包 / 安装程序 / 自助更新）

> 这一页只讲**怎么把 Studio 交到别人手里**。产品怎么用见仓库根的 `README.md`。

## 一条命令

```bash
node packaging/build-desktop.mjs
```

它会：构建前端 → 打绿色包 → 打更新包 → 写 `update.json`（更新清单）。
产物都在 `dist-desktop/`：

| 产物 | 是什么 | 给谁 |
| --- | --- | --- |
| `LINGHAN-Studio/` | 目录形态：自带 Node + Electron + 程序 + 启动器 | 自己用 / 拷进 U 盘 |
| `LINGHAN-Studio-<版本>-win-x64.zip` | 上者的压缩包（约 143 MB） | 发给别人（解压双击就能跑） |
| `LINGHAN-Studio-<版本>-update.zip` | **只有程序**（不含 Node 与 Electron） | 已经装过的人自助更新 |
| `update.json` | 更新源清单（`version` / `url` / `sha256` / `notes`） | 放到 HTTPS 上给 `STUDIO_UPDATE_URL` 用 |
| `LINGHAN-Studio-<版本>-setup.exe` | 安装程序 | 想「像正常软件一样安装」的人（需装 Inno Setup） |

常用开关：

```bash
node packaging/build-desktop.mjs --node "C:\path\to\node.exe"   # 指定要捆进去的 Node
node packaging/build-desktop.mjs --url https://…/update.zip     # 写进 update.json 的下载地址
node packaging/build-desktop.mjs --notes "这一版修了什么"        # 更新说明（界面上会显示）
node packaging/build-desktop.mjs --skip-build                   # 前端已构建，省掉一次构建
node packaging/build-desktop.mjs --no-electron                  # 不打 Electron（包小一半，退回浏览器窗口）
```

## 桌面端是**独立应用窗口**

双击「启动 Studio.cmd」打开的是**应用窗口**，不是浏览器页面：没有地址栏、没有标签页，
任务栏上是它自己的图标，关掉窗口就是退出应用（服务端进程一起带走），
再点一次图标是把已有窗口叫到前面，窗口大小与位置记在数据目录里（`window.json`）。

分工：**Electron 只做窗口与生命周期，服务端仍由自带的 `node/node.exe` 跑**。
原因是 Electron 内建的 Node **没有** `node:sqlite`（这个产品的数据库模块），
实测 Electron 33 / Node 20 直接报 `No such built-in module: node:sqlite`，
而类型剥离也要 Node 22.18+。代价是包大一倍多（约 180 MB + 110 MB），换来的是它真的是个应用。

三级退化（`STUDIO_WINDOW=browser|app|electron` 可强制）：

| 条件 | 打开的窗口 |
| --- | --- |
| 包里有 `electron/`（默认打） | **Electron 应用窗口**：无地址栏/标签页，任务栏是自己 |
| 没有 Electron，但有 Edge/Chrome | Chromium 的 `--app=` 窗口：同样无地址栏，外壳是浏览器厂商的；用专用 profile，不碰用户自己的浏览器 |
| 都没有 | 系统默认浏览器（这时它确实是网页） |

Electron 二进制走镜像下载（`ELECTRON_MIRROR`，默认 `https://registry.npmmirror.com/-/binary/electron/`）：
这台机器直连 GitHub Releases 拿不到二进制，npm 包本身装了也没用。下不下来会**明说跳过**
并退回 `--app=` 窗口，不会假装成功。

### 端口探测为什么不能只「绑一下试试」

Windows 上，容器把端口转发到 `0.0.0.0:8080` 时，我们去绑 `127.0.0.1:8080` **能成功**（实测），
于是探测说「空闲」—— 而连接可能落到容器里的另一个服务上，
表现是「桌面应用里看到的是别的程序」。所以判据是**先连一下**（连得上就是有人在听），
绑定检测只作第二道。实测：容器在跑时桌面端会自己选 8081。
这份探测由启动器与 Electron 外壳共用（`desktop/ports.mjs`）。

安装程序**不是必需的**：绿色包解压即用，`setup.exe` 只是多给一个开始菜单快捷方式与卸载项。
没装 [Inno Setup](https://jrsoftware.org/isdl.php)（`ISCC.exe`）时脚本会**明确说跳过**，
而不是假装成功。

## 三类部署，三种升级方式

| 部署方式 | 怎么升级 | 为什么 |
| --- | --- | --- |
| 绿色包 / 安装程序 | **页面上点「装这一版」**（设置页 → 软件更新） | 目录布局是自己的，能安全地换 `versions/<版本>` 指针 |
| Docker | 拉新镜像、重建容器 | 容器里的文件系统不该被进程自己替换 |
| 源码运行 | `git pull` | 同上 |

服务端只在**绿色包**里提供自助更新（判据是启动器设的 `STUDIO_HOME` 与 `current.txt`）。
它在 Docker / 源码运行时明确回一句「这个部署方式不能自助更新」，而不是留一个
「让服务器下载并运行任意 zip」的接口。

## 自助更新到底做了什么

1. `GET /api/update`：读 `STUDIO_UPDATE_URL` 指向的清单，和当前版本比。
2. `POST /api/update/apply`：**按清单里的地址**下载（请求体不能指定地址）→ 校验 `sha256`
   → 解到 `versions/<版本>/` → 改 `current.txt` → 界面上说「重启后生效」。
3. 启动器 (`launch.mjs`) 每次启动读 `current.txt`，指着哪个版本就跑哪个。

四条安全线（都在 `apps/server/src/update.ts` 与 `zip.ts` 里，有单测）：

- **清单里没有 `sha256` 就不装** —— 更新器最不该做的事是装一个来路不明的包。
- **逐条核对 CRC 与解压后长度**，坏包当场拒绝（解出一半比不更新更糟）。
- **zip-slip 防线**：条目名里的绝对路径、`..`、盘符、反斜杠一律拒绝。
- **装失败不碰老版本**：先解到 `.staging-<版本>`，成功后改名过去，最后才写指针。

## 许可：为什么不捆绑 ComfyUI

ComfyUI 是 **GPL-3.0**。把它打进安装包，整个安装包的再分发就要按 GPL 走，
而这份产品是**专有许可**（见 `LICENSE`）。所以：

- 安装包**只装 Studio 自己**；
- 出图后端由**首启向导**填一个地址，指向用户自己那份 ComfyUI（不复制、不分发它的任何文件）；
- 同理，任何模型权重都不进包 —— 那既是许可问题，也是几十 GB 的体积问题。

想接云端（火山方舟）的人根本不需要 ComfyUI；想接本机显卡的人本来就装过 ComfyUI。

## 首启向导

没有 `STUDIO_PASSWORD` 且没点过「以后再说」时，界面会先走三步向导：数据目录 → 访问密码 →
出图后端。它由一个**唯一允许未登录写入**的接口 `POST /api/setup` 支撑，
而且配过一次之后永久 403（不会变成后门）。设置页里改的一切仍然生效，向导只是把
「刚拿到包的人必须先做的三件事」按顺序问了一遍。
