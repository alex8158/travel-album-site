# Design Document: 视频自动编译与合并

## Overview

本功能实现视频处理流程的三项改进：（1）去掉环境变量开关，视频分析完成后始终自动编译精华视频；（2）我的相册页分栏展示原始视频和剪辑视频，公开画廊仅展示剪辑后的视频；（3）支持用户跨相册选择多个剪辑视频合并为一个新视频。

## Architecture

本功能涉及三个层面的改动：

1. **Pipeline 层**：移除环境变量开关，始终在 videoAnalysis 后执行 autoCompile
2. **API 层**：新增合并视频 API 端点，修改 gallery 查询逻辑
3. **前端层**：MyGalleryPage 分栏展示，GalleryPage 过滤逻辑

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend                               │
│  ┌──────────────────┐    ┌──────────────────────────┐   │
│  │  MyGalleryPage   │    │      GalleryPage          │   │
│  │  ┌────┐ ┌─────┐ │    │  (仅展示 compiled/merged) │   │
│  │  │原始│ │剪辑 │ │    └──────────────────────────┘   │
│  │  └────┘ └─────┘ │                                    │
│  └──────────────────┘                                    │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                    API Layer                              │
│  GET /api/my/trips/:id/gallery  (分栏数据)              │
│  GET /api/trips/:id/gallery     (过滤后数据)            │
│  POST /api/media/merge          (合并请求)              │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  Service Layer                            │
│  ┌────────────────┐  ┌──────────────┐                   │
│  │ Pipeline        │  │ MergeEngine  │                   │
│  │ (always auto-  │  │ (concat +    │                   │
│  │  compile)      │  │  DB record)  │                   │
│  └────────────────┘  └──────────────┘                   │
│           │                    │                          │
│           ▼                    ▼                          │
│  ┌────────────────┐  ┌──────────────┐                   │
│  │Compilation     │  │ videoEditor  │                   │
│  │Engine          │  │ .concatenate │                   │
│  └────────────────┘  └──────────────┘                   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  Data Layer                               │
│  media_items (+ media_source 字段)                      │
│  merged_video_sources (新关联表)                         │
└─────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### 1. Pipeline 改造 (`runTripProcessingPipeline.ts`)

**改动点**：移除 `VIDEO_AUTO_COMPILE_ENGINE` 环境变量检查，autoCompile 阶段始终执行。

```typescript
// 改造前
const autoCompileEnabled = process.env.VIDEO_AUTO_COMPILE_ENGINE === 'true';
if (autoCompileEnabled) { ... }

// 改造后 — 始终执行
onProgress('autoCompile', 'start');
let autoCompileCount = 0;
const compilationEngine = new CompilationEngine();
for (const videoRow of unprocessedVideos) {
  if (!analysisResults.has(videoRow.id)) continue;
  // 跳过 merged 视频
  if (videoRow.media_source === 'merged') continue;
  try {
    await compilationEngine.autoCompile(videoRow.id);
    autoCompileCount++;
  } catch (err) {
    // 错误不中断 pipeline
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] autoCompile failed for ${videoRow.id}: ${errorMsg}`);
  }
}
onProgress('autoCompile', 'complete', `${autoCompileCount} auto-compiled`);
```

**关键行为**：
- autoCompile 失败时记录错误日志，继续处理下一个视频
- 跳过 `media_source = 'merged'` 的视频
- CompilationEngine.autoCompile 内部已负责写入 `compiled_path`

### 2. MergeEngine (`server/src/services/mergeEngine.ts`)

新增服务模块，负责多视频合并逻辑。

```typescript
export interface MergeRequest {
  userId: string;
  tripId: string;
  sourceMediaIds: string[];  // 按顺序排列的源视频 ID
  name?: string;             // 可选自定义名称
}

export interface MergeResult {
  success: boolean;
  mediaId: string | null;    // 新创建的 media_items.id
  filePath: string | null;   // 合并后文件的存储路径
  error?: string;
}

export class MergeEngine {
  /**
   * 合并多个已编译视频为一个新视频。
   * 1. 验证所有源视频存在且有 compiled_path
   * 2. 下载所有 compiled 文件到临时目录
   * 3. 调用 ffmpeg 拼接
   * 4. 上传结果到存储
   * 5. 创建 media_items 记录 (media_source='merged')
   * 6. 写入 merged_video_sources 关联记录
   */
  async merge(request: MergeRequest): Promise<MergeResult>;

