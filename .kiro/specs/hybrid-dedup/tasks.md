# 实施计划：四层混合去重流水线

## 概述

分两个阶段实现四层混合去重流水线。Phase A 为 MVP：Layer 0 + Layer 1 + Strict Threshold 回退 + Layer 3，不依赖任何 LLM，即可完整运行去重。Phase B 在 MVP 基础上叠加 Layer 2 LLM 逐对精判。

所有阈值常量集中在 `dedupThresholds.ts` 单一文件中定义，Python 端通过 CLI 参数接收阈值，不硬编码任何数值。

### 阈值常量定义（单一真相源）

| 常量名 | 值 | 含义 | 边界定义 |
|--------|-----|------|----------|
| `HASH_HAMMING_THRESHOLD` | 4 | Layer 0: pHash/dHash 汉明距离 | ≤ 4（闭区间，含 4） |
| `CLIP_CONFIRMED_THRESHOLD` | 0.94 | Layer 1: 直接确认重复 | ≥ 0.94（闭下界） |
| `CLIP_GRAY_HIGH_THRESHOLD` | 0.90 | Layer 1: 灰区上档 | [0.90, 0.94)（左闭右开） |
| `CLIP_GRAY_LOW_THRESHOLD` | 0.85 | Layer 1: 灰区下档（有条件） | [0.85, 0.90)（左闭右开） |
| `CLIP_STRICT_THRESHOLD` | 0.955 | 无 LLM 时灰区回退阈值 | ≥ 0.955（闭下界） |
| `CLIP_TOP_K` | 5 | top-k 近邻数 | — |
| `GRAY_LOW_SEQ_DISTANCE` | 12 | [0.85, 0.90) 档序列位置差限制 | abs(i-j) ≤ 12（闭区间） |
| `GRAY_LOW_HASH_DISTANCE` | 16 | [0.85, 0.90) 档哈希距离限制 | pHash ≤ 16 或 dHash ≤ 16（闭区间） |

## 任务

---

## Phase A: MVP（Layer 0 + Layer 1 + Strict Threshold + Layer 3）

> 目标：不依赖任何 LLM，完整可用的去重流水线。灰区候选对全部使用 Strict Threshold（≥ 0.955）判定。


- [x] 1. 创建阈值常量单一真相源 `dedupThresholds.ts`
  - [x] 1.1 创建 `server/src/services/dedupThresholds.ts`
    - 导出所有阈值常量，每个常量附带 JSDoc 注释说明含义和边界行为：
      - `HASH_HAMMING_THRESHOLD = 4` — Layer 0: pHash 汉明距离 ≤ 4 且 dHash 汉明距离 ≤ 4（两者均为闭区间，含边界值 4）
      - `CLIP_CONFIRMED_THRESHOLD = 0.94` — Layer 1 tier 1: similarity ≥ 0.94（闭下界）→ confirmed
      - `CLIP_GRAY_HIGH_THRESHOLD = 0.90` — Layer 1 tier 2: 0.90 ≤ similarity < 0.94（左闭右开）→ gray zone
      - `CLIP_GRAY_LOW_THRESHOLD = 0.85` — Layer 1 tier 3: 0.85 ≤ similarity < 0.90（左闭右开）+ 条件 → gray zone
      - `CLIP_STRICT_THRESHOLD = 0.955` — 无 LLM 回退: similarity ≥ 0.955（闭下界）→ confirmed
      - `CLIP_TOP_K = 5` — top-k 近邻数
      - `GRAY_LOW_SEQ_DISTANCE = 12` — [0.85, 0.90) 档: abs(i-j) ≤ 12（闭区间）
      - `GRAY_LOW_HASH_DISTANCE = 16` — [0.85, 0.90) 档: pHash ≤ 16 或 dHash ≤ 16（闭区间）
    - 导出 `classifyClipPair(similarity, seqDistance, pHashDist, dHashDist)` 纯函数：
      - 输入：CLIP 相似度、序列位置差、pHash 距离、dHash 距离
      - 输出：`'confirmed' | 'gray' | 'skip'`
      - 严格按上述开闭区间实现分类逻辑
    - 导出 `applyStrictThreshold(similarity)` 纯函数：
      - 输入：CLIP 相似度
      - 输出：`boolean`（≥ 0.955 → true，< 0.955 → false）
    - _需求: 2.3, 2.4, 2.5, 2.6, 4.1, 4.2, 4.3_
  - [x] 1.2 编写 `dedupThresholds.test.ts` 属性测试和边界测试
    - **Property 3: CLIP 三档分层分类正确性**
    - 使用 fast-check 生成随机 similarity ∈ [0, 1]、seqDistance ∈ [0, 100]、pHashDist ∈ [0, 64]、dHashDist ∈ [0, 64]
    - 验证 `classifyClipPair()` 输出与阈值定义严格一致
    - **Property 6: 严格阈值回退正确性**
    - 使用 fast-check 生成随机 similarity ∈ [0, 1]，验证 `applyStrictThreshold()` 在 ≥ 0.955 返回 true，< 0.955 返回 false
    - 边界单元测试：similarity 恰好为 0.85、0.90、0.94、0.955 的精确行为
    - 边界单元测试：pHash/dHash 距离恰好为 4、5、16、17 的精确行为
    - **验证: 需求 2.3, 2.4, 2.5, 2.6, 4.1, 4.2, 4.3**

