# Video Editing Fixes Bugfix Design

## Overview

视频剪辑流程存在 5 个 bug，涵盖 ffmpeg filter 语法错误、过渡策略不当、音频处理路径缺失、片段选择逻辑缺陷、以及前端缺少处理进度显示。修复策略是逐一定位根因并做最小化修改，同时确保手动剪辑（Clip Editor）的 fade/crossfade 功能不受影响。

## Glossary

- **Bug_Condition (C)**: 触发 bug 的输入条件集合，包括 scale filter 语法、transitionType 为 'none' 时的音频处理路径、selectSegments 的 break 逻辑、以及前端 fire-and-forget 调用
- **Property (P)**: 修复后的期望行为——ffmpeg 正确执行、音频平滑、片段选择充分、前端显示进度
- **Preservation**: 手动剪辑 fade/crossfade 功能、短视频跳过合成、图片上传流程、无音频视频处理等不受影响
- **concatenateWithTransitions**: `videoEditor.ts` 中使用 filter graph 合成带过渡效果视频的函数
- **buildTransitionFilters**: `videoEditor.ts` 中根据 transitionType 构建 ffmpeg filter 字符串的函数
- **selectSegments**: `videoEditor.ts` 中基于质量评分贪心选择视频片段的函数
- **editVideo**: `videoEditor.ts` 中视频剪辑主入口函数，协调片段选择、稳定化、合成
- **processVideoAfterProxy**: `proxyGenerator.ts` 中代理生成后自动触发视频分析和剪辑的函数

## Bug Details

### Bug Condition

5 个 bug 在以下条件下触发：

1. **Scale filter 语法错误**: 当 `concatenateWithTransitions` 被调用且需要应用分辨率限制时，生成的 scale filter 字符串包含错位引号
2. **不当的 fade 过渡**: 当自动剪辑调用方（`proxyGenerator`）传递 `transitionType: 'fade'` 时，短片段几乎全在看淡入淡出
3. **'none' 模式跳过音频处理**: 当 `editVideo` 以默认 `transitionType: 'none'` 运行时，走 `concatenateSegments`（concat demuxer）路径，完全跳过音频 afade 处理
4. **selectSegments 提前退出**: 当某个片段会导致累计时长超过 `targetDuration * 1.1` 时，`break` 退出整个循环而非 `continue` 跳过该片段
5. **前端无进度显示**: `FileUploader` 以 fire-and-forget 方式调用 `POST /api/media/:id/process`，不监听返回结果

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { functionName, args, callerContext }
  OUTPUT: boolean

  // Bug 1: scale filter 语法
  IF input.functionName == 'concatenateWithTransitions'
     AND input.args.options?.videoResolution IS NOT NULL
     THEN RETURN TRUE  // 生成的 scaleFilter 字符串语法错误

  // Bug 2: 自动剪辑传 fade
  IF input.callerContext IN ['proxyGenerator.processVideoAfterProxy']
     AND input.args.options?.transitionType == 'fade'
     THEN RETURN TRUE

  // Bug 3: 'none' 模式跳过音频
  IF input.functionName == 'editVideo'
     AND (input.args.options?.transitionType ?? 'none') == 'none'
     AND segmentCount > 1
     AND videoHasAudio == TRUE
     THEN RETURN TRUE  // 走 concatenateSegments 跳过 afade

  // Bug 4: selectSegments break
  IF input.functionName == 'selectSegments'
     AND input.args.targetDuration IS NOT NULL
     AND EXISTS segment WHERE cumulative + segment.duration > targetDuration * 1.1
       AND EXISTS laterSegment WHERE cumulative + laterSegment.duration <= targetDuration * 1.1
     THEN RETURN TRUE  // break 导致后续短片段被跳过

  // Bug 5: 前端无进度
  IF input.callerContext == 'FileUploader.uploadFile'
     AND input.args.mediaType == 'video'
     THEN RETURN TRUE  // fire-and-forget 无进度反馈

  RETURN FALSE
