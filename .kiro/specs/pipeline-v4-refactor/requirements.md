# Requirements Document

## Introduction

本次重构的目标是将图片处理流水线从当前的"算法服务直接写数据库"架构，改造为"评估 → 归并 → 写入"三段式架构。核心问题：当前分类失败会级联导致模糊检测结果丢失，去重在下载或模型失败时静默退化为空结果，且多个服务各自写 DB 导致部分写入和不一致。

重构后的流水线遵循三条原则：
1. 每个能力（classify、blur、dedup）独立成功/失败
2. 算法服务只返回评估结果，不直接写 DB
3. 只有一个地方（resultWriter）写数据库

流水线阶段：收集输入 → 分类评估 → 模糊评估 → 去重评估 → 归并结果（reducer）→ 写入 DB（writer）

## Glossary

- **Pipeline**: 图片处理流水线，从输入收集到最终 DB 写入的完整处理流程
- **Assessment**: 算法服务对单张图片某一能力维度的评估结果（纯数据，不含副作用）
- **ClassificationAssessment**: 分类评估结果，包含 category、categoryScores、source（Python/Rekognition/fallback）
- **BlurAssessment**: 模糊评估结果，包含 sharpnessScore、blurStatus、source（Python/Node）
- **DedupAssessment**: 去重评估结果，包含确认重复对列表、每组保留索引
- **ImageProcessContext**: 单张图片的处理上下文，包含 mediaId、filePath、localPath 及各阶段评估结果
- **PerImageFinalDecision**: 归并后的单张图片最终决策，包含最终 blurStatus、category、是否被去重移除等
- **ResultReducer**: 归并模块，将多个 Assessment 按优先级合并为 PerImageFinalDecision
- **ResultWriter**: 唯一的 DB 写入模块，接收 PerImageFinalDecision 列表并批量更新数据库
- **Orchestrator**: 流水线编排器（runTripProcessingPipeline），协调各阶段的调用顺序和错误处理
- **Fallback_Chain**: 回退链，Python > Rekognition > Node 的优先级顺序
- **PROCESS_THRESHOLDS**: 统一的阈值配置对象，集中管理所有处理阈值

## Requirements

### Requirement 1: 统一数据结构定义

**User Story:** 作为开发者，我希望有统一的类型定义来描述流水线各阶段的输入输出，以便各模块之间通过明确的接口契约通信。

#### Acceptance Criteria

1. THE Pipeline SHALL define an ImageProcessContext type containing mediaId, tripId, filePath, localPath, downloadOk, downloadError, processingErrors array, and nullable slots for ClassificationAssessment, BlurAssessment, and DedupAssessment
2. THE Pipeline SHALL define a ClassificationAssessment type containing category, categoryScores, and source field indicating the provider (python, rekognition, or fallback)
3. THE Pipeline SHALL define a BlurAssessment type containing sharpnessScore, blurStatus, musiqScore, and source field indicating the provider (python or node)
4. THE Pipeline SHALL define a DedupAssessment type containing confirmedPairs, groups, kept list, removed list, skippedIndices, skippedReasons map, capabilitiesUsed record, and evidenceByPair array
5. THE Pipeline SHALL define a PerImageFinalDecision type containing finalBlurStatus, finalCategory, trashedReasons array (not comma-joined string), qualityScore, and all fields needed by ResultWriter to update the database
6. WHEN any Assessment type is produced by an algorithm service, THE Assessment SHALL contain only pure data with no database handles or side effects

### Requirement 2: 流水线编排器

**User Story:** 作为开发者，我希望有一个编排器按固定顺序调用各评估阶段，以便流水线的执行流程清晰可控。

#### Acceptance Criteria

1. THE Orchestrator SHALL execute stages in the order: collect inputs → classify assessment → blur assessment → dedup assessment → reduce → write
2. WHEN the classify assessment stage fails, THE Orchestrator SHALL record the error and continue to the blur assessment stage with the classify slot set to null
3. WHEN the blur assessment stage fails, THE Orchestrator SHALL record the error and continue to the dedup assessment stage with the blur slot set to null
4. WHEN the dedup assessment stage fails, THE Orchestrator SHALL record the error and continue to the reduce stage with the dedup slot set to null
5. THE Orchestrator SHALL return a ProcessResult summary containing counts for totalImages, blurryDeletedCount, dedupDeletedCount, classifiedCount, failedCount, skippedCount, partialFailureCount, and downloadFailedCount
6. WHEN all three assessment stages fail for a given image, THE Orchestrator SHALL mark the image with processingError and retain the image as active with category set to other
7. THE Orchestrator SHALL support partial per-image failure within a stage — a single image failure SHALL only null out that image's assessment, not the entire stage result

