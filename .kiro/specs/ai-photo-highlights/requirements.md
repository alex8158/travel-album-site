# Requirements Document

## Introduction

AI 照片精华挑选功能：用户上传旅行照片经过代码筛选（CLIP 分类 + OpenCV 模糊检测 + 重复检测）后，系统使用视觉大模型对技术合格的照片进行批量评审，完成两个核心任务：（1）基于构图美感、独特瞬间、故事性和多样性等维度挑选约 30-40% 的精华照片；（2）识别相似照片组并在每组中推荐保留质量最好的一张。结果持久化到数据库，前端展示精华标记和相似组推荐。

## Glossary

- **AI_Highlight_Service**: 后端服务模块，负责将技术合格照片分批发送给视觉大模型进行评审，并解析返回的结构化 JSON 结果
- **Vision_LLM**: 视觉大模型，支持 OpenAI、Bedrock、DashScope 三种 provider 级联回退
- **Highlight_Photo**: 被 AI 评审选中的精华照片，基于构图美感、独特瞬间、故事性和多样性等维度评选
- **Similar_Group**: 一组被 AI 识别为相似的照片（同一场景、同一角度、连拍等），每组包含一张推荐保留的最佳照片
- **Batch**: 一次发送给 Vision_LLM 的照片集合，包含 4-8 张照片
- **Provider_Cascade**: 多 AI provider 级联回退机制，首选 provider 失败时自动尝试下一个
- **Technical_Qualified_Photo**: 通过代码筛选（非模糊、非重复）的照片，作为 AI 评审的输入
- **Highlight_Result**: AI 评审的持久化结果，包含精华标记和相似组信息，存储在 SQLite 数据库中

## Requirements

### Requirement 1: 批量照片评审

**User Story:** As a 旅行用户, I want 系统对我的技术合格照片进行 AI 批量评审, so that 我能快速从大量照片中找到最值得保留的精华照片。

#### Acceptance Criteria

1. WHEN a batch review is triggered for a trip, THE AI_Highlight_Service SHALL collect all Technical_Qualified_Photos for that trip and divide them into Batches of 4-8 photos each
2. WHEN a Batch is ready, THE AI_Highlight_Service SHALL send the Batch to the Vision_LLM with a structured prompt requesting highlight selection and similar group identification
3. WHEN the Vision_LLM returns a response, THE AI_Highlight_Service SHALL parse the response as structured JSON containing highlight selections and similar group recommendations
4. IF the Vision_LLM returns an invalid or unparseable response, THEN THE AI_Highlight_Service SHALL log the error and retry the Batch once before marking it as failed
5. THE AI_Highlight_Service SHALL resize each photo to a maximum of 768x768 pixels before sending to the Vision_LLM to reduce token cost and latency

### Requirement 2: 精华照片挑选

**User Story:** As a 旅行用户, I want AI 从我的照片中挑选出构图优美、瞬间独特的精华照片, so that 我能快速获得一组高质量的旅行回忆。

#### Acceptance Criteria

1. WHEN evaluating a Batch, THE Vision_LLM SHALL assess each photo on composition aesthetics, unique moments, storytelling value, and diversity dimensions
2. THE AI_Highlight_Service SHALL select approximately 30-40% of all Technical_Qualified_Photos as Highlight_Photos across all Batches for a trip
3. WHEN the evaluation is complete, THE AI_Highlight_Service SHALL persist each Highlight_Photo designation to the Highlight_Result in the database with the photo ID and a brief reason text
4. THE AI_Highlight_Service SHALL include a reason field (maximum 100 characters) for each Highlight_Photo explaining why it was selected

### Requirement 3: 相似照片组识别与最佳推荐

**User Story:** As a 旅行用户, I want AI 识别出我照片中的相似组并推荐每组中最好的一张, so that 我能轻松清理冗余照片只保留最佳版本。

#### Acceptance Criteria

1. WHEN evaluating a Batch, THE Vision_LLM SHALL identify photos that are similar (same scene, same angle, burst shots) and group them into Similar_Groups
2. WHEN a Similar_Group is identified, THE Vision_LLM SHALL recommend the single best photo in the group based on sharpness, composition, and lighting
3. WHEN the evaluation is complete, THE AI_Highlight_Service SHALL persist each Similar_Group to the database with the group member photo IDs and the recommended best photo ID
4. THE AI_Highlight_Service SHALL assign a unique group identifier to each Similar_Group within a trip

