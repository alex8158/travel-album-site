# 需求文档：自动视频剪辑

## 简介

视频上传处理完成后（video_segments 分片数据和质量评分已就绪），系统自动基于质量评分选择最佳片段，使用 ffmpeg 拼接生成约 60 秒的"初步剪辑版本" MP4 文件。用户可在前端预览该版本，不满意时可手动调整选中片段后重新生成。当前阶段 AI API 尚未配置（千问 key 未就绪），采用纯质量评分策略（editPlanner.ts 中的 fallbackSelection）进行片段选择。

## 术语表

- **Compilation_Engine**：自动剪辑引擎，负责在视频处理完成后自动触发片段选择和 ffmpeg 拼接，生成初步剪辑版本
- **Segment_Selector**：片段选择器，基于 video_segments 表中的 overallScore 按降序选择片段，累计时长达到目标时长为止
- **Compiled_Video**：合成视频，由 Compilation_Engine 拼接生成的 MP4 文件
- **Video_Detail_Page**：视频详情页，前端展示视频信息和剪辑预览的页面
- **Target_Duration**：目标时长，自动剪辑的目标输出时长，默认 60 秒
- **Regeneration_Request**：重新生成请求，用户调整片段选择后发起的重新拼接请求
- **Processing_Pipeline**：处理管线，视频上传后执行分片分析和质量评分的现有流程
- **FFmpeg_Compiler**：FFmpeg 拼接器，调用 ffmpeg 命令行工具将多个视频片段拼接为单一 MP4 文件的模块

## 需求

### 需求 1：视频处理完成后自动触发剪辑

**用户故事：** 作为用户，我希望视频上传处理完成后系统自动生成一个初步剪辑版本，以便我无需手动操作即可快速获得精选视频摘要。

#### 验收标准

1. WHEN Processing_Pipeline 完成视频分片分析且 video_segments 数据已写入数据库, THE Compilation_Engine SHALL 自动触发片段选择和拼接流程
2. WHEN 自动剪辑流程被触发, THE Compilation_Engine SHALL 调用 Segment_Selector 从 video_segments 表中按 overallScore 降序选择片段
3. THE Segment_Selector SHALL 从评分最高的片段开始累计选择，直到累计时长达到或超过 Target_Duration（原始视频时长 60-600 秒时 Target_Duration 为 60 秒，原始视频时长大于 600 秒时 Target_Duration 为 300 秒）
4. WHEN 原始视频时长小于 60 秒, THE Segment_Selector SHALL 不设置 Target_Duration 上限，仅排除低质量片段后保留全部有效片段
5. THE Segment_Selector SHALL 排除 label 为 "severely_blurry"、"severely_shaky" 或 "severely_exposed" 的片段
6. THE Compilation_Engine SHALL 将选中片段按原始时间顺序排列后传递给 FFmpeg_Compiler 进行拼接
7. WHEN 自动剪辑完成, THE Compilation_Engine SHALL 将 Compiled_Video 的文件路径写入 media_items 表的 compiled_path 字段
8. IF 所有片段均被排除导致无有效片段可选, THEN THE Compilation_Engine SHALL 不生成 Compiled_Video，并将 processing_error 设为"无有效片段"
9. IF FFmpeg_Compiler 拼接过程中发生错误, THEN THE Compilation_Engine SHALL 记录错误信息至 processing_error 字段，清理临时文件，且不写入 compiled_path

### 需求 2：FFmpeg 拼接生成 MP4

**用户故事：** 作为用户，我希望系统使用 ffmpeg 将选中的视频片段拼接为一个标准 MP4 文件，以便我可以在任何设备上正常播放。

#### 验收标准

1. THE FFmpeg_Compiler SHALL 以 MP4 容器格式输出 Compiled_Video
2. THE FFmpeg_Compiler SHALL 使用 H.264 编码输出视频流
3. THE FFmpeg_Compiler SHALL 使用 AAC 编码输出音频流
4. WHEN 输入片段存在不同分辨率或帧率时, THE FFmpeg_Compiler SHALL 以第一个片段的参数为基准统一转码，并将输出分辨率限制在 1080p（1920×1080）以内，不放大低于 1080p 的原始分辨率
5. THE FFmpeg_Compiler SHALL 通过环境变量 VIDEO_MEMORY_LIMIT_MB 限制 ffmpeg 进程的内存使用量，默认值为 4096 MB
6. WHEN 拼接过程中 ffmpeg 进程异常退出或运行时间超过 600 秒, THE FFmpeg_Compiler SHALL 终止该进程、清理所有临时文件并返回包含错误描述的结果
7. THE FFmpeg_Compiler SHALL 在相邻片段拼接处保持音视频同步，音视频偏差不超过 100 毫秒
8. IF 输入的片段列表为空, THEN THE FFmpeg_Compiler SHALL 返回参数错误提示而不启动 ffmpeg 进程