### Requirement 3: 分类评估纯函数化

**User Story:** 作为开发者，我希望分类服务只返回评估结果而不写数据库，以便分类失败不会影响其他处理阶段的结果。

#### Acceptance Criteria

1. WHEN Python is available, THE ClassificationAssessment SHALL be produced by calling Python CLIP analysis and returning category and categoryScores with source set to python
2. WHEN Python is unavailable and AWS Rekognition is configured, THE ClassificationAssessment SHALL be produced by calling Rekognition DetectLabels and returning the mapped category with source set to rekognition
3. WHEN both Python and Rekognition are unavailable, THE ClassificationAssessment SHALL return category as other with source set to fallback
4. THE imageClassifier module SHALL export a pure assessment function that accepts an image buffer or path and returns a ClassificationAssessment without executing any database statements
5. IF Python classification returns error for a specific image, THEN THE Orchestrator SHALL attempt Rekognition classification for that image before falling back to other

### Requirement 4: 模糊检测评估纯函数化

**User Story:** 作为开发者，我希望模糊检测服务只返回评估结果而不写数据库，以便模糊检测失败不会影响分类或去重结果。

#### Acceptance Criteria

1. WHEN Python is available, THE BlurAssessment SHALL be produced by Python OpenCV blur detection returning blurScore and blurStatus with source set to python
2. WHEN Python is unavailable, THE BlurAssessment SHALL be produced by Node.js Laplacian variance computation returning sharpnessScore and blurStatus with source set to node
3. THE blurDetector module SHALL export a pure assessment function that accepts an image path and returns a BlurAssessment without executing any database statements or modifying media item status
4. WHEN the Node.js blur assessment also fails for a specific image, THE BlurAssessment SHALL return blurStatus as suspect with sharpnessScore as null and an error message

### Requirement 5: 去重评估纯函数化

**User Story:** 作为开发者，我希望去重引擎只返回评估结果而不写数据库，以便去重失败时已有的模糊和分类结果不受影响。

#### Acceptance Criteria

1. THE hybridDedupEngine SHALL export a pure assessment function that accepts image rows and returns a DedupAssessment containing confirmedPairs, groups, kept, and removed lists without executing any database statements
2. WHEN Python is available, THE DedupAssessment SHALL use the four-layer hybrid dedup pipeline (Layer 0 hash + Layer 1 CLIP/DINOv2 + Layer 2 LLM/strict threshold + Layer 3 Union-Find)
3. WHEN Python is unavailable, THE DedupAssessment SHALL use only Layer 0 hash pre-filter and Layer 3 Union-Find grouping
4. WHEN image downloads fail during dedup, THE DedupAssessment SHALL process only successfully downloaded images and report skipped images in the assessment result
5. THE hybridDedupEngine SHALL self-detect Python and ML service availability at runtime instead of receiving a pythonAvailable flag from the caller

### Requirement 6: 结果归并器（ResultReducer）

**User Story:** 作为开发者，我希望有一个归并模块按优先级合并各评估结果为最终决策，以便每张图片的最终状态由明确的规则决定。

#### Acceptance Criteria

