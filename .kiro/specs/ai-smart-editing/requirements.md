# 需求文档：AI 智能剪辑

## 简介

在现有视频处理管线（场景检测、质量评分、片段选择、过渡效果）基础上，引入 AI 大模型能力，实现视频内容的深度理解与智能剪辑方案生成。系统通过多模态 AI（如 Claude、GPT-4V）分析视频片段的语义内容，生成场景描述、情感标签和叙事价值评分，再由 LLM 基于内容理解结果生成最优剪辑方案（片段选择顺序、过渡方式、节奏建议）。同时支持 AI 生成视频标题、片段字幕和旁白文案。系统提供统一的 AI Provider 抽象层支持多提供商切换，并内置完整的成本追踪与预算控制机制。

## 术语表

- **AI_Provider**: AI 提供商抽象层，封装不同 AI 服务（Bedrock Claude、OpenAI GPT-4V 等）的统一调用接口
- **Content_Analyzer**: 内容分析器，使用多模态 AI 分析视频片段的视觉内容，生成场景描述、情感标签和叙事价值评分
- **Edit_Planner**: 剪辑方案规划器，使用 LLM 基于内容分析结果生成剪辑方案
- **Text_Generator**: 文本生成器，使用 LLM 生成视频标题、片段字幕和旁白文案
- **Cost_Tracker**: 成本追踪器，记录每次 AI 调用的 token 用量和费用
- **Budget_Controller**: 预算控制器，在 AI 调用前检查预算余额，超出预算时拒绝调用
- **Scene_Description**: 场景描述，AI 对视频片段视觉内容的自然语言描述
- **Emotion_Tag**: 情感标签，AI 对视频片段情感氛围的分类标注（如欢乐、宁静、壮观、温馨等）
- **Narrative_Score**: 叙事价值评分，AI 对视频片段在整体叙事中重要性的量化评分（0-100）
- **Edit_Plan**: 剪辑方案，包含片段选择顺序、过渡方式建议和节奏标注的结构化数据
- **AI_Usage_Record**: AI 使用记录，包含提供商、模型、输入/输出 token 数、费用和调用时间
- **Budget_Limit**: 预算限制，按用户或按旅行设置的 AI 调用费用上限
- **Provider_Config**: 提供商配置，包含 API 密钥、模型选择、区域等连接参数
- **Segment**: 视频片段，由视频分析器在自然边界处切分产生的视频单元（复用现有定义）

## 需求

### 需求 1：AI Provider 抽象层

**用户故事：** 作为开发者，我希望系统提供统一的 AI 调用接口，支持多个 AI 提供商的无缝切换，以便在不修改业务代码的情况下更换底层 AI 服务。

#### 验收标准

1. THE AI_Provider SHALL 定义统一的调用接口，包含文本生成（text completion）和多模态分析（vision analysis）两种能力
2. THE AI_Provider SHALL 支持 AWS Bedrock Claude 作为提供商实现
3. THE AI_Provider SHALL 支持 OpenAI GPT-4V/GPT-4o 作为提供商实现
4. WHEN 调用 AI_Provider 时, THE AI_Provider SHALL 接受统一的请求参数（prompt、images、maxTokens、temperature）并返回统一的响应格式（text、usage）
5. THE AI_Provider SHALL 通过环境变量或配置文件选择当前活跃的提供商，无需修改代码
6. WHEN AI_Provider 调用失败, THE AI_Provider SHALL 按指数退避策略重试最多 3 次
7. IF 所有重试均失败, THEN THE AI_Provider SHALL 返回包含错误类型和描述的结构化错误对象
8. THE AI_Provider SHALL 在每次调用的响应中返回实际消耗的 token 数量（input_tokens 和 output_tokens）
9. WHEN 调用包含图片的多模态请求时, THE AI_Provider SHALL 自动将图片缩放至提供商要求的最大尺寸限制内

### 需求 2：AI 视频内容理解

**用户故事：** 作为用户，我希望系统能用 AI 理解视频片段的内容，生成场景描述和情感标签，以便后续智能剪辑能基于语义而非仅基于画面质量进行片段选择。

#### 验收标准

1. WHEN 视频分析完成后触发 AI 内容理解, THE Content_Analyzer SHALL 从每个 Segment 中提取代表帧（中间帧）并发送给 AI_Provider 进行多模态分析
2. THE Content_Analyzer SHALL 为每个 Segment 生成 Scene_Description（不超过 100 字的自然语言描述）
3. THE Content_Analyzer SHALL 为每个 Segment 生成 1-3 个 Emotion_Tag（从预定义标签集中选择）
4. THE Content_Analyzer SHALL 为每个 Segment 生成 Narrative_Score（0-100 整数，表示该片段在整体叙事中的重要性）
5. WHEN 单个 Segment 的 AI 分析失败, THE Content_Analyzer SHALL 为该 Segment 设置默认值（空描述、空标签、Narrative_Score 为 50）并继续处理其余片段
6. THE Content_Analyzer SHALL 支持批量分析模式，将多个片段的代表帧合并为一次 AI 调用以减少请求次数
7. THE Content_Analyzer SHALL 将分析结果持久化到数据库，避免重复分析
8. WHEN Segment 已有 AI 分析结果且未过期, THE Content_Analyzer SHALL 直接返回缓存结果而不重新调用 AI

