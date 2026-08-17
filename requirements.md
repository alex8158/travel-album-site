# 需求文档

> **本文档的定位**
>
> - **第一部分**（下方"简介"至"超出范围"）是 v1 MVP 的基线需求，2026-03-31 完成，属于历史记录。
> - **第二部分**是各功能迭代的总览索引，用于快速定位到具体 spec。
>
> **本文档不是实现契约。** 每个功能的权威需求在 `.kiro/specs/<feature>/requirements.md`；本仓库还存在 `docs/requirements-v2.md`（产品愿景，非契约）。三套文档的权威顺序与使用规则见 `AGENTS.md` 第 5.1 节。

## 简介

旅行相册展示网站是一个自动化的媒体管理与展示系统。用户只需批量上传旅行素材（图片和视频），填写旅行标题和可选说明，系统即可自动完成文件类型识别、图片去重/近重复聚合、最佳质量图片选择，并最终生成一个按旅行维度组织的相册/视频展示网站。

## 术语表

- **Upload_Manager**：负责接收和处理用户批量上传素材的模块
- **File_Classifier**：负责自动识别上传文件类型（图片或视频）的模块
- **Dedup_Engine**：负责对图片进行去重和近重复聚合的模块
- **Quality_Selector**：负责在重复或近似图片组中选择质量最好的一张作为默认展示图的模块
- **Site_Generator**：负责自动生成按旅行维度组织的相册/视频展示页面的模块
- **Trip**：一次旅行，作为素材组织的基本维度，包含标题、可选说明和一批关联素材
- **Media_Item**：一个上传的素材文件，可以是图片或视频
- **Duplicate_Group**：一组被判定为重复或近似的图片集合
- **Gallery_Page**：展示某次旅行所有素材的页面

## 需求

### 需求 1：批量素材上传

**用户故事：** 作为旅行者，我想要批量上传一次旅行的图片和视频素材，以便系统能够统一处理和展示这些素材。

#### 验收标准

1. THE Upload_Manager SHALL 支持用户在单次操作中选择并上传多个文件
2. THE Upload_Manager SHALL 支持常见图片格式（JPEG、PNG、WebP、HEIC）和常见视频格式（MP4、MOV、AVI、MKV）的上传
3. WHEN 用户选择的文件超出支持的格式范围时, THE Upload_Manager SHALL 在上传前提示用户该文件格式不受支持并跳过该文件
4. WHEN 上传过程中发生网络中断, THE Upload_Manager SHALL 保留已成功上传的文件并允许用户重新上传失败的文件
5. WHILE 文件正在上传中, THE Upload_Manager SHALL 显示每个文件的上传进度百分比

### 需求 2：旅行信息填写

**用户故事：** 作为旅行者，我想要为每批上传的素材填写旅行标题和可选说明，以便在展示网站中清晰标识每次旅行。

#### 验收标准

1. THE Upload_Manager SHALL 要求用户为每批上传的素材填写一个旅行标题
2. THE Upload_Manager SHALL 允许用户为每次旅行填写一段可选的文字说明
3. WHEN 用户未填写旅行标题即尝试提交时, THE Upload_Manager SHALL 阻止提交并提示用户填写标题
4. THE Upload_Manager SHALL 允许用户在素材上传完成后修改旅行标题和说明

### 需求 3：文件类型自动识别

**用户故事：** 作为旅行者，我想要系统自动识别上传文件是图片还是视频，以便无需手动分类素材。

#### 验收标准

1. WHEN 文件上传完成后, THE File_Classifier SHALL 根据文件的 MIME 类型和文件头信息自动将每个文件分类为图片或视频
2. WHEN File_Classifier 无法确定文件类型时, THE File_Classifier SHALL 将该文件标记为"未知类型"并通知用户
3. THE File_Classifier SHALL 在文件上传完成后 2 秒内完成单个文件的类型识别

### 需求 4：图片去重与近重复聚合

**用户故事：** 作为旅行者，我想要系统自动识别并聚合重复或近似的图片，以便展示页面不会出现大量重复内容。

#### 验收标准

