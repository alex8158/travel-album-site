# 实现计划：AI 智能剪辑

## 概述

基于现有视频处理管线，引入 AI 大模型能力实现视频内容语义理解与智能剪辑方案生成。实现路径按依赖关系排序：数据库 schema → AI Provider 抽象层 → CostTracker + BudgetController → ContentAnalyzer → EditPlanner → TextGenerator → API 路由 → 管线集成。

## Tasks

- [x] 1. 数据库 Schema 与基础设施
  - [x] 1.1 创建 AI 智能剪辑数据库迁移
    - 在 `server/src/services/database.ts` 中添加 5 张新表的 CREATE TABLE 语句
    - 创建 `segment_ai_analysis` 表（含 media_id + segment_index 唯一索引）
    - 创建 `ai_edit_plans` 表（含 media_id 索引）
    - 创建 `ai_generated_texts` 表（含 media_id + text_type 复合索引）
    - 创建 `ai_usage_records` 表（含 user_id、trip_id、created_at、call_type 索引）
    - 创建 `ai_budget_configs` 表（含 user_id 唯一索引）
    - 确保所有外键设置 ON DELETE CASCADE
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x] 1.2 定义 AI 模块核心类型与接口
    - 创建 `server/src/services/ai/types.ts`，定义所有共享类型
    - 定义 `AIRequest`、`AIResponse` 接口
    - 定义 `EmotionTag` 类型、`SegmentAIAnalysis` 接口
    - 定义 `EditPlan`、`EditPlanSegment`、`TransitionType`、`PaceType`
    - 定义 `TextType`、`TextStyle`、`GeneratedTitles`、`GeneratedSubtitles`、`GeneratedNarration`
    - 定义 `AICallType`、`AIUsageRecord`、`UsageStats`、`ModelPricing`
    - 定义 `BudgetConfig`、`BudgetCheckResult`
    - _Requirements: 1.1, 1.4, 2.2, 2.3, 2.4, 3.2, 5.1_

- [x] 2. AI Provider 抽象层
  - [x] 2.1 实现 AIProvider 接口与工厂函数
    - 创建 `server/src/services/ai/aiProvider.ts`
    - 定义 `AIProvider` 接口（textCompletion、visionAnalysis 方法）
    - 实现 `createAIProvider()` 工厂函数，根据环境变量 `AI_PROVIDER` 选择提供商
    - 实现 `getActiveProviderName()` 辅助函数
    - _Requirements: 1.1, 1.4, 1.5_

  - [x] 2.2 实现 BedrockProvider
    - 创建 `server/src/services/ai/bedrockProvider.ts`
    - 扩展现有 `bedrockClient.ts` 的能力，实现 `AIProvider` 接口
    - 实现 `textCompletion` 方法（调用 Claude Messages API）
    - 实现 `visionAnalysis` 方法（支持图片 base64 输入）
    - 实现指数退避重试逻辑（1s, 2s, 4s，最多 3 次）
    - 实现 30 秒超时控制（可通过 `AI_TIMEOUT_MS` 环境变量配置）
    - 返回 usage 信息（inputTokens、outputTokens）
    - _Requirements: 1.2, 1.6, 1.7, 1.8, 10.1, 10.2, 10.6_

  - [x] 2.3 实现 OpenAIProvider
    - 创建 `server/src/services/ai/openaiProvider.ts`
    - 实现 `AIProvider` 接口，调用 OpenAI Chat Completions API
    - 实现 `textCompletion` 方法
    - 实现 `visionAnalysis` 方法（支持 image_url 格式）
    - 实现指数退避重试逻辑和超时控制
    - 返回 usage 信息
    - _Requirements: 1.3, 1.6, 1.7, 1.8, 10.1, 10.2, 10.6_

  - [x] 2.4 实现图片缩放工具函数 resizeForProvider
    - 创建 `server/src/services/ai/imageUtils.ts`
    - 实现 `resizeForProvider(base64, maxWidth, maxHeight)` 函数
    - 保持宽高比不变，缩放至提供商最大尺寸限制内（默认 768×768）
    - 支持 JPEG/PNG 格式输入输出
    - _Requirements: 1.9_

  - [ ]* 2.5 编写 Property 1 属性测试：图片缩放保持尺寸约束与宽高比
    - **Property 1: 图片缩放保持尺寸约束与宽高比**
    - **Validates: Requirements 1.9**
    - 使用 fast-check 生成随机正整数宽高 (1-10000)
    - 验证输出尺寸不超过最大限制且宽高比误差 ≤ 1%

  - [ ]* 2.6 编写 AIProvider 单元测试
    - 创建 `server/src/services/ai/aiProvider.test.ts`
    - Mock HTTP 响应，验证重试逻辑、超时处理、错误格式化
    - 验证工厂函数根据环境变量正确选择提供商
    - _Requirements: 1.5, 1.6, 1.7_

