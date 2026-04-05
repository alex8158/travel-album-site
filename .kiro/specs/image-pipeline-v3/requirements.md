# 需求文档：图片处理流水线 V3

## 简介

对现有图片处理流水线进行全面重构，建立新的处理顺序：原图保存 → 模糊检测 → 去重 → 图片分析 → 自动修图参数生成 → 自动修图 → 自动分类 → 缩略图生成 → 封面选择 → 处理结果持久化完成 → 前端展示。主要变更包括：模糊检测后直接删除（保留删除日志）、滑动窗口去重（含保留规则）、基于图片分析的自适应修图、AWS Rekognition 图片分类（含优先级规则）、以及按分类分组的前端展示。

## 术语表

- **Pipeline（流水线）**: 图片从上传到展示的完整自动化处理链路
- **SharpnessScore（清晰度分数）**: 使用拉普拉斯方差（Laplacian Variance）计算的图片清晰度指标。**值越大越清晰，值越小越模糊**。
- **BlurDetector（模糊检测器）**: 计算图片清晰度分数并判定是否模糊的服务。清晰度分数低于阈值的图片被判定为模糊。
- **DedupEngine（去重引擎）**: 使用感知哈希和汉明距离检测并处理重复图片的服务
- **ImageAnalyzer（图片分析器）**: 分析原始图片的亮度、对比度、色偏、噪点等特征的服务
- **ImageOptimizer（图片优化器）**: 根据分析结果自适应调整图片参数的服务
- **ImageClassifier（图片分类器）**: 使用 AWS Rekognition detectLabels API 将图片分类为风景/动物/人物/其他的服务
- **HammingDistance（汉明距离）**: 两个哈希值之间不同比特位的数量（0-64），值越小表示图片越相似
- **SlidingWindow（滑动窗口）**: 去重时每张图片仅与后续 N 张图片比较的策略
- **GalleryPage（相册页面）**: 前端展示图片的页面组件
- **MediaItem（媒体项）**: 数据库中存储的单个媒体文件记录
- **Category（分类）**: 图片的内容分类标签，包括风景（landscape）、动物（animal）、人物（people）、其他（other）

## 需求

### 需求 1：原始图片存储保留

**用户故事：** 作为用户，我希望上传的原始图片保存在专用目录中，以便后续处理时始终可以访问原始文件。

#### 验收标准

1. WHEN 用户上传图片时，THE Pipeline SHALL 将原始图片保存到 `{tripId}/originals/` 目录下
2. WHILE 处理流水线执行期间，THE Pipeline SHALL 保留原始图片文件不做任何修改
3. IF 原始图片保存失败，THEN THE Pipeline SHALL 返回上传失败错误并记录错误信息

### 需求 2：模糊检测与删除

**用户故事：** 作为用户，我希望系统自动检测并永久删除模糊图片，以便相册中只保留清晰的照片。

#### 验收标准

1. WHEN 处理流水线启动时，THE BlurDetector SHALL 在去重之前先对所有图片执行模糊检测
2. WHEN 图片的清晰度分数（SharpnessScore，拉普拉斯方差）**低于**可配置阈值时，THE BlurDetector SHALL 判定该图片为模糊图片并永久删除（从存储和数据库中移除），而非移入回收站
3. WHERE 清晰度阈值可配置，THE BlurDetector SHALL 使用默认阈值 50（清晰度分数低于 50 视为模糊）
4. IF 模糊检测过程中发生错误，THEN THE BlurDetector SHALL 将该图片标记为 suspect 状态并记录错误信息，不删除该图片
5. WHEN 图片被删除时，THE BlurDetector SHALL 在处理日志中记录被删除图片的文件名、清晰度分数、删除原因和删除时间
6. THE Pipeline SHALL 在处理结果摘要中包含"删除了多少张模糊图"的统计数据

### 需求 3：滑动窗口去重

**用户故事：** 作为用户，我希望系统自动检测并去除连续拍摄的重复照片，以便相册中不出现大量相似图片。

#### 验收标准

