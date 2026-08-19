# 需求 / 设计 / 任务 对齐矩阵：photo-curation-fix

## 这份文档的用途

把同一个 spec 的三份文件横向对齐，回答四个问题：

1. 每条需求对应哪些设计章节？
2. 每条需求由哪些任务实现？
3. 完成了多少？
4. 实现落在哪些代码文件里？

**本文档不是需求来源**，它是索引。需求以 `requirements.md` 为准，设计以 `design.md` 为准，进度以 `tasks.md` 的勾选状态为准。三者变更后需要回来更新本表。

行号基于当前版本（`design.md` 628 行），改动 design.md 后行号会偏移，届时以章节标题定位。

---

## 一、总览

| 需求 | 目标（一句话） | 验收标准条数 | 设计章节 | 任务 | 必做任务完成度 | 可选任务完成度 |
| --- | --- | --- | --- | --- | --- | --- |
| **1** 主体级过曝检测 | 整图偏暗但主体被打爆时也能判为过曝 | 16 条 + Q1–Q4 | §组件 1、属性 1、属性 2 | 2.1, 2.2, 2.3* | **2 / 2** | 0 / 1 |
| **2** 结果归并器识别过曝 | 过曝的 trash 决定不再被归并阶段静默覆盖 | 9 条 | §组件 2、§数据模型、属性 3、约束 4、约束 6 | 4.1, 4.2*, 9.1 | **2 / 2** | 0 / 1 |
| **3** 跨批次全局相似 | 相隔数小时拍的同主体照片也能被比较去重 | 17 条 | §组件 3、属性 4、属性 5、属性 6、约束 1、约束 2、约束 3 | 6.1–6.5, 6.6*, 9.1, 9.2* | **6 / 6** | 0 / 2 |
| **4** VLM 状态上报 | 区分「AI 没找到要删的」与「AI 根本没被调用」 | 11 条 | §组件 4、§数据模型、属性 7、约束 5、约束 6、约束 7 | 7.1–7.3, 7.4* | **3 / 3** | 0 / 1 |
| **5** 阈值与日志一致 | 日志里的阈值必须等于实际生效的阈值 | 9 条 | §组件 5、属性 8 | 1.1, 1.2, 1.3*, 2.1, 2.2, 9.1 | **5 / 5** | 0 / 1 |
| **6** 阶段错误标签 | 过曝阶段的错误不再被标成 blur 阶段 | 3 条 | §组件 6、属性 9 | 3.1, 3.2* | **1 / 1** | 0 / 1 |

带 `*` 的是 tasks.md 中标记为可选的任务（`- [ ]*`），全部是属性测试或回归测试。

**总计：必做任务 25 / 25 完成，可选任务 0 / 7 完成。**

---

## 二、逐需求明细

### 需求 1：主体级过曝检测

**要解决的问题**：水下摄影中，整幅图偏暗但主体（海蛞蝓、潜水装备、珊瑚）高光被打爆。原有的全局过曝检测（>40% 像素超过 240）完全抓不到这种情况。

**需求要点**

- 合格区域需同时满足 Q1–Q4：V ≥ 245、S ≤ 45、Sobel 梯度 std < 5.0、连通块 ≥ 300px
- 中心 60% 区域 1.5 倍加权（criterion 1）
- severity 三档：severe（总面积 ≥ 0.012 或单区域 > 0.015）、mild（≥ 0.006）、none（criteria 3–5）
- mild 扣 0.15 质量分但不 trash；severe 才 trash（criteria 7、9）
- 两层失败处理：Python 侧返回 none（criterion 13），Node 侧回退到 sharp 全局检查（criterion 14）
- 7 个阈值全部由 CLI 参数传入（criterion 16）

**设计依据**

| 位置 | 内容 |
| --- | --- |
| `design.md` §Components 1（L51–119） | `detect_subject_overexposure` 的判据、返回结构、反误判策略 |
| `design.md` 属性 1（L371–375） | 分档判定的形式化表述 |
| `design.md` 属性 2（L377–381） | 有纹理的亮区（沙地）不得计入 |
| `design.md` §Error Handling（L550） | 解码失败的处理 |

