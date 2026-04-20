# Requirements Document

## Introduction

当前图片处理流水线通过 SSE 流式传输（GET /api/trips/:id/process/stream）同步运行。当处理 100+ 张图片时，耗时 7-15 分钟，SSE 连接经常因 Nginx 超时、浏览器超时等原因断开。后端实际处理成功，但前端因连接断开显示"处理失败"。

本功能将处理流水线改为异步后台任务模式：前端发起处理请求后立即获得 jobId，后端在后台执行流水线并将进度写入数据库，前端通过轮询获取结构化进度数据。

## Glossary

- **Processing_Job**: 一个异步处理任务记录，包含状态、进度、结果等信息，存储在 processing_jobs 表中
- **Job_Event**: 处理任务执行过程中产生的日志事件，存储在 processing_job_events 表中
- **Job_API**: 处理任务相关的 REST API 端点集合，包括创建、查询状态、获取事件和结果
- **Processing_Pipeline**: 现有的图片处理流水线（runTripProcessingPipeline），包含模糊检测、去重、分析、优化、分类、缩略图生成、视频分析、视频编辑、封面选择等步骤
- **Progress_Poller**: 前端轮询组件，定期请求任务状态并更新进度条显示
- **Trip**: 一次旅行记录，包含多个媒体文件

## Requirements

### Requirement 1: 处理任务数据库表

**User Story:** As a developer, I want processing job state persisted in the database, so that progress survives connection drops and can be queried independently.

#### Acceptance Criteria

1. THE Job_API SHALL create a `processing_jobs` table with columns: id (TEXT PRIMARY KEY), trip_id (TEXT NOT NULL, FOREIGN KEY), status (TEXT NOT NULL DEFAULT 'queued'), current_step (TEXT), percent (INTEGER DEFAULT 0), processed (INTEGER DEFAULT 0), total (INTEGER DEFAULT 0), error_message (TEXT), result_json (TEXT), created_at (TEXT NOT NULL), started_at (TEXT), finished_at (TEXT)
   - percent: 整体流水线进度（0-100），计算方式为 completed_steps / total_steps * 100
   - processed: 当前步骤已处理的项目数（step-scoped，非 trip-scoped）
   - total: 当前步骤的总项目数（step-scoped，非 trip-scoped）
2. THE Job_API SHALL create a `processing_job_events` table with columns: id (INTEGER PRIMARY KEY AUTOINCREMENT), job_id (TEXT NOT NULL, FOREIGN KEY), seq (INTEGER NOT NULL), level (TEXT NOT NULL DEFAULT 'info'), step (TEXT), message (TEXT NOT NULL), processed (INTEGER), total (INTEGER), created_at (TEXT NOT NULL)
3. THE Job_API SHALL create an index on processing_job_events(job_id, seq) for efficient event querying
4. THE Job_API SHALL enforce a FOREIGN KEY from processing_jobs.trip_id to trips.id
5. THE Job_API SHALL enforce a FOREIGN KEY from processing_job_events.job_id to processing_jobs.id
6. THE Job_API SHALL create a UNIQUE partial index on processing_jobs(trip_id) WHERE status IN ('queued', 'running') to enforce at most one active job per trip at the database level

### Requirement 2: 创建处理任务

**User Story:** As a user, I want to trigger image processing and get an immediate response, so that I don't have to wait for a long-running SSE connection.

#### Acceptance Criteria

1. WHEN a POST request is sent to /api/trips/:id/process-jobs, THE Job_API SHALL create a new Processing_Job with status 'queued' and return the job id and status without blocking pipeline completion（不阻塞流水线完成，尽快返回）
2. WHEN a POST request is sent for a trip that does not exist, THE Job_API SHALL return HTTP 404 with error code 'NOT_FOUND'
3. WHEN a POST request is sent for a trip that already has a Processing_Job with status 'queued' or 'running', THE Job_API SHALL return HTTP 409 with error code 'ALREADY_PROCESSING' and include the existing active job's id in the response: `{ error: { code: 'ALREADY_PROCESSING', message: '该旅行正在处理中', existingJobId: 'xxx' } }`
4. WHEN a Processing_Job is created, THE Job_API SHALL start the Processing_Pipeline in the background without blocking the HTTP response
5. WHEN the background Processing_Pipeline starts execution, THE Job_API SHALL update the Processing_Job status from 'queued' to 'running' and set started_at

