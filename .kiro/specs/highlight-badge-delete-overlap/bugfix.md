# Bugfix Requirements Document

## Introduction

**状态：已登记、未修复**（registered, not fixed；2026-10-28 登记）。本文档只登记缺陷，没有任务计划，也没有改动代码。修复需单独批准后另行立项（届时再补 `design.md` / `tasks.md`）。

**缺陷标识**：本 spec 路径 `.kiro/specs/highlight-badge-delete-overlap/` 即缺陷编号。

**来源**：C2 真实浏览器验收（见 `.kiro/specs/multi-user-system/acceptance/c2-browser-acceptance.md`）中发现的 UI 缺陷。它不属于 C2 契约（multi-user-system 需求 9 AC 15），不影响 C2 的验收结论。

在 My Gallery 页面 `/my/trips/<id>`（`client/src/pages/MyGalleryPage.tsx`）上，被标为精华的照片缩略图右上角有两个元素叠在一起：精华徽标 `HighlightBadge`（`client/src/components/HighlightBadge.tsx`）和单张删除按钮 🗑（`data-testid="delete-btn-<id>"`）。徽标盖住了删除按钮的大部分，点击按钮中心会落在徽标上，不会触发删除。

**发现环境**：

- 被测代码：commit `c17be30`（`c17be3040f6b007d20caa8ec9f629d9e999da4ee`）的干净 clone。截至登记时，HEAD 上这两个文件与 `c17be30` 相同。
- 浏览器：Google Chrome 156.0.8078.49 headless（`--headless=new`），经 DevTools 协议驱动。
- 环境：隔离验收环境。客户端是 production build，由隔离 server 在 `http://127.0.0.1:3001` 提供；DB、uploads 和 TEMP_DIR 都在 `/tmp/kiro-browser-acceptance/` 下。

**代码中的成因（`c17be30`，只读核对）**：

- `HighlightBadge` 的样式是 `position: absolute; top: 6; right: 6; width: 24; height: 24; zIndex: 2`。
- 删除按钮的样式是 `position: absolute; top: 4px; right: 4px; padding: 2px 8px`，没有设置 `zIndex`。实测尺寸约 33×26 px。
- 两者锚定在同一个角，徽标的层级更高，所以按钮只露出左侧约 5 px。

### 复现步骤

1. 以 trip 所有者身份登录，打开 `/my/trips/<id>`。该 trip 至少要有一张被标为精华的照片（`highlightByPhotoId` 里有它），并且不在多选模式。
2. 找到这张精华照片缩略图右上角的 🗑 按钮（`delete-btn-<id>`）。
3. 在按钮的几何中心点击。也可以先在控制台执行 `document.elementFromPoint(cx, cy)`，其中 cx、cy 是按钮矩形的中心。
4. 观察：没有出现确认对话框，也没有发出 `PUT /api/trips/<id>/media/trash` 请求，照片状态不变。`elementFromPoint` 返回的是徽标内的 `SPAN`（★），不是按钮。
5. 改为点击按钮露出的左边缘（矩形内 x 方向约 5% 处）：出现确认对话框，确认后发出 trash 请求，照片进入回收站。

### 影响与临时绕过

- **影响**：所有者按常规方式点击 🗑 中心，无法把精华照片移入回收站，界面上也没有任何反馈。非精华照片不受影响，多选模式下的批量删除也不受影响。数据不会丢失或被误删，因为点击根本不会发出请求。
- **临时绕过**：点击 🗑 按钮露出的左边缘，这一做法已在验收中实测生效。按代码阅读，多选模式下「删除选中」走的是同一个 trash 接口，也可作为绕过，但这一路径未在浏览器中实测。

### 证据（归档的绝对路径）

归档根目录：`/Users/huang/Documents/kiro/travel-album-acceptance/c2/20261024T040116Z/`。完整性见同目录的 `MANIFEST.sha256` 和 `ARCHIVE-REPORT.md`。

- 失败截图，即 attempt 3 留下的 4 张。当时点击落在徽标上，没有发出请求。
  - `/Users/huang/Documents/kiro/travel-album-acceptance/c2/20261024T040116Z/evidence/screenshots/B-public-trash-operation-owner-error.png`
  - `/Users/huang/Documents/kiro/travel-album-acceptance/c2/20261024T040116Z/evidence/screenshots/B-unlisted-trash-operation-owner-error.png`
  - `/Users/huang/Documents/kiro/travel-album-acceptance/c2/20261024T040116Z/evidence/screenshots/B-public-delete-operation-owner-error.png`
  - `/Users/huang/Documents/kiro/travel-album-acceptance/c2/20261024T040116Z/evidence/screenshots/B-unlisted-delete-operation-owner-error.png`
  - 原件在 evidence 树中的位置：`/tmp/kiro-browser-acceptance/evidence/20261024T040116Z/screenshots/` 下的同名文件。它们可能被 OS 清理，以归档为准。
