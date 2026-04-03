# Requirements Document

## Introduction

图片处理管线 V2 对现有图片处理流程进行全面升级，解决四个核心问题：模糊检测误判率高、相似图片聚类误合并、质量评分过度偏向分辨率、图片优化管线顺序错误且过于激进。所有改进必须基于 sharp (Node.js) API 实现。

## Glossary

- **Blur_Detector**: 负责检测图片模糊程度并分类的服务模块 (`blurDetector.ts`)
- **Dedup_Engine**: 负责计算感知哈希并聚类相似图片的服务模块 (`dedupEngine.ts`)
- **Quality_Selector**: 负责计算图片质量评分并在重复组中选择最佳图片的服务模块 (`qualitySelector.ts`)
- **Image_Optimizer**: 负责对图片执行优化处理管线的服务模块 (`imageOptimizer.ts`)
- **Pipeline_Orchestrator**: 负责协调各处理步骤执行顺序的路由处理器 (`process.ts`)
- **Laplacian_Variance**: 通过拉普拉斯卷积核计算图像灰度方差来衡量清晰度的算法
- **dHash**: 差异哈希算法，将图片缩放为 9×8 灰度图后比较相邻像素生成 64 位指纹
- **pHash**: 感知哈希算法，本项目中使用 sharp 实现的基于 DCT 近似的感知哈希（将图片缩放为 32×32 灰度图，计算 8×8 DCT 子矩阵的中值比较），对亮度和对比度变化更鲁棒。注意：标准 pHash 依赖完整 DCT 变换，sharp 不直接提供 DCT API，因此实现为近似版本——将图片缩放为 32×32 灰度后取 raw 像素，用均值二值化生成 64 位指纹。这不是学术标准的 pHash，但在 sharp-only 约束下是合理的近似，比单一 dHash 多了一层分辨率和频率信息。
- **Hamming_Distance**: 两个哈希值之间不同比特位的数量，用于衡量图片相似度
- **Exemplar_Clustering**: 基于中心样本的聚类方法，每个成员必须与组中心相似，避免链式传递合并
- **EXIF_Metadata**: 图片文件中嵌入的拍摄参数信息（相机型号、拍摄时间、GPS 等）
- **CLAHE**: 对比度受限自适应直方图均衡化，用于局部对比度增强
- **Blur_Status**: 图片模糊状态分类，取值为 'clear'、'suspect'、'blurry'
- **Hard_Threshold**: 模糊检测的硬阈值，低于此值的图片直接标记为 blurry
- **Soft_Threshold**: 模糊检测的软阈值，介于硬阈值和软阈值之间的图片标记为 suspect

## Requirements

### Requirement 1: 双阈值模糊检测

**User Story:** As a 用户, I want 模糊检测使用双阈值系统区分"确定模糊"和"疑似模糊", so that 不会因为单一阈值误判而丢失可能有价值的照片。

#### Acceptance Criteria

1. WHEN Blur_Detector 分析一张图片且 Laplacian_Variance 低于 Hard_Threshold (默认 50), THE Blur_Detector SHALL 将该图片的 blur_status 设置为 'blurry' 并将 status 设置为 'trashed'、trashed_reason 设置为 'blur'。
2. WHEN Blur_Detector 分析一张图片且 Laplacian_Variance 介于 Hard_Threshold 和 Soft_Threshold (默认 150) 之间, THE Blur_Detector SHALL 将该图片的 blur_status 设置为 'suspect' 并保持 status 为 'active'。
3. WHEN Blur_Detector 分析一张图片且 Laplacian_Variance 高于或等于 Soft_Threshold, THE Blur_Detector SHALL 将该图片的 blur_status 设置为 'clear'。
4. IF Laplacian_Variance 计算过程中发生异常, THEN THE Blur_Detector SHALL 将 processing_error 字段记录具体错误信息，并将 blur_status 设置为 'suspect'（而非默认为 0 导致误判为 blurry）。
5. THE Blur_Detector SHALL 接受可选的 hardThreshold 和 softThreshold 参数以覆盖默认值。
6. WHEN hardThreshold 参数值大于或等于 softThreshold 参数值, THE Blur_Detector SHALL 拒绝执行并返回参数校验错误。

### Requirement 2: 改进相似图片聚类

**User Story:** As a 用户, I want 相似图片聚类更加精确, so that 不会因为链式传递将完全不同的图片错误地合并到同一组。

#### Acceptance Criteria

1. WHEN Dedup_Engine 计算 dHash, THE Dedup_Engine SHALL 使用 fit:'cover' 进行缩放（而非 fit:'fill'），以保持原始宽高比并填满目标尺寸。
2. THE Dedup_Engine SHALL 使用收紧后的默认 Hamming_Distance 阈值 (默认 5，原为 10) 进行 dHash 比较。
3. WHEN 两张图片的 dHash Hamming_Distance 低于阈值, THE Dedup_Engine SHALL 使用第二层哈希 (pHash) 进行确认，仅当两层哈希均判定相似时才视为匹配。
4. THE Dedup_Engine SHALL 使用 Exemplar_Clustering 替代纯 Union-Find 聚类：每个候选成员必须与组的中心样本（exemplar）相似，而非仅与组内任意成员相似。
5. WHEN Dedup_Engine 完成聚类, THE Dedup_Engine SHALL 将每张图片的 dHash 和 pHash 值均存储到数据库。
6. THE Dedup_Engine SHALL 接受可选的 dHash 阈值和 pHash 阈值参数以覆盖默认值。

### Requirement 3: 多维质量评分

**User Story:** As a 用户, I want 质量评分综合考虑清晰度、曝光、对比度等多个维度, so that 在重复组中选出的"最佳"照片是真正视觉质量最好的。