1. WHEN 一批图片上传并完成类型识别后, THE Dedup_Engine SHALL 自动对该批图片进行去重和近重复检测
2. THE Dedup_Engine SHALL 使用感知哈希算法（如 pHash 或 dHash）计算图片相似度
3. WHEN 两张图片的感知哈希相似度超过预设阈值时, THE Dedup_Engine SHALL 将这两张图片归入同一个 Duplicate_Group
4. THE Dedup_Engine SHALL 为每个 Duplicate_Group 保留所有原始图片文件，不删除任何用户上传的素材
5. WHEN 去重处理完成后, THE Dedup_Engine SHALL 向用户展示聚合结果摘要，包括检测到的 Duplicate_Group 数量和每组包含的图片数量

### 需求 5：最佳质量图片自动选择

**用户故事：** 作为旅行者，我想要系统在重复或近似图片中自动选择质量最好的一张作为默认展示图，以便展示页面呈现最佳视觉效果。

#### 验收标准

1. WHEN 一个 Duplicate_Group 被创建后, THE Quality_Selector SHALL 自动从该组中选择一张质量最好的图片作为默认展示图
2. THE Quality_Selector SHALL 基于图片分辨率（像素总数）、文件大小和清晰度评分综合评估图片质量
3. THE Quality_Selector SHALL 优先选择分辨率最高的图片作为默认展示图
4. WHEN 一个 Duplicate_Group 中多张图片分辨率相同时, THE Quality_Selector SHALL 选择清晰度评分最高的图片作为默认展示图
5. THE Gallery_Page SHALL 允许用户手动更换 Duplicate_Group 的默认展示图

### 需求 6：旅行相册展示网站生成

**用户故事：** 作为旅行者，我想要系统自动生成一个按旅行维度组织的相册/视频展示网站，以便方便地浏览和分享旅行回忆。

#### 验收标准

1. WHEN 素材处理完成后, THE Site_Generator SHALL 自动生成一个包含所有旅行的首页
2. THE Site_Generator SHALL 在首页按时间倒序排列所有 Trip，每个 Trip 显示标题、说明摘要和一张封面图
3. WHEN 用户点击某个 Trip 时, THE Site_Generator SHALL 展示该 Trip 的 Gallery_Page
4. THE Gallery_Page SHALL 将图片和视频分区展示，图片区域使用网格布局，视频区域使用列表布局
5. WHEN 用户点击 Gallery_Page 中的某张图片时, THE Gallery_Page SHALL 以灯箱模式全屏展示该图片并支持左右切换浏览
6. WHEN 用户点击 Gallery_Page 中的某个视频时, THE Gallery_Page SHALL 使用内嵌播放器播放该视频
7. THE Site_Generator SHALL 生成响应式页面，在桌面端和移动端均可正常浏览
8. THE Site_Generator SHALL 为每张展示图片生成缩略图以加快页面加载速度

### 需求 7：封面图自动选择

**用户故事：** 作为旅行者，我想要系统自动为每次旅行选择一张封面图，以便首页展示更加美观。

#### 验收标准

1. WHEN 一个 Trip 的素材处理完成后, THE Site_Generator SHALL 自动选择该 Trip 中质量评分最高的图片作为封面图
2. THE Gallery_Page SHALL 允许用户手动更换 Trip 的封面图
3. IF 一个 Trip 中没有任何图片素材, THEN THE Site_Generator SHALL 使用视频的第一帧作为封面图
4. IF 一个 Trip 中既没有图片也无法从视频提取帧, THEN THE Site_Generator SHALL 使用默认占位图作为封面图

## 超出范围 / 后续版本规划

以下功能点不在当前版本的实现范围内，将在后续版本中规划和实现：

1. **复杂社交功能**：如评论、点赞、分享到社交平台等互动功能
2. **多用户系统**：支持多用户注册、登录及独立的个人空间管理
3. **在线图片精修**：在网站内提供图片裁剪、滤镜、调色等编辑功能
4. **复杂权限体系**：细粒度的访问控制，如按旅行、按用户设置查看/编辑权限
5. **自动剪辑视频**：基于上传的视频素材自动生成旅行精彩片段或混剪视频
6. **高级搜索**：按地点、日期、标签等多维度检索旅行和素材
7. **多语言**：支持界面和内容的多语言切换
---

