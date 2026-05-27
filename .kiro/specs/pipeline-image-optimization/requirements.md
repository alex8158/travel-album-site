# Requirements Document

## Introduction

优化旅行相册项目的图片处理 pipeline，包含以下改进：

1. **模糊检测直接标记 trashed**：当前 pipeline 的 blur 阶段通过 `runBlurStage` 仅在 `ImageProcessContext` 上标记 `blurStatus`，最终由 `reduce` 阶段决定是否 trash。改为在 blur 阶段结束后立即将确认模糊的图片设置 `status = 'trashed', trashed_reason = 'blur'`，使后续阶段（dedup、AI 筛选）不再处理这些图片。

2. **AI 精修**：在 AI 筛选完成后，对最终保留的图片调用 qwen-vl-max（DashScope）获取调整建议，再用 sharp 执行亮度/对比度/饱和度/锐度调整，保存为 `optimized_path`。

3. **AI 筛选分批优化**：当前 AI screening 按上传时间顺序每 10 张一批，相似图片可能跨越批次边界导致无法被同批比较。改为利用 DINOv2/CLIP 相似度对图片预分组，确保视觉相似的图片尽量在同一批次内被 AI 审查。

另外记录环境变量变更：`DINOV2_DEDUP_THRESHOLD` 已从 0.8 调回 0.9 以解决人物照片过度去重问题。

## Glossary

- **Pipeline**：`runTripProcessingPipeline` 函数，按阶段顺序处理一个 trip 的所有媒体文件
- **Blur_Stage**：Pipeline 中的模糊检测阶段，调用 `runBlurStage` 对每张图片评估清晰度
- **AI_Screening_Stage**：Pipeline 中的 AI 筛选阶段，调用 `runAiScreening` 批量审查图片
- **AI_Refinement_Stage**：新增的 AI 精修阶段，调用 DashScope 获取调整参数并用 sharp 执行
- **DashScope_Client**：通过 OpenAI 兼容协议调用阿里云 DashScope API 的客户端
- **Sharp**：Node.js 图片处理库，用于执行亮度/对比度/饱和度/锐度调整
- **Optimized_Path**：精修后图片的存储路径，保存在 `media_items.optimized_path` 字段
- **Adjustment_Params**：AI 返回的调整参数 JSON，包含 brightness、contrast、saturation、sharpness 四个维度
- **Similarity_Grouping**：基于 DINOv2 余弦相似度对图片进行预分组，使视觉相似的图片被分配到同一 AI 筛选批次
- **Batch**：AI 筛选中一次发送给 qwen-vl-max 的图片集合，当前上限为 10 张

## Requirements

### Requirement 1: 模糊检测直接标记 trashed

**User Story:** 作为系统管理员，我希望确认模糊的图片在 blur 阶段就被直接标记为 trashed，这样后续的去重和 AI 筛选阶段不会浪费资源处理这些图片。

#### Acceptance Criteria

1. WHEN Blur_Stage 将一张图片评估为 `blurStatus = 'blurry'`，THE Pipeline SHALL 在数据库中将该图片设置 `status = 'trashed'`、`trashed_reason = 'blur'`、`blur_status = 'blurry'`，并记录该图片的 `sharpness_score` 数值
2. WHEN Blur_Stage 完成后进入 dedup 阶段，THE Pipeline SHALL 仅处理 `status = 'active'` 的图片，排除已被 blur 阶段 trash 的图片
3. WHEN Blur_Stage 完成后进入 AI_Screening_Stage，THE Pipeline SHALL 仅处理 `status = 'active'` 的图片，排除已被 blur 阶段 trash 的图片
4. WHEN 一张图片被 Blur_Stage 标记为 `blurStatus = 'suspect'`，THE Pipeline SHALL 保持该图片 `status = 'active'` 并仅更新 `blur_status` 和 `sharpness_score` 字段
5. WHEN 一张图片被 Blur_Stage 标记为 `blurStatus = 'clear'`，THE Pipeline SHALL 保持该图片 `status = 'active'` 并更新 `blur_status` 和 `sharpness_score` 字段
6. WHEN reduce 阶段生成最终决策时，THE Pipeline SHALL 确保已被 blur 阶段 trash 的图片在 decisions 中 `finalStatus = 'trashed'` 且 `trashedReasons` 包含 `'blur'`
7. IF Blur_Stage 在评估某张图片时发生计算错误，THEN THE Pipeline SHALL 将该图片标记为 `blurStatus = 'suspect'`、保持 `status = 'active'`，并将错误信息追加到该图片的 `processing_error` 字段

