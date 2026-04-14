# 需求文档：四层混合去重流水线

## 简介

当前系统有两套独立的去重引擎：基于 pHash/dHash 的 `dedupEngine.ts` 和基于 Bedrock 视觉模型的 `dedupEngine.bedrock.ts`。两者各有局限——哈希去重对构图相似但内容不同的照片容易误判，而纯大模型去重成本高、速度慢。

旅行照片存在三类容易混淆的情况：
1. **真正重复**：连拍、导出副本、轻微裁剪/压缩
2. **同场景非重复**：同一人/位置但不同表情/姿势/构图
3. **语义相似非重复**：同一动物/海洋/地标但不同时间拍摄

单一 CLIP 阈值（如 0.85）无法稳定区分以上三类，因为阈值会随 CLIP 模型版本、归一化方式和图片内容而变化。本功能实现四层递进式混合去重流水线：

- **Layer 0 — Hash 预过滤**：文件哈希精确匹配 + pHash/dHash 极低距离直接判定重复，成本最低，拦截明显重复
- **Layer 1 — CLIP 粗筛**：三档分层阈值输出候选对，而非单一阈值一刀切
- **Layer 2 — LLM 逐对精判**：仅对灰区候选对调用多模态视觉模型做逐对审查
- **Layer 3 — 质量选择与分组**：Union-Find 合并确认重复对为组，复用已有 qualitySelector 选出每组最佳

## 术语表

- **Hash_PreFilter**: Layer 0 哈希预过滤器，使用文件哈希精确匹配和 pHash/dHash 低距离匹配快速识别明显重复
- **CLIP_Coarse_Filter**: Layer 1 CLIP 粗筛器（Python 端 `analyze.py`），负责提取 CLIP 嵌入向量并按三档阈值输出候选对
- **LLM_Pair_Reviewer**: Layer 2 大模型逐对审查器（新增 `llmPairReviewer.ts`），调用多模态视觉模型对灰区候选对做逐对精确判断
- **Quality_Grouper**: Layer 3 质量选择与分组器，使用 Union-Find 合并确认重复对并复用 `qualitySelector.ts` 选出最佳保留
- **Hybrid_Dedup_Engine**: 四层混合去重引擎（TypeScript），协调四层流水线的完整执行
- **Bedrock_Client**: 已有的 AI 客户端（`bedrockClient.ts`），支持 Bedrock、OpenAI 和 DashScope（千问）三种 provider
- **Process_Router**: 处理路由（`process.ts`），触发完整的图片处理流水线
- **Candidate_Pair**: 候选重复对，Layer 1 CLIP 粗筛阶段输出的图片对（含相似度分值和所属档位）
- **Gray_Zone_Pair**: 灰区候选对，CLIP 相似度处于中间档位、需要 LLM 进一步判断的候选对
- **Confirmed_Pair**: 确认重复对，经过任意层级确认为重复的图片对
- **Strict_Threshold**: CLIP 严格阈值，固定为 0.955，在无已配置 LLM provider 或所有 provider 均失败时用于灰区候选对的最终判定
- **Provider_Chain**: LLM provider 级联链，按优先级排序的已配置 provider 列表（默认顺序：OpenAI → Bedrock → DashScope），首选 provider 排在最前，失败时依次尝试下一个
- **pHash**: 感知哈希（Perceptual Hash），基于图片低频特征的 64 位哈希值
- **dHash**: 差异哈希（Difference Hash），基于相邻像素差异的 64 位哈希值
- **Union_Find**: 并查集算法，用于将确认重复对合并为重复组

## 需求

### 需求 1：Layer 0 — Hash 预过滤

**用户故事：** 作为系统管理员，我希望系统在调用 CLIP 之前先用最低成本的哈希比较拦截明显重复，以减少后续层级的计算量。

#### 验收标准

1. WHEN 去重流水线启动时，THE Hash_PreFilter SHALL 对旅行中所有活跃和已回收的图片计算文件哈希（MD5 或 SHA-256）、pHash 和 dHash
2. WHEN 两张图片的文件哈希完全相同时，THE Hash_PreFilter SHALL 将该对直接标记为 Confirmed_Pair，跳过后续所有层级
3. WHEN 两张图片的 pHash 汉明距离 ≤ 4 且 dHash 汉明距离 ≤ 4 时，THE Hash_PreFilter SHALL 将该对直接标记为 Confirmed_Pair，跳过后续所有层级
4. THE Hash_PreFilter SHALL 将未被 Layer 0 确认为重复的图片传递给 Layer 1 继续处理
5. IF 某张图片的哈希计算失败，THEN THE Hash_PreFilter SHALL 跳过该图片的 Layer 0 配对，将其直接传递给 Layer 1

### 需求 2：Layer 1 — CLIP 三档粗筛

**用户故事：** 作为系统管理员，我希望 CLIP 粗筛使用分层阈值而非单一阈值，以更稳定地区分真正重复、灰区候选和明确不同的图片。

#### 验收标准

