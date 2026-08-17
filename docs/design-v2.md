> **状态：产品愿景文档，非实现契约（2026-05-06）**
>
> 本文档是 `docs/requirements-v2.md` 的配套设计，描述目标架构而非当前实现。写于迭代开发中途，未反向对齐过代码。
>
> **不要据此判断当前系统结构。** 当前设计依据见 `.kiro/specs/<feature>/design.md`；文档权威顺序见 `AGENTS.md` 第 5.1 节。
>
> 本文档保持原样，不随代码更新。

---

# 智能图片与视频处理系统设计文档

## 1. 文档说明

本文档基于《智能图片与视频处理系统项目需求文档》编写，用于指导系统架构设计、模块拆分、数据结构设计、处理流程设计和后续代码实现。

本设计文档重点解决以下问题：

1. 图片和视频如何分阶段处理。
2. 哪些任务由传统算法处理。
3. 哪些任务由 AI 模型处理。
4. 前端、后端、Worker、数据库如何协作。
5. 如何保证任务稳定、可恢复、可追踪。
6. 如何降低模型调用成本。
7. 如何避免处理过程中破坏原始文件。
8. 如何支持后续扩展到 AI 精修和视频智能剪辑。

---

# 2. 总体设计目标

## 2.1 核心目标

系统目标是构建一套面向旅行相册场景的智能媒体处理平台，支持用户上传图片和视频后，自动完成基础分析、质量筛选、重复识别、基础增强和可选 AI 精修。

系统整体采用以下策略：

```text
传统算法负责大批量基础处理
AI 模型负责少量高价值内容的智能判断和精修
所有耗时任务异步执行
所有原始文件永久保留
所有处理结果以新版本保存
```

---

## 2.2 设计原则

### 2.2.1 原始文件不可破坏

任何处理流程都不能覆盖原图或原视频。

所有增强、精修、转码、剪辑结果都必须保存为新文件，并通过版本表进行管理。

---

### 2.2.2 传统算法优先

以下任务优先使用传统代码和计算机视觉算法完成：

1. 图片 hash 去重。
2. 图片 pHash / dHash 相似检测。
3. 图片模糊检测。
4. 图片曝光检测。
5. 图片基础增强。
6. 视频转码。
7. 视频抽帧。
8. 视频镜头切分。
9. 视频模糊检测。
10. 视频抖动检测。
11. 视频黑场检测。
12. 视频音量分析。
13. 视频基础拼接。

---

### 2.2.3 AI 模型按需调用

AI 模型只在以下场景介入：

1. 图片高价值精修。
2. 图片去除路人或杂物。
3. 图片复杂审美判断。
4. 相似图片组最终裁判。
5. 视频候选片段内容理解。
6. 视频智能剪辑方案生成。
7. 自动标题、摘要、字幕、旁白生成。

---

### 2.2.4 任务异步化

图片和视频处理都是耗时任务，不能放在普通 HTTP 请求中同步执行。

上传完成后，后端只负责创建任务，真正的处理由 Worker 异步完成。

---

### 2.2.5 状态可追踪

每个媒体文件、每个处理任务、每个处理版本都必须有明确状态。

系统需要支持：

1. 查看处理进度。
2. 查看失败原因。
3. 任务重试。
4. 单个文件重新处理。
5. 单个阶段重新处理。
6. 任务日志查看。

---

# 3. 总体架构设计

## 3.1 系统架构图

```text
┌────────────────────────┐
│        前端 Web         │
│  上传 / 浏览 / 操作 / 状态 │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│      后端 API 服务       │
│  鉴权 / 上传 / 查询 / 调度 │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│        数据库            │
│ media / jobs / versions │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│       任务队列           │
│ image / video / ai jobs │
└───────┬────────┬────────┘
        │        │
        ▼        ▼
┌─────────────┐ ┌─────────────┐
│ 图片 Worker │ │ 视频 Worker │
│ CV / 增强   │ │ FFmpeg / CV │
└──────┬──────┘ └──────┬──────┘
       │               │
       ▼               ▼
┌────────────────────────┐
│        文件存储          │
│ original / preview / out │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│       AI Worker          │
│ 图片精修 / 视频理解 / 剪辑 │
└────────────────────────┘
```

---

## 3.2 模块划分

系统拆分为以下核心模块：

| 模块 | 职责 |
|---|---|
| 前端模块 | 上传、预览、操作、展示处理结果 |
| 后端 API 模块 | 接收请求、管理媒体、创建任务、查询状态 |
| 图片处理模块 | 图片去重、模糊检测、质量评分、自动增强 |
| 视频处理模块 | 视频转码、抽帧、切片、废片识别、基础优化 |
| AI 处理模块 | 图片精修、视频理解、剪辑方案生成 |
| 任务队列模块 | 管理异步任务、重试、失败状态 |
| 文件存储模块 | 管理原始文件、预览文件、处理结果 |
| 数据库模块 | 记录媒体、分析结果、任务、版本、片段 |
| 日志模块 | 记录处理日志、错误日志、模型调用日志 |

---

# 4. 技术架构设计

## 4.1 推荐技术栈

