import type { ProcessResult } from './ProcessTrigger';

export interface ProcessingLogProps {
  uploadCount: number;
  result: ProcessResult;
  onClose: () => void;
}

export default function ProcessingLog({ uploadCount, result, onClose }: ProcessingLogProps) {
  const duplicatedCount = result.duplicateGroups.reduce(
    (sum, g) => sum + (g.imageCount - 1),
    0
  );
  const keptImages = result.totalImages - duplicatedCount;

  return (
    <div className="processing-log-overlay" role="dialog" aria-label="处理日志">
      <div className="processing-log-modal">
        <h2>处理完成</h2>
        <ul>
          <li>上传文件数量：{uploadCount}</li>
          <li>处理图片数量：{result.totalImages}</li>
          <li>处理视频数量：{result.totalVideos}</li>
          <li>重复组数量：{result.totalGroups}</li>
          <li>最终保留图片数量：{keptImages}</li>
        </ul>
        <button onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}