- [x] 3. Checkpoint - 确保 AI Provider 层测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. 成本追踪与预算控制
  - [x] 4.1 实现 CostTracker 成本追踪器
    - 创建 `server/src/services/ai/costTracker.ts`
    - 实现 `recordUsage()` 方法：记录 AI 调用到 ai_usage_records 表
    - 实现 `calculateCost()` 方法：基于配置单价计算费用
    - 实现 `getUserStats()` 方法：按用户/时间范围查询累计费用
    - 实现 `getTripStats()` 方法：按旅行查询费用
    - 实现 `getPricing()` 方法：从配置文件读取模型单价
    - 实现 `estimateTokens()` 方法：当 usage 信息不完整时估算 token 数
    - 创建 `server/src/services/ai/pricingConfig.ts` 存储模型单价配置
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ]* 4.2 编写 Property 8 属性测试：费用计算正确性
    - **Property 8: 费用计算正确性**
    - **Validates: Requirements 5.2**
    - 使用 fast-check 生成随机正整数 token 数和正数单价
    - 验证 calculateCost 返回值精度误差不超过 0.000001 美元

  - [ ]* 4.3 编写 Property 9 属性测试：费用聚合查询正确性
    - **Property 9: 费用聚合查询正确性**
    - **Validates: Requirements 5.3, 5.4**
    - 使用 fast-check 生成随机 AIUsageRecord 集合
    - 验证按筛选条件查询的累计费用等于记录之和

  - [ ]* 4.4 编写 Property 12 属性测试：Token 数估算合理性
    - **Property 12: Token 数估算合理性**
    - **Validates: Requirements 5.6**
    - 使用 fast-check 生成随机中英文混合字符串
    - 验证 estimateTokens 返回值在 len(s)/6 到 len(s)/2 范围内

  - [x] 4.5 实现 BudgetController 预算控制器
    - 创建 `server/src/services/ai/budgetController.ts`
    - 实现 `checkBudget()` 方法：检查用户预算（含 80% 警告阈值）
    - 实现 `getBudgetConfig()` 方法：获取用户预算配置
    - 实现 `setUserBudget()` 方法：设置自定义预算
    - 实现 `resetUserBudget()` 方法：重置已用预算
    - 实现 `getGlobalDefault()` 方法：从环境变量 `AI_MONTHLY_BUDGET_LIMIT` 读取默认值（默认 5 美元）
    - 实现 `getAllUsersBudgetStatus()` 方法：管理员查看所有用户预算
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

  - [ ]* 4.6 编写 Property 10 属性测试：预算检查逻辑完整性
    - **Property 10: 预算检查逻辑完整性**
    - **Validates: Requirements 6.3, 6.4, 6.5**
    - 使用 fast-check 生成随机 usage (0-100) 和 limit (0.01-100)
    - 验证 allowed、warningLevel、remainingBudget 的正确性

  - [ ]* 4.7 编写 CostTracker 和 BudgetController 单元测试
    - 创建 `server/src/services/ai/costTracker.test.ts`
    - 创建 `server/src/services/ai/budgetController.test.ts`
    - 验证记录创建、费用计算、统计查询、预算检查、警告级别、重置操作
    - _Requirements: 5.1, 5.2, 6.3, 6.4, 6.5, 6.7_