END FUNCTION
```

### Examples

- **Bug 1**: `concatenateWithTransitions` 生成 `scale='min(1080,iw)':min'(1080,ih)':force_original_aspect_ratio=decrease`，ffmpeg 报 `Invalid option` 错误退出。期望生成 `scale='min(1080,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease`
- **Bug 2**: `proxyGenerator` 调用 `editVideo(..., { transitionType: 'fade' })`，1.5 秒的片段几乎全是淡入淡出效果。期望视频硬切，仅音频做短时 afade
- **Bug 3**: `editVideo` 以 `transitionType: 'none'` 运行 3 个片段的视频，走 `concatenateSegments` 路径，音频拼接处出现爆音。期望走 filter graph 路径对音频应用 ~100ms afade
- **Bug 4**: `selectSegments([10s, 8s, 3s, 2s, 1.5s], targetDuration=15)` 选中 10s 后，8s 会超过 16.5s 上限，`break` 退出，最终只选 10s。期望 `continue` 跳过 8s，继续选 3s+2s，总计 15s
- **Bug 5**: 用户上传视频后只看到上传进度条完成，不知道后端分析/剪辑状态。期望显示"处理中…"→"处理完成"或"处理失败"

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- 用户通过 Clip Editor UI（`POST /api/media/:id/clips`）手动指定 `transitionType: 'fade'` 或 `'crossfade'` 时，系统继续使用用户指定的过渡效果
- 原始视频时长 < 60 秒且全片质量良好时，继续保留原视频不做裁剪
- `selectSegments` 处理 `targetDuration === null` 的短视频时，继续返回所有通过质量过滤的片段
- 用户上传图片文件时，前端继续正常上传，不触发视频处理流程
- 视频不包含音频轨道时，系统继续正常拼接视频，不尝试应用音频 filter
- `mergeEngine.ts` 和 `clips.ts` 中的 merge/re-edit 路径不受影响

**Scope:**
不涉及键盘快捷键的输入、非视频类型的媒体处理、以及 Clip Editor UI 的手动剪辑流程，均不受此次修复影响。

## Hypothesized Root Cause

Based on the bug description, the most likely issues are:

1. **Scale Filter 引号错位** (`videoEditor.ts` L558):
   - 当前代码: `` scale='min(${maxRes},iw)':min'(${maxRes},ih)':force_original_aspect_ratio=decrease ``
   - `min'(...)' ` 中引号位置错误，应为 `'min(...)'`
   - 这是一个简单的字符串拼写错误

2. **proxyGenerator 硬编码 fade** (`proxyGenerator.ts` L149-150):
   - `processVideoAfterProxy` 中 `editVideo` 调用显式传递 `transitionType: 'fade'`
   - 应移除此参数，让 `editVideo` 使用默认值 `'none'`

3. **'none' 模式路径缺陷** (`videoEditor.ts` L521-528):
   - `editVideo` 中 `if (transitionType !== 'none')` 条件导致 `'none'` 模式直接走 `concatenateSegments`
   - `concatenateSegments` 使用 concat demuxer，不经过 filter graph，无法应用 afade
   - 修复: 当 `transitionType === 'none'` 且有音频且多片段时，仍需调用 `buildTransitionFilters` 获取音频 filter，然后走 `concatenateWithTransitions` 路径

4. **selectSegments break vs continue** (`videoEditor.ts` L104):
   - 外层循环中 `if (selected.length > 0 && cumulative + seg.duration > targetDuration * 1.1) break;`
   - `break` 退出整个循环，后续更短的片段不会被评估
   - 应改为 `continue` 跳过当前片段，继续检查后续片段

5. **FileUploader fire-and-forget** (`FileUploader.tsx` L109-112):
   - 视频上传成功后调用 `apiPost('/api/media/${id}/process')` 但不等待结果
   - 需要追踪 `POST /api/media/:id/process` 的响应状态，在 UI 上显示处理进度

