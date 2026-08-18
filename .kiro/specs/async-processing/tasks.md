# Tasks

> **需求引用为事后补录（2026-08-05）**
>
> 本文件原先没有任何 `_Requirements:` 标注，导致 11 条需求无法追溯到任务。
> 下方每个任务的需求引用是根据任务描述与 `requirements.md` 逐条比对后补录的，
> **任务描述与勾选状态一律未改动**。
>
> 补录后 11 条需求全部有任务覆盖。校验见 `traceability.md`。

## Task 1: Create processing_jobs and processing_job_events tables

- [x] 1.1 Add `processing_jobs` table DDL to `initTables()` in `server/src/database.ts` with columns: id (TEXT PK), trip_id (TEXT NOT NULL FK→trips.id), status (TEXT NOT NULL DEFAULT 'queued'), current_step (TEXT), percent (INTEGER DEFAULT 0), processed (INTEGER DEFAULT 0), total (INTEGER DEFAULT 0), error_message (TEXT), result_json (TEXT), created_at (TEXT NOT NULL), started_at (TEXT), finished_at (TEXT)
  - _Requirements: 1.1, 1.4_
- [x] 1.2 Add `processing_job_events` table DDL to `initTables()` with columns: id (INTEGER PK AUTOINCREMENT), job_id (TEXT NOT NULL FK→processing_jobs.id), seq (INTEGER NOT NULL), level (TEXT NOT NULL DEFAULT 'info'), step (TEXT), message (TEXT NOT NULL), processed (INTEGER), total (INTEGER), created_at (TEXT NOT NULL)
  - _Requirements: 1.2, 1.5_
- [x] 1.3 Add index `idx_processing_job_events_job_seq` on `processing_job_events(job_id, seq)`
  - _Requirements: 1.3_
- [x] 1.4 Add UNIQUE partial index `idx_processing_jobs_active_trip` on `processing_jobs(trip_id) WHERE status IN ('queued', 'running')` to enforce at most one active job per trip at the database level
  - _Requirements: 1.6, 8.1_
- [x] 1.5 Add zombie job cleanup logic at end of `initTables()`: UPDATE all jobs with status 'running' or 'queued' to status 'failed', set error_message='服务重启，任务中断', set finished_at=now; INSERT error event for each affected job
  - _Requirements: 11.1, 11.2, 11.3_

## Task 2: Create jobProgressReporter service

- [x] 2.1 Create `server/src/services/jobProgressReporter.ts` with class `JobProgressReporter` that takes `jobId` in constructor
  - _Requirements: 3.1_
- [x] 2.2 Implement `markRunning()`: UPDATE job status='running', started_at=now
  - _Requirements: 2.5_
- [x] 2.3 Implement `onStepBegin(step, totalSteps, stepIndex)`: INSERT event (level='info', step, message=step name), UPDATE job current_step, percent = Math.round(((stepIndex - 1) / totalSteps) * 100), and reset processed=0, total=0 for the new step. seq counter starts at 1, increments per event, never resets within a job.
  - _Requirements: 3.1, 3.2, 3.7, 3.8_
- [x] 2.4 Implement `onStepComplete(step, totalSteps, stepIndex)`: UPDATE job percent = Math.round((stepIndex / totalSteps) * 100)
  - _Requirements: 3.3_
- [x] 2.5 Implement `onItemProgress(processed, total)`: UPDATE job processed and total fields
  - _Requirements: 3.6_
- [x] 2.6 Implement `markCompleted(resultJson)`: UPDATE job status='completed', result_json, finished_at=now
  - _Requirements: 3.4_
- [x] 2.7 Implement `markFailed(errorMessage)`: UPDATE job status='failed', error_message, finished_at=now; INSERT error event
  - _Requirements: 3.5_
- [x] 2.8 Implement `toPipelineCallback()`: returns a `PipelineProgressCallback` function that maps PipelineStage start/complete to onStepBegin/onStepComplete using the existing STAGE_TO_STEP mapping
  - _Requirements: 3.1, 3.2, 3.3_

## Task 3: Create processJobs route

- [x] 3.1 Create `server/src/routes/processJobs.ts` with Express Router
  - _Requirements: 2.1_