# 第二部分：迭代需求总览

本部分汇总 `.kiro/specs/` 下各功能迭代的需求，作为主需求文档的补充索引。

上面第一部分的 7 条需求是项目的 v1 基线需求。项目实际演进过程中，绝大部分能力是通过独立 spec 迭代实现的。每个迭代的完整验收标准仍以各自 spec 目录下的 `requirements.md` 为准，本部分只做目标与关键点摘要。

统计：共 22 个迭代 spec，其中 20 个含编号需求文档（合计约 180 条编号需求），2 个为 bugfix 文档（`ai-dedup-fix`、`video-editing-fixes`）。

此外还有 1 份事后补写的 as-built 文档 `multi-user-system`（13 条需求），描述已实现但当初没有立 spec 的多用户系统，详见第七节。

## 一、照片筛选与去重

这条线是项目投入最大的方向，从"哈希去重"逐步演进为"哈希 + 嵌入向量 + VLM 多阶段筛选"。

### I-1 Python CLIP 分析（python-clip-analysis，7 条需求）

**目标**：用 Python 生态的 CLIP + OpenCV 替代 Node.js 传统算法和 AWS Rekognition，提升分类、模糊检测、去重的精度。Python 脚本以独立进程运行，Node.js 通过 `child_process` 调用，不常驻内存。

**关键点**：
- Python 环境、依赖与模型管理
- 基于 CLIP 的零样本图片分类
- 基于 OpenCV 的模糊检测
- 基于 CLIP embedding 的去重检测
- Python 脚本命令行接口 + Node.js 集成层
- 接入处理流水线

### I-2 混合去重（hybrid-dedup，7 条需求）

**目标**：合并原有两套独立去重引擎（pHash/dHash 的 `dedupEngine.ts` 与 Bedrock 视觉模型的 `dedupEngine.bedrock.ts`），解决"哈希误判构图相似但内容不同的照片"与"纯大模型成本高、速度慢"的两难。

**分层结构**：
- Layer 0 — Hash 预过滤
- Layer 1 — CLIP 三档粗筛
- Layer 2 — LLM 逐对精判
- Layer 3 — 质量选择与分组
- LLM 未配置时的回退策略
- 环境变量配置与多 Provider 自动检测

### I-3 智能筛选（smart-curation，12 条需求）

**目标**：取代原 `aiScreening` 阶段，建立三阶段智能选片引擎。面向水下/潜水摄影场景（蓝色调、低对比度为常态，不应被当作缺陷）。

**三个阶段**：
- **Phase 1 `smartCuration`**：相似度分组后，组内用技术质量评分（完全重复）或 VLM 评估（近似重复）保留最佳代表
- **Phase 2 `aiReview`**：对 Phase 1 后仍存活的**每一张**照片做独立 keep/trash 判断，捕捉因未分组或仅凭技术分胜出而残留的模糊/截断/低价值照片
- **Phase 3 `aiFinalDedup`**：按批次比较已合格照片，移除 DINOv2 因余弦相似度低于分组阈值而漏掉的冗余照片

**关键点**：
- 分层相似度分组（完全重复阈值默认 0.98，可通过 `SMART_CURATION_EXACT_THRESHOLD` 覆盖；近似重复默认 0.80，可通过 `SMART_CURATION_NEAR_THRESHOLD` 覆盖）
- 按组大小分配保留配额（2–3 张留 1；4–8 张留 1–2；9 张以上留 2–3）
- VLM 提示词面向"旅行幻灯片视频选片"而非通用重复检测
- 具体化 trash 原因枚举：`exact_duplicate`、`near_duplicate_worse`、`scene_redundant`、`blurry`、`low_subject_quality`、`low_aesthetic_quality`、`low_video_value`
- 只做软删除（`status = 'trashed'`，`file_path` 不变）
- 生成调试用 JSON 报告
- VLM 调用效率约束（单次最多 5 张候选、并发上限 3、完全重复组不调 VLM）
- 已知限制：Phase 3 不跨批次比较，落在批次边界两侧的近似重复会同时保留（这是成本与覆盖率的显式取舍）

