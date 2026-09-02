# 修改边界与记录规范

**每次动手改任何东西之前，先读这份文档。**

本文档定义三件事：

1. 什么可以改、什么必须先问（边界）
2. 改完之后要记录到哪里（记录义务）
3. 本项目已经踩过的具体坑（教训清单）

与其他文档的关系：`AGENTS.md` 定义总体工作规则，`docs/agent/verify-commands.md` 定义验证命令，`docs/agent/known-issues.md` 记录运行时陷阱，本文档定义**改动的边界与留痕**。文档权威顺序见 `AGENTS.md` 第 5.1 节。

---

## 第一部分：改动边界

### 三档风险与对应动作

| 档位 | 判定 | 动作 |
| --- | --- | --- |
| 🟢 低 | 单文件、可逆、不改契约 | 直接改，改完验证并报告 |
| 🟡 中 | 跨文件、改 API 形状、改共享类型、改管线阶段行为 | 先说明影响面与验证方案，再改 |
| 🔴 高 | 见下方红线清单 | **停下来，解释清楚，等批准** |

### 🔴 红线清单：必须先获批准

数据与用户资产：

- 改数据库 schema（`server/src/database.ts` 的 `initTables()` 或任何 `ALTER TABLE`）
- 删除数据库记录
- 删除或永久修改用户上传的媒体文件
- 改上传流程
- 改媒体删除 / 回收 / 清理行为
- 任何可能影响既有用户数据的改动

安全与部署：

- 改认证或授权行为
- 改环境变量**名称**（改值不属于代码改动）
- 改 AI provider 配置
- 改生产部署配置、nginx 生产配置
- 碰 `.env*`、`*.pem`、私钥、凭证文件

工程结构：

- 新增依赖（见下方专章）
- 大范围重构
- 重命名对外 API
- 删除既有测试

### 媒体状态：四个概念不许混用

这是本项目最容易出事的地方。改任何筛选、去重、清理逻辑前必须分清：

| 状态 | 含义 | 数据库表现 |
| --- | --- | --- |
| rejected | 被判定为不合格 | 业务判断，不一定落库 |
| trashed | 移入待删除 | `media_items.status = 'trashed'` + `trashed_reason`，**`file_path` 不变** |
| permanently deleted | 永久删除 | 物理删除文件，红线操作 |
| excluded from curated output | 不进精选输出 | `is_highlight = 0` / `is_highlight_tier = 0`，照片本身仍是 active |

**软删除不变式**：所有自动筛选阶段只能写 `status` 和 `trashed_reason`，不得改 `file_path`，不得删文件。

**不要用删除来绕过筛选或展示的 bug。**

### 阈值：主注册表与允许的例外

阈值的主注册表是 `server/src/services/dedupThresholds.ts` 的 `PROCESS_THRESHOLDS`。视频阈值另有 `videoThresholds.ts`。

新增**图片筛选检测阈值**必须进 `PROCESS_THRESHOLDS`，除三类豁免：单阶段 VLM 批次大小、单阶段并发上限、VLM 传输配置。

已登记的例外位置见 `.kiro/specs/photo-curation-fix/requirements.md` 需求 5 的「Permitted Secondary Locations」表。**改那张表等于改需求**，需同步更新。

写死数值在业务代码里是不允许的 —— 日志也必须打印从注册表读到的实际值，不能打印字面量。

### 依赖

新增依赖前必须报告：包名、为什么需要、检查过哪些现有替代、影响 server 还是 client 还是两者、引入什么风险。

优先用已有依赖和内置 API。包名可疑或像仿冒的要指出来。

### 危险命令

不经明确要求不得执行：`rm -rf`、`DROP DATABASE`、`DELETE FROM`、`TRUNCATE`、`git reset --hard`、`git clean -fd`、`npm/pnpm/yarn add <新包>`、任何指向生产的部署脚本。

---

## 第二部分：改完记录到哪里

### 记录矩阵

改动落地后，按类型更新对应文档。**漏记录等于没改完。**