1. WHEN Layer 0 完成后，THE CLIP_Coarse_Filter SHALL 对剩余图片提取 CLIP 嵌入向量
2. THE CLIP_Coarse_Filter SHALL 使用 top-k 近邻搜索（k 值范围 3~5）查找每张图片的最近邻，而非全量两两比较
3. WHEN 两张图片的 CLIP 余弦相似度 ≥ 0.94 时，THE CLIP_Coarse_Filter SHALL 将该对直接标记为 Confirmed_Pair（高置信度，直接进入确认池）
4. WHEN 两张图片的 CLIP 余弦相似度在 [0.90, 0.94) 区间且该图片的 top-k 邻居数 ≤ 5 时，THE CLIP_Coarse_Filter SHALL 将该对标记为 Gray_Zone_Pair（进入候选池）
5. WHEN 两张图片的 CLIP 余弦相似度在 [0.85, 0.90) 区间时，THE CLIP_Coarse_Filter SHALL 仅在同时满足以下两个条件时将该对标记为 Gray_Zone_Pair：序列位置差 abs(i - j) ≤ 12，且 pHash 汉明距离 ≤ 16 或 dHash 汉明距离 ≤ 16
6. WHEN 两张图片的 CLIP 余弦相似度 < 0.85 时，THE CLIP_Coarse_Filter SHALL 跳过该对，不进入任何候选池
7. THE CLIP_Coarse_Filter SHALL 仅输出 Candidate_Pair 列表（含 Confirmed_Pair 和 Gray_Zone_Pair），不执行分组操作
8. IF 某张图片的 CLIP 嵌入提取失败，THEN THE CLIP_Coarse_Filter SHALL 跳过该图片的配对，并在 stderr 输出错误日志

### 需求 3：Layer 2 — LLM 逐对精判

**用户故事：** 作为系统管理员，我希望仅对灰区候选对调用多模态视觉模型做逐对审查，以在控制成本的同时避免误删不同内容的相似照片。系统应支持多 provider 自动检测与级联回退，最大化可用性。

#### 验收标准

1. WHEN 至少一个 LLM provider 已配置且存在 Gray_Zone_Pair 时，THE LLM_Pair_Reviewer SHALL 将每个 Gray_Zone_Pair 的两张图片发送给多模态视觉模型进行比较（每次仅发送 2 张图片）
2. THE LLM_Pair_Reviewer SHALL 向视觉模型发送包含两张图片的请求，并要求模型返回 JSON 格式的判定结果，包含 `is_duplicate`（布尔值）和 `confidence`（0-1 浮点数）字段
3. WHEN 视觉模型返回 `is_duplicate` 为 true 时，THE LLM_Pair_Reviewer SHALL 将该 Gray_Zone_Pair 标记为 Confirmed_Pair
4. WHEN 视觉模型返回 `is_duplicate` 为 false 时，THE LLM_Pair_Reviewer SHALL 保留两张图片不做去重处理
5. IF 当前 provider 的视觉模型调用失败，THEN THE LLM_Pair_Reviewer SHALL 记录错误日志，并尝试下一个已配置的 provider（级联回退）
6. IF 所有已配置的 LLM provider 对某个 Gray_Zone_Pair 均调用失败，THEN THE LLM_Pair_Reviewer SHALL 放弃该对的 LLM 判定，记录通知日志，并对该对回退到 Strict_Threshold（0.955）判定
7. IF 所有 Gray_Zone_Pair 的 LLM 调用均失败，THEN THE Hybrid_Dedup_Engine SHALL 输出初步 CLIP 结果（使用 Strict_Threshold 判定所有灰区对），并附带通知说明 LLM 不可用
8. THE LLM_Pair_Reviewer SHALL 按以下优先级选择视觉模型：GPT-4.1 mini（最佳性价比）→ GPT-4.1（困难边界案例）→ Claude Sonnet 4.6（需要详细推理的边界案例）→ Gemini 2.5 Flash（高吞吐批量审查）
9. THE LLM_Pair_Reviewer SHALL 复用已有的 Bedrock_Client（`createAIClient()`）创建视觉模型客户端，根据 provider 链中的当前 provider 选择对应客户端

### 需求 4：LLM 未配置时的回退策略

**用户故事：** 作为系统管理员，我希望在没有检测到任何已配置的 LLM provider 的情况下，系统仍能通过更严格的 CLIP 阈值处理灰区候选对，保证基本的去重能力。

#### 验收标准

1. WHEN 没有检测到任何已配置的 LLM provider 且存在 Gray_Zone_Pair 时，THE Hybrid_Dedup_Engine SHALL 对所有 Gray_Zone_Pair 应用 Strict_Threshold（0.955）进行最终判定
2. WHEN Gray_Zone_Pair 的 CLIP 余弦相似度 ≥ Strict_Threshold 时，THE Hybrid_Dedup_Engine SHALL 将该对标记为 Confirmed_Pair
3. WHEN Gray_Zone_Pair 的 CLIP 余弦相似度 < Strict_Threshold 时，THE Hybrid_Dedup_Engine SHALL 保留两张图片不做去重处理

### 需求 5：Layer 3 — 质量选择与分组

