# Implementation Plan: Bedrock 图片分析

## 概述

将当前基于传统算法的图片分析流水线替换为 AWS Bedrock Claude Sonnet 视觉模型方案。按增量步骤实现：先建立 Bedrock 客户端基础设施，再逐步改造 blurDetector、imageClassifier、dedupEngine，最后更新 process.ts 流水线集成。

## Tasks

- [x] 1. 安装依赖并创建 Bedrock 客户端基础模块
  - [x] 1.1 安装 @aws-sdk/client-bedrock-runtime 依赖
    - 在 server/ 目录下运行 `npm install @aws-sdk/client-bedrock-runtime`
    - _Requirements: 1.1_

  - [x] 1.2 创建 `server/src/services/bedrockClient.ts`，实现 `createBedrockClient` 和 `invokeModel`
    - 从环境变量读取 AWS 凭证和区域（AWS_ACCESS_KEY_ID、AWS_SECRET_ACCESS_KEY、S3_REGION/AWS_REGION）
    - 使用 `@aws-sdk/client-bedrock-runtime` 的 `BedrockRuntimeClient` 和 `InvokeModelCommand`
    - 模型 ID 默认 `anthropic.claude-sonnet-4-20250514`，可通过 `BEDROCK_MODEL_ID` 环境变量覆盖
    - 支持单图和多图（images 数组），构建 Claude Messages API content 数组
    - max_tokens 默认 1024，可通过参数覆盖
    - 实现 ThrottlingException 指数退避重试（2^attempt 秒，最多 3 次）
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 1.3 在 `bedrockClient.ts` 中实现 `resizeForAnalysis` 函数
    - 使用 sharp 将图片缩放到长边 ≤ 512px，保持宽高比
    - 输出 JPEG 格式，返回 base64 字符串
    - 长边已 ≤ 512px 时不放大，直接编码
    - 失败时抛出包含文件路径的异常
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]* 1.4 为 `resizeForAnalysis` 编写属性测试
    - **Property 1: 图片缩放输出有效性**
    - **Validates: Requirements 2.1, 2.2, 2.3**

- [x] 2. 创建 JSON 提取工具函数并编写属性测试
  - [x] 2.1 在 `bedrockClient.ts` 中实现 `extractJSON` 工具函数
    - 从模型响应文本中提取 JSON 内容
    - 处理可能包含的 markdown 代码块标记（` ```json ... ``` ` 或 ` ``` ... ``` `）
    - 处理无包裹的纯 JSON 文本
    - _Requirements: 8.1, 8.2_

  - [ ]* 2.2 为 `extractJSON` 编写属性测试
    - **Property 2: JSON 提取处理 markdown 代码块**
    - **Validates: Requirements 8.2**

  - [ ]* 2.3 为单图分析响应编写属性测试
    - **Property 3: 单图分析响应往返一致性**
    - **Validates: Requirements 5.3, 8.3, 8.5**

  - [ ]* 2.4 为去重响应解析编写属性测试
    - **Property 4: 去重响应解析正确性**
    - **Validates: Requirements 6.4, 8.4**

- [x] 3. Checkpoint - 确保基础模块测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. 改造 blurDetector.ts，实现 `applyBlurResult`
  - [x] 4.1 在 `blurDetector.ts` 中新增 `applyBlurResult(mediaId, blurStatus)` 函数
    - 当 blurStatus 为 'blurry' 时，更新 status='trashed'、trashed_reason='blur'、blur_status='blurry'
    - 当 blurStatus 为 'clear' 时，更新 blur_status='clear'，status 保持 'active'
    - 保留现有的 `detectBlurry`、`computeSharpness`、`classifyBlur` 函数不删除（向后兼容）
    - _Requirements: 3.2, 3.3, 3.4_

  - [ ]* 4.2 为 `applyBlurResult` 编写属性测试
    - **Property 5: 模糊状态决定正确的数据库状态转换**
    - **Validates: Requirements 3.3, 3.4, 5.4**

- [x] 5. 改造 imageClassifier.ts，实现 `applyClassifyResult`
  - [x] 5.1 在 `imageClassifier.ts` 中新增 `applyClassifyResult(mediaId, category)` 函数
    - 更新 media_items 表的 category 字段
    - 删除旧的 category: 标签，写入新的 `category:{分类名}` 标签到 media_tags 表
    - 保留现有的 `classifyTrip`、`mapLabelsToCategory` 等函数不删除（向后兼容）
    - _Requirements: 4.2, 4.3_

  - [ ]* 5.2 为 `applyClassifyResult` 编写属性测试
    - **Property 6: 分类结果写入 media_tags**
    - **Validates: Requirements 4.3**

