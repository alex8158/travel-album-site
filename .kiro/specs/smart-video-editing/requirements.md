# 需求文档：智能视频剪辑

## 简介

系统对用户上传的视频进行自动筛选与摘要剪辑，输出质量较好、内容连续、便于回看的成片，并支持用户基于自动剪辑结果进行手动编辑与合并导出。系统根据视频时长分类处理，检测并剔除严重抖动、严重模糊、严重曝光异常的低质量片段，在自然边界处切分，保持时间顺序输出内容摘要，并在片段拼接处应用平滑过渡效果。该功能基于现有的 `videoAnalyzer` 和 `videoEditor` 服务进行增强。

## 术语表

- **Video_Analyzer**：视频分析服务，负责将视频分割为片段并计算每个片段的清晰度、稳定性和曝光评分
- **Video_Editor**：视频剪辑服务，负责根据分析结果选择、裁剪和拼接视频片段
- **Segment**：视频片段，由 Video_Analyzer 在自然边界处切分产生的视频单元
- **Sharpness_Score**：清晰度评分，通过拉普拉斯方差计算的帧画面清晰度指标
- **Stability_Score**：稳定性评分，通过比较片段首尾帧差异计算的抖动程度指标
- **Exposure_Score**：曝光评分，通过分析帧亮度直方图计算的曝光正常程度指标
- **Quality_Detector**：质量检测器，负责识别严重抖动、严重模糊和严重曝光异常的片段
- **Cut_Point_Detector**：切点检测器，负责在视频中识别自然边界（场景切换、动作间歇等）作为切分位置
- **Merge_Engine**：合并引擎，负责将用户选择的视频片段按指定顺序合并为一个新视频
- **Transition_Filter**：过渡滤镜，在视频片段拼接处应用的视觉和音频平滑过渡效果
- **Target_Duration**：目标时长，根据原始视频时长计算出的剪辑后最大目标时长
- **Compiled_Video**：合成视频，由多个片段拼接生成的最终输出视频
- **Clip_Editor_UI**：片段编辑界面，前端提供的片段级手动操作界面

## 需求

### 需求 1：按视频时长分类处理

**用户故事：** 作为用户，我希望系统根据原始视频时长自动确定处理策略和目标时长，以便不同长度的视频得到合理的剪辑处理。

#### 验收标准

1. WHEN 原始视频时长小于 60 秒, THE Video_Editor SHALL 将 Target_Duration 设为 null，仅检测并删除严重抖动、严重模糊、严重曝光异常的片段
2. WHEN 原始视频时长小于 60 秒且全片质量良好, THE Video_Editor SHALL 保留原视频不做任何裁剪
3. WHEN 原始视频时长大于等于 60 秒且小于等于 600 秒（含 10 分钟整）, THE Video_Editor SHALL 将 Target_Duration 设为 60 秒，自动剪辑为不超过 60 秒的摘要视频
4. WHEN 原始视频时长大于 600 秒（严格大于 10 分钟）, THE Video_Editor SHALL 将 Target_Duration 设为 300 秒，自动剪辑为不超过 300 秒的摘要视频
5. WHEN 有效片段总时长不足 Target_Duration, THE Video_Editor SHALL 按实际可保留时长输出，不进行填充或重复

### 需求 2：低质量片段检测与剔除

**用户故事：** 作为用户，我希望系统自动检测并剔除视频中严重抖动、严重模糊和严重曝光异常的片段，以便最终视频画面清晰、稳定、曝光正常。

#### 验收标准

1. THE Quality_Detector SHALL 对每个 Segment 计算 Sharpness_Score、Stability_Score 和 Exposure_Score
2. WHEN Segment 存在严重模糊（包括失焦模糊和运动模糊）导致主体难以辨认, THE Quality_Detector SHALL 将该 Segment 标记为 "severely_blurry"
3. WHEN Segment 存在严重抖动导致主体难以辨认, THE Quality_Detector SHALL 将该 Segment 标记为 "severely_shaky"
4. WHEN Segment 存在严重曝光异常（过暗或过曝）, THE Quality_Detector SHALL 将该 Segment 标记为 "severely_exposed"
5. THE Video_Editor SHALL 从候选片段中排除所有标记为 "severely_blurry"、"severely_shaky" 或 "severely_exposed" 的 Segment
6. THE Compiled_Video SHALL 不包含任何明显看不清的片段

