# 实施计划：处理流水线统一重构 (Pipeline Consolidation)

## 概述

按照用户指定的执行顺序，先修复模糊检测阈值，再修复去重引擎，然后更新路由，最后退役遗留代码并添加新功能。所有代码变更使用 TypeScript，测试使用 vitest + fast-check。

## 任务

- [x] 1. 修复 pythonAnalyzer.ts 模糊检测阈值
  - [x] 1.1 修改 `pythonAnalyzer.ts`：从 `blurDetector.ts` 导入 `DEFAULT_BLUR_THRESHOLD` 和 `DEFAULT_CLEAR_THRESHOLD`，将 `analyzeImages()` 的 `blurThreshold` 默认值从 100 改为 `DEFAULT_BLUR_THRESHOLD`(15)，新增 `clearThreshold` 选项默认值为 `DEFAULT_CLEAR_THRESHOLD`(50)
    - 修改 `runAnalyzeBatch()` 的 args 数组，添加 `'--clear-threshold', String(clearThreshold)` 参数
    - _Requirements: 1.2, 1.3, 1.4_
  - [ ]* 1.2 在 `pythonAnalyzer.test.ts` 中添加单元测试：验证默认 blurThreshold=15，args 包含 --clear-threshold 50
    - _Requirements: 1.2, 1.3_

- [x] 2. 修复 analyze.py 并标记 dedup 子命令为 legacy
  - [x] 2.1 确认 `analyze.py` 的 analyze 子命令已支持 `--clear-threshold` 参数（当前代码已有，确认默认值为 50.0）；在 dedup 子命令的 help 文本中添加 `[LEGACY]` 前缀
    - _Requirements: 1.5, 6.2_
  - [ ]* 2.2 在 `pythonAnalyzer.test.ts` 中添加单元测试：验证 analyze 子命令接受 --clear-threshold 参数
    - _Requirements: 1.5_

- [x] 3. 导出 blurDetector.ts 模糊阈值常量
  - [x] 3.1 修改 `blurDetector.ts`：将现有的 `const DEFAULT_BLUR_THRESHOLD = 15` 和 `const DEFAULT_CLEAR_THRESHOLD = 50` 改为 `export const`
    - _Requirements: 1.1, 1.4_
  - [ ]* 3.2 在 `blurDetector.test.ts` 中添加单元测试：验证 `DEFAULT_BLUR_THRESHOLD === 15` 和 `DEFAULT_CLEAR_THRESHOLD === 50` 可正确导入
    - _Requirements: 1.1_
  - [ ]* 3.3 编写属性测试 `blurDetector.property.test.ts`
    - **Property 1: 模糊检测错误状态一致性**
    - 使用 fast-check 生成随机场景，验证模糊检测异常时 blur_status 始终为 'suspect'
    - **Validates: Requirements 1.6**

- [x] 4. 为 qualitySelector.ts 添加批量辅助函数
  - [x] 4.1 在 `qualitySelector.ts` 中新增 `selectBestFromMediaIds(mediaIds: string[]): Promise<string>` 和 `scoreMediaIds(mediaIds: string[]): Promise<Array<{ mediaId: string; score: QualityScore }>>` 函数
    - 从 DB 查询 file_path，下载图片，计算六维质量评分，返回 overall 最高的 media ID
    - 失败时赋予 overall=0 的默认评分并继续处理
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [ ]* 4.2 在 `qualitySelector.test.ts` 中添加单元测试：验证 selectBestFromMediaIds 和 scoreMediaIds 存在且失败时 overall=0
    - _Requirements: 5.1, 5.2, 5.4_
  - [ ]* 4.3 编写属性测试 `qualitySelector.property.test.ts`
    - **Property 3: 清晰图片在质量选择中优先于模糊图片**
    - **Validates: Requirements 4.2, 4.3**
  - [ ]* 4.4 编写属性测试 `qualitySelector.property.test.ts`
    - **Property 4: selectBestFromMediaIds 返回最高评分**
    - **Validates: Requirements 5.3**

- [x] 5. 精简 dedupEngine.ts 为纯工具模块
  - [x] 5.1 修改 `dedupEngine.ts`：移除 `deduplicate()` 函数、`pickLoser()` 函数和 `SlidingWindowDedupOptions` 接口，仅保留 `computeHash()`、`computePHash()`、`hammingDistance()` 和 `DedupResult` 类型
    - 移除对 `getDb`、`getStorageProvider`、`fs` 的导入（如果不再需要）
    - _Requirements: 2.1, 2.2, 3.1_
  - [ ]* 5.2 更新 `dedupEngine.test.ts`：移除对 `deduplicate` 和 `pickLoser` 的测试，保留 `computeHash`、`computePHash`、`hammingDistance` 的测试
    - _Requirements: 2.1, 2.2_
  - [ ]* 5.3 编写属性测试 `dedupEngine.property.test.ts`
    - **Property 5: hammingDistance 对称性与非负性**
    - 使用 fast-check 生成随机等长十六进制字符串对，验证对称性、非负性和自反性
    - **Validates: Requirements 3.3**
  - [ ]* 5.4 编写属性测试 `dedupEngine.property.test.ts`
    - **Property 6: 哈希计算幂等性**
    - 使用固定测试图片，验证连续两次调用 computeHash/computePHash 返回相同值
    - **Validates: Requirements 2.1**

