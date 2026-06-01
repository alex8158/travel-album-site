# AI 相似照片去重修复 — 技术设计

## Overview

本次修复的核心问题是 `vlmClient.ts` 不识别 OpenAI-compatible provider（`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`），导致 `isVLMAvailable()` 返回 `false`，所有依赖 VLM 的阶段（sceneDedup、aiReview）被静默跳过，AI 去重形同虚设。

修复策略：
1. 在 `vlmClient.ts` 中新增 `openai` provider，支持 OpenAI SDK 的 chat.completions 接口（含 vision/image_url）
2. 实现分层 provider 解析优先级：显式 `SMART_CURATION_VLM_PROVIDER` > 自动探测（DashScope → Anthropic → Bedrock → OpenAI-compatible）
3. 增加结构化诊断日志，覆盖 VLM 可用性判断、每次调用、失败原因
4. 低风险恢复全局相似分组入口（复用现有 `runSmartCuration` + `similarityGrouper`），配置分层阈值
5. sceneDedup 的 boundary merging 在 ML 不可用时使用 pHash/dHash 弱信号兜底

## Glossary

- **Bug_Condition (C)**: 用户配置了 `OPENAI_API_KEY` + `OPENAI_MODEL`，但 `isVLMAvailable()` 返回 `false`，VLM 阶段被跳过
- **Property (P)**: 配置 OpenAI-compatible 环境变量后，VLM 阶段正常执行，sceneDedup 真实调用 VLM 进行去重选优
- **Preservation**: DashScope / Anthropic / Bedrock 原有 provider 行为不变；VLM 失败时保守回退（keep all）；soft delete 语义不变
- **vlmClient**: `server/src/services/smartCuration/vlmClient.ts` — 统一的 provider 无关 VLM 调用接口
- **sceneDedup**: `server/src/services/smartCuration/sceneDedup.ts` — 基于场景的跨照片去重阶段
- **smartCurationEngine**: `server/src/services/smartCuration/smartCurationEngine.ts` — 全局相似分组 + VLM 选优引擎
- **similarityGrouper**: `server/src/services/smartCuration/similarityGrouper.ts` — DINOv2 + pHash/dHash 相似分组（Union-Find）
- **boundary merging**: sceneDedup 中利用 embedding 余弦相似度将相邻相似照片合并到同一 batch 的机制

## Bug Details

### Bug Condition

当用户使用 OpenAI 兼容 API（如 vLLM、Ollama、LiteLLM、或将 DashScope 配置为 OpenAI 兼容端点）时，`vlmClient.ts` 的 `getActiveProvider()` 只识别 `'anthropic' | 'dashscope' | 'bedrock'` 三种值，未设置 `SMART_CURATION_VLM_PROVIDER` 时默认回退到 `'dashscope'`，而 `isVLMAvailable()` 检查 `DASHSCOPE_API_KEY` 是否存在——用户只配置了 `OPENAI_API_KEY`，因此返回 `false`。

**Formal Specification:**
```
FUNCTION isBugCondition(env)
  INPUT: env of type EnvironmentVariables
  OUTPUT: boolean
  
  RETURN env.OPENAI_API_KEY IS SET
         AND env.OPENAI_MODEL IS SET
         AND (env.SMART_CURATION_VLM_PROVIDER IS UNSET OR env.SMART_CURATION_VLM_PROVIDER = 'openai')
         AND env.DASHSCOPE_API_KEY IS UNSET
         AND env.ANTHROPIC_API_KEY IS UNSET
         AND NOT (env.AWS_ACCESS_KEY_ID IS SET AND env.AWS_SECRET_ACCESS_KEY IS SET)
         AND isVLMAvailable() = false  // 当前代码的实际返回值
END FUNCTION
```

### Examples

- 用户配置 `OPENAI_API_KEY=sk-xxx` + `OPENAI_MODEL=gpt-4o` → `getActiveProvider()` 返回 `'dashscope'`（默认值）→ `isVLMAvailable()` 检查 `DASHSCOPE_API_KEY` → 未设置 → 返回 `false` → sceneDedup 输出 "No VLM provider configured — skipping scene dedup" → **照片不去重**
- 用户配置 `OPENAI_API_KEY=sk-xxx` + `OPENAI_BASE_URL=http://localhost:8000/v1` + `OPENAI_MODEL=qwen-vl-max` → 同上，VLM 被跳过
- 用户配置 `SMART_CURATION_VLM_PROVIDER=openai` + `OPENAI_API_KEY=sk-xxx` → `getActiveProvider()` 打印 warning "not recognised; using 'dashscope'" → 同上
- 用户同时配置 `DASHSCOPE_API_KEY` + `OPENAI_API_KEY`，希望用 OpenAI → 无法强制选择 OpenAI provider

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `DASHSCOPE_API_KEY` 配置时，DashScope provider 继续使用 qwen-vl-max，调用路径不变
- `ANTHROPIC_API_KEY` 配置时，Anthropic provider 继续使用 Claude，调用路径不变
- AWS Bedrock 凭证配置时，Bedrock provider 继续使用 `createBedrockClient()`，调用路径不变
- VLM 调用失败或返回不可解析 JSON 时，保守回退 keep all，不误删照片
- 照片被 trash 时仅执行 soft delete（`status='trashed'` + `trashed_reason`），`file_path` 不变
- 用户手动 override 照片状态后，后续自动精选不覆盖用户决定
- 单 batch 失败不影响整个 trip 的 pipeline 执行