### 需求 3：智能切点与片段切分

**用户故事：** 作为用户，我希望系统在自然边界处切分视频，不在连续动作中间硬切，以便剪辑后的视频内容连贯自然。

#### 验收标准

1. THE Cut_Point_Detector SHALL 在场景切换、动作间歇等自然边界处确定切分位置
2. THE Cut_Point_Detector SHALL 避免在明显连续动作的中间位置设置切点
3. THE Video_Editor SHALL 保证每个保留的 Segment 时长不短于 2 秒
4. WHEN 一组连续 Segment 构成连续动作片段, THE Video_Editor SHALL 允许保留超过 2 秒的更长时长以保持动作完整性
5. THE Video_Editor SHALL 在切点前后保留适当缓冲时间，以避免动作被截断

### 需求 4：智能片段选择与排序策略

**用户故事：** 作为用户，我希望系统优先保留清晰、稳定、曝光正常、内容连续的片段，并按时间顺序输出，以便最终视频呈现内容摘要效果。

#### 验收标准

1. THE Video_Editor SHALL 优先选择清晰度高、稳定性好、曝光正常的 Segment 作为候选
2. THE Video_Editor SHALL 按 overallScore（综合 Sharpness_Score、Stability_Score 和 Exposure_Score）降序排列候选 Segment
3. THE Video_Editor SHALL 从评分最高的 Segment 开始累计选择，直到累计时长达到 Target_Duration
4. WHEN 两个候选 Segment 在原始时间线上相邻或间隔不超过 2 秒, THE Video_Editor SHALL 优先将它们作为连续片段一起选择，以减少碎片化
5. THE Video_Editor SHALL 在评分相近（差距不超过 10%）的候选 Segment 之间，优先选择能与已选片段形成连续区间的 Segment
6. THE Video_Editor SHALL 将选中的 Segment 按原始时间顺序重新排列后进行拼接
7. THE Compiled_Video SHALL 呈现"内容摘要"效果，而非随机抽帧拼接

### 需求 5：片段级手动编辑能力

**用户故事：** 作为用户，我希望在自动剪辑完成后能够预览、删除、调整顺序和合并导出片段，以便按自己的意愿控制最终视频内容。

#### 验收标准

1. THE Clip_Editor_UI SHALL 展示自动剪辑生成的所有 Segment 的预览
2. THE Clip_Editor_UI SHALL 允许用户删除不需要的 Segment
3. THE Clip_Editor_UI SHALL 允许用户调整 Segment 的排列顺序
4. THE Clip_Editor_UI SHALL 允许用户勾选多个 Segment 进行合并导出，生成新的合并视频
5. WHEN 用户提交合并请求, THE Merge_Engine SHALL 按用户指定的顺序提取并拼接所选 Segment
6. THE Merge_Engine SHALL 将合并后的视频保存至存储系统并返回新视频的访问路径
7. IF 用户提交的 Segment 选择列表为空, THEN THE Merge_Engine SHALL 返回参数错误提示
8. IF 合并过程中发生错误, THEN THE Merge_Engine SHALL 返回包含错误描述的结果并清理临时文件
9. THE Clip_Editor_UI SHALL 在架构上预留后续支持片段入点和出点微调的扩展能力

### 需求 6：片段过渡效果

**用户故事：** 作为用户，我希望剪辑后的视频片段之间有平滑的过渡效果，音频拼接处无突兀断裂，以便观看体验流畅自然。

#### 验收标准

1. THE Transition_Filter SHALL 默认在相邻 Segment 拼接处应用平滑连接效果
2. THE Transition_Filter SHALL 支持硬切（直接拼接）过渡方式
3. THE Transition_Filter SHALL 支持短时淡入淡出过渡方式
4. THE Transition_Filter SHALL 支持交叉淡化（crossfade）过渡方式
5. THE Transition_Filter SHALL 在音频拼接处应用短时淡入淡出处理，避免音频突兀断裂
6. WHEN Segment 时长小于过渡时长的 2 倍, THE Transition_Filter SHALL 跳过该 Segment 的过渡效果以避免画面异常