**任务与状态**

| 任务 | 描述 | 状态 |
| --- | --- | --- |
| 2.1 | 在 `analyze.py` 实现 `detect_subject_overexposure` | ✅ 完成 |
| 2.2 | 接入流水线的 Python 调用，含 sharp 回退与 severity 映射 | ✅ 完成 |
| 2.3* | Python 侧检测测试（属性 1、属性 2 + 合成图） | ⬜ 可选，未做 |

**实现文件**

- `server/python/analyze.py` — `detect_subject_overexposure()`（约 L117–310）、`detect_overexposure()`（约 L319，全局检查）
- `server/src/services/pythonAnalyzer.ts` — CLI 参数拼装（约 L279–301）
- `server/src/services/pipeline/runTripProcessingPipeline.ts` — sharp 回退（约 L272–293）

**已知缺口**：`center_weight`（1.5）是 `analyze.py` 的函数默认值，不在 CLI 参数里，因此无法配置。已登记在需求 5 的次级位置表。

---

### 需求 2：结果归并器识别过曝

**要解决的问题**：过曝阶段已把图片标为 trashed，但归并阶段不认识 `overexposure` 这个原因，导致决定被静默覆盖。

**需求要点**

- `TrashReason` 恰好四个值：`blur`、`overexposure`、`duplicate`、`global_similarity`（criterion 1）
- 四级优先级：blur > overexposure > duplicate > global_similarity（criterion 5）
- 接受 `globalSimilarityAssessment` 参数（criterion 7）
- `finalStatus = trashed` 当且仅当 `trashedReasons` 非空（criterion 8）
- 只有 severity `severe` 才构成 trash 理由，`mild` 仅扣分（criterion 9）

**设计依据**

| 位置 | 内容 |
| --- | --- |
| `design.md` §Components 2（L120–151） | 归并器改动点 |
| `design.md` §Data Models — `PerImageFinalDecision`（L322–339） | `trashedReasons` 结构 |
| `design.md` 属性 3（L383–387） | 完整性与顺序 |
| `design.md` 约束 4（L457–478） | 写入语义（后置阶段只追加 trash，不能反向解除） |
| `design.md` 约束 6（L514–535） | 统计计数不得重复计算 |

**任务与状态**

| 任务 | 描述 | 状态 |
| --- | --- | --- |
| 4.1 | 归并器支持 overexposure 与 global_similarity | ✅ 完成 |
| 4.2* | 属性测试：完整性与优先级顺序 | ⬜ 可选，未做 |
| 9.1 | 端到端串联（与需求 3、5 共享） | ✅ 完成 |

**实现文件**

- `server/src/services/pipeline/resultReducer.ts` — 优先级 push 顺序（约 L39–55）
- `server/src/services/pipeline/types.ts` — `TrashReason`（L79）

---

### 需求 3：跨批次全局相似候选生成

**要解决的问题**：相似照片若落在不同拍摄时间批次，原流程不会互相比较，导致同主体的冗余照片全部保留。

**需求要点**

- 用 **DINOv2**（384 维）嵌入，不是 CLIP；只处理 `prelimActiveMediaIds`（criterion 1）
- 三档分类：confirmed ≥ 0.88、gray_zone ≥ 0.75、低于则直接丢弃（criteria 3–5）
- 两阶段 Union-Find：灰区对不得桥接两个簇（criteria 6–7）
- 簇上限 `CLUSTER_SIZE_CAP` = 8，超出则反复移除最弱边（criterion 8）
- 直接边要求：只有与保留者或 medoid 有直接 confirmed 边才能被 trash（criterion 9）
- 分级消解：纯 confirmed 簇走本地质量选择不调 VLM；含灰区簇走 VLM；VLM 失败时灰区簇 `fallback_keep_all`（criteria 10–13）
- 复合质量分 `sharpness*0.4 + aesthetic*0.3 + exposure*0.3 + 过曝惩罚`（criterion 14）

