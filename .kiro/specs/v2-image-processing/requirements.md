# Requirements Document

## Introduction

本 spec 覆盖 v2 智能媒体处理系统的第二阶段：图片处理增强。在第一阶段（v2-schema-foundation）完成了数据库 schema 增强（media_versions、media_analysis、duplicate_group_items、ai_invocations 四张表及 CRUD API）的基础上，本阶段聚焦三个核心能力：

1. **色偏检测（Color Cast Detection）** — 基于图像统计分析检测照片色偏问题（偏暖/偏冷/绿色色偏等），产出量化评分存入 media_analysis
2. **AI Provider 抽象（AI Provider Abstraction）** — 创建统一的 AI 提供商接口，支持 Bedrock、OpenAI、本地模型等多种后端无缝切换
3. **AI 精修（AI Enhancement）** — 利用 AI 能力对照片进行智能增强（自动色彩校正、锐化、降噪等），生成增强版本

当前系统已有基础的色偏计算（imageAnalyzer.ts 中的 colorCastR/G/B）和简单的 AI 客户端（bedrockClient.ts 中的 createAIClient），但缺少：
- 结构化的色偏严重程度评估和分类
- 可扩展的 AI Provider 注册/切换机制
- AI 驱动的图片增强流程

## Glossary

- **Color_Cast_Detector**: 色偏检测服务，分析图像 RGB 通道偏差并产出色偏类型和严重程度评分
- **AI_Provider_Registry**: AI 提供商注册中心，管理多个 AI 后端的注册、选择和健康检查
- **AI_Provider**: 统一的 AI 提供商接口，定义文本生成和图像分析的标准调用方法
- **AI_Enhancement_Service**: AI 精修服务，协调 AI 分析和 sharp 图像处理来增强照片质量
- **Enhancement_Pipeline**: 增强处理流水线，从分析到参数计算到图像处理的完整流程
- **Media_Analysis_Table**: media_analysis 数据库表，存储色偏评分等分析结果
- **Media_Versions_Table**: media_versions 数据库表，存储增强后的图片版本记录
- **AI_Invocations_Table**: ai_invocations 数据库表，记录所有 AI 调用的详细信息
- **Color_Cast_Type**: 色偏类型枚举，包含 warm（偏暖）、cool（偏冷）、green（偏绿）、magenta（偏品红）、neutral（无色偏）
- **Severity_Level**: 严重程度枚举，包含 none、mild、moderate、severe
- **Provider_Type**: AI 提供商类型，包含 bedrock、openai、local

## Requirements

### Requirement 1: 色偏检测算法

**User Story:** As a developer, I want a color cast detection algorithm that quantifies color bias in photos, so that the system can identify problematic images and provide data for AI enhancement.

#### Acceptance Criteria

1. WHEN an image file path is provided, THE Color_Cast_Detector SHALL compute the color cast by analyzing per-channel mean deviations from the overall brightness mean
2. WHEN the color cast analysis is complete, THE Color_Cast_Detector SHALL classify the cast type as one of: warm, cool, green, magenta, neutral
3. WHEN the color cast analysis is complete, THE Color_Cast_Detector SHALL assign a severity level of none, mild, moderate, or severe based on the magnitude of channel deviation
4. THE Color_Cast_Detector SHALL produce a numeric color_score in the range [0.0, 1.0] where 1.0 indicates no color cast and 0.0 indicates severe color cast
5. WHEN the maximum absolute channel deviation is less than 5, THE Color_Cast_Detector SHALL classify the severity as none and the type as neutral
6. WHEN the maximum absolute channel deviation is between 5 and 15, THE Color_Cast_Detector SHALL classify the severity as mild
7. WHEN the maximum absolute channel deviation is between 15 and 30, THE Color_Cast_Detector SHALL classify the severity as moderate
8. WHEN the maximum absolute channel deviation exceeds 30, THE Color_Cast_Detector SHALL classify the severity as severe

### Requirement 2: 色偏检测结果持久化

**User Story:** As a developer, I want color cast detection results stored in the media_analysis table, so that downstream services can access the data without re-computation.

#### Acceptance Criteria

1. WHEN color cast detection completes for a media item, THE Color_Cast_Detector SHALL write the color_score to the media_analysis table's color_score column
2. WHEN color cast detection completes for a media item, THE Color_Cast_Detector SHALL store the cast type and severity in the media_analysis table's reason column as structured JSON
3. IF a media_analysis record already exists for the media item, THEN THE Color_Cast_Detector SHALL update the existing record rather than creating a duplicate
4. IF the image file cannot be read or analyzed, THEN THE Color_Cast_Detector SHALL log the error and skip the media item without interrupting batch processing

### Requirement 3: 批量色偏检测

**User Story:** As a developer, I want to run color cast detection on all images in a trip, so that the processing pipeline can assess color quality across the entire album.

#### Acceptance Criteria

1. WHEN a trip ID is provided, THE Color_Cast_Detector SHALL analyze all active image media items in that trip
2. WHEN batch processing completes, THE Color_Cast_Detector SHALL return a summary including total processed count, count per severity level, and any error details
3. WHEN an individual image fails during batch processing, THE Color_Cast_Detector SHALL continue processing remaining images and include the failure in the error summary

### Requirement 4: AI Provider 统一接口定义

**User Story:** As a developer, I want a unified AI provider interface, so that business logic can call AI capabilities without coupling to a specific provider implementation.

#### Acceptance Criteria

1. THE AI_Provider interface SHALL define a method for text generation that accepts a prompt string and optional parameters and returns a text response
2. THE AI_Provider interface SHALL define a method for image analysis that accepts one or more base64-encoded images with a prompt and returns a text response
3. THE AI_Provider interface SHALL define a method for reporting provider health status including availability and latency
4. THE AI_Provider interface SHALL include provider metadata: provider name, model name, supported capabilities list, and cost-per-token estimates
5. WHEN an AI_Provider method is invoked, THE AI_Provider SHALL return a standardized response object containing the result text, token usage counts, and elapsed time