## Correctness Properties

Property 1: Bug Condition - Scale Filter 语法正确性

_For any_ 调用 `concatenateWithTransitions` 且 `videoResolution` 不为空的输入，修复后的函数 SHALL 生成语法正确的 ffmpeg scale filter 字符串，使 ffmpeg 能正常解析和执行。

**Validates: Requirements 2.1**

Property 2: Bug Condition - 自动剪辑无视觉过渡

_For any_ 通过自动剪辑流程（proxyGenerator、mediaProcess、runTripProcessingPipeline）调用 `editVideo` 的输入，修复后 SHALL 不传递 `transitionType: 'fade'`，使用默认 `'none'` 实现视频硬切。

**Validates: Requirements 2.2**

Property 3: Bug Condition - 'none' 模式音频平滑

_For any_ `editVideo` 以 `transitionType: 'none'` 运行、视频包含音频轨道且有多个片段的输入，修复后 SHALL 走 filter graph 路径对音频拼接处应用 ~100ms afade，消除爆音。

**Validates: Requirements 2.2, 2.3**

Property 4: Bug Condition - selectSegments 不提前退出

_For any_ `selectSegments` 调用中某个片段会导致累计时长超过 `targetDuration * 1.1` 的输入，修复后 SHALL 跳过该片段（continue）而非退出循环（break），继续评估后续更短的片段。

**Validates: Requirements 2.4**

Property 5: Preservation - 手动剪辑过渡效果保留

_For any_ 通过 Clip Editor UI 手动指定 `transitionType` 为 'fade' 或 'crossfade' 的输入，修复后 SHALL 产生与修复前相同的行为，保留用户指定的视觉过渡效果。

**Validates: Requirements 3.1**

Property 6: Preservation - 短视频和无音频视频处理

_For any_ 原始视频时长 < 60 秒且全片质量良好的输入，或视频不包含音频轨道的输入，修复后 SHALL 产生与修复前相同的结果。

**Validates: Requirements 3.2, 3.5**

Property 7: Bug Condition - 前端视频处理进度显示

_For any_ 用户上传视频文件后，前端 SHALL 显示视频处理状态（处理中/完成/失败），而非 fire-and-forget 无反馈。

**Validates: Requirements 2.5**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `server/src/services/videoEditor.ts`

**Function**: `concatenateWithTransitions`

**Specific Changes**:
1. **修复 scale filter 引号** (L558):
   - 当前: `` scale='min(${maxRes},iw)':min'(${maxRes},ih)':force_original_aspect_ratio=decrease ``
   - 修复: `` scale='min(${maxRes},iw)':'min(${maxRes},ih)':force_original_aspect_ratio=decrease ``

**Function**: `selectSegments`

2. **break 改为 continue** (L104):
   - 当前: `if (selected.length > 0 && cumulative + seg.duration > targetDuration * 1.1) break;`
   - 修复: `if (selected.length > 0 && cumulative + seg.duration > targetDuration * 1.1) continue;`

**Function**: `editVideo`

3. **'none' 模式走 filter graph 处理音频** (L521-528):
   - 当前逻辑: `if (transitionType !== 'none')` 才走 filter graph
   - 修复: 当 `transitionType === 'none'` 且 `withAudio && segmentPaths.length > 1` 时，调用 `buildTransitionFilters` 获取音频 filter（videoFilter 为 null），然后走 `concatenateWithTransitions` 路径
   - 仅当单片段或无音频时才走 `concatenateSegments` 简单路径

4. **buildTransitionFilters 中 'none' 模式的 afade 时长调整**:
   - 当前使用 `transitionDuration`（默认 0.5s）作为 afade 时长
   - 修复: 'none' 模式下 afade 时长固定为 ~0.1s（100ms），不受 `transitionDuration` 配置影响

---