- [x] 3.2 Implement `POST /api/trips/:id/process-jobs`: validate trip exists, check no queued/running job for trip (atomic transaction), INSERT job with status='queued', start pipeline in background with jobProgressReporter, return `{ jobId, status: 'queued' }`. On 409 ALREADY_PROCESSING, include `existingJobId` in the error response: `{ error: { code: 'ALREADY_PROCESSING', message: '该旅行正在处理中', existingJobId: 'xxx' } }`. Apply authMiddleware + requireAuth + owner/admin check.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 8.2, 8.3, 8.4, 10.1, 10.3, 10.4_
- [x] 3.3 Implement `GET /api/process-jobs/:jobId`: fetch job from DB, verify auth (owner/admin of associated trip), return camelCase fields
  - _Requirements: 4.1, 4.2, 4.3, 10.2, 10.3, 10.4_
- [x] 3.4 Implement `GET /api/process-jobs/:jobId/events`: fetch events ordered by seq ASC, support `after` query param for incremental fetch, verify auth
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 10.2_
- [x] 3.5 Implement `GET /api/process-jobs/:jobId/result`: verify job status='completed', return parsed result_json, verify auth
  - _Requirements: 6.1, 6.2, 6.3, 10.2_
- [x] 3.6 Register route in `server/src/index.ts`: import and mount at `/api/trips` (for POST and active-job) and `/api/process-jobs` (for GET endpoints)
  - _Requirements: 2.1_
- [x] 3.7 Implement `GET /api/trips/:id/active-job`: query the latest processing_job for the trip with status 'queued' or 'running', return `{ jobId, status }` or 404 if none. Apply authMiddleware + requireAuth + owner/admin check.
  - _Requirements: 7.11, 10.1_

## Task 4: Refactor SSE endpoint to use job backend

- [x] 4.1 Modify `GET /:id/process/stream` in `server/src/routes/process.ts`: create a processing_job record, start pipeline with jobProgressReporter, poll job_events and stream as SSE events, send complete/error SSE events based on job final status
  - _Requirements: 9.1, 9.2, 9.3_
- [x] 4.2 Remove the in-memory `processingTrips` Set from process.ts (concurrency now handled by DB job status check)
  - _Requirements: 8.1, 8.3_

## Task 5: Update ProcessTrigger to use polling

- [x] 5.1 Replace EventSource logic in `client/src/components/ProcessTrigger.tsx` with polling: POST to `/api/trips/:id/process-jobs` using `authFetch`, store jobId. If POST returns 409, extract `existingJobId` from the error response and start polling that job instead of showing an error.
  - _Requirements: 7.1, 8.2, 9.4_
- [x] 5.2 Implement polling loop: setInterval every 2s, GET `/api/process-jobs/:jobId` using `authFetch`, update state (status, percent, currentStep, processed, total)
  - _Requirements: 7.2, 7.3_
- [x] 5.3 Implement completion handling: when status='completed', stop polling, GET `/api/process-jobs/:jobId/result`, call onProcessed with result
  - _Requirements: 7.4, 7.6_
- [x] 5.4 Implement failure handling: when status='failed', stop polling, display errorMessage from job
  - _Requirements: 7.5_
- [x] 5.5 Implement retry logic: on network error or 5xx, retry up to 3 times with exponential backoff (2s, 4s, 8s); after 3 consecutive failures show '连接异常' warning and retry every 10s; never show '处理失败' while retrying
  - _Requirements: 7.7, 7.8, 7.9_
- [x] 5.6 On component mount, check for active job via `GET /api/trips/:id/active-job`. If found, resume polling with that jobId instead of showing "开始处理" button (handles page refresh / navigation back)
  - _Requirements: 7.10, 7.11_

## Task 6: Write unit tests for jobProgressReporter

- [ ] 6.1 Write property test for Property 1 (step-begin inserts event + updates current_step) in `server/src/services/jobProgressReporter.test.ts`
  - **Validates: Requirements 3.1, 3.2, 3.7, 3.8**
- [ ] 6.2 Write property test for Property 2 (step-complete updates percent correctly)
  - **Validates: Requirements 3.3**
- [ ] 6.3 Write property test for Property 3 (item-level progress updates processed/total)
  - **Validates: Requirements 3.6**
