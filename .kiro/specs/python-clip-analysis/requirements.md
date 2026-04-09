# 需求文档：Python CLIP 图片分析

## 简介

引入 Python 生态的专业图片处理工具（CLIP + OpenCV）替代当前 Node.js 的传统算法和 AWS Rekognition，实现更精准的图片分类、模糊检测和去重。Python 脚本作为独立进程运行，Node.js 通过 child_process 调用，不常驻内存。

## 术语表

- **CLIP**: OpenAI 开源的视觉-语言模型，支持零样本图片分类，通过图像特征和文本特征的余弦相似度做匹配
- **ONNX Runtime**: 轻量级推理引擎，比 PyTorch 更省内存，CPU 友好
- **零样本分类**: 不需要训练数据，直接用文本描述（prompt template）做分类
- **CLIP Embedding**: CLIP 模型提取的图片特征向量（512维），可用于计算图片相似度
- **余弦相似度**: 两个向量的夹角余弦值，范围 [-1, 1]，越接近 1 越相似
- **CLAHE**: 对比度受限自适应直方图均衡化（Contrast Limited Adaptive Histogram Equalization），OpenCV 的 createCLAHE() 实现
- **Prompt Template**: 用于 CLIP 零样本分类的文本模板，如 "a photo of a lion in the wild"

## 需求

### 需求 1：Python 环境、依赖和模型管理

**用户故事：** 作为运维人员，我希望部署脚本能自动检测和安装 Python 环境及模型文件，以便无需手动配置。

#### 技术路线选择

选择方案 B（ONNX 路线），理由：CPU 友好、内存更省、推理更快。

- **方案 A（PyTorch 路线）**：依赖 transformers、torch、Pillow、opencv-python-headless、numpy。内存占用约 1.5GB。
- **方案 B（ONNX 路线）✓**：依赖 transformers、optimum[onnxruntime]、onnxruntime、Pillow、opencv-python-headless、numpy。内存占用约 500MB。

#### 验收标准

1. THE deploy/update.sh SHALL 检测 Python 3.9+ 是否已安装，未安装时自动安装
2. THE deploy/update.sh SHALL 检测 pip 是否可用，未安装时自动安装
3. THE deploy/update.sh SHALL 在每次部署时自动安装/更新 server/python/requirements.txt 中的依赖
4. THE requirements.txt SHALL 包含以下依赖：transformers, optimum[onnxruntime], onnxruntime, Pillow, opencv-python-headless, numpy
5. THE deploy/update.sh SHALL 在首次部署时检测 ONNX 模型是否已存在，不存在时执行 prepare-model.py 脚本下载并导出 ONNX 格式到本地目录（server/python/models/clip-vit-base-patch32-onnx/）
6. THE Python 脚本运行时 SHALL 从本地模型目录加载预先导出的 ONNX 模型，不在请求路径中联网下载或重新导出
7. THE 模型版本 SHALL 固定为 openai/clip-vit-base-patch32，revision/commit hash 写入 server/python/model_config.json，部署时不得隐式拉取最新版
8. THE prepare-model.py 脚本 SHALL 仅在显式执行时重新导出模型，日常部署和运行时不触发导出
9. IF 模型文件不存在，THEN Python 脚本 SHALL 立即退出并返回错误码（exit code 2），由 Node.js 走回退路径

### 需求 2：基于 CLIP 的图片分类

**用户故事：** 作为用户，我希望系统能准确将图片分类为 people/animal/landscape/other，包括识别草原上的动物、水下生物等场景。

#### 验收标准

1. THE Python 脚本 SHALL 使用 CLIP ViT-B/32 模型（ONNX 格式）对图片进行零样本分类
2. THE 分类标签 SHALL 包括：people（人物）、animal（动物）、landscape（风景）、other（其他）
3. EACH 分类类别 SHALL 配置多条 prompt template，同一类别内取 max 聚合，四个类别之间做 softmax 归一化输出 category_scores。示例 prompt：
   - animal: ["a photo of an animal", "a photo of wildlife in nature", "a photo of a lion in the grassland", "a photo of fish underwater", "a photo of birds in the sky", "a photo of elephants", "a photo of a giraffe"]
   - landscape: ["a photo of natural scenery", "a photo of mountains and sky", "a photo of ocean and beach", "a photo of a sunset", "a photo of a forest"]
   - people: ["a photo of a person", "a photo of people", "a portrait photo", "a photo of a diver underwater"]
   - other: ["a photo of food", "a photo of an object", "an abstract photo", "a photo of text or documents"]
4. THE 分类结果 SHALL 包含 category（最高分类别）和 category_scores（四个类别的 softmax 归一化分数）
5. IF CLIP 模型加载失败，THEN SHALL 返回 error=true 并记录错误信息，由 Node.js 走回退路径

### 需求 3：基于 OpenCV 的模糊检测

**用户故事：** 作为用户，我希望系统能准确判断图片是否模糊，不会将暗光照片误判为模糊。

#### 验收标准