- [x] 6. 创建单图合并分析函数
  - [x] 6.1 在 `bedrockClient.ts`（或新建 `bedrockAnalysis.ts`）中实现 `analyzeImageWithBedrock(imagePath)` 函数
    - 调用 `resizeForAnalysis` 缩放图片
    - 使用合并 prompt 同时请求 blur_status 和 category
    - 调用 `invokeModel` 发送请求
    - 使用 `extractJSON` 解析响应
    - 返回 `{ blur_status, category }` 对象
    - 解析失败时返回 `{ blur_status: 'clear', category: 'other' }` 并记录错误
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 3.5, 3.6, 4.4, 4.5_

- [x] 7. 改造 dedupEngine.ts，使用 Bedrock 滑动窗口去重
  - [x] 7.1 重写 `deduplicate(tripId, options)` 函数
    - 按 created_at 升序查询 active 图片
    - 滑动窗口大小默认 5，最大 10（`min(windowSize, 10)`）
    - 每个窗口：所有图片 `resizeForAnalysis` → base64 → 一次 `invokeModel` 调用
    - 使用去重 prompt 要求模型返回 `{ "duplicate_groups": [[0,2], [1,3]] }` 格式
    - 每组保留 sharpness_score 最高的（sharpness 相近时取分辨率最高的），其余 trash
    - 解析失败或 API 失败：跳过该窗口，日志记录
    - 移除 pHash/dHash 相关逻辑（computeHash、computePHash、hammingDistance 可保留导出但不再使用）
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [ ]* 7.2 为去重保留最优图片逻辑编写属性测试
    - **Property 7: 去重保留最优图片**
    - **Validates: Requirements 6.5**

  - [ ]* 7.3 为滑动窗口构建编写属性测试
    - **Property 9: 滑动窗口构建正确性**
    - **Validates: Requirements 6.1, 6.2**

- [x] 8. Checkpoint - 确保各模块独立测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. 改造 process.ts 流水线集成
  - [x] 9.1 更新 POST `/:id/process` 路由
    - 导入 `createBedrockClient`、`resizeForAnalysis`、`analyzeImageWithBedrock`、`applyBlurResult`、`applyClassifyResult`
    - Step 1: 遍历所有 active 图片，每张调用 `analyzeImageWithBedrock` → `applyBlurResult` + `applyClassifyResult`
    - Step 2: 调用 `deduplicate(tripId, { windowSize })`
    - 移除原来的 `classifyTrip` 独立调用（分类已合并到 Step 1）
    - 移除 `markOptimizeFailedAsOther` 逻辑（分类在优化之前完成）
    - 正确计算 blurryDeletedCount 和 dedupDeletedCount
    - _Requirements: 7.1, 7.4, 7.5_

  - [x] 9.2 更新 GET `/:id/process/stream` SSE 路由
    - Step 1 (blurDetect): 遍历图片，每张调用 `analyzeImageWithBedrock` → `applyBlurResult` + `applyClassifyResult`，SSE 报告进度
    - Step 2 (dedup): 调用 `deduplicate`，SSE 报告进度
    - 移除独立的 classify 步骤（已合并到 Step 1）
    - 后续步骤（analyze、optimize、thumbnail、video、cover）保持不变
    - _Requirements: 7.1, 7.2, 7.3, 7.5_

  - [ ]* 9.3 为限流重试行为编写属性测试
    - **Property 8: 限流重试行为**
    - **Validates: Requirements 1.3, 1.4**

  - [ ]* 9.4 为处理摘要计数编写属性测试
    - **Property 10: 处理摘要计数一致性**
    - **Validates: Requirements 7.4**

- [ ] 10. 编写单元测试
  - [ ]* 10.1 为 bedrockClient 编写单元测试
    - 测试请求构建格式正确（content 数组结构）
    - 测试环境变量读取（region fallback、model ID 覆盖）
    - 测试 max_tokens 设置
    - _Requirements: 1.1, 1.2, 1.5_

  - [ ]* 10.2 为 resizeForAnalysis 编写单元测试
    - 测试已小于 512px 的图片不放大
    - 测试无效文件抛出包含路径的异常
    - _Requirements: 2.3, 2.4_

  - [ ]* 10.3 为 extractJSON 编写单元测试
    - 测试空字符串、无效 JSON、嵌套代码块
    - 测试纯 JSON 文本、markdown 包裹的 JSON
    - _Requirements: 8.2_

  - [ ]* 10.4 为合并分析和去重编写单元测试
    - 测试模型返回非 JSON 时的 fallback（blur_status='clear', category='other'）
    - 测试空图片列表、单张图片、所有图片都不重复的去重场景
    - _Requirements: 5.5, 6.6, 6.7_

- [x] 11. Final checkpoint - 确保所有测试通过
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 标记 `*` 的子任务为可选测试任务，可跳过以加快 MVP 进度
- 每个任务引用了具体的需求编号以确保可追溯性
- Checkpoint 任务确保增量验证
- 属性测试验证设计文档中的 10 个正确性属性
- 单元测试验证具体示例和边界情况
- 现有的传统算法函数（computeSharpness、computeHash 等）保留不删除，确保向后兼容
