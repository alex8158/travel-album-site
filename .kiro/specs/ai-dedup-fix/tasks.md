# Implementation Plan

## Overview

修复 AI 相似照片去重功能中 OpenAI-compatible VLM Provider 不被识别的 bug。采用 bug condition 方法论：先编写探索性测试确认 bug 存在，再编写 preservation 测试捕获基线行为，然后实施修复并验证。

## Tasks

- [x] 1. 编写 Bug Condition 探索性测试（修复前）
  - **Property 1: Bug Condition** - OpenAI-compatible VLM Provider 不被识别
  - **CRITICAL**: 此测试必须在未修复代码上 FAIL — 失败即确认 bug 存在
  - **DO NOT** 在测试失败时尝试修复测试或代码
  - **NOTE**: 此测试编码了期望行为 — 修复后通过即验证 fix 正确
  - **GOAL**: 产生 counterexample 证明 bug 存在
  - **Scoped PBT Approach**: 将 property 限定到具体失败场景：设置 `OPENAI_API_KEY` + `OPENAI_MODEL`，未设置其他 provider key
  - 测试文件：`server/src/services/smartCuration/__tests__/vlmClient.bugCondition.test.ts`
  - 测试场景 1：设置 `SMART_CURATION_VLM_PROVIDER=openai` + `OPENAI_API_KEY=sk-test`，调用 `getActiveProvider()` → 断言应返回 `'openai'`（Bug Condition 中实际返回 `'dashscope'`）
  - 测试场景 2：仅设置 `OPENAI_API_KEY=sk-test` + `OPENAI_MODEL=gpt-4o`，调用 `isVLMAvailable()` → 断言应返回 `true`（Bug Condition 中实际返回 `false`）
  - 测试场景 3：使用 property-based testing 生成随机 `OPENAI_API_KEY` + `OPENAI_MODEL` 组合（其他 provider key 均 unset），断言 `isVLMAvailable()` 始终返回 `true`
  - 在未修复代码上运行测试
  - **EXPECTED OUTCOME**: 测试 FAIL（这是正确的 — 证明 bug 存在）
  - 记录 counterexample：`getActiveProvider()` 对 `'openai'` 值打印 warning 并回退到 `'dashscope'`；`isVLMAvailable()` 在只有 `OPENAI_API_KEY` 时返回 `false`
  - 测试编写完成、运行完成、失败已记录后标记任务完成
  - _Requirements: 1.1, 1.3, 2.1, 2.7_