| 层级 | 技术 |
|---|---|
| 前端 | React / TypeScript |
| 后端 | Node.js / TypeScript |
| API 框架 | Express / Fastify / 当前项目已有框架 |
| 数据库 | SQLite，后续可迁移 PostgreSQL |
| 图片处理 | sharp / OpenCV / Python CV |
| 图片相似度 | pHash / dHash / DINOv2 / CLIP / FAISS |
| 视频处理 | FFmpeg / ffprobe / PySceneDetect / OpenCV |
| AI 调用 | OpenAI / Gemini / 其他可替换模型 |
| 任务队列 | BullMQ / Bee-Queue / SQLite Job Queue |
| 文件存储 | 本地文件系统，后续支持 S3 |
| 日志 | 本地日志文件 + 数据库任务日志 |

---

## 4.2 Node.js 与 Python 分工

### Node.js 负责

1. API 服务。
2. 文件上传。
3. 数据库读写。
4. 任务创建。
5. 任务状态查询。
6. 前端数据接口。
7. 调用 Python Worker。
8. 调用 AI 服务。
9. 文件版本管理。

---

### Python 负责

1. OpenCV 图像分析。
2. DINOv2 / CLIP embedding 提取。
3. FAISS 相似检索。
4. 视频关键帧分析。
5. 视频抖动分析。
6. PySceneDetect 镜头切分。
7. 复杂图像质量评分。

---

### FFmpeg 负责

1. 视频转码。
2. 视频抽帧。
3. 视频片段切割。
4. 视频拼接。
5. 音频提取。
6. 音量归一化。
7. 生成代理视频。
8. 生成最终短视频。

---

# 5. 文件存储设计

## 5.1 目录结构

建议采用以下目录结构：

```text
storage/
├── originals/
│   ├── images/
│   └── videos/
├── thumbnails/
│   ├── images/
│   └── videos/
├── previews/
│   ├── images/
│   └── videos/
├── enhanced/
│   ├── images/
│   └── videos/
├── ai_refined/
│   ├── images/
│   └── videos/
├── segments/
│   └── videos/
├── outputs/
│   └── videos/
├── temp/
└── logs/
```

---

## 5.2 文件命名规则

所有文件应避免使用用户原始文件名直接作为存储文件名。

推荐命名格式：

```text
{media_id}_{version_type}_{timestamp}.{ext}
```

示例：

```text
media_102_original_20260505.jpg
media_102_thumbnail_20260505.webp
media_102_enhanced_20260505.jpg
video_205_preview_20260505.mp4
video_205_segment_001.mp4
video_205_output_60s.mp4
```

---

## 5.3 文件版本原则

每个媒体至少包含一个原始版本。

图片可能包含：

1. original：原图。
2. thumbnail：缩略图。
3. preview：预览图。
4. enhanced：自动增强图。
5. ai_refined：AI 精修图。

视频可能包含：

1. original：原视频。
2. thumbnail：封面图。
3. proxy：低清代理视频。
4. segment：切分片段。
5. enhanced_segment：优化片段。
6. output：最终合成视频。

---

# 6. 数据库设计

## 6.1 media_items 表

用于记录所有图片和视频的基础信息。

```sql
CREATE TABLE media_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER,
    type TEXT NOT NULL, -- image / video

    original_filename TEXT,
    original_path TEXT NOT NULL,
    thumbnail_path TEXT,
    preview_path TEXT,

    file_hash TEXT,
    file_size INTEGER,
    mime_type TEXT,

    width INTEGER,
    height INTEGER,
    duration REAL,
    fps REAL,
    bitrate INTEGER,

    status TEXT NOT NULL DEFAULT 'uploaded',
    selected_version_id INTEGER,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 6.2 media_analysis 表

用于存储图片或视频的分析结果。

```sql
CREATE TABLE media_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,

    blur_score REAL,
    sharpness_score REAL,
    exposure_score REAL,
    color_score REAL,
    noise_score REAL,
    aesthetic_score REAL,
    quality_score REAL,

    is_blurry INTEGER DEFAULT 0,
    is_overexposed INTEGER DEFAULT 0,
    is_underexposed INTEGER DEFAULT 0,
    is_duplicate INTEGER DEFAULT 0,
    is_recommended INTEGER DEFAULT 0,

    recommendation TEXT, -- keep / remove / review
    reason TEXT,

    analysis_version TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (media_id) REFERENCES media_items(id)
);
```

---

## 6.3 media_versions 表

用于存储原图、增强图、AI 精修图、视频代理、最终输出等版本。

```sql
CREATE TABLE media_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,

    version_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER,
    width INTEGER,
    height INTEGER,
    duration REAL,

    model_name TEXT,
    processor_name TEXT,
    params TEXT,

    status TEXT DEFAULT 'ready',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (media_id) REFERENCES media_items(id)
);
```

version_type 可选值：

```text
original
thumbnail
preview
enhanced
ai_refined
proxy
segment
final_output
```

---

## 6.4 duplicate_groups 表

用于记录重复图片组或相似图片组。

```sql
CREATE TABLE duplicate_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER,
    group_type TEXT NOT NULL, -- exact / similar / semantic

    recommended_media_id INTEGER,
    similarity_score REAL,
    status TEXT DEFAULT 'active',

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 6.5 duplicate_group_items 表

用于记录重复组内的媒体。