### Requirement 3: 后台流水线进度上报

**User Story:** As a developer, I want the pipeline to report progress to the database instead of SSE, so that progress data is durable and queryable.

#### Acceptance Criteria

1. WHEN the Processing_Pipeline begins a step, THE Processing_Pipeline SHALL insert a Job_Event with level 'info', the step name, and a descriptive message
2. WHEN the Processing_Pipeline begins a step, THE Processing_Pipeline SHALL update the Processing_Job current_step to the new step name（current_step 在步骤开始时更新，而非完成时）
3. WHEN the Processing_Pipeline completes a step, THE Processing_Pipeline SHALL update the Processing_Job percent, processed, and total fields
4. WHEN the Processing_Pipeline completes all steps successfully, THE Processing_Pipeline SHALL update the Processing_Job status to 'completed', store the result as JSON in result_json, and set finished_at
5. IF the Processing_Pipeline encounters a fatal error, THEN THE Processing_Pipeline SHALL update the Processing_Job status to 'failed', store the error in error_message, insert a Job_Event with level 'error', and set finished_at
6. WHEN the Processing_Pipeline processes individual items within a step, THE Processing_Pipeline SHALL update the Processing_Job processed and total fields to reflect item-level progress within the current step
7. THE seq field in processing_job_events SHALL be a monotonically increasing integer per job, starting from 1, never reset within a job
8. THE processed and total fields on processing_jobs SHALL be reset to 0 when a new step begins (they are step-scoped, not cumulative across steps)

### Requirement 4: 查询任务状态（轮询）

**User Story:** As a frontend client, I want to poll for job status, so that I can display progress without maintaining a persistent connection.

#### Acceptance Criteria

1. WHEN a GET request is sent to /api/process-jobs/:jobId, THE Job_API SHALL return the Processing_Job fields: id, tripId, status, currentStep, percent, processed, total, errorMessage, createdAt, startedAt, finishedAt
2. WHEN a GET request is sent for a job that does not exist, THE Job_API SHALL return HTTP 404 with error code 'NOT_FOUND'
3. THE Job_API SHALL return the response in camelCase JSON format

### Requirement 5: 查询任务事件日志

**User Story:** As a frontend client, I want to fetch detailed processing events, so that I can show a detailed log of what happened during processing.

#### Acceptance Criteria

1. WHEN a GET request is sent to /api/process-jobs/:jobId/events, THE Job_API SHALL return all Job_Event records for the specified job ordered by seq ascending
2. WHEN a GET request includes query parameter after=N, THE Job_API SHALL return only Job_Event records with seq greater than N
3. WHEN a GET request is sent for a job that does not exist, THE Job_API SHALL return HTTP 404 with error code 'NOT_FOUND'
4. THE Job_API SHALL return each event with fields: id, seq, level, step, message, processed, total, createdAt

### Requirement 6: 查询任务结果

**User Story:** As a frontend client, I want to fetch the final processing result, so that I can display a summary when processing completes.

#### Acceptance Criteria

1. WHEN a GET request is sent to /api/process-jobs/:jobId/result and the Processing_Job status is 'completed', THE Job_API SHALL return the parsed result_json content
2. WHEN a GET request is sent and the Processing_Job status is not 'completed', THE Job_API SHALL return HTTP 409 with error code 'JOB_NOT_COMPLETE'
3. WHEN a GET request is sent for a job that does not exist, THE Job_API SHALL return HTTP 404 with error code 'NOT_FOUND'

### Requirement 7: 前端轮询进度显示

**User Story:** As a user, I want to see a progress bar and step information while processing runs, so that I know the system is working even without SSE.

#### Acceptance Criteria

