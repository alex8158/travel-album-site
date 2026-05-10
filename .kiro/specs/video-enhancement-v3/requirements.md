# 需求文档：视频处理增强 V3

## 简介

本 spec 覆盖视频处理系统的第三阶段增强。在前两阶段已完成黑帧检测、垃圾片段识别、音频归一化和多版本输出的基础上，本阶段聚焦以下核心改进：

1. **内存优化** — 解决视频处理过程中内存占用过大导致系统崩溃的问题，引入流式处理、并发控制和内存监控机制
2. **黑场检测增强** — 扩展现有黑帧检测能力，支持近黑帧（如极暗画面、镜头盖半遮挡）的识别
3. **废片识别增强** — 新增镜头遮挡检测（手指/物体遮挡镜头），完善废片识别覆盖面
4. **音频归一化增强** — 优化归一化流程的内存效率，支持流式处理大文件
5. **多版本输出调整** — 将输出版本调整为 30s/1min/5min 三档，匹配实际使用场景

当前系统已有能力：
- 黑帧检测（blackFrameDetector）：基于帧亮度采样的黑帧占比分析
- 垃圾片段识别（junkClipDetector）：too_short / extreme_blur / ground_shot / accidental_touch 四类检测
- 音频归一化（audioNormalizer）：基于 ffmpeg loudnorm 的 LUFS 归一化
- 多版本输出（multiVersionGenerator）：highlight(30s) / summary(60s) / full_edit(300s) 三档
- 存储层已支持 Buffer 和 Readable Stream 两种写入方式

本阶段的核心目标是解决内存崩溃问题，同时增强检测能力和调整输出配置。

## 术语表

- **Memory_Manager**: 内存管理器，负责监控进程内存使用、控制并发任务数量、在内存压力过大时暂停或降级处理
- **Stream_Processor**: 流式处理器，使用 Node.js Stream 替代 Buffer 整体加载，避免大文件占满内存
- **Concurrency_Controller**: 并发控制器，限制同时进行的视频处理任务数量，防止多任务并行导致内存叠加
- **Black_Frame_Detector**: 黑帧检测服务（已有），本阶段增强为支持近黑帧检测
- **Junk_Clip_Detector**: 垃圾片段检测服务（已有），本阶段新增镜头遮挡检测
- **Audio_Normalizer**: 音频归一化服务（已有），本阶段优化为流式处理
- **Multi_Version_Generator**: 多版本生成器（已有），本阶段调整输出时长配置
- **Video_Segment**: 视频片段，由场景检测分割产生的基本处理单元
- **Memory_Pressure_Level**: 内存压力等级，分为 normal / warning / critical 三级
- **Near_Black_Frame**: 近黑帧，亮度低于近黑阈值但高于纯黑阈值的帧（如极暗环境、镜头盖半遮挡）
- **Lens_Occlusion**: 镜头遮挡，手指或物体部分/完全遮挡镜头导致画面大面积单色或模糊
- **Backpressure**: 背压机制，当下游处理速度跟不上上游数据产生速度时的流量控制策略
- **Segment_Processing_Queue**: 片段处理队列，按顺序处理视频片段并控制同时处理的片段数量
- **RSS**: Resident Set Size，进程实际占用的物理内存大小

## 需求

### 需求 1：进程内存监控

**用户故事：** 作为开发者，我希望系统能实时监控视频处理过程中的内存使用情况，以便在内存压力过大时及时采取措施避免系统崩溃。

#### 验收标准

