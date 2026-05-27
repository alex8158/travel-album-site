# Implementation Plan: Pipeline Image Optimization

## Overview

本实现计划覆盖四项 pipeline 优化：blur 阶段直接 trash、AI 精修阶段、AI 筛选相似度预分组、DINOv2 阈值确认。所有代码使用 TypeScript，测试使用 vitest + fast-check。

## Tasks

- [x] 1. Blur 阶段直接 trash 实现
  - [x] 1.1 在 `runBlurStage` 末尾新增 `applyBlurTrash` 函数
    - 在 `server/src/services/pipeline/runTripProcessingPipeline.ts` 中实现 `applyBlurTrash(contexts, db)` 函数
    - 对 `blurStatus = 'blurry'` 的图片执行 `UPDATE media_items SET status='trashed', trashed_reason='blur', blur_status='blurry', sharpness_score=?`
    - 对 `blurStatus = 'suspect'` 或 `'clear'` 的图片仅更新 `blur_status` 和 `sharpness_score`
    - 对 blur 评估异常的图片设置 `blur_status='suspect'`, `status='active'`，错误追加到 `processing_error`
    - 在 blur 阶段完成后调用 `applyBlurTrash`
    - _Requirements: 1.1, 1.4, 1.5, 1.7_

  - [x] 1.2 确认后续阶段仅处理 active 图片
    - 验证 `runDedupStage` 已过滤 `blurStatus === 'blurry'` 的 contexts（已有逻辑）
    - 验证 `runAiScreening` 查询条件已包含 `status = 'active'`（已有逻辑）
    - 确保 reduce 阶段对已被 blur trash 的图片生成 `finalStatus='trashed'`, `trashedReasons` 包含 `'blur'` 的 decision
    - _Requirements: 1.2, 1.3, 1.6_

  - [ ]* 1.3 Write property tests for blur stage state transitions
    - **Property 1: Blur 阶段状态转换正确性**
    - **Validates: Requirements 1.1, 1.4, 1.5**
    - 使用 fast-check 生成随机 `ImageProcessContext` 数组（含不同 blurStatus），验证 DB 状态转换

  - [ ]* 1.4 Write property test for post-blur stage filtering
    - **Property 2: 后续阶段仅处理 active 图片**
    - **Validates: Requirements 1.2, 1.3, 2.2**
    - 生成混合 status 的图片集，验证阶段输入过滤逻辑

  - [ ]* 1.5 Write property test for reduce stage blur decision preservation
    - **Property 3: Reduce 阶段保持 blur trash 决策**
    - **Validates: Requirements 1.6**
    - 生成随机 contexts + dedupAssessment，验证 reduce() 输出

- [x] 2. Checkpoint - Ensure blur stage tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. AI 精修服务实现
  - [x] 3.1 创建 `aiImageOptimizer.ts` 核心模块
    - 创建 `server/src/services/aiImageOptimizer.ts`
    - 实现 `AdjustmentParams` 接口（brightness, contrast, saturation, sharpness，范围 [0, 2]）
    - 实现 `AiOptimizeResult` 和 `AiOptimizeBatchResult` 接口
    - 实现 `createRefinementClient()` 复用 DashScope OpenAI 兼容协议，timeout 30s
    - 实现 DashScope prompt（水下摄影后期处理专家）
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.2 实现 `parseAdjustmentParams` 和 `validateAndClamp` 函数
    - `parseAdjustmentParams(responseText)`: 从响应文本中提取 JSON（支持 markdown code block、裸 JSON、prose 包裹）
    - `validateAndClamp(raw)`: 对每个字段执行校验——缺失/非数值/NaN → 默认 1.0，超出 [0, 2] → 裁剪到边界
    - 提取失败返回 null
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 3.3 实现 `applyAdjustments` 函数
    - 使用 sharp 执行调整：brightness → `modulate({ brightness })`，contrast → `linear(contrast, -(128*(contrast-1)))`，saturation → `modulate({ saturation })`，sharpness → `sharpen({ sigma: (sharpness-1)*2 })` 仅 > 1.0 时
    - 仅对值不等于 1.0 的字段执行对应 sharp 操作
    - 全部为 1.0 时跳过处理，返回 null
    - 保存结果到存储并返回 optimized_path
    - _Requirements: 2.5, 2.9, 2.10_

  - [x] 3.4 实现 `runAiRefinement` 主函数
    - 查询 `status='active'` 且 `media_type='image'` 的图片
    - 逐张调用 DashScope 获取 AdjustmentParams
    - 调用 `applyAdjustments` 执行 sharp 处理
    - 更新 `media_items.optimized_path`
    - 单张失败不影响其他图片（错误隔离）
    - _Requirements: 2.2, 2.6, 2.7, 4.2, 4.3_

  - [ ]* 3.5 Write property test for AdjustmentParams parsing and validation
    - **Property 4: AdjustmentParams 解析与校验的完整性**
    - **Validates: Requirements 2.4, 3.1, 3.2, 3.3, 3.5**
    - 使用 fast-check 生成随机 JSON 字符串（含各种格式），验证解析结果始终符合 schema

  - [ ]* 3.6 Write property test for sharp conditional execution
    - **Property 5: Sharp 仅对非 1.0 字段执行调整**
    - **Validates: Requirements 2.5, 2.9, 2.10**
    - 生成随机 AdjustmentParams，验证 sharp 操作仅对非 1.0 字段触发

  - [ ]* 3.7 Write property test for AI refinement error isolation
    - **Property 6: AI 精修错误隔离**
    - **Validates: Requirements 2.7, 4.3**
    - 生成随机图片批次（部分模拟失败），验证错误隔离

  - [ ]* 3.8 Write property test for JSON extraction robustness
    - **Property 8: JSON 提取的鲁棒性**
    - **Validates: Requirements 3.3, 3.4**
    - 生成随机文本包裹的 JSON，验证提取逻辑