- [x] 2. Python `clip-neighbors` 子命令（接收阈值为 CLI 参数，不硬编码）
  - [x] 2.1 在 `server/python/analyze.py` 中新增 `clip-neighbors` 子命令
    - 新增 `cmd_clip_neighbors(args)` 函数，复用现有 `extract_embeddings()`
    - CLI 参数（所有阈值从 TypeScript 端传入，Python 不硬编码任何阈值）：
      - `--images`: 图片路径列表
      - `--model-dir`: 模型目录
      - `--top-k`: 近邻数（默认 5）
      - `--confirmed-threshold`: 确认阈值（默认 0.94）
      - `--gray-high-threshold`: 灰区上档阈值（默认 0.90）
      - `--gray-low-threshold`: 灰区下档阈值（默认 0.85）
      - `--gray-low-seq-distance`: 下档序列距离限制（默认 12）
      - `--gray-low-hash-distance`: 下档哈希距离限制（默认 16）
      - `--hash-data`: JSON 字符串，包含每张图片的 pHash、dHash 和序列位置
    - 实现 top-k 近邻搜索（复用现有 embedding 提取逻辑）
    - 三档分层逻辑（使用 CLI 传入的阈值，不硬编码）：
      - similarity ≥ confirmed_threshold → confirmed_pairs
      - gray_high_threshold ≤ similarity < confirmed_threshold → gray_zone_pairs
      - gray_low_threshold ≤ similarity < gray_high_threshold 且 abs(i-j) ≤ gray_low_seq_distance 且 (pHash ≤ gray_low_hash_distance 或 dHash ≤ gray_low_hash_distance) → gray_zone_pairs
      - similarity < gray_low_threshold → 跳过
    - 输出 JSON：`{ confirmed_pairs, gray_zone_pairs, embedding_time_ms, total_time_ms }`
    - 在 `build_parser()` 中注册新子命令，在 `main()` 中分发
    - 嵌入提取失败的图片跳过配对，stderr 输出错误日志
    - _需求: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

- [x] 3. TypeScript `clipNeighborSearch()` 封装（传递阈值给 Python）
  - [x] 3.1 在 `server/src/services/pythonAnalyzer.ts` 中新增 `clipNeighborSearch()` 封装函数
    - 新增 `ClipCandidatePair`、`ClipNeighborResult` 接口
    - 实现 `clipNeighborSearch(imagePaths, hashData, options?)` 函数
    - 从 `dedupThresholds.ts` 导入所有阈值常量，作为 CLI 参数传递给 Python：
      - `--confirmed-threshold ${CLIP_CONFIRMED_THRESHOLD}`
      - `--gray-high-threshold ${CLIP_GRAY_HIGH_THRESHOLD}`
      - `--gray-low-threshold ${CLIP_GRAY_LOW_THRESHOLD}`
      - `--gray-low-seq-distance ${GRAY_LOW_SEQ_DISTANCE}`
      - `--gray-low-hash-distance ${GRAY_LOW_HASH_DISTANCE}`
      - `--top-k ${CLIP_TOP_K}`
    - 复用现有 `mutex`、`EXEC_TIMEOUT`、`EXEC_MAX_BUFFER` 和 `markPythonUnavailable()` 机制
    - _需求: 2.1, 2.2_