```sql
CREATE TABLE duplicate_group_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    media_id INTEGER NOT NULL,

    similarity_score REAL,
    quality_score REAL,
    recommendation TEXT, -- keep / remove / review
    reason TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (group_id) REFERENCES duplicate_groups(id),
    FOREIGN KEY (media_id) REFERENCES media_items(id)
);
```

---

## 6.6 video_segments 表

用于记录视频切分后的片段。

```sql
CREATE TABLE video_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,

    segment_index INTEGER,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    duration REAL NOT NULL,

    file_path TEXT,
    thumbnail_path TEXT,
    preview_path TEXT,

    blur_score REAL,
    stability_score REAL,
    exposure_score REAL,
    audio_score REAL,
    quality_score REAL,

    is_black_screen INTEGER DEFAULT 0,
    is_shaky INTEGER DEFAULT 0,
    is_blurry INTEGER DEFAULT 0,
    is_recommended INTEGER DEFAULT 0,

    recommendation TEXT, -- keep / remove / review
    reason TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (media_id) REFERENCES media_items(id)
);
```

---

## 6.7 processing_jobs 表

用于记录所有异步任务。

```sql
CREATE TABLE processing_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    media_id INTEGER,
    segment_id INTEGER,

    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',

    progress INTEGER DEFAULT 0,
    current_step TEXT,

    input_payload TEXT,
    output_payload TEXT,

    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,

    started_at DATETIME,
    finished_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (media_id) REFERENCES media_items(id),
    FOREIGN KEY (segment_id) REFERENCES video_segments(id)
);
```

job_type 示例：

```text
image_thumbnail
image_hash
image_analysis
image_duplicate
image_enhance
image_ai_refine

video_metadata
video_proxy
video_scene_detect
video_segment_analysis
video_enhance
video_ai_edit_plan
video_render
```

---

## 6.8 ai_invocations 表

用于记录 AI 调用情况，便于成本控制和排查问题。

```sql
CREATE TABLE ai_invocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    media_id INTEGER,
    segment_id INTEGER,

    provider TEXT,
    model_name TEXT,
    task_type TEXT,

    request_payload TEXT,
    response_payload TEXT,

    input_tokens INTEGER,
    output_tokens INTEGER,
    estimated_cost REAL,

    status TEXT,
    error_message TEXT,

    started_at DATETIME,
    finished_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

# 7. 状态机设计

## 7.1 媒体状态

media_items.status 可选值：

```text
uploaded
queued
processing
analyzed
enhanced
ai_refined
completed
failed
deleted
```

状态流转：

```text
uploaded
→ queued
→ processing
→ analyzed
→ enhanced
→ completed
```

失败时：

```text
processing
→ failed
```

删除时：

```text
completed / failed / analyzed
→ deleted
```

---

## 7.2 任务状态

processing_jobs.status 可选值：

```text
pending
running
success
failed
cancelled
retrying
```

状态流转：

```text
pending
→ running
→ success
```

失败重试：

```text
running
→ failed
→ retrying
→ running
```

超过最大重试次数：

```text
retrying
→ failed
```

用户取消：

```text
pending / running
→ cancelled
```

---

# 8. 图片处理设计

## 8.1 图片处理总体流程

```text
上传图片
→ 保存原图
→ 创建处理任务
→ 生成缩略图
→ 读取 EXIF
→ 计算文件 hash
→ 判断完全重复
→ 计算 pHash / dHash
→ 提取 embedding
→ 相似图片分组
→ 模糊检测
→ 曝光检测
→ 色彩检测
→ 综合质量评分
→ 推荐保留图片
→ 自动增强
→ 前端展示结果
→ 用户确认或 AI 精修
```

---

## 8.2 缩略图生成

### 处理工具

推荐使用 sharp。

### 处理策略

生成两种图：

1. thumbnail：小图，用于列表。
2. preview：中等尺寸，用于详情预览。

建议尺寸：

```text
thumbnail: 最大边 400px
preview: 最大边 1600px
```

### 输出格式

推荐统一输出为 WebP：

```text
thumbnail.webp
preview.webp
```

---

## 8.3 完全重复检测

### 算法

使用文件 hash：

```text
MD5 或 SHA256
```

### 判断逻辑

如果两个文件 hash 完全相同，则认为是完全重复。

### 处理结果

1. 标记 is_duplicate = true。
2. 创建 duplicate_group。
3. group_type = exact。
4. 只推荐保留一张。

---

## 8.4 近似重复检测

### 第一层：pHash / dHash

用于快速识别视觉高度相似图片。

推荐阈值：

```text
Hamming distance <= 5：高度相似
Hamming distance <= 10：疑似相似
Hamming distance > 10：不认为重复
```

---

### 第二层：DINOv2 / CLIP embedding

用于识别同一场景、同一主体、不同角度或轻微变化的图片。

推荐流程：

```text
图片缩放到统一尺寸
→ 提取 embedding
→ 存入向量索引
→ 使用 FAISS 检索近邻
→ 根据 cosine similarity 分组
```

推荐阈值：

```text
similarity >= 0.95：高度重复
similarity >= 0.90：相似
similarity >= 0.85：疑似相似
```

---

## 8.5 模糊检测

### 基础算法

使用 Laplacian variance：

```text
score = variance(Laplacian(gray_image))
```

推荐阈值：

```text
score < 30：严重模糊
30 <= score < 80：疑似模糊
score >= 80：清晰
```

实际阈值需要根据项目图片样本调参。

---

### 人像特殊处理

对于人像图片，不能只看全图清晰度。

应优先检测：

1. 人脸区域是否清晰。
2. 眼睛区域是否清晰。
3. 主体区域是否清晰。

如果背景虚化但人物清晰，不应判定为模糊废片。

---

## 8.6 曝光检测

### 判断维度

1. 平均亮度。
2. 高光溢出比例。
3. 暗部死黑比例。
4. 直方图分布。

### 推荐规则

```text
高光像素比例 > 15%：疑似过曝
暗部像素比例 > 25%：疑似欠曝
平均亮度过低：欠曝
平均亮度过高：过曝
```

---

## 8.7 色偏检测

### 处理方式

计算 RGB 或 LAB 色彩空间分布。

判断是否存在：

1. 偏蓝。
2. 偏黄。
3. 偏绿。
4. 偏红。
5. 水下偏色。

### 输出结果

```text
color_score
color_cast_type
color_cast_strength
```

---

## 8.8 综合质量评分

综合质量评分使用加权方式生成。

示例：

```text
quality_score =
  sharpness_score * 0.35