### 需求 3：目标时长控制

**用户故事：** 作为用户，我希望自动剪辑生成的视频时长约为 60 秒，以便快速浏览视频精华内容。

#### 验收标准

1. THE Compilation_Engine SHALL 将默认 Target_Duration 设为 60 秒
2. WHEN 可选片段的总时长不足 Target_Duration, THE Compilation_Engine SHALL 按实际可保留时长输出，不进行填充或重复
3. IF 视频原始时长小于 60 秒且所有片段均未被标记为严重低质量（severely_blurry、severely_shaky、severely_exposed）, THEN THE Compilation_Engine SHALL 跳过自动剪辑流程，不生成 Compiled_Video
4. IF 视频中无任何可保留片段（所有片段均被标记为严重低质量）, THEN THE Compilation_Engine SHALL 记录"无有效片段"状态，不生成 Compiled_Video
5. THE Compilation_Engine SHALL 允许通过 API 参数指定自定义 Target_Duration 值，有效范围为 10 秒至 600 秒（含边界值）
6. IF API 参数指定的 Target_Duration 值小于 10 秒或大于 600 秒或非正整数, THEN THE Compilation_Engine SHALL 拒绝请求并返回参数错误提示，指明有效范围
7. THE Compilation_Engine SHALL 输出的 Compiled_Video 总时长不超过 Target_Duration

### 需求 4：前端剪辑预览

**用户故事：** 作为用户，我希望在视频详情页看到自动生成的剪辑预览，以便快速判断剪辑效果是否满意。

#### 验收标准

1. IF Compiled_Video 存在, THEN THE Video_Detail_Page SHALL 展示"剪辑预览"按钮
2. WHEN 用户点击"剪辑预览"按钮, THE Video_Detail_Page SHALL 使用 VideoPlayer 组件播放 Compiled_Video，视频 URL 从媒体详情接口获取
3. IF Compiled_Video 不存在且视频片段分析已完成（segments 数据可用）, THEN THE Video_Detail_Page SHALL 展示"生成剪辑"按钮供用户手动触发编译流程
4. IF Compiled_Video 不存在且视频片段分析尚未完成, THEN THE Video_Detail_Page SHALL 不展示"剪辑预览"或"生成剪辑"按钮
5. WHILE Compilation_Engine 正在执行拼接, THE Video_Detail_Page SHALL 展示进度指示器，包含当前完成百分比（0-100%）和处理状态文字描述
6. WHILE Compilation_Engine 正在执行拼接, THE Video_Detail_Page SHALL 每 2 秒轮询一次任务状态接口以更新进度
7. IF 剪辑编译失败（任务状态返回 failed）, THEN THE Video_Detail_Page SHALL 展示包含失败原因的错误提示信息和"重试"按钮
8. WHEN 用户点击"重试"按钮, THE Video_Detail_Page SHALL 重新发起编译请求并恢复进度指示器展示

### 需求 5：手动调整片段后重新生成

**用户故事：** 作为用户，我希望在预览不满意时可以手动调整选中的片段，然后重新生成剪辑视频，以便获得符合我期望的视频摘要。

#### 验收标准

1. WHEN 当前视频已存在 Compiled_Video, THE Video_Detail_Page SHALL 展示"重新生成"按钮，允许用户进入片段调整模式
2. WHEN 用户进入片段调整模式, THE Video_Detail_Page SHALL 展示该视频所有经过分析的 Segment 列表（包括之前被自动剔除的低质量片段），标注每个片段的时间范围、时长、质量评分及是否被标记为低质量
3. THE Video_Detail_Page SHALL 允许用户勾选或取消勾选片段以调整选择，最多可选择 50 个片段
4. THE Video_Detail_Page SHALL 允许用户通过拖拽操作调整选中片段的排列顺序
5. WHEN 用户确认调整后提交 Regeneration_Request, THE Compilation_Engine SHALL 按用户指定的片段和顺序重新执行 ffmpeg 拼接，并在前端展示处理中状态
6. WHEN 重新生成完成, THE Compilation_Engine SHALL 用新的 Compiled_Video 替换之前的版本，旧版本不保留
7. IF 用户提交的片段选择列表为空, THEN THE Compilation_Engine SHALL 返回参数错误提示，不执行拼接操作
8. IF 重新生成过程中 ffmpeg 拼接失败, THEN THE Compilation_Engine SHALL 保留原有的 Compiled_Video 不变，并向用户返回包含错误描述的失败提示
9. IF 重新生成耗时超过 120 秒, THEN THE Compilation_Engine SHALL 终止该次拼接任务并向用户返回超时错误提示

### 需求 6：片段选择策略（纯质量评分）