- [x] 5. Checkpoint - 确保成本追踪与预算控制测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. ContentAnalyzer 内容分析器
  - [x] 6.1 实现 ContentAnalyzer 核心逻辑
    - 创建 `server/src/services/ai/contentAnalyzer.ts`
    - 实现 `analyzeContent()` 方法：从 video_segments 提取代表帧，调用 AI 多模态分析
    - 实现批量分析模式（每批最大 5 个片段合并为一次 AI 调用）
    - 实现 `parseSegmentAnalysis()` 解析函数：将 AI 原始文本解析为 SegmentAIAnalysis
    - 实现缓存检查逻辑（`hasCachedAnalysis`、`getCachedAnalysis`）
    - 实现单片段失败时的默认值设置（空描述、空标签、score=50）
    - 将分析结果写入 segment_ai_analysis 表
    - 每次调用后通过 CostTracker 记录费用
    - 调用前通过 BudgetController 检查预算
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [ ]* 6.2 编写 Property 2 属性测试：AI 分析结果格式不变量
    - **Property 2: AI 分析结果格式不变量**
    - **Validates: Requirements 2.2, 2.3, 2.4**
    - 使用 fast-check 生成随机字符串（含边界长度、特殊字符）
    - 验证 parseSegmentAnalysis 输出满足长度、标签集合、评分范围约束

  - [ ]* 6.3 编写 Property 3 属性测试：AI 数据存储 round-trip
    - **Property 3: AI 数据存储 round-trip**
    - **Validates: Requirements 2.7, 3.8**
    - 使用 fast-check 生成随机 SegmentAIAnalysis 对象
    - 验证写入数据库后再读取，所有字段相等

  - [ ]* 6.4 编写 ContentAnalyzer 单元测试
    - 创建 `server/src/services/ai/contentAnalyzer.test.ts`
    - Mock AIProvider，验证批量分析、缓存命中、默认值设置
    - _Requirements: 2.5, 2.6, 2.7, 2.8_

- [x] 7. EditPlanner 剪辑方案规划器
  - [x] 7.1 实现 EditPlanner 核心逻辑
    - 创建 `server/src/services/ai/editPlanner.ts`
    - 实现 `generateEditPlan()` 方法：构建 prompt（含所有片段分析结果 + 质量评分 + 时长）
    - 实现 `validateEditPlan()` 验证函数：检查 JSON 格式、片段索引范围、必填字段
    - 实现 `validateAndFallback()` 函数：无效输出时回退到 overallScore 降序选择
    - 实现 `selectWithDurationLimit()` 函数：确保选中片段累计时长不超过目标时长
    - 实现加权分数计算：narrativeScore * 0.4 + overallScore * 0.6
    - 将 EditPlan 写入 ai_edit_plans 表
    - 实现 `getEditPlan()` 方法：从数据库读取已保存方案
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [ ]* 7.2 编写 Property 4 属性测试：EditPlan 结构完整性
    - **Property 4: EditPlan 结构完整性**
    - **Validates: Requirements 3.2, 3.3**
    - 使用 fast-check 生成随机 JSON 结构 + 有效/无效字段组合
    - 验证 validateEditPlan 正确识别有效/无效方案

  - [ ]* 7.3 编写 Property 5 属性测试：EditPlan 时长约束
    - **Property 5: EditPlan 时长约束**
    - **Validates: Requirements 3.4**
    - 使用 fast-check 生成随机片段集合 + 随机目标时长
    - 验证选中片段累计时长不超过目标时长 T

  - [ ]* 7.4 编写 Property 6 属性测试：无效 LLM 输出回退
    - **Property 6: 无效 LLM 输出回退**
    - **Validates: Requirements 3.7**
    - 使用 fast-check 生成随机无效 JSON + 随机超范围索引
    - 验证 validateAndFallback 返回 overallScore 降序结果且 fallbackUsed=true

  - [ ]* 7.5 编写 Property 11 属性测试：EditPlanner 片段选择策略
    - **Property 11: EditPlanner 片段选择策略**
    - **Validates: Requirements 3.5, 9.5, 9.6**
    - 使用 fast-check 生成随机片段集合（有/无 narrativeScore）
    - 验证选中片段加权分数均值 ≥ 未选中片段加权分数均值

  - [ ]* 7.6 编写 EditPlanner 单元测试
    - 创建 `server/src/services/ai/editPlanner.test.ts`
    - Mock AIProvider，验证 prompt 构建、方案解析、回退触发
    - _Requirements: 3.1, 3.6, 3.7_