- [x] 4. 四层混合去重引擎 MVP — Layer 0 + Layer 1 + Strict Threshold + Layer 3
  - [x] 4.1 创建 `server/src/services/hybridDedupEngine.ts`
    - 从 `dedupThresholds.ts` 导入所有阈值常量（不在本文件中定义任何阈值数值）
    - 定义 `HybridDedupOptions`、`Layer0Result`、`Layer1Result`、`DedupGroup`、`ImageRow` 内部类型
    - 实现 `UnionFind` 类（路径压缩 + 按秩合并）
    - 实现 Layer 0：
      - 查询 trip 所有 active + trashed 图片
      - 计算文件 MD5 哈希
      - 复用 `dedupEngine.ts` 的 `computePHash`/`computeHash`/`hammingDistance`
      - 文件哈希相同 → confirmedPairs
      - pHash ≤ HASH_HAMMING_THRESHOLD 且 dHash ≤ HASH_HAMMING_THRESHOLD → confirmedPairs
      - 哈希计算失败的图片跳过 Layer 0，传递给 Layer 1
    - 实现 Layer 1：调用 `pythonAnalyzer.clipNeighborSearch()`
    - 实现 Strict Threshold 回退：对所有灰区对调用 `applyStrictThreshold()`
    - 实现 Layer 3：
      - Union-Find 合并所有 confirmedPairs（来自 Layer 0 + Layer 1 confirmed + Strict Threshold 确认）
      - 复用 `qualitySelector.ts` 的 `computeQualityScore` 选出每组最佳保留
      - active 图片 → trashed (reason='duplicate')
      - 已 trashed 图片 → reason 追加 ',duplicate'
    - 实现 `hybridDeduplicate(tripId, options?)` 主入口，返回 `DedupResult`
    - _需求: 1.1, 1.2, 1.3, 1.4, 1.5, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 7.3_
  - [x] 4.2 编写 `hybridDedupEngine.test.ts` 属性测试和单元测试
    - **Property 1: Layer 0 哈希分类正确性**
    - 使用 fast-check 生成随机 16 字符 hex 哈希对，控制汉明距离
    - 验证文件哈希相同或 pHash ≤ 4 且 dHash ≤ 4 时标记为 confirmed
    - **Property 2: Layer 0 输出完整性不变量**
    - 使用 fast-check 生成随机图片索引集合和确认对
    - 验证 confirmedPairs 索引与 remainingIndices 的并集等于原始集合，且无交集
    - **Property 7: Union-Find 分组正确性**
    - 使用 fast-check 生成随机边集（确认对），验证连通分量正确
    - **Property 8: 质量选择与状态更新正确性**
    - 使用 fast-check 生成随机质量评分的图片组，验证选出最佳保留
    - **Property 9: DedupResult 接口不变量**
    - 使用 fast-check 生成随机图片集合，mock 各层输出
    - 验证 `removedCount === removed.length`，`kept` 与 `removed` 无交集，总数守恒
    - 单元测试：
      - Layer 0 边界：汉明距离恰好为 4（确认）和 5（不确认）
      - 空输入（0 张图片）、单张图片
      - 全重复极端情况
      - 已回收图片的 trashed_reason 追加逻辑
      - Python 不可用时回退到 pHash/dHash 引擎
    - **验证: 需求 1.2, 1.3, 1.4, 1.5, 5.1, 5.2, 5.3, 5.4, 7.2, 7.3**

- [x] 5. 集成到处理路由 `process.ts`
  - [x] 5.1 修改 `server/src/routes/process.ts` 集成 hybridDedupEngine
    - 在去重步骤中调用 `hybridDeduplicate()` 替代现有 `dedupImages()` / `deduplicate()`
    - Python 可用时使用四层混合去重；Python 不可用时回退到现有 pHash/dHash 引擎（`dedupEngine.ts`）
    - 在 SSE 流式处理中报告四层混合去重的进度（Layer 0 / Layer 1 / Strict Threshold / Layer 3 各阶段状态）
    - 保持与现有 `DedupResult` 接口兼容（kept, removed, removedCount）
    - _需求: 7.1, 7.2, 7.3, 7.4_

- [x] 6. Phase A 检查点 — MVP 完整可用
  - 确保所有测试通过，如有疑问请询问用户。
  - 验证：MVP 流水线不依赖任何 LLM 环境变量即可完整运行
  - 验证：所有灰区候选对使用 Strict Threshold（≥ 0.955）判定
  - 验证：所有阈值数值仅在 `dedupThresholds.ts` 中定义，Python 端通过 CLI 参数接收

---

## Phase B: 完整版（叠加 Layer 2 LLM 逐对精判）

> 目标：在 MVP 基础上，为灰区候选对增加 LLM 多模态视觉模型审查。有 LLM 时用 LLM，无 LLM 时自动回退到 Strict Threshold（MVP 行为不变）。

