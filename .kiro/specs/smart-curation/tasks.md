# Implementation Plan: Smart Curation

## Overview

Replace the existing `aiScreening` pipeline stage with a two-phase Smart Curation engine. Phase 1 groups photos by DINOv2 embedding similarity using tiered thresholds (exact duplicate >= 0.94, near-duplicate >= 0.86). Phase 2 selects the best photo(s) from each group using technical quality scoring (exact duplicates) or VLM-based evaluation via DashScope qwen-vl-max (near-duplicates). The implementation reuses existing infrastructure (mlQualityService, bedrockClient, qualitySelector) and follows the same VLM call pattern as aiImageOptimizer.ts.

## Tasks

- [x] 1. Set up Smart Curation module structure and core types
  - [x] 1.1 Create the smartCuration directory and define core types/interfaces
    - Create `server/src/services/smartCuration/smartCurationEngine.ts` with all exported types: `TrashReason`, `GroupType`, `SimilaritySource`, `CurationCandidate`, `CurationGroup`, `CurationDecision`, `SmartCurationResult`, `SmartCurationOptions`
    - Export the `runSmartCuration` function signature (stub implementation returning empty result)
    - Create `server/src/services/smartCuration/index.ts` barrel export
    - _Requirements: 1.1, 4.1-4.8, 7.1_

- [x] 2. Implement Similarity Grouper
  - [x] 2.1 Implement the similarityGrouper module
    - Create `server/src/services/smartCuration/similarityGrouper.ts`
    - Export constants `EXACT_DUPLICATE_THRESHOLD = 0.94` and `NEAR_DUPLICATE_THRESHOLD = 0.86`
    - Implement `groupBySimilarity(candidates)` that: fetches DINOv2 embeddings via `mlQualityService.ts`, computes pairwise cosine similarity, builds Union-Find groups using tiered thresholds, classifies groups as `exact_duplicate` or `near_duplicate_candidate` based on max similarity within the group
    - Implement fallback to pHash/dHash when ML service is unavailable
    - Return groups of 2+ candidates and ungrouped singletons separately
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ]* 2.2 Write property test: Tiered Grouping by Cosine Similarity
    - **Property 1: Tiered Grouping by Cosine Similarity**
    - **Validates: Requirements 1.2, 1.3, 1.4**
    - Create `server/src/services/smartCuration/smartCuration.property.test.ts`
    - Generate random embedding vectors and verify grouping thresholds are applied correctly

  - [ ]* 2.3 Write property test: Union-Find Grouping Transitivity
    - **Property 10: Union-Find Grouping Transitivity**
    - **Validates: Requirements 1.1**
    - Verify that if sim(A,B) >= threshold and sim(B,C) >= threshold, then A, B, C are all in the same group

- [x] 3. Implement Technical Quality Selector
  - [x] 3.1 Implement the technicalQualitySelector module
    - Create `server/src/services/smartCuration/technicalQualitySelector.ts`
    - Implement `selectBestByQuality(candidates)` using sharpness score, resolution (width*height), and file size as ranking criteria
    - Implement `preselectTopCandidates(candidates, maxCount)` to reduce large groups before VLM evaluation
    - Reuse scoring logic from existing `qualitySelector.ts` where applicable
    - _Requirements: 3.3, 3.5, 8.2, 8.3_

  - [ ]* 3.2 Write property test: Pre-selection Reduces Large Groups to At Most 5
    - **Property 3: Pre-selection Reduces Large Groups to At Most 5**
    - **Validates: Requirements 3.3, 8.2**
    - Verify that for any group with > 5 candidates, preselectTopCandidates returns at most 5 and they are the top-scoring ones

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement VLM Selector
  - [x] 5.1 Implement the vlmSelector module
    - Create `server/src/services/smartCuration/vlmSelector.ts`
    - Implement `getKeepQuota(groupSize)` with the tiered logic: 2-3 → keep 1, 4-8 → keep 1-2, 9+ → keep 2-3
    - Implement `buildCurationPrompt(candidateCount, keepQuota)` with the full VLM prompt including underwater photo handling instructions
    - Implement `parseVLMResponse(responseText, candidateCount, keepQuota)` to parse JSON from VLM output, returning null on failure
    - Implement `selectBestByVLM(candidates, keepQuota)` that: resizes images to 768px using `resizeForAnalysis` from bedrockClient, builds the prompt, calls DashScope qwen-vl-max via OpenAI-compatible client (same pattern as aiImageOptimizer.ts), parses the response
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.4, 9.1, 9.2, 9.3_

  - [ ]* 5.2 Write property test: Group Size Determines Keep Quota
    - **Property 2: Group Size Determines Keep Quota**
    - **Validates: Requirements 2.1, 2.2, 2.3**
    - Verify getKeepQuota returns correct min/max for all group size ranges

  - [ ]* 5.3 Write property test: VLM Response Parsing Round-Trip
    - **Property 4: VLM Response Parsing Round-Trip**
    - **Validates: Requirements 3.4**
    - Generate valid VLMSelectionResponse objects, serialize to JSON, parse back, verify equivalence

  - [ ]* 5.4 Write property test: Trash Reason Matches Group Type
    - **Property 5: Trash Reason Matches Group Type and Determination**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7**
    - Verify exact_duplicate groups only produce `exact_duplicate` reason; near_duplicate groups produce one of the VLM-specific reasons