  /**
   * 生成默认名称：tripTitle + 4位随机数
   */
  private generateDefaultName(tripId: string): string;
}
```

**合并流程**：
1. 验证 `sourceMediaIds` 中每个视频都有 `compiled_path`
2. 按顺序下载各 compiled 文件到临时目录
3. 使用 `videoEditor.ts` 中已有的 `concatenateSegments` 函数拼接
4. 上传合并结果到 S3/本地存储
5. 在 `media_items` 表创建新记录，设置 `media_source = 'merged'`
6. 在 `merged_video_sources` 表写入源关系和顺序

### 3. 合并 API 端点 (`server/src/routes/merge.ts`)

```typescript
// POST /api/media/merge
interface MergeRequestBody {
  tripId: string;              // 合并视频归属的相册
  sourceMediaIds: string[];    // 源视频 ID 列表（按顺序）
  name?: string;               // 可选名称
}

interface MergeResponse {
  mediaId: string;
  filePath: string;
  name: string;
}
```

**验证逻辑**：
- 用户必须已登录
- `sourceMediaIds` 至少包含 2 个 ID
- 所有源视频必须存在且有 `compiled_path`
- 用户必须是所有源视频所属相册的 owner 或 admin
- `tripId` 对应的相册必须属于当前用户

### 4. Gallery API 改造

#### `/api/my/trips/:id/gallery` 改造

返回数据新增分栏信息：

```typescript
interface MyGalleryData extends GalleryData {
  originalVideos: VideoItem[];   // 原始上传视频 (media_type='video', media_source!='merged')
  compiledVideos: VideoItem[];   // 剪辑视频 (有 compiled_path 的视频的编译版 + media_source='merged' 的视频)
}
```

分类规则：
- `originalVideos`：所有 `media_type = 'video'` 且 `media_source != 'merged'` 的原始视频
- `compiledVideos`：具有 `compiled_path` 的视频（展示编译版）+ `media_source = 'merged'` 的视频

#### `/api/trips/:id/gallery` 改造

视频过滤逻辑：
```sql
-- 仅返回有 compiled_path 的视频 或 media_source='merged' 的视频
SELECT * FROM media_items
WHERE trip_id = ? AND media_type = 'video' AND status = 'active'
  AND (compiled_path IS NOT NULL OR media_source = 'merged')
```

对于有 `compiled_path` 的视频，前端播放地址使用 compiled_path 对应的 URL。

### 5. 前端改造

#### MyGalleryPage 分栏

```typescript
// 视频区域分为两个 Tab 或两栏
type VideoTab = 'original' | 'compiled';

// 原始视频栏：展示所有上传的视频
// 剪辑视频栏：展示 compiled 版本 + merged 视频
```

#### GalleryPage 过滤

```typescript
// 仅展示有 compiled_path 或 media_source='merged' 的视频
// 播放地址优先使用 compiled_path
const videoUrl = video.compiledPath
  ? `/api/media/${video.id}/compiled`
  : `/api/media/${video.id}/original`;
```

## Data Models

### media_items 表新增字段

```sql
-- Migration: add media_source column
ALTER TABLE media_items ADD COLUMN media_source TEXT DEFAULT 'upload'
  CHECK(media_source IN ('upload', 'merged'));