1. WHEN the user triggers processing, THE Progress_Poller SHALL send a POST to /api/trips/:id/process-jobs and store the returned jobId
2. WHILE the Processing_Job status is 'queued' or 'running', THE Progress_Poller SHALL poll GET /api/process-jobs/:jobId every 2 seconds
3. WHEN poll data is received, THE Progress_Poller SHALL update the progress bar with percent, current step label (中文), and processed/total counts
4. WHEN the Processing_Job status becomes 'completed', THE Progress_Poller SHALL stop polling, fetch the result from /api/process-jobs/:jobId/result, and display the processing summary
5. WHEN the Processing_Job status becomes 'failed', THE Progress_Poller SHALL stop polling and display the error message
6. WHEN the Processing_Job status becomes 'completed', THE Progress_Poller SHALL trigger a gallery refresh to show newly processed media
7. IF a poll request fails due to network error or HTTP 5xx, THEN THE Progress_Poller SHALL retry up to 3 times with exponential backoff (2s, 4s, 8s)
8. IF 3 consecutive poll requests fail, THEN THE Progress_Poller SHALL display a '连接异常' warning and continue retrying every 10 seconds
9. WHILE poll requests are failing, THE Progress_Poller SHALL NOT display '处理失败' because the backend Processing_Job may still be running
10. WHEN the user refreshes the page or navigates back to a trip that has a Processing_Job with status 'queued' or 'running', THE Progress_Poller SHALL automatically resume polling for that job
11. THE frontend SHALL provide a GET /api/trips/:id/active-job endpoint (or query the latest job for the trip) to discover the active jobId on page load

### Requirement 8: 并发控制

**User Story:** As a system operator, I want to prevent duplicate processing for the same trip, so that resources are not wasted and data integrity is maintained.

#### Acceptance Criteria

1. THE Job_API SHALL allow concurrent Processing_Jobs for different trips
2. WHEN a POST request is sent for a trip that already has a Processing_Job with status 'queued' or 'running', THE Job_API SHALL return HTTP 409 with error code 'ALREADY_PROCESSING', message '该旅行正在处理中', and include the existing active job's id as `existingJobId` in the error response
3. WHEN a Processing_Job finishes (status 'completed' or 'failed'), THE Job_API SHALL allow creating a new Processing_Job for the same trip
4. WHEN checking for existing queued/running jobs and inserting a new job, THE Job_API SHALL perform the check and INSERT in a single database transaction to prevent race conditions where two concurrent requests both pass the check

### Requirement 9: SSE 端点统一

**User Story:** As a developer, I want the SSE endpoint to use the same job backend as the polling flow, so that there is a single execution chain and no duplicated processing logic.

#### Acceptance Criteria

1. WHEN a GET request is sent to /api/trips/:id/process/stream, THE Job_API SHALL create a Processing_Job internally and execute the Processing_Pipeline through the same job backend as the polling flow
2. WHILE the Processing_Job is running, THE Job_API SHALL stream Job_Event records to the SSE client in real time
3. THE Job_API SHALL NOT maintain a separate execution chain for SSE — the SSE endpoint is a thin wrapper that creates a job, then streams job events via SSE instead of polling
4. THE Progress_Poller SHALL use the new polling-based flow as the default processing method in the frontend


### Requirement 10: 权限校验

**User Story:** As a system operator, I want processing job endpoints to enforce authorization, so that only authorized users can create and query processing jobs.

#### Acceptance Criteria

1. WHEN a POST request is sent to /api/trips/:id/process-jobs, THE Job_API SHALL verify that the authenticated user is the trip owner or an admin
2. WHEN a GET request is sent to /api/process-jobs/:jobId, /api/process-jobs/:jobId/events, or /api/process-jobs/:jobId/result, THE Job_API SHALL verify that the authenticated user is the trip owner or an admin
3. IF the request has no valid authentication token, THEN THE Job_API SHALL return HTTP 401 with error code 'UNAUTHORIZED'
4. IF the authenticated user is not the trip owner and not an admin, THEN THE Job_API SHALL return HTTP 403 with error code 'FORBIDDEN'

### Requirement 11: 服务重启恢复

**User Story:** As a system operator, I want zombie jobs cleaned up on server startup, so that stale 'running' jobs do not block new processing requests.

#### Acceptance Criteria

1. WHEN the server starts, THE Job_API SHALL update all Processing_Jobs with status 'running' to status 'failed' with error_message '服务重启，任务中断' and set finished_at to the current timestamp
2. WHEN the server starts, THE Job_API SHALL update all Processing_Jobs with status 'queued' to status 'failed' with error_message '服务重启，任务中断' and set finished_at to the current timestamp
3. WHEN zombie jobs are cleaned up, THE Job_API SHALL insert a Job_Event with level 'error' and message '服务重启，任务中断' for each affected job