- [x] 6. Implement Debug Report Writer
  - [x] 6.1 Implement the debugReportWriter module
    - Create `server/src/services/smartCuration/debugReportWriter.ts`
    - Implement `writeDebugReport(tripId, decisions, groups)` that writes JSON to `data/debug/smart-curation-{tripId}-{timestamp}.json`
    - Ensure the report contains one entry per processed photo with all required fields
    - Create the `data/debug/` directory if it doesn't exist
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 6.2 Write property test: Debug Report Completeness
    - **Property 7: Debug Report Completeness**
    - **Validates: Requirements 6.2, 6.3, 6.4**
    - Verify that for any set of decisions, the report contains exactly one entry per photo with all required fields

- [x] 7. Implement Smart Curation Engine orchestrator
  - [x] 7.1 Implement the full runSmartCuration orchestrator logic
    - Complete the `runSmartCuration` function in `smartCurationEngine.ts`
    - Load active images from DB for the trip (`status = 'active'`)
    - Call `groupBySimilarity` to form groups
    - For `exact_duplicate` groups: use `selectBestByQuality` to pick the best, trash others with reason `exact_duplicate`
    - For `near_duplicate_candidate` groups: pre-select top 5 if group > 5, then call `selectBestByVLM`, fall back to quality scoring on failure
    - Apply decisions to DB: set `status = 'trashed'` and `trashed_reason` for trashed photos
    - Process VLM calls with concurrency limit of 3 using `Promise.allSettled` batching
    - Call `writeDebugReport` at the end
    - Report progress via `options.onProgress` callback
    - Handle graceful degradation: skip VLM if DASHSCOPE_API_KEY not set, fall back on unparseable responses
    - _Requirements: 2.4, 3.3, 3.5, 4.8, 5.1, 5.2, 7.2, 7.4, 8.1, 8.3, 8.4, 8.5_

  - [ ]* 7.2 Write property test: Soft Delete Invariant
    - **Property 6: Soft Delete Invariant**
    - **Validates: Requirements 5.1, 5.2**
    - Verify that trashing only modifies status and trashed_reason, never file_path

  - [ ]* 7.3 Write property test: VLM Invoked Only for Near-Duplicate Groups
    - **Property 8: VLM Invoked Only for Near-Duplicate Groups with 2+ Members**
    - **Validates: Requirements 8.1, 8.3, 8.5**
    - Verify VLM is never called for singletons, ungrouped photos, or exact_duplicate groups

  - [ ]* 7.4 Write property test: Curation Processes Only Active Photos
    - **Property 9: Curation Processes Only Active Photos**
    - **Validates: Requirements 7.2**
    - Verify only photos with status='active' are processed and no other-status photos are modified

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Pipeline integration
  - [x] 9.1 Replace aiScreening with smartCuration in the pipeline
    - Modify `server/src/services/pipeline/runTripProcessingPipeline.ts`
    - Replace the `aiScreening` stage block with a `smartCuration` stage that calls `runSmartCuration`
    - Remove the `AI_REVIEW_ENABLED` gate — smartCuration always runs (falls back to quality scoring if no API key)
    - Wire the pipeline's `onProgress` callback to the smartCuration options
    - Log curation results (totalTrashed, vlmCallsMade, timing)
    - Ensure subsequent stages (analyze, optimize, thumbnail) continue after smartCuration completes
    - _Requirements: 7.1, 7.3, 7.5_

  - [ ]* 9.2 Write unit tests for pipeline integration
    - Test that smartCuration stage is called after write stage
    - Test that pipeline continues to analyze/optimize/thumbnail after smartCuration
    - Test that smartCuration failure does not block subsequent stages
    - Test progress callback receives smartCuration stage events
    - _Requirements: 7.1, 7.3, 7.5_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