**设计依据**

| 位置 | 内容 |
| --- | --- |
| `design.md` §Components 3（L152–219） | 全局相似生成器的完整设计 |
| `design.md` 属性 4（L389–393） | 分级消解 |
| `design.md` 属性 5（L395–399） | DINOv2 三档分类 |
| `design.md` 属性 6（L401–405） | 聚类链式合并防护 |
| `design.md` 约束 1（L429–437） | 输入过滤（只取 prelim active） |
| `design.md` 约束 2（L438–448） | 链式合并防护细则 |
| `design.md` 约束 3（L449–456） | 纯 confirmed 簇的 trash 校验 |

**任务与状态**

| 任务 | 描述 | 状态 |
| --- | --- | --- |
| 6.1 | 建 `globalSimilarity.ts` 与核心类型 | ✅ 完成 |
| 6.2 | DINOv2 嵌入拉取 + top-K 近邻 + 三档分类 | ✅ 完成 |
| 6.3 | 两阶段 Union-Find + 簇上限 + 直接边 | ✅ 完成 |
| 6.4 | 分级消解（本地质量 / VLM / 回退） | ✅ 完成 |
| 6.5 | 接入流水线编排 | ✅ 完成 |
| 6.6* | 属性测试（属性 4、5、6） | ⬜ 可选，未做 |
| 9.1 | 端到端串联（共享） | ✅ 完成 |
| 9.2* | 水下真实图片回归套件 | ⬜ 可选，未做 |

**实现文件**

- `server/src/services/smartCuration/globalSimilarity.ts` — `classifyPairs`（L244）、`computeTopKNeighbors`（L162）、`selectBestByQuality`（L94）、`computeCompositeScore`（L117）
- `server/src/services/smartCuration/unionFind.ts` — `buildClusters`（L295）、`CLUSTER_SIZE_CAP`（L139）、最弱边拆分（L142 起）

---

### 需求 4：VLM 状态上报

**要解决的问题**：AI 阶段静默跳过时，用户看到的和「AI 跑了但没删东西」完全一样，无法区分。

**需求要点**

- `vlmStatus` 恰好六个值：`not_configured`、`disabled`、`skipped`、`success`、`partial_failure`、`failed`（criterion 1）
- `deriveVLMStatus` 七步判定顺序（criterion 2）
- `skipped` 的含义是「VLM 可用但没被调用」，与 `failed`（试了但全失败）严格区分（criteria 5–6）
- `vlmCallStats` 九个字段，含 `parseFailures`、`timeoutFailures`、`providerAuthFailures`（criterion 7）
- 全程共用一个 tracker，实时递增，是 `vlmStatus` 的唯一依据（criteria 8–9）
- `PipelineResult` 附带 7 个分阶段 trash 计数器（criterion 11）

**设计依据**

| 位置 | 内容 |
| --- | --- |
| `design.md` §Components 4（L220–262） | 状态上报器设计 |
| `design.md` §Data Models — `PipelineResult`（L340–368） | 返回结构 |
| `design.md` 属性 7（L407–411） | 状态推导 |
| `design.md` 约束 5（L479–513） | 判定优先级（含完整代码） |
| `design.md` 约束 6（L514–535） | 计数语义 |
| `design.md` 约束 7（L536–549） | 后端完成日志 |

**任务与状态**

| 任务 | 描述 | 状态 |
| --- | --- | --- |
| 7.1 | 定义 VLM 类型 + 实现状态推导 | ✅ 完成 |
| 7.2 | 各 AI 阶段接入共享 tracker | ✅ 完成 |
| 7.3 | `PipelineResult` 补字段与统计计数 | ✅ 完成 |
| 7.4* | 属性测试：状态推导 | ⬜ 可选，未做 |

**实现文件**

- `server/src/services/pipeline/types.ts` — `VLMStatus`（L137–143）、`VLMCallStats`（L145–156）、`deriveVLMStatus`（L161–174）、`createVLMCallStatsTracker`（L180）、`PipelineResult`（L261–284）