### 需求 3：AI 剪辑方案生成

**用户故事：** 作为用户，我希望 AI 能基于对视频内容的理解，生成一个考虑叙事逻辑和节奏感的剪辑方案，以便最终视频不仅画面质量好，还具有故事性。

#### 验收标准

1. WHEN 内容分析完成后, THE Edit_Planner SHALL 将所有 Segment 的分析结果（Scene_Description、Emotion_Tag、Narrative_Score、质量评分、时长）作为上下文发送给 LLM
2. THE Edit_Planner SHALL 生成结构化的 Edit_Plan，包含：选中片段的索引列表、每个片段间的推荐过渡方式、整体节奏标注（快/中/慢）
3. THE Edit_Planner SHALL 在 Edit_Plan 中为每个选中片段标注选择理由（一句话说明）
4. WHEN 生成 Edit_Plan 时, THE Edit_Planner SHALL 遵守目标时长限制（与现有时长分档逻辑一致）
5. WHEN 生成 Edit_Plan 时, THE Edit_Planner SHALL 优先选择 Narrative_Score 高的片段，同时兼顾画面质量评分
6. THE Edit_Planner SHALL 确保 Edit_Plan 中的片段顺序具有叙事连贯性（开头-发展-高潮-结尾的基本结构）
7. IF LLM 返回的 Edit_Plan 格式不合法或包含无效片段索引, THEN THE Edit_Planner SHALL 回退到现有的基于评分的片段选择策略
8. THE Edit_Planner SHALL 将生成的 Edit_Plan 持久化到数据库，供用户查看和修改

### 需求 4：标题/字幕/旁白生成

**用户故事：** 作为用户，我希望 AI 能为我的视频生成合适的标题、片段字幕和旁白文案，以便视频更具表现力和可分享性。

#### 验收标准

1. WHEN 用户请求生成标题时, THE Text_Generator SHALL 基于所有片段的 Scene_Description 和 Emotion_Tag 生成 3 个候选视频标题
2. THE Text_Generator SHALL 生成的标题不超过 30 个字符，风格简洁有吸引力
3. WHEN 用户请求生成字幕时, THE Text_Generator SHALL 为每个选中的 Segment 生成一句字幕文案（不超过 20 个字符）
4. WHEN 用户请求生成旁白时, THE Text_Generator SHALL 基于 Edit_Plan 和片段内容生成连贯的旁白文案
5. THE Text_Generator SHALL 生成的旁白文案总时长（按朗读速度估算）不超过视频总时长
6. THE Text_Generator SHALL 支持指定文案风格（旅行日记、纪录片、社交媒体短视频等）
7. IF 文本生成失败, THEN THE Text_Generator SHALL 返回空结果并记录错误，不影响视频剪辑流程

### 需求 5：成本追踪

**用户故事：** 作为系统管理员，我希望系统记录每次 AI 调用的 token 用量和费用，以便监控和分析 AI 使用成本。

#### 验收标准

1. WHEN AI_Provider 完成一次调用, THE Cost_Tracker SHALL 记录一条 AI_Usage_Record，包含：用户 ID、旅行 ID、提供商名称、模型名称、输入 token 数、输出 token 数、估算费用、调用时间、调用类型（content_analysis/edit_planning/text_generation）
2. THE Cost_Tracker SHALL 根据提供商和模型的单价配置自动计算每次调用的估算费用
3. THE Cost_Tracker SHALL 提供按用户、按旅行、按时间范围查询累计费用的接口
4. THE Cost_Tracker SHALL 提供按调用类型分组统计费用的接口
5. THE Cost_Tracker SHALL 将单价配置存储在配置文件中，支持通过环境变量覆盖
6. WHEN 提供商返回的 usage 信息不完整, THE Cost_Tracker SHALL 基于 prompt 长度和响应长度估算 token 数

### 需求 6：预算控制

**用户故事：** 作为系统管理员，我希望能为每个用户或每次旅行设置 AI 调用预算上限，以便防止意外的高额费用。

#### 验收标准

1. THE Budget_Controller SHALL 支持设置全局默认预算限制（每用户每月）
2. THE Budget_Controller SHALL 支持为单个用户设置自定义预算限制，覆盖全局默认值
3. WHEN AI_Provider 调用前, THE Budget_Controller SHALL 检查当前用户的已用预算是否已达到限制
4. IF 当前用户的已用预算已达到或超过限制, THEN THE Budget_Controller SHALL 拒绝该次 AI 调用并返回 "BUDGET_EXCEEDED" 错误
5. THE Budget_Controller SHALL 在预算使用达到 80% 时在 AI 调用响应中附加预算警告信息
6. THE Budget_Controller SHALL 支持管理员查看所有用户的预算使用情况
7. THE Budget_Controller SHALL 支持管理员重置用户的已用预算（用于新计费周期）
8. THE Budget_Controller SHALL 从环境变量读取全局默认预算限制，提供合理的默认值（如每用户每月 5 美元）