- [x] 8. Checkpoint - 确保 ContentAnalyzer 和 EditPlanner 测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. TextGenerator 文本生成器
  - [x] 9.1 实现 TextGenerator 核心逻辑
    - 创建 `server/src/services/ai/textGenerator.ts`
    - 实现 `generateText()` 方法：根据 type 参数分发到不同生成逻辑
    - 实现标题生成：基于所有片段 Scene_Description + Emotion_Tag 生成 3 个候选标题
    - 实现字幕生成：为每个选中 Segment 生成一句字幕
    - 实现旁白生成：基于 EditPlan 和片段内容生成连贯旁白
    - 实现 `truncateTitle()`、`truncateSubtitle()` 截断函数
    - 实现 `estimateNarrationDuration()` 朗读时长估算（中文 4 字/秒，英文 150 词/分钟）
    - 实现风格参数传递（travel_diary、documentary、social_media、cinematic）
    - 将生成结果写入 ai_generated_texts 表
    - 失败时返回空结果并记录错误
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [ ]* 9.2 编写 Property 7 属性测试：生成文本长度约束
    - **Property 7: 生成文本长度约束**
    - **Validates: Requirements 4.2, 4.3, 4.5**
    - 使用 fast-check 生成随机 Unicode 字符串
    - 验证 truncateTitle ≤ 30 字符、truncateSubtitle ≤ 20 字符、旁白时长 ≤ 视频时长

  - [ ]* 9.3 编写 TextGenerator 单元测试
    - 创建 `server/src/services/ai/textGenerator.test.ts`
    - Mock AIProvider，验证各类型文案生成、风格参数传递、失败处理
    - _Requirements: 4.1, 4.6, 4.7_

- [x] 10. API 路由层
  - [x] 10.1 实现 AI 剪辑 API 路由
    - 创建 `server/src/routes/aiEditing.ts`
    - 实现 `POST /api/media/:id/ai-analyze`：触发 AI 内容分析，创建 processing_job，返回 jobId
    - 实现 `GET /api/media/:id/ai-analysis`：返回该视频所有片段的 AI 分析结果
    - 实现 `POST /api/media/:id/ai-edit-plan`：触发剪辑方案生成，返回 jobId
    - 实现 `GET /api/media/:id/ai-edit-plan`：返回最新 EditPlan
    - 实现 `POST /api/media/:id/ai-text`：触发文本生成（接受 type 和 style 参数）
    - 实现 `GET /api/media/:id/ai-text`：返回已生成的文本内容
    - 实现 `GET /api/ai/usage`：返回当前用户 AI 使用统计
    - 实现 `GET /api/ai/budget`：返回当前用户预算使用情况
    - 实现参数校验、认证检查、404/401/503 错误处理
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10_

  - [x] 10.2 实现管理员 AI 端点
    - 在 `server/src/routes/aiEditing.ts` 中添加管理员路由
    - 实现 `GET /api/admin/ai/usage`：查看所有用户 AI 使用情况
    - 实现 `PUT /api/admin/ai/budget/:userId`：设置用户自定义预算
    - 实现 `POST /api/admin/ai/budget/:userId/reset`：重置用户已用预算
    - _Requirements: 6.2, 6.6, 6.7_

  - [x] 10.3 注册 AI 路由到 Express 应用
    - 在 `server/src/index.ts` 或主路由文件中引入并注册 aiEditing 路由
    - 确保 AI Provider 配置缺失时 API 返回 HTTP 503
    - _Requirements: 10.5_

  - [ ]* 10.4 编写 API 路由集成测试
    - 创建 `server/src/routes/aiEditing.test.ts`
    - 测试完整流程：创建视频 → AI 内容分析 → 生成剪辑方案 → 生成文案
    - 测试参数校验、认证检查、404/401/503 响应
    - 测试预算超出时 API 拒绝
    - _Requirements: 8.9, 8.10, 6.4_