### Requirement 2: AI 精修阶段

**User Story:** 作为用户，我希望最终保留的图片能通过 AI 分析获得针对性的画质调整建议并自动执行，这样我能得到更好的水下照片观看体验。

#### Acceptance Criteria

1. WHEN AI_Screening_Stage 完成且 `AI_REVIEW_ENABLED=true` 且 `DASHSCOPE_API_KEY` 为非空字符串，THE Pipeline SHALL 执行 AI_Refinement_Stage
2. WHEN AI_Refinement_Stage 执行时，THE Pipeline SHALL 仅处理 `status = 'active'` 且 `media_type = 'image'` 的图片，按顺序逐张处理
3. WHEN AI_Refinement_Stage 处理一张图片时，THE DashScope_Client SHALL 将图片发送给 qwen-vl-max 模型并请求返回 JSON 格式的 Adjustment_Params，单次调用超时时间为 30 秒
4. THE Adjustment_Params SHALL 包含四个字段：`brightness`（0~2）、`contrast`（0~2）、`saturation`（0~2）、`sharpness`（0~2），其中 1.0 表示不调整
5. WHEN DashScope_Client 返回有效的 Adjustment_Params 且至少一个字段值不等于 1.0，THE Sharp SHALL 按参数执行亮度、对比度、饱和度、锐度调整
6. WHEN Sharp 完成调整后，THE Pipeline SHALL 将结果保存到存储并更新 `media_items.optimized_path` 字段
7. IF DashScope_Client 调用失败（网络错误、超时、HTTP 非 2xx 响应）或返回无效 JSON，THEN THE Pipeline SHALL 跳过该图片的 AI 精修并记录错误日志，不影响其他图片处理
8. IF `AI_REVIEW_ENABLED` 不为 `true` 或 `DASHSCOPE_API_KEY` 为空或未设置，THEN THE Pipeline SHALL 跳过 AI_Refinement_Stage
9. WHEN Adjustment_Params 中某个字段值为 1.0 时，THE Sharp SHALL 跳过该维度的调整操作
10. IF Adjustment_Params 的四个字段值均为 1.0，THEN THE Pipeline SHALL 跳过该图片的 Sharp 处理并保留现有的 `optimized_path` 不变

### Requirement 3: AI 精修参数校验

**User Story:** 作为系统管理员，我希望 AI 返回的调整参数经过严格校验，这样不会因为异常参数导致图片质量恶化。

#### Acceptance Criteria

1. WHEN DashScope_Client 返回的 Adjustment_Params 中任一字段值小于 0 或大于 2，THE Pipeline SHALL 将该字段值裁剪到 [0, 2] 范围内
2. WHEN DashScope_Client 返回的 JSON 中 brightness、contrast、saturation、sharpness 任一字段缺失或其值为非数值类型（null、字符串、布尔值、NaN），THE Pipeline SHALL 对该字段使用默认值 1.0（不调整）
3. WHEN DashScope_Client 返回的内容无法直接解析为有效 JSON，THE Pipeline SHALL 尝试从响应文本中提取第一个完整的 JSON 对象（匹配 markdown code block 内的内容或首个 `{` 到对应 `}` 的文本）
4. IF 提取 JSON 仍然失败，THEN THE Pipeline SHALL 跳过该图片的 AI 精修、记录包含该图片标识的警告日志，并继续处理剩余图片
5. WHEN 从响应文本中成功提取 JSON 对象后，THE Pipeline SHALL 对提取结果执行与正常返回相同的字段校验（标准 1 和标准 2 的裁剪与默认值逻辑）