### 需求 7：AI 分析结果存储

**用户故事：** 作为开发者，我希望 AI 分析结果和剪辑方案持久化存储在数据库中，以便前端展示和后续复用。

#### 验收标准

1. THE Content_Analyzer SHALL 将每个 Segment 的 AI 分析结果（Scene_Description、Emotion_Tag、Narrative_Score）存储到 segment_ai_analysis 表
2. THE Edit_Planner SHALL 将生成的 Edit_Plan 存储到 ai_edit_plans 表，关联 media_id
3. THE Text_Generator SHALL 将生成的标题、字幕、旁白存储到 ai_generated_texts 表，关联 media_id
4. THE Cost_Tracker SHALL 将 AI_Usage_Record 存储到 ai_usage_records 表
5. THE Budget_Controller SHALL 将用户预算配置存储到 ai_budget_configs 表
6. WHEN 用户删除旅行时, THE AI_Provider SHALL 级联删除该旅行关联的所有 AI 分析结果和生成内容

### 需求 8：AI 剪辑 API 端点

**用户故事：** 作为前端开发者，我希望有清晰的 API 端点来触发 AI 分析、获取剪辑方案和生成文案，以便在前端集成 AI 功能。

#### 验收标准

1. WHEN POST 请求发送到 /api/media/:id/ai-analyze, THE AI_Provider SHALL 触发该视频的 AI 内容分析流程并返回 jobId
2. WHEN GET 请求发送到 /api/media/:id/ai-analysis, THE AI_Provider SHALL 返回该视频所有片段的 AI 分析结果
3. WHEN POST 请求发送到 /api/media/:id/ai-edit-plan, THE AI_Provider SHALL 触发剪辑方案生成并返回 jobId
4. WHEN GET 请求发送到 /api/media/:id/ai-edit-plan, THE AI_Provider SHALL 返回最新的 Edit_Plan
5. WHEN POST 请求发送到 /api/media/:id/ai-text, THE AI_Provider SHALL 触发文本生成（标题/字幕/旁白）并返回 jobId
6. WHEN GET 请求发送到 /api/media/:id/ai-text, THE AI_Provider SHALL 返回已生成的文本内容
7. WHEN GET 请求发送到 /api/ai/usage, THE Cost_Tracker SHALL 返回当前用户的 AI 使用统计
8. WHEN GET 请求发送到 /api/ai/budget, THE Budget_Controller SHALL 返回当前用户的预算使用情况
9. IF 请求的 media 不存在, THEN THE AI_Provider SHALL 返回 HTTP 404
10. IF 用户未认证, THEN THE AI_Provider SHALL 返回 HTTP 401

### 需求 9：AI 分析与现有管线集成

**用户故事：** 作为用户，我希望 AI 分析能与现有的视频处理管线无缝集成，在视频分析完成后自动触发或手动触发 AI 分析。

#### 验收标准

1. WHEN 视频处理管线完成片段分析后, THE Content_Analyzer SHALL 支持作为可选步骤自动触发 AI 内容分析
2. THE Content_Analyzer SHALL 支持通过环境变量 AI_AUTO_ANALYZE 控制是否自动触发（默认关闭）
3. WHEN AI 自动分析被启用时, THE Content_Analyzer SHALL 在触发前检查预算是否充足
4. IF 预算不足, THEN THE Content_Analyzer SHALL 跳过 AI 分析步骤并记录日志，不影响管线其余步骤
5. THE Edit_Planner SHALL 在生成剪辑方案时同时考虑 AI 内容分析结果（Narrative_Score）和现有质量评分（overallScore）
6. WHEN AI 分析结果不可用时（未分析或分析失败）, THE Edit_Planner SHALL 回退到纯基于质量评分的片段选择策略

### 需求 10：错误处理与降级

**用户故事：** 作为用户，我希望 AI 功能出现问题时系统能优雅降级，不影响基础视频剪辑功能的正常使用。

#### 验收标准

1. IF AI_Provider 调用超时（超过 30 秒）, THEN THE Content_Analyzer SHALL 终止该次调用并标记为失败
2. IF AI_Provider 返回速率限制错误, THEN THE AI_Provider SHALL 按指数退避等待后重试
3. WHEN AI 内容分析全部失败, THE Content_Analyzer SHALL 返回明确的错误信息，系统回退到基于质量评分的剪辑策略
4. WHEN AI 剪辑方案生成失败, THE Edit_Planner SHALL 返回明确的错误信息，系统使用现有的评分排序策略
5. IF AI_Provider 配置缺失（无 API 密钥）, THEN THE AI_Provider SHALL 在启动时记录警告日志，AI 相关 API 端点返回 HTTP 503 并说明 AI 服务未配置
6. THE AI_Provider SHALL 对所有 AI 调用设置 30 秒超时限制，可通过环境变量 AI_TIMEOUT_MS 配置

