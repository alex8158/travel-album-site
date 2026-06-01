# Bugfix Requirements Document

## Introduction

AI 相似照片去重功能在旅行相册项目中实际效果很差。用户报告同一场景连续拍摄的照片仍被保留多张，同一主体（人物/动物/水下生物）的相似照片没有被合并，AI 似乎没有真正参与相似组选优。

经代码分析确认，核心缺陷是 VLM provider 配置不兼容：用户使用 `OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL` 配置 AI，但 `vlmClient.ts` 只识别 `DASHSCOPE_API_KEY`、`ANTHROPIC_API_KEY` 和 AWS Bedrock 凭证。`isVLMAvailable()` 返回 `false`，导致依赖 vlmClient 的 VLM 阶段被静默跳过。

### 修复范围

本次只修 AI 相似照片去重链路，不改前端、不改视频处理、不改上传逻辑、不改 P12 orchestrator。

**优先级：**
1. **Must Fix**：修复 OpenAI-compatible VLM provider 识别和调用
2. **Must Fix**：增加 VLM 跳过/失败/调用次数的结构化日志
3. **Must Fix**：确认 sceneDedup 能真实调用 VLM
4. **Should Fix**：恢复全局相似分组入口，复用现有 worker/pipeline，不新增独立大框架
5. **Should Fix**：相似分组阈值可配置，区分强相似与灰区候选

**不在本次修复范围内：**
- 前端 UI 变更
- 视频处理逻辑
- P12 orchestrator 重构
- 幻灯片生成

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN 用户配置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 环境变量时 THEN `vlmClient.ts` 的 `isVLMAvailable()` 返回 `false`，依赖该 vlmClient 的 VLM 阶段被静默跳过（至少包括 sceneDedup；如 aiReview 使用同一 client，也会同步受影响），无任何错误日志提示配置不匹配

1.2 WHEN VLM 实际未被调用时 THEN 系统没有明确的结构化日志输出说明"VLM 未调用"的原因（是 key 缺失、provider 不匹配、还是 ML 服务不可用），用户无法诊断问题

1.3 WHEN 用户使用 OpenAI 兼容 API（如 vLLM、Ollama、LiteLLM、或将 DashScope 配置为 OpenAI 兼容端点）时 THEN 无法通过任何现有环境变量配置让 vlmClient 识别该 provider

1.4 WHEN trip 中存在同一主体/同一场景的相似照片时 THEN 全局相似分组（Phase 1 smartCuration）已从 pipeline 中禁用（`void runSmartCuration`），这些照片不会被归入同一 group 进行 VLM 选优，仅依赖 sceneDedup 的 batch 内比较

1.5 WHEN sceneDedup 阶段运行但 ML 服务不可用时 THEN boundary merging 完全退化为固定大小 batch 切分，相邻的相似照片可能被分到不同 batch 中，VLM 无法看到它们之间的关系

### Expected Behavior (Correct)

2.1 WHEN 用户配置 `OPENAI_API_KEY` + `OPENAI_MODEL`，且可选配置 `OPENAI_BASE_URL`（或设置 `SMART_CURATION_VLM_PROVIDER=openai`）时 THEN vlmClient SHALL 将其识别为有效的 VLM provider（OpenAI 兼容模式），`isVLMAvailable()` SHALL 返回 `true`，依赖 vlmClient 的阶段 SHALL 正常执行。若 `OPENAI_BASE_URL` 未设置则使用 OpenAI SDK 默认 baseURL；若设置则使用自定义端点。调用时 SHALL 使用 OpenAI SDK 的 chat.completions 接口，支持 image_url/base64 格式的图片输入

2.2 WHEN VLM 调用被跳过或失败时 THEN 系统 SHALL 输出结构化日志，明确说明跳过原因，包括：当前 provider 配置、哪些环境变量已设置/未设置（仅输出 set/unset 状态，禁止输出 API key、token、secret 的真实内容）、跳过的具体阶段名称（例如 `[vlmClient] VLM unavailable: provider=openai, OPENAI_API_KEY=unset` 或 `[sceneDedup] VLM skipped: isVLMAvailable()=false, configured provider=dashscope, DASHSCOPE_API_KEY=unset`）

2.3 WHEN VLM 被成功调用时 THEN 系统 SHALL 记录每次调用的 provider、model、batch size、响应是否可解析，以及整个阶段的汇总统计（调用次数、成功次数、失败次数、总耗时）

2.4 WHEN 配置的 OpenAI 兼容端点不支持 vision（图片输入）时 THEN 系统 SHALL 在首次调用失败后记录明确的错误日志提示"endpoint may not support vision/image input"，而不是静默 fallback 后让用户困惑

