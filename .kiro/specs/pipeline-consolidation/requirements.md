# 需求文档：处理流水线统一重构 (Pipeline Consolidation)

## 简介

本次重构旨在统一图片处理流水线中的模糊检测、去重引擎、质量选择、环境变量配置和上传后处理触发等模块。当前系统存在多处阈值不一致、遗留代码路径未退役、SQL 查询缺失字段、环境变量命名混乱等问题，导致模糊检测三档分类失效、去重回退路径过于宽松、keeper 选择逻辑无法正常工作。本次重构将修复所有 P0 级 bug，统一阈值来源，退役遗留代码，并为上传路由添加异步处理触发。

## 术语表

- **Pipeline**: 图片处理流水线，包含模糊检测、去重、分类、优化、缩略图生成等步骤
- **BlurDetector**: Node.js 端模糊检测模块 (`blurDetector.ts`)，使用 Laplacian 方差计算清晰度
- **PythonAnalyzer**: Python 端分析模块 (`pythonAnalyzer.ts` + `analyze.py`)，使用 CLIP 分类 + OpenCV 模糊检测
- **DedupEngine**: 旧版滑动窗口去重引擎 (`dedupEngine.ts`)，基于 pHash/dHash 汉明距离
- **HybridDedupEngine**: 新版四层混合去重引擎 (`hybridDedupEngine.ts`)，Layer 0-3 流水线
- **BedrockDedupEngine**: 旧版 Bedrock 视觉模型多图窗口去重引擎 (`dedupEngine.bedrock.ts`)
- **LLMPairReviewer**: LLM 逐对审查服务 (`llmPairReviewer.ts`)，支持 OpenAI/Bedrock/DashScope 级联
- **QualitySelector**: 六维质量评分模块 (`qualitySelector.ts`)，用于重复组中选择最佳保留图片
- **DedupThresholds**: 阈值常量单一真相源 (`dedupThresholds.ts`)
- **BlurThreshold**: 模糊检测下阈值，blur_score < BlurThreshold 判定为 blurry，默认值 15
- **ClearThreshold**: 模糊检测上阈值，blur_score >= ClearThreshold 判定为 clear，默认值 50
- **HASH_HAMMING_THRESHOLD**: pHash/dHash 汉明距离阈值，默认值 4
- **MediaUploadRoute**: 媒体上传路由 (`media.ts`)，处理文件上传、分类和标签生成
- **ProcessingStatus**: 媒体项的处理状态字段，跟踪异步处理进度

## 需求

### 需求 1：统一模糊检测阈值

**用户故事：** 作为开发者，我希望 Python 端和 Node.js 端使用一致的模糊检测阈值，以确保三档分类（blurry/suspect/clear）在所有代码路径中行为一致。

#### 验收标准

1. THE BlurDetector SHALL 导出 `DEFAULT_BLUR_THRESHOLD`（值为 15）和 `DEFAULT_CLEAR_THRESHOLD`（值为 50）作为命名常量
2. WHEN PythonAnalyzer 调用 `analyzeImages()` 时，THE PythonAnalyzer SHALL 使用 BlurThreshold 默认值 15（而非当前的 100）
3. WHEN PythonAnalyzer 调用 `analyzeImages()` 时，THE PythonAnalyzer SHALL 传递 `--clear-threshold` 参数给 Python 脚本，默认值为 50
4. THE Pipeline SHALL 从 BlurDetector 导入 `DEFAULT_BLUR_THRESHOLD` 和 `DEFAULT_CLEAR_THRESHOLD` 作为阈值的单一真相源
5. WHEN Python 端 `analyze.py` 的 analyze 子命令被调用时，THE PythonAnalyzer SHALL 接受 `--clear-threshold` CLI 参数并传递给 `detect_blur()` 函数
6. IF 模糊检测计算失败，THEN THE BlurDetector 和 PythonAnalyzer SHALL 统一使用 `suspect` 作为错误状态（而非 `unknown`）

### 需求 2：统一去重引擎架构

**用户故事：** 作为开发者，我希望去重引擎有清晰的职责划分，HybridDedupEngine 作为唯一编排器，DedupEngine 退化为纯工具模块，以消除多条去重路径的混乱。

#### 验收标准

1. THE DedupEngine SHALL 仅导出 `computeHash()`、`computePHash()` 和 `hammingDistance()` 三个纯工具函数
2. THE DedupEngine SHALL 移除 `deduplicate()` 函数和 `pickLoser()` 函数
3. THE HybridDedupEngine SHALL 作为所有去重操作的唯一入口
4. WHEN Python 不可用时，THE Pipeline SHALL 使用 HybridDedupEngine 的 Layer 0（Hash 预过滤）+ Layer 3（Union-Find 分组 + 质量选择）作为回退路径，跳过 Layer 1 和 Layer 2
5. THE Pipeline SHALL 在 `process.ts` 中移除对旧版 `deduplicate()` 的所有导入和调用

### 需求 3：修复去重引擎回退路径阈值

**用户故事：** 作为开发者，我希望去重引擎的回退路径使用正确的汉明距离阈值，以避免过于宽松的重复判定。

#### 验收标准

1. WHILE DedupEngine 作为工具模块存在时，THE DedupEngine SHALL 不再包含任何硬编码的汉明距离阈值
2. THE HybridDedupEngine SHALL 从 DedupThresholds 导入 `HASH_HAMMING_THRESHOLD`（值为 4）作为 Layer 0 的汉明距离阈值
3. WHEN 两张图片的 pHash 汉明距离 ≤ 4 且 dHash 汉明距离 ≤ 4 时，THE HybridDedupEngine SHALL 判定为确认重复