- [ ] 6.4 Write example tests for markCompleted and markFailed state transitions
  - **Validates: Requirements 3.4, 3.5**

## Task 7: Write unit tests for processJobs routes

- [ ] 7.1 Write property test for Property 4 (GET job returns camelCase fields) in `server/src/routes/processJobs.test.ts`
  - **Validates: Requirements 4.1, 4.3**
- [ ] 7.2 Write property test for Property 5 (events ordered by seq ascending)
  - **Validates: Requirements 5.1**
- [ ] 7.3 Write property test for Property 6 (events filtered by after parameter)
  - **Validates: Requirements 5.2, 5.4**
- [ ] 7.4 Write property test for Property 7 (result JSON round-trip)
  - **Validates: Requirements 6.1**
- [ ] 7.5 Write edge case tests: 404 for non-existent job/trip, 409 for already processing, 409 for result before completion
  - **Validates: Requirements 2.2, 2.3, 4.2, 5.3, 6.2, 6.3, 8.2**
- [ ] 7.6 Write property test for Property 8 (authorization rejects non-owner non-admin)
  - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**

## Task 8: Write unit tests for ProcessTrigger component

- [ ] 8.1 Write tests for polling lifecycle in `client/src/components/ProcessTrigger.test.tsx`: POST creates job, polls every 2s, stops on completed/failed
  - **Validates: Requirements 7.1, 7.2, 7.4, 7.5**
- [ ] 8.2 Write tests for retry logic: network error retries with backoff, warning after 3 failures, no false '处理失败'
  - **Validates: Requirements 7.7, 7.8, 7.9**
- [ ] 8.3 Write tests for completion flow: fetches result, calls onProcessed, displays summary
  - **Validates: Requirements 7.3, 7.4, 7.6**

## Task 9: Write integration test for zombie cleanup

- [ ] 9.1 Write test in `server/src/database.test.ts`: insert running/queued jobs, call initTables cleanup logic, verify jobs marked failed with correct error_message and error events inserted
  - **Validates: Requirements 11.1, 11.2, 11.3**

## 当前状态

必做任务 **28 / 42** 完成。

| 任务组 | 状态 | 说明 |
| --- | --- | --- |
| Task 1–5 | ✅ 全部完成 | 数据库表、进度上报服务、任务路由、SSE 改造、前端轮询 |
| **Task 6–9** | ❌ **14 项全部未完成** | 全部为测试任务 |

**关于完成度口径**：本 spec 的测试任务**没有**标记 `*`（可选），因此它们计入必做任务。其他多数 spec 把属性测试标为可选，所以本 spec 的 28/42 与其他 spec 的"必做 100%"不具可比性 —— 差异来自标记方式，不代表本 spec 实施得更差。

**未完成的测试覆盖范围**：

| 任务 | 覆盖需求 | 内容 |
| --- | --- | --- |
| 6.1–6.4 | 需求 3 | jobProgressReporter 的步骤上报、百分比计算、条目级进度、终态转换 |
| 7.1–7.6 | 需求 2、4、5、6、8、10 | 路由的 camelCase 输出、事件排序与增量拉取、结果往返、错误码、权限校验 |
| 8.1–8.3 | 需求 7 | 前端轮询生命周期、重试退避、完成流程 |
| 9.1 | 需求 11 | 服务重启僵尸任务清理 |

其中 **7.6（权限校验测试）** 与 **9.1（重启恢复测试）** 风险相对较高：前者涉及越权访问，后者涉及重启后任务状态是否会阻塞新请求。

## Notes

- 本 spec 的任务采用 `## Task N:` 标题 + `- [x] N.M` 子项的结构，没有可勾选的顶层任务条目
- 需求引用格式：实现任务用 `_Requirements: X.Y_`，测试任务用 `**Validates: Requirements X.Y**`
- 需求 8（并发控制）由两处共同保证：数据库层的 UNIQUE 部分索引（任务 1.4）与路由层的单事务检查+插入（任务 3.2）
- 需求 11（重启恢复）在 `initTables()` 末尾执行（任务 1.5），因此每次 `getDb()` 初始化都会清理僵尸任务