**用户故事：** 作为系统管理员，我希望系统能将所有层级确认的重复对合并为重复组，并自动选择每组中质量最好的图片保留。

#### 验收标准

1. WHEN 存在 Confirmed_Pair 时，THE Quality_Grouper SHALL 使用 Union_Find 算法将所有 Confirmed_Pair 合并为重复组
2. THE Quality_Grouper SHALL 复用已有的 `qualitySelector.ts` 对每个重复组选择最佳保留图片，优先级为：清晰度评分最高 → 分辨率最高 → 文件大小最大 → 序列中最早的图片
3. WHEN 重复组中的被淘汰图片状态为 active 时，THE Quality_Grouper SHALL 将其状态更新为 trashed，trashed_reason 设为 'duplicate'
4. WHEN 重复组中的被淘汰图片状态已为 trashed 时，THE Quality_Grouper SHALL 在其 trashed_reason 后追加 ',duplicate'

### 需求 6：环境变量配置与多 Provider 自动检测

**用户故事：** 作为系统管理员，我希望系统能自动检测已配置的 LLM provider，并支持级联回退，以最大化 LLM 去重的可用性，同时允许我指定首选 provider。

#### 验收标准

1. THE Hybrid_Dedup_Engine SHALL 通过检测环境变量自动发现已配置的 LLM provider，支持以下三种 provider：
   - **OpenAI**（GPT-4.1 mini / GPT-4.1 等）：需要 `OPENAI_API_KEY` 已设置；可选 `OPENAI_MODEL`（默认 `gpt-4o-mini`）
   - **Bedrock**（Claude Sonnet / Nova 等）：需要 `AWS_ACCESS_KEY_ID` 和 `AWS_SECRET_ACCESS_KEY` 均已设置；可选 `S3_REGION` 或 `AWS_REGION`（默认 `us-east-1`）、`BEDROCK_MODEL_ID`
   - **DashScope / 千问**（Qwen-VL 系列）：需要 `DASHSCOPE_API_KEY` 已设置；可选 `DASHSCOPE_MODEL`（默认 `qwen-vl-max`）、`DASHSCOPE_BASE_URL`（默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`）。DashScope API 兼容 OpenAI 协议，使用 OpenAI SDK 配合自定义 base URL 调用
2. WHEN 多个 provider 的环境变量均已配置时，THE Hybrid_Dedup_Engine SHALL 将所有已检测到的 provider 加入可用 provider 列表
3. THE Hybrid_Dedup_Engine SHALL 支持可选环境变量 `LLM_DEDUP_PROVIDER`（可选值为 `openai`、`bedrock`、`dashscope` 或留空），用于指定首选/默认 provider
4. WHEN `LLM_DEDUP_PROVIDER` 已设置且对应 provider 的环境变量已配置时，THE Hybrid_Dedup_Engine SHALL 将该 provider 作为级联链中的第一个尝试
5. WHEN `LLM_DEDUP_PROVIDER` 已设置但对应 provider 的环境变量未配置时，THE Hybrid_Dedup_Engine SHALL 记录警告日志，并使用其他已检测到的 provider
6. WHEN 首选 provider 调用失败时，THE LLM_Pair_Reviewer SHALL 按级联顺序尝试下一个已配置的 provider，直到成功或所有 provider 均失败
7. THE 默认级联顺序 SHALL 为：OpenAI → Bedrock → DashScope（当未指定 `LLM_DEDUP_PROVIDER` 时）
8. WHEN 没有任何 provider 的环境变量被配置时，THE Hybrid_Dedup_Engine SHALL 跳过 Layer 2，对灰区候选对使用 Strict_Threshold 回退判定
9. IF 所有已配置的 LLM provider 对某个 Gray_Zone_Pair 均调用失败，THEN THE LLM_Pair_Reviewer SHALL 放弃该对的 LLM 判定，记录通知日志，并对该对回退到 Strict_Threshold（0.955）判定
10. IF 所有 Gray_Zone_Pair 的 LLM 调用均失败（即所有 provider 对所有对均失败），THEN THE Hybrid_Dedup_Engine SHALL 直接输出基于 Strict_Threshold 的初步 CLIP 结果，并附带通知说明 LLM 不可用
11. THE `.env.example` 文件 SHALL 包含所有三种 provider 的环境变量说明和示例，每个变量附带中文注释

### 需求 7：处理流水线集成

**用户故事：** 作为系统管理员，我希望四层混合去重能无缝替换现有的去重步骤，不影响其他处理流程。

#### 验收标准

1. THE Process_Router SHALL 在去重步骤中调用 Hybrid_Dedup_Engine 替代现有的 dedupEngine
2. WHEN Python CLIP 不可用时，THE Process_Router SHALL 回退到现有的 pHash/dHash 去重引擎（`dedupEngine.ts`）
3. THE Hybrid_Dedup_Engine SHALL 返回与现有 DedupResult 接口兼容的结果（包含 kept、removed、removedCount 字段）
4. THE Process_Router SHALL 在 SSE 流式处理中正确报告四层混合去重的进度（包括各层级的处理状态）