1. THE Memory_Manager SHALL 提供获取当前进程 RSS 内存使用量的能力，返回值为数值类型，单位为 MB
2. THE Memory_Manager SHALL 根据 RSS 与配置的内存上限计算当前 Memory_Pressure_Level（normal / warning / critical）
3. IF RSS 低于内存上限乘以 warning 阈值比例, THEN THE Memory_Manager SHALL 将 Memory_Pressure_Level 设为 normal
4. IF RSS 达到内存上限乘以 warning 阈值比例但低于内存上限乘以 critical 阈值比例, THEN THE Memory_Manager SHALL 将 Memory_Pressure_Level 设为 warning
5. IF RSS 达到或超过内存上限乘以 critical 阈值比例, THEN THE Memory_Manager SHALL 将 Memory_Pressure_Level 设为 critical
6. THE Memory_Manager SHALL 支持通过环境变量 VIDEO_MEMORY_LIMIT_MB 配置内存上限（默认 1024 MB），有效范围为 128 至 65536 MB
7. THE Memory_Manager SHALL 支持通过环境变量 VIDEO_MEMORY_WARNING_RATIO 配置 warning 阈值比例（默认 0.7），有效范围为 0.1 至 0.9
8. THE Memory_Manager SHALL 支持通过环境变量 VIDEO_MEMORY_CRITICAL_RATIO 配置 critical 阈值比例（默认 0.85），有效范围为 0.2 至 0.99 且必须大于 warning 阈值比例
9. IF 环境变量配置值超出有效范围或 critical 阈值比例不大于 warning 阈值比例, THEN THE Memory_Manager SHALL 忽略无效值并使用对应的默认值
10. WHEN Memory_Pressure_Level 从一个级别变化到另一个级别时, THE Memory_Manager SHALL 记录日志包含变化前后的级别和当前 RSS 值


### 需求 2：内存压力响应策略

**用户故事：** 作为开发者，我希望系统在检测到内存压力时自动采取降级措施，以便在不崩溃的前提下尽可能完成视频处理任务。

#### 验收标准

1. WHILE Memory_Pressure_Level 为 normal（堆内存使用率低于 70%）, THE Memory_Manager SHALL 允许所有视频处理操作以正常模式执行（默认每段 5 帧采样，最大并发片段处理数量按系统配置）
2. WHILE Memory_Pressure_Level 为 warning（堆内存使用率达到 70% 且低于 90%）, THE Memory_Manager SHALL 降低帧采样密度（从默认每段 5 帧降至 3 帧）以减少内存占用
3. WHILE Memory_Pressure_Level 为 warning, THE Memory_Manager SHALL 将并发片段处理数量降至 1（串行处理）
4. WHEN Memory_Pressure_Level 变为 critical（堆内存使用率达到 90% 或以上）, THE Memory_Manager SHALL 暂停所有尚未开始执行的排队片段处理任务，并等待当前正在执行的任务完成释放内存
5. WHEN Memory_Pressure_Level 从 critical 恢复至 warning 或 normal, THE Memory_Manager SHALL 按原始排队顺序（FIFO）恢复暂停的片段处理任务
6. IF Memory_Pressure_Level 持续 critical 超过 30 秒且在此期间无任何任务完成, THEN THE Memory_Manager SHALL 触发强制垃圾回收（global.gc）并记录警告日志
7. IF 强制垃圾回收执行后 10 秒内 Memory_Pressure_Level 仍为 critical, THEN THE Memory_Manager SHALL 取消所有暂停的待处理任务，返回错误信息指示内存不足无法继续处理，并保留已完成任务的结果
8. THE Memory_Manager SHALL 每 5 秒检测一次当前堆内存使用率并更新 Memory_Pressure_Level
9. THE Memory_Manager SHALL 在每个片段处理完成后立即检查 Memory_Pressure_Level 并据此决定是否继续下一个片段（遵循当前级别对应的策略）
10. WHEN Memory_Pressure_Level 在 warning 与 normal 之间变化时, THE Memory_Manager SHALL 要求新级别持续至少 5 秒后才执行级别切换，以防止因内存波动导致策略频繁切换

### 需求 3：流式文件存储

**用户故事：** 作为开发者，我希望视频处理完成后使用流式方式将文件写入存储系统，以便避免将整个视频文件加载到内存中。

#### 验收标准

