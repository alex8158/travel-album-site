# Bugfix Requirements Document

## Introduction

视频剪辑功能存在多个 bug，影响自动剪辑流程的正确性和用户体验。主要问题包括：
1. `concatenateWithTransitions` 中 scale filter 语法错误导致 ffmpeg 执行失败
2. 自动剪辑默认应使用直接拼接（`'none'`），不加视频 fade 特效；仅在音频拼接处做短时淡入淡出避免爆音
3. `selectSegments` 的 `targetDuration * 1.1` 上限逻辑存在提前退出问题，可能导致选中片段总时长远低于目标时长
4. 前端上传视频后无法看到后端处理进度（分析、剪辑等状态）

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `concatenateWithTransitions` 构建 scale filter 时，生成的字符串为 `` scale='min(1080,iw)':min'(1080,ih)':force_original_aspect_ratio=decrease ``，其中 `min'(...)' ` 多了错位的单引号，THEN ffmpeg 因 filter 语法错误而执行失败，导致视频合成报错

1.2 WHEN 自动剪辑流程（proxyGenerator、mediaProcess、runTripProcessingPipeline）调用 `editVideo` 时，部分调用方传递了 `transitionType: 'fade'`，THEN 短片段（如 1-2 秒）几乎全在看淡入淡出特效，严重影响观看体验

1.3 WHEN `editVideo` 的默认 transitionType 为 `'none'` 时，音频拼接处可能出现突兀断裂，但视频画面不需要 fade 特效

1.4 WHEN `selectSegments` 在贪心选择循环中，累计时长加上当前片段超过 `targetDuration * 1.1` 时执行 `break` 退出整个外层循环，THEN 即使后续存在更短的片段可以填充到目标时长，也不会被考虑，导致选中片段总时长可能远低于目标时长

1.5 WHEN 用户上传视频后，前端 FileUploader 以 fire-and-forget 方式调用 `POST /api/media/:id/process`，THEN 用户无法看到视频处理进度（分析中、剪辑中、完成/失败），不知道后端处理状态

### Expected Behavior (Correct)

2.1 WHEN `concatenateWithTransitions` 构建 scale filter 时，THEN 系统 SHALL 生成正确的 ffmpeg scale filter 语法 `` scale='min(1080,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease ``，使 ffmpeg 能正常执行视频合成

2.2 WHEN 自动剪辑流程合成视频时，THEN 系统 SHALL 使用视频硬切（不加任何视觉过渡特效），同时在音频拼接处应用极短的 afade（约 100ms）消除爆音和咔嗒声

2.3 WHEN `editVideo` 以默认 `transitionType: 'none'` 运行且视频包含音频轨道时，THEN 系统 SHALL 走 filter graph 路径对音频拼接处应用短时 afade，而非直接走 concat demuxer 跳过所有音频平滑处理

2.4 WHEN `selectSegments` 在贪心选择循环中遇到某个片段会导致累计时长超过 `targetDuration * 1.1` 时，THEN 系统 SHALL 跳过该片段（`continue`）而非退出循环（`break`），继续检查后续更短的片段，直到所有候选片段都被评估

2.5 WHEN 用户上传视频后，THEN 前端 SHALL 显示视频处理进度状态（如"分析中"、"剪辑中"、"处理完成"或"处理失败"），让用户了解后端处理状态

### Unchanged Behavior (Regression Prevention)

3.1 WHEN 用户通过 Clip Editor UI 手动触发剪辑（`POST /api/media/:id/clips`）并指定 transitionType 为 'fade' 或 'crossfade' 时，THEN 系统 SHALL CONTINUE TO 使用用户指定的 transitionType

3.2 WHEN 原始视频时长小于 60 秒且全片质量良好时，THEN 系统 SHALL CONTINUE TO 保留原视频不做任何裁剪，不触发合成流程

3.3 WHEN `selectSegments` 处理无需目标时长限制的短视频（targetDuration 为 null）时，THEN 系统 SHALL CONTINUE TO 返回所有通过质量过滤的片段

3.4 WHEN 用户上传图片文件时，THEN 前端 SHALL CONTINUE TO 正常上传图片，不触发视频处理流程

3.5 WHEN 视频不包含音频轨道时，THEN 系统 SHALL CONTINUE TO 正常拼接视频，不尝试应用音频 filter