**Scope:**
所有不涉及 OpenAI-compatible provider 识别的输入路径应完全不受本次修复影响。

## Hypothesized Root Cause

基于代码分析，确认的根因如下：

1. **Provider 类型缺失**: `VLMProvider` 类型定义为 `'anthropic' | 'dashscope' | 'bedrock'`，不包含 `'openai'`。`getActiveProvider()` 对 `'openai'` 值打印 warning 并回退到 `'dashscope'`

2. **凭证检查不匹配**: `isVLMAvailable()` 的 switch 分支只检查三种 provider 的凭证，没有 `OPENAI_API_KEY` 的检查路径

3. **无自动探测逻辑**: 当 `SMART_CURATION_VLM_PROVIDER` 未设置时，直接默认 `'dashscope'`，没有按优先级探测哪个 provider 的凭证实际存在

4. **无诊断日志**: `isVLMAvailable()` 返回 `false` 时，sceneDedup 只输出一行 generic warning，不说明具体是哪个 provider、哪个 env var 缺失

5. **全局相似分组被禁用**: `runSmartCuration` 在 pipeline 中被 `void` 跳过，仅依赖 sceneDedup 的 batch 内比较，跨 batch 的相似照片无法被发现

6. **boundary merging 无 hash 兜底**: 当 ML embedding 不可用时，sceneDedup 退化为固定大小 batch，相邻相似照片可能被分到不同 batch

## Correctness Properties

Property 1: Bug Condition - OpenAI-compatible VLM Provider 识别与调用

_For any_ 环境配置中 `OPENAI_API_KEY` 和 `OPENAI_MODEL` 已设置（且 `SMART_CURATION_VLM_PROVIDER` 未设置或为 `'openai'`），修复后的 `isVLMAvailable()` SHALL 返回 `true`，且 `callVLM()` SHALL 使用 OpenAI SDK 的 `chat.completions.create` 接口发送请求，支持 `image_url` 格式的图片输入。

**Validates: Requirements 2.1, 2.7**

Property 2: Preservation - 原有 Provider 行为不变

_For any_ 环境配置中仅设置了 `DASHSCOPE_API_KEY`（或 `ANTHROPIC_API_KEY`、或 AWS Bedrock 凭证），且 `OPENAI_API_KEY` 未设置，修复后的 `getActiveProvider()` 和 `callVLM()` SHALL 产生与修复前完全相同的行为，包括 provider 选择、model 解析、SDK 调用方式。

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

## Fix Implementation

### Changes Required

假设根因分析正确（已通过代码确认）：

**File**: `server/src/services/smartCuration/vlmClient.ts`

**Changes**:

1. **扩展 VLMProvider 类型**: 添加 `'openai'` 到 union type
   ```typescript
   export type VLMProvider = 'anthropic' | 'dashscope' | 'bedrock' | 'openai';
   ```

2. **重写 `getActiveProvider()` — 分层解析逻辑**:
   - 如果 `SMART_CURATION_VLM_PROVIDER` 显式设置且为有效值（`openai` / `dashscope` / `anthropic` / `bedrock`），严格使用该 provider
   - 如果未设置，按优先级自动探测：
     1. `DASHSCOPE_API_KEY` 存在 → `'dashscope'`（兼容旧行为）
     2. `ANTHROPIC_API_KEY` 存在 → `'anthropic'`
     3. AWS Bedrock 凭证存在 → `'bedrock'`
     4. `OPENAI_API_KEY` 存在 → `'openai'`
   - 输出结构化日志：最终选定的 provider、各 env 的 set/unset 状态（不打印 secret 原文）

3. **扩展 `isVLMAvailable()`**: 添加 `case 'openai'` 分支，检查 `OPENAI_API_KEY` 是否存在

4. **扩展 `getActiveModel()`**: 添加 `case 'openai'` 分支，读取 `OPENAI_MODEL` 环境变量（无默认值，必须显式配置）

