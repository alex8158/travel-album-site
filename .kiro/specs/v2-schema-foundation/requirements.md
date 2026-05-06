# Requirements Document

## Introduction

本 spec 覆盖 v2 智能媒体处理系统的第一阶段：数据库 schema 增强和基础 CRUD API。当前系统的分析数据散落在 media_items 表的多个列中（blur_status, exposure_score, contrast_score, noise_score, avg_brightness 等），缺少独立的版本管理、分析结果存储、重复组成员关系和 AI 调用记录表。本阶段将新增 media_versions、media_analysis、duplicate_group_items、ai_invocations 四张表，并提供对应的 CRUD API 端点和数据迁移逻辑。

## Glossary

- **Database**: 基于 better-sqlite3 的 SQLite 数据库实例，在 server/src/database.ts 中初始化
- **Schema_Migrator**: 负责在 initTables 中执行 DDL 语句创建新表和索引的模块
- **Media_Versions_API**: 管理媒体文件版本（原图、缩略图、增强图、AI 精修图等）的 REST API 端点
- **Media_Analysis_API**: 管理媒体分析结果（模糊评分、曝光评分、质量评分等）的 REST API 端点
- **Duplicate_Group_Items_API**: 管理重复组内媒体成员关系的 REST API 端点
- **AI_Invocations_API**: 管理 AI 调用记录（provider、token 用量、成本估算等）的 REST API 端点
- **Data_Migration_Service**: 将现有 media_items 表中散落的分析数据迁移到 media_analysis 表的服务
- **Version_Type**: 媒体版本类型枚举，包含 original、thumbnail、preview、enhanced、ai_refined、proxy、segment、final_output

## Requirements

### Requirement 1: media_versions 表创建

**User Story:** As a developer, I want a dedicated media_versions table, so that I can manage multiple file versions (original, thumbnail, enhanced, AI refined, proxy, etc.) for each media item independently.

#### Acceptance Criteria

1. WHEN the database is initialized, THE Schema_Migrator SHALL create the media_versions table with columns: id (TEXT PRIMARY KEY), media_id (TEXT NOT NULL), version_type (TEXT NOT NULL), file_path (TEXT NOT NULL), file_size (INTEGER), width (INTEGER), height (INTEGER), duration (REAL), model_name (TEXT), processor_name (TEXT), params (TEXT), status (TEXT DEFAULT 'ready'), created_at (TEXT NOT NULL)
2. WHEN the media_versions table is created, THE Schema_Migrator SHALL create a foreign key constraint on media_id referencing media_items(id)
3. WHEN the media_versions table is created, THE Schema_Migrator SHALL create an index on media_id for efficient lookup
4. THE Schema_Migrator SHALL support version_type values: original, thumbnail, preview, enhanced, ai_refined, proxy, segment, final_output

### Requirement 2: media_analysis 表创建

**User Story:** As a developer, I want a dedicated media_analysis table, so that analysis results are stored independently from media_items and can be versioned and recalculated without modifying the base media record.

#### Acceptance Criteria

1. WHEN the database is initialized, THE Schema_Migrator SHALL create the media_analysis table with columns: id (TEXT PRIMARY KEY), media_id (TEXT NOT NULL), blur_score (REAL), sharpness_score (REAL), exposure_score (REAL), color_score (REAL), noise_score (REAL), aesthetic_score (REAL), quality_score (REAL), is_blurry (INTEGER DEFAULT 0), is_overexposed (INTEGER DEFAULT 0), is_underexposed (INTEGER DEFAULT 0), is_duplicate (INTEGER DEFAULT 0), is_recommended (INTEGER DEFAULT 0), recommendation (TEXT), reason (TEXT), analysis_version (TEXT), created_at (TEXT NOT NULL)
2. WHEN the media_analysis table is created, THE Schema_Migrator SHALL create a foreign key constraint on media_id referencing media_items(id)
3. WHEN the media_analysis table is created, THE Schema_Migrator SHALL create an index on media_id for efficient lookup

### Requirement 3: duplicate_group_items 表创建

**User Story:** As a developer, I want a duplicate_group_items table, so that I can track which media items belong to each duplicate group along with their similarity scores and recommendations.

#### Acceptance Criteria

1. WHEN the database is initialized, THE Schema_Migrator SHALL create the duplicate_group_items table with columns: id (TEXT PRIMARY KEY), group_id (TEXT NOT NULL), media_id (TEXT NOT NULL), similarity_score (REAL), quality_score (REAL), recommendation (TEXT), reason (TEXT), created_at (TEXT NOT NULL)
2. WHEN the duplicate_group_items table is created, THE Schema_Migrator SHALL create foreign key constraints on group_id referencing duplicate_groups(id) and media_id referencing media_items(id)
3. WHEN the duplicate_group_items table is created, THE Schema_Migrator SHALL create an index on group_id and a composite unique index on (group_id, media_id) to prevent duplicate entries

### Requirement 4: ai_invocations 表创建

**User Story:** As a developer, I want an ai_invocations table, so that I can track all AI model calls for cost control, debugging, and usage analytics.

#### Acceptance Criteria