### I-4 全局幸存者去重（global-survivor-dedup，9 条需求）

**目标**：在 VLM 组内去重之后补一道跨组去重。落在**不同**相似组里的近似重复照片原本会同时存活，本阶段用纯 DINOv2 嵌入扫描所有剩余 active 照片，在过曝去重之前拦下它们。

**关键点**：
- 插入点：相似组去重（step 10）之后、过曝去重（step 11）之前
- 复用已存库的 DINOv2 嵌入，**零 VLM 调用**、不重算嵌入
- 确认重复：余弦相似度 ≥ 0.88
- 灰度区（0.82–0.88）：需要 30 秒内的拍摄时间接近性作为补充证据
- 保留者按复合质量分选择（`sharpness*0.4 + aesthetic*0.3 + exposure*0.3 + 过曝惩罚`）
- 多张构成连通簇时（传递闭包）只留质量分最高的一张
- trash 原因 `global_similarity_after_vlm`，软删除
- 结果中上报 `globalSimilarityAfterVlmDeletedCount`

### I-5 照片筛选缺陷修复（photo-curation-fix，6 条需求）

**目标**：修复 6 个相互关联的筛选缺陷。仅改服务端流水线（不动前端），并保留既有的模糊检测、哈希去重和"失败时全部保留"的保守策略。

**关键点**：
- **主体级过曝检测**：整图偏暗但主体（海蛞蝓、潜水装备、珊瑚）被打爆的情况，用 HSV 连通亮区分析识别（V ≥ 245 且 S ≤ 45，Sobel 梯度标准差 < 5.0 判定细节丢失，最小连通块 300 像素；面积占比 0.006 起判、单块上限 0.015、severe 阈值 0.012）。**不使用 LAB**
- 结果归并器承认 `overexposure` 为合法 trash 原因（此前会被静默覆盖）；多原因优先级 blur > overexposure > duplicate
- 跨批次全局相似候选生成（DINOv2 嵌入 + top-K 近邻 + union-find 聚类；CLIP 属独立的 hybrid-dedup 流水线），在 scene dedup 之前执行
- **VLM 状态上报**：`vlmStatus`（`success` / `partial_failure` / `skipped` / `unavailable`）+ `vlmCallStats` + `vlmDiagnostic`，区分"AI 没找到要删的"和"AI 根本没被调用"
- 阈值与日志一致性：`PROCESS_THRESHOLDS` 为主注册表，另有一张「允许的次级定义位置」表登记 smartCuration 各阶段的批次/并发参数与 VLM 传输配置；日志必须打印实际运行值
- 过曝阶段的错误不再被误标为 blur 阶段错误

### I-6 AI 去重修复（ai-dedup-fix，bugfix）

**问题**：用户报告 AI 相似照片去重实际效果很差——同场景连拍仍保留多张，AI 似乎没真正参与选优。