**范围边界**：design.md §Scope Boundary（L626）明确前端展示这些字段**不在本 spec 范围**，前端仍只显示「处理完成」。

---

### 需求 5：阈值与日志一致性

**要解决的问题**：日志打印的阈值与实际生效的不一致，导致排查时被误导。

**需求要点**

- `PROCESS_THRESHOLDS` 是**主**注册表（criterion 1）
- 次级定义位置限定在白名单表内，共 6 处（criterion 2）
- 新增图片筛选检测阈值必须进主注册表，除三类豁免（criterion 3）
- 畸形环境变量 → 回退默认值 + 告警（含变量名、被拒值、有效范围、生效默认值）（criterion 6）
- 启动时单行结构化日志，至少含 10 个字段（criterion 7）
- 过曝阶段单独打印传给 Python 的 7 个阈值（criterion 8）

**设计依据**

| 位置 | 内容 |
| --- | --- |
| `design.md` §Components 5（L263–310） | 阈值配置（含 DINO/CLIP 命名拆分、日志格式、Python 传参） |
| `design.md` 属性 8（L413–417） | 日志一致性 |

**任务与状态**

| 任务 | 描述 | 状态 |
| --- | --- | --- |
| 1.1 | 扩展 `PROCESS_THRESHOLDS` 字段 + 环境变量校验 | ✅ 完成 |
| 1.2 | 启动时结构化阈值日志 | ✅ 完成 |
| 1.3* | 属性测试：日志一致性 | ⬜ 可选，未做 |
| 2.1 | Python 侧接收并打印阈值（共享） | ✅ 完成 |
| 2.2 | Node 侧传参（共享） | ✅ 完成 |
| 9.1 | 端到端串联（共享） | ✅ 完成 |

**实现文件**

- `server/src/services/dedupThresholds.ts` — `PROCESS_THRESHOLDS`（L108 起）、`envBounded` / `envPositiveInt` / `envPositiveNumber` 校验器
- `server/src/services/pipeline/runTripProcessingPipeline.ts` — 启动日志（约 L480–487）
- `server/src/services/pythonAnalyzer.ts` — 过曝阈值日志（约 L295–301）

**次级定义位置**（需求 5 白名单，共 6 处）：`similarityGrouper.ts`、`aiFinalDedup.ts`、`aiReview.ts`、`sceneDedup.ts`、`vlmClient.ts`、`unionFind.ts`，另加 `analyze.py` 的 `center_weight` 缺口。

---

### 需求 6：阶段错误标签

**要解决的问题**：过曝阶段抛错时被记成 `stage: 'blur'`，误导排查方向。

**需求要点**

- 过曝阶段错误必须记为 `stage: 'overexposure'`（criterion 1）
- 不得标成 `blur`（criterion 2）
- 两个阶段各自独立失败时产生独立条目（criterion 3）

**设计依据**

| 位置 | 内容 |
| --- | --- |
| `design.md` §Components 6（L311–319） | 错误标签修复 |
| `design.md` 属性 9（L419–423） | 标签正确性 |

**任务与状态**

| 任务 | 描述 | 状态 |
| --- | --- | --- |
| 3.1 | 修正 `runTripProcessingPipeline.ts` 的错误标签 | ✅ 完成 |
| 3.2* | 属性测试：错误标签 | ⬜ 可选，未做 |

**实现文件**

- `server/src/services/pipeline/runTripProcessingPipeline.ts` — `stageErrors` 记录处

---

## 三、完成度汇总

| 分类 | 完成 | 未完成 | 说明 |
| --- | --- | --- | --- |
| 必做任务 | 25 | 0 | 全部功能项已实现 |
| 可选任务 | 0 | 7 | 全部是属性测试与回归测试 |
| 检查点任务 | 3 | 0 | 任务 5、8、10 |

**未完成的 7 个可选任务**