1. WHEN 视频编辑完成需要保存合成视频时, THE Stream_Processor SHALL 使用 createReadStream 读取临时文件并以 Readable Stream 方式传递给存储层的 save 方法，等待存储层写入完成（stream pipeline resolved）后再视为传输成功
2. WHEN 多版本输出完成需要保存各版本文件时, THE Stream_Processor SHALL 使用 createReadStream 读取临时文件并以 Readable Stream 方式传递给存储层的 save 方法，等待存储层写入完成（stream pipeline resolved）后再视为传输成功
3. WHEN 合并引擎完成需要保存合并视频时, THE Stream_Processor SHALL 使用 createReadStream 读取临时文件并以 Readable Stream 方式传递给存储层的 save 方法，等待存储层写入完成（stream pipeline resolved）后再视为传输成功
4. WHEN Stream 传输成功完成（pipeline resolved）, THE Stream_Processor SHALL 删除对应的临时文件，并在删除完成后才向调用方返回成功结果
5. IF Stream 传输过程中发生错误（读取错误、写入错误或超时）, THEN THE Stream_Processor SHALL 销毁 ReadStream、清理临时文件、并向调用方抛出包含失败原因的错误
6. IF 临时文件在开始流式传输前不存在或不可读, THEN THE Stream_Processor SHALL 立即向调用方抛出错误，不尝试创建 Stream
7. IF 临时文件删除失败, THEN THE Stream_Processor SHALL 记录警告日志并仍向调用方返回成功结果（因为存储层写入已完成）
8. THE Stream_Processor SHALL 为每次流式传输设置 300 秒超时，超时未完成时视为传输失败并触发错误处理流程


### 需求 4：片段处理并发控制

**用户故事：** 作为开发者，我希望系统限制同时处理的视频片段数量，以便多个片段的帧提取和分析不会同时占满内存。

#### 验收标准

1. THE Concurrency_Controller SHALL 支持通过环境变量 VIDEO_MAX_CONCURRENT_SEGMENTS 配置最大并发片段处理数（默认 3），有效值范围为 1 至 16；IF 环境变量值无效（非正整数或超出范围）, THEN THE Concurrency_Controller SHALL 使用默认值 3 并记录警告日志
2. WHEN 视频分析（analyzeVideo）处理多个片段时, THE Concurrency_Controller SHALL 限制同时进行帧提取和评分计算的片段数量不超过配置值
3. WHEN 黑帧检测批量处理多个片段时, THE Concurrency_Controller SHALL 限制同时进行帧提取的片段数量不超过配置值
4. WHEN 垃圾片段检测批量处理多个片段时, THE Concurrency_Controller SHALL 限制同时进行运动估计和角度分析的片段数量不超过配置值
5. THE Concurrency_Controller SHALL 使用信号量（Semaphore）模式实现并发限制；WHEN 并发数已达上限时，后续提交的任务 SHALL 异步等待（不阻塞事件循环），并按 FIFO 顺序在有空位释放时获得执行机会
6. WHILE Memory_Pressure_Level 为 warning, THE Concurrency_Controller SHALL 将最大并发数动态降至 1；WHEN Memory_Pressure_Level 从 warning 恢复至 normal, THE Concurrency_Controller SHALL 将最大并发数恢复至配置值

### 需求 5：临时文件及时清理

**用户故事：** 作为开发者，我希望每个片段处理完成后立即清理其临时文件，以便磁盘空间和内存映射不会持续累积。

#### 验收标准

1. WHEN 单个片段的帧提取和分析完成后, THE Video_Analyzer SHALL 在返回分析结果之前同步删除该片段的所有临时帧文件（包括中间帧 PNG 文件和临时目录）
2. WHEN 单个片段的黑帧检测完成后, THE Black_Frame_Detector SHALL 在返回检测结果之前同步删除该片段的所有临时帧文件（包括采样帧 PNG 文件）
3. WHEN 单个片段的垃圾片段检测完成后, THE Junk_Clip_Detector SHALL 在返回检测结果之前同步删除该片段的所有临时帧文件（包括运动分析用帧文件）
4. WHEN 音频归一化的单个片段处理完成且归一化后的音频数据已被合成步骤读取后, THE Audio_Normalizer SHALL 删除该片段的中间归一化音频文件
5. WHEN 单个片段的所有处理步骤（帧分析、黑帧检测、垃圾片段检测、音频归一化）完成后, THE Stream_Processor SHALL 验证该片段的临时目录中剩余文件数为 0
6. IF 临时文件删除失败, THEN THE Stream_Processor SHALL 记录包含文件路径和错误原因的警告日志并继续处理，不中断整体流程
7. IF Stream_Processor 验证发现临时目录中仍存在残留文件, THEN THE Stream_Processor SHALL 尝试强制删除残留文件并记录警告日志