| 改动类型 | 必须更新 | 可能需要更新 |
| --- | --- | --- |
| 实现某个 spec 的任务 | 该 spec 的 `tasks.md` 勾选 + `traceability.md` 重新生成 | — |
| 改变了行为，与需求不符 | 该 spec 的 `requirements.md` | `design.md`、根 `requirements.md` 第二部分摘要 |
| 改了阈值默认值 | `dedupThresholds.ts` 注释 + 相关 spec 的 requirements | `photo-curation-fix` 需求 5 的例外表 |
| 改了 API 路由 / 请求响应形状 | 相关 spec 的 requirements | `multi-user-system/requirements.md` 的路由权限总表 |
| 改了数据库 schema | `database.ts` + 相关 spec | `multi-user-system/requirements.md`（若涉及 users/trips 归属） |
| 修了一个会复发的坑 | `docs/agent/known-issues.md` | 本文档第三部分 |
| 新增了没有 spec 的功能 | 新建 spec，或写 as-built 需求文档 | 根 `requirements.md` 第二部分索引 |
| 决定暂缓某任务 | 该 spec 的 `tasks.md` 加「先保留」标注 + 文末「当前状态」小节 | — |

### 追溯性标注格式

`tasks.md` 里每个任务都要能追到需求。本仓库存在四种既有写法，**沿用所在文件的写法，不要混用**：

```
_Requirements: 1.1, 1.2_          英文，多数 spec
_需求: 2.3, 2.4_                  中文半角冒号，hybrid-dedup
_需求：R10-AC1_                   中文全角冒号 + R-AC 格式，smart-video-editing
_Requirements: R7-AC1_            英文 + R-AC 格式，video-upload-pipeline
```

测试任务用 `**Validates: Requirements X.Y**` 或 `**验证: 需求 X.Y**`。

改完 `tasks.md` 或 `requirements.md` 后跑一次：

```
python3 .kiro/specs/_gen_traceability.py
```

它会重新生成 23 份 `traceability.md`，并报告需求覆盖缺口、越界引用。**有告警就说明记录没做完。**

> **产物不入库：** `_gen_traceability.py` 已入库，上面这一步现在可以直接运行。但它生成的 23 份 `traceability.md` **不进版本控制**，由 `.gitignore` 管理 —— 它们可再生、无 provenance，且入库会带来 merge conflict。人工维护的 `.kiro/specs/photo-curation-fix/traceability-verified.md` 是另一回事，它入库，不属于 generator 的输出范围。
>
> 跑完请按 `docs/agent/verify-commands.md` 确认：exit 0、23 份产物、`.tmp` 残留 0，且连续两次生成 byte-identical。`_check_completed.py` 同理可直接运行。

### 状态标记约定

| 标记 | 含义 | 勾选状态 |
| --- | --- | --- |
| `- [x]` | 已完成且已验证 | 勾选 |
| `- [ ]` | 未完成 | 不勾 |
| `- [ ]*` | 可选任务（多为属性测试） | 不勾 |
| `- [ ]` + 【待验证】 | 代码已存在但未经验收标准逐条核对 | **不勾** |
| `- [ ]` + 【先保留】 | 用户明确决定既不推进也不关闭 | **不勾** |

【待验证】和【先保留】都不许自作主张勾选或删除。看到【先保留】不要"顺手做掉"。

### 需求编号变更的连带义务

如果增删了某条需求的验收标准，编号会漂移，必须同步：

1. 该 spec 的 `tasks.md` 里所有 `_Requirements:` 引用
2. 该 spec 的 `design.md` 里所有 `**Validates:**` 标注
3. 重新生成 `traceability.md` 并确认无越界告警

本项目已经因为漏做这一步产生过 7 处失效引用。

---

## 第三部分：本项目已经踩过的坑

以下都是实际发生过的，不是假设。

### 坑 1：需求文档孤立地过时

`photo-curation-fix` 的 `requirements.md` 需求 1 写的过曝判据（HSV V>220 或 LAB L>230、面积 ≥5%、最小连通块 500px）与实现完全不同（V=245、S≤45、纹理梯度、面积 0.6%、300px，且 LAB 从未实现）。而同一个 spec 的 `design.md` 和 `tasks.md` 一直是对的。

**教训**：不要因为"其他文档是对的"就假定需求文档也对。以代码为实现真相。

### 坑 2：一个 spec 内部自相矛盾

`smart-curation` 需求 1.2/4.1/8.3 写阈值 0.94，需求 11 写"默认改为 0.98（原 0.94）"，前三处从未同步。

**教训**：调整阈值时全文搜索该数值，或改成引用常量名而非写死数字。

### 坑 3：需求写了单一真相源，实现做不到