- [x] 11. Checkpoint - 确保 API 路由测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. 管线集成与降级策略
  - [x] 12.1 集成 AI 分析到现有视频处理管线
    - 修改现有视频处理管线代码，在片段分析完成后支持可选的 AI 分析步骤
    - 通过环境变量 `AI_AUTO_ANALYZE` 控制是否自动触发（默认关闭）
    - 自动触发前检查预算是否充足，不足则跳过并记录日志
    - 确保 AI 分析失败不影响管线其余步骤
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 12.2 实现 EditPlanner 与现有质量评分的融合
    - 修改 EditPlanner，在生成方案时同时考虑 narrativeScore 和 overallScore
    - 实现加权策略：narrativeScore * 0.4 + overallScore * 0.6
    - 当 AI 分析结果不可用时，回退到纯 overallScore 排序
    - _Requirements: 9.5, 9.6_

  - [x] 12.3 实现完整降级策略链
    - 实现降级优先级：AI 完整功能 → AI 部分可用 → 纯质量评分策略 → 错误提示
    - 确保每个降级层级都能产出可用的剪辑结果
    - 实现 AI Provider 配置缺失时的 503 响应
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [ ]* 12.4 编写管线集成测试
    - 测试 AI_AUTO_ANALYZE 开启/关闭时的行为
    - 测试预算不足时跳过 AI 分析
    - 测试 AI 失败时的降级路径
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 10.3, 10.4_

- [ ] 13. 属性测试汇总文件
  - [ ]* 13.1 创建属性测试汇总文件
    - 创建 `server/src/services/ai/aiSmartEditing.property.test.ts`
    - 将所有 12 个属性测试整合到统一文件中（或确保各属性测试文件正确引用）
    - 每个测试标注 `// Feature: ai-smart-editing, Property N: [标题]`
    - 确保每个属性测试最少运行 100 次迭代
    - _Requirements: 全部正确性属性 P1-P12_

- [x] 14. Final Checkpoint - 确保所有测试通过
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- 每个任务引用了具体的需求编号以确保可追溯性
- Checkpoints 确保增量验证，每个阶段完成后验证测试通过
- Property tests 验证通用正确性属性，unit tests 验证具体示例和边界情况
- 实现顺序严格按依赖关系排列：数据库 → Provider → 成本控制 → 分析器 → 规划器 → 生成器 → API → 集成
- AI Provider 层设计为可插拔架构，新增提供商只需实现 AIProvider 接口
- 所有 AI 调用均通过 BudgetController 预检查，确保不会超出预算

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.4"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.5", "2.6"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "4.5"] },
    { "id": 5, "tasks": ["4.6", "4.7"] },
    { "id": 6, "tasks": ["6.1"] },
    { "id": 7, "tasks": ["6.2", "6.3", "6.4", "7.1"] },
    { "id": 8, "tasks": ["7.2", "7.3", "7.4", "7.5", "7.6"] },
    { "id": 9, "tasks": ["9.1"] },
    { "id": 10, "tasks": ["9.2", "9.3", "10.1"] },
    { "id": 11, "tasks": ["10.2", "10.3"] },
    { "id": 12, "tasks": ["10.4", "12.1", "12.2"] },
    { "id": 13, "tasks": ["12.3", "12.4"] },
    { "id": 14, "tasks": ["13.1"] }
  ]
}
```