- [x] 7. 创建 LLM 逐对审查服务 `llmPairReviewer.ts`
  - [x] 7.1 创建 `server/src/services/llmPairReviewer.ts`
    - 定义 `LLMProviderType`、`ProviderConfig`、`PairReviewRequest`、`PairReviewResult` 类型
    - 实现 `detectConfiguredProviders(preferredProvider?)`：
      - 检测 `OPENAI_API_KEY`（OpenAI）、`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`（Bedrock）、`DASHSCOPE_API_KEY`（DashScope）
      - 默认级联顺序：OpenAI → Bedrock → DashScope
      - `LLM_DEDUP_PROVIDER` 指定首选 provider 时排到链首
      - 首选 provider 环境变量未配置时记录 warning 日志，使用其他已检测到的 provider
    - DashScope provider 使用 OpenAI SDK 配合自定义 base URL（`DASHSCOPE_BASE_URL`）创建客户端
    - 实现 `reviewPairs(pairs, providerChain)`：
      - 逐对发送两张图片给视觉模型
      - 要求返回 `{is_duplicate: boolean, confidence: number}` JSON
      - 首选 provider 失败时级联到下一个 provider
      - 所有 provider 对某对均失败时，从 `dedupThresholds.ts` 导入 `applyStrictThreshold()` 回退判定
    - 复用 `bedrockClient.ts` 的 `createAIClient()`、`createBedrockClient()`、`resizeForAnalysis()`、`extractJSON()`
    - _需求: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.9, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10_
  - [x] 7.2 编写 `llmPairReviewer.test.ts` 属性测试和单元测试
    - **Property 10: Provider 自动检测正确性**
    - 使用 fast-check 生成随机环境变量组合（OPENAI_API_KEY 有/无 × AWS 凭证有/无 × DASHSCOPE_API_KEY 有/无）
    - **Property 11: Provider 链排序正确性**
    - 使用 fast-check 生成随机已配置 provider 列表和首选 provider
    - **Property 4: LLM 响应映射正确性**
    - 使用 fast-check 生成随机 `{is_duplicate: boolean, confidence: number}` 对象
    - **Property 5: LLM 响应 JSON 解析往返**
    - 使用 fast-check 生成随机合法 JSON 对象，验证序列化后再解析等价
    - **Property 12: 级联回退正确性**
    - 使用 fast-check 生成随机 provider 链和随机失败模式
    - **Property 13: 全 Provider 失败降级正确性**
    - 使用 fast-check 生成随机灰区对和全失败 provider 链，验证回退到 Strict Threshold
    - 单元测试：
      - DashScope 客户端创建（验证使用 OpenAI SDK + 自定义 base URL）
      - LLM 返回非法 JSON 时的错误处理
      - `LLM_DEDUP_PROVIDER` 各种值（openai/bedrock/dashscope/空/无效）的解析
      - 首选 provider 环境变量未配置时的 warning 日志
    - **验证: 需求 3.2, 3.3, 3.4, 3.5, 3.6, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8**

- [x] 8. 将 Layer 2 LLM 接入 `hybridDedupEngine.ts`
  - [x] 8.1 修改 `server/src/services/hybridDedupEngine.ts` — 接入 LLM 审查
    - 在 `hybridDeduplicate()` 中，Layer 1 输出灰区对后：
      - 调用 `detectConfiguredProviders()` 检测可用 provider
      - 有 provider 时：调用 `reviewPairs()` 对灰区对进行 LLM 审查
      - 无 provider 时：保持 MVP 行为（Strict Threshold 回退）
      - 所有 provider 对所有灰区对均失败时：输出基于 Strict Threshold 的结果 + LLM 不可用通知
    - 合并 Layer 2 的 confirmedPairs 到 Layer 3 的 Union-Find 输入
    - _需求: 3.1, 3.7, 4.1, 6.8, 6.10_

- [x] 9. 更新环境变量配置
  - [x] 9.1 更新 `server/.env.example` 新增 LLM provider 环境变量
    - 新增 `LLM_DEDUP_PROVIDER`、`OPENAI_API_KEY`、`OPENAI_MODEL`、`DASHSCOPE_API_KEY`、`DASHSCOPE_MODEL`、`DASHSCOPE_BASE_URL` 配置项
    - 每个变量附带中文注释说明自动检测条件和默认值
    - _需求: 6.11_

- [x] 10. Phase B 最终检查点 — 完整版可用
  - 确保所有测试通过，如有疑问请询问用户。
  - 验证：有 LLM 环境变量时灰区对走 LLM 审查
  - 验证：无 LLM 环境变量时自动回退到 Strict Threshold（MVP 行为不变）
  - 验证：所有阈值数值仅在 `dedupThresholds.ts` 中定义，`llmPairReviewer.ts` 和 `hybridDedupEngine.ts` 均从该文件导入

## 备注

- Phase A（任务 1-6）为 MVP，不依赖任何 LLM，可独立交付使用
- Phase B（任务 7-10）在 MVP 基础上叠加 LLM 能力，无 LLM 时自动降级为 MVP 行为
- 所有阈值常量集中在 `dedupThresholds.ts`，Python 端通过 CLI 参数接收，不硬编码
- 每个阈值的开闭区间在常量定义和 `classifyClipPair()` 中严格实现
- 测试不标记为可选 — 每个实现任务包含对应的测试
- 检查点仅在 Phase 边界设置
