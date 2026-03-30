# 需求文档

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