5. **新增 OpenAI provider 实现**:
   ```typescript
   let openaiClient: OpenAI | null = null;

   function getOpenAIClient(): OpenAI {
     if (openaiClient) return openaiClient;
     const apiKey = process.env.OPENAI_API_KEY;
     if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is required');
     openaiClient = new OpenAI({
       apiKey,
       baseURL: process.env.OPENAI_BASE_URL || undefined, // undefined = SDK 默认
       timeout: readTimeoutMs(),
     });
     return openaiClient;
   }

   async function callOpenAI(req: VLMRequest): Promise<VLMResponse> {
     const client = getOpenAIClient();
     const model = process.env.OPENAI_MODEL;
     if (!model) throw new Error('OPENAI_MODEL environment variable is required for openai provider');
     // 构建 content: image_url + text，与 callDashscope 结构相同
     // ...
   }
   ```

6. **扩展 `callVLM()` switch**: 添加 `case 'openai': return callOpenAI(req);`

7. **增加结构化诊断日志**:
   - `getActiveProvider()` 解析完成后输出：`[vlmClient] Provider resolved: provider=${name}, method=${explicit|auto-detect}, env: DASHSCOPE_API_KEY=${set|unset}, ANTHROPIC_API_KEY=${set|unset}, ...`
   - `callVLM()` 每次调用后输出：`[vlmClient] VLM call: provider=${p}, model=${m}, images=${n}, responseLength=${len}, parseable=${bool}`
   - `callVLM()` 失败时输出：`[vlmClient] VLM call failed: provider=${p}, model=${m}, error=${msg}`
   - 首次调用失败且错误信息包含 vision/image 相关关键词时：`[vlmClient] WARNING: endpoint may not support vision/image input`

8. **扩展 `_resetVLMClientCacheForTests()`**: 添加 `openaiClient = null;`

---

**File**: `server/src/services/smartCuration/sceneDedup.ts`

**Function**: `tryGetEmbeddings` / `buildSmartBatches`

**Changes**:

1. **pHash/dHash 兜底 boundary merging**: 当 `isMLServiceAvailable()` 返回 `false` 时，不直接返回 `null`，而是尝试计算 pHash/dHash，利用 hamming distance 作为弱相似信号辅助 boundary merging
   - 复用 `similarityGrouper.ts` 中已有的 `computeHashes()` 和 `hammingToSimilarity()` 逻辑
   - 阈值设为较高值（如 0.90）以减少误合并
   - 日志标注 "degraded mode: hash-based boundary merging"

2. **增强 VLM 跳过日志**: `isVLMAvailable()` 返回 `false` 时，输出具体的 provider 配置和 env 状态

3. **增加阶段汇总统计日志**: 完成后输出 VLM 调用次数、成功次数、失败次数、总耗时

---

**File**: `server/src/services/pipeline/runTripProcessingPipeline.ts`

**Changes**:

1. **恢复全局相似分组入口**: 将 `void runSmartCuration;` 替换为条件调用：
   - 仅当 `SMART_CURATION_GLOBAL_GROUPING=true`（默认 `false`，低风险）时执行
   - 复用现有 `runSmartCuration()` 函数，不新增独立框架
   - 在 sceneDedup 之前执行（先全局分组去重，再 batch 内场景去重）

2. **分层阈值配置**: 通过环境变量控制
   - `SMART_CURATION_EXACT_THRESHOLD`（默认 0.94）
   - `SMART_CURATION_NEAR_THRESHOLD`（默认 0.88）— 灰区下限
   - `SMART_CURATION_STRONG_THRESHOLD`（默认 0.92）— 强相似直接归组

---

**File**: `server/src/services/smartCuration/similarityGrouper.ts`

**Changes**（仅当恢复全局分组时）:

1. **分层阈值支持**: 区分强相似（≥ 0.92 直接归组）和灰区候选（0.88~0.92 进入 VLM 复核）
2. 如果本次恢复会引入大范围重构，则仅补充 TODO 注释和诊断日志

## Testing Strategy

### Validation Approach

测试策略分两阶段：先在未修复代码上验证 bug 确实存在（counterexample），再验证修复后行为正确且不回归。

### Exploratory Bug Condition Checking

**Goal**: 在未修复代码上确认 bug 存在，验证根因分析。

**Test Plan**: 设置 `OPENAI_API_KEY` + `OPENAI_MODEL` 环境变量，调用 `isVLMAvailable()` 和 `getActiveProvider()`，断言返回值与预期不符。