- [x] 2. 编写 Preservation 属性测试（修复前）
  - **Property 2: Preservation** - 原有 Provider 行为不变
  - **IMPORTANT**: 遵循 observation-first 方法论
  - 测试文件：`server/src/services/smartCuration/__tests__/vlmClient.preservation.test.ts`
  - 观察：在未修复代码上，仅设置 `DASHSCOPE_API_KEY` → `getActiveProvider()` 返回 `'dashscope'`，`isVLMAvailable()` 返回 `true`
  - 观察：在未修复代码上，仅设置 `ANTHROPIC_API_KEY` + `SMART_CURATION_VLM_PROVIDER=anthropic` → `getActiveProvider()` 返回 `'anthropic'`，`isVLMAvailable()` 返回 `true`
  - 观察：在未修复代码上，设置 AWS 凭证 + `SMART_CURATION_VLM_PROVIDER=bedrock` → `getActiveProvider()` 返回 `'bedrock'`，`isVLMAvailable()` 返回 `true`
  - 观察：在未修复代码上，同时设置 `DASHSCOPE_API_KEY` + `OPENAI_API_KEY`，未设置 provider → DashScope 优先
  - 编写 property-based test：对所有非 bug condition 的环境变量组合（`DASHSCOPE_API_KEY` set / `ANTHROPIC_API_KEY` set / AWS 凭证 set），验证 `getActiveProvider()` 和 `isVLMAvailable()` 返回值与观察基线一致
  - 编写 property-based test：VLM 调用失败时，验证 keep all 行为不变（不误删照片）
  - 编写 property-based test：soft delete 语义不变（`status='trashed'` + `trashed_reason`，`file_path` 不变）
  - 在未修复代码上运行测试
  - **EXPECTED OUTCOME**: 测试 PASS（确认基线行为已被正确捕获）
  - 测试编写完成、运行完成、在未修复代码上通过后标记任务完成
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 3. 修复 AI 相似照片去重 — OpenAI-compatible VLM Provider 支持

  - [x] 3.1 扩展 VLMProvider 类型并重写 getActiveProvider()
    - 在 `server/src/services/smartCuration/vlmClient.ts` 中将 `VLMProvider` 类型扩展为 `'anthropic' | 'dashscope' | 'bedrock' | 'openai'`
    - 重写 `getActiveProvider()` 实现分层解析逻辑：
      - 显式 `SMART_CURATION_VLM_PROVIDER` 设置且为有效值 → 严格使用该 provider
      - 未设置时按优先级自动探测：DashScope → Anthropic → Bedrock → OpenAI-compatible
    - 输出结构化诊断日志：最终选定 provider、解析方式（explicit/auto-detect）、各 env 的 set/unset 状态（禁止打印 secret 原文）
    - _Bug_Condition: isBugCondition(env) where OPENAI_API_KEY set AND OPENAI_MODEL set AND other providers unset → isVLMAvailable() = false_
    - _Expected_Behavior: getActiveProvider() returns 'openai' when OPENAI_API_KEY is set and no higher-priority provider configured_
    - _Preservation: DashScope/Anthropic/Bedrock 原有 provider 选择逻辑不变；未设置 provider 时 DashScope 仍为最高优先级_
    - _Requirements: 2.1, 2.7, 3.1, 3.2, 3.3_

  - [x] 3.2 扩展 isVLMAvailable() 和 getActiveModel()
    - 在 `isVLMAvailable()` 中添加 `case 'openai'` 分支，检查 `OPENAI_API_KEY` 是否存在
    - 在 `getActiveModel()` 中添加 `case 'openai'` 分支，读取 `OPENAI_MODEL` 环境变量（无默认值，必须显式配置）
    - _Bug_Condition: isVLMAvailable() 的 switch 无 'openai' case → 返回 false_
    - _Expected_Behavior: isVLMAvailable() 在 OPENAI_API_KEY 存在时返回 true_
    - _Preservation: 其他 provider 的 case 分支不变_
    - _Requirements: 2.1, 3.1, 3.2, 3.3_

  - [x] 3.3 实现 callOpenAI() 并扩展 callVLM()
    - 新增 `getOpenAIClient()` 函数：使用 OpenAI SDK，支持 `OPENAI_BASE_URL` 自定义端点
    - 新增 `callOpenAI(req: VLMRequest): Promise<VLMResponse>` 函数：
      - 使用 `chat.completions.create` 接口
      - 支持 `image_url` 格式的图片输入（base64 或 URL）
      - 读取 `OPENAI_MODEL` 环境变量作为 model 参数
    - 在 `callVLM()` switch 中添加 `case 'openai': return callOpenAI(req);`
    - 扩展 `_resetVLMClientCacheForTests()` 添加 `openaiClient = null;`
    - _Bug_Condition: callVLM() 无 'openai' case → 无法调用 OpenAI-compatible 端点_
    - _Expected_Behavior: callVLM() 使用 OpenAI SDK chat.completions 接口发送请求，支持 image_url 格式_
    - _Preservation: 其他 provider 的 callVLM 路径不变_
    - _Requirements: 2.1, 2.4, 3.4_

  - [x] 3.4 增加结构化诊断日志
    - `getActiveProvider()` 解析完成后输出：`[vlmClient] Provider resolved: provider=${name}, method=${explicit|auto-detect}, env: DASHSCOPE_API_KEY=${set|unset}, ...`
    - `callVLM()` 每次调用后输出：`[vlmClient] VLM call: provider=${p}, model=${m}, images=${n}, responseLength=${len}, parseable=${bool}`
    - `callVLM()` 失败时输出：`[vlmClient] VLM call failed: provider=${p}, model=${m}, error=${msg}`
    - 首次调用失败且错误信息包含 vision/image 关键词时：`[vlmClient] WARNING: endpoint may not support vision/image input`
    - sceneDedup 阶段完成后输出汇总统计：VLM 调用次数、成功次数、失败次数、总耗时
    - 日志中禁止打印任何 API key / token / secret 原文，仅输出 set/unset 状态
    - _Requirements: 2.2, 2.3, 2.4_

  - [x] 3.5 sceneDedup pHash/dHash 兜底 boundary merging
    - 在 `server/src/services/smartCuration/sceneDedup.ts` 中修改 `tryGetEmbeddings` / `buildSmartBatches`
    - 当 `isMLServiceAvailable()` 返回 `false` 时，尝试计算 pHash/dHash
    - 复用 `similarityGrouper.ts` 中已有的 `computeHashes()` 和 `hammingToSimilarity()` 逻辑
    - 使用 hamming distance 作为弱相似信号辅助 boundary merging，阈值设为 0.90（减少误合并）
    - 日志标注 "degraded mode: hash-based boundary merging"
    - _Requirements: 2.6_

  - [x] 3.6 恢复全局相似分组入口（条件性启用）
    - 在 `server/src/services/pipeline/runTripProcessingPipeline.ts` 中将 `void runSmartCuration;` 替换为条件调用
    - 仅当 `SMART_CURATION_GLOBAL_GROUPING=true`（默认 `false`，低风险）时执行
    - 复用现有 `runSmartCuration()` 函数，不新增独立框架
    - 在 sceneDedup 之前执行（先全局分组去重，再 batch 内场景去重）
    - 分层阈值通过环境变量控制：`SMART_CURATION_EXACT_THRESHOLD`（默认 0.94）、`SMART_CURATION_NEAR_THRESHOLD`（默认 0.88）、`SMART_CURATION_STRONG_THRESHOLD`（默认 0.92）
    - _Requirements: 2.5_

  - [x] 3.7 验证 Bug Condition 探索性测试现在通过
    - **Property 1: Expected Behavior** - OpenAI-compatible VLM Provider 正确识别与调用
    - **IMPORTANT**: 重新运行任务 1 中的同一测试 — 不要编写新测试
    - 任务 1 中的测试编码了期望行为
    - 当此测试通过时，确认期望行为已满足
    - 运行 `server/src/services/smartCuration/__tests__/vlmClient.bugCondition.test.ts`
    - **EXPECTED OUTCOME**: 测试 PASS（确认 bug 已修复）
    - _Requirements: 2.1, 2.7_

  - [x] 3.8 验证 Preservation 测试仍然通过
    - **Property 2: Preservation** - 原有 Provider 行为不变
    - **IMPORTANT**: 重新运行任务 2 中的同一测试 — 不要编写新测试
    - 运行 `server/src/services/smartCuration/__tests__/vlmClient.preservation.test.ts`
    - **EXPECTED OUTCOME**: 测试 PASS（确认无回归）
    - 确认修复后所有 preservation 测试仍然通过（无回归）
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 4. Checkpoint — 确保所有测试通过
  - 运行 `npx vitest --run` 确保全量测试通过
  - 运行 `npx tsc --noEmit` 确保 typecheck 通过
  - 运行 lint 检查确保代码风格一致
  - 确认不修改 `client/` 目录下的任何文件
  - 如有问题，询问用户

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2"] },
    { "id": 1, "tasks": ["3.1"] },
    { "id": 2, "tasks": ["3.2", "3.4", "3.5", "3.6"] },
    { "id": 3, "tasks": ["3.3"] },
    { "id": 4, "tasks": ["3.7", "3.8"] },
    { "id": 5, "tasks": ["4"] }
  ]
}
```

## Notes

- 任务 1 和任务 2 可以并行执行，它们都在未修复代码上运行
- 任务 3.4、3.5、3.6 可以在 3.1 完成后并行执行
- 任务 3.7 和 3.8 必须在所有实现子任务完成后执行
- 所有测试使用 vitest 框架，property-based testing 使用 fast-check 库
- 修复范围严格限制在 `server/` 目录，不修改 `client/` 下任何文件
