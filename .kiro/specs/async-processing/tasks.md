# Tasks

## Task 1: Create processing_jobs and processing_job_events tables

- [x] 1.1 Add `processing_jobs` table DDL to `initTables()` in `server/src/database.ts` with columns: id (TEXT PK), trip_id (TEXT NOT NULL FK→trips.id), status (TEXT NOT NULL DEFAULT 'queued'), current_step (TEXT), percent (INTEGER DEFAULT 0), processed (INTEGER DEFAULT 0), total (INTEGER DEFAULT 0), error_message (TEXT), result_json (TEXT), created_at (TEXT NOT NULL), started_at (TEXT), finished_at (TEXT)
- [x] 1.2 Add `processing_job_events` table DDL to `initTables()` with columns: id (INTEGER PK AUTOINCREMENT), job_id (TEXT NOT NULL FK→processing_jobs.id), seq (INTEGER NOT NULL), level (TEXT NOT NULL DEFAULT 'info'), step (TEXT), message (TEXT NOT NULL), processed (INTEGER), total (INTEGER), created_at (TEXT NOT NULL)
- [x] 1.3 Add index `idx_processing_job_events_job_seq` on `processing_job_events(job_id, seq)`
- [x] 1.4 Add UNIQUE partial index `idx_processing_jobs_active_trip` on `processing_jobs(trip_id) WHERE status IN ('queued', 'running')` to enforce at most one active job per trip at the database level
- [x] 1.5 Add zombie job cleanup logic at end of `initTables()`: UPDATE all jobs with status 'running' or 'queued' to status 'failed', set error_message='服务重启，任务中断', set finished_at=now; INSERT error event for each affected job

## Task 2: Create jobProgressReporter service

- [x] 2.1 Create `server/src/services/jobProgressReporter.ts` with class `JobProgressReporter` that takes `jobId` in constructor
- [x] 2.2 Implement `markRunning()`: UPDATE job status='running', started_at=now
- [x] 2.3 Implement `onStepBegin(step, totalSteps, stepIndex)`: INSERT event (level='info', step, message=step name), UPDATE job current_step, percent = Math.round(((stepIndex - 1) / totalSteps) * 100), and reset processed=0, total=0 for the new step. seq counter starts at 1, increments per event, never resets within a job.
- [x] 2.4 Implement `onStepComplete(step, totalSteps, stepIndex)`: UPDATE job percent = Math.round((stepIndex / totalSteps) * 100)
- [x] 2.5 Implement `onItemProgress(processed, total)`: UPDATE job processed and total fields
- [x] 2.6 Implement `markCompleted(resultJson)`: UPDATE job status='completed', result_json, finished_at=now
- [x] 2.7 Implement `markFailed(errorMessage)`: UPDATE job status='failed', error_message, finished_at=now; INSERT error event
- [x] 2.8 Implement `toPipelineCallback()`: returns a `PipelineProgressCallback` function that maps PipelineStage start/complete to onStepBegin/onStepComplete using the existing STAGE_TO_STEP mapping

## Task 3: Create processJobs route

- [x] 3.1 Create `server/src/routes/processJobs.ts` with Express Router
- [x] 3.2 Implement `POST /api/trips/:id/process-jobs`: validate trip exists, check no queued/running job for trip (atomic transaction), INSERT job with status='queued', start pipeline in background with jobProgressReporter, return `{ jobId, status: 'queued' }`. On 409 ALREADY_PROCESSING, include `existingJobId` in the error response: `{ error: { code: 'ALREADY_PROCESSING', message: '该旅行正在处理中', existingJobId: 'xxx' } }`. Apply authMiddleware + requireAuth + owner/admin check.
- [x] 3.3 Implement `GET /api/process-jobs/:jobId`: fetch job from DB, verify auth (owner/admin of associated trip), return camelCase fields
- [x] 3.4 Implement `GET /api/process-jobs/:jobId/events`: fetch events ordered by seq ASC, support `after` query param for incremental fetch, verify auth
- [x] 3.5 Implement `GET /api/process-jobs/:jobId/result`: verify job status='completed', return parsed result_json, verify auth
- [x] 3.6 Register route in `server/src/index.ts`: import and mount at `/api/trips` (for POST and active-job) and `/api/process-jobs` (for GET endpoints)
- [x] 3.7 Implement `GET /api/trips/:id/active-job`: query the latest processing_job for the trip with status 'queued' or 'running', return `{ jobId, status }` or 404 if none. Apply authMiddleware + requireAuth + owner/admin check.