### 需求 6：近黑帧检测增强

**用户故事：** 作为用户，我希望系统能识别不仅是纯黑帧，还包括极暗画面（如镜头盖半遮挡、极暗环境无有效内容）的片段，以便这些无用片段也被自动排除。

#### 验收标准

1. THE Black_Frame_Detector SHALL 支持 Near_Black_Frame 检测模式，对每个采样帧使用近黑亮度阈值（默认 20，范围 1-255）判定该帧是否为近黑帧，该阈值独立于纯黑帧阈值（默认 10）
2. WHEN 片段中 Near_Black_Frame 占比超过近黑帧占比阈值（默认 0.9，即 90% 的采样帧亮度低于近黑阈值）, THE Black_Frame_Detector SHALL 将该片段标记为近黑帧片段（isNearBlackSegment = true）
3. THE Black_Frame_Detector SHALL 在检测结果中同时输出 blackFrameRatio 和 nearBlackRatio 两个独立字段，其中纯黑帧片段判定条件为 blackFrameRatio > 0.8，近黑帧片段判定条件为 nearBlackRatio > 0.9；当片段同时满足两个条件时，优先标记为纯黑帧片段
4. THE Black_Frame_Detector SHALL 支持通过环境变量 VIDEO_NEAR_BLACK_THRESHOLD 配置近黑亮度阈值（默认 20）；IF 环境变量值不在 1-255 范围内或非数字, THEN THE Black_Frame_Detector SHALL 使用默认值 20
5. THE Black_Frame_Detector SHALL 支持通过环境变量 VIDEO_NEAR_BLACK_RATIO 配置近黑帧占比阈值（默认 0.9）；IF 环境变量值不在 0.0-1.0 范围内或非数字, THEN THE Black_Frame_Detector SHALL 使用默认值 0.9
6. WHEN 片段被标记为近黑帧片段（isNearBlackSegment = true）且未被标记为纯黑帧片段, THE Video_Editor SHALL 在片段选择时将其排除，与纯黑帧片段的排除逻辑一致


### 需求 7：镜头遮挡检测

**用户故事：** 作为用户，我希望系统能识别镜头被手指或物体遮挡的片段，以便这些无效内容被自动排除。

#### 验收标准

1. THE Junk_Clip_Detector SHALL 支持 Lens_Occlusion 检测，通过分析采样帧的颜色方差和边缘密度识别遮挡：当帧的颜色方差低于 VIDEO_OCCLUSION_VARIANCE_THRESHOLD 且边缘密度低于 VIDEO_OCCLUSION_EDGE_THRESHOLD 时，判定该帧为遮挡帧
2. WHEN 片段中超过 70% 的采样帧被判定为遮挡帧（颜色方差低于阈值且边缘密度低于阈值）, THE Junk_Clip_Detector SHALL 将该片段标记为 junk，reason 为 "lens_occlusion"
3. THE Junk_Clip_Detector SHALL 对每个片段均匀采样 5 帧用于遮挡检测分析，每帧缩放至 64x64 灰度图像进行计算
4. THE Junk_Clip_Detector SHALL 支持通过环境变量 VIDEO_OCCLUSION_VARIANCE_THRESHOLD 配置颜色方差阈值（默认 300）
5. THE Junk_Clip_Detector SHALL 支持通过环境变量 VIDEO_OCCLUSION_EDGE_THRESHOLD 配置边缘密度阈值（默认 0.05）
6. WHEN 多个废片条件同时满足时, THE Junk_Clip_Detector SHALL 按优先级顺序报告第一个匹配的原因：too_short > extreme_blur > ground_shot > lens_occlusion > accidental_touch
7. IF 遮挡检测过程中某帧提取失败, THEN THE Junk_Clip_Detector SHALL 跳过该帧并继续分析剩余采样帧，仅基于成功提取的帧计算遮挡帧占比

### 需求 8：音频归一化流式优化