### Requirement 4: AI 精修与现有 optimize 阶段的关系

**User Story:** 作为开发者，我希望 AI 精修的结果能正确覆盖或补充现有的 optimize 阶段输出，这样两个优化不会冲突。

#### Acceptance Criteria

1. THE Pipeline SHALL 在现有 optimize 阶段之后、thumbnail 阶段之前执行 AI_Refinement_Stage，使 thumbnail 阶段始终基于最终的 `media_items.optimized_path` 值生成缩略图
2. WHEN AI_Refinement_Stage 生成新的 optimized 文件时，THE Pipeline SHALL 以 AI 精修结果覆盖 `media_items.optimized_path`，其中 AI 精修的输入为该图片的原始上传文件（`media_items.file_path`），而非传统 optimize 阶段的输出
3. WHEN AI_Refinement_Stage 跳过某张图片（因 DashScope 调用失败、返回无效参数、或启用条件不满足）时，THE Pipeline SHALL 保留该图片现有的 `optimized_path` 值不变（即传统 optimize 阶段的输出，若传统 optimize 也未生成则 `optimized_path` 保持为 NULL）
4. IF 传统 optimize 阶段和 AI_Refinement_Stage 均未能为某张图片生成 optimized 文件，THEN THE Pipeline SHALL 保持该图片的 `optimized_path` 为 NULL，thumbnail 阶段应基于原始 `file_path` 生成缩略图

### Requirement 5: DINOv2 去重阈值调整

**User Story:** 作为系统管理员，我希望 DINOv2 去重阈值从 0.8 调回 0.9，这样人物照片不会被过度去重。

#### Acceptance Criteria

1. THE Pipeline SHALL 使用 0.9 作为 DINOv2 余弦相似度去重的默认阈值，当两张图片的 DINOv2 余弦相似度 ≥ 该阈值时判定为重复
2. IF `DINOV2_DEDUP_THRESHOLD` 环境变量已设置且值为 0.0 到 1.0 之间的有效数字，THEN THE Pipeline SHALL 使用该环境变量指定的值覆盖默认阈值 0.9
3. IF `DINOV2_DEDUP_THRESHOLD` 环境变量已设置但值不是有效数字或超出 0.0 到 1.0 范围，THEN THE Pipeline SHALL 忽略该无效值，使用默认阈值 0.9，并在 stderr 输出警告日志

### Requirement 6: AI 筛选相似度预分组

**User Story:** 作为用户，我希望 AI 筛选能更有效地识别和去除相似图片，即使它们在上传时间上不相邻，这样最终相册中不会出现多张几乎相同的照片。

#### Acceptance Criteria

1. WHEN AI_Screening_Stage 执行前，THE Pipeline SHALL 利用 dedup 阶段已计算的 DINOv2 嵌入向量对 active 图片进行相似度预分组，将余弦相似度 ≥ 0.75 的图片归入同一组
2. WHEN 构建 AI 筛选批次时，THE Pipeline SHALL 优先将同一相似度组内的图片分配到同一批次，确保视觉相似的图片能被 AI 在同一上下文中比较
3. WHEN 一个相似度组的图片数量超过批次上限（10 张）时，THE Pipeline SHALL 将该组拆分为多个批次，每个批次不超过 10 张
4. WHEN 一个相似度组的图片数量不足以填满一个批次时，THE Pipeline SHALL 用其他小组或未分组的图片填充至批次上限，优先选择与该组相似度较高的图片
5. IF DINOv2 嵌入向量不可用（Python 服务不可达或 dedup 阶段未运行），THEN THE Pipeline SHALL 回退到按上传时间排序的原有分批策略
6. WHEN 预分组完成后，THE Pipeline SHALL 在日志中输出分组统计信息（总组数、最大组大小、未分组图片数）