### Requirement 5: AI Provider 注册与选择

**User Story:** As a developer, I want a registry that manages multiple AI providers, so that the system can switch providers based on availability, cost, or task requirements.

#### Acceptance Criteria

1. THE AI_Provider_Registry SHALL support registering multiple AI_Provider implementations identified by unique provider names
2. WHEN a provider is requested by name, THE AI_Provider_Registry SHALL return the corresponding AI_Provider instance
3. WHEN a provider is requested without specifying a name, THE AI_Provider_Registry SHALL return the default provider configured via the AI_PROVIDER environment variable
4. IF the requested provider is not registered, THEN THE AI_Provider_Registry SHALL throw a descriptive error indicating available providers
5. THE AI_Provider_Registry SHALL support a Bedrock provider implementation wrapping the existing createBedrockClient functionality
6. THE AI_Provider_Registry SHALL support an OpenAI provider implementation wrapping the existing createOpenAIClient functionality

### Requirement 6: AI 调用日志记录

**User Story:** As a developer, I want all AI provider calls automatically logged to the ai_invocations table, so that I can track usage, costs, and debug failures.

#### Acceptance Criteria

1. WHEN an AI_Provider method is invoked, THE AI_Provider_Registry SHALL create an ai_invocations record with status "pending" before the call executes
2. WHEN an AI_Provider method completes successfully, THE AI_Provider_Registry SHALL update the ai_invocations record with status "completed", response payload, token counts, estimated cost, and finished_at timestamp
3. IF an AI_Provider method fails, THEN THE AI_Provider_Registry SHALL update the ai_invocations record with status "failed", error message, and finished_at timestamp
4. THE AI_Provider_Registry SHALL populate the task_type field based on the calling context (e.g., "color_cast_analysis", "image_enhancement", "pair_review")

### Requirement 7: AI 精修分析阶段

**User Story:** As a developer, I want AI to analyze a photo and recommend specific enhancement parameters, so that the enhancement is tailored to each image's unique issues.

#### Acceptance Criteria

1. WHEN a media item is submitted for AI enhancement, THE AI_Enhancement_Service SHALL send the image to the configured AI_Provider with a prompt requesting enhancement recommendations
2. WHEN the AI analysis response is received, THE AI_Enhancement_Service SHALL parse the response into structured enhancement parameters including: brightness adjustment, contrast adjustment, color correction values, sharpening level, and noise reduction level
3. IF the AI response cannot be parsed into valid enhancement parameters, THEN THE AI_Enhancement_Service SHALL fall back to rule-based parameter computation using the existing computeOptimizeParams logic
4. THE AI_Enhancement_Service SHALL validate that all parsed parameters are within safe bounds (gamma: 0.5-2.0, sharpen sigma: 0-3.0, median filter: 0-5)

### Requirement 8: AI 精修图像处理

**User Story:** As a developer, I want the system to apply AI-recommended enhancements to produce an improved version of the photo, so that users get better quality images.

#### Acceptance Criteria

1. WHEN enhancement parameters are determined, THE AI_Enhancement_Service SHALL apply them using sharp image processing to produce an enhanced image file
2. WHEN the enhanced image is produced, THE AI_Enhancement_Service SHALL create a media_versions record with version_type "ai_refined", the file path, dimensions, and the model name used for analysis
3. WHEN the enhanced image is produced, THE AI_Enhancement_Service SHALL preserve the original EXIF metadata in the output file
4. THE AI_Enhancement_Service SHALL output the enhanced image in JPEG format with quality level 90
5. IF the enhancement processing fails, THEN THE AI_Enhancement_Service SHALL log the error and leave the original media item unchanged

### Requirement 9: AI 精修用户触发

**User Story:** As a user, I want to manually trigger AI enhancement on specific photos, so that I can choose which photos to improve rather than having all photos automatically processed.

#### Acceptance Criteria

1. WHEN a POST request is sent to /api/media/:mediaId/enhance, THE AI_Enhancement_Service SHALL initiate the AI enhancement workflow for the specified media item
2. WHEN the enhancement workflow completes successfully, THE AI_Enhancement_Service SHALL return status 200 with the new media_versions record
3. IF the media item does not exist or is not an image, THEN THE AI_Enhancement_Service SHALL return status 400 with a descriptive error
4. IF an ai_refined version already exists for the media item, THEN THE AI_Enhancement_Service SHALL replace the existing version with the new enhancement result
5. WHILE an enhancement is in progress for a media item, THE AI_Enhancement_Service SHALL reject additional enhancement requests for the same media item with status 409

### Requirement 10: AI 精修批量处理

**User Story:** As a user, I want to trigger AI enhancement on all photos in a trip that have quality issues, so that I can improve the entire album efficiently.

#### Acceptance Criteria

1. WHEN a POST request is sent to /api/trips/:tripId/enhance with optional filter parameters, THE AI_Enhancement_Service SHALL identify eligible media items based on their analysis scores
2. WHEN batch enhancement is triggered, THE AI_Enhancement_Service SHALL process eligible images sequentially to avoid overwhelming the AI provider
3. WHEN batch enhancement completes, THE AI_Enhancement_Service SHALL return a summary including total processed, successful count, failed count, and skipped count
4. THE AI_Enhancement_Service SHALL consider a media item eligible for enhancement if its quality_score is below 0.7 or its color_score is below 0.6
5. IF no eligible media items are found, THEN THE AI_Enhancement_Service SHALL return status 200 with an empty result and a message indicating no items need enhancement