- [x] 6. Checkpoint — 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [x] 7. 修复 hybridDedupEngine.ts
  - [x] 7.1 修改 `hybridDedupEngine.ts` 的 `ImageRow` 接口：添加 `blur_status: string | null` 字段
    - _Requirements: 4.1_
  - [x] 7.2 修改 `hybridDeduplicate()` 中的 SQL 查询：在 SELECT 列表中添加 `blur_status`
    - _Requirements: 4.1_
  - [x] 7.3 为 `hybridDeduplicate()` 添加 Python 不可用回退路径：当 `pythonAvailable === false` 时跳过 Layer 1 和 Layer 2，仅执行 Layer 0 + Layer 3
    - 新增 `pythonAvailable?: boolean` 选项到 `HybridDedupOptions`
    - _Requirements: 2.4_
  - [ ]* 7.4 更新 `hybridDedupEngine.test.ts`：添加 Python 不可用时仅执行 L0+L3 的测试；验证 ImageRow 包含 blur_status
    - _Requirements: 2.4, 4.1_
  - [ ]* 7.5 编写属性测试 `hybridDedupEngine.property.test.ts`
    - **Property 2: Hash 对分类正确性**
    - 使用 fast-check 生成随机 16 字符十六进制字符串对，验证 Layer 0 的 pHash/dHash ≤ 4 判定逻辑
    - **Validates: Requirements 3.3**

- [x] 8. 更新 process.ts：移除旧 deduplicate 导入，统一使用 hybridDeduplicate
  - [x] 8.1 修改 `process.ts`：移除 `import { deduplicate } from '../services/dedupEngine'`，将所有 `deduplicate(tripId)` 调用替换为 `hybridDeduplicate(tripId, { pythonAvailable: false })`
    - 包括 Python 失败回退路径和 Node.js 回退路径中的调用
    - _Requirements: 2.3, 2.5, 9.2_
  - [ ]* 8.2 更新 `process.test.ts`（如存在）：验证无 deduplicate 导入，无 BedrockDedupEngine 导入
    - _Requirements: 2.5, 9.3_

- [x] 9. 标记遗留代码为废弃
  - [x] 9.1 在 `pythonAnalyzer.ts` 的 `dedupImages()` 函数上添加 `@deprecated` JSDoc 标记
    - _Requirements: 6.1_
  - [x] 9.2 在 `dedupEngine.bedrock.ts` 模块顶部和 `deduplicate()` 函数上添加 `@deprecated` JSDoc 标记，并在函数体开头添加 `console.warn` 废弃警告
    - _Requirements: 6.3, 6.4, 9.1_

- [x] 10. 更新 .env.example：添加 AI_REVIEW_* 环境变量
  - [x] 10.1 在 `server/.env.example` 中添加 `AI_REVIEW_ENABLED`、`AI_REVIEW_FAIL_OPEN`、`AI_REVIEW_TIMEOUT_MS` 的注释说明和默认值
    - _Requirements: 7.3, 7.4, 7.5, 7.6_

- [x] 11. 添加 processing_status 列迁移和 enqueueMediaProcessing
  - [x] 11.1 在 `database.ts` 的 `initTables()` 中添加 `processing_status TEXT DEFAULT 'none'` 列的迁移
    - _Requirements: 8.2_
  - [x] 11.2 在 `media.ts` 中实现 `enqueueMediaProcessing(mediaId, tripId)` 非阻塞函数，使用 `setImmediate` 在后台执行处理
    - 上传成功后调用 `enqueueMediaProcessing`，INSERT 时设置 `processing_status = 'pending'`
    - 处理开始时更新为 `processing`，完成时更新为 `completed`，失败时更新为 `failed` 并记录 `processing_error`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_
  - [ ]* 11.3 更新 `media.test.ts`：验证上传后 processing_status=pending，enqueueMediaProcessing 被调用
    - _Requirements: 8.1, 8.3_

- [x] 12. Final checkpoint — 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

## 备注

- 标记 `*` 的任务为可选，可跳过以加速 MVP
- 每个任务引用具体需求编号以确保可追溯性
- Checkpoint 确保增量验证
- 属性测试验证通用正确性属性（6 个属性全部覆盖）
- 单元测试验证具体示例和边界条件