1. THE Python 脚本 SHALL 使用 OpenCV Laplacian 方差计算图片清晰度分数
2. THE 模糊检测 SHALL 在计算前对图片进行 CLAHE 亮度归一化（cv2.createCLAHE()），消除暗图偏差
3. THE 结果 SHALL 包含 blur_status（clear/blurry/unknown）和 blur_score（数值）
4. THE 默认模糊阈值 SHALL 为 100，项目部署后可按样本集校准，可通过 --blur-threshold 参数覆盖
5. IF OpenCV 处理失败，THEN SHALL 返回 blur_status='unknown' 和 error 信息，由 Node.js 走回退算法，不将失败伪装为 clear

### 需求 4：基于 CLIP Embedding 的去重检测

**用户故事：** 作为用户，我希望系统能识别同一场景的重复拍摄（包括轻微位移和构图变化），并推荐保留最好的一张。

#### 验收标准

1. THE Python 脚本 SHALL 使用 CLIP 模型提取图片特征向量（512维 embedding）
2. THE 去重 SHALL 计算图片间的余弦相似度
3. WHEN 两张图片的余弦相似度超过阈值（默认 0.9）时，SHALL 判定为重复
4. THE 去重结果 SHALL 包含重复组信息和推荐保留的图片索引
5. THE 保留优先级 SHALL 为：blur_score 最高 → 分辨率（width×height）最高 → 文件大小最大
6. THE 默认相似度阈值 SHALL 为 0.9，可通过 --threshold 参数覆盖
7. THE 单次 dedup SHALL 以 trip 为单位处理，去重策略按图片数量分级：
   - V1（≤ 500 张）：全量两两比较（numpy 向量化余弦相似度矩阵，O(n²) 可接受）
   - V1（> 500 张）：使用 numpy 向量化计算 top-k 近邻（每张取最相近的 50 张再判），避免 O(n²) 内存爆炸
   - V2 扩展：将近邻索引从 numpy 过渡到 faiss，支持全局 embedding 索引，新图上传时增量查重

### 需求 5：Python 脚本命令行接口

**用户故事：** 作为开发者，我希望 Python 脚本提供清晰的命令行接口，减少进程启动次数。

#### 验收标准

1. THE Python 脚本 SHALL 支持 `analyze` 子命令：接受 --images 参数（图片路径列表），一次返回每张图的 blur_status + blur_score + category + category_scores
2. THE Python 脚本 SHALL 支持 `dedup` 子命令：接受 --images、--threshold 参数，输出重复组和保留推荐
3. THE 输出 SHALL 为标准 JSON 格式，写入 stdout
4. THE 错误信息 SHALL 写入 stderr，不影响 stdout 的 JSON 输出
5. IF 某张图片处理失败，THEN SHALL 跳过该图片并在结果中标记 error=true，不影响其他图片
6. THE --model-dir 参数 SHALL 指定本地模型目录路径，默认为脚本同目录下的 models/

### 需求 6：Node.js 集成层

**用户故事：** 作为开发者，我希望有一个 TypeScript 封装层调用 Python 脚本，以便无缝集成到现有处理流水线。

#### 验收标准

1. THE Node.js 封装层 SHALL 通过 child_process.execFile 调用 Python 脚本
2. THE 封装层 SHALL 解析 Python 脚本的 JSON 输出并返回类型化的结果
3. WHEN Python 脚本执行失败时，THE 封装层 SHALL 回退到现有的 Node.js 算法（Rekognition 分类 / pHash 去重 / Laplacian 模糊检测）
4. WHEN Python analyze 中单张图片返回 error=true 时，THE 封装层 SHALL 仅对该图片走 Node.js 回退算法，不影响同批其他图片的 Python 结果
4. THE 封装层 SHALL 在调用前检测 Python 环境是否可用且模型文件是否已存在，任一不满足时直接走回退，不等 Python 启动后再失败
5. THE execFile 调用 SHALL 设置 timeout（默认 300 秒）和 maxBuffer（默认 50MB），避免大批量 JSON 输出把 Node 卡死
6. THE 封装层 SHALL 导出 `isPythonAvailable(): boolean` 函数供 process.ts 判断

### 需求 7：处理流水线集成

**用户故事：** 作为用户，我希望触发处理后，系统优先使用 Python CLIP 进行分析，Python 不可用时自动回退到现有算法。

#### 验收标准

1. THE process.ts SHALL 在启动时调用 isPythonAvailable() 判断 Python 环境
2. WHEN Python 可用时，THE process.ts SHALL 用 Python analyze 命令替代 Step 1（模糊检测）和 Step 5（分类），用 Python dedup 命令替代 Step 2（去重）
3. WHEN Python 不可用时，THE process.ts SHALL 自动回退到现有算法（Rekognition + pHash + Laplacian）
4. THE 处理结果 SHALL 与现有数据库字段兼容（category, blur_status, trashed_reason 等）
5. THE SSE 进度报告 SHALL 保持与现有步骤名兼容（blurDetect, dedup, classify 等）