## Task 4: Refactor SSE endpoint to use job backend

- [x] 4.1 Modify `GET /:id/process/stream` in `server/src/routes/process.ts`: create a processing_job record, start pipeline with jobProgressReporter, poll job_events and stream as SSE events, send complete/error SSE events based on job final status
- [x] 4.2 Remove the in-memory `processingTrips` Set from process.ts (concurrency now handled by DB job status check)

## Task 5: Update ProcessTrigger to use polling

- [x] 5.1 Replace EventSource logic in `client/src/components/ProcessTrigger.tsx` with polling: POST to `/api/trips/:id/process-jobs` using `authFetch`, store jobId. If POST returns 409, extract `existingJobId` from the error response and start polling that job instead of showing an error.
- [x] 5.2 Implement polling loop: setInterval every 2s, GET `/api/process-jobs/:jobId` using `authFetch`, update state (status, percent, currentStep, processed, total)
- [x] 5.3 Implement completion handling: when status='completed', stop polling, GET `/api/process-jobs/:jobId/result`, call onProcessed with result
- [x] 5.4 Implement failure handling: when status='failed', stop polling, display errorMessage from job
- [x] 5.5 Implement retry logic: on network error or 5xx, retry up to 3 times with exponential backoff (2s, 4s, 8s); after 3 consecutive failures show '连接异常' warning and retry every 10s; never show '处理失败' while retrying
- [x] 5.6 On component mount, check for active job via `GET /api/trips/:id/active-job`. If found, resume polling with that jobId instead of showing "开始处理" button (handles page refresh / navigation back)

## Task 6: Write unit tests for jobProgressReporter

- [ ] 6.1 Write property test for Property 1 (step-begin inserts event + updates current_step) in `server/src/services/jobProgressReporter.test.ts`
- [ ] 6.2 Write property test for Property 2 (step-complete updates percent correctly)
- [ ] 6.3 Write property test for Property 3 (item-level progress updates processed/total)
- [ ] 6.4 Write example tests for markCompleted and markFailed state transitions

## Task 7: Write unit tests for processJobs routes

- [ ] 7.1 Write property test for Property 4 (GET job returns camelCase fields) in `server/src/routes/processJobs.test.ts`
- [ ] 7.2 Write property test for Property 5 (events ordered by seq ascending)
- [ ] 7.3 Write property test for Property 6 (events filtered by after parameter)
- [ ] 7.4 Write property test for Property 7 (result JSON round-trip)
- [ ] 7.5 Write edge case tests: 404 for non-existent job/trip, 409 for already processing, 409 for result before completion
- [ ] 7.6 Write property test for Property 8 (authorization rejects non-owner non-admin)

## Task 8: Write unit tests for ProcessTrigger component

- [ ] 8.1 Write tests for polling lifecycle in `client/src/components/ProcessTrigger.test.tsx`: POST creates job, polls every 2s, stops on completed/failed
- [ ] 8.2 Write tests for retry logic: network error retries with backoff, warning after 3 failures, no false '处理失败'
- [ ] 8.3 Write tests for completion flow: fetches result, calls onProcessed, displays summary

## Task 9: Write integration test for zombie cleanup

- [ ] 9.1 Write test in `server/src/database.test.ts`: insert running/queued jobs, call initTables cleanup logic, verify jobs marked failed with correct error_message and error events inserted