**用户故事：** 作为开发者，我希望在 AI API 未配置时系统使用纯质量评分策略选择片段，以便功能可以独立于 AI 服务正常运行。

#### 验收标准

1. THE Segment_Selector SHALL 使用 editPlanner.ts 中的 fallbackSelection 函数作为默认选择策略
2. THE Segment_Selector SHALL 排除 overallScore 低于 30 的片段，并将剩余片段按 overallScore 降序排列
3. THE Segment_Selector SHALL 从评分最高的片段开始累计选择，直到累计时长大于或等于 Target_Duration（默认 60 秒）；当加入下一个片段会超出 Target_Duration 时，仍将该片段纳入选择后停止
4. THE Segment_Selector SHALL 将最终选中的片段按原始时间顺序（startTime 升序）重新排列
5. IF 两个候选片段 overallScore 差值不超过绝对分值 10 分且 startTime 间隔不超过 5 秒, THEN THE Segment_Selector SHALL 优先选择能形成连续区间的片段
6. IF 所有符合条件的片段（overallScore >= 30）累计总时长不足 Target_Duration, THEN THE Segment_Selector SHALL 选择全部符合条件的片段并按 startTime 升序排列

### 需求 7：API 接口设计

**用户故事：** 作为前端开发者，我希望有清晰的 API 接口来触发剪辑、获取状态和下载结果，以便前端可以正确集成自动剪辑功能。

#### 验收标准

1. WHEN POST 请求发送到 /api/media/:mediaId/compile, THE Compilation_Engine SHALL 启动剪辑任务并返回包含 jobId 和初始状态的 JSON 响应
2. WHEN GET 请求发送到 /api/media/:mediaId/compile/status, THE Compilation_Engine SHALL 返回包含当前状态（queued、running、completed、failed）、进度百分比和错误信息（如有）的 JSON 响应
3. WHEN GET 请求发送到 /api/media/:mediaId/compile/download 且 Compiled_Video 已生成, THE Compilation_Engine SHALL 以 MP4 文件流形式返回 Compiled_Video
4. WHEN POST /api/media/:mediaId/compile 请求包含 segmentIndices 参数, THE Compilation_Engine SHALL 验证所有索引值在该视频 video_segments 的有效范围内（0 到片段总数-1），并按指定片段列表执行拼接
5. WHEN POST /api/media/:mediaId/compile 请求包含 targetDuration 参数, THE Compilation_Engine SHALL 验证该值为 5 到 600 之间的正整数（单位：秒），并使用指定的目标时长
6. IF 指定的 mediaId 不存在或无 video_segments 数据, THEN THE Compilation_Engine SHALL 返回 HTTP 404 错误及错误描述
7. IF 已有剪辑任务正在执行（状态为 queued 或 running）, THEN THE Compilation_Engine SHALL 返回 HTTP 409 冲突错误及错误描述
8. IF GET /api/media/:mediaId/compile/download 请求时 Compiled_Video 尚未生成, THEN THE Compilation_Engine SHALL 返回 HTTP 404 错误并说明剪辑尚未完成
9. IF POST /api/media/:mediaId/compile 请求中 segmentIndices 为空数组或包含无效索引, THEN THE Compilation_Engine SHALL 返回 HTTP 400 错误并说明参数无效
10. IF POST /api/media/:mediaId/compile 请求中 targetDuration 超出有效范围, THEN THE Compilation_Engine SHALL 返回 HTTP 400 错误并说明时长范围限制

### 需求 8：错误处理与资源清理

**用户故事：** 作为用户，我希望系统在剪辑失败时给出明确的错误提示，并确保不会残留临时文件占用磁盘空间。

#### 验收标准

1. IF ffmpeg 拼接过程中发生错误, THEN THE FFmpeg_Compiler SHALL 终止当前 ffmpeg 进程、删除本次拼接任务创建的临时目录及其中所有文件，并返回包含失败原因的错误结果
2. IF ffmpeg 进程在 300 秒内未完成, THEN THE FFmpeg_Compiler SHALL 强制终止该进程、删除本次拼接任务创建的临时目录及其中所有文件，并返回超时错误
3. WHEN 剪辑失败（包括错误和超时）, THE Compilation_Engine SHALL 将 media_items 表中对应记录的 processing_error 字段更新为失败原因描述（最大 500 字符，超出部分截断）
4. THE FFmpeg_Compiler SHALL 在拼接开始前验证所有源片段文件存在且可读
5. IF 部分源片段文件缺失但至少有 1 个片段可用, THEN THE FFmpeg_Compiler SHALL 跳过缺失片段并继续拼接剩余片段，同时在返回结果中包含缺失片段的索引列表作为警告信息
6. IF 所有源片段文件均缺失或不可读, THEN THE FFmpeg_Compiler SHALL 返回错误结果，指明无可用片段，不执行拼接操作