### 需求 7：输出规格

**用户故事：** 作为用户，我希望输出的视频符合标准格式和编码规范，保持原始画面方向和帧率，以便在各种设备上正常播放。

#### 验收标准

1. THE Video_Editor SHALL 以 MP4 格式输出 Compiled_Video
2. THE Video_Editor SHALL 使用 H.264 编码输出视频流
3. THE Video_Editor SHALL 使用 AAC 编码输出音频流
4. THE Video_Editor SHALL 保持原始视频的横屏或竖屏方向不变
5. THE Video_Editor SHALL 不放大原始分辨率，必要时将分辨率压缩至最大 1080p
6. THE Video_Editor SHALL 优先保持原始视频的帧率

### 需求 8：异常与边界处理

**用户故事：** 作为用户，我希望系统在各种异常和边界情况下都能给出明确的反馈或合理的输出，以便我了解处理结果。

#### 验收标准

1. WHEN 视频中无任何可保留片段, THE Video_Editor SHALL 返回明确的"无有效片段"提示信息
2. WHEN 可保留内容总时长不足 Target_Duration, THE Video_Editor SHALL 按实际可保留内容输出，不进行填充
3. THE Video_Editor SHALL 支持处理横屏视频
4. THE Video_Editor SHALL 支持处理竖屏视频
5. THE Video_Editor SHALL 支持处理无音频轨道的视频
6. THE Merge_Engine SHALL 支持用户在自动剪辑结果基础上再次手动合并导出

### 需求 9：第一版功能范围

**用户故事：** 作为开发者，我希望明确第一版的功能边界，以便合理规划开发工作量和交付范围。

#### 验收标准

1. THE Quality_Detector SHALL 在第一版中实现严重抖动、严重模糊和严重曝光异常的检测能力
2. THE Video_Editor SHALL 在第一版中实现删除低质量片段的能力
3. THE Video_Editor SHALL 在第一版中实现按时长生成 60 秒或 300 秒摘要的能力
4. THE Clip_Editor_UI SHALL 在第一版中实现片段预览、删除、排序和合并导出功能
5. THE Transition_Filter SHALL 在第一版中实现硬切、短时淡入淡出和交叉淡化三种基础过渡效果
6. THE Video_Editor SHALL 在第一版中实现 MP4/H.264/AAC 格式的视频导出功能
7. THE Quality_Detector SHALL 在第一版中不要求识别复杂语义问题（如主体过小、构图差、遮挡严重等）
8. THE Clip_Editor_UI SHALL 在第一版中不要求支持逐帧精修功能

### 需求 10：质量阈值配置化

**用户故事：** 作为开发者/运维人员，我希望所有质量判定阈值都可通过配置文件或环境变量调整，以便在不修改代码的情况下针对不同场景优化检测效果。

#### 验收标准

1. THE Quality_Detector SHALL 从统一配置对象读取严重模糊判定阈值（Sharpness_Score 下限），支持环境变量覆盖
2. THE Quality_Detector SHALL 从统一配置对象读取严重抖动判定阈值（Stability_Score 下限），支持环境变量覆盖
3. THE Quality_Detector SHALL 从统一配置对象读取严重曝光异常判定阈值（Exposure_Score 上下限），支持环境变量覆盖
4. THE Video_Editor SHALL 从统一配置对象读取最小片段时长（默认 2 秒），支持环境变量覆盖
5. THE Video_Editor SHALL 从统一配置对象读取时长分档边界（默认 60 秒和 600 秒）和对应目标时长（默认 60 秒和 300 秒），支持环境变量覆盖
6. THE Transition_Filter SHALL 从统一配置对象读取默认过渡时长，支持环境变量覆盖
7. 所有配置项 SHALL 提供合理的默认值，在未设置环境变量时系统可正常运行