- 点击坐标和命中元素：`network/B-<trip>-operation.json` 中的 `deleteButtonHit`，每个 trip 一个文件。
  - `/Users/huang/Documents/kiro/travel-album-acceptance/c2/20261024T040116Z/evidence/network/B-public-trash-operation.json`
  - `/Users/huang/Documents/kiro/travel-album-acceptance/c2/20261024T040116Z/evidence/network/B-unlisted-trash-operation.json`
  - `/Users/huang/Documents/kiro/travel-album-acceptance/c2/20261024T040116Z/evidence/network/B-public-delete-operation.json`
  - `/Users/huang/Documents/kiro/travel-album-acceptance/c2/20261024T040116Z/evidence/network/B-unlisted-delete-operation.json`
  - 四个文件的值相同：按钮矩形 `{x: 242, y: 393.56, w: 33, h: 26}`，`centreTopmost: "SPAN"`。重跑时实际点击在 `fx: 0.05, fy: 0.5`（左边缘），这次删除生效。
- attempt 3 之后的 DB 只读快照：`/Users/huang/Documents/kiro/travel-album-acceptance/c2/20261024T040116Z/evidence/blocking/db-after-attempt3.json`。四个 trash/delete trip 的 photo1 仍是 active/public，说明 attempt 3 的点击没有触发任何操作。
- 文字记录：`/Users/huang/Documents/kiro/travel-album-acceptance/c2/20261024T040116Z/evidence/results.md`，见 "Observations" 第 1 条和 "Driver attempts and data restore" 的 Attempt 3。

### 建议修复方向（未实施）

调整 `HighlightBadge` 与删除按钮在缩略图上的布局，让两者不重叠，并保留各自的交互。例如可以给其中一个改锚点或加偏移，也可以把两者放进同一个不重叠的角标容器。不得通过移除徽标或删除按钮、隐藏任一者，或用 `pointer-events: none` 让徽标失去 hover tooltip 来解决。修复属于 🟢 低风险的前端单文件布局改动，但仍需单独批准。

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN 所有者在 `/my/trips/<id>` 查看一张精华照片（`highlightByPhotoId.has(id)`）且不在多选模式时 THEN `HighlightBadge`（absolute，top 6 / right 6，24×24，`zIndex: 2`）叠在删除按钮 `delete-btn-<id>`（absolute，top 4px / right 4px，约 33×26 px，无 `zIndex`）上方，按钮只露出左侧约 5 px

1.2 WHEN 所有者点击该删除按钮的几何中心时 THEN 点击命中徽标（`document.elementFromPoint` 在按钮中心返回徽标内的 `SPAN`），`handleSingleDelete` 不被调用，不出现确认对话框，不发出 `PUT /api/trips/<id>/media/trash` 请求，照片保持 active

1.3 WHEN 点击被徽标吞掉时 THEN 界面没有任何反馈，所有者无从得知删除没有执行

### Expected Behavior (Correct)

2.1 WHEN 一张精华照片在 `/my/trips/<id>` 显示且不在多选模式时 THEN 精华徽标和删除按钮 SHALL 都完整可见、互不遮挡，并且各自可以单独点击

2.2 WHEN 所有者点击删除按钮的可见区域内任意一点（包括几何中心）时 THEN 系统 SHALL 调用 `handleSingleDelete`，弹出确认对话框，确认后发出 trash 请求，把该照片移入回收站（`status = 'trashed'`，`file_path` 不变）

2.3 WHEN 所有者悬停或点击精华徽标时 THEN 徽标 SHALL 仍显示精华理由 tooltip（`title`），并且不触发删除

### Unchanged Behavior (Regression Prevention)

3.1 WHEN 照片不是精华照片时 THEN 删除按钮 SHALL CONTINUE TO 保持现有位置，点击后的行为不变

3.2 WHEN 照片是精华照片时 THEN 系统 SHALL CONTINUE TO 显示 `HighlightBadge`（`data-testid="highlight-badge"`），保留其 `aria-label`、`title` tooltip，以及传入 `onClick` 时的可交互行为

3.3 WHEN 所有者点击删除按钮时 THEN 系统 SHALL CONTINUE TO 先弹出确认对话框，确认后只执行移入回收站（trashed），不做永久删除。永久删除仍只能经「清空待删除区」完成

3.4 WHEN 处于多选模式时 THEN 删除按钮 SHALL CONTINUE TO 隐藏，多选复选框和批量删除的行为不变

3.5 WHEN 照片属于相似组或重复组时 THEN 「🔗 查看相似组」按钮（top 36px / right 4px）、「🔄 更换默认展示图」按钮和「✏ 编辑」按钮 SHALL CONTINUE TO 可见、可点击，不被新布局遮挡

3.6 WHEN 修复落地时 THEN 系统 SHALL CONTINUE TO 不改动任何 API、服务端行为或数据库 schema