**Test Cases**:
1. **Provider 不识别**: 设置 `SMART_CURATION_VLM_PROVIDER=openai`，调用 `getActiveProvider()` → 预期返回 `'dashscope'`（bug 行为）
2. **VLM 不可用**: 仅设置 `OPENAI_API_KEY`，调用 `isVLMAvailable()` → 预期返回 `false`（bug 行为）
3. **sceneDedup 跳过**: mock VLM client，运行 sceneDedup → 预期 `vlmCallsMade = 0`（bug 行为）
4. **无诊断日志**: 检查 console 输出，预期无结构化 provider 信息（bug 行为）

**Expected Counterexamples**:
- `getActiveProvider()` 对 `'openai'` 值打印 warning 并回退到 `'dashscope'`
- `isVLMAvailable()` 在只有 `OPENAI_API_KEY` 时返回 `false`

### Fix Checking

**Goal**: 验证修复后，所有满足 bug condition 的输入都产生正确行为。

**Pseudocode:**
```
FOR ALL env WHERE isBugCondition(env) DO
  result := isVLMAvailable_fixed(env)
  ASSERT result = true
  
  provider := getActiveProvider_fixed(env)
  ASSERT provider = 'openai'
  
  response := callVLM_fixed(mockRequest)
  ASSERT response.provider = 'openai'
  ASSERT response.model = env.OPENAI_MODEL
END FOR
```

### Preservation Checking

**Goal**: 验证修复后，所有不满足 bug condition 的输入（原有 provider 配置）行为不变。

**Pseudocode:**
```
FOR ALL env WHERE NOT isBugCondition(env) DO
  ASSERT getActiveProvider_original(env) = getActiveProvider_fixed(env)
  ASSERT isVLMAvailable_original(env) = isVLMAvailable_fixed(env)
  ASSERT callVLM_original(env, req) = callVLM_fixed(env, req)
END FOR
```

**Testing Approach**: Property-based testing 适合 preservation checking，因为：
- 可自动生成多种环境变量组合（DashScope only、Anthropic only、Bedrock only、混合配置）
- 能覆盖边界情况（如同时设置多个 provider 的 key）
- 强保证原有行为在所有非 bug 输入下不变

**Test Plan**: 先在未修复代码上观察各 provider 的行为基线，再编写 property-based test 验证修复后行为一致。

**Test Cases**:
1. **DashScope Preservation**: 仅设置 `DASHSCOPE_API_KEY`，验证 provider 选择和 SDK 调用路径不变
2. **Anthropic Preservation**: 仅设置 `ANTHROPIC_API_KEY` + `SMART_CURATION_VLM_PROVIDER=anthropic`，验证行为不变
3. **Bedrock Preservation**: 设置 AWS 凭证 + `SMART_CURATION_VLM_PROVIDER=bedrock`，验证行为不变
4. **Fallback Preservation**: VLM 调用失败时，验证 keep all 行为不变
5. **Priority Preservation**: 同时设置 `DASHSCOPE_API_KEY` + `OPENAI_API_KEY`，未设置 provider → 验证 DashScope 优先（兼容旧行为）

### Unit Tests

- `getActiveProvider()` 对所有有效 provider 值的返回值测试
- `getActiveProvider()` 自动探测优先级测试（多种 env 组合）
- `isVLMAvailable()` 对每种 provider 的凭证检查测试
- `callOpenAI()` 使用 mock OpenAI SDK 的请求构建和响应解析测试
- `callOpenAI()` 对不支持 vision 的端点的错误处理测试
- 结构化日志输出格式验证（不含 secret 原文）
- sceneDedup hash-based boundary merging 的 batch 划分测试
- provider 解析日志中 env 状态只显示 set/unset 不显示值

### Property-Based Tests

- 生成随机环境变量组合，验证 `getActiveProvider()` 的优先级规则一致性
- 生成随机 provider + 凭证组合，验证 `isVLMAvailable()` 返回值与凭证存在性的对应关系
- 生成随机 batch 配置 + embedding/hash 数据，验证 `buildSmartBatches()` 的 batch 划分满足不变量（每个 candidate 恰好出现一次、batch 大小在 [1, maxBatch] 范围内）
- 对原有 provider（DashScope/Anthropic/Bedrock），验证修复前后 `callVLM` 的请求构建逻辑等价

### Integration Tests

- 使用 mock OpenAI-compatible server，端到端运行 sceneDedup，验证 VLM 确实被调用
- 验证 pipeline 中 smartCuration（全局分组）+ sceneDedup 的串联执行
- 验证 VLM 调用失败时的 graceful degradation（keep all + 日志输出）
- 验证 `SMART_CURATION_GLOBAL_GROUPING=true` 时全局分组正确执行
- typecheck / lint / 全量测试通过