**用户故事：** 作为开发者，我希望音频归一化过程不将整个音频文件加载到内存中，以便处理大文件时不会导致内存溢出。

#### 验收标准

1. THE Audio_Normalizer SHALL 通过 spawn 启动 ffmpeg 子进程并使用文件路径参数（-i filepath）传递输入，不将音频文件内容读入 Node.js 进程的 Buffer 或字符串变量中，使得 Node.js 进程在归一化期间的堆内存增长不超过 50MB
2. WHEN 批量归一化多个片段时, THE Audio_Normalizer SHALL 串行处理各片段（逐个分析、逐个归一化），确保任意时刻最多只有 1 个 ffmpeg 子进程处于运行状态
3. WHEN 单个片段归一化完成后, THE Audio_Normalizer SHALL 在 ffmpeg 子进程退出后关闭所有关联的文件描述符，并将该片段的输入路径变量置为 null，使操作系统可回收相关资源
4. WHEN 归一化输出文件已被后续合成步骤读取完毕, THE Audio_Normalizer SHALL 不持有对输出文件的文件描述符或写锁，使调用方可直接通过 fs.unlink 删除归一化中间文件
5. IF 单个 ffmpeg 子进程的 RSS 内存超过 512MB, THEN THE Audio_Normalizer SHALL 记录包含进程 PID 和当前 RSS 值的警告日志，并继续处理而不终止该进程
6. THE Audio_Normalizer SHALL 每 5 秒轮询一次正在运行的 ffmpeg 子进程的 RSS 内存占用

### 需求 9：多版本输出配置调整

**用户故事：** 作为用户，我希望系统生成 30 秒精华、1 分钟摘要和 5 分钟完整剪辑三个版本，以便在不同场景下使用不同时长的视频。

#### 验收标准

1. THE Multi_Version_Generator SHALL 支持三个预定义版本配置："highlight"（30 秒）、"summary"（60 秒）、"extended"（300 秒）
2. WHEN 源视频时长严格小于某版本的目标时长, THE Multi_Version_Generator SHALL 跳过该版本的生成，并在输出结果中标注该版本状态为 "skipped" 及跳过原因
3. WHEN 生成 "highlight" 版本时, THE Multi_Version_Generator SHALL 严格按片段 overallScore 降序选择片段，累计时长达到目标时长即停止选择
4. WHEN 生成 "summary" 版本时, THE Multi_Version_Generator SHALL 将源视频时间线等分为 3 段区间，从每个区间中按 overallScore 降序选择片段，使每个区间至少贡献 1 个片段，直到累计时长达到目标时长
5. WHEN 生成 "extended" 版本时, THE Multi_Version_Generator SHALL 包含所有 overallScore 不低于 30（满分 100）的非废片、非黑帧片段
6. FOR ALL 版本配置, THE Multi_Version_Generator SHALL 保持选中片段的时间顺序
7. THE Multi_Version_Generator SHALL 支持通过环境变量 VIDEO_HIGHLIGHT_DURATION、VIDEO_SUMMARY_DURATION、VIDEO_EXTENDED_DURATION 分别配置各版本目标时长，各环境变量的有效范围为 5 秒至 600 秒的正整数
8. IF 环境变量值不在有效范围内或格式非法, THEN THE Multi_Version_Generator SHALL 忽略该环境变量并使用对应版本的默认时长
9. FOR ALL 版本配置, THE Multi_Version_Generator SHALL 输出的版本时长不超过目标时长，且当可用片段充足时不低于目标时长的 80%


### 需求 10：多版本生成内存优化

**用户故事：** 作为开发者，我希望多版本生成过程串行执行各版本的合成，以便不会因为同时生成多个版本而导致内存叠加。

#### 验收标准