**根因**：VLM provider 配置不兼容。用户用 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` 配置，但 `vlmClient.ts` 只识别 `DASHSCOPE_API_KEY`、`ANTHROPIC_API_KEY` 和 AWS Bedrock 凭证，导致 `isVLMAvailable()` 返回 `false`，所有依赖 vlmClient 的 VLM 阶段被静默跳过。

**范围**：只修 AI 相似照片去重链路，不改前端、视频处理、上传逻辑和 P12 orchestrator。

### I-7 流水线图片优化（pipeline-image-optimization，6 条需求）

**关键点**：
- 模糊检测阶段结束后立即标记 `status = 'trashed', trashed_reason = 'blur'`，使后续 dedup、AI 筛选不再处理这些图片
- **AI 精修阶段**：对最终保留的图片调用 qwen-vl-max 取调整建议，再用 sharp 执行亮度/对比度/饱和度/锐度调整，存为 `optimized_path`
- AI 精修参数校验，及其与现有 optimize 阶段的关系
- DINOv2 去重阈值调整
- AI 筛选相似度预分组：改用 DINOv2/CLIP 相似度预分组，避免相似图片跨批次而无法同批比较

## 二、精选与精华分级

两级策展：精选（`is_highlight`）→ 精华（`is_highlight_tier`），后者始终是前者的严格子集。

### II-1 AI 照片精华挑选（ai-photo-highlights，8 条需求）

**目标**：技术筛选（CLIP 分类 + OpenCV 模糊检测 + 重复检测）通过后，用视觉大模型批量评审，完成两件事：按构图美感、独特瞬间、故事性、多样性挑出约 30–40% 的精华照片；识别相似照片组并推荐每组质量最好的一张。

**关键点**：
- 批量照片评审 / 精华照片挑选 / 相似组识别与最佳推荐
- 多 Provider 级联回退（OpenAI、Bedrock、DashScope）
- 结果持久化 + 触发入口 + 前端精华展示 + API 接口

### II-2 精华分级（highlight-tier，9 条需求）

**目标**：在精选之上加第二层策展。精选流水线完成后自动跑一次按类别（`people` / `animal` / `landscape` / `other`）的 VLM 选片，挑出各类别最好的照片进入"精华"层，并驱动一支专属幻灯片视频。

**关键点**：
- 精选评估成功后自动触发，只处理 `is_highlight = 1` 且 `status = 'active'` 的照片
- 库表扩展：`highlight_results.is_highlight_tier`、`media_items.category`
- **类别配额**：动物 6–9 张（每张不同动物主体、清晰、不过曝）；风景 3–9 张（最视觉突出且互不相似）；人物 3–9 张（每张不同场景）
- VLM 批次 10–15 张；超过 15 张时分子批，子批胜出者再跑一轮决出配额
- 所有提示词保留水下照片处理说明
- 精华照片自动生成幻灯片视频
- 我的相册"精华"标签页 + 公开画廊精华视频展示
- 子集不变式：精华必为精选子集，照片被 trash 时自动清除精华标记

### II-3 手动精华管理（manual-photo-management，10 条需求）

**目标**：精华选择原本完全由 AI 决定，本迭代加入人工干预能力。

**关键点**：
- 移除精华照片，移除后原位置显示 `+` 空位
- 通过 Photo Picker 从精选池补入照片（只显示 `is_highlight = 1` 且 `status = 'active'` 且尚未入精华的照片）
- 待删除（trashed）照片不可直接加入精华，需先恢复；API 返回 400 `NOT_ELIGIBLE`
- 类别配额改为**软限制**（仅提示 "动物: 7/6-9"，不阻止增删）
- 手动触发精华幻灯片视频重新生成
- 公开画廊拆成"全部"/"精华"两个标签页
- API：`PUT` / `DELETE /api/my/trips/:id/tier-photos/:photoId`、`POST /api/my/trips/:id/tier-slideshow/regenerate`（含 404 / 400 / 403 / 500 错误码约定）
- 保持子集不变式（trash 或取消精选时级联清除精华标记）

## 三、流水线架构与稳定性

### III-1 流水线 v4 重构（pipeline-v4-refactor，10 条需求）

**目标**：从"算法服务直接写数据库"改为"评估 → 归并 → 写入"三段式架构。原架构的问题：分类失败会级联导致模糊检测结果丢失；去重在下载或模型失败时静默退化为空结果；多个服务各自写库导致部分写入和不一致。

**三条原则**：
1. 每个能力（classify、blur、dedup）独立成功/失败
2. 算法服务只返回评估结果，不直接写库
3. 只有一个地方（`resultWriter`）写数据库

**关键点**：统一数据结构定义、流水线编排器、分类/模糊/去重评估纯函数化、ResultReducer、唯一写入点 ResultWriter、路由层精简、`analyze.py` 独立错误返回、统一阈值配置

### III-2 流水线健壮性（pipeline-robustness，5 条需求）

**关键点**：
- TypeScript 与 Python 之间的 blur 状态类型对齐
- 单张图片下载失败的优雅降级（不拖垮整批）
- 保持去重传递性跨层一致
- 去重保留者选择时 active 图片优先于 trashed
- 单次运行内的临时路径缓存，消除重复下载

### III-3 异步处理（async-processing，11 条需求）

**目标**：原流水线通过 SSE 同步流式运行（`GET /api/trips/:id/process/stream`），处理 100+ 张图片耗时 7–15 分钟，SSE 连接常因 Nginx / 浏览器超时断开——后端实际成功，前端却显示"处理失败"。改为异步后台任务 + 轮询。

**关键点**：
- `processing_jobs` 任务表；发起请求立即返回 `jobId`
- 后台执行流水线并把进度写库；前端轮询获取结构化进度
- 任务状态 / 事件日志 / 结果查询接口
- 并发控制、SSE 端点统一、权限校验
- 服务重启后的任务恢复

## 四、视频上传与处理

### IV-1 视频上传流水线（video-upload-pipeline，19 条需求）

**目标**：重构视频上传链路，支持 10–20GB 大文件稳定上传，兼容所有存储后端（本地、S3、OSS、COS）。上传完成后异步生成预览版和剪辑代理版。图片上传保持现有 multer 流程不变。

**关键点**：上传初始化、分片签名、分片上传（对象存储 / 本地双实现）、上传完成确认、进度与断点续传、`StorageProvider` 接口扩展、代理文件生成、异常处理与清理、Nginx 配置更新、`save()` 流式化、上传状态查询、取消上传、过期上传自动清理

### IV-2 智能视频剪辑（smart-video-editing，10 条需求）

**目标**：自动筛选与摘要剪辑，输出质量较好、内容连续的成片，并支持基于自动结果做手动编辑与合并导出。基于现有 `videoAnalyzer` 和 `videoEditor` 增强。

**关键点**：按视频时长分类处理、低质量片段（严重抖动/模糊/曝光异常）检测剔除、自然边界智能切点、片段选择与排序策略、片段级手动编辑、过渡效果、输出规格、异常与边界处理、质量阈值配置化

### IV-3 自动视频编译（auto-video-compilation，8 条需求）

**目标**：视频处理完成（`video_segments` 与质量评分就绪）后，自动按质量评分选最佳片段，用 ffmpeg 拼成约 60 秒的"初步剪辑版本"。用户可预览，不满意时手动调整片段后重新生成。

**关键点**：自动触发、ffmpeg 拼接 MP4、目标时长控制、前端剪辑预览、手动调整后重新生成、纯质量评分选择策略（AI key 未就绪时的 `fallbackSelection`）、API 设计、错误处理与资源清理

### IV-4 自动编译与合并（video-auto-compile-and-merge，7 条需求）

**关键点**：
- 去掉环境变量开关，视频分析完成后**始终**自动编译精华视频
- 我的相册页分栏展示原始视频与剪辑视频；公开画廊仅展示剪辑后视频
- 支持跨相册选择多个剪辑视频合并为新视频
- 合并视频命名、源关系记录、生命周期管理

### IV-5 视频增强 v3（video-enhancement-v3，12 条需求）

**目标**：第三阶段增强，聚焦内存优化、黑场检测增强、废片识别增强。

**关键点**：
- **内存**：进程内存监控、内存压力响应策略、流式文件存储、片段处理并发控制、临时文件及时清理、多版本生成内存优化、帧提取内存优化、管线整体内存保护
- **检测**：近黑帧检测（极暗画面、镜头盖半遮挡）、镜头遮挡检测（手指/物体遮挡）
- 音频归一化流式优化、多版本输出配置调整

### IV-6 AI 智能剪辑（ai-smart-editing，10 条需求）

**目标**：在现有视频管线（场景检测、质量评分、片段选择、过渡）之上引入多模态 AI，做内容理解与剪辑方案生成，并生成标题/字幕/旁白。

**关键点**：AI Provider 抽象层（多提供商切换）、视频内容理解（场景描述、情感标签、叙事价值评分）、剪辑方案生成（片段顺序、过渡、节奏）、标题/字幕/旁白生成、**成本追踪与预算控制**、分析结果存储、API 端点、与现有管线集成、错误处理与降级

### IV-7 视频剪辑缺陷修复（video-editing-fixes，bugfix）

**已识别 bug**：
1. `concatenateWithTransitions` 中 scale filter 语法错误导致 ffmpeg 执行失败
2. 自动剪辑应默认直接拼接（`'none'`），不加视频 fade；仅在音频拼接处做短时淡入淡出避免爆音
3. `selectSegments` 的 `targetDuration * 1.1` 上限存在提前退出问题，可能导致选中片段总时长远低于目标
4. 前端上传视频后看不到后端处理进度

## 五、音频与成品输出

### V-1 音频库（audio-library，7 条需求）

**目标**：自动剪辑产出的视频由多个 2 秒片段拼接，原始音频在片段切换处产生突兀断裂。本迭代引入音频库与背景音乐替换机制，产出音画协调的成品。

**关键点**：自动剪辑时静音原始音频、音频文件上传、从网络下载背景音乐、音频库管理、为视频选择背景音乐、音频自动裁剪、音频手动裁剪

### V-2 照片幻灯片视频（photo-slideshow-video，7 条需求）

**目标**：在 MyGalleryPage 多选照片，后端用 ffmpeg 按顺序拼成幻灯片视频（每张固定 2 秒），可选背景音乐，输出可下载/预览的 MP4。

**关键点**：触发生成、生成 API、ffmpeg 拼接、背景音乐混合、视频输出与访问、进度报告、错误处理

## 六、与第一部分基线需求的对应关系

| 基线需求 | 相关迭代 |
| --- | --- |
| 需求 1 批量素材上传 | video-upload-pipeline（大文件分片、断点续传、多存储后端） |
| 需求 2 旅行信息填写 | 无专门迭代 |
| 需求 3 文件类型自动识别 | python-clip-analysis（CLIP 分类替代原方案） |
| 需求 4 图片去重与近重复聚合 | hybrid-dedup、smart-curation、global-survivor-dedup、photo-curation-fix、ai-dedup-fix、pipeline-image-optimization |
| 需求 5 最佳质量图片自动选择 | smart-curation、ai-photo-highlights、highlight-tier、manual-photo-management |
| 需求 6 相册展示网站生成 | highlight-tier、manual-photo-management（画廊分栏与精华展示） |
| 需求 7 封面图自动选择 | 由 pipeline 的 cover selection 阶段承载，见 pipeline-robustness |
| —（流水线基础设施） | pipeline-v4-refactor、pipeline-robustness、async-processing |
| —（视频能力） | smart-video-editing、auto-video-compilation、video-auto-compile-and-merge、video-enhancement-v3、ai-smart-editing、video-editing-fixes |
| —（音频与成品） | audio-library、photo-slideshow-video |

## 七、第一部分"超出范围"清单的现状说明

第一部分末尾的"超出范围 / 后续版本规划"是 v1 时的判断，其中若干项已在后续迭代中落地。该清单保留原文未改，此处只做现状标注：

| 原清单项 | 现状 |
| --- | --- |
| 复杂社交功能（评论、点赞、分享） | 仍未实现，无对应 spec |
| 多用户系统 | 已落地。审批制注册 + JWT 会话 + admin/regular 双角色 + 资源归属校验。已补写 as-built 需求文档：`.kiro/specs/multi-user-system/requirements.md`（含 13 条需求与 17 项已知缺口） |
| 在线图片精修 | 部分落地。`pipeline-image-optimization` 的"AI 精修"提供服务端自动调整；前端存在 `ImageEditor.tsx` |
| 复杂权限体系 | 部分落地。存在 trip `visibility`（public）与 owner/admin 权限校验（见 manual-photo-management 的 403 约定），但非细粒度权限体系 |
| 自动剪辑视频 | 已落地。见 smart-video-editing、auto-video-compilation、video-auto-compile-and-merge、ai-smart-editing |
| 高级搜索 | 仍未实现，无对应 spec |
| 多语言 | 仍未实现，无对应 spec |

上表基于文件结构与 spec 文档得出，未逐项运行验证实际行为。
