# 需求文档

## 简介

使用 AWS Bedrock 上的 Claude Sonnet 视觉模型替代当前不可靠的传统图片分析算法，实现三个核心功能：模糊检测、去重检测和图片分类。当前的拉普拉斯方差算法会将暗图误判为模糊，pHash/dHash 算法对轻微位移/构图变化检测不出来，AWS Rekognition 会将水下动物照片误分为人物。新方案通过大模型的视觉理解能力解决这些问题，同时将模糊和去重结果放入待删除区供用户审核。

## 术语表

- **Bedrock_Client**: 封装 AWS Bedrock Runtime SDK 调用的客户端模块，负责向 Claude Sonnet 视觉模型发送图片分析请求
- **Blur_Detector**: 模糊检测服务，使用 Bedrock_Client 判断单张图片是否模糊
- **Dedup_Engine**: 去重检测服务，使用 Bedrock_Client 对一组图片进行滑动窗口批量比较，识别重复拍摄
- **Image_Classifier**: 图片分类服务，使用 Bedrock_Client 将图片分类为 people/animal/landscape/other
- **Processing_Pipeline**: 图片处理流水线（process.ts），按顺序调用各分析服务并将结果写入数据库
- **Thumbnail_Resizer**: 缩略图生成模块，将图片缩放到指定尺寸以控制 token 成本
- **Media_Item**: 数据库中的媒体项记录，包含 category、blur_status、status、trashed_reason 等字段
- **Trash_Zone**: 待删除区，status='trashed' 的媒体项集合，供用户审核后决定恢复或永久删除

## 需求

### 需求 1：Bedrock 客户端封装

**用户故事：** 作为开发者，我希望有一个统一的 Bedrock 客户端模块，以便所有图片分析功能共享相同的 AWS 调用逻辑和错误处理。

#### 验收标准

1. THE Bedrock_Client SHALL 使用 @aws-sdk/client-bedrock-runtime 创建客户端实例，从环境变量（AWS_ACCESS_KEY_ID、AWS_SECRET_ACCESS_KEY、S3_REGION 或 AWS_REGION）读取凭证和区域配置
2. THE Bedrock_Client SHALL 提供一个 `invokeModel` 方法，接受 base64 编码的图片数据和文本 prompt，调用 Claude Sonnet 视觉模型并返回模型的文本响应
3. WHEN Bedrock API 返回限流错误（ThrottlingException），THE Bedrock_Client SHALL 使用指数退避策略重试，最多重试 3 次，退避间隔为 2^attempt 秒
4. IF Bedrock API 在所有重试后仍然失败，THEN THE Bedrock_Client SHALL 抛出包含原始错误信息的异常
5. THE Bedrock_Client SHALL 在请求中设置 max_tokens 为 1024，以控制响应长度和成本

### 需求 2：图片预处理（缩略到 512px）

**用户故事：** 作为开发者，我希望在发送图片给大模型前将其缩放到 512px，以便控制 token 成本。

#### 验收标准

1. THE Thumbnail_Resizer SHALL 提供一个 `resizeForAnalysis` 方法，将输入图片缩放到长边不超过 512 像素，保持原始宽高比
2. THE Thumbnail_Resizer SHALL 将缩放后的图片编码为 JPEG 格式并返回 base64 字符串
3. WHEN 输入图片的长边已经小于或等于 512 像素，THE Thumbnail_Resizer SHALL 直接编码为 JPEG 并返回 base64 字符串，不进行放大
4. IF 输入图片文件无法读取或格式不支持，THEN THE Thumbnail_Resizer SHALL 抛出包含文件路径和错误原因的异常

### 需求 3：基于大模型的模糊检测

**用户故事：** 作为用户，我希望系统能准确判断图片是否模糊，不会将暗光照片误判为模糊，以便我只需要审核真正模糊的照片。

#### 验收标准

1. WHEN 处理一张图片时，THE Blur_Detector SHALL 将缩放后的图片和模糊检测 prompt 一起发送给 Bedrock_Client，请求模型判断图片是否模糊
2. THE Blur_Detector SHALL 解析模型响应，将结果映射为 blur_status 字段值：'blurry'（模糊）或 'clear'（清晰）
3. WHEN 模型判定图片为 blurry，THE Blur_Detector SHALL 将该 Media_Item 的 status 更新为 'trashed'，trashed_reason 更新为 'blur'
4. WHEN 模型判定图片为 clear，THE Blur_Detector SHALL 将该 Media_Item 的 blur_status 更新为 'clear'，status 保持 'active'
5. IF 模型响应无法解析为有效的模糊状态，THEN THE Blur_Detector SHALL 将 blur_status 设为 'clear'，并在 processing_error 字段追加错误信息
6. IF Bedrock_Client 调用失败，THEN THE Blur_Detector SHALL 将 blur_status 设为 'clear'，并在 processing_error 字段追加错误信息，不影响后续处理流程

### 需求 4：基于大模型的图片分类

**用户故事：** 作为用户，我希望系统能准确将图片分类为 people/animal/landscape/other，不会将水下动物照片误分为人物。

#### 验收标准