1. WHEN 模糊检测完成后，THE DedupEngine SHALL 对剩余图片执行滑动窗口去重
2. THE DedupEngine SHALL 将每张图片仅与其后续最多 N 张图片进行比较（N 为可配置的窗口大小，默认值为 10）
3. WHEN 两张图片的汉明距离（HammingDistance）低于或等于可配置阈值时，THE DedupEngine SHALL 判定为重复并仅保留其中一张
4. THE DedupEngine SHALL 使用汉明距离（比特位差异数，范围 0-64）作为相似度度量，不使用百分比
5. WHERE 窗口大小可配置，THE DedupEngine SHALL 接受 windowSize 参数控制比较范围
6. WHERE 相似度阈值可配置，THE DedupEngine SHALL 接受 hammingThreshold 参数控制去重灵敏度（默认值为 5）
7. WHEN 两张图片被判定为重复时，THE DedupEngine SHALL 按以下优先级保留其中一张：① 优先保留清晰度分数（SharpnessScore）更高的；② 若清晰度接近（差值 < 10），则保留分辨率（width × height）更高的；③ 若仍相同，则保留序列中靠前的一张
8. THE Pipeline SHALL 在处理结果摘要中包含"去重删除了多少张图"的统计数据

### 需求 4：图片分析

**用户故事：** 作为用户，我希望系统在修图前先分析每张图片的特征，以便后续修图能针对性地优化。

#### 验收标准

1. WHEN 去重完成后，THE ImageAnalyzer SHALL 对每张存活图片分析以下特征：亮度（avg_brightness）、对比度（contrast_level）、色偏（color_cast_r、color_cast_g、color_cast_b）、噪点水平（noise_level）
2. THE ImageAnalyzer SHALL 将分析结果存储到数据库 media_items 表的以下字段：`avg_brightness REAL`、`contrast_level REAL`、`color_cast_r REAL`、`color_cast_g REAL`、`color_cast_b REAL`、`noise_level REAL`
3. THE ImageAnalyzer SHALL 为每张图片生成独立的分析结果，不同图片的分析结果相互独立
4. IF 图片分析失败，THEN THE ImageAnalyzer SHALL 将错误信息写入 `processing_error` 字段并继续处理下一张图片

### 需求 5：自适应自动修图

**用户故事：** 作为用户，我希望系统根据每张图片的实际特征自动优化，使照片看起来自然且美观。

#### 验收标准

1. WHEN 图片分析完成后，THE ImageOptimizer SHALL 根据分析结果为每张图片生成个性化的优化参数
2. THE ImageOptimizer SHALL 根据图片分析结果，按需执行亮度校正、对比度调整、色偏矫正、锐化强度控制，并可选执行保守的噪点抑制
3. THE ImageOptimizer SHALL 保持原始图片分辨率不变
4. THE ImageOptimizer SHALL 确保优化后的图片看起来自然，避免过度处理导致画面失真或泛白
5. WHEN 图片亮度正常（avg_brightness 在 90-170 范围内）时，THE ImageOptimizer SHALL 跳过亮度校正步骤
6. WHEN 图片对比度正常（contrast_level 在 40-80 范围内）时，THE ImageOptimizer SHALL 跳过对比度增强步骤
7. WHEN 图片无明显色偏（各通道偏差 < 10）时，THE ImageOptimizer SHALL 跳过色偏消除步骤
8. WHEN 图片噪点水平较低（noise_level < 0.3）时，THE ImageOptimizer SHALL 跳过噪点抑制步骤
9. THE ImageOptimizer SHALL 将优化后的图片保存到 `{tripId}/optimized/` 目录，并更新数据库中的 `optimized_path` 字段
10. IF 优化过程失败，THEN THE ImageOptimizer SHALL 将错误信息写入 `processing_error` 字段并继续处理下一张图片

### 需求 6：AWS Rekognition 图片分类

**用户故事：** 作为用户，我希望系统自动将图片分类为风景、动物、人物等类别，以便我能按类别浏览照片。

#### 验收标准