**File**: `server/src/services/proxyGenerator.ts`

**Function**: `processVideoAfterProxy`

5. **移除 transitionType: 'fade'** (L149-150):
   - 当前: `editVideo(videoPath, analysis, tripId, mediaId, { transitionType: 'fade' })`
   - 修复: `editVideo(videoPath, analysis, tripId, mediaId, {})`（使用默认 'none'）

---

**File**: `client/src/components/FileUploader.tsx`

**Function**: `FileUploader`

6. **视频处理进度显示**:
   - 将 fire-and-forget 的 `apiPost('/api/media/${id}/process')` 改为追踪响应
   - 在 `UploadFileEntry` 中增加 `processingStatus` 字段（'processing' | 'processed' | 'process_failed'）
   - 视频上传完成后设置 `processingStatus: 'processing'`，等待 API 响应后更新为 'processed' 或 'process_failed'
   - 在 UI 中对视频文件显示处理状态标签

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: 编写单元测试验证各 bug 的触发条件，在未修复代码上运行以观察失败模式。

**Test Cases**:
1. **Scale Filter 语法测试**: 构造 `concatenateWithTransitions` 调用，断言生成的 scale filter 字符串语法正确（will fail on unfixed code）
2. **proxyGenerator fade 测试**: 验证 `processVideoAfterProxy` 调用 `editVideo` 时不传 `transitionType: 'fade'`（will fail on unfixed code）
3. **'none' 模式音频路径测试**: 以 `transitionType: 'none'` 调用 `editVideo`，断言多片段有音频时走 filter graph 路径（will fail on unfixed code）
4. **selectSegments break 测试**: 构造 `[10s, 8s, 3s, 2s]` 片段集合，`targetDuration=15`，断言选中 10s+3s+2s=15s 而非仅 10s（will fail on unfixed code）

**Expected Counterexamples**:
- Bug 1: ffmpeg 因 `Invalid option` 或 `Unrecognized option` 报错退出
- Bug 4: `selectSegments` 返回总时长远低于 `targetDuration` 的片段集合

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedFunction(input)
  ASSERT expectedBehavior(result)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalFunction(input) = fixedFunction(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for non-bug inputs (手动剪辑 fade/crossfade、短视频、无音频视频、图片上传), then write property-based tests capturing that behavior.

**Test Cases**:
1. **手动剪辑 Preservation**: 验证 Clip Editor 传 `transitionType: 'fade'` 时，`editVideo` 仍走 fade filter graph 路径
2. **短视频 Preservation**: 验证 `targetDuration === null` 时 `selectSegments` 返回所有候选片段
3. **无音频视频 Preservation**: 验证 `withAudio === false` 时不尝试构建音频 filter
4. **图片上传 Preservation**: 验证图片文件上传后不触发视频处理流程

### Unit Tests

- `selectSegments` break→continue 修复后的片段选择正确性
- `concatenateWithTransitions` scale filter 字符串语法正确性
- `buildTransitionFilters` 在 'none' 模式下生成正确的音频 afade filter
- `editVideo` 在 'none' 模式下多片段有音频时走 filter graph 路径
- `FileUploader` 视频上传后显示处理状态

### Property-Based Tests

- 生成随机片段集合和 targetDuration，验证 `selectSegments` 修复后选中片段总时长尽可能接近 targetDuration
- 生成随机 videoResolution 值，验证 `concatenateWithTransitions` 生成的 scale filter 字符串始终语法正确
- 生成随机 transitionType 和 withAudio 组合，验证 `buildTransitionFilters` 输出的 filter 字符串格式正确

### Integration Tests

- 端到端测试：上传视频 → 自动剪辑 → 验证合成视频无 ffmpeg 错误
- 端到端测试：Clip Editor 手动选择 fade 过渡 → 验证合成视频包含 fade 效果
- 前端集成测试：上传视频 → 验证 UI 显示处理进度状态变化