---

## 补录任务（需求 10 / 11 / 12）

> **【待验证】补录说明**
>
> 任务 1–10 只覆盖需求 1–9（Phase 1）。需求 10（Phase 2 AI Review）、需求 11（阈值校准）、需求 12（Phase 3 AI Cross-Photo Dedup）是后续追加到 `requirements.md` 的，**代码已实现但从未建立任务**，因此也从未经过本 spec 的检查点验证。
>
> 以下任务为事后补录，用于恢复需求↔任务追溯。它们**保持未勾选状态**，标记为【待验证】：代码存在，但「是否完整满足需求」未经核对确认。勾选前需逐条比对验收标准。
>
> 补录依据：`aiReview.ts`、`aiFinalDedup.ts`、`similarityGrouper.ts`、`runTripProcessingPipeline.ts` 的当前实现。

- [ ] 11. 【待验证】Phase 2 — AI per-photo review
  - [ ] 11.1 【待验证】实现 `runAIReview`（`server/src/services/smartCuration/aiReview.ts`）
    - 加载 trip 内全部 `status = 'active'` 照片，按固定批次大小切分（`BATCH_SIZE = 5`）
    - 每批一次 VLM 调用，逐张独立 keep/trash 判断（无组上下文、不做组内择优）
    - trash 原因限定为 `blurry` / `low_subject_quality` / `low_aesthetic_quality` / `low_video_value`
    - 提示词保留水下照片说明（蓝色调不视为缺陷）
    - 单批调用失败或响应无法解析时保留该批全部照片，并递增 `vlmCallsFailed`
    - 未配置 `DASHSCOPE_API_KEY` 时整阶段跳过，不 trash 任何照片
    - 仅软删除：写 `status` 与 `trashed_reason`，`file_path` 不变
    - 调试报告写入 `data/debug/ai-review-{tripId}-{timestamp}.json`
    - VLM 批次并发上限 `VLM_CONCURRENCY = 3`，批内取图并发 `PER_BATCH_IMAGE_CONCURRENCY = 5`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 10.12, 10.13_

  - [ ] 11.2 【待验证】将 `aiReview` 接入流水线为独立阶段
    - 在 `runTripProcessingPipeline.ts` 中于 `smartCuration` 之后、`analyze` 之前执行（约 L673–695）
    - 独立的 `onProgress('aiReview', ...)` 进度回调
    - 阶段级错误隔离：失败时记入 `stageErrors` 并继续后续阶段
    - 共享 `vlmCallStats` tracker
    - _Requirements: 10.14_

  - [ ]* 11.3 为 `runAIReview` 补测试
    - 批次切分、保守回退（批失败保留全部）、无 API key 跳过、软删除不变式
    - _Requirements: 10.1, 10.9, 10.10, 10.11_

- [ ] 12. 【待验证】需求 11 — 连拍场景的相似度阈值校准
  - [ ] 12.1 【待验证】校准 `similarityGrouper.ts` 的两档阈值
    - `EXACT_DUPLICATE_THRESHOLD` 默认 0.98（自 0.94 上调），使 0.94–0.98 区间的人物连拍进入近似重复档交由 VLM 评估
    - `NEAR_DUPLICATE_THRESHOLD` 默认 0.80（自 0.86 下调），因 DINOv2-small 低估水下低对比度照片的近似度
    - 两者分别支持 `SMART_CURATION_EXACT_THRESHOLD` / `SMART_CURATION_NEAR_THRESHOLD` 环境变量覆盖
    - NEAR > EXACT 时输出告警且不中断启动
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