`photo-curation-fix` 需求 5.1 曾要求所有阈值都从 `PROCESS_THRESHOLDS` 读，但 `similarityGrouper.ts`、`aiFinalDedup.ts`、`vlmClient.ts`、`unionFind.ts` 各有自己的常量，而对应任务却已勾选完成。

**教训**：写不到的绝对规则不要写。要么改实现，要么把例外显式登记。

### 坑 4：需求描述了一个已停用的实现

`smart-curation` 需求 12 描述 `runAIFinalDedup`，但流水线早已改用 `runSceneDedup`，前者只保留作回滚（`void runAIFinalDedup;`）。

**教训**：换实现时要处理旧需求 —— 标注取代、改写、或废止，三选一，不要放着。

### 坑 5：任务 100% 完成但需求没全覆盖

`smart-curation` 显示必做任务 10/10 完成，看着是 100%，实际 12 条需求里 3 条（共 35 条验收标准）从未进入任务计划，代码写了但没有任何任务或测试背书。

**教训**：任务完成度与需求覆盖率是两回事。追加需求时必须同时追加任务。

### 坑 6：可选任务标记方式不统一，完成度不可比

多数 spec 把属性测试标为 `- [ ]*`（可选），`async-processing` 没标，所以它显示 28/42 而别人显示 100%。差异来自标记方式，不代表实施质量。

**教训**：跨 spec 比较完成度前先确认标记口径。

### 坑 7：全项目 9 条正确性属性零测试覆盖

`photo-curation-fix` 的 `design.md` 定义了 9 条正确性属性，对应 7 个可选测试任务，一个都没做。全仓库可选任务完成度 4/172。

**教训**：功能实现完成不等于行为被固定住。改动这些区域时没有测试网。

### 坑 8：文档扫描工具的格式盲区

因为生成器只认英文 `_Requirements:`，曾误判 `hybrid-dedup` 和 `smart-video-editing` 两个 spec「完全没有追溯标注」，实际它们用的是中文格式。

**教训**：工具报告"缺失"时，先确认是真缺失还是格式不匹配。

### 坑 9：三套并行的需求文档

根目录 v1 三件套（2026-03-31 归档）、`docs/*-v2.md`（2026-05-06 愿景，非契约）、`.kiro/specs/*`（真实迭代契约）。曾长期没有任何文档说明它们的关系。

**教训**：以 `.kiro/specs/` 为契约。不要从 v1/v2 文档倒推需求去实现。

### 坑 10：VLM provider 配置不兼容导致 AI 阶段静默跳过

用户用 `OPENAI_API_KEY` 配置，而 `vlmClient.ts` 当时只认 `DASHSCOPE_API_KEY` 等，`isVLMAvailable()` 返回 false，所有 VLM 阶段被静默跳过，表现为"AI 去重效果很差"。

**教训**：AI 阶段被跳过必须上报原因（现由 `vlmStatus` 六值机制覆盖），不能静默。

---

## 第四部分：动手前的自检清单

```
[ ] 我读过本文档了吗
[ ] 这次改动属于哪一档风险？红线清单里有吗
[ ] 相关 spec 的 requirements / design 我读过了吗
[ ] 我确认过当前代码的实际行为，而不是只看文档吗
[ ] 会碰到媒体状态的四个概念吗？分清了吗
[ ] 会碰阈值吗？该进主注册表还是属于已登记例外
[ ] 需要新增依赖吗？报告过了吗
[ ] 改完要更新哪些文档？（查第二部分记录矩阵）
[ ] 会导致需求编号漂移吗？连带义务清楚吗
[ ] 验证命令是哪几条？（见 verify-commands.md）
```

## 第五部分：验证与报告

验证命令以 `docs/agent/verify-commands.md` 为准。当前项目**没有** lint 脚本、**没有** smoke 脚本，不得声称它们通过。

后端改动至少跑：

```
cd server && npx tsc --noEmit
cd server && npm test
```

前端改动至少跑：

```
cd client && npx tsc -b
cd client && npm test
```

报告必须区分「实际执行过的命令」与「建议执行的命令」，并按以下格式：

```
改动文件:
- path/to/file

风险档位:
- 低 / 中 / 高

改了什么:
- 平实语言说明

没有改什么:
- 明确保住的边界

文档更新:
- 按记录矩阵更新了哪些

验证:
- 命令: 通过 / 失败 / 未运行

遗留风险:
- 未解决的风险
```