| 任务 | 覆盖需求 | 对应设计属性 |
| --- | --- | --- |
| 1.3* | 5.4 | 属性 8 日志一致性 |
| 2.3* | 1.Q1–Q4, 1.3, 1.4, 1.5 | 属性 1、属性 2 |
| 3.2* | 6.1–6.3 | 属性 9 |
| 4.2* | 2.1–2.9 | 属性 3 |
| 6.6* | 3.3–3.13 | 属性 4、属性 5、属性 6 |
| 7.4* | 4.2–4.6 | 属性 7 |
| 9.2* | 1.3, 1.4, 3.3, 3.6–3.9 | 水下真实图片回归套件 |

也就是说：`design.md` 定义的 9 条正确性属性，**目前 0 条有测试覆盖**。功能都实现了，但没有测试固定这些行为。这是本 spec 当前最大的质量缺口。

---

## 四、历史文档漂移（已闭合）

> **状态：已全部修复。** 下表是当初核对时发现的漂移，保留作为历史记录。修复由 commit
> `c2e5ec9`（`docs: align curation specs with implemented behavior`）落地，已在 HEAD
> `42de4d4` 上逐条重新核验。**当前不存在待处理漂移。**

当时的问题：`design.md` 的属性章节里的 `**Validates: Requirements X.Y**` 标注是**旧编号**，需求重编号后未同步。

| 位置 | 当时写的 | 当时判定应为 | `c2e5ec9` 后的实际值 | 复核 |
| --- | --- | --- | --- | --- |
| 属性 1（L375） | Requirements 1.1, 1.4 | 1.Q1–1.Q4, 1.3, 1.4 | `1.Q1–1.Q4, 1.3, 1.4, 1.5` | ✅ 已闭合（另补了 1.5） |
| 属性 2（L381） | Requirement 1.3 | 1.Q3, 1.5 | `1.Q3, 1.5` | ✅ 已闭合 |
| 属性 3（L387） | Requirements 2.1-2.5 | 2.1–2.9 | `2.1–2.9` | ✅ 已闭合 |
| 属性 5（L399） | Requirements 3.3, 3.4 | 3.3, 3.4, 3.5 | `3.3, 3.4, 3.5` | ✅ 已闭合 |
| 属性 6（L405） | Requirement 3.5 | 3.6–3.9 | `3.6–3.9` | ✅ 已闭合 |
| 属性 7（L411） | Requirements 4.2-4.5 | 4.2–4.6 | `4.2–4.6` | ✅ 已闭合 |
| 属性 8（L417） | Requirements 5.2 | 5.4 | `Requirement 5.4` | ✅ 已闭合 |

属性 4 与属性 9 当时判定无需改动，该判断**仍然成立**：属性 4（L393）是纯描述性引用（「Requirement 3 — VLM failure does not block high-confidence dedup」），无数字型验收编号；属性 9（L423）的 `Requirements 6.1, 6.2, 6.3` 是有效引用 —— 需求 6 共 3 条验收标准，三个编号全部在范围内。两者在 `c2e5ec9` 中均未改动。

`tasks.md` 的引用当时已全部重映射并通过越界校验；在 HEAD `42de4d4` 上复核，60 个数字型引用**零越界**。

---

## 五、怎么用这张表核对

**日常核对（读文档即可）**

1. 看总览表确认某需求的任务是否都完成
2. 顺着「设计依据」的行号去 `design.md` 确认设计意图
3. 顺着「实现文件」去代码确认实际行为

**引用编号校验（可脚本化）**

`tasks.md` 里的 `_Requirements: X.Y_` 与 `**Validates: ...**` 引用应全部落在各需求实际条目数范围内。当前各需求条数：

| 需求 | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- |
| 条数 | 16 | 9 | 17 | 11 | 9 | 3 |

需求 1 另有 Q1–Q4 四个标签式条件，引用时写 `1.Q1`–`1.Q4`，不占用数字编号。

**变更后需要回来更新本表的情形**

- 增删需求条目 → 更新第五节的条数表，并检查 tasks.md 引用是否越界
- 增删任务 → 更新对应需求的任务表与第三节汇总
- 调整 design.md 章节 → 更新行号，或改用标题定位