+ exposure_score  * 0.20
+ color_score     * 0.15
+ noise_score     * 0.10
+ aesthetic_score * 0.20
```

第一阶段可以先不接入复杂美学模型，aesthetic_score 可以为空或使用简单规则。

---

## 8.9 重复组最佳图片选择

在同一个重复组内，系统推荐保留质量最高的一张。

排序依据：

1. 清晰度更高。
2. 曝光更正常。
3. 色彩更自然。
4. 主体更完整。
5. 人脸更清晰。
6. 构图更好。
7. 文件分辨率更高。

推荐结果：

```text
recommendation = keep
reason = "清晰度最高，曝光正常，主体完整"
```

其他图片：

```text
recommendation = remove
reason = "与推荐图片高度相似，清晰度较低"
```

---

## 8.10 图片自动增强

### 处理原则

自动增强只针对推荐保留图片执行。

自动增强不调用 AI 模型，优先使用 sharp / OpenCV。

### 处理内容

1. 自动白平衡。
2. 自动亮度调整。
3. 自动对比度调整。
4. 自动色彩校正。
5. 轻度锐化。
6. 轻度降噪。
7. 自动拉直。
8. 自动裁切建议。

### 输出结果

保存为新版本：

```text
version_type = enhanced
```

---

## 8.11 图片 AI 精修

### 触发条件

AI 精修不默认执行。

触发方式：

1. 用户手动点击 AI 精修。
2. 系统识别为高价值图片后建议用户精修。
3. 管理配置允许自动精修精选图片。

### 处理任务

1. 去除路人。
2. 去除杂物。
3. 修复天空。
4. 修复局部阴影。
5. 水下偏色修正。
6. 人像细节优化。
7. 高级色彩风格优化。

### 输出结果

保存为新版本：

```text
version_type = ai_refined
```

同时记录：

1. 模型名称。
2. 请求参数。
3. 处理时间。
4. 费用估算。
5. 失败原因。

---

# 9. 视频处理设计

## 9.1 视频处理总体流程

```text
上传视频
→ 保存原视频
→ 读取视频元信息
→ 生成封面图
→ 生成代理视频
→ 抽取关键帧
→ 镜头切分
→ 分析片段清晰度
→ 分析片段稳定性
→ 检测黑场和废片
→ 生成候选片段
→ 基础优化
→ AI 生成剪辑方案
→ FFmpeg 合成短视频
→ 前端展示结果
```

---

## 9.2 视频元信息读取

使用 ffprobe 读取：

1. 时长。
2. 分辨率。
3. 帧率。
4. 码率。
5. 编码格式。
6. 音频格式。
7. 音频声道。
8. 文件大小。

输出写入 media_items 表。

---

## 9.3 代理视频生成

为了减少前端加载压力，上传后生成低清代理视频。

推荐参数：

```text
分辨率：720p
编码：H.264
音频：AAC
格式：MP4
```

示例命令：

```bash
ffmpeg -i input.mov -vf scale=-2:720 -c:v libx264 -preset fast -crf 28 -c:a aac output_proxy.mp4
```

---

## 9.4 视频封面生成

从视频中抽取一帧作为封面。

推荐选择：

1. 视频 10% 位置。
2. 如果该帧黑屏，则继续向后查找。
3. 如果存在推荐片段，则使用推荐片段第一帧。

示例命令：

```bash
ffmpeg -ss 00:00:03 -i input.mp4 -frames:v 1 thumbnail.jpg
```

---

## 9.5 视频镜头切分

### 第一选择

使用 PySceneDetect。

### 备用方案

如果 PySceneDetect 失败，使用固定时间切片。

固定切片规则：

```text
视频小于 1 分钟：按 5 秒切片
视频 1 到 10 分钟：按 10 秒切片
视频超过 10 分钟：按 15 到 30 秒切片
```

---

## 9.6 关键帧抽取

对每个视频片段抽取关键帧。

推荐规则：

```text
片段小于 5 秒：抽 3 帧
片段 5 到 30 秒：每 2 秒抽 1 帧
片段超过 30 秒：每 5 秒抽 1 帧
```

关键帧用于：

1. 模糊检测。
2. 曝光检测。
3. 内容识别。
4. 缩略图生成。
5. AI 视频理解输入。

---

## 9.7 视频模糊检测

对片段关键帧逐帧计算清晰度。

片段清晰度评分：

```text
segment_blur_score = average(frame_blur_scores)
```

判断规则：

```text
平均清晰度低：疑似模糊
连续多帧低清晰度：严重模糊
只有少数帧模糊：保留观察
```

---

## 9.8 视频抖动检测

通过连续帧特征点位移或光流变化判断抖动。

判断维度：

1. 帧间位移幅度。
2. 位移方向变化频率。
3. 画面旋转变化。
4. 高频震动程度。

输出：

```text
stability_score
is_shaky
shake_reason
```

---

## 9.9 黑场检测

通过亮度判断黑屏或镜头遮挡。

规则示例：

```text
平均亮度 < 10
且持续时间 > 1 秒
则标记为黑场片段
```

---

## 9.10 废片识别

废片类型包括：

1. 黑场。
2. 严重模糊。
3. 严重抖动。
4. 长时间拍地面。
5. 长时间无主体。
6. 误触录制。
7. 音频异常。
8. 过短且无价值。
9. 重复片段。

第一阶段优先实现：

1. 黑场。
2. 模糊。
3. 抖动。
4. 过短片段。
5. 低质量片段。

---

## 9.11 视频基础优化

对候选保留片段进行基础优化。

处理内容：

1. 转码。
2. 分辨率统一。
3. 帧率统一。
4. 轻度防抖。
5. 亮度调整。
6. 对比度调整。
7. 音量归一化。
8. 生成预览文件。

所有优化片段保存为新文件，不覆盖原始视频片段。

---

## 9.12 视频 AI 智能剪辑

### 输入

AI 不直接处理所有原始长视频。

AI 输入应是经过筛选后的候选数据：

1. 候选片段列表。
2. 每个片段的开始时间。
3. 每个片段的结束时间。
4. 每个片段缩略图。
5. 每个片段关键帧。
6. 每个片段质量评分。
7. 每个片段已有标签。
8. 可选语音转文字结果。

---

### 输出

AI 输出剪辑方案：

```json
{
  "title": "旅行精选短片",
  "target_duration": 60,
  "segments": [
    {
      "segment_id": 1,
      "start_time": 12.5,
      "end_time": 18.0,
      "reason": "开场风景清晰，适合作为开头"
    },
    {
      "segment_id": 5,
      "start_time": 43.0,
      "end_time": 52.0,
      "reason": "人物动作完整，画面稳定"
    }
  ],
  "summary": "本短片以风景开场，中段展示人物活动，最后以日落结束"
}
```

---

### 合成

最终合成仍由 FFmpeg 完成。

AI 只负责生成剪辑方案，不直接负责底层视频处理。

---

# 10. API 设计

## 10.1 媒体上传

```http
POST /api/media/upload
```

功能：

1. 上传图片或视频。
2. 保存原始文件。
3. 创建 media_items 记录。
4. 创建初始处理任务。

返回：

```json
{
  "media_id": 123,
  "status": "uploaded"
}
```

---

## 10.2 获取媒体列表

```http
GET /api/media?trip_id=1&type=image
```

返回：

```json
{
  "items": [
    {
      "id": 123,
      "type": "image",
      "thumbnail_path": "/storage/thumbnails/123.webp",
      "status": "completed",
      "quality_score": 87,
      "is_recommended": true
    }
  ]
}
```

---

## 10.3 获取媒体详情

```http
GET /api/media/:id
```

返回内容包括：

1. 基础信息。
2. 缩略图。
3. 原始文件。
4. 分析结果。
5. 版本列表。
6. 重复组信息。
7. 任务状态。

---

## 10.4 重新处理媒体

```http
POST /api/media/:id/process
```

请求示例：

```json
{
  "stages": ["analysis", "duplicate", "enhance"]
}
```

---

## 10.5 一键增强

```http
POST /api/media/:id/enhance
```

功能：

1. 创建 image_enhance 任务。
2. Worker 生成 enhanced 版本。
3. 前端查询任务状态。

---

## 10.6 AI 精修

```http
POST /api/media/:id/ai-refine
```

请求示例：

```json
{
  "instruction": "去掉背景中的路人，保持画面自然",
  "base_version": "enhanced"
}
```

---

## 10.7 获取重复组

```http
GET /api/duplicate-groups?trip_id=1
```

返回：

```json
{
  "groups": [
    {
      "id": 10,
      "group_type": "similar",
      "recommended_media_id": 123,
      "items": [
        {
          "media_id": 123,
          "quality_score": 90,
          "recommendation": "keep"
        },
        {
          "media_id": 124,
          "quality_score": 75,
          "recommendation": "remove"
        }
      ]
    }
  ]
}
```

---

## 10.8 获取视频片段

```http
GET /api/videos/:id/segments
```

返回：

```json
{
  "segments": [
    {
      "id": 1,
      "start_time": 10.5,
      "end_time": 18.0,
      "duration": 7.5,
      "thumbnail_path": "/storage/segments/1.webp",
      "quality_score": 82,
      "recommendation": "keep",
      "reason": "画面稳定，主体清晰"
    }
  ]
}
```

---

## 10.9 生成视频剪辑方案

```http
POST /api/videos/:id/generate-edit-plan
```

请求示例：

```json
{
  "target_duration": 60,
  "style": "travel_highlight"
}
```

---

## 10.10 渲染最终视频

```http
POST /api/videos/:id/render
```

请求示例：

```json
{
  "edit_plan_id": 1001,
  "resolution": "1080p"
}
```

---

# 11. Worker 设计

## 11.1 Worker 类型

系统建议拆分为三个 Worker：

```text
ImageWorker
VideoWorker
AIWorker
```

---

## 11.2 ImageWorker

负责处理任务：

```text
image_thumbnail
image_hash
image_analysis
image_duplicate
image_enhance
```

主要函数：

```text
generateThumbnail()
readExif()
calculateFileHash()
calculatePerceptualHash()
extractImageEmbedding()
detectBlur()
detectExposure()
detectColorCast()
calculateQualityScore()
createDuplicateGroups()
enhanceImage()
```

---

## 11.3 VideoWorker

负责处理任务：

```text
video_metadata
video_thumbnail
video_proxy
video_scene_detect
video_segment_analysis
video_enhance
video_render
```

主要函数：

```text
readVideoMetadata()
generateVideoThumbnail()
generateProxyVideo()
detectScenes()
extractKeyFrames()
analyzeSegmentBlur()
analyzeSegmentStability()
detectBlackScreen()
scoreVideoSegment()
enhanceVideoSegment()
renderFinalVideo()
```

---

## 11.4 AIWorker

负责处理任务：

```text
image_ai_refine
image_ai_judge
video_ai_understand
video_ai_edit_plan
caption_generate
title_generate
```

主要函数：

```text
refineImage()
judgeImageGroup()
understandVideoSegments()
generateEditPlan()
generateTitle()
generateCaption()
recordAIInvocation()
```

---

## 11.5 Worker 并发控制

建议第一阶段并发配置：

```text
ImageWorker: 2 到 4 并发
VideoWorker: 1 并发
AIWorker: 1 并发
```

原因：

1. 图片处理相对轻量，可以适度并发。
2. 视频处理占用 CPU 和磁盘 IO，需要限制并发。
3. AI 调用有成本和限流，需要严格控制。

---

# 12. 任务调度设计

## 12.1 上传后任务创建

图片上传后创建任务：

```text
image_thumbnail
image_hash
image_analysis
image_duplicate
```

图片基础分析完成后，如果被推荐保留，再创建：

```text
image_enhance
```

---

视频上传后创建任务：

```text
video_metadata
video_thumbnail
video_proxy
video_scene_detect
video_segment_analysis
```

用户点击生成短视频后创建：

```text
video_ai_edit_plan
video_render
```

---

## 12.2 任务依赖关系

图片任务依赖：

```text
image_thumbnail
    ↓