- [x] 4. Checkpoint - Ensure AI refinement tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Pipeline 集成 AI 精修阶段
  - [x] 5.1 在 pipeline 中插入 AI 精修阶段
    - 在 `runTripProcessingPipeline.ts` 的 optimize 阶段之后、thumbnail 阶段之前插入 `runAiRefinement` 调用
    - 检查 `AI_REVIEW_ENABLED === 'true'` 且 `DASHSCOPE_API_KEY` 非空
    - 失败时记录 stageError，不影响后续 thumbnail 阶段
    - AI 精修输入为原始 `file_path`，非传统 optimize 输出
    - _Requirements: 2.1, 2.8, 4.1, 4.2, 4.3, 4.4_

  - [ ]* 5.2 Write unit tests for pipeline AI refinement integration
    - 验证 AI refinement 在 optimize 之后、thumbnail 之前执行
    - 验证启用条件（环境变量检查）
    - 验证 optimized_path 覆盖逻辑
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 6. DINOv2 阈值确认
  - [x] 6.1 确认 `dedupThresholds.ts` 中 DINOv2 阈值为 0.9
    - 验证 `PROCESS_THRESHOLDS.dinov2DedupThreshold` 默认值为 0.90（已确认）
    - 确保环境变量 `DINOV2_DEDUP_THRESHOLD` 覆盖逻辑正确
    - 添加无效环境变量值的警告日志（当值不是有效数字或超出 [0, 1] 范围时）
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ]* 6.2 Write property test for DINOv2 threshold parsing
    - **Property 7: DINOv2 阈值解析正确性**
    - **Validates: Requirements 5.1, 5.2, 5.3**
    - 使用 fast-check 生成随机环境变量值，验证阈值解析逻辑

- [x] 7. AI 筛选相似度预分组
  - [x] 7.1 实现 `groupBySimilarity` 函数
    - 在 `server/src/services/aiImageScreener.ts` 中新增 `groupBySimilarity` 函数
    - 从数据库或 Python 服务获取 DINOv2 嵌入向量
    - 计算两两余弦相似度，使用 Union-Find 将 sim >= 0.75 的图片归入同一组
    - 返回 `SimilarityGroup[]`
    - _Requirements: 6.1_

  - [x] 7.2 实现 `buildSmartBatches` 函数
    - 按组大小降序排列
    - 大组（> BATCH_SIZE）拆分为多个批次
    - 小组合并填充：优先选择与当前组相似度最高的其他小组
    - 未分组图片填充剩余空间
    - 每个批次不超过 10 张
    - _Requirements: 6.2, 6.3, 6.4_

  - [x] 7.3 修改 `runAiScreening` 使用智能分批
    - 替换原有的按时间排序分批逻辑为 `groupBySimilarity` + `buildSmartBatches`
    - 当 DINOv2 不可用时回退到原有时间排序分批策略
    - 在日志中输出分组统计信息（总组数、最大组大小、未分组图片数）
    - _Requirements: 6.2, 6.5, 6.6_

  - [ ]* 7.4 Write property test for similarity grouping batch assignment
    - **Property 9: 相似度预分组保证同组图片在同一批次**
    - **Validates: Requirements 6.1, 6.2**
    - 生成随机图片集合及相似度矩阵，验证同组图片在同一批次

  - [ ]* 7.5 Write property test for fallback batching
    - **Property 10: 预分组降级不影响功能**
    - **Validates: Requirements 6.5**
    - 模拟 DINOv2 不可用场景，验证回退到时间排序分批

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- DINOv2 阈值已在 `dedupThresholds.ts` 中确认为 0.9，主要工作是添加无效值警告
- AI 精修使用与 AI screening 相同的 DashScope 客户端模式（OpenAI 兼容协议）
- 相似度预分组复用 dedup 阶段已计算的 DINOv2 嵌入向量

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1", "6.1"] },
    { "id": 1, "tasks": ["1.2", "3.2", "6.2"] },
    { "id": 2, "tasks": ["1.3", "1.4", "3.3"] },
    { "id": 3, "tasks": ["1.5", "3.4", "3.5"] },
    { "id": 4, "tasks": ["3.6", "3.7", "3.8", "5.1"] },
    { "id": 5, "tasks": ["5.2", "7.1"] },
    { "id": 6, "tasks": ["7.2"] },
    { "id": 7, "tasks": ["7.3"] },
    { "id": 8, "tasks": ["7.4", "7.5"] }
  ]
}
```