### 需求 4：修复去重引擎中 blur_status 查询缺失

**用户故事：** 作为开发者，我希望去重引擎的 keeper 选择逻辑能正确获取 blur_status 字段，以确保清晰图片优先于模糊图片被保留。

#### 验收标准

1. THE HybridDedupEngine SHALL 在查询 media_items 时包含 `blur_status` 字段
2. THE QualitySelector SHALL 在计算质量评分时考虑 blur_status，blurry 图片的评分应低于 clear 图片
3. WHEN 重复组中存在 clear 和 blurry 图片时，THE QualitySelector SHALL 优先保留 clear 图片

### 需求 5：为 QualitySelector 添加批量辅助函数

**用户故事：** 作为开发者，我希望 QualitySelector 提供基于 media ID 的批量评分和选择函数，以简化调用方的代码。

#### 验收标准

1. THE QualitySelector SHALL 导出 `selectBestFromMediaIds(mediaIds: string[]): Promise<string>` 函数，接受一组 media ID，返回最佳保留的 media ID
2. THE QualitySelector SHALL 导出 `scoreMediaIds(mediaIds: string[]): Promise<Array<{ mediaId: string; score: QualityScore }>>` 函数，返回每个 media ID 的质量评分
3. WHEN `selectBestFromMediaIds()` 被调用时，THE QualitySelector SHALL 下载图片、计算六维质量评分、返回 overall 最高的 media ID
4. IF 图片下载或评分计算失败，THEN THE QualitySelector SHALL 为该图片赋予 overall=0 的默认评分并继续处理其余图片

### 需求 6：退役遗留去重代码

**用户故事：** 作为开发者，我希望遗留的去重代码被明确标记为废弃，以防止新代码误用旧路径。

#### 验收标准

1. THE PythonAnalyzer SHALL 在 `dedupImages()` 函数上添加 `@deprecated` JSDoc 标记，说明应使用 `clipNeighborSearch()` 替代
2. THE PythonAnalyzer 的 `analyze.py` SHALL 在 dedup 子命令的帮助文本中标注 `[LEGACY]` 前缀
3. THE BedrockDedupEngine SHALL 在模块顶部添加 `@deprecated` JSDoc 标记，说明应使用 LLMPairReviewer 替代
4. THE BedrockDedupEngine 的 `deduplicate()` 函数 SHALL 添加 `@deprecated` JSDoc 标记

### 需求 7：统一环境变量命名

**用户故事：** 作为开发者，我希望所有 LLM 相关的环境变量命名一致，.env.example 文档准确反映代码实际支持的配置项。

#### 验收标准

1. THE BedrockClient SHALL 使用 `AI_PROVIDER` 环境变量选择 provider（支持 `openai` 和 `bedrock`）
2. THE LLMPairReviewer SHALL 使用 `LLM_DEDUP_PROVIDER` 环境变量选择首选 provider（支持 `openai`、`bedrock`、`dashscope`）
3. THE Pipeline SHALL 支持 `AI_REVIEW_ENABLED` 环境变量（布尔值，默认 true），控制是否启用 LLM 逐对审查
4. THE Pipeline SHALL 支持 `AI_REVIEW_FAIL_OPEN` 环境变量（布尔值，默认 true），控制 LLM 审查失败时是否回退到 Strict Threshold
5. THE Pipeline SHALL 支持 `AI_REVIEW_TIMEOUT_MS` 环境变量（整数，默认 30000），控制单次 LLM 审查的超时时间
6. THE .env.example SHALL 准确记录 `AI_PROVIDER`、`LLM_DEDUP_PROVIDER`、`AI_REVIEW_ENABLED`、`AI_REVIEW_FAIL_OPEN`、`AI_REVIEW_TIMEOUT_MS` 的用途和默认值

### 需求 8：上传路由添加异步处理触发

**用户故事：** 作为开发者，我希望媒体文件上传后自动触发异步处理流水线，以避免上传后需要手动触发处理。

#### 验收标准

1. WHEN 媒体文件上传成功并完成 INSERT 后，THE MediaUploadRoute SHALL 调用 `enqueueMediaProcessing(mediaId, tripId)` 触发异步处理
2. THE Pipeline SHALL 在 media_items 表中维护 `processing_status` 字段，支持 `pending`、`processing`、`completed`、`failed` 四种状态
3. WHEN 媒体文件刚上传时，THE MediaUploadRoute SHALL 将 `processing_status` 设置为 `pending`
4. WHEN 异步处理开始时，THE Pipeline SHALL 将 `processing_status` 更新为 `processing`
5. WHEN 异步处理完成时，THE Pipeline SHALL 将 `processing_status` 更新为 `completed`
6. IF 异步处理失败，THEN THE Pipeline SHALL 将 `processing_status` 更新为 `failed` 并记录错误信息到 `processing_error` 字段
7. THE `enqueueMediaProcessing()` SHALL 为非阻塞调用，上传接口在触发后立即返回响应，处理在后台异步执行

### 需求 9：BedrockDedupEngine 多图窗口分组策略退役

**用户故事：** 作为开发者，我希望 BedrockDedupEngine 的多图窗口分组策略被退役，因为其 prompt 对旅行照片过于激进，LLMPairReviewer 的逐对审查已经是正确的替代方案。

#### 验收标准

1. THE BedrockDedupEngine 的 `deduplicate()` 函数 SHALL 在函数体开头添加废弃警告日志
2. THE Pipeline SHALL 不再在任何主流程中调用 BedrockDedupEngine 的 `deduplicate()` 函数
3. THE process.ts SHALL 移除对 BedrockDedupEngine 的导入（如果存在）