2.5 WHEN 当前代码中已有可复用的 smartCuration / embedding / Union-Find 分组能力时 THEN 系统 SHOULD 低风险恢复全局相似分组入口，复用现有 pipeline 和 worker。如果本次恢复全局相似分组，则相似阈值 SHALL 可配置且分层：强相似（默认 ≥ 0.92）直接归组，灰区候选（默认 0.88~0.92）进入 VLM 复核，低于下限不自动合并。VLM SHALL 只在 group 内做最终组选优。如果恢复会引入大范围重构，则本次只需补充 TODO 注释、诊断日志和集成测试，避免重写整套 pipeline

2.6 WHEN sceneDedup 阶段运行且 ML embedding 服务不可用时 THEN 系统 SHALL 尝试使用 pHash/dHash 信号作为弱兜底辅助 boundary merging（仅用于判断相邻照片是否为同一场景的近似信号），并在日志中明确标注"degraded mode: hash-based boundary merging"

2.7 WHEN 解析 VLM provider 时 THEN 系统 SHALL 使用以下优先级：
  1. 如果 `SMART_CURATION_VLM_PROVIDER` 显式设置，则严格使用该 provider：`openai` / `dashscope` / `anthropic` / `bedrock`
  2. 如果未显式设置 provider，则按兼容旧行为优先自动探测：DashScope → Anthropic → Bedrock → OpenAI-compatible
  3. 如果用户希望强制使用 OpenAI-compatible，即使同时存在 DashScope key，也必须设置 `SMART_CURATION_VLM_PROVIDER=openai`
  4. 自动探测结果必须输出日志，包含最终选定的 provider 名称和各 env 的 set/unset 状态，不能打印 secret 原文

### Unchanged Behavior (Regression Prevention)

3.1 WHEN 用户配置 `DASHSCOPE_API_KEY` 且 `SMART_CURATION_VLM_PROVIDER=dashscope`（或未设置 provider）时 THEN 系统 SHALL CONTINUE TO 使用 DashScope 端点调用 qwen-vl-max

3.2 WHEN 用户配置 `ANTHROPIC_API_KEY` 且 `SMART_CURATION_VLM_PROVIDER=anthropic` 时 THEN 系统 SHALL CONTINUE TO 使用 Anthropic SDK 调用 Claude

3.3 WHEN 用户配置 AWS Bedrock 凭证且 `SMART_CURATION_VLM_PROVIDER=bedrock` 时 THEN 系统 SHALL CONTINUE TO 使用 Bedrock 客户端调用模型

3.4 WHEN VLM 调用失败或返回不可解析的响应时 THEN 系统 SHALL CONTINUE TO 保守回退（keep all photos in the failed batch），不因 AI 失败而误删照片

3.5 WHEN 照片被 AI 标记为 trash 时 THEN 系统 SHALL CONTINUE TO 仅执行 soft delete（设置 `status='trashed'` + `trashed_reason`），不物理删除文件，`file_path` 保持不变

3.6 WHEN 用户手动 override 照片状态（如恢复已删除照片）时 THEN 系统 SHALL CONTINUE TO 尊重用户 override，后续自动精选不覆盖用户决定

3.7 WHEN 单张照片处理失败或单个 batch 的 VLM 调用失败时 THEN 系统 SHALL CONTINUE TO 不影响整个 trip 的处理流程，pipeline 继续执行后续阶段

## Acceptance Criteria

- 配置 `OPENAI_API_KEY` + `OPENAI_MODEL` 后，`isVLMAvailable()` 返回 `true`
- 配置 `OPENAI_BASE_URL` 后，OpenAI SDK 使用该 baseURL 作为端点
- 未配置任何 VLM provider 时，sceneDedup 输出明确的 skipped reason 日志
- VLM 调用成功时，日志包含 provider / model / batchSize / call count / parse result
- VLM 调用失败或返回非法 JSON 时，保持 keep all，不误删任何照片
- 日志中不打印任何 API key 原文，只打印 set/unset 状态
- DashScope / Anthropic / Bedrock 原有 provider 的测试不回归
- 使用 mock OpenAI-compatible client 测试 sceneDedup 确实会调用 VLM
- 覆盖 provider 选择优先级测试：显式 `SMART_CURATION_VLM_PROVIDER=openai` 优先于自动探测；未设置 provider 时保持 DashScope 旧默认优先级
- typecheck / lint / test 全部通过
- 不修改 `client/` 目录下的任何文件