1. WHEN 自动修图完成后，THE ImageClassifier SHALL 使用 AWS Rekognition detectLabels API 对每张图片进行分类
2. THE ImageClassifier SHALL 将 Rekognition 返回的标签映射到以下四个分类之一：风景（landscape）、动物（animal）、人物（people）、其他（other）
3. WHEN Rekognition 返回包含 "Person"、"Human"、"Face" 等标签时，THE ImageClassifier SHALL 将图片分类为"人物"
4. WHEN Rekognition 返回包含 "Mountain"、"Beach"、"Sky"、"Ocean"、"Forest"、"Lake" 等标签时，THE ImageClassifier SHALL 将图片分类为"风景"
5. WHEN Rekognition 返回包含 "Dog"、"Cat"、"Bird"、"Animal" 等标签时，THE ImageClassifier SHALL 将图片分类为"动物"
6. WHEN 图片不明确属于以上任何分类时，THE ImageClassifier SHALL 将图片分类为"其他"
7. WHEN 图片同时命中多个分类时，THE ImageClassifier SHALL 按以下优先级确定主分类：人物 > 动物 > 风景 > 其他。同时可将次要分类作为附加标签保存。
8. THE ImageClassifier SHALL 将主分类结果存储到 media_items 表的 `category` 字段（值为 landscape/animal/people/other），并将所有匹配的分类作为标签存储到 media_tags 表中
9. IF AWS Rekognition API 调用失败，THEN THE ImageClassifier SHALL 将图片分类为"其他"并将错误信息写入 `processing_error` 字段

### 需求 7：前端按分类展示

**用户故事：** 作为用户，我希望在相册页面按分类标签浏览图片，以便快速找到特定类型的照片。

#### 验收标准

1. THE GalleryPage SHALL 以分类标签页形式展示图片，标签页包括：全部 | 风景 | 动物 | 人物 | 其他
2. THE GalleryPage SHALL 在每个标签页标题旁显示该分类下的图片数量
3. WHEN 用户点击某个分类标签时，THE GalleryPage SHALL 仅展示该分类下的图片网格
4. THE GalleryPage SHALL 默认选中"全部"标签页，显示所有图片
5. WHEN 某个分类下没有图片时，THE GalleryPage SHALL 在该标签页中显示空状态提示

### 需求 8：处理流水线顺序

**用户故事：** 作为开发者，我希望处理流水线按照明确的顺序执行各步骤，以确保每个步骤的输入数据正确。

#### 验收标准

1. THE Pipeline SHALL 按以下完整顺序执行处理步骤：原图保存 → 模糊检测 → 去重 → 图片分析 → 自动修图参数生成 → 自动修图 → 自动分类 → 缩略图生成 → 封面选择 → 处理结果持久化完成
2. THE Pipeline SHALL 确保每个步骤仅处理前一步骤输出的有效图片
3. THE Pipeline SHALL 通过 SSE 流式接口报告每个步骤的进度
4. IF 流水线中某个步骤失败，THEN THE Pipeline SHALL 记录错误并继续执行后续步骤
5. THE Pipeline SHALL 在所有步骤完成后返回包含各步骤统计数据的处理结果摘要（包括模糊删除数、去重删除数、优化成功数、分类统计等）

### 需求 9：缩略图生成

**用户故事：** 作为用户，我希望每张图片都有缩略图，以便在相册网格中快速加载预览。

#### 验收标准

1. WHEN 自动分类完成后，THE Pipeline SHALL 为每张存活的图片和视频生成缩略图
2. THE Pipeline SHALL 生成最大 400×400 像素的 WebP 格式缩略图，保持原始宽高比
3. THE Pipeline SHALL 根据 EXIF orientation 自动旋转缩略图方向
4. THE Pipeline SHALL 将缩略图保存到 `{tripId}/thumbnails/` 目录，并更新数据库中的 `thumbnail_path` 字段
5. IF 缩略图生成失败，THEN THE Pipeline SHALL 记录错误信息并继续处理下一张

### 需求 10：封面选择

**用户故事：** 作为用户，我希望系统自动为相册选择一张合适的封面图。

#### 验收标准

1. WHEN 缩略图生成完成后，THE Pipeline SHALL 自动选择一张图片作为相册封面
2. THE Pipeline SHALL 优先选择质量评分最高的图片作为封面
3. THE Pipeline SHALL 将封面图片 ID 更新到 trips 表的 `cover_image_id` 字段
4. IF 相册中没有图片（全部被模糊检测或去重删除），THEN THE Pipeline SHALL 不设置封面