#### Acceptance Criteria

1. THE Quality_Selector SHALL 计算以下质量维度：sharpness（清晰度）、exposure（曝光度）、contrast（对比度）、resolution（分辨率）、noise_artifact（噪声/压缩伪影程度）、file_size（文件大小）。
2. THE Quality_Selector SHALL 使用加权公式计算 overall 评分：sharpness 40%、exposure + contrast 20%、resolution 20%、noise_artifact 10%、file_size 10%。
3. WHEN Quality_Selector 计算 exposure 评分, THE Quality_Selector SHALL 基于图片直方图的均值偏离中间值的程度进行评分（越接近中间值越好）。
4. WHEN Quality_Selector 计算 contrast 评分, THE Quality_Selector SHALL 基于图片直方图的标准差进行评分（适中的标准差优于极端值）。
5. WHEN Quality_Selector 计算 noise_artifact 评分, THE Quality_Selector SHALL 基于高频分量的比例进行评分（高频噪声越少越好）。
6. THE Quality_Selector SHALL 将所有维度评分（exposure_score、contrast_score、noise_score）存储到 media_items 表的对应字段。
7. WHEN 任一维度评分计算失败, THE Quality_Selector SHALL 将该维度记录为 null 并在 overall 计算中使用剩余维度的归一化权重。
8. THE Quality_Selector SHALL 将每个维度评分归一化到 0.0–1.0 范围：sharpness 使用 min(laplacianVariance / 500, 1.0)；exposure 使用 1.0 - |mean - 128| / 128；contrast 使用基于标准差的钟形曲线（标准差 50-70 为最优区间）；resolution 使用 min(width × height / 12000000, 1.0)（以 1200 万像素为满分）；noise_artifact 使用 1.0 - min(highFreqRatio, 1.0)；file_size 使用 min(fileSize / 5000000, 1.0)（以 5MB 为满分）。
9. THE Quality_Selector SHALL 复用 Blur_Detector 已计算的 sharpness_score（Laplacian_Variance），避免重复计算。

### Requirement 4: 优化图片处理管线

**User Story:** As a 用户, I want 图片优化管线使用正确的处理顺序和参数, so that 优化后的图片质量优于原图而非引入伪影。

#### Acceptance Criteria

1. THE Image_Optimizer SHALL 按以下顺序执行处理管线：轻度降噪 → 亮度/对比度校正 → 轻度锐化。
2. WHEN Image_Optimizer 执行降噪步骤, THE Image_Optimizer SHALL 使用 sharp 的 median(3) 进行轻度中值滤波降噪。
3. WHEN Image_Optimizer 执行亮度/对比度校正步骤, THE Image_Optimizer SHALL 使用 sharp 的 gamma() 和/或 clahe() 进行自适应校正（而非固定 brightness:1.0 的无效操作）。
4. WHEN Image_Optimizer 执行锐化步骤, THE Image_Optimizer SHALL 使用 sigma 值在 0.5 到 0.8 之间的 sharpen()（而非当前过于激进的 sigma:1.0）。
5. THE Image_Optimizer SHALL 在输出时保留原始 EXIF_Metadata（使用 sharp 的 withMetadata() 方法）。
6. THE Image_Optimizer SHALL 移除当前的 normalize() 调用，或将其替换为更温和的处理方式。
7. THE Image_Optimizer SHALL 移除当前的 modulate({ brightness: 1.0 }) 无效调用。

### Requirement 5: 数据库 Schema 扩展

**User Story:** As a 开发者, I want 数据库表结构支持新增的质量维度和模糊状态字段, so that 所有新的处理结果能够持久化存储。

#### Acceptance Criteria

1. THE Pipeline_Orchestrator SHALL 在 media_items 表中新增 blur_status 字段，类型为 TEXT，取值为 'clear'、'suspect'、'blurry'。
2. THE Pipeline_Orchestrator SHALL 在 media_items 表中新增 exposure_score 字段，类型为 REAL，可为 null。
3. THE Pipeline_Orchestrator SHALL 在 media_items 表中新增 contrast_score 字段，类型为 REAL，可为 null。
4. THE Pipeline_Orchestrator SHALL 在 media_items 表中新增 noise_score 字段，类型为 REAL，可为 null。
5. THE Pipeline_Orchestrator SHALL 在 media_items 表中新增 phash 字段，类型为 TEXT，用于存储 pHash 值。
6. THE Pipeline_Orchestrator SHALL 通过 ALTER TABLE 迁移方式添加新字段，保持与现有数据的向后兼容。

### Requirement 6: 处理管线集成与顺序

**User Story:** As a 开发者, I want 处理管线各步骤按正确顺序执行并传递新参数, so that V2 的改进能在完整处理流程中生效。

#### Acceptance Criteria

1. THE Pipeline_Orchestrator SHALL 按以下顺序执行图片处理步骤：去重 → 模糊检测（计算清晰度） → 质量评分（复用模糊检测的清晰度分数） → 图片优化 → 缩略图生成 → 封面选择。
2. WHEN Pipeline_Orchestrator 调用 Blur_Detector, THE Pipeline_Orchestrator SHALL 传递 hardThreshold 和 softThreshold 参数（如果用户提供）。
3. WHEN Pipeline_Orchestrator 返回处理结果, THE Pipeline_Orchestrator SHALL 在响应中包含 blurry 数量和 suspect 数量（而非仅 blurryCount）。
4. WHEN Pipeline_Orchestrator 通过 SSE 流式报告进度, THE Pipeline_Orchestrator SHALL 为每个处理步骤报告 blurry 和 suspect 的分别计数。