1. WHEN the database is initialized, THE Schema_Migrator SHALL create the ai_invocations table with columns: id (TEXT PRIMARY KEY), media_id (TEXT), segment_id (TEXT), provider (TEXT), model_name (TEXT), task_type (TEXT), request_payload (TEXT), response_payload (TEXT), input_tokens (INTEGER), output_tokens (INTEGER), estimated_cost (REAL), status (TEXT), error_message (TEXT), started_at (TEXT), finished_at (TEXT), created_at (TEXT NOT NULL)
2. WHEN the ai_invocations table is created, THE Schema_Migrator SHALL create an index on media_id for efficient lookup
3. WHEN the ai_invocations table is created, THE Schema_Migrator SHALL create an index on task_type for filtering by AI task category

### Requirement 5: Media Versions CRUD API

**User Story:** As a developer, I want REST API endpoints for media versions, so that the frontend and processing workers can create, read, update, and delete version records.

#### Acceptance Criteria

1. WHEN a POST request is sent to /api/media/:mediaId/versions with valid version data, THE Media_Versions_API SHALL create a new version record and return it with status 201
2. WHEN a GET request is sent to /api/media/:mediaId/versions, THE Media_Versions_API SHALL return all versions for the specified media item
3. WHEN a GET request is sent to /api/media/:mediaId/versions/:versionId, THE Media_Versions_API SHALL return the specific version record
4. WHEN a DELETE request is sent to /api/media/:mediaId/versions/:versionId, THE Media_Versions_API SHALL delete the version record and return status 204
5. IF a POST request contains an invalid version_type value, THEN THE Media_Versions_API SHALL return status 400 with a descriptive error message

### Requirement 6: Media Analysis CRUD API

**User Story:** As a developer, I want REST API endpoints for media analysis records, so that processing workers can store analysis results and the frontend can retrieve them.

#### Acceptance Criteria

1. WHEN a POST request is sent to /api/media/:mediaId/analysis with valid analysis data, THE Media_Analysis_API SHALL create a new analysis record and return it with status 201
2. WHEN a GET request is sent to /api/media/:mediaId/analysis, THE Media_Analysis_API SHALL return the latest analysis record for the specified media item
3. WHEN a PUT request is sent to /api/media/:mediaId/analysis/:analysisId with updated data, THE Media_Analysis_API SHALL update the analysis record and return the updated record
4. WHEN a GET request is sent to /api/media/:mediaId/analysis with query parameter history=true, THE Media_Analysis_API SHALL return all historical analysis records for the media item ordered by created_at descending

### Requirement 7: Duplicate Group Items CRUD API

**User Story:** As a developer, I want REST API endpoints for duplicate group items, so that the dedup engine can record group membership and the frontend can display group details.

#### Acceptance Criteria

1. WHEN a POST request is sent to /api/duplicate-groups/:groupId/items with valid item data, THE Duplicate_Group_Items_API SHALL create a new group item record and return it with status 201
2. WHEN a GET request is sent to /api/duplicate-groups/:groupId/items, THE Duplicate_Group_Items_API SHALL return all items in the specified duplicate group with their similarity and quality scores
3. WHEN a PUT request is sent to /api/duplicate-groups/:groupId/items/:itemId with updated recommendation, THE Duplicate_Group_Items_API SHALL update the item record
4. WHEN a DELETE request is sent to /api/duplicate-groups/:groupId/items/:itemId, THE Duplicate_Group_Items_API SHALL delete the group item record and return status 204
5. IF a POST request references a media_id that already exists in the group, THEN THE Duplicate_Group_Items_API SHALL return status 409 with a conflict error message

### Requirement 8: AI Invocations CRUD API

**User Story:** As a developer, I want REST API endpoints for AI invocation records, so that the system can log AI calls and administrators can monitor usage and costs.

#### Acceptance Criteria

1. WHEN a POST request is sent to /api/ai-invocations with valid invocation data, THE AI_Invocations_API SHALL create a new invocation record and return it with status 201
2. WHEN a GET request is sent to /api/ai-invocations with optional filters (media_id, task_type, status, date range), THE AI_Invocations_API SHALL return matching invocation records with pagination
3. WHEN a PUT request is sent to /api/ai-invocations/:id with status and response data, THE AI_Invocations_API SHALL update the invocation record to reflect completion or failure
4. WHEN a GET request is sent to /api/ai-invocations/summary, THE AI_Invocations_API SHALL return aggregated statistics including total invocations, total tokens, and total estimated cost

### Requirement 9: Data Migration from media_items to media_analysis

**User Story:** As a developer, I want existing analysis data in media_items to be migrated to the new media_analysis table, so that the system transitions cleanly to the normalized schema without data loss.

#### Acceptance Criteria

1. WHEN the Data_Migration_Service is executed, THE Data_Migration_Service SHALL read all media_items rows that have non-null values in any of: quality_score, sharpness_score, exposure_score, contrast_score, noise_score, blur_status, avg_brightness
2. WHEN migrating a media_item record, THE Data_Migration_Service SHALL create a corresponding media_analysis record mapping: quality_score → quality_score, sharpness_score → sharpness_score, exposure_score → exposure_score, noise_score → noise_score, blur_status → is_blurry (converting text to integer flag)
3. WHEN the migration completes successfully, THE Data_Migration_Service SHALL log the number of records migrated
4. IF a media_analysis record already exists for a given media_id, THEN THE Data_Migration_Service SHALL skip that media_id to avoid duplicate entries
5. WHEN the Data_Migration_Service encounters an error on a single record, THE Data_Migration_Service SHALL log the error and continue processing remaining records