```

| 字段 | 类型 | 说明 |
|------|------|------|
| media_source | TEXT | 'upload'（默认，用户上传）或 'merged'（合并生成） |

### merged_video_sources 新表

```sql
CREATE TABLE IF NOT EXISTS merged_video_sources (
  id TEXT PRIMARY KEY,
  merged_media_id TEXT NOT NULL,
  source_media_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (merged_media_id) REFERENCES media_items(id) ON DELETE CASCADE,
  FOREIGN KEY (source_media_id) REFERENCES media_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_merged_sources_merged ON merged_video_sources(merged_media_id);
CREATE INDEX IF NOT EXISTS idx_merged_sources_source ON merged_video_sources(source_media_id);
```

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | UUID 主键 |
| merged_media_id | TEXT | 合并后视频的 media_items.id |
| source_media_id | TEXT | 源视频的 media_items.id |
| sort_order | INTEGER | 源视频在合并结果中的排列顺序（从 0 开始） |
| created_at | TEXT | 创建时间 |

**外键策略**：
- `merged_media_id` → `ON DELETE CASCADE`：删除合并视频时自动清理关联记录
- `source_media_id` → `ON DELETE SET NULL`：删除源视频时保留关联记录但置空引用

### MediaItemRow 类型扩展

```typescript
// server/src/helpers/mediaItemRow.ts
export interface MediaItemRow {
  // ... existing fields
  media_source: 'upload' | 'merged' | null;
}
```

## Interfaces

### MergeEngine API

```typescript
// POST /api/media/merge
// Request
{
  "tripId": "trip-uuid",
  "sourceMediaIds": ["media-1", "media-2", "media-3"],
  "name": "我的旅行合集"  // optional
}

// Response 200
{
  "mediaId": "new-merged-uuid",
  "filePath": "trips/trip-uuid/merged/new-merged-uuid.mp4",
  "name": "我的旅行合集"
}

// Response 400
{
  "error": {
    "code": "INVALID_SOURCES",
    "message": "所有源视频必须已完成编译"
  }
}
```

### Gallery API 响应扩展

```typescript
// GET /api/my/trips/:id/gallery 响应
interface MyGalleryResponse {
  trip: Trip;
  images: GalleryImage[];
  videos: VideoItem[];           // 保持兼容，包含所有视频
  originalVideos: VideoItem[];   // 新增：原始视频
  compiledVideos: VideoItem[];   // 新增：剪辑/合并视频
}

// GET /api/trips/:id/gallery 响应
// videos 数组仅包含有 compiled_path 或 media_source='merged' 的视频
// 每个 video 对象包含 compiledUrl 字段用于播放
```

## Error Handling

| 场景 | 处理方式 |
|------|----------|
| autoCompile 失败 | 记录错误日志，pipeline 继续执行后续阶段 |
| 合并时源视频不存在 | 返回 404，提示具体缺失的视频 ID |
| 合并时源视频无 compiled_path | 返回 400，code: INVALID_SOURCES |
| ffmpeg 拼接失败 | 返回 500，记录错误，不创建 media_items 记录 |
| 存储上传失败 | 返回 500，清理临时文件，不创建 DB 记录 |
| 用户无权操作源视频 | 返回 403 |
| sourceMediaIds 少于 2 个 | 返回 400，code: INSUFFICIENT_SOURCES |

## Testing Strategy

- **单元测试**：视频分类逻辑（哪些视频属于原始栏/剪辑栏）、合并选择验证、默认名称生成
- **属性测试**：视频过滤正确性、源关系记录完整性、合并不变性
- **集成测试**：Pipeline autoCompile 阶段执行、合并 API 端到端流程、ffmpeg 拼接

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Pipeline autoCompile 错误隔离

*For any* video where `CompilationEngine.autoCompile` throws an error, the pipeline SHALL continue processing subsequent videos and stages without interruption, and the overall pipeline result SHALL NOT be marked as failed due to autoCompile errors alone.

**Validates: Requirements 1.3**

### Property 2: MyGalleryPage 视频分类正确性

*For any* set of video media items in a trip, a video appears in the "剪辑视频" section if and only if it has a non-null `compiled_path` OR its `media_source` is `'merged'`; all other videos with `media_type = 'video'` and `media_source != 'merged'` appear in the "原始视频" section.

**Validates: Requirements 2.2, 2.3, 2.4**

### Property 3: GalleryPage 视频过滤正确性

*For any* set of video media items in a trip, the public gallery returns exactly those videos where `compiled_path IS NOT NULL` OR `media_source = 'merged'`, and for each returned video with `compiled_path`, the playback URL references the compiled path rather than the original file path.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

### Property 4: 合并选择验证

*For any* merge request containing a list of source media IDs, the system SHALL reject the request if any source video lacks a `compiled_path`, and SHALL accept the request only when all source videos have a non-null `compiled_path`.

**Validates: Requirements 4.1**

### Property 5: 合并操作保留源视频不变性

*For any* successful merge operation, all source video records in `media_items` SHALL remain unchanged (same `id`, `file_path`, `compiled_path`, `media_source`, `status`) before and after the merge.

**Validates: Requirements 4.4**

### Property 6: 合并记录创建正确性

*For any* successful merge operation, the newly created `media_items` record SHALL have `media_source = 'merged'`, and its `original_filename` SHALL equal the user-provided name if given, or follow the pattern `{tripTitle}{4-digit-random}` if no name was provided.

**Validates: Requirements 4.3, 5.2, 5.3**

### Property 7: 合并源关系记录完整性

*For any* successful merge of N source videos in order [s₁, s₂, ..., sₙ], the `merged_video_sources` table SHALL contain exactly N records for the merged video, with `sort_order` values [0, 1, ..., N-1] corresponding to the specified source order. Additionally, a single source video MAY appear in multiple merge relationships without conflict.

**Validates: Requirements 6.1, 6.2, 6.3**

### Property 8: Pipeline 跳过合并视频

*For any* trip containing videos with `media_source = 'merged'`, the pipeline SHALL NOT invoke `analyzeVideo` or `autoCompile` on those videos, leaving their records completely untouched.

**Validates: Requirements 7.2**

### Property 9: 源视频删除不级联到合并视频

*For any* merged video whose source videos are subsequently deleted, the merged video record SHALL remain in `media_items` with `status = 'active'` and its file SHALL remain accessible for playback.

**Validates: Requirements 7.3**