image_hash
    ↓
image_analysis
    ↓
image_duplicate
    ↓
image_enhance
```

视频任务依赖：

```text
video_metadata
    ↓
video_thumbnail
    ↓
video_proxy
    ↓
video_scene_detect
    ↓
video_segment_analysis
    ↓
video_ai_edit_plan
    ↓
video_render
```

---

## 12.3 失败重试策略

默认重试策略：

```text
最大重试次数：3
第一次失败：立即重试
第二次失败：延迟 30 秒
第三次失败：延迟 2 分钟
超过次数：标记 failed
```

不可重试错误：

1. 文件不存在。
2. 文件格式不支持。
3. 数据库记录不存在。
4. 用户取消任务。

可重试错误：

1. 临时文件占用。
2. FFmpeg 临时失败。
3. AI API 超时。
4. 网络请求失败。
5. Worker 进程异常。

---

# 13. 前端设计

## 13.1 页面结构

前端建议包括以下页面：

```text
/media/upload
/media
/media/:id
/duplicates
/videos/:id/segments
/jobs
/settings
```

---

## 13.2 上传页面

功能：

1. 拖拽上传。
2. 批量上传。
3. 上传进度显示。
4. 上传失败提示。
5. 上传成功后自动进入媒体列表。

---

## 13.3 媒体列表页面

展示字段：

1. 缩略图。
2. 媒体类型。
3. 处理状态。
4. 质量评分。
5. 是否重复。
6. 是否模糊。
7. 是否推荐保留。
8. 是否已增强。
9. 是否已 AI 精修。

---

## 13.4 图片详情页面

展示内容：

1. 原图预览。
2. 增强图预览。
3. AI 精修图预览。
4. EXIF 信息。
5. 分析评分。
6. 推荐理由。
7. 操作按钮。

操作按钮：

```text
保留
删除
恢复
一键增强
AI 精修
重新处理
选择当前版本
```

---

## 13.5 重复组页面

展示内容：

1. 重复组列表。
2. 组内图片对比。
3. 推荐保留图。
4. 每张图片评分。
5. 推荐原因。
6. 手动选择保留图。
7. 批量删除未保留图。

---

## 13.6 视频片段页面

展示内容：

1. 原视频。
2. 代理视频。
3. 片段列表。
4. 片段缩略图。
5. 片段起止时间。
6. 质量评分。
7. 推荐原因。
8. 生成短视频按钮。

---

## 13.7 任务状态页面

展示内容：

1. 所有任务。
2. 等待任务。
3. 运行任务。
4. 成功任务。
5. 失败任务。
6. 当前进度。
7. 错误信息。
8. 重试按钮。

---

# 14. AI 调用设计

## 14.1 AI Provider 抽象

AI 调用必须封装，不允许业务代码直接绑定某一个模型。

设计接口：

```ts
interface AIProvider {
  refineImage(input: ImageRefineInput): Promise<ImageRefineResult>;
  judgeImages(input: ImageJudgeInput): Promise<ImageJudgeResult>;
  understandVideo(input: VideoUnderstandInput): Promise<VideoUnderstandResult>;
  generateEditPlan(input: EditPlanInput): Promise<EditPlanResult>;
}
```

---

## 14.2 模型配置

配置文件示例：

```json
{
  "ai": {
    "enabled": true,
    "imageRefineProvider": "openai",
    "videoUnderstandProvider": "gemini",
    "maxDailyInvocations": 100,
    "maxConcurrentInvocations": 1
  }
}
```

---

## 14.3 成本控制

控制策略：

1. 默认不全量调用 AI。
2. 只对候选图片或候选视频片段调用 AI。
3. AI 精修需要用户主动触发。
4. 每次调用记录 ai_invocations。
5. 限制每日调用次数。
6. 限制单个相册调用次数。
7. 限制视频输入长度和关键帧数量。

---

# 15. 日志设计

## 15.1 日志类型

系统日志分为：

1. API 请求日志。
2. Worker 处理日志。
3. 任务状态日志。
4. FFmpeg 命令日志。
5. Python 分析日志。
6. AI 调用日志。
7. 错误日志。

---

## 15.2 日志内容

每条日志建议包含：

```text
timestamp
level
module
job_id
media_id
message
error_stack
duration_ms
```

---

## 15.3 日志存储

第一阶段可以写入本地文件：

```text
storage/logs/app.log
storage/logs/worker.log
storage/logs/ffmpeg.log
storage/logs/ai.log
```

后续可以接入：

1. CloudWatch。
2. OpenSearch。
3. Loki。
4. ELK。

---

# 16. 错误处理设计

## 16.1 文件错误

常见错误：

1. 文件不存在。
2. 文件损坏。
3. 文件格式不支持。
4. 文件过大。
5. 文件无法读取。

处理方式：

1. 标记任务失败。
2. 写入 error_message。
3. 不删除原文件。
4. 前端显示失败原因。

---

## 16.2 图片处理错误

常见错误：

1. sharp 读取失败。
2. EXIF 读取失败。
3. OpenCV 分析失败。
4. embedding 提取失败。

处理方式：

1. 非关键步骤失败不影响整体流程。
2. 缩略图失败则标记处理失败。
3. EXIF 失败可以继续。
4. embedding 失败可以退回 pHash / dHash。

---

## 16.3 视频处理错误

常见错误：

1. ffprobe 失败。
2. FFmpeg 转码失败。
3. 镜头切分失败。
4. 抽帧失败。
5. 片段生成失败。

处理方式：

1. ffprobe 失败则视频不可处理。
2. 镜头切分失败则使用固定时间切片。
3. 抽帧失败则跳过片段分析。
4. 转码失败则保留原视频。

---

## 16.4 AI 调用错误

常见错误：

1. API Key 无效。
2. 额度不足。
3. 请求超时。
4. 模型限流。
5. 返回格式错误。

处理方式：

1. 记录 ai_invocations。
2. 标记任务失败。
3. 不影响基础处理结果。
4. 前端提示用户稍后重试。
5. 支持切换备用模型。

---

# 17. 安全设计

## 17.1 上传安全

1. 限制文件类型。
2. 限制文件大小。
3. 校验 MIME 类型。
4. 避免直接使用原始文件名。
5. 文件路径必须通过安全函数生成。
6. 禁止路径穿越。

---

## 17.2 API 安全

1. 所有写操作需要鉴权。
2. 用户只能访问自己的媒体。
3. 删除操作需要二次确认。
4. AI 精修需要权限控制。
5. 管理配置接口仅管理员可用。

---

## 17.3 模型调用安全

1. API Key 只能保存在服务端。
2. 前端不能直接调用模型 API。
3. AI 调用参数需要限制长度。
4. 不把敏感信息发送给模型。
5. 模型返回结果需要校验。

---

# 18. 性能设计

## 18.1 图片性能

优化策略：

1. 上传后优先生成缩略图。
2. 前端优先展示缩略图。
3. 图片分析批量执行。
4. embedding 提取限制并发。
5. 图片增强只处理推荐保留图。

---

## 18.2 视频性能

优化策略：

1. 上传后先生成代理视频。
2. 前端播放代理视频。
3. 视频处理单任务并发。
4. 长视频分段处理。
5. 只对候选片段做后续分析。
6. 合成短视频时限制分辨率和码率。

---

## 18.3 前端性能

优化策略：

1. 媒体列表分页加载。
2. 缩略图懒加载。
3. 视频片段按需加载。
4. 任务状态轮询间隔控制。
5. 大量媒体使用虚拟列表。

---

# 19. 可扩展性设计

## 19.1 存储扩展

第一阶段使用本地文件系统。

后续可扩展到：

1. Amazon S3。
2. CloudFront CDN。
3. EFS 共享存储。
4. 对象存储生命周期管理。

---

## 19.2 数据库扩展

第一阶段可使用 SQLite。

当媒体数量增加后，迁移到 PostgreSQL。

迁移重点：

1. media_items。
2. media_analysis。
3. duplicate_groups。
4. video_segments。
5. processing_jobs。
6. ai_invocations。

---

## 19.3 Worker 扩展

后续可以将 Worker 拆成独立服务：

```text
api-service
image-worker
video-worker
ai-worker
```

通过队列解耦。

---

## 19.4 模型扩展

AI Provider 采用抽象接口，后续可替换：

1. OpenAI。
2. Gemini。
3. Claude。
4. GLM。
5. Qwen。
6. 本地模型。
7. 私有化模型。

---

# 20. 阶段实施设计

## 20.1 第一阶段：图片基础处理

目标：

```text
先让图片自动整理能力稳定可用
```

实现内容：

1. 图片上传。
2. 缩略图生成。
3. EXIF 读取。
4. 文件 hash。
5. pHash / dHash。
6. 模糊检测。
7. 曝光检测。
8. 质量评分。
9. 重复组展示。
10. 推荐保留图。
11. 一键增强。

暂不实现：

1. AI 精修。
2. 视频智能剪辑。
3. 大模型批量判断。

---

## 20.2 第二阶段：视频基础处理

目标：

```text
实现视频自动切片和废片筛选
```

实现内容：

1. 视频上传。
2. ffprobe 元信息读取。
3. 封面生成。
4. 代理视频生成。
5. 抽帧。
6. 镜头切分。
7. 模糊检测。
8. 抖动检测。
9. 黑场检测。
10. 片段展示。

---

## 20.3 第三阶段：图片 AI 精修

目标：

```text
对少量高价值图片提供 AI 精修能力
```

实现内容：

1. AI Provider 封装。
2. AI 精修任务。
3. AI 调用日志。
4. 图片版本管理。
5. 原图、增强图、AI 精修图对比。
6. 成本控制。

---

## 20.4 第四阶段：视频智能剪辑

目标：

```text
基于候选视频片段生成短视频
```

实现内容：

1. 候选片段输入。
2. AI 生成剪辑方案。
3. 用户预览剪辑方案。
4. 用户调整片段顺序。
5. FFmpeg 合成视频。
6. 输出 30 秒、1 分钟、5 分钟版本。

---

# 21. 关键实现建议

## 21.1 不要上传后立即做所有任务

上传完成后优先做：

1. 保存原文件。
2. 生成缩略图。
3. 创建后台任务。

前端不等待全部处理完成。

---

## 21.2 不要让 AI 处理全量文件

AI 只处理：

1. 推荐保留图片。
2. 用户主动选择的图片。
3. 视频候选片段。
4. 系统无法判断的边界案例。

---

## 21.3 删除操作不要直接物理删除

建议先软删除：

```text
media_items.status = deleted
```

物理删除可以后续由清理任务执行。

---

## 21.4 重复图片只推荐，不强制删除

系统只给建议：

```text
推荐保留
建议删除
需要人工确认
```

最终由用户确认。

---

## 21.5 每个处理步骤都要可重新执行

例如：

1. 重新生成缩略图。
2. 重新检测模糊。
3. 重新计算质量评分。
4. 重新执行自动增强。
5. 重新生成视频片段。
6. 重新生成剪辑方案。

---

# 22. 最终设计总结

本系统采用分层式智能媒体处理架构。

图片处理流程：

```text
上传
→ 缩略图
→ EXIF
→ hash 去重
→ pHash / dHash
→ embedding 聚类
→ 模糊检测
→ 曝光和色彩检测
→ 质量评分
→ 推荐保留
→ 自动增强
→ 按需 AI 精修
```

视频处理流程：

```text
上传
→ 元信息读取
→ 封面
→ 代理视频
→ 抽帧
→ 镜头切分
→ 片段质量分析
→ 废片识别
→ 候选片段
→ 基础优化
→ AI 剪辑方案
→ FFmpeg 合成
```

核心设计原则：

1. 传统算法处理大批量基础任务。
2. AI 模型只处理高价值和复杂判断任务。
3. 所有任务异步执行。
4. 所有原始文件永久保留。
5. 所有处理结果保存为新版本。
6. 系统只做推荐，不自动永久删除。
7. 每个任务可追踪、可重试、可恢复。
8. 数据库记录处理状态、分析结果、版本和日志。
9. 前端持续展示进度和推荐理由。
10. 后续可平滑扩展到 S3、PostgreSQL、独立 Worker 和多模型架构。

本设计既能保证第一阶段快速落地，也为后续 AI 精修、视频智能剪辑和云端扩展预留了完整架构空间。