- [ ] 13. 【待验证】需求 12 — Phase 3 AI Cross-Photo Dedup（**已被 sceneDedup 取代**）
  > **⚠️ 需求与实现已分叉，勾选前必须先决策**
  >
  > 需求 12 描述的 `runAIFinalDedup`（`aiFinalDedup.ts`）**已不再被流水线调用**。
  > `runTripProcessingPipeline.ts` L707–709 明确注释其「preserved for rollback but no longer invoked」，
  > 并以 `void runAIFinalDedup;` 保持 import 存活。
  >
  > 当前实际运行的是 `runSceneDedup`（`sceneDedup.ts`），它用 DINOv2 余弦相似度做跨批次边界合并，
  > 修掉了需求 12 自己承认的局限（「落在批次边界两侧的近似重复会同时保留」）。
  > `sceneDedup` 的规格定义在 `photo-curation-fix` spec（术语表 Scene_Dedup 与 Boundary_Merging）。
  >
  > 因此需求 12 目前处于**描述了一个已停用实现**的状态。三种处理方式待你选择：
  > 1. 保留需求 12 并标注「已被 sceneDedup 取代，实现保留作回滚」
  > 2. 改写需求 12 使其描述 sceneDedup 的实际行为
  > 3. 废止需求 12，把跨照片去重的规格完全交给 `photo-curation-fix`
  >
  > 在做出决策前，本任务不应勾选。

  - [ ] 13.1 【待验证】`runAIFinalDedup` 实现现状（已停用）
    - `aiFinalDedup.ts` 已实现：按 `created_at` 升序分批、批次默认 12（`SMART_CURATION_DEDUP_BATCH_SIZE`，有效范围 2–12）
    - trash 原因限定 `scene_redundant`；批次不足 2 张时跳过 VLM 调用
    - 批失败保守保留全部并递增 `vlmCallsFailed`；无 API key 整阶段跳过
    - 调试报告 `data/debug/ai-final-dedup-{tripId}-{timestamp}.json`；并发上限 3
    - **但该函数未被流水线调用**，故需求 12.14（作为独立 `aiFinalDedup` 阶段接入）当前不成立
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12, 12.13, 12.15_

  - [ ] 13.2 【待验证】决定需求 12 的归属并同步文档
    - 按上方三个选项之一处理需求 12
    - 若选项 2 或 3，需同步更新 `photo-curation-fix` 中 Scene_Dedup 的规格归属
    - _Requirements: 12.14_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Tasks marked 【待验证】are back-filled records of already-written code (see 补录任务 above). They are intentionally left unchecked: the implementation exists but has not been verified against its acceptance criteria. Do not tick them without a criterion-by-criterion comparison.
- 任务 1–10 覆盖需求 1–9；补录任务 11–13 覆盖需求 10–12。任务编号与需求编号**不对应**，映射见每个任务标题与 `traceability.md`
- 补录任务未纳入下方 Task Dependency Graph（该图仅描述 Phase 1 的原始实施顺序）
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The implementation reuses existing infrastructure: `mlQualityService.ts` (DINOv2 embeddings), `bedrockClient.ts` (resizeForAnalysis), `qualitySelector.ts` (quality scoring), and the DashScope OpenAI-compatible client pattern from `aiImageOptimizer.ts`
- Database is better-sqlite3 with no new tables needed — reuses existing `media_items.trashed_reason` column
- VLM concurrency is limited to 3 parallel requests matching the existing aiImageScreener pattern

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "6.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.2", "5.1", "6.2"] },
    { "id": 3, "tasks": ["5.2", "5.3", "5.4", "7.1"] },
    { "id": 4, "tasks": ["7.2", "7.3", "7.4"] },
    { "id": 5, "tasks": ["9.1"] },
    { "id": 6, "tasks": ["9.2"] }
  ]
}
```
