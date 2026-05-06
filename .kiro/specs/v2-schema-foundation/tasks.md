# Implementation Plan: v2-schema-foundation

## Overview

为 v2 智能媒体处理系统新增 4 张数据库表（media_versions, media_analysis, duplicate_group_items, ai_invocations），创建对应的 CRUD API 路由，实现数据迁移服务，并更新级联删除逻辑。

## Tasks

- [x] 1. 在 database.ts 的 initTables() 中添加 4 张新表的 DDL
  - 在 `db.exec()` 中追加 media_versions、media_analysis、duplicate_group_items、ai_invocations 的 CREATE TABLE IF NOT EXISTS 语句
  - 创建对应索引：idx_media_versions_media_id、idx_media_analysis_media_id、idx_duplicate_group_items_group_id、idx_duplicate_group_items_group_media（UNIQUE）、idx_ai_invocations_media_id、idx_ai_invocations_task_type
  - 确保外键约束正确声明
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3_

- [ ] 2. 创建 Media Versions 路由
  - [ ] 2.1 创建 `server/src/routes/mediaVersions.ts`，实现 POST/GET/GET:id/DELETE 四个端点
    - POST 创建版本记录，校验 version_type 枚举值（original, thumbnail, preview, enhanced, ai_refined, proxy, segment, final_output），无效值返回 400
    - GET 列出指定 media_id 的所有版本
    - GET :versionId 获取单个版本
    - DELETE :versionId 删除版本记录返回 204
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 3. 创建 Media Analysis 路由
  - [ ] 3.1 创建 `server/src/routes/mediaAnalysis.ts`，实现 POST/GET/PUT 三个端点
    - POST 创建分析记录
    - GET 默认返回最新一条，?history=true 返回全部按 created_at DESC 排序
    - PUT :analysisId 更新分析记录
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [ ] 4. 创建 Duplicate Group Items 路由
  - [ ] 4.1 创建 `server/src/routes/duplicateGroupItems.ts`，实现 POST/GET/PUT/DELETE 四个端点
    - POST 添加成员，检查 (group_id, media_id) 唯一约束，冲突返回 409
    - GET 列出组内所有成员
    - PUT :itemId 更新推荐信息
    - DELETE :itemId 删除成员返回 204
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 5. 创建 AI Invocations 路由
  - [ ] 5.1 创建 `server/src/routes/aiInvocations.ts`，实现 POST/GET/PUT/GET:summary 四个端点
    - POST 创建调用记录
    - GET 支持 media_id、task_type、status 过滤和分页
    - PUT :id 更新状态和响应数据
    - GET /summary 返回聚合统计（total_invocations, total_input_tokens, total_output_tokens, total_estimated_cost, by_task_type）
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ] 6. 在 index.ts 中注册新路由
  - 导入 mediaVersionsRouter、mediaAnalysisRouter、duplicateGroupItemsRouter、aiInvocationsRouter
  - 注册路径：`/api/media` 挂载 mediaVersions 和 mediaAnalysis（使用 mergeParams），`/api/duplicate-groups` 挂载 duplicateGroupItems，`/api/ai-invocations` 挂载 aiInvocations
  - _Requirements: 5.1, 6.1, 7.1, 8.1_

- [ ] 7. 创建数据迁移服务 analysisMigration.ts
  - 创建 `server/src/services/analysisMigration.ts`
  - 实现 `migrateAnalysisData()` 函数：读取 media_items 中有非空分析字段的记录，映射到 media_analysis 表
  - 字段映射：quality_score→quality_score, sharpness_score→sharpness_score, exposure_score→exposure_score, noise_score→noise_score, blur_status→is_blurry (text→integer)
  - 跳过已有 media_analysis 记录的 media_id，单条失败不中断整体
  - 返回 AnalysisMigrationResult（migratedCount, skippedCount, errorCount, errors）
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [ ] 8. 更新 trips.ts 的级联删除逻辑
  - 在 DELETE /api/trips/:id 路由中，删除 media_items 之前追加清理 media_versions、media_analysis、duplicate_group_items
  - 同时清理 ai_invocations 中 media_id 匹配的记录
  - _Requirements: 1.2, 2.2, 3.2_

- [ ] 9. Checkpoint - 确认编译通过
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. 编写单元测试
  - [ ] 10.1 创建 `server/src/database.test.ts` 中追加新表 schema 验证测试
    - 验证 4 张新表和所有索引存在
    - 验证外键约束拒绝无效引用
    - 验证 duplicate_group_items 的唯一约束
    - _Requirements: 1.1, 2.1, 3.1, 3.3, 4.1_
  - [ ] 10.2 创建 `server/src/routes/mediaVersions.test.ts`
    - 测试 CRUD happy path 和 version_type 校验
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
  - [ ] 10.3 创建 `server/src/routes/mediaAnalysis.test.ts`
    - 测试 CRUD happy path 和 history 查询
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [ ] 10.4 创建 `server/src/routes/duplicateGroupItems.test.ts`
    - 测试 CRUD happy path 和 409 冲突
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
  - [ ] 10.5 创建 `server/src/routes/aiInvocations.test.ts`
    - 测试 CRUD happy path、过滤、聚合统计
    - _Requirements: 8.1, 8.2, 8.3, 8.4_
  - [ ] 10.6 创建 `server/src/services/analysisMigration.test.ts`
    - 测试迁移映射、跳过逻辑、错误恢复、幂等性
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [ ] 11. Final checkpoint - 确认所有测试通过
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 所有代码使用 TypeScript，与现有项目保持一致
- 使用 Vitest 作为测试框架
- 测试使用内存 SQLite 数据库（`:memory:`）进行隔离
- 迁移后现有 media_items 分析字段暂时保留（向后兼容）
- 每个任务引用具体的 requirements 条款以确保可追溯性