### Requirement 4: 多 Provider 级联回退

**User Story:** As a 系统管理员, I want AI 评审支持多 provider 级联回退, so that 单个 provider 不可用时系统仍能正常工作。

#### Acceptance Criteria

1. THE AI_Highlight_Service SHALL detect configured providers by checking environment variables for OpenAI, Bedrock, and DashScope
2. WHEN the primary provider fails for a Batch, THE AI_Highlight_Service SHALL automatically retry with the next available provider in the cascade chain
3. IF all providers fail for a Batch, THEN THE AI_Highlight_Service SHALL mark that Batch as failed and continue processing remaining Batches
4. THE AI_Highlight_Service SHALL log which provider was used for each successful Batch evaluation
5. WHERE a preferred provider is configured via environment variable, THE AI_Highlight_Service SHALL use that provider as the first in the cascade chain

### Requirement 5: 结果持久化

**User Story:** As a 旅行用户, I want AI 评审结果保存到数据库, so that 我每次打开相册都能看到精华标记和相似组推荐而无需重新评审。

#### Acceptance Criteria

1. WHEN a Batch evaluation completes successfully, THE AI_Highlight_Service SHALL persist the results to the SQLite database within a single transaction
2. THE AI_Highlight_Service SHALL store each Highlight_Photo record with the fields: photo ID, trip ID, is_highlight flag, highlight reason, and evaluation timestamp
3. THE AI_Highlight_Service SHALL store each Similar_Group record with the fields: group ID, trip ID, member photo IDs, recommended best photo ID, and evaluation timestamp
4. WHEN a new evaluation is triggered for a trip that already has results, THE AI_Highlight_Service SHALL replace the previous results for that trip
5. IF a database write fails, THEN THE AI_Highlight_Service SHALL roll back the transaction and report the error without corrupting existing data

### Requirement 6: 触发入口

**User Story:** As a 旅行用户, I want 能手动触发 AI 精华评审, so that 我可以在照片处理完成后随时获取 AI 推荐。

#### Acceptance Criteria

1. THE Frontend SHALL display a trigger button on the trip gallery page to initiate AI highlight evaluation
2. WHEN the trigger button is clicked, THE Frontend SHALL send a request to the backend API to start the evaluation for the specified trip
3. WHILE the evaluation is in progress, THE Frontend SHALL display a progress indicator showing the current Batch number and total Batch count
4. WHEN the evaluation completes, THE Frontend SHALL refresh the gallery view to display the updated highlight marks and similar group recommendations
5. IF the evaluation fails, THEN THE Frontend SHALL display an error message with the failure reason

### Requirement 7: 前端精华展示

**User Story:** As a 旅行用户, I want 在相册中直观看到精华标记和相似组推荐, so that 我能快速浏览最佳照片并处理冗余照片。

#### Acceptance Criteria

1. THE Frontend SHALL display a visual highlight badge on each Highlight_Photo thumbnail in the gallery grid
2. THE Frontend SHALL provide a filter option to show only Highlight_Photos in the gallery view
3. WHEN a user views a photo that belongs to a Similar_Group, THE Frontend SHALL display the group members and indicate which photo is the recommended best
4. THE Frontend SHALL display the highlight reason text when the user hovers over or clicks the highlight badge
5. THE Frontend SHALL provide a filter option to show only Similar_Groups for review

### Requirement 8: API 接口

**User Story:** As a 前端开发者, I want 后端提供清晰的 REST API 接口, so that 前端能触发评审、查询结果和展示数据。

#### Acceptance Criteria

1. THE Backend SHALL expose a POST endpoint to trigger AI highlight evaluation for a specified trip
2. THE Backend SHALL expose a GET endpoint to retrieve all Highlight_Photos for a specified trip
3. THE Backend SHALL expose a GET endpoint to retrieve all Similar_Groups for a specified trip
4. WHEN the trigger endpoint is called while an evaluation is already in progress for the same trip, THE Backend SHALL return a conflict status indicating evaluation is already running
5. THE Backend SHALL validate that the requesting user has access to the specified trip before processing any request