1. WHEN 处理一张图片时，THE Image_Classifier SHALL 将缩放后的图片和分类 prompt 一起发送给 Bedrock_Client，请求模型将图片分类为 people、animal、landscape 或 other
2. THE Image_Classifier SHALL 解析模型响应，提取分类结果并更新 Media_Item 的 category 字段
3. THE Image_Classifier SHALL 将分类结果写入 media_tags 表，格式为 'category:{分类名}'
4. IF 模型响应无法解析为有效的分类值（people/animal/landscape/other），THEN THE Image_Classifier SHALL 将 category 设为 'other'，并在 processing_error 字段追加错误信息
5. IF Bedrock_Client 调用失败，THEN THE Image_Classifier SHALL 将 category 设为 'other'，并在 processing_error 字段追加错误信息

### 需求 5：单图合并调用（模糊检测 + 分类）

**用户故事：** 作为开发者，我希望每张图片只调用一次大模型就同时完成模糊检测和分类，以便减少 API 调用次数和成本。

#### 验收标准

1. THE Processing_Pipeline SHALL 对每张图片发送一次 Bedrock 调用，prompt 中同时要求模型判断模糊状态和图片分类
2. THE Bedrock_Client SHALL 返回包含 blur_status 和 category 两个字段的 JSON 响应
3. THE Processing_Pipeline SHALL 解析该 JSON 响应，分别将 blur_status 和 category 写入对应的数据库字段
4. WHEN blur_status 为 'blurry' 时，THE Processing_Pipeline SHALL 将 Media_Item 移入 Trash_Zone（status='trashed'，trashed_reason='blur'），同时仍然记录 category 值
5. IF JSON 响应解析失败，THEN THE Processing_Pipeline SHALL 将 blur_status 设为 'clear'，category 设为 'other'，并在 processing_error 字段追加解析错误信息

### 需求 6：基于大模型的去重检测

**用户故事：** 作为用户，我希望系统能识别出同一场景的重复拍摄（包括轻微位移和构图变化），以便我只保留最好的一张。

#### 验收标准

1. THE Dedup_Engine SHALL 按 created_at 升序查询旅行中所有 active 状态的图片，使用滑动窗口方式进行批量比较
2. THE Dedup_Engine SHALL 支持可配置的窗口大小，默认为 5 张图片，最大为 10 张图片
3. WHEN 处理一个窗口时，THE Dedup_Engine SHALL 将窗口内所有图片的缩略图（512px）一起发送给 Bedrock_Client，请求模型识别哪些图片是同一场景的重复拍摄
4. THE Dedup_Engine SHALL 解析模型响应，获取重复组信息（哪些图片索引属于同一组）
5. WHEN 检测到重复组时，THE Dedup_Engine SHALL 保留每组中质量最高的图片（基于 sharpness_score 和分辨率），将其余图片移入 Trash_Zone（status='trashed'，trashed_reason='duplicate'）
6. IF 模型响应无法解析为有效的重复组信息，THEN THE Dedup_Engine SHALL 跳过该窗口，不标记任何图片为重复，并在日志中记录解析错误
7. IF Bedrock_Client 调用失败，THEN THE Dedup_Engine SHALL 跳过该窗口，不标记任何图片为重复，并在日志中记录错误信息

### 需求 7：处理流水线集成

**用户故事：** 作为用户，我希望触发处理后，系统按正确顺序执行模糊检测、去重和分类，并通过 SSE 实时报告进度。

#### 验收标准

1. THE Processing_Pipeline SHALL 按以下顺序执行图片分析步骤：(1) 单图分析（模糊检测+分类合并调用）→ (2) 去重检测 → (3) 后续步骤（优化、缩略图等）
2. WHEN 执行单图分析步骤时，THE Processing_Pipeline SHALL 通过 SSE 报告 'blurDetect' 步骤的进度（已处理数/总数）
3. WHEN 执行去重检测步骤时，THE Processing_Pipeline SHALL 通过 SSE 报告 'dedup' 步骤的进度（已处理窗口数/总窗口数）
4. THE Processing_Pipeline SHALL 在处理完成后返回的摘要中包含 blurryDeletedCount（模糊移入待删除区数量）和 dedupDeletedCount（重复移入待删除区数量）
5. WHEN 单图分析或去重检测中某张图片处理失败，THE Processing_Pipeline SHALL 跳过该图片并继续处理剩余图片，将错误记录到 processing_error 字段

### 需求 8：模型响应解析与格式化

**用户故事：** 作为开发者，我希望有可靠的响应解析逻辑，以便正确处理大模型返回的各种格式。

#### 验收标准

1. THE Bedrock_Client SHALL 在 prompt 中要求模型以 JSON 格式返回结果
2. THE Bedrock_Client SHALL 从模型响应文本中提取 JSON 内容（处理可能包含的 markdown 代码块标记）
3. WHEN 单图分析响应包含有效 JSON 且含有 blur_status 和 category 字段时，THE Processing_Pipeline SHALL 正确提取这两个字段的值
4. WHEN 去重分析响应包含有效 JSON 且含有 duplicate_groups 字段时，THE Dedup_Engine SHALL 正确提取重复组信息
5. FOR ALL 有效的单图分析 JSON 响应，解析后再序列化再解析 SHALL 产生等价的 blur_status 和 category 值（往返一致性）