1. WHEN 生成多个版本时, THE Multi_Version_Generator SHALL 串行生成各版本（完成一个版本的合成和存储后再开始下一个）
2. WHEN 单个版本合成完成并保存到存储后, THE Multi_Version_Generator SHALL 立即删除该版本的临时合成文件
3. WHEN 每个版本生成开始前, THE Multi_Version_Generator SHALL 检查 Memory_Pressure_Level
4. IF Memory_Pressure_Level 为 critical, THEN THE Multi_Version_Generator SHALL 暂停等待内存恢复至 warning 或 normal 级别，等待时间不超过 60 秒
5. IF 等待 60 秒后 Memory_Pressure_Level 仍为 critical, THEN THE Multi_Version_Generator SHALL 跳过当前版本、记录错误日志、并继续尝试下一个版本
6. WHEN 多版本生成过程中某个版本失败, THE Multi_Version_Generator SHALL 清理该版本的所有临时文件后继续生成下一个版本
7. THE Multi_Version_Generator SHALL 复用已提取的片段文件，避免为每个版本重复提取相同片段
8. WHEN 所有版本生成完成或失败后, THE Multi_Version_Generator SHALL 删除所有共享的临时片段文件（无论各版本成功或失败）

### 需求 11：帧提取内存优化

**用户故事：** 作为开发者，我希望帧提取过程逐帧处理并立即释放已分析帧的内存，以便大量帧不会同时驻留在内存中。

#### 验收标准

1. WHEN 提取多帧进行分析时, THE Video_Analyzer SHALL 逐帧顺序提取、分析、释放，任意时刻内存中最多保留1帧的像素数据（稳定性比较期间最多2帧）
2. WHEN 使用 sharp 处理帧图像时, THE Video_Analyzer SHALL 在获取分析结果后、下一次 await 调用之前，将 sharp 返回的 Buffer 引用置为不可达（不再持有变量引用）
3. WHEN 单帧分析完成时, THE Video_Analyzer SHALL 立即删除该帧对应的临时文件，不等到整个片段分析完成
4. WHEN 稳定性估计完成首尾帧像素比较时, THE Video_Analyzer SHALL 在比较循环结束后、返回稳定性分数之前，将两帧的像素 Buffer 引用置为不可达
5. WHEN 进行像素级计算（稳定性估计和曝光分析）时, THE Video_Analyzer SHALL 将帧图像缩放至 64x64 灰度后再进行计算，不对原始分辨率像素数据执行逐像素遍历
6. IF 临时帧文件删除失败, THEN THE Video_Analyzer SHALL 记录警告日志并继续处理后续帧，不中断整体分析流程

### 需求 12：处理管线整体内存保护

**用户故事：** 作为开发者，我希望整个视频处理管线有统一的内存保护机制，以便任何阶段的内存异常都不会导致进程崩溃。

#### 验收标准

1. WHEN 视频处理管线启动时, THE Memory_Manager SHALL 注册内存监控定时器，每 5 秒检查一次 Memory_Pressure_Level，并在管线完成或异常终止时清除该定时器
2. WHEN 批量处理多个视频时, THE Memory_Manager SHALL 确保同一时间只有一个视频在进行完整的处理管线（分析 → 检测 → 归一化 → 合成）
3. IF 单个视频处理过程中发生 OOM 相关错误（ENOMEM、allocation failed）, THEN THE Memory_Manager SHALL 捕获错误、记录详细日志（包含当前 RSS、处理阶段、视频信息）、清理该视频产生的所有临时帧文件和中间合成文件、将该视频标记为处理失败状态、继续处理下一个视频
4. THE Memory_Manager SHALL 在每个处理阶段（分析、黑帧检测、垃圾检测、归一化、合成、存储）完成后、下一阶段开始前检查 Memory_Pressure_Level
5. WHEN 处理阶段之间的内存检查发现 Memory_Pressure_Level 为 critical, THE Memory_Manager SHALL 以 5 秒为间隔轮询等待 Memory_Pressure_Level 恢复至 warning 或 normal，最多等待 60 秒；超时后记录错误（包含当前 RSS 和等待时长）并跳过当前视频
6. WHEN 处理管线完成（所有视频处理结束或批量任务中止）时, THE Memory_Manager SHALL 输出内存使用摘要日志，包含峰值 RSS（MB）、各阶段平均 RSS（MB）、GC 触发次数、跳过的视频数量及原因
7. IF 视频因内存超时或 OOM 错误被跳过, THEN THE Memory_Manager SHALL 在批量处理结果摘要中记录该视频的标识、失败阶段和失败原因