1. THE ResultReducer SHALL merge ClassificationAssessment, BlurAssessment, and DedupAssessment into a PerImageFinalDecision for each image
2. WHEN multiple classification sources are available, THE stage (not the Reducer) SHALL resolve the fallback chain: Python > Rekognition > fallback, and pass only the winning result to the Reducer
3. WHEN multiple blur sources are available, THE stage (not the Reducer) SHALL resolve the fallback chain: Python > Node, and pass only the winning result to the Reducer
4. WHEN an image is marked as blurry by BlurAssessment, THE ResultReducer SHALL add 'blur' to trashedReasons array and set finalStatus to trashed
5. WHEN an image is marked as removed by DedupAssessment, THE ResultReducer SHALL add 'duplicate' to trashedReasons array and set finalStatus to trashed
6. WHEN an image is marked as both blurry and duplicate, THE ResultReducer SHALL set trashedReasons to ['blur', 'duplicate']
7. WHEN all assessments for an image are null, THE ResultReducer SHALL set finalStatus to active with category set to other and blurStatus set to suspect
8. THE ResultReducer SHALL NOT perform multi-source priority selection — fallback chains (Python → Rekognition → fallback for classify, Python → Node for blur) SHALL be resolved within each stage, and the ResultReducer SHALL only receive the final winning assessment per image

### Requirement 7: 唯一数据库写入点（ResultWriter）

**User Story:** 作为开发者，我希望只有一个模块负责写数据库，以便消除部分写入和级联失败问题。

#### Acceptance Criteria

1. THE ResultWriter SHALL be the only module in the pipeline that executes database write statements for media_items and media_tags tables
2. THE ResultWriter SHALL accept a list of PerImageFinalDecision and update all corresponding media_items rows in a single database transaction
3. WHEN the database transaction fails, THE ResultWriter SHALL roll back all changes and report the error to the Orchestrator
4. THE ResultWriter SHALL update blur_status, sharpness_score, category, status, trashed_reason, and processing_error fields for each media item
5. THE ResultWriter SHALL delete old category tags and insert new category tags for each media item within the same transaction
6. THE blurDetector, imageClassifier, and hybridDedupEngine modules SHALL contain zero database import statements after refactoring
7. THE current version SHALL NOT maintain a separate duplicate_groups table — dedup results are reflected only in media_items.status and trashed_reason

### Requirement 8: 路由层精简

**User Story:** 作为开发者，我希望 process.ts 路由只负责请求验证和调用编排器，以便路由层不包含业务逻辑。

#### Acceptance Criteria

1. THE process route handler SHALL validate the trip exists and delegate all processing to the Orchestrator
2. THE process route handler SHALL contain zero direct calls to blurDetector, imageClassifier, or hybridDedupEngine
3. THE process route handler SHALL pass the Orchestrator result directly as the HTTP response without additional database queries for building the response
4. THE SSE streaming route handler SHALL receive progress callbacks from the Orchestrator and forward progress events to the client
5. THE process route handler SHALL contain zero classify/blur/dedup fallback logic, per-image apply logic, or direct DB update logic — all processing logic SHALL live under server/src/services/pipeline/

### Requirement 9: Python analyze.py 独立错误返回

**User Story:** 作为开发者，我希望 Python analyze.py 对分类和模糊检测返回独立的错误状态，以便一个能力失败时另一个的结果仍然可用。

#### Acceptance Criteria

1. WHEN classification fails for an image but blur detection succeeds, THE analyze.py SHALL return error as true with errorMessage describing the classification failure, while blur_status and blur_score contain valid values
2. WHEN blur detection fails for an image but classification succeeds, THE analyze.py SHALL return category and category_scores with valid values, while blur_status is set to unknown and blur_score is set to null
3. THE analyze.py output format SHALL include separate error fields for classification (classify_error) and blur detection (blur_error) instead of a single shared error boolean
4. THE analyze.py output format SHALL NOT include any image-level shared error boolean — errors MUST be capability-scoped only (classify_error and blur_error)

### Requirement 10: 统一阈值配置

**User Story:** 作为开发者，我希望所有处理阈值集中在一个配置对象中管理，以便调参时只需修改一处。

#### Acceptance Criteria

1. THE dedupThresholds module SHALL export a unified PROCESS_THRESHOLDS configuration object containing blur thresholds (blurThreshold, clearThreshold, musiqBlurThreshold), dedup thresholds (hashHammingThreshold, clipConfirmedThreshold, clipGrayHighThreshold, clipGrayLowThreshold, clipStrictThreshold, clipTopK), and sequence/hash distance limits
2. THE PROCESS_THRESHOLDS object SHALL support environment variable overrides for each threshold value
3. THE Pipeline modules SHALL read threshold values exclusively from PROCESS_THRESHOLDS instead of defining local constants or accepting threshold parameters